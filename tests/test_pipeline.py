import io
import json
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pandas as pd
import requests
from fastapi.testclient import TestClient
from pydantic import ValidationError

from aiops.config import settings
from aiops.contracts import NetworkMetric, Detection
from aiops.features import FeatureBuilder, rule_detection
from aiops.kafka import commit_messages, quarantine
from integrations.adapters import NetBoxAdapter, ZabbixAdapter, LibreNMSAdapter, GNS3Adapter, EVENGAdapter
from integrations.hub import create_app
from integrations.state import StateStore
from consumer.kafka_to_minio import persist_batch, run_consumer
from predictor.auto_predictor import detect, process_batch
from model.train import temporal_split


def metric(**changes):
    return NetworkMetric.model_validate({"device_id": "core-01", "source": "zabbix",
        "timestamp": "2026-10-11T00:00:00Z", "latency_ms": 220, **changes}).model_dump(mode="json")


def detection(index, severity="critical", **changes):
    return Detection(event_id=f"event-{index}", device_id="core-01", source="zabbix",
        timestamp=datetime(2026, 10, 11, tzinfo=timezone.utc) + timedelta(seconds=index),
        severity=severity, method="rules", **changes)


def response(data, status=200):
    result = Mock(status_code=status)
    result.json.return_value = data
    if status >= 400:
        result.raise_for_status.side_effect = requests.HTTPError(str(status))
    return result


def session_with(*payloads):
    session = Mock(headers={})
    session.request.side_effect = [response(payload) for payload in payloads]
    return session


