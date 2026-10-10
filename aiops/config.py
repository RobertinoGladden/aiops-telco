"""One configuration surface for host scripts and containers."""
import os
from pathlib import Path
from dataclasses import dataclass
from urllib.parse import urlsplit

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env", override=False)


@dataclass(frozen=True)
class Settings:
    kafka_servers: str = os.getenv("KAFKA_BOOTSTRAP_SERVERS", "127.0.0.1:29092")
    metrics_topic: str = os.getenv("KAFKA_TOPIC", "telco.network.metrics")
    dlq_topic: str = os.getenv("KAFKA_DLQ_TOPIC", "telco.network.dead-letter")
    predictions_topic: str = os.getenv("KAFKA_PREDICTIONS_TOPIC", "telco.network.predictions")
    minio_endpoint: str = os.getenv("MINIO_ENDPOINT", "http://127.0.0.1:9000")
    minio_access_key: str = os.getenv("MINIO_ACCESS_KEY", "telcoadmin")
    minio_secret_key: str = os.getenv("MINIO_SECRET_KEY", "telcopassword123")
    raw_bucket: str = os.getenv("MINIO_BUCKET_RAW", "telco-raw-data")
    processed_bucket: str = os.getenv("MINIO_BUCKET_PROC", "telco-processed-data")
    models_bucket: str = os.getenv("MINIO_BUCKET_MODELS", "telco-models")
    mlflow_uri: str = os.getenv("MLFLOW_TRACKING_URI", "http://127.0.0.1:5000")
    model_name: str = os.getenv("MODEL_NAME", "random_forest")
    model_api_url: str = os.getenv("MODEL_API_URL", "http://127.0.0.1:8081")
    hub_url: str = os.getenv("INTEGRATION_HUB_URL", "http://127.0.0.1:8082")
    hub_token: str = os.getenv("INTEGRATION_API_TOKEN", "local-lab-change-me")
    connectors_file: str = os.getenv("CONNECTORS_FILE", str(ROOT / "config/connectors.yml"))
    state_db: str = os.getenv("AIOPS_STATE_DB", str(ROOT / "data/integrations.sqlite"))
    poll_interval: float = float(os.getenv("CONNECTOR_POLL_SECONDS", "30"))
    confirmations: int = int(os.getenv("INCIDENT_CONFIRMATIONS", "3"))
    recovery_confirmations: int = int(os.getenv("RECOVERY_CONFIRMATIONS", "3"))
    workflow_url: str = os.getenv("WORKFLOW_WEBHOOK_URL", "")
    workflow_token: str = os.getenv("WORKFLOW_WEBHOOK_TOKEN", "")
    workflow_enabled: bool = os.getenv("WORKFLOW_ENABLED", "false").lower() == "true"
    ai_enabled: bool = os.getenv("AI_ENABLED", "false").lower() == "true"
    groq_api_key: str = os.getenv("GROQ_API_KEY", "")
    groq_model: str = os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    decision_model: str = os.getenv("DECISION_MODEL", "gpt-6-luna")
    ai_timeout: float = float(os.getenv("AI_TIMEOUT_SECONDS", "20"))
    ai_max_daily: int = int(os.getenv("AI_MAX_RUNS_PER_DAY", "50"))
    ai_cooldown: int = int(os.getenv("AI_COOLDOWN_SECONDS", "30"))
    ai_max_evidence_age: int = int(os.getenv("AI_MAX_EVIDENCE_AGE_SECONDS", "300"))
    ai_min_confidence: float = float(os.getenv("AI_MIN_CONFIDENCE", "0.85"))
    prometheus_url: str = os.getenv("PROMETHEUS_URL", "http://127.0.0.1:9090")
    grafana_url: str = os.getenv("GRAFANA_URL", "http://127.0.0.1:3000")
    airflow_url: str = os.getenv("AIRFLOW_URL", "")
    alertmanager_url: str = os.getenv("ALERTMANAGER_URL", "http://127.0.0.1:9093")
    storage_metrics_url: str = os.getenv("STORAGE_METRICS_URL", "http://127.0.0.1:9101")
    predictor_metrics_url: str = os.getenv("PREDICTOR_METRICS_URL", "http://127.0.0.1:9102")
    deployment_mode: str = os.getenv("STRATA_DEPLOYMENT_MODE", "local")
    access_team_domain: str = os.getenv("CF_ACCESS_TEAM_DOMAIN", "")
    access_audience: str = os.getenv("CF_ACCESS_AUDIENCE", "")

    def __post_init__(self):
        if self.deployment_mode not in {"local", "online"}:
            raise ValueError("STRATA_DEPLOYMENT_MODE must be local or online")
        if self.deployment_mode == "online":
            if len(self.hub_token) < 32 or not all(c.isalnum() or c in "-_" for c in self.hub_token):
                raise ValueError("Online mode requires a generated, URL-safe INTEGRATION_API_TOKEN of at least 32 characters")
            team = urlsplit(self.access_team_domain)
            if (team.scheme != "https" or not team.hostname or
                    not team.hostname.endswith(".cloudflareaccess.com") or
                    team.username or team.password or team.port or team.path or team.query or team.fragment):
                raise ValueError("CF_ACCESS_TEAM_DOMAIN must be https://YOUR-TEAM.cloudflareaccess.com without a trailing slash")
            if not self.access_audience or self.access_audience.startswith("REPLACE_"):
                raise ValueError("Online mode requires the Cloudflare Access application's audience tag")
        if self.poll_interval < 1 or self.confirmations < 1 or self.recovery_confirmations < 1:
            raise ValueError("poll interval and incident confirmations must be positive")
        if self.workflow_enabled and not self.workflow_url:
            raise ValueError("WORKFLOW_ENABLED requires WORKFLOW_WEBHOOK_URL")
        if not 0 < self.ai_min_confidence <= 1:
            raise ValueError("AI_MIN_CONFIDENCE must be between 0 and 1")
        if min(self.ai_timeout, self.ai_max_daily, self.ai_cooldown, self.ai_max_evidence_age) < 1:
            raise ValueError("AI limits and timeouts must be positive")


settings = Settings()
