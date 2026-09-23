"""
Pydantic schemas: these define the exact JSON "contract" — what a PMU must
send in, and what the API sends back out. FastAPI uses these to validate
incoming data automatically and to auto-generate API docs.
"""

from pydantic import BaseModel, Field
from datetime import datetime
from typing import Optional


class ReadingIn(BaseModel):
    """What a PMU device sends when reporting a measurement."""
    pmu_id: int = Field(..., ge=1, description="Which PMU unit (1-4)")
    voltage: float = Field(..., description="RMS voltage")
    current: float = Field(..., description="RMS current")
    angle: float = Field(..., description="V-I phase angle in degrees")
    frequency: Optional[float] = Field(None, description="Estimated frequency in Hz")
    timestamp: Optional[datetime] = Field(
        None, description="Device's own timestamp, ISO 8601. Optional."
    )


class ReadingOut(BaseModel):
    """What the API returns when the dashboard asks for data."""
    id: int
    pmu_id: int
    voltage: float
    current: float
    angle: float
    frequency: Optional[float]
    device_timestamp: Optional[datetime]
    received_at: datetime

    class Config:
        from_attributes = True  # lets this build directly from the ORM object
