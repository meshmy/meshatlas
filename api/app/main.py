from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .api import routes_links, routes_nodes, routes_systems
from .ingest import IngestionManager
from .ws import ConnectionManager

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(name)s: %(message)s")

connections = ConnectionManager()
ingestion = IngestionManager(connections)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ingestion.start()
    try:
        yield
    finally:
        await ingestion.stop()


app = FastAPI(title="MeshAtlas API", lifespan=lifespan)

# Permissive CORS: the shipped deployment serves the frontend from the
# same origin via nginx (see web/nginx.conf), so this mainly matters for
# local frontend development (`npm run dev` on a different port).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(routes_systems.router, prefix="/api")
app.include_router(routes_nodes.router, prefix="/api")
app.include_router(routes_links.router, prefix="/api")


@app.get("/api/healthz")
def healthz():
    return {"status": "ok"}


@app.websocket("/ws/live")
async def websocket_live(websocket: WebSocket):
    await connections.connect(websocket)
    try:
        while True:
            # Clients don't send anything meaningful; just wait for them
            # to close so we can clean up. Reading is what surfaces the
            # disconnect promptly instead of only on the next broadcast.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await connections.disconnect(websocket)
