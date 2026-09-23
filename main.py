"""
PMU backend server.

Three jobs:
1. POST /api/ingest      — PMUs (via WiFi or GSM, doesn't matter) push readings here
2. GET  /api/readings/*  — the dashboard pulls current/historical data from here
3. WS   /ws/live         — the dashboard connects here to get new readings pushed
                            to it instantly, without needing to keep asking

Run locally with:  uvicorn main:app --reload
Then open:         http://127.0.0.1:8000/docs   (auto-generated API docs — try it there first)
"""

import os
import json
import logging
from datetime import datetime, timedelta
from typing import List, Optional

from fastapi import FastAPI, Depends, HTTPException, Header, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import desc

from database import engine, get_db, Base
from models import Reading
from schemas import ReadingIn, ReadingOut

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("pmu-backend")

# Creates the readings table on first run if it doesn't exist yet.
Base.metadata.create_all(bind=engine)

app = FastAPI(title="PMU Backend", version="1.0")

# CORS: allows your dashboard website (running on a different domain/port)
# to call this API from the browser. "*" is fine for development; tighten
# this to your actual dashboard's domain before you consider this "done".
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Shared secret the PMUs must send to prove they're allowed to post data.
# Set this via an environment variable in production — never hardcode a
# real secret and commit it. For local testing, it falls back to a default.
DEVICE_API_KEY = os.getenv("DEVICE_API_KEY", "dev-test-key-change-me")


# ---------------------------------------------------------------------------
# WebSocket connection manager — keeps track of every dashboard browser
# currently connected, so we can push new readings to all of them at once.
# ---------------------------------------------------------------------------
class ConnectionManager:
    def __init__(self):
        self.active: List[WebSocket] = []

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active.append(ws)
        logger.info(f"Dashboard connected. Total connections: {len(self.active)}")

    def disconnect(self, ws: WebSocket):
        if ws in self.active:
            self.active.remove(ws)
        logger.info(f"Dashboard disconnected. Total connections: {len(self.active)}")

    async def broadcast(self, message: dict):
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws)


manager = ConnectionManager()


# ---------------------------------------------------------------------------
# 1. INGEST — PMUs post their readings here
# ---------------------------------------------------------------------------
@app.post("/api/ingest", response_model=ReadingOut)
async def ingest_reading(
    reading: ReadingIn,
    db: Session = Depends(get_db),
    x_api_key: Optional[str] = Header(None),
):
    if x_api_key != DEVICE_API_KEY:
        raise HTTPException(status_code=401, detail="Invalid or missing API key")

    db_reading = Reading(
        pmu_id=reading.pmu_id,
        voltage=reading.voltage,
        current=reading.current,
        angle=reading.angle,
        frequency=reading.frequency,
        device_timestamp=reading.timestamp,
    )
    db.add(db_reading)
    db.commit()
    db.refresh(db_reading)

    logger.info(f"Ingested reading from PMU {reading.pmu_id}: V={reading.voltage} I={reading.current} angle={reading.angle}")

    # Push it live to every connected dashboard immediately.
    await manager.broadcast({
        "id": db_reading.id,
        "pmu_id": db_reading.pmu_id,
        "voltage": db_reading.voltage,
        "current": db_reading.current,
        "angle": db_reading.angle,
        "frequency": db_reading.frequency,
        "received_at": db_reading.received_at.isoformat(),
    })

    return db_reading


# ---------------------------------------------------------------------------
# 2. QUERY ENDPOINTS — the dashboard reads from these
# ---------------------------------------------------------------------------
@app.get("/api/readings/latest", response_model=List[ReadingOut])
def get_latest(db: Session = Depends(get_db)):
    """Most recent reading from each PMU (one row per pmu_id)."""
    all_ids = [row[0] for row in db.query(Reading.pmu_id).distinct().all()]
    results = []
    for pid in all_ids:
        latest = (
            db.query(Reading)
            .filter(Reading.pmu_id == pid)
            .order_by(desc(Reading.received_at))
            .first()
        )
        if latest:
            results.append(latest)
    return results


@app.get("/api/readings/history", response_model=List[ReadingOut])
def get_history(
    pmu_id: int = Query(..., description="Which PMU's history to fetch"),
    minutes: int = Query(30, description="How many minutes back to look"),
    limit: int = Query(500, le=5000),
    db: Session = Depends(get_db),
):
    """Historical readings for one PMU, for drawing trend charts."""
    since = datetime.utcnow() - timedelta(minutes=minutes)
    results = (
        db.query(Reading)
        .filter(Reading.pmu_id == pmu_id, Reading.received_at >= since)
        .order_by(Reading.received_at.asc())
        .limit(limit)
        .all()
    )
    return results


@app.get("/api/health")
def health_check():
    """Simple endpoint to confirm the server is alive — useful once deployed."""
    return {"status": "ok", "time": datetime.utcnow().isoformat()}


# ---------------------------------------------------------------------------
# 3. WEBSOCKET — dashboard connects here for live push updates
# ---------------------------------------------------------------------------
@app.websocket("/ws/live")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # We don't expect the dashboard to send anything, but we need to
            # keep the connection open and listening, or it will close.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
