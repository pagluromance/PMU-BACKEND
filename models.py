"""
Database table definition.

One row = one phasor reading from one PMU at one instant.
"""

from sqlalchemy import Column, Integer, Float, String, DateTime, Index
from sqlalchemy.sql import func
from database import Base


class Reading(Base):
    __tablename__ = "readings"

    id = Column(Integer, primary_key=True, index=True)

    # Which PMU sent this (1, 2, 3, 4 for your four units)
    pmu_id = Column(Integer, nullable=False, index=True)

    # The core phasor quantities
    voltage = Column(Float, nullable=False)       # RMS volts
    current = Column(Float, nullable=False)       # RMS amps
    angle = Column(Float, nullable=False)          # V-I angle, degrees
    frequency = Column(Float, nullable=True)       # Hz, optional if device doesn't estimate it

    # When the PMU took the measurement (device's own clock/report).
    # If the device doesn't send one, we fall back to server arrival time.
    device_timestamp = Column(DateTime(timezone=True), nullable=True)

    # When our server actually received it — always set, useful for
    # diagnosing transport delay (GSM/WiFi latency) later.
    received_at = Column(DateTime(timezone=True), server_default=func.now())

    # Composite index: speeds up "give me PMU 2's recent history" queries,
    # which is exactly what the dashboard will ask for constantly.
    __table_args__ = (
        Index("ix_pmu_time", "pmu_id", "received_at"),
    )
