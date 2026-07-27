"""Coverage / "who heard whom" endpoint -- the equivalent of
lora-aprs.live's coverage.html, generalized across RF systems.

A `NodeLink` row is one observation, so the same pair of nodes
accumulates many rows over time (see models.NodeLink). This endpoint
collapses that history into "the latest observation per pair within the
requested window", which is what a coverage map wants to draw: current
known contacts, not every reception ever logged.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import desc, or_
from sqlalchemy.orm import Session, aliased
from sqlalchemy.orm.exc import NoResultFound

from ..models import Node, NodeLink
from ..schemas import link_to_feature
from .deps import get_session

router = APIRouter()


@router.get("/links")
def list_links(
    system: str | None = Query(None, description="Filter to one system_id, e.g. 'meshtastic'"),
    hours: float = Query(6, gt=0, le=24 * 30, description="Only consider links observed within this window"),
    link_type: str | None = Query(None, description="Filter to one link_type, e.g. 'heard_direct'"),
    node: str | None = Query(
        None, description="Only links touching this node's native_id (e.g. '!a1b2c3d4'), either direction"
    ),
    min_snr: float | None = Query(None, description="Only links with snr >= this value"),
    session: Session = Depends(get_session),
):
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)

    from_node = aliased(Node)
    to_node = aliased(Node)

    query = (
        session.query(NodeLink)
        .join(from_node, NodeLink.from_node_id == from_node.id)
        .join(to_node, NodeLink.to_node_id == to_node.id)
        .filter(NodeLink.observed_at >= cutoff)
        # Both ends need a known position to be drawable as a line.
        .filter(from_node.last_latitude.isnot(None))
        .filter(to_node.last_latitude.isnot(None))
    )
    if system:
        query = query.filter(NodeLink.system_id == system)
    if link_type:
        query = query.filter(NodeLink.link_type == link_type)
    if node:
        query = query.filter(or_(from_node.native_id == node, to_node.native_id == node))
    if min_snr is not None:
        query = query.filter(NodeLink.snr >= min_snr)

    # DISTINCT ON (from_node_id, to_node_id) ordered by observed_at DESC
    # gives one row per pair -- the most recent -- in a single query.
    query = query.distinct(NodeLink.from_node_id, NodeLink.to_node_id).order_by(
        NodeLink.from_node_id, NodeLink.to_node_id, desc(NodeLink.observed_at)
    )

    links = query.all()
    features = []
    for link in links:
        try:
            features.append(link_to_feature(link))
        except ValueError:
            # Position changed between the filter above and now (race with
            # a concurrent write); skip rather than 500 the whole request.
            continue

    return {"type": "FeatureCollection", "features": features}


@router.get("/nodes/{node_id}/links")
def node_links(
    node_id: str,
    hours: float = Query(6, gt=0, le=24 * 30),
    session: Session = Depends(get_session),
):
    """Convenience alias for `/links?node=<native_id>` when you already
    have a node's UUID (e.g. from a map click) rather than its native_id."""
    try:
        node_uuid = uuid.UUID(node_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="node_id must be a UUID") from None

    try:
        native_id = session.query(Node.native_id).filter(Node.id == node_uuid).one()[0]
    except NoResultFound:
        raise HTTPException(status_code=404, detail="node not found") from None

    return list_links(
        system=None,
        hours=hours,
        link_type=None,
        node=native_id,
        min_snr=None,
        session=session,
    )
