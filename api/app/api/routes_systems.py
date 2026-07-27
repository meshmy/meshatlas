from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..models import System
from .deps import get_session

router = APIRouter()


@router.get("/systems")
def list_systems(session: Session = Depends(get_session)):
    """All RF systems this deployment knows about, whether or not an
    ingestion Source for them is currently enabled -- lets the frontend
    show "MeshCore (coming soon)" style entries without needing its own
    hardcoded list."""
    rows = session.query(System).order_by(System.id).all()
    return [{"id": row.id, "name": row.name, "description": row.description} for row in rows]
