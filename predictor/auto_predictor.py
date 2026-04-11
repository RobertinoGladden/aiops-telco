#!/usr/bin/env python3
"""
================================================================
TELCO AIOPS - Tahap 4: Auto Predictor (Closed-Loop)
Fungsi: Baca data real-time dari Kafka -> kirim ke Model API
        -> deteksi anomali otomatis -> trigger remediation
================================================================
"""

# --- FIX IPv4 Windows ---
import socket
_orig = socket.getaddrinfo
def _ipv4(host, port, *a, **kw):
    r = _orig(host, port, *a, **kw)
    v4 = [x for x in r if x[0] == socket.AF_INET]
    return v4 if v4 else r
socket.getaddrinfo = _ipv4

import json
import time
import logging
import requests
from datetime import datetime, timezone
from collections import deque, defaultdict
from kafka import KafkaConsumer

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)

# --- KONFIGURASI ---
KAFKA_BOOTSTRAP_SERVERS = ["127.0.0.1:29092"]
KAFKA_TOPIC             = "telco.network.metrics"
KAFKA_GROUP_ID          = "telco-auto-predictor"

MODEL_API_URL           = "http://127.0.0.1:8081"
PREDICT_ENDPOINT        = f"{MODEL_API_URL}/predict"
BATCH_PREDICT_ENDPOINT  = f"{MODEL_API_URL}/predict/batch"

BATCH_SIZE              = 10
BATCH_TIMEOUT_SEC       = 5

ANOMALY_THRESHOLD       = 0.7
CRITICAL_THRESHOLD      = 0.85

device_history = defaultdict(lambda: deque(maxlen=50))
anomaly_counts = defaultdict(int)


def enrich_with_rolling(record: dict) -> dict:
    device_id = record["device_id"]
    history   = device_history[device_id]
    history.append(record)

    latencies   = [h["latency_ms"]      for h in history]
    packet_loss = [h["packet_loss_pct"] for h in history]
    cpu_usages  = [h["cpu_usage_pct"]   for h in history]

    n = len(history)
    window = min(5, n)

    record["latency_ms_rolling5"]      = sum(latencies[-window:])  / window
    record["packet_loss_pct_rolling5"] = sum(packet_loss[-window:]) / window
    record["cpu_usage_pct_rolling5"]   = sum(cpu_usages[-window:])  / window

    if n > 1:
        mean_lat = sum(latencies) / n
        std_lat  = (sum((x - mean_lat)**2 for x in latencies) / n) ** 0.5
        record["latency_ms_zscore"] = (record["latency_ms"] - mean_lat) / (std_lat or 1)

        mean_cpu = sum(cpu_usages) / n
        std_cpu  = (sum((x - mean_cpu)**2 for x in cpu_usages) / n) ** 0.5
        record["cpu_usage_pct_zscore"] = (record["cpu_usage_pct"] - mean_cpu) / (std_cpu or 1)
    else:
        record["latency_ms_zscore"]    = 0.0
        record["cpu_usage_pct_zscore"] = 0.0

    now = datetime.now(timezone.utc)
    record["hour"]      = now.hour
    record["dayofweek"] = now.weekday()

    record["is_critical"] = int(
        record["latency_ms"] > 100 or
        record["packet_loss_pct"] > 5 or
        record["cpu_usage_pct"] > 90
    )
    return record


def trigger_remediation(prediction: dict, device: dict):
    device_id = prediction["device_id"]
    region    = prediction["region"]
    score     = prediction["anomaly_score"]
    severity  = prediction["severity"]

    if severity == "critical":
        log.warning(f"CRITICAL [{region}] {device_id} score={score:.3f} -> AUTO-REMEDIATION")
        if device.get("latency_ms", 0) > 200:
            log.warning(f"   -> REROUTE_TRAFFIC on {device_id}")
        if device.get("packet_loss_pct", 0) > 10:
            log.warning(f"   -> SWITCH_BACKUP_LINK on {device_id}")
        if device.get("cpu_usage_pct", 0) > 95:
            log.warning(f"   -> SCALE_RESOURCES on {device_id}")
        anomaly_counts[device_id] += 1
    elif severity == "warning":
        log.info(f"WARNING [{region}] {device_id} score={score:.3f}")


