"""Wires together configured Source plugins, persistence and the
WebSocket fan-out. This is the only module that knows about all three;
everything downstream of it just deals in NodeUpdate/LinkObservation
events or GeoJSON features.
"""
from __future__ import annotations

import asyncio
import logging

from . import db
from .config import settings
from .schemas import link_to_feature, node_to_feature
from .sources import REGISTRY
from .sources.base import Event, LinkObservation, NodeUpdate
from .ws import ConnectionManager

logger = logging.getLogger(__name__)


def _config_for(system_id: str):
    """Maps a system_id to its typed config object. Adding a new source
    means adding one line here (and its Config dataclass in config.py) --
    nothing else in this module changes."""
    if system_id == "meshtastic":
        return settings.meshtastic
    raise ValueError(
        f"source {system_id!r} is registered but has no config accessor in app.ingest._config_for"
    )


class IngestionManager:
    """Fans multiple sources into one serialized writer.

    Sources call `sink(event)` (really `self._enqueue`) from wherever --
    including, for the Meshtastic MQTT source, paho-mqtt's own network
    thread via `asyncio.run_coroutine_threadsafe`. Persisting was
    originally done inline in the sink via `asyncio.to_thread`, but with
    more than one event in flight at once that meant multiple threads
    could concurrently run `_get_or_create_stub_node` for the same
    not-yet-seen node (e.g. a NodeUpdate and a LinkObservation mentioning
    the same node arriving moments apart), race the
    check-then-insert, and hit `nodes`'s (system_id, native_id) unique
    constraint. Routing every event through one queue, drained by exactly
    one writer task, makes that class of race structurally impossible
    instead of papering over one instance of it -- and at the message
    volumes an RF mesh produces, a single writer is nowhere near a
    throughput bottleneck.
    """

    def __init__(self, connections: ConnectionManager) -> None:
        self._connections = connections
        self._stop_event = asyncio.Event()
        self._tasks: list[asyncio.Task] = []
        self._queue: asyncio.Queue[Event] = asyncio.Queue()

    async def start(self) -> None:
        with db.session_scope() as session:
            db.ensure_known_systems(session)

        self._tasks.append(asyncio.create_task(self._writer_loop(), name="ingest-writer"))

        for system_id in settings.enabled_sources:
            source_cls = REGISTRY.get(system_id)
            if source_cls is None:
                logger.warning(
                    "ingest: ENABLED_SOURCES lists %r but no Source is registered under that id "
                    "(available: %s) -- skipping",
                    system_id,
                    sorted(REGISTRY),
                )
                continue
            source = source_cls(_config_for(system_id))
            task = asyncio.create_task(source.run(self._enqueue, self._stop_event), name=f"source:{system_id}")
            self._tasks.append(task)
            logger.info("ingest: started source %r", system_id)

    async def stop(self) -> None:
        self._stop_event.set()
        for task in self._tasks:
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    async def _enqueue(self, event: Event) -> None:
        await self._queue.put(event)

    async def _writer_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue
            try:
                message = await asyncio.to_thread(self._persist, event)
            except Exception:
                logger.exception("ingest: failed to persist event %r", event)
                continue
            if message is not None:
                await self._connections.broadcast(message)

    @staticmethod
    def _persist(event: Event) -> dict | None:
        """Runs on a worker thread (see `_sink`): does the actual
        synchronous DB write and, while the session is still open, builds
        the GeoJSON message to broadcast (so relationship access doesn't
        need a second round trip after the session closes)."""
        with db.session_scope() as session:
            row = db.apply_event(session, event)
            session.flush()

            if isinstance(event, NodeUpdate):
                return {"type": "node", "feature": node_to_feature(row)}

            if isinstance(event, LinkObservation):
                if row.from_node.last_latitude is None or row.to_node.last_latitude is None:
                    return None  # can't draw a line without both endpoints' positions yet
                return {"type": "link", "feature": link_to_feature(row)}

        return None
