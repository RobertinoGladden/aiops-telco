#!/usr/bin/env python3
"""
================================================================
TELCO AIOPS — Tahap 3: Model API Server
Fungsi: Expose model ML sebagai REST API yang bisa dipanggil
        oleh sistem AIOps (Tahap 4) untuk prediksi real-time

Endpoint:
  GET  /health          → cek status server
  GET  /metrics         → Prometheus metrics
  POST /predict         → prediksi satu perangkat
  POST /predict/batch   → prediksi banyak perangkat sekaligus
  GET  /model/info      → info model yang aktif

Jalankan: python api/model_server.py
================================================================
"""

# ─── FIX IPv4 Windows ───────────────────────────────────────
import socket
_orig = socket.getaddrinfo
def _ipv4(host, port, *a, **kw):
    r = _orig(host, port, *a, **kw)
    v4 = [x for x in r if x[0] == socket.AF_INET]
    return v4 if v4 else r
socket.getaddrinfo = _ipv4
# ────────────────────────────────────────────────────────────

import io
import time
import logging
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd
import boto3
import joblib
from botocore.client import Config
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
import uvicorn
from prometheus_client import (
    Counter, Histogram, Gauge,
    generate_latest, CONTENT_TYPE_LATEST
)
from fastapi.responses import Response

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# ─── KONFIGURASI ────────────────────────────────────────────
MINIO_ENDPOINT   = "http://127.0.0.1:9000"
MINIO_ACCESS_KEY = "telcoadmin"
MINIO_SECRET_KEY = "telcopassword123"
BUCKET_MODELS    = "telco-models"
MODEL_NAME       = "random_forest"   # Model utama yang dipakai
API_PORT         = 8081

# ─── PROMETHEUS METRICS ─────────────────────────────────────
# Ini yang akan di-scrape Prometheus di Tahap 4!
predict_counter = Counter(
    "telco_predictions_total",
    "Total prediksi yang dilakukan",
    ["model", "result"]
)
predict_latency = Histogram(
    "telco_prediction_latency_seconds",
    "Waktu inferensi model",
    buckets=[0.001, 0.005, 0.01, 0.05, 0.1, 0.5]
)
anomaly_gauge = Gauge(
    "telco_anomaly_score_current",
    "Skor anomali terbaru per device",
    ["device_id", "region"]
)
model_loaded_gauge = Gauge(
    "telco_model_loaded",
    "Status model (1=loaded, 0=not loaded)"
)

# ─── PYDANTIC MODELS ────────────────────────────────────────
class DeviceMetrics(BaseModel):
    """Input: metrics dari satu perangkat jaringan."""
    device_id:             str
    device_type:           str   = "BTS"
    region:                str   = "Jakarta"
    latency_ms:            float = Field(..., ge=0)
    packet_loss_pct:       float = Field(..., ge=0, le=100)
    cpu_usage_pct:         float = Field(..., ge=0, le=100)
    throughput_mbps:       float = Field(..., ge=0)
    signal_strength_dbm:   float = -75.0
    error_rate:            float = Field(0.001, ge=0)
    # Rolling features (opsional, diisi 0 jika tidak ada)
    latency_ms_rolling5:        float = 0.0
    packet_loss_pct_rolling5:   float = 0.0
    cpu_usage_pct_rolling5:     float = 0.0
    latency_ms_zscore:          float = 0.0
    cpu_usage_pct_zscore:       float = 0.0
    hour:                  int   = 12
    dayofweek:             int   = 0
    is_critical:           int   = 0

class PredictionResult(BaseModel):
    """Output: hasil prediksi untuk satu perangkat."""
    device_id:        str
    region:           str
    is_anomaly:       bool
    anomaly_score:    float   # 0.0 = normal, 1.0 = pasti anomali
    confidence:       float
    severity:         str     # normal / warning / critical
    timestamp:        str
    model_used:       str
    inference_ms:     float

class BatchRequest(BaseModel):
    devices: list[DeviceMetrics]

class BatchResult(BaseModel):
    total:          int
    anomaly_count:  int
    results:        list[PredictionResult]
    processing_ms:  float


# ─── APP SETUP ──────────────────────────────────────────────
app = FastAPI(
    title="Telco AIOps — Model API",
    description="REST API untuk prediksi anomali jaringan Telco secara real-time",
    version="1.0.0",
)

# State global: model yang di-load saat startup
_model_bundle = None


