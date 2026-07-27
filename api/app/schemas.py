"""GeoJSON serialization for the ORM models.

Deliberately plain dicts (not Pydantic models) -- GeoJSON's shape (a
`geometry` that's one of several types, arbitrary `properties`) doesn't map
cleanly onto Pydantic's static typing, and FastAPI is happy to return
plain JSON-able dicts directly.
"""
from __future__ import annotations

from .models import Node, NodeLink


def node_to_feature(node: Node) -> dict:
    geometry = None
    if node.last_latitude is not None and node.last_longitude is not None:
        geometry = {
            "type": "Point",
            "coordinates": [node.last_longitude, node.last_latitude, node.last_altitude_m or 0],
        }
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": {
            "id": str(node.id),
            "system_id": node.system_id,
            "native_id": node.native_id,
            "display_name": node.display_name,
            "short_name": node.short_name,
            "hardware_model": node.hardware_model,
            "battery_pct": node.battery_pct,
            "voltage": node.voltage,
            "snr": node.snr,
            "rssi": node.rssi,
            "first_seen": _iso(node.first_seen),
            "last_seen": _iso(node.last_seen),
            "last_position_at": _iso(node.last_position_at),
        },
    }


def link_to_feature(link: NodeLink) -> dict:
    """Renders a link as a LineString. Callers must ensure both endpoint
    nodes have a known position -- this raises if they don't, rather than
    silently emitting a broken geometry."""
    from_node, to_node = link.from_node, link.to_node
    if from_node.last_latitude is None or to_node.last_latitude is None:
        raise ValueError(f"link {link.id} has an endpoint with no known position")

    return {
        "type": "Feature",
        "geometry": {
            "type": "LineString",
            "coordinates": [
                [from_node.last_longitude, from_node.last_latitude, from_node.last_altitude_m or 0],
                [to_node.last_longitude, to_node.last_latitude, to_node.last_altitude_m or 0],
            ],
        },
        "properties": {
            "id": link.id,
            "system_id": link.system_id,
            "link_type": link.link_type,
            "from_node_id": str(link.from_node_id),
            "to_node_id": str(link.to_node_id),
            "from_native_id": from_node.native_id,
            "to_native_id": to_node.native_id,
            "from_display_name": from_node.display_name or from_node.native_id,
            "to_display_name": to_node.display_name or to_node.native_id,
            "snr": link.snr,
            "rssi": link.rssi,
            "distance_m": link.distance_m,
            "observed_at": _iso(link.observed_at),
        },
    }


def _iso(value) -> str | None:
    return value.isoformat() if value is not None else None
