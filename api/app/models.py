"""SQLAlchemy models.

The schema is deliberately generic: nothing here mentions Meshtastic. Every
row is scoped by `system_id` (a short string like "meshtastic", "aprs",
"lora_aprs", "meshcore") so that adding a new RF system later is a data
change, not a schema change.
"""
from __future__ import annotations

import uuid
from datetime import datetime

from geoalchemy2 import Geography
from sqlalchemy import (
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class System(Base):
    """A distinct RF/location-reporting network, e.g. Meshtastic or APRS."""

    __tablename__ = "systems"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str | None] = mapped_column(String(512), nullable=True)

    nodes: Mapped[list["Node"]] = relationship(back_populates="system")


class Node(Base):
    """Latest known state of one node. History lives in `NodePosition`."""

    __tablename__ = "nodes"
    __table_args__ = (
        UniqueConstraint("system_id", "native_id", name="uq_nodes_system_native_id"),
        Index("ix_nodes_system_id", "system_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    system_id: Mapped[str] = mapped_column(ForeignKey("systems.id"))
    # The identifier the source system uses natively, e.g. a Meshtastic
    # "!a1b2c3d4" node id, or an APRS callsign-SSID in the future.
    native_id: Mapped[str] = mapped_column(String(64))

    display_name: Mapped[str | None] = mapped_column(String(256), nullable=True)
    short_name: Mapped[str | None] = mapped_column(String(32), nullable=True)
    hardware_model: Mapped[str | None] = mapped_column(String(64), nullable=True)

    first_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    last_latitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_longitude: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_altitude_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    last_position_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Geography column mirroring last_latitude/last_longitude, kept in sync
    # in application code so it can be indexed (GiST) for spatial queries
    # (bounding-box map queries, "nodes near me", etc.) without every
    # consumer needing to know PostGIS.
    geom = mapped_column(Geography(geometry_type="POINT", srid=4326), nullable=True)

    battery_pct: Mapped[int | None] = mapped_column(Integer, nullable=True)
    voltage: Mapped[float | None] = mapped_column(Float, nullable=True)
    snr: Mapped[float | None] = mapped_column(Float, nullable=True)
    rssi: Mapped[int | None] = mapped_column(Integer, nullable=True)

    extra: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    system: Mapped[System] = relationship(back_populates="nodes")
    positions: Mapped[list["NodePosition"]] = relationship(
        back_populates="node", order_by="NodePosition.observed_at"
    )


class NodePosition(Base):
    """Append-only position history, used to draw trails and to let a
    node's track be replayed/analyzed independent of its "latest" state."""

    __tablename__ = "node_positions"
    __table_args__ = (Index("ix_node_positions_node_id_observed_at", "node_id", "observed_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    node_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    latitude: Mapped[float] = mapped_column(Float)
    longitude: Mapped[float] = mapped_column(Float)
    altitude_m: Mapped[float | None] = mapped_column(Float, nullable=True)
    geom = mapped_column(Geography(geometry_type="POINT", srid=4326), nullable=True)

    node: Mapped[Node] = relationship(back_populates="positions")


class NodeLink(Base):
    """One observation of node A hearing node B over RF -- the raw
    material for a coverage/"heard contacts" view, analogous to
    lora-aprs.live's coverage.html.

    This is append-only history, same as NodePosition: every reception
    report is a new row rather than an upsert, so that signal quality over
    time (and not just "currently linked or not") can be analyzed later.
    The API layer collapses this into "most recent link per pair" for
    rendering; nothing here assumes only one row per pair exists.

    `link_type` distinguishes how the edge was learned, since different
    systems/packet types produce this differently:
      - "heard_direct": derived from a source system_id + relay/hop
        metadata proving a specific packet was received over RF with no
        intermediate relay (e.g. a Meshtastic MQTT gateway's rx_snr/rssi
        on a packet whose relay_node is unset).
      - "neighbor_report": a node's own self-reported neighbor table
        (e.g. Meshtastic NEIGHBORINFO_APP), which is symmetric-ish but
        self-reported rather than independently observed.
    """

    __tablename__ = "node_links"
    __table_args__ = (
        Index("ix_node_links_from_to_observed_at", "from_node_id", "to_node_id", "observed_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    system_id: Mapped[str] = mapped_column(ForeignKey("systems.id"))
    from_node_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"))
    to_node_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"))
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    link_type: Mapped[str] = mapped_column(String(32))
    snr: Mapped[float | None] = mapped_column(Float, nullable=True)
    rssi: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # Great-circle distance in metres between the two nodes' positions at
    # the time this row was written, if both were known. Computed in
    # application code (see app/db.py) so the API doesn't need a PostGIS
    # round-trip just to sort/filter by distance.
    distance_m: Mapped[float | None] = mapped_column(Float, nullable=True)

    extra: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")

    from_node: Mapped[Node] = relationship(foreign_keys=[from_node_id])
    to_node: Mapped[Node] = relationship(foreign_keys=[to_node_id])
