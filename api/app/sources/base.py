"""Shared contract every RF-network source plugin must implement.

MeshAtlas is built around one idea: the map, the API and the database only
ever see the generic shapes defined here (`NodeUpdate` / `NodeEvent`).
Everything specific to a given radio system (Meshtastic MQTT topics and
protobufs today; APRS-IS, LoRa APRS or MeshCore in the future) is isolated
inside a `Source` subclass that translates its wire format into these
generic shapes.

To add a new system:
  1. Create `app/sources/<system>.py` implementing `Source`.
  2. Call `register_source(...)` (see bottom of this module) with a unique
     `system_id`.
  3. Add the row for that system to the `systems` table (a migration, or
     the `ensure_system` helper in app.db).
  4. List the plugin in `app/sources/__init__.py` and add its id to
     ENABLED_SOURCES.
No changes to models, the API routes, the WebSocket feed, or the frontend
are required -- they are all keyed on `system_id` + `native_id`, not on
anything Meshtastic-specific.
"""
from __future__ import annotations

import abc
import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any


@dataclass(slots=True)
class NodeUpdate:
    """A normalized snapshot of one node, as reported by any source.

    Every field except `system_id`, `native_id` and `observed_at` is
    optional because different systems (and different packet types within
    the same system) report different subsets of this information. Sinks
    merge updates into the latest known state for a node rather than
    requiring a complete record every time.
    """

    system_id: str
    native_id: str
    observed_at: datetime

    display_name: str | None = None
    short_name: str | None = None
    hardware_model: str | None = None

    latitude: float | None = None
    longitude: float | None = None
    altitude_m: float | None = None

    battery_pct: int | None = None
    voltage: float | None = None
    snr: float | None = None
    rssi: int | None = None

    # Raw, system-specific fields worth keeping for debugging or future
    # features, without polluting the normalized columns above.
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def has_position(self) -> bool:
        return self.latitude is not None and self.longitude is not None


@dataclass(slots=True)
class LinkObservation:
    """One report of node `from_native_id` being heard by/reported as a
    neighbor of `to_native_id` over RF. See models.NodeLink for how
    `link_type` is used; keep the two in sync.
    """

    system_id: str
    from_native_id: str
    to_native_id: str
    observed_at: datetime
    link_type: str

    snr: float | None = None
    rssi: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)


# Anything a source can emit. The ingestion manager dispatches on type;
# sources never touch the database directly, which is what keeps a new
# system's Source implementation to "decode wire format -> emit Event".
Event = NodeUpdate | LinkObservation

# A sink is just "what to do with a decoded event" -- the ingestion manager
# supplies one that persists to Postgres and fans out over the WebSocket;
# tests can supply one that appends to a list.
Sink = Callable[[Event], Awaitable[None]]


class Source(abc.ABC):
    """Base class for a single RF-network ingestion plugin."""

    #: Unique, stable identifier stored in the `systems`/`nodes` tables.
    #: Must match a row in the `systems` table.
    system_id: str

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config

    @abc.abstractmethod
    async def run(self, sink: Sink, stop_event: asyncio.Event) -> None:
        """Run forever (until `stop_event` is set), calling `sink(update)`
        for every node update the source observes."""
        raise NotImplementedError