class ContractTests(unittest.TestCase):
    def test_missing_measurements_stay_missing(self):
        event = metric()
        self.assertIsNone(event["cpu_usage_pct"])
        self.assertIsNone(event["is_anomaly"])
        self.assertEqual(event["event_id"], metric()["event_id"])

    def test_invalid_data_rejected(self):
        for changes in ({"cpu_usage_pct": 101}, {"latency_ms": float("nan")},
                        {"timestamp": "2026-10-11T00:00:00"}, {"is_anomaly": False},
                        {"latency_ms": None}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                metric(**changes)

    def test_features_are_causal_and_replay_is_ignored(self):
        builder = FeatureBuilder()
        first = metric(latency_ms=10)
        second = metric(latency_ms=30, timestamp="2026-10-11T00:00:01Z")
        self.assertEqual(builder.enrich(first)["latency_ms_rolling5"], 10)
        enriched = builder.enrich(second)
        self.assertEqual(enriched["latency_ms_rolling5"], 20)
        self.assertEqual(enriched["latency_ms_zscore"], 1)
        self.assertEqual(builder.enrich(second)["latency_ms_rolling5"], 20)
        self.assertEqual(enriched["hour"], 0)
        missing = metric(latency_ms=None, throughput_mbps=10, timestamp="2026-10-11T00:00:02Z")
        self.assertIsNone(builder.enrich(missing)["latency_ms_rolling5"])

    def test_rule_fallback_only_uses_measured_fields(self):
        self.assertEqual(rule_detection(metric())[0], "critical")
        self.assertEqual(rule_detection({"throughput_mbps": 10})[0], "unknown")

    def test_temporal_split_does_not_fit_scaler_on_holdout(self):
        frame = pd.DataFrame({"timestamp": pd.date_range("2026-10-10", periods=100, freq="s", tz="UTC"),
                              "latency_ms": list(range(80)) + [10000] * 20})
        train, test, scaler, _, _ = temporal_split(frame, ["latency_ms"])
        self.assertLess(train.timestamp.max(), test.timestamp.min())
        self.assertEqual(scaler.mean_[0], 39.5)


class AdapterTests(unittest.TestCase):
    def test_netbox_pagination_and_token_versions(self):
        fake = session_with({"results": [{"id": 1, "name": "core-01", "site": {"name": "Jakarta"},
                               "primary_ip4": {"address": "10.0.0.1/24"}, "custom_fields": {"aiops_maintenance": True}}],
                             "next": "http://netbox.test/api/dcim/devices/?offset=1"},
                            {"results": [{"id": 2, "name": "core-02"}], "next": None})
        adapter = NetBoxAdapter({"name": "netbox", "kind": "netbox", "url": "http://netbox.test", "token": "nbt_key.secret", "auth_scheme": "auto"}, fake)
        result = adapter.poll()
        self.assertEqual(len(result.inventory), 2)
        self.assertEqual(result.inventory[0]["management_ip"], "10.0.0.1")
        self.assertTrue(result.inventory[0]["maintenance"])
        self.assertEqual(fake.headers["Authorization"], "Bearer nbt_key.secret")

    def test_netbox_cannot_forward_token_to_other_origin(self):
        fake = session_with({"results": [], "next": "http://other.test/api/devices"})
        with self.assertRaises(ValueError):
            NetBoxAdapter({"name": "netbox", "kind": "netbox", "url": "http://netbox.test"}, fake).poll()
        self.assertEqual(fake.request.call_count, 1)

    def test_zabbix_converts_units_and_skips_stale_items(self):
        now = int(datetime.now(timezone.utc).timestamp())
        fake = session_with({"result": [{"hostid": "1", "host": "core-01", "interfaces": [{"ip": "10.0.0.1"}]}]},
            {"result": [{"hostid": "1", "key_": "icmppingsec", "lastvalue": "0.23", "lastclock": str(now), "state": "0"},
                        {"hostid": "1", "key_": "cpu", "lastvalue": "10", "lastclock": str(now-1000), "state": "0"}]})
        adapter = ZabbixAdapter({"name": "zabbix", "kind": "zabbix", "url": "http://zabbix.test",
            "metric_map": {"latency_ms": {"key": "icmppingsec", "scale": 1000}, "cpu_usage_pct": {"key": "cpu"}}}, fake)
        result = adapter.poll()
        self.assertEqual(result.telemetry[0]["latency_ms"], 230)
        self.assertIsNone(result.telemetry[0]["cpu_usage_pct"])
        self.assertNotIn("auth", fake.request.call_args.kwargs["json"])

    def test_librenms_uses_port_octet_rates_and_does_not_invent_loss(self):
        stamp = datetime.now(timezone.utc).isoformat()
        fake = session_with({"devices": [{"device_id": 1, "hostname": "core-01", "last_polled": stamp, "last_ping_timetaken": 12}]},
            {"graphs": [{"sensor_id": 7, "desc": "CPU0"}, {"sensor_id": 8, "desc": "CPU1"}]},
            {"graphs": [{"processor_usage": "40"}]}, {"graphs": [{"processor_usage": "60"}]},
            {"ports": [{"ifName": "Gi0/0", "ifInOctets_rate": 1000000, "ifOutOctets_rate": 1000000}]})
        result = LibreNMSAdapter({"name": "librenms", "kind": "librenms", "url": "http://libre.test", "interfaces": ["Gi0/0"]}, fake).poll()
        self.assertEqual(result.telemetry[0]["cpu_usage_pct"], 50)
        self.assertEqual(result.telemetry[0]["throughput_mbps"], 16)
        self.assertIsNone(result.telemetry[0]["packet_loss_pct"])

    def test_gns3_collects_topology_without_fake_metrics(self):
        fake = session_with([{"node_id": "n1", "name": "core-01", "status": "started"}],
                            [{"link_id": "l1", "nodes": [{"node_id": "n1", "port_number": 0}]}])
        result = GNS3Adapter({"name": "gns3", "kind": "gns3", "url": "http://gns.test", "project_id": "p1"}, fake).poll()
        self.assertEqual(result.telemetry, [])
        self.assertEqual(result.topology["links"][0]["endpoints"][0]["remote_id"], "n1")
        self.assertTrue(all(call.args[0] == "GET" for call in fake.request.call_args_list))

    def test_eve_ng_cookie_login_and_interfaces(self):
        fake = session_with({"status": "success"}, {"status": "success", "data": {"1": {"name": "core-01", "template": "vios"}}},
                            {"status": "success", "data": {"ethernet": [{"name": "Gi0/0", "network_id": 2}]}})
        result = EVENGAdapter({"name": "eve-ng", "kind": "eve_ng", "url": "http://eve.test",
            "username": "admin", "password": "test", "lab_path": "Lab 1.unl"}, fake).poll()
        self.assertEqual(result.inventory[0]["remote_id"], "1")
        self.assertEqual(result.telemetry, [])
        self.assertIn("Lab%201.unl", fake.request.call_args.args[1])


class StateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = StateStore(Path(self.temp.name) / "state.db")

    def tearDown(self):
        self.temp.cleanup()

    def test_confirmation_dedup_recovery_and_persistence(self):
        for index in (1, 2):
            self.assertEqual(self.store.observe(detection(index), workflow_url="http://workflow.test")["state"], "observing")
        self.assertEqual(self.store.observe(detection(3), workflow_url="http://workflow.test")["state"], "open")
        self.assertTrue(self.store.observe(detection(3))["duplicate"])
        self.assertEqual(len(self.store.pending()), 1)
        restored = StateStore(self.store.path)
        self.assertEqual(restored.incidents()[0]["streak"], 3)
        for index in (4, 5):
            self.assertEqual(restored.observe(detection(index, "normal"), workflow_url="http://workflow.test")["state"], "open")
        self.assertEqual(restored.observe(detection(6, "normal"), workflow_url="http://workflow.test")["state"], "resolved")
        self.assertEqual(len(restored.pending()), 2)
        incident_id = restored.incidents()[0]["incident_id"]
        self.assertEqual([row["state"] for row in restored.incident_history(incident_id)], ["open", "resolved"])

    def test_maintenance_never_queues_action(self):
        result = self.store.observe(detection(1), 1, maintenance=True, workflow_url="http://workflow.test")
        self.assertEqual(result["state"], "suppressed")
        self.assertEqual(self.store.pending(), [])

    def test_same_external_event_id_from_two_sources_is_independent(self):
        first = detection(1)
        second = first.model_copy(update={"source": "librenms"})
        self.store.observe(first, 1)
        self.store.observe(second, 1)
        self.assertEqual(len(self.store.incidents()), 2)

    def test_stale_event_does_not_resolve_current_incident(self):
        self.store.observe(detection(5), 1)
        self.assertEqual(self.store.observe(detection(1, "normal"))["ignored"], "out_of_order")
        self.assertEqual(self.store.incidents()[0]["state"], "open")

    def test_incomplete_recovery_does_not_clear_anomaly(self):
        self.store.observe(detection(1, evidence={"telemetry": {"latency_ms": 250, "packet_loss_pct": 20}}), 1)
        result = self.store.observe(detection(2, "normal", evidence={"telemetry": {"latency_ms": 10}}), 1, 1)
        self.assertEqual(result["ignored"], "insufficient_recovery_evidence")
        self.assertEqual(self.store.incidents()[0]["state"], "open")

    def test_outbox_survives_restart_and_deduplicates(self):
        self.assertTrue(self.store.enqueue("m1", "kafka", "metrics", metric()))
        self.assertFalse(self.store.enqueue("m1", "kafka", "metrics", metric()))
        restored = StateStore(self.store.path)
        row = restored.pending()[0]
        restored.failed(row["id"], requests.ConnectionError("secret must not be stored"))
        with restored.transaction() as db:
            saved = dict(db.execute("SELECT * FROM outbox").fetchone())
        self.assertEqual(saved["last_error"], "ConnectionError")
        self.assertEqual(saved["attempts"], 1)
        restored.delivered(row["id"])
        self.assertEqual(restored.delivery_counts()["sent"], 1)


class APIAndDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        config = replace(settings, state_db=str(Path(self.temp.name) / "state.db"), hub_token="test-token")
        self.app = create_app(config, background=False)
        self.client = TestClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def test_ingestion_is_authenticated_validated_and_queued_once(self):
        body = {"events": [metric()]}
        self.assertEqual(self.client.post("/ingest/metrics", json=body).status_code, 401)
        self.assertEqual(self.client.post("/ingest/metrics", json=body, headers=self.headers).json()["accepted"], 1)
        self.assertEqual(self.client.post("/ingest/metrics", json=body, headers=self.headers).json()["duplicates"], 1)
        self.assertEqual(self.client.post("/ingest/metrics", json={"events": [{"device_id": "x"}]}, headers=self.headers).status_code, 422)

    def test_netbox_enriches_remote_ip_and_maintenance(self):
        hub = self.app.state.hub
        hub.store.snapshot("inventory:netbox", [{"device_id": "canonical-core", "netbox_id": 1, "management_ip": "10.0.0.1", "region": "Jakarta", "maintenance": True}])
        hub.store.snapshot("inventory:zabbix", [{"device_id": "core-01", "remote_id": "1", "management_ip": "10.0.0.1"}])
        hub.ingest(NetworkMetric.model_validate(metric(metadata={"remote_id": "1"})))
        event = json.loads(hub.store.pending()[0]["data"])
        self.assertEqual(event["device_id"], "canonical-core")
        self.assertEqual(event["region"], "Jakarta")
        self.assertEqual(hub.observe(detection(1))["state"], "suppressed")

    def test_alertmanager_firing_and_resolved(self):
        labels = {"alertname": "ConnectorDown", "connector": "zabbix", "severity": "warning"}
        alert = {"labels": labels, "fingerprint": "abc", "status": "firing", "startsAt": "2026-10-11T00:00:00Z"}
        self.assertEqual(self.client.post("/alerts/alertmanager", json={"alerts": [alert]}, headers=self.headers).status_code, 200)
        self.assertEqual(self.app.state.hub.store.incidents()[0]["state"], "open")
        alert.update(status="resolved", endsAt="2026-10-11T00:05:00Z")
        self.client.post("/alerts/alertmanager", json={"alerts": [alert]}, headers=self.headers)
        self.assertEqual(self.app.state.hub.store.incidents()[0]["state"], "resolved")

    def test_partial_telemetry_uses_rules_when_api_rejects(self):
        session = Mock()
        session.post.return_value = response({}, 422)
        result = detect(FeatureBuilder().enrich(metric()), session)
        self.assertEqual(result.method, "rules")
        self.assertEqual(result.severity, "critical")

    def test_predictor_never_commits_when_hub_write_fails(self):
        consumer, publisher, session = Mock(), Mock(), Mock()
        session.post.side_effect = [response({}, 503), response({}, 500)]
        with self.assertRaises(requests.HTTPError):
            process_batch(consumer, publisher, session, [], [FeatureBuilder().enrich(metric())])
        consumer.commit.assert_not_called()
        publisher.send.assert_not_called()

    def test_storage_second_write_failure_does_not_commit(self):
        record = metric()
        msg = SimpleNamespace(topic=settings.metrics_topic, partition=0, offset=0, value=json.dumps(record).encode())
        consumer, publisher, s3 = Mock(), Mock(), Mock()
        consumer.poll.return_value = {"partition": [msg]}
        s3.put_object.side_effect = [None, RuntimeError("storage unavailable")]
        with patch.dict("os.environ", {"STORAGE_BATCH_SIZE": "1"}), patch("consumer.kafka_to_minio.WorkerMonitor.start"), patch("consumer.kafka_to_minio.KafkaConsumer", return_value=consumer), patch("consumer.kafka_to_minio.producer", return_value=publisher), patch("consumer.kafka_to_minio.create_minio_client", return_value=s3):
            with self.assertRaises(RuntimeError):
                run_consumer()
        self.assertEqual(s3.put_object.call_count, 2)
        consumer.commit.assert_not_called()
        consumer.close.assert_called_once_with(autocommit=False)

    def test_persisted_parquet_preserves_unknowns_and_metadata(self):
        record = metric()
        s3 = Mock()
        msg = SimpleNamespace(partition=0, offset=10)
        persist_batch(s3, [record], [FeatureBuilder().enrich(record)], [msg])
        raw = s3.put_object.call_args_list[0].kwargs
        frame = pd.read_parquet(io.BytesIO(raw["Body"]))
        self.assertTrue(pd.isna(frame.iloc[0]["cpu_usage_pct"]))
        self.assertEqual(json.loads(frame.iloc[0]["metadata"]), {})
        self.assertIn("p0-10-10", raw["Key"])

    def test_storage_separates_observations_crossing_hour_boundary(self):
        records = [metric(timestamp="2026-10-11T00:59:59Z"), metric(timestamp="2026-10-11T01:00:01Z")]
        builder = FeatureBuilder()
        s3 = Mock()
        persist_batch(s3, records, [builder.enrich(record) for record in records], [SimpleNamespace(partition=0, offset=i) for i in range(2)])
        self.assertEqual(s3.put_object.call_count, 4)
        keys = [call.kwargs["Key"] for call in s3.put_object.call_args_list]
        self.assertEqual(sum("hour=00/" in key for key in keys), 2)
        self.assertEqual(sum("hour=01/" in key for key in keys), 2)

    def test_commits_next_offset_per_partition(self):
        consumer = Mock()
        messages = [SimpleNamespace(topic="metrics", partition=0, offset=4), SimpleNamespace(topic="metrics", partition=0, offset=2), SimpleNamespace(topic="metrics", partition=1, offset=8)]
        commit_messages(consumer, messages)
        offsets = consumer.commit.call_args.kwargs["offsets"]
        self.assertEqual(sorted(value.offset for value in offsets.values()), [5, 9])

    def test_quarantine_waits_for_broker_ack(self):
        publisher = Mock()
        message = SimpleNamespace(topic="metrics", partition=0, offset=1, value=b"invalid")
        quarantine(publisher, message, ValueError("bad data"))
        publisher.send.return_value.get.assert_called_once_with(timeout=15)

    def test_model_api_reports_missing_features_instead_of_filling_defaults(self):
        from api import model_server
        bundle = {"model": Mock(), "scaler": Mock(), "features": ["latency_ms", "cpu_usage_pct"]}
        with patch.object(model_server, "_model_bundle", bundle), TestClient(model_server.app) as client:
            result = client.post("/predict", json={"device_id": "core-01", "latency_ms": 10})
            self.assertEqual(result.status_code, 422)
            self.assertEqual(result.json()["detail"]["missing_model_features"], ["cpu_usage_pct"])
            bundle["scaler"].transform.assert_not_called()

    def test_real_sklearn_bundle_predicts_through_model_api(self):
        from api import model_server
        from sklearn.ensemble import RandomForestClassifier
        from sklearn.preprocessing import StandardScaler
        frame = pd.DataFrame({"latency_ms": [10, 12, 14, 220, 240, 260]})
        scaler = StandardScaler().fit(frame)
        model = RandomForestClassifier(n_estimators=20, random_state=42).fit(scaler.transform(frame), [0, 0, 0, 1, 1, 1])
        bundle = {"model": model, "scaler": scaler, "features": ["latency_ms"]}
        with patch.object(model_server, "_model_bundle", bundle), TestClient(model_server.app) as client:
            result = client.post("/predict", json={"device_id": "core-01", "latency_ms": 250})
            self.assertEqual(result.status_code, 200)
            self.assertTrue(result.json()["is_anomaly"])
            self.assertEqual(client.get("/ready").status_code, 200)


if __name__ == "__main__":
    unittest.main()
