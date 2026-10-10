"""Model inference with explicit missing-feature checks and retryable readiness."""
import asyncio
import io
import logging
import os
import threading
import time
from contextlib import asynccontextmanager, suppress
from datetime import datetime, timezone
import boto3
import joblib
import numpy as np
import pandas as pd
import uvicorn
from botocore.client import Config
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from prometheus_client import Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST
from aiops.config import settings
from aiops.contracts import NetworkMetric
from aiops.features import FeatureBuilder, FEATURE_COLS

log = logging.getLogger(__name__)
MODEL_NAME = settings.model_name
_model_bundle = None
_features = FeatureBuilder()
_feature_lock = threading.Lock()
predict_counter = Counter("telco_predictions_total", "Model predictions", ["model", "result"])
predict_latency = Histogram("telco_prediction_latency_seconds", "Model inference time")
anomaly_gauge = Gauge("telco_anomaly_score_current", "Latest model score", ["device_id", "region"])
model_loaded_gauge = Gauge("telco_model_loaded", "Model is ready")


class DeviceMetrics(BaseModel):
    model_config = ConfigDict(allow_inf_nan=False)
    device_id: str = Field(min_length=1)
    source: str = "direct-api"
    region: str = "unknown"
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    event_id: str = ""
    latency_ms: float | None = Field(default=None, ge=0)
    packet_loss_pct: float | None = Field(default=None, ge=0, le=100)
    cpu_usage_pct: float | None = Field(default=None, ge=0, le=100)
    throughput_mbps: float | None = Field(default=None, ge=0)
    signal_strength_dbm: float | None = None
    error_rate: float | None = Field(default=None, ge=0, le=1)
    latency_ms_rolling5: float | None = None
    packet_loss_pct_rolling5: float | None = None
    cpu_usage_pct_rolling5: float | None = None
    latency_ms_zscore: float | None = None
    cpu_usage_pct_zscore: float | None = None
    hour: int | None = Field(default=None, ge=0, le=23)
    dayofweek: int | None = Field(default=None, ge=0, le=6)
    is_critical: int | None = Field(default=None, ge=0, le=1)

    _aware = field_validator("timestamp")(NetworkMetric.aware_timestamp.__func__)


class BatchRequest(BaseModel):
    devices: list[DeviceMetrics] = Field(min_length=1, max_length=500)


def load_model():
    global _model_bundle
    try:
        client = boto3.client("s3", endpoint_url=settings.minio_endpoint,
            aws_access_key_id=settings.minio_access_key, aws_secret_access_key=settings.minio_secret_key,
            region_name="us-east-1", config=Config(signature_version="s3v4", connect_timeout=3, read_timeout=5, retries={"max_attempts": 1}))
        obj = client.get_object(Bucket=settings.models_bucket, Key=f"latest/{MODEL_NAME}.pkl")
        bundle = joblib.load(io.BytesIO(obj["Body"].read()))
        if not bundle.get("features") or "model" not in bundle or "scaler" not in bundle or any(field not in FEATURE_COLS for field in bundle["features"]):
            raise ValueError("model contains unsupported features")
        _model_bundle = bundle
        log.info("Model %s loaded", MODEL_NAME)
    except Exception as error:
        log.warning("Model load deferred: %s", type(error).__name__)
    model_loaded_gauge.set(int(_model_bundle is not None))


@asynccontextmanager
async def lifespan(app):
    async def retry_load():
        while True:
            if _model_bundle is None:
                await asyncio.to_thread(load_model)
            await asyncio.sleep(10)
    task = asyncio.create_task(retry_load())
    yield
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


app = FastAPI(title="Telco AIOps Model API", version="2.0.0", lifespan=lifespan)


def run_inference(device):
    bundle = _model_bundle
    if bundle is None:
        raise HTTPException(503, "Model unavailable; train a model first")
    record = device.model_dump(mode="json")
    with _feature_lock:
        enriched = _features.enrich(record)
    for key in FEATURE_COLS:
        if record.get(key) is not None:
            enriched[key] = record[key]
    missing = [key for key in bundle["features"] if enriched.get(key) is None]
    if missing:
        raise HTTPException(422, {"missing_model_features": missing, "fallback": "measured_rules"})
    model, scaler = bundle["model"], bundle["scaler"]
    start = time.perf_counter()
    X = scaler.transform(pd.DataFrame([{key: enriched[key] for key in bundle["features"]}]))
    if hasattr(model, "predict_proba"):
        probabilities = model.predict_proba(X)[0]
        anomaly_class = list(model.classes_).index(1)
        score = float(probabilities[anomaly_class])
        is_anomaly = score > 0.5
        confidence = float(max(probabilities))
    else:
        decision = float(model.decision_function(X)[0])
        score = float(1 / (1 + np.exp(np.clip(decision * 2, -700, 700))))
        is_anomaly = bool(model.predict(X)[0] == -1)
        confidence = score if is_anomaly else 1 - score
    severity = "normal" if not is_anomaly else ("critical" if score > 0.8 else "warning")
    elapsed = time.perf_counter() - start
    predict_counter.labels(MODEL_NAME, "anomaly" if is_anomaly else "normal").inc()
    predict_latency.observe(elapsed)
    anomaly_gauge.labels(device.device_id, device.region).set(score)
    return {"device_id": device.device_id, "region": device.region, "is_anomaly": bool(is_anomaly),
            "anomaly_score": round(score, 4), "confidence": round(confidence, 4), "severity": severity,
            "timestamp": datetime.now(timezone.utc).isoformat(), "model_used": MODEL_NAME,
            "inference_ms": round(elapsed * 1000, 3)}


@app.get("/health")
def health():
    return {"status": "ok" if _model_bundle else "degraded", "model": MODEL_NAME, "loaded": _model_bundle is not None}


@app.get("/ready")
def ready():
    if _model_bundle is None:
        raise HTTPException(503, "Model unavailable")
    return {"status": "ready"}


@app.get("/metrics")
def metrics():
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/model/info")
def model_info():
    if _model_bundle is None:
        raise HTTPException(503, "Model unavailable")
    return {"model_name": MODEL_NAME, "features": _model_bundle["features"], "metadata": _model_bundle.get("metadata", {})}


@app.post("/predict")
def predict(device: DeviceMetrics):
    return run_inference(device)


@app.post("/predict/batch")
def predict_batch(request: BatchRequest):
    start = time.perf_counter()
    results = [run_inference(device) for device in request.devices]
    return {"total": len(results), "anomaly_count": sum(row["is_anomaly"] for row in results), "results": results,
            "processing_ms": round((time.perf_counter() - start) * 1000, 2)}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("MODEL_API_PORT", "8081")))
