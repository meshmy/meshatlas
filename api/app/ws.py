"""Tiny in-memory WebSocket fan-out for live updates.

One process, one list of connections -- deliberately not backed by
Redis/pubsub. If this ever needs to run as more than one API replica,
swap `ConnectionManager.broadcast` for a pubsub-backed version without
touching any callers (they only depend on `connect`/`disconnect`/`broadcast`).
"""
from __future__ import annotations

import asyncio
import json
import logging

from fastapi import WebSocket

logger = logging.getLogger(__name__)


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    async def broadcast(self, message: dict) -> None:
        async with self._lock:
            connections = list(self._connections)
        if not connections:
            return

        payload = json.dumps(message)
        stale: list[WebSocket] = []
        for ws in connections:
            try:
                await ws.send_text(payload)
            except Exception:
                stale.append(ws)

        if stale:
            async with self._lock:
                for ws in stale:
                    self._connections.discard(ws)
