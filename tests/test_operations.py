"""Operational monitoring must distinguish unavailable, idle, stale and acknowledged."""
import json
import sqlite3
import tempfile
import time
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import requests
from fastapi.testclient import TestClient
from prometheus_client import generate_latest

from aiops.config import settings
from aiops.telemetry import WorkerMonitor
from integrations.hub import create_app
from integrations.platform_health import PlatformHealth
from integrations.state import StateStore
from predictor.auto_predictor import process_batch
from aiops.contracts import NetworkMetric
from aiops.features import FeatureBuilder


def metric():
    return NetworkMetric.model_validate({"device_id": "core-01", "source": "zabbix",
        "timestamp": "2026-10-11T00:00:00Z", "latency_ms": 220}).model_dump(mode="json")


def response(data, status=200):
    result = Mock(status_code=status)
    result.json.return_value = data
    if status >= 400:
        result.raise_for_status.side_effect = requests.HTTPError(str(status))
    return result


class OperationsTests(unittest.TestCase):
    def test_worker_health_needs_current_heartbeat_not_just_http_200(self):
        worker = WorkerMonitor("storage")
        def probe():
            reply = Mock(status_code=200, text=generate_latest(worker.registry).decode())
            with patch("integrations.platform_health.requests.get", return_value=reply):
                return PlatformHealth.probe(("storage", "Storage worker", "worker", "http://worker/metrics"))
        self.assertEqual(probe()["state"], "stale")
        worker.tick(7)
        current = probe()
        self.assertEqual(current["state"], "healthy")
        self.assertEqual(current["metrics"]["buffered_events"], 7)
        self.assertEqual(current["metrics"]["processed_events_total"], 0)
        worker.heartbeat.set(time.time() - 95)
        self.assertEqual(probe()["state"], "stale")

    def test_predictor_counters_advance_only_after_all_acknowledgements(self):
        worker = WorkerMonitor("predictor")
        consumer, publisher, session = Mock(), Mock(), Mock()
        record = FeatureBuilder().enrich(metric())
        messages = [SimpleNamespace(topic=settings.metrics_topic, partition=0, offset=1)]
        session.post.side_effect = [response({}, 503), response({}, 200)]
        publisher.send.return_value.get.side_effect = RuntimeError("no broker acknowledgement")
        with self.assertRaises(RuntimeError):
            process_batch(consumer, publisher, session, messages, [record], worker)
        consumer.commit.assert_not_called()
        self.assertEqual(worker.processed._value.get(), 0)
        self.assertEqual(worker.last_success._value.get(), 0)
        session.post.side_effect = [response({}, 503), response({}, 200)]
        publisher.send.return_value.get.side_effect = None
        process_batch(consumer, publisher, session, messages, [record], worker)
        self.assertEqual(worker.processed._value.get(), 1)
        self.assertEqual(worker.fallbacks._value.get(), 1)
        self.assertGreater(worker.last_success._value.get(), 0)

    def test_prometheus_missing_and_failed_signals_stay_unknown(self):
        health = PlatformHealth(settings)
        with patch("integrations.platform_health.requests.get", side_effect=requests.Timeout("secret endpoint")):
            result = health.pipeline_metrics()
        self.assertFalse(result["available"])
        self.assertEqual(result["lag"], {"storage": None, "predictor": None})
        self.assertIsNone(result["dead_letter_offset"])
        self.assertIsNone(result["firing_alerts"])
        self.assertNotIn("secret", json.dumps(result))
        empty = response({"status": "success", "data": {"resultType": "vector", "result": []}})
        alerts = response({"status": "success", "data": {"alerts": []}})
        with patch("integrations.platform_health.requests.get", side_effect=lambda url, **kw: alerts if url.endswith("alerts") else empty):
            result = health.pipeline_metrics()
        self.assertTrue(result["available"])
        self.assertIsNone(result["lag"]["storage"])
        self.assertIsNone(result["dead_letter_offset"])
        self.assertEqual(result["firing_alerts"], 0)

    def test_prometheus_reports_real_groups_and_rejects_invalid_values(self):
        health = PlatformHealth(settings)
        def get(url, **kwargs):
            if url.endswith("alerts"):
                return response({"status": "success", "data": {"alerts": [{"state": "firing"}, {"state": "pending"}]}})
            expression = kwargs["params"]["query"]
            self.assertIn('up{job="kafka"} == 1', expression)
            rows = [{"metric": {"consumergroup": "telco-data-pipeline-v2"}, "value": [time.time(), "12"]},
                    {"metric": {"consumergroup": "telco-auto-predictor-v2"}, "value": [time.time(), "NaN"]}] if "consumergroup" in expression else [{"metric": {}, "value": [time.time(), "42"]}]
            return response({"status": "success", "data": {"resultType": "vector", "result": rows}})
        with patch("integrations.platform_health.requests.get", side_effect=get):
            result = health.pipeline_metrics()
        self.assertEqual(result["lag"], {"storage": 12, "predictor": None})
        self.assertEqual(result["dead_letter_offset"], 42)
        self.assertEqual(result["firing_alerts"], 1)

    def test_airflow_requires_scheduler_and_database_health(self):
        for scheduler, expected in (("healthy", "healthy"), ("unhealthy", "unavailable")):
            reply = response({"metadatabase": {"status": "healthy"}, "scheduler": {"status": scheduler}})
            with patch("integrations.platform_health.requests.get", return_value=reply):
                result = PlatformHealth.probe(("airflow", "Airflow", "airflow", "http://airflow/health"))
            self.assertEqual(result["state"], expected)

    def test_model_probe_reports_training_metadata_without_arbitrary_fields(self):
        reply = response({"model_name": "isolation_forest", "features": ["latency_ms"],
                          "metadata": {"trained_at": "2026-10-11T00:00:00Z", "train_rows": 100,
                                       "evaluation": "chronological", "secret": "never-export"}})
        with patch("integrations.platform_health.requests.get", return_value=reply):
            result = PlatformHealth.probe(("model-api", "Model API", "model", "http://model/model/info"))
        self.assertEqual(result["state"], "healthy")
        self.assertEqual(result["model"]["training"]["train_rows"], 100)
        self.assertNotIn("never-export", json.dumps(result))

    def test_legacy_outbox_migration_ledger_and_secret_exclusion(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "state.db")
            with sqlite3.connect(path) as db:
                db.execute("CREATE TABLE outbox (id INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,destination TEXT NOT NULL,data TEXT NOT NULL,state TEXT DEFAULT 'pending',attempts INTEGER DEFAULT 0,next_attempt REAL DEFAULT 0,last_error TEXT)")
                db.execute("INSERT INTO outbox(event_id,kind,destination,data) VALUES ('legacy','workflow','http://secret','{}')")
            db.close()
            store = StateStore(path)
            store.enqueue("fresh", "workflow", "http://secret", {"token": "secret"})
            events = store.operational_summary()["delivery"]["recent"]
            self.assertIsNone(events[1]["created_at"])
            self.assertTrue(events[0]["created_at"])
            store.failed(events[0]["id"], requests.Timeout("secret"))
            self.assertEqual(store.operational_summary()["delivery"]["retrying"], 1)
            store.delivered(events[0]["id"])
            result = store.operational_summary()
            self.assertEqual(result["delivery"]["sent"], 1)
            self.assertEqual(result["delivery"]["retrying"], 0)
            self.assertTrue(result["delivery"]["recent"][0]["delivered_at"])
            self.assertNotIn("secret", json.dumps(result))

    def test_operations_snapshot_is_authenticated_and_uses_persisted_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(replace(settings, state_db=str(Path(directory) / "state.db"), hub_token="test-token"), background=False)
            app.state.hub.store.enqueue("event", "kafka", "topic", {"secret": "hidden"})
            with TestClient(app) as client, patch.object(app.state.hub.platform_health, "snapshot", return_value=[]):
                self.assertEqual(client.get("/console/overview").status_code, 401)
                result = client.get("/console/overview", headers={"Authorization": "Bearer test-token"}).json()
            self.assertEqual(result["operations"]["delivery"]["pending"], 1)
            self.assertEqual(result["operations"]["ai"]["runs_today"], 0)
            self.assertNotIn("hidden", json.dumps(result))

    def test_collector_attempt_time_does_not_claim_a_successful_observation(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(replace(settings, state_db=str(Path(directory) / "state.db"), hub_token="test-token"), background=False)
            hub = app.state.hub
            hub.store.snapshot("status:zabbix", {"state": "error", "error_type": "Timeout"})
            with TestClient(app) as client, patch.object(hub.platform_health, "snapshot", return_value=[]), patch.dict("os.environ", {"ZABBIX_ENABLED": "true"}):
                result = client.get("/console/overview", headers={"Authorization": "Bearer test-token"}).json()
            connector = next(row for row in result["connectors"] if row["id"] == "zabbix")
            self.assertEqual(connector["state"], "error")
            self.assertTrue(connector["checked_at"])
            self.assertIsNone(connector["observed_at"])
            self.assertIsNone(connector["metrics"])

    def test_prometheus_connector_health_expires_with_successful_data(self):
        with tempfile.TemporaryDirectory() as directory:
            app = create_app(replace(settings, state_db=str(Path(directory) / "state.db"), hub_token="test-token"), background=False)
            hub = app.state.hub
            hub.store.snapshot("status:zabbix", {"state": "healthy", "last_success": (datetime.now(timezone.utc) - timedelta(minutes=20)).isoformat()})
            with TestClient(app) as client, patch.dict("os.environ", {"ZABBIX_ENABLED": "true"}):
                self.assertIn('telco_connector_up{connector="zabbix"} 0.0', client.get("/metrics").text)
                hub.store.snapshot("inventory:zabbix", [])
                self.assertIn('telco_connector_up{connector="zabbix"} 1.0', client.get("/metrics").text)


if __name__ == "__main__":
    unittest.main()
