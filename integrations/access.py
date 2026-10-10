"""Origin verification for the online console; machine routes stay private."""
import jwt
from jwt import PyJWKClient


# Only internal workers/probes use these paths. The online gateway never proxies them.
PRIVATE_PATHS = frozenset({"/health", "/metrics", "/ingest/metrics", "/detections", "/alerts/alertmanager"})


class AccessVerifier:
    def __init__(self, config):
        self.issuer = config.access_team_domain
        self.audience = config.access_audience
        self.keys = PyJWKClient(self.issuer + "/cdn-cgi/access/certs", timeout=5, lifespan=300)

    def verify(self, token):
        if not token or len(token) > 16384:
            raise jwt.InvalidTokenError("Missing or oversized Access assertion")
        # Never fetch a URL from unverified token claims; the issuer is operator-configured.
        key = self.keys.get_signing_key_from_jwt(token).key
        return jwt.decode(token, key, algorithms=["RS256"], issuer=self.issuer,
                          audience=self.audience, options={"require": ["exp", "iat", "iss", "aud", "sub"]})
