"""Engine/session setup plus the handful of CRUD helpers the ingestion
manager and the REST routes both need.

This project deliberately uses plain synchronous SQLAlchemy rather than an
async ORM. Node update volume from a mesh/APRS network is low (at most a
few messages per second), so the simplicity of sync code -- easier to
read, debug and contribute to -- outweighs the throughput async would buy.
Sync DB calls made from the (async) ingestion loop are pushed onto a
thread via `asyncio.to_thread` at the call site; see app/ingest.py.
"""
from __future__ import annotations

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from math import atan2, cos, radians, sin, sqrt

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Node, NodeLink, NodePosition, System
from .sources.base import Event, LinkObservation, NodeUpdate

engine = create_engine(settings.database_url, pool_pre_ping=True, future=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, future=True)


@contextmanager
def session_scope() -> Iterator[Session]:
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


# Known systems this deployment ships a UI/label for. Only "meshtastic" has
# an ingestion Source today; the others are placeholders so the schema,
# API and frontend never need to change to accommodate them later.
KNOWN_SYSTEMS: dict[str, str] = {
    "meshtastic": "Meshtastic",
    "aprs": "APRS",
    "lora_aprs": "LoRa APRS",
    "meshcore": "MeshCore",
}


def ensure_known_systems(session: Session) -> None:
    existing = {row.id for row in session.query(System.id).all()}
    for system_id, name in KNOWN_SYSTEMS.items():
        if system_id not in existing:
            session.add(System(id=system_id, name=name))


def _point_wkt(lat: float, lon: float) -> str:
    return f"SRID=4326;POINT({lon} {lat})"


def apply_node_update(session: Session, update: NodeUpdate) -> Node:
    """Upsert a node's latest state and, if the update carries a position,
    append a row to its history. Returns the up-to-date Node row."""

    node = (
        session.query(Node)
        .filter(Node.system_id == update.system_id, Node.native_id == update.native_id)
        .one_or_none()
    )
    if node is None:
        node = Node(
            id=uuid.uuid4(),
            system_id=update.system_id,
            native_id=update.native_id,
            first_seen=update.observed_at,
            last_seen=update.observed_at,
        )
        session.add(node)

    node.last_seen = max(node.last_seen or update.observed_at, update.observed_at)
    if update.display_name:
        node.display_name = update.display_name
    if update.short_name:
        node.short_name = update.short_name
    if update.hardware_model:
        node.hardware_model = update.hardware_model
    if update.battery_pct is not None:
        node.battery_pct = update.battery_pct
    if update.voltage is not None:
        node.voltage = update.voltage
    if update.snr is not None:
        node.snr = update.snr
    if update.rssi is not None:
        node.rssi = update.rssi
    if update.extra:
        node.extra = {**(node.extra or {}), **update.extra}

    if update.has_position:
        node.last_latitude = update.latitude
        node.last_longitude = update.longitude
        node.last_altitude_m = update.altitude_m
        node.last_position_at = update.observed_at
        node.geom = _point_wkt(update.latitude, update.longitude)

        session.flush()  # ensure node.id is assigned before the FK insert
        session.add(
            NodePosition(
                node_id=node.id,
                observed_at=update.observed_at,
                latitude=update.latitude,
                longitude=update.longitude,
                altitude_m=update.altitude_m,
                geom=_point_wkt(update.latitude, update.longitude),
            )
        )

    return node


def _get_or_create_stub_node(session: Session, system_id: str, native_id: str, observed_at) -> Node:
    """Look up a node by (system_id, native_id), creating a minimal
    placeholder if it hasn't been seen via a NodeUpdate yet -- e.g. a
    neighbor report can mention a node id before that node's own NodeInfo
    packet has been observed. The placeholder is filled in normally the
    next time a NodeUpdate for it arrives."""

    node = (
        session.query(Node)
        .filter(Node.system_id == system_id, Node.native_id == native_id)
        .one_or_none()
    )
    if node is None:
        node = Node(
            id=uuid.uuid4(),
            system_id=system_id,
            native_id=native_id,
            first_seen=observed_at,
            last_seen=observed_at,
        )
        session.add(node)
        session.flush()
    return node


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    earth_radius_m = 6_371_000.0
    dlat, dlon = radians(lat2 - lat1), radians(lon2 - lon1)
    a = sin(dlat / 2) ** 2 + cos(radians(lat1)) * cos(radians(lat2)) * sin(dlon / 2) ** 2
    return earth_radius_m * 2 * atan2(sqrt(a), sqrt(1 - a))


def apply_link_observation(session: Session, obs: LinkObservation) -> NodeLink:
    """Record one "node A heard node B" observation. Both ends are
    resolved to Node rows (creating placeholders as needed) so the map can
    always join a link back to a node even if positions aren't known yet.
    """

    from_node = _get_or_create_stub_node(session, obs.system_id, obs.from_native_id, obs.observed_at)
    to_node = _get_or_create_stub_node(session, obs.system_id, obs.to_native_id, obs.observed_at)

    distance_m = None
    if (
        from_node.last_latitude is not None
        and from_node.last_longitude is not None
        and to_node.last_latitude is not None
        and to_node.last_longitude is not None
    ):
        distance_m = _haversine_m(
            from_node.last_latitude,
            from_node.last_longitude,
            to_node.last_latitude,
            to_node.last_longitude,
        )

    link = NodeLink(
        system_id=obs.system_id,
        from_node_id=from_node.id,
        to_node_id=to_node.id,
        observed_at=obs.observed_at,
        link_type=obs.link_type,
        snr=obs.snr,
        rssi=obs.rssi,
        distance_m=distance_m,
        extra=obs.extra or {},
    )
    session.add(link)
    return link


def apply_event(session: Session, event: Event) -> Node | NodeLink:
    """Single entry point the ingestion manager calls for every decoded
    event, regardless of which Source produced it or what kind of event it
    is. Keeping this dispatch in one place is what lets sources stay
    completely decoupled from persistence."""

    if isinstance(event, NodeUpdate):
        return apply_node_update(session, event)
    if isinstance(event, LinkObservation):
        return apply_link_observation(session, event)
    raise TypeError(f"Unhandled event type: {type(event)!r}")
