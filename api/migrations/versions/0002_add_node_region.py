"""add node region

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-13
"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "0002"
down_revision: Union[str, None] = "0001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("nodes", sa.Column("region", sa.String(length=32), nullable=True))
    op.add_column(
        "nodes",
        sa.Column("region_authoritative", sa.Boolean, nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_column("nodes", "region_authoritative")
    op.drop_column("nodes", "region")
