import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..models import Node, NodePosition
from ..schemas import node_to_feature
from .deps import get_session

router = APIRouter()


@router.get("/nodes")
def list_nodes(
    system: str | None = Query(None, description="Filter to one system_id, e.g. 'meshtastic'"),
    active_hours: float | None = Query(
        None, gt=0, description="Only include nodes with last_seen within this many hours"
    ),
    session: Session = Depends(get_session),
):
    query = session.query(Node)
    if system:
        query = query.filter(Node.system_id == system)
    if active_hours is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=active_hours)
        query = query.filter(Node.last_seen >= cutoff)

    nodes = query.order_by(Node.last_seen.desc()).all()
    return {"type": "FeatureCollection", "features": [node_to_feature(n) for n in nodes]}


@router.get("/nodes/{node_id}/history")
def node_history(
    node_id: str,
    hours: float = Query(24, gt=0, le=24 * 30, description="How far back to look"),
    session: Session = Depends(get_session),
):
    try:
        node_uuid = uuid.UUID(node_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="node_id must be a UUID") from None

    node = session.get(Node, node_uuid)
    if node is None:
        raise HTTPException(status_code=404, detail="node not found")

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    positions = (
        session.query(NodePosition)
        .filter(NodePosition.node_id == node.id, NodePosition.observed_at >= cutoff)
        .order_by(NodePosition.observed_at)
        .all()
    )

    coordinates = [[p.longitude, p.latitude, p.altitude_m or 0] for p in positions]
    return {
        "type": "Feature",
        "geometry": {"type": "LineString", "coordinates": coordinates} if len(coordinates) >= 2 else None,
        "properties": {
            "node_id": str(node.id),
            "native_id": node.native_id,
            "point_count": len(coordinates),
            "points": [
                {
                    "observed_at": p.observed_at.isoformat(),
                    "lon": p.longitude,
                    "lat": p.latitude,
                    "altitude_m": p.altitude_m,
                }
                for p in positions
            ],
        },
    }
