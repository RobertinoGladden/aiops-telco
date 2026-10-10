"""Causal feature calculation shared by offline ingestion and online inference."""
import math
from collections import defaultdict, deque
from datetime import datetime

from aiops.contracts import MEASUREMENTS

FEATURE_COLS = list(MEASUREMENTS) + [
    "latency_ms_rolling5", "packet_loss_pct_rolling5", "cpu_usage_pct_rolling5",
    "latency_ms_zscore", "cpu_usage_pct_zscore", "hour", "dayofweek", "is_critical",
]


class FeatureBuilder:
    def __init__(self):
        self.history = defaultdict(lambda: deque(maxlen=50))

    def enrich(self, record: dict) -> dict:
        enriched = dict(record)
        key = (record.get("source", "simulator"), record["device_id"])
        history = self.history[key]
        # A replay within the live window does not count as a new observation.
        if not any(row.get("event_id") == record.get("event_id") for row in history) or not record.get("event_id"):
            history.append(dict(record))
        for field in ("latency_ms", "packet_loss_pct", "cpu_usage_pct"):
            recent = [row[field] for row in list(history)[-5:] if row.get(field) is not None]
            enriched[f"{field}_rolling5"] = sum(recent) / len(recent) if recent and record.get(field) is not None else None
            if field != "packet_loss_pct":
                values = [row[field] for row in history if row.get(field) is not None]
                if record.get(field) is None:
                    enriched[f"{field}_zscore"] = None
                else:
                    mean = sum(values) / len(values)
                    std = math.sqrt(sum((value - mean) ** 2 for value in values) / len(values))
                    enriched[f"{field}_zscore"] = (record[field] - mean) / (std or 1)
        timestamp = datetime.fromisoformat(str(record["timestamp"]).replace("Z", "+00:00"))
        enriched["hour"] = timestamp.hour
        enriched["dayofweek"] = timestamp.weekday()
        enriched["is_critical"] = int(any(
            record.get(key) is not None and record[key] > threshold
            for key, threshold in (("latency_ms", 100), ("packet_loss_pct", 5), ("cpu_usage_pct", 90))
        ))
        return enriched


def rule_detection(record: dict) -> tuple[str, list[str]]:
    if not any(record.get(key) is not None for key in ("latency_ms", "packet_loss_pct", "cpu_usage_pct")):
        return "unknown", []
    critical = []
    warning = []
    for key, warn, crit, action in (
        ("latency_ms", 100, 200, "CHECK_ROUTE_AND_BACKUP_PATH"),
        ("packet_loss_pct", 5, 10, "CHECK_INTERFACE_ERRORS_AND_BACKUP_LINK"),
        ("cpu_usage_pct", 90, 95, "CHECK_CONTROL_PLANE_AND_CAPACITY"),
    ):
        value = record.get(key)
        if value is not None and value >= crit:
            critical.append(action)
        elif value is not None and value >= warn:
            warning.append(action)
    return ("critical", critical) if critical else (("warning", warning) if warning else ("normal", []))
