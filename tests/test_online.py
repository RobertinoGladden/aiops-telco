"""The online origin must reject access failures while internal delivery stays usable."""
import json
import tempfile
import time
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from aiops.config import settings
from integrations.access import AccessVerifier
from integrations.hub import create_app


class OnlineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        cls.other_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = replace(settings, deployment_mode="online", hub_token="x" * 48,
            state_db=str(Path(self.temp.name) / "state.db"),
            access_team_domain="https://strata-test.cloudflareaccess.com", access_audience="test-audience")
        self.app = create_app(self.config, background=False)
        self.client = TestClient(self.app)
        verifier = self.app.state.access_verifier
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key()))
        jwk.update(kid="test-key", alg="RS256", use="sig")
        self.keys = patch.object(verifier.keys, "fetch_data", return_value={"keys": [jwk]})
        self.keys.start()

    def tearDown(self):
        self.keys.stop()
        self.client.close()
        self.temp.cleanup()

    def assertion(self, **claims):
        payload = {"iss": self.config.access_team_domain, "aud": ["test-audience"],
            "iat": int(time.time()) - 1, "exp": int(time.time()) + 60, "sub": "operator-01"}
        payload.update(claims)
        return jwt.encode(payload, self.key, algorithm="RS256", headers={"kid": "test-key"})

    def headers(self, **claims):
        return {"Authorization": "Bearer " + self.config.hub_token,
                "Cf-Access-Jwt-Assertion": self.assertion(**claims)}

    def test_bearer_alone_cannot_reach_console_or_operational_data(self):
        for path in ("/", "/assets/app.js", "/incidents", "/console/overview"):
            reply = self.client.get(path, headers={"Authorization": "Bearer " + self.config.hub_token})
            self.assertEqual(reply.status_code, 401)
            self.assertEqual(reply.headers["Cache-Control"], "no-store")

    def test_verified_jwt_and_hub_token_are_both_required(self):
        self.assertEqual(self.client.get("/incidents", headers=self.headers()).status_code, 200)
        headers = self.headers()
        headers.pop("Authorization")
        self.assertEqual(self.client.get("/incidents", headers=headers).status_code, 401)
        self.assertEqual(self.client.get("/", headers=headers).status_code, 200)

    def test_expired_wrong_issuer_wrong_audience_and_missing_subject_fail(self):
        for claims in ({"exp": int(time.time()) - 1}, {"iss": "https://evil.cloudflareaccess.com"},
                       {"aud": "different-application"}):
            self.assertEqual(self.client.get("/incidents", headers=self.headers(**claims)).status_code, 401)
        payload = jwt.decode(self.assertion(), options={"verify_signature": False})
        del payload["sub"]
        token = jwt.encode(payload, self.key, algorithm="RS256", headers={"kid": "test-key"})
        self.assertEqual(self.client.get("/", headers={"Cf-Access-Jwt-Assertion": token}).status_code, 401)

    def test_wrong_signature_and_algorithm_fail(self):
        payload = jwt.decode(self.assertion(), options={"verify_signature": False})
        for token in (jwt.encode(payload, self.other_key, algorithm="RS256", headers={"kid": "test-key"}),
                      jwt.encode(payload, "a" * 48, algorithm="HS256", headers={"kid": "test-key"}), "invalid"):
            self.assertEqual(self.client.get("/", headers={"Cf-Access-Jwt-Assertion": token}).status_code, 401)

    def test_provider_failure_is_closed_and_does_not_leak_details(self):
        with patch.object(self.app.state.access_verifier.keys, "fetch_data", side_effect=RuntimeError("secret URL")):
            result = self.client.get("/incidents", headers=self.headers())
        self.assertEqual(result.status_code, 401)
        self.assertNotIn("secret", result.text)

    def test_private_probe_and_ingest_still_work_without_access_jwt(self):
        self.assertEqual(self.client.get("/health").status_code, 200)
        self.assertEqual(self.client.get("/metrics").status_code, 200)
        self.assertEqual(self.client.post("/ingest/metrics", json={"events": []}).status_code, 401)
        payload = {"events": [{"device_id": "field-01", "source": "drive-test-probe",
            "timestamp": "2026-10-11T00:00:00Z", "latency_ms": 15}]}
        reply = self.client.post("/ingest/metrics", json=payload,
            headers={"Authorization": "Bearer " + self.config.hub_token})
        self.assertEqual(reply.status_code, 202)
        self.assertEqual(reply.json()["accepted"], 1)

    def test_online_docs_are_disabled_and_response_is_hardened(self):
        headers = self.headers()
        for path in ("/docs", "/redoc", "/openapi.json"):
            self.assertEqual(self.client.get(path, headers=headers).status_code, 404)
        reply = self.client.get("/", headers=headers)
        self.assertEqual(reply.headers["X-Frame-Options"], "DENY")
        self.assertEqual(reply.headers["Strict-Transport-Security"], "max-age=31536000")
        self.assertIn("frame-ancestors 'none'", reply.headers["Content-Security-Policy"])

    def test_online_configuration_rejects_weak_tokens_or_untrusted_issuer(self):
        for changes in ({"hub_token": "local-lab-change-me"}, {"access_audience": ""},
                        {"access_team_domain": "https://attacker.example"},
                        {"access_team_domain": "http://strata-test.cloudflareaccess.com"},
                        {"access_team_domain": "https://strata-test.cloudflareaccess.com/"}):
            with self.assertRaises(ValueError):
                replace(self.config, **changes)

    def test_access_verifier_bounds_token_size_before_network(self):
        verifier = AccessVerifier(self.config)
        with patch.object(verifier.keys, "get_signing_key_from_jwt") as fetch_key:
            with self.assertRaises(jwt.InvalidTokenError):
                verifier.verify("x" * 16385)
        fetch_key.assert_not_called()


if __name__ == "__main__":
    unittest.main()