def predict_batch(batch: list) -> list:
    try:
        response = requests.post(BATCH_PREDICT_ENDPOINT, json={"devices": batch}, timeout=10)
        response.raise_for_status()
        return response.json()["results"]
    except requests.exceptions.ConnectionError:
        log.error(f"Tidak bisa konek ke Model API ({MODEL_API_URL})")
        return []
    except Exception as e:
        log.error(f"Predict error: {e}")
        return []


def display_summary(predictions: list, elapsed: float):
    if not predictions:
        return
    anomalies = [p for p in predictions if p["is_anomaly"]]
    criticals = [p for p in predictions if p["severity"] == "critical"]
    avg_score = sum(p["anomaly_score"] for p in predictions) / len(predictions)
    avg_ms    = sum(p["inference_ms"]  for p in predictions) / len(predictions)
    log.info(
        f"Prediksi: {len(predictions)} device | Anomali: {len(anomalies)} | "
        f"Critical: {len(criticals)} | Avg score: {avg_score:.3f} | Inference: {avg_ms:.1f}ms"
    )
    for p in criticals[:3]:
        log.warning(f"   CRITICAL {p['device_id']} [{p['region']}] score={p['anomaly_score']:.3f}")


def run_auto_predictor():
    log.info("Auto Predictor dimulai")
    log.info(f"   Kafka : {KAFKA_BOOTSTRAP_SERVERS}")
    log.info(f"   API   : {MODEL_API_URL}")

    # =================================================================
    # PERUBAHAN: retry loop - tidak langsung exit jika API belum siap
    # =================================================================
    log.info("Menunggu Model API siap (max 60 detik)...")
    api_ok = False
    for attempt in range(30):  # 30 x 2 detik = 60 detik
        try:
            r = requests.get(f"{MODEL_API_URL}/health", timeout=5)
            r.raise_for_status()
            health = r.json()
            if health.get("loaded"):
                log.info(f"Model API ready: model={health['model']}")
                api_ok = True
                break
            else:
                log.warning(f"Model belum loaded, coba lagi ({attempt+1}/30)...")
        except Exception as e:
            log.warning(f"API belum siap ({attempt+1}/30): {e}")
        time.sleep(2)

    if not api_ok:
        log.error("Model API tidak bisa diakses setelah 60 detik. Keluar.")
        return
    # =================================================================

    log.info("Menghubungkan ke Kafka...")
    consumer = KafkaConsumer(
        KAFKA_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
        group_id=KAFKA_GROUP_ID,
        auto_offset_reset="latest",
        enable_auto_commit=True,
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
        session_timeout_ms=30000,
        heartbeat_interval_ms=10000,
    )
    log.info("Terhubung ke Kafka - mulai prediksi otomatis...")

    batch       = []
    last_flush  = time.time()
    total_preds = 0

    try:
        for message in consumer:
            record   = message.value
            enriched = enrich_with_rolling(record)
            batch.append(enriched)

            if len(batch) >= BATCH_SIZE or (time.time() - last_flush) >= BATCH_TIMEOUT_SEC:
                if batch:
                    predictions = predict_batch(batch)
                    if predictions:
                        display_summary(predictions, 0)
                        device_map = {d["device_id"]: d for d in batch}
                        for pred in predictions:
                            if pred["anomaly_score"] >= ANOMALY_THRESHOLD:
                                trigger_remediation(pred, device_map.get(pred["device_id"], {}))
                        total_preds += len(predictions)
                    batch      = []
                    last_flush = time.time()

    except KeyboardInterrupt:
        log.info(f"Dihentikan. Total prediksi: {total_preds}")
    finally:
        consumer.close()


if __name__ == "__main__":
    run_auto_predictor()