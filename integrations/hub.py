"""Integration API, connector collectors, and durable Kafka/workflow outbox."""
import json
import logging
import os
import secrets
import threading
from typing import Literal
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import requests
import uvicorn
import yaml
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import Response, FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator, model_validator
from prometheus_client import CollectorRegistry, Gauge, generate_latest, CONTENT_TYPE_LATEST

from aiops.config import settings, Settings
from aiops.contracts import Detection, NetworkMetric, fingerprint, utcnow
from aiops.kafka import producer
from integrations.adapters import ADAPTERS
from integrations.state import StateStore
from integrations.intelligence import Intelligence, AIError
from integrations.platform_health import PlatformHealth
from integrations.access import AccessVerifier, PRIVATE_PATHS

log = logging.getLogger(__name__)


class IngestRequest(BaseModel):
    events: list[NetworkMetric] = Field(min_length=1, max_length=500)


class Alert(BaseModel):
    status: Literal["firing", "resolved"] = "firing"
    labels: dict[str, str] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)
    fingerprint: str = ""
    startsAt: datetime
    endsAt: datetime | None = None

    @field_validator("startsAt", "endsAt")
    @classmethod
    def aware(cls, value):
        return NetworkMetric.aware_timestamp(value) if value is not None else None

    @model_validator(mode="after")
    def resolved_timestamp(self):
        if self.status == "resolved" and self.endsAt is None:
            raise ValueError("resolved alert requires endsAt")
        return self


class AlertmanagerPayload(BaseModel):
    alerts: list[Alert] = Field(max_length=500)


class Hub:
    def __init__(self, config: Settings = settings, store=None):
        self.config = config
        self.store = store or StateStore(config.state_db)
        with open(config.connectors_file, encoding="utf-8") as stream:
            self.spec = yaml.safe_load(stream)
        self.stop = threading.Event()
        self.threads = []
        self.registry = CollectorRegistry()
        self.connector_up = Gauge("telco_connector_up", "Last connector collection succeeded", ["connector"], registry=self.registry)
        self.backlog = Gauge("telco_outbox_pending", "Unacknowledged outbound events", registry=self.registry)
        self.incident_gauge = Gauge("telco_incidents", "Incidents by state", ["state"], registry=self.registry)
        self.intelligence = Intelligence(self)
        self.platform_health = PlatformHealth(config)

    def canonical(self, source, device_id, remote_id=""):
        aliases = self.spec.get("aliases", {})
        explicit = aliases.get(f"{source}:{remote_id}") or aliases.get(f"{source}:{device_id}")
        if explicit:
            device_id = explicit
        inventory = self.store.snapshots("inventory:")
        source_inventory = inventory.get(source, {}).get("data", [])
        current = next((row for row in source_inventory if row["device_id"] == device_id or str(row.get("remote_id")) == remote_id), {})
        for snapshot in inventory.values():
            for device in snapshot["data"]:
                if "netbox_id" not in device:
                    continue
                if device["device_id"] == device_id or (current.get("management_ip") and current["management_ip"] == device.get("management_ip")):
                    return device["device_id"], device
        return device_id, current

    def ingest(self, event):
        device_id, inventory = self.canonical(event.source, event.device_id, str(event.metadata.get("remote_id", "")))
        record = event.model_dump(mode="json")
        record["device_id"] = device_id
        for field in ("region", "vendor", "device_type"):
            if inventory.get(field) and inventory[field] != "unknown":
                record[field] = inventory[field]
        record["metadata"]["inventory"] = inventory
        return self.store.enqueue(f"metric:{event.source}:{event.event_id}", "kafka", self.config.metrics_topic, record)

    def observe(self, detection):
        device_id, inventory = self.canonical(detection.source, detection.device_id)
        detection = detection.model_copy(update={"device_id": device_id})
        return self.store.observe(detection, self.config.confirmations, self.config.recovery_confirmations,
                                  maintenance=inventory.get("maintenance", False),
                                  workflow_url=self.config.workflow_url if self.config.workflow_enabled else "")

    def collect(self, spec):
        name = spec["name"]
        adapter = None
        while not self.stop.is_set():
            try:
                adapter = adapter or ADAPTERS[spec["kind"]](spec)
                result = adapter.poll()
                self.store.snapshot(f"inventory:{name}", result.inventory)
                if result.topology:
                    self.store.snapshot(f"topology:{name}", result.topology)
                for metric in result.telemetry:
                    self.ingest(NetworkMetric.model_validate(metric))
                self.store.snapshot(f"status:{name}", {"state": "healthy", "last_success": utcnow(),
                                                       "metrics": len(result.telemetry), "devices": len(result.inventory)})
                self.connector_up.labels(name).set(1)
            except Exception as error:
                self.connector_up.labels(name).set(0)
                self.store.snapshot(f"status:{name}", {"state": "error", "error_type": type(error).__name__})
                log.warning("Connector %s failed: %s", name, type(error).__name__)
                # Keep the last successful inventory during an outage.
            self.stop.wait(self.config.poll_interval)
        if adapter:
            adapter.session.close()

    def deliver(self):
        publisher = None
        with requests.Session() as session:
            while not self.stop.is_set():
                for row in self.store.pending():
                    if self.stop.is_set():
                        break
                    try:
                        event = json.loads(row["data"])
                        if row["kind"] == "kafka":
                            publisher = publisher or producer(self.config.kafka_servers)
                            publisher.send(row["destination"], key=event["device_id"], value=event).get(timeout=15)
                        elif row["kind"] == "workflow":
                            if not self.config.workflow_enabled:
                                continue
                            headers = {"Idempotency-Key": row["event_id"]}
                            if self.config.workflow_token:
                                headers["Authorization"] = f"Bearer {self.config.workflow_token}"
                            response = session.post(row["destination"], json=event, headers=headers, timeout=10, allow_redirects=False)
                            if not 200 <= response.status_code < 300:
                                raise RuntimeError(f"workflow status {response.status_code}")
                        self.store.delivered(row["id"])
                    except Exception as error:
                        self.store.failed(row["id"], error)
                        log.warning("Outbox delivery %s failed: %s", row["id"], type(error).__name__)
                self.stop.wait(1)
        if publisher:
            publisher.close(timeout=5)

    def start(self):
        for spec in self.spec.get("connectors", []):
            if os.getenv(spec.get("enabled_env", ""), "false").lower() != "true":
                self.store.snapshot(f"status:{spec['name']}", {"state": "disabled"})
                continue
            self.threads.append(threading.Thread(target=self.collect, args=(spec,), daemon=True, name=spec["name"]))
        self.threads.append(threading.Thread(target=self.deliver, daemon=True, name="outbox"))
        for thread in self.threads:
            thread.start()

    def close(self):
        self.stop.set()
        for thread in self.threads:
            thread.join(timeout=2)


def create_app(config=settings, store=None, background=True):
    hub = Hub(config, store)

    @asynccontextmanager
    async def lifespan(app):
        if background:
            hub.start()
        yield
        hub.close()

    online = config.deployment_mode == "online"
    verifier = AccessVerifier(config) if online else None
    app = FastAPI(title="Strata Operations API", version="2.2.0", lifespan=lifespan,
                  docs_url=None if online else "/docs", redoc_url=None if online else "/redoc",
                  openapi_url=None if online else "/openapi.json")
    app.state.hub = hub
    app.state.access_verifier = verifier

    @app.middleware("http")
    async def response_headers(request, call_next):
        if online and request.url.path not in PRIVATE_PATHS:
            try:
                request.state.access_identity = await run_in_threadpool(
                    verifier.verify, request.headers.get("Cf-Access-Jwt-Assertion", ""))
            except Exception:
                # Provider outage, bad signatures and missing configuration never grant access.
                response = JSONResponse({"detail": "Valid Cloudflare Access login required"}, status_code=401)
            else:
                response = await call_next(request)
        else:
            response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
        if online:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        if online or not request.url.path.startswith("/assets/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def authorize(authorization: str = Header(default="")):
        if not config.hub_token or not secrets.compare_digest(authorization, f"Bearer {config.hub_token}"):
            raise HTTPException(401, "Integration API requires a Bearer token")

    auth = [Depends(authorize)]

    console_root = Path(__file__).resolve().parents[1] / "console"
    app.mount("/assets", StaticFiles(directory=console_root / "assets"), name="console-assets")

    @app.get("/", include_in_schema=False)
    def console():
        return FileResponse(console_root / "index.html", headers={
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store"})

    @app.get("/console/overview", dependencies=auth)
    def overview():
        statuses = hub.store.snapshots("status:")
        inventory = hub.store.snapshots("inventory:")
        connector_rows = []
        for spec in hub.spec.get("connectors", []):
            enabled = os.getenv(spec.get("enabled_env", ""), "false").lower() == "true"
            status = statuses.get(spec["name"], {})
            state = status.get("data", {}).get("state", "waiting") if enabled else "disabled"
            observed_at = inventory.get(spec["name"], {}).get("observed_at") or status.get("data", {}).get("last_success")
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(observed_at)).total_seconds() if observed_at else None
            if state == "healthy":
                if age is None:
                    state = "waiting"
                elif age > max(90, config.poll_interval * 3):
                    state = "stale"
            connector_rows.append({"id": spec["name"], "kind": spec["kind"], "state": state, "enabled": enabled,
                                   "observed_at": observed_at, "checked_at": status.get("observed_at"), "age_seconds": age,
                                   "devices": len(inventory.get(spec["name"], {}).get("data", [])),
                                   "metrics": status.get("data", {}).get("metrics"),
                                   "error_type": status.get("data", {}).get("error_type"),
                                   "enabled_env": spec.get("enabled_env"), "url_env": spec.get("url_env")})
        incidents = hub.store.incidents()
        decisions = hub.store.ai_runs()
        by_id = {row["incident_id"]: row for row in incidents}
        for run in decisions:
            if run["status"] == "ready" and run["incident_id"] in by_id:
                run["policy"] = hub.intelligence.policy(by_id[run["incident_id"]], run["decision"], run["evidence_hash"])
        services = hub.platform_health.snapshot()
        operations = hub.store.operational_summary()
        operations["pipeline"] = hub.platform_health.observability
        operations["ai"]["daily_limit"] = config.ai_max_daily
        return {"time": utcnow(), "connectors": connector_rows, "services": services, "operations": operations,
                "inventory": inventory, "topology": hub.store.snapshots("topology:"),
                "incidents": incidents, "decisions": decisions, "ai": hub.intelligence.status(),
                "outbox": hub.store.delivery_counts(),
                "summary": {"devices": len({device["device_id"] for snapshot in inventory.values() for device in snapshot["data"]}),
                            "active_incidents": sum(row["state"] == "open" for row in incidents),
                            "healthy_connectors": sum(row["state"] == "healthy" for row in connector_rows),
                            "total_connectors": len(connector_rows)}}

    @app.get("/ai/status", dependencies=auth)
    def ai_status():
        return hub.intelligence.status()

    @app.get("/ai/decisions", dependencies=auth)
    def ai_decisions():
        return hub.store.ai_runs()

    @app.post("/incidents/{incident_id}/analyze", dependencies=auth)
    def analyze(incident_id: str):
        try:
            return hub.intelligence.analyze(incident_id)
        except AIError as error:
            raise HTTPException(error.status, error.code) from None

    @app.post("/ai/decisions/{run_id}/request-review", dependencies=auth)
    def request_review(run_id: str):
        try:
            return hub.intelligence.request_review(run_id)
        except AIError as error:
            raise HTTPException(error.status, error.code) from None

    @app.get("/health")
    def health():
        statuses = hub.store.snapshots("status:")
        degraded = any(row["data"].get("state") == "error" for row in statuses.values())
        return {"status": "degraded" if degraded else "ok", "time": utcnow(), "outbox": hub.store.delivery_counts()}

    @app.get("/connectors", dependencies=auth)
    def connectors():
        return hub.store.snapshots("status:")

    @app.get("/inventory", dependencies=auth)
    def inventory():
        return hub.store.snapshots("inventory:")

    @app.get("/topology", dependencies=auth)
    def topology():
        return hub.store.snapshots("topology:")

    @app.post("/ingest/metrics", status_code=202, dependencies=auth)
    def ingest(request: IngestRequest):
        accepted = sum(hub.ingest(event) for event in request.events)
        return {"accepted": accepted, "duplicates": len(request.events) - accepted, "delivery": "queued"}

    @app.post("/detections", dependencies=auth)
    def detect(detection: Detection):
        return hub.observe(detection)

    @app.get("/incidents", dependencies=auth)
    def incidents():
        return hub.store.incidents()

    @app.get("/incidents/{incident_id}/history", dependencies=auth)
    def incident_history(incident_id: str):
        history = hub.store.incident_history(incident_id)
        if not history:
            raise HTTPException(404, "No incident transitions for this ID")
        return history

    @app.post("/alerts/alertmanager", dependencies=auth)
    def alertmanager(payload: AlertmanagerPayload):
        results = []
        for alert_object in payload.alerts:
            alert = alert_object.model_dump(mode="json")
            labels = alert["labels"]
            status = alert["status"]
            device_id = labels.get("device_id") or labels.get("connector") or labels.get("consumergroup") or labels.get("instance") or labels.get("job", "platform")
            timestamp = alert.get("endsAt") if status == "resolved" else alert["startsAt"]
            severity = "normal" if status == "resolved" else ("critical" if labels.get("severity") == "critical" else "warning")
            detection = Detection(event_id=fingerprint({"alert": alert.get("fingerprint") or labels, "status": status, "timestamp": timestamp}),
                source="alertmanager:" + labels.get("alertname", "unknown"), device_id=device_id,
                timestamp=timestamp or datetime.now(timezone.utc), severity=severity, method="alertmanager",
                summary=alert.get("annotations", {}).get("summary", ""), evidence={"labels": labels})
            # Prometheus already applies its configured 'for' duration to alerts.
            _, context = hub.canonical(detection.source, device_id)
            results.append(hub.store.observe(detection, 1, 1, context.get("maintenance", False),
                           config.workflow_url if config.workflow_enabled else ""))
        return {"processed": len(results)}

    @app.get("/metrics")
    def metrics():
        statuses = hub.store.snapshots("status:")
        inventories = hub.store.snapshots("inventory:")
        for spec in hub.spec.get("connectors", []):
            if os.getenv(spec.get("enabled_env", ""), "false").lower() != "true":
                continue
            status = statuses.get(spec["name"], {}).get("data", {})
            observed = inventories.get(spec["name"], {}).get("observed_at") or status.get("last_success")
            age = (datetime.now(timezone.utc) - datetime.fromisoformat(observed)).total_seconds() if observed else None
            hub.connector_up.labels(spec["name"]).set(int(status.get("state") == "healthy" and age is not None and -30 <= age <= max(90, config.poll_interval * 3)))
        hub.backlog.set(hub.store.delivery_counts().get("pending", 0))
        incidents = hub.store.incidents()
        for state in ("open", "observing", "resolved", "suppressed"):
            hub.incident_gauge.labels(state).set(sum(row["state"] == state for row in incidents))
        return Response(generate_latest(hub.registry), media_type=CONTENT_TYPE_LATEST)

    return app


app = create_app()

if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("INTEGRATION_API_PORT", "8082")))
