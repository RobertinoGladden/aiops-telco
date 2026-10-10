"""Provider contracts, durable audit, and review gates without external AI calls."""
import json
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import Mock, patch

import requests
from fastapi.testclient import TestClient

from aiops.config import settings
from aiops.contracts import Detection
from integrations.hub import create_app
from integrations.intelligence import ACTIONS, AIError, parse_decision
from integrations.state import StateStore


def provider_responses(action="collect_diagnostics", confidence=.96, sufficient=.98):
    analysis = {"summary": "Latency terukur tinggi.", "probable_cause": "Gangguan link masih berupa hipotesis.",
                "evidence": ["Latency 250 ms"], "missing_evidence": ["Interface counters"],
                "recommended_action": action, "rationale": "Kumpulkan diagnostik sebelum intervensi."}
    groq = {"choices": [{"message": {"content": json.dumps(analysis)}}], "usage": {"total_tokens": 200}}
    decisions = {"model": "gpt-6-luna", "answers": [
        {"type": "choice", "name": "next_action", "choice": action, "confidence": confidence,
         "probabilities": [{"value": value, "probability": .96 if value == action else .01} for value in ACTIONS]},
        {"type": "predicate", "name": "evidence_sufficient", "probability": sufficient}],
        "usage": {"input_tokens": 100, "output_tokens": 0}}
    return groq, decisions


def fake_response(payload, status=200):
    response = Mock(status_code=status)
    response.json.return_value = payload
    return response


class IntelligenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = replace(settings, state_db=str(Path(self.temp.name) / "state.db"), hub_token="test-token",
                              ai_enabled=True, groq_api_key="groq-secret", openai_api_key="openai-secret",
                              ai_max_daily=2, ai_cooldown=1, workflow_enabled=True, workflow_url="http://workflow.test")
        self.app = create_app(self.config, background=False)
        self.hub = self.app.state.hub
        self.client = TestClient(self.app)
        self.headers = {"Authorization": "Bearer test-token"}
        self.incident = self.observe("event-1")
        self.path = f"/incidents/{self.incident['incident_id']}/analyze"

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def observe(self, event, **updates):
        detection = Detection.model_validate({"event_id": event, "device_id": "core-01", "source": "zabbix",
            "timestamp": datetime.now(timezone.utc), "severity": "critical", "method": "rules",
            "evidence": {"telemetry": {"latency_ms": 250, "metadata": {"password": "never-send"}}}, **updates})
        return self.hub.store.observe(detection, 1, 1)

    def analyze(self, action="collect_diagnostics", confidence=.96, sufficient=.98):
        session = Mock()
        session.post.side_effect = [fake_response(payload) for payload in provider_responses(action, confidence, sufficient)]
        with patch("integrations.intelligence.requests.Session") as factory:
            factory.return_value.__enter__.return_value = session
            result = self.client.post(self.path, headers=self.headers)
        return result, session

    def review(self, run):
        return self.client.post(f"/ai/decisions/{run['id']}/request-review", headers=self.headers)

    def test_groq_and_openai_contracts_audit_and_idempotent_review(self):
        result, session = self.analyze()
        self.assertEqual(result.status_code, 200, result.text)
        run = result.json()
        self.assertTrue(run["policy"]["eligible_for_review"])
        groq, openai = session.post.call_args_list
        self.assertEqual(groq.args[0], "https://api.groq.com/openai/v1/chat/completions")
        schema = groq.kwargs["json"]["response_format"]["json_schema"]
        self.assertTrue(schema["strict"])
        self.assertFalse(schema["schema"]["additionalProperties"])
        self.assertEqual(openai.args[0], "https://api.openai.com/v1/decisions")
        self.assertEqual(openai.kwargs["json"]["model"], "gpt-6-luna")
        self.assertEqual([q["type"] for q in openai.kwargs["json"]["questions"]], ["choice", "predicate"])
        self.assertEqual(groq.kwargs["headers"]["Authorization"], "Bearer groq-secret")
        self.assertEqual(openai.kwargs["headers"]["Authorization"], "Bearer openai-secret")
        facts = groq.kwargs["json"]["messages"][1]["content"]
        self.assertNotIn("never-send", facts)
        self.assertNotIn("metadata", facts)
        self.assertEqual(StateStore(self.config.state_db).ai_run(run["id"])["status"], "ready")
        self.assertEqual(self.review(run).json()["review_status"], "queued")
        self.assertEqual(self.review(run).status_code, 200)
        queued = self.hub.store.pending()
        self.assertEqual(len(queued), 1)
        self.assertEqual(json.loads(queued[0]["data"])["execution_status"], "not_executed")

    def test_cache_reuses_evidence_without_paying_provider(self):
        run = self.analyze()[0].json()
        with patch("integrations.intelligence.requests.Session") as factory:
            cached = self.client.post(self.path, headers=self.headers)
        self.assertTrue(cached.json()["cached"])
        self.assertEqual(cached.json()["id"], run["id"])
        factory.assert_not_called()

    def test_all_ai_and_console_data_require_token(self):
        for method, path in [("get", "/ai/status"), ("get", "/ai/decisions"), ("get", "/console/overview"),
                             ("post", self.path), ("post", "/ai/decisions/unknown/request-review")]:
            self.assertEqual(getattr(self.client, method)(path).status_code, 401)
        page = self.client.get("/")
        self.assertEqual(page.status_code, 200)
        self.assertIn("frame-ancestors 'none'", page.headers["Content-Security-Policy"])
        self.assertNotIn("groq-secret", page.text)
        self.assertEqual(self.client.get("/assets/app.js").status_code, 200)

    def test_status_exposes_presence_and_never_keys(self):
        result = self.client.get("/ai/status", headers=self.headers)
        self.assertTrue(result.json()["ready"])
        self.assertNotIn("groq-secret", result.text)
        self.assertNotIn("openai-secret", result.text)
        self.assertEqual(result.headers["Cache-Control"], "no-store")

    def test_disabled_or_missing_provider_keys_make_no_calls(self):
        for changes in ({"ai_enabled": False}, {"openai_api_key": ""}, {"groq_api_key": ""}):
            with TestClient(create_app(replace(self.config, **changes), background=False)) as client, patch("integrations.intelligence.requests.Session") as factory:
                self.assertEqual(client.post(self.path, headers=self.headers).status_code, 503)
                factory.assert_not_called()

    def test_timeout_audited_without_secrets_and_review_closed(self):
        with patch("integrations.intelligence.requests.Session") as factory:
            factory.return_value.__enter__.return_value.post.side_effect = requests.Timeout("groq-secret must never be stored")
            result = self.client.post(self.path, headers=self.headers)
        self.assertEqual(result.status_code, 502)
        run = self.hub.store.ai_runs()[0]
        self.assertEqual(run["error_code"], "provider_unavailable")
        self.assertNotIn("groq-secret", json.dumps(run))
        self.assertEqual(self.review(run).status_code, 409)
        self.assertEqual(self.hub.store.pending(), [])

    def test_refusal_invalid_choice_and_nonfinite_probability_are_rejected(self):
        groq, valid = provider_responses()
        cases = [{"answers": [{"type": "refusal", "name": "next_action"}, valid["answers"][1]]},
                 {"answers": [{**valid["answers"][0], "choice": "reload_router"}, valid["answers"][1]]},
                 {"answers": [{**valid["answers"][0], "confidence": float("nan")}, valid["answers"][1]]},
                 {"answers": [{**valid["answers"][0], "choice": {}}, valid["answers"][1]]}]
        for payload in cases:
            with self.subTest(payload=payload), self.assertRaises(AIError):
                parse_decision(payload)

    def test_invalid_groq_content_stops_before_decisions(self):
        with patch("integrations.intelligence.requests.Session") as factory:
            session = factory.return_value.__enter__.return_value
            session.post.return_value = fake_response({"choices": [{"message": {"content": '{"command":"reload"}'}}]})
            result = self.client.post(self.path, headers=self.headers)
        self.assertEqual(result.status_code, 502)
        self.assertEqual(session.post.call_count, 1)
        self.assertEqual(self.hub.store.ai_runs()[0]["status"], "failed")

    def test_low_confidence_and_evidence_probability_block_review(self):
        result, _ = self.analyze(confidence=.3, sufficient=.2)
        run = result.json()
        self.assertFalse(run["policy"]["eligible_for_review"])
        self.assertEqual(set(run["policy"]["blockers"]), {"low_confidence", "insufficient_evidence"})
        self.assertEqual(self.review(run).status_code, 409)
        self.assertEqual(self.hub.store.pending(), [])

    def test_new_evidence_invalidates_decision_even_same_incident_version(self):
        run = self.analyze()[0].json()
        fresh = self.observe("event-2")
        self.assertEqual(fresh["version"], run["incident_version"])
        result = self.review(run)
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json()["detail"], "evidence_changed")

    def test_maintenance_activated_after_analysis_blocks_review(self):
        run = self.analyze()[0].json()
        self.hub.store.snapshot("inventory:netbox", [{"device_id": "core-01", "netbox_id": 1, "maintenance": True}])
        self.assertEqual(self.review(run).json()["detail"], "maintenance")
        self.assertEqual(self.hub.store.pending(), [])

    def test_old_or_empty_evidence_rejected_before_provider_call(self):
        for updates, expected in [({"timestamp": datetime.now(timezone.utc)-timedelta(minutes=10)}, "evidence_stale"),
                                   ({"evidence": {}}, "no_measured_evidence")]:
            with self.hub.store.transaction() as db:
                db.execute("DELETE FROM incidents")
                db.execute("DELETE FROM incident_history")
            self.observe(expected, **updates)
            with patch("integrations.intelligence.requests.Session") as factory:
                result = self.client.post(self.path, headers=self.headers)
            self.assertEqual(result.json()["detail"], expected)
            factory.assert_not_called()

    def test_daily_budget_and_cooldown_are_durable(self):
        self.analyze()
        self.observe("event-2")
        self.assertEqual(self.client.post(self.path, headers=self.headers).json()["detail"], "cooldown")
        with self.hub.store.transaction() as db:
            db.execute("UPDATE ai_runs SET created_at=?", ((datetime.now(timezone.utc)-timedelta(seconds=2)).isoformat(),))
        self.analyze()
        self.observe("event-3")
        with self.hub.store.transaction() as db:
            db.execute("UPDATE ai_runs SET created_at=?", ((datetime.now(timezone.utc)-timedelta(seconds=2)).isoformat(),))
        self.assertEqual(self.client.post(self.path, headers=self.headers).json()["detail"], "daily_limit")

    def test_workflow_disabled_cannot_queue_review(self):
        run = self.analyze()[0].json()
        with TestClient(create_app(replace(self.config, workflow_enabled=False), background=False)) as client:
            result = client.post(f"/ai/decisions/{run['id']}/request-review", headers=self.headers)
        self.assertEqual(result.json()["detail"], "workflow_not_configured")
        self.assertEqual(self.hub.store.pending(), [])

    def test_failover_requires_topology_for_affected_device(self):
        self.hub.store.snapshot("topology:gns3", {"links": [{"endpoints": [{"remote_id": "n1"}]}]})
        self.hub.store.snapshot("inventory:gns3", [{"device_id": "other-device", "remote_id": "n1"}])
        run = self.analyze(action="review_failover")[0].json()
        self.assertIn("topology_unavailable", run["policy"]["blockers"])
        self.assertEqual(self.review(run).status_code, 409)
        self.hub.store.snapshot("inventory:gns3", [{"device_id": "core-01", "remote_id": "n1"}])
        self.assertEqual(self.review(run).status_code, 200)

    def test_provider_error_records_failed_stage_and_stops(self):
        with patch("integrations.intelligence.requests.Session") as factory:
            session = factory.return_value.__enter__.return_value
            session.post.return_value = fake_response({"error": "secret provider details"}, 401)
            result = self.client.post(self.path, headers=self.headers)
        run = self.hub.store.ai_runs()[0]
        self.assertEqual(result.json()["detail"], "provider_http_error")
        self.assertEqual(run["stage"], "groq_analysis")
        self.assertNotIn("secret provider details", json.dumps(run))
        self.assertEqual(session.post.call_count, 1)

    def test_console_uses_real_snapshots_and_recomputes_policy(self):
        run = self.analyze()[0].json()
        self.observe("event-2")
        self.hub.store.snapshot("status:zabbix", {"state": "healthy", "metrics": 1})
        with patch.object(self.hub.platform_health, "snapshot", return_value=[]):
            result = self.client.get("/console/overview", headers=self.headers)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(len(result.json()["connectors"]), 5)
        self.assertEqual(result.json()["summary"]["active_incidents"], 1)
        self.assertIn("evidence_changed", result.json()["decisions"][0]["policy"]["blockers"])
        self.assertNotIn("openai-secret", result.text)


if __name__ == "__main__":
    unittest.main()