# ─── LOAD MODEL DARI MINIO ──────────────────────────────────
def load_model():
    global _model_bundle
    log.info(f"📥 Loading model '{MODEL_NAME}' dari MinIO...")
    try:
        client = boto3.client(
            "s3",
            endpoint_url=MINIO_ENDPOINT,
            aws_access_key_id=MINIO_ACCESS_KEY,
            aws_secret_access_key=MINIO_SECRET_KEY,
            config=Config(signature_version="s3v4"),
            region_name="us-east-1",
        )
        obj = client.get_object(
            Bucket=BUCKET_MODELS,
            Key=f"latest/{MODEL_NAME}.pkl"
        )
        _model_bundle = joblib.load(io.BytesIO(obj["Body"].read()))
        model_loaded_gauge.set(1)
        log.info(f"✅ Model loaded! Features: {_model_bundle['features']}")
    except Exception as e:
        model_loaded_gauge.set(0)
        log.error(f"❌ Gagal load model: {e}")
        log.error("   Pastikan train.py sudah dijalankan terlebih dahulu!")


# ─── INFERENSI ──────────────────────────────────────────────
def run_inference(device: DeviceMetrics) -> PredictionResult:
    if _model_bundle is None:
        raise HTTPException(
            status_code=503,
            detail="Model belum di-load. Jalankan train.py dulu!"
        )

    model    = _model_bundle["model"]
    scaler   = _model_bundle["scaler"]
    features = _model_bundle["features"]

    # Buat DataFrame dari input
    data = {f: getattr(device, f, 0) for f in features}
    X = pd.DataFrame([data])

    start = time.time()
    X_scaled = scaler.transform(X)

    # Prediksi
    if hasattr(model, "predict_proba"):
        # Random Forest → probabilitas
        proba = model.predict_proba(X_scaled)[0]
        anomaly_score = float(proba[1])
        is_anomaly    = anomaly_score > 0.5
        confidence    = float(max(proba))
    else:
        # Isolation Forest → decision function
        score      = model.decision_function(X_scaled)[0]
        # Normalisasi ke 0-1 (skor negatif = lebih anomali)
        anomaly_score = float(1 / (1 + np.exp(score * 2)))
        is_anomaly    = model.predict(X_scaled)[0] == -1
        confidence    = anomaly_score if is_anomaly else 1 - anomaly_score

    inference_ms = (time.time() - start) * 1000

    # Tentukan severity
    if not is_anomaly:
        severity = "normal"
    elif anomaly_score > 0.8:
        severity = "critical"
    else:
        severity = "warning"

    # Update Prometheus metrics
    predict_counter.labels(
        model=MODEL_NAME,
        result="anomaly" if is_anomaly else "normal"
    ).inc()
    predict_latency.observe(inference_ms / 1000)
    anomaly_gauge.labels(
        device_id=device.device_id,
        region=device.region
    ).set(anomaly_score)

    return PredictionResult(
        device_id=device.device_id,
        region=device.region,
        is_anomaly=is_anomaly,
        anomaly_score=round(anomaly_score, 4),
        confidence=round(confidence, 4),
        severity=severity,
        timestamp=datetime.now(timezone.utc).isoformat(),
        model_used=MODEL_NAME,
        inference_ms=round(inference_ms, 3),
    )


# ─── ENDPOINTS ──────────────────────────────────────────────
@app.on_event("startup")
async def startup():
    load_model()

@app.get("/health")
def health():
    return {
        "status": "ok" if _model_bundle else "degraded",
        "model":  MODEL_NAME,
        "loaded": _model_bundle is not None,
        "time":   datetime.now(timezone.utc).isoformat(),
    }

@app.get("/metrics")
def prometheus_metrics():
    """Endpoint untuk Prometheus scrape — ini kunci Tahap 4!"""
    return Response(
        content=generate_latest(),
        media_type=CONTENT_TYPE_LATEST
    )

@app.get("/model/info")
def model_info():
    if not _model_bundle:
        raise HTTPException(status_code=503, detail="Model belum loaded")
    return {
        "model_name": MODEL_NAME,
        "features":   _model_bundle["features"],
        "model_type": type(_model_bundle["model"]).__name__,
    }

@app.post("/predict", response_model=PredictionResult)
def predict(device: DeviceMetrics):
    """Prediksi anomali untuk SATU perangkat jaringan."""
    return run_inference(device)

@app.post("/predict/batch", response_model=BatchResult)
def predict_batch(request: BatchRequest):
    """Prediksi anomali untuk BANYAK perangkat sekaligus."""
    start = time.time()
    results = [run_inference(d) for d in request.devices]
    anomaly_count = sum(1 for r in results if r.is_anomaly)

    return BatchResult(
        total=len(results),
        anomaly_count=anomaly_count,
        results=results,
        processing_ms=round((time.time() - start) * 1000, 2),
    )


# ─── MAIN ───────────────────────────────────────────────────
if __name__ == "__main__":
    log.info("🚀 Telco Model API Server dimulai")
    log.info(f"   Port    : {API_PORT}")
    log.info(f"   Docs    : http://localhost:{API_PORT}/docs")
    log.info(f"   Metrics : http://localhost:{API_PORT}/metrics")
    uvicorn.run(app, host="0.0.0.0", port=API_PORT)
