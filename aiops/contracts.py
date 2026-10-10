"""Versioned telemetry; unknown measurements remain unknown."""
import hashlib
import json
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator

MEASUREMENTS = (
    "latency_ms", "packet_loss_pct", "cpu_usage_pct", "throughput_mbps",
    "signal_strength_dbm", "error_rate",
)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def fingerprint(value: dict) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


class NetworkMetric(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)
    schema_version: Literal["1.0"] = "1.0"
    event_id: str = ""
    source: str = Field(default="simulator", min_length=1, max_length=64)
    device_id: str = Field(min_length=1, max_length=200)
    device_type: str = "unknown"
    region: str = "unknown"
    vendor: str = "unknown"
    timestamp: datetime
    latency_ms: float | None = Field(default=None, ge=0)
    packet_loss_pct: float | None = Field(default=None, ge=0, le=100)
    cpu_usage_pct: float | None = Field(default=None, ge=0, le=100)
    throughput_mbps: float | None = Field(default=None, ge=0)
    signal_strength_dbm: float | None = None
    error_rate: float | None = Field(default=None, ge=0, le=1)
    is_anomaly: bool | None = None
    metadata: dict = Field(default_factory=dict)

    @field_validator("timestamp")
    @classmethod
    def aware_timestamp(cls, value):
        if value.tzinfo is None:
            raise ValueError("timestamp must include a timezone")
        return value.astimezone(timezone.utc)

    @model_validator(mode="after")
    def validate_event(self):
        if not any(getattr(self, key) is not None for key in MEASUREMENTS):
            raise ValueError("at least one measured network metric is required")
        if self.source != "simulator" and self.is_anomaly is not None:
            raise ValueError("real telemetry requires separately reviewed training labels")
        if not self.event_id:
            self.event_id = fingerprint(self.model_dump(mode="json", exclude={"event_id"}))
        return self


class Detection(BaseModel):
    model_config = ConfigDict(extra="ignore", allow_inf_nan=False)
    event_id: str = Field(min_length=1)
    device_id: str = Field(min_length=1)
    source: str
    timestamp: datetime
    severity: Literal["normal", "warning", "critical", "unknown"]
    method: Literal["ml", "rules", "alertmanager"]
    region: str = "unknown"
    summary: str = ""
    evidence: dict = Field(default_factory=dict)
    suggested_actions: list[str] = Field(default_factory=list)

    _aware = field_validator("timestamp")(NetworkMetric.aware_timestamp.__func__)
