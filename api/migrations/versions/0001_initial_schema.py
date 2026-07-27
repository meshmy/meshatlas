"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-07-27
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from geoalchemy2 import Geography
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")

    op.create_table(
        "systems",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("description", sa.String(length=512), nullable=True),
    )

    op.create_table(
        "nodes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("system_id", sa.String(length=32), sa.ForeignKey("systems.id"), nullable=False),
        sa.Column("native_id", sa.String(length=64), nullable=False),
        sa.Column("display_name", sa.String(length=256), nullable=True),
        sa.Column("short_name", sa.String(length=32), nullable=True),
        sa.Column("hardware_model", sa.String(length=64), nullable=True),
        sa.Column("first_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_seen", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("last_latitude", sa.Float, nullable=True),
        sa.Column("last_longitude", sa.Float, nullable=True),
        sa.Column("last_altitude_m", sa.Float, nullable=True),
        sa.Column("last_position_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("geom", Geography(geometry_type="POINT", srid=4326), nullable=True),
        sa.Column("battery_pct", sa.Integer, nullable=True),
        sa.Column("voltage", sa.Float, nullable=True),
        sa.Column("snr", sa.Float, nullable=True),
        sa.Column("rssi", sa.Integer, nullable=True),
        sa.Column("extra", postgresql.JSONB, server_default="{}", nullable=False),
        sa.UniqueConstraint("system_id", "native_id", name="uq_nodes_system_native_id"),
    )
    op.create_index("ix_nodes_system_id", "nodes", ["system_id"])
    # Note: no explicit index on `geom` here -- GeoAlchemy2's Geography
    # type attaches a DDL listener that creates a GiST index
    # ("idx_nodes_geom") automatically when the table is created.

    op.create_table(
        "node_positions",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column(
            "node_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("latitude", sa.Float, nullable=False),
        sa.Column("longitude", sa.Float, nullable=False),
        sa.Column("altitude_m", sa.Float, nullable=True),
        sa.Column("geom", Geography(geometry_type="POINT", srid=4326), nullable=True),
    )
    op.create_index(
        "ix_node_positions_node_id_observed_at", "node_positions", ["node_id", "observed_at"]
    )

    op.create_table(
        "node_links",
        sa.Column("id", sa.BigInteger, primary_key=True, autoincrement=True),
        sa.Column("system_id", sa.String(length=32), sa.ForeignKey("systems.id"), nullable=False),
        sa.Column(
            "from_node_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "to_node_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("nodes.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("observed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("link_type", sa.String(length=32), nullable=False),
        sa.Column("snr", sa.Float, nullable=True),
        sa.Column("rssi", sa.Integer, nullable=True),
        sa.Column("distance_m", sa.Float, nullable=True),
        sa.Column("extra", postgresql.JSONB, server_default="{}", nullable=False),
    )
    op.create_index(
        "ix_node_links_from_to_observed_at",
        "node_links",
        ["from_node_id", "to_node_id", "observed_at"],
    )

    # Seed the systems this deployment knows the *name* of, even though
    # only "meshtastic" has an active ingestion Source today. See
    # app/db.py::KNOWN_SYSTEMS.
    systems = sa.table(
        "systems", sa.column("id", sa.String), sa.column("name", sa.String), sa.column("description", sa.String)
    )
    op.bulk_insert(
        systems,
        [
            {"id": "meshtastic", "name": "Meshtastic", "description": "LoRa mesh network, ingested via MQTT."},
            {"id": "aprs", "name": "APRS", "description": "Not yet implemented."},
            {"id": "lora_aprs", "name": "LoRa APRS", "description": "Not yet implemented."},
            {"id": "meshcore", "name": "MeshCore", "description": "Not yet implemented."},
        ],
    )


def downgrade() -> None:
    op.drop_table("node_links")
    op.drop_table("node_positions")
    op.drop_index("ix_nodes_system_id", table_name="nodes")
    op.drop_table("nodes")
    op.drop_table("systems")
