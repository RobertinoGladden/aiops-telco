#!/usr/bin/env python3
"""
================================================================
TELCO AIOPS — Tahap 4: Auto Predictor (Closed-Loop)
Fungsi: Baca data real-time dari Kafka → kirim ke Model API
        → deteksi anomali otomatis → trigger remediation

Ini adalah "otak" AIOps yang berjalan terus-menerus tanpa
perlu intervensi manual. Prediksi terjadi setiap detik.

Jalankan: python predictor/auto_predictor.py
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

# ─── KONFIGURASI ────────────────────────────────────────────
KAFKA_BOOTSTRAP_SERVERS = ["127.0.0.1:29092"]
KAFKA_TOPIC             = "telco.network.metrics"
KAFKA_GROUP_ID          = "telco-auto-predictor"

MODEL_API_URL           = "http://127.0.0.1:8081"   # Sesuaikan port
PREDICT_ENDPOINT        = f"{MODEL_API_URL}/predict"
BATCH_PREDICT_ENDPOINT  = f"{MODEL_API_URL}/predict/batch"

# Kirim prediksi setiap N perangkat atau M detik
BATCH_SIZE              = 10
BATCH_TIMEOUT_SEC       = 5

# Threshold untuk trigger remediation
ANOMALY_THRESHOLD       = 0.7    # Skor > 0.7 = anomali serius
CRITICAL_THRESHOLD      = 0.85   # Skor > 0.85 = critical, trigger auto-heal

# Rolling window untuk tracking per device (50 data terakhir)
device_history = defaultdict(lambda: deque(maxlen=50))
anomaly_counts = defaultdict(int)


# ─── ROLLING FEATURES ───────────────────────────────────────
def enrich_with_rolling(record: dict) -> dict:
    """
    Hitung rolling features dari history device.
    Ini penting agar prediksi model akurat karena model
    dilatih dengan rolling features.
    """
    device_id = record["device_id"]
    history   = device_history[device_id]
    history.append(record)

    # Ambil nilai historis
    latencies    = [h["latency_ms"]      for h in history]
    packet_loss  = [h["packet_loss_pct"] for h in history]
    cpu_usages   = [h["cpu_usage_pct"]   for h in history]

    n = len(history)
    window = min(5, n)

    # Rolling average 5 data terakhir
    record["latency_ms_rolling5"]      = sum(latencies[-window:])  / window
    record["packet_loss_pct_rolling5"] = sum(packet_loss[-window:]) / window
    record["cpu_usage_pct_rolling5"]   = sum(cpu_usages[-window:])  / window

    # Z-score sederhana
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

    # Jam dan hari
    now = datetime.now(timezone.utc)
    record["hour"]      = now.hour
    record["dayofweek"] = now.weekday()

    # Flag kritis
    record["is_critical"] = int(
        record["latency_ms"] > 100 or
        record["packet_loss_pct"] > 5 or
        record["cpu_usage_pct"] > 90
    )

    return record


# ─── AUTO REMEDIATION ────────────────────────────────────────
def trigger_remediation(prediction: dict, device: dict):
    """
    CLOSED-LOOP AUTOMATION — Inti dari AIOps!
    Ketika AI mendeteksi anomali kritis, sistem otomatis
    mengambil tindakan tanpa campur tangan manusia.
    """
    device_id  = prediction["device_id"]
    region     = prediction["region"]
    score      = prediction["anomaly_score"]
    severity   = prediction["severity"]

    if severity == "critical":
        log.warning(
            f"🚨 CRITICAL ANOMALY [{region}] {device_id} "
            f"score={score:.3f} → TRIGGERING AUTO-REMEDIATION"
        )
        # Di sistem nyata: panggil Terraform, restart service, dll.
        # Contoh simulasi:
        remediation_actions = []

        if device["latency_ms"] > 200:
            remediation_actions.append("REROUTE_TRAFFIC")
        if device["packet_loss_pct"] > 10:
            remediation_actions.append("SWITCH_BACKUP_LINK")
        if device["cpu_usage_pct"] > 95:
            remediation_actions.append("SCALE_RESOURCES")

        for action in remediation_actions:
            log.warning(f"   ⚡ Executing: {action} on {device_id}")
            # TODO Tahap 4 lanjutan: panggil Terraform/Ansible API di sini

        anomaly_counts[device_id] += 1

    elif severity == "warning":
        log.info(
            f"⚠️  WARNING [{region}] {device_id} "
            f"score={score:.3f} — monitoring ketat"
        )


# ─── PREDICT BATCH ──────────────────────────────────────────
def predict_batch(batch: list) -> list:
    """Kirim batch perangkat ke Model API dan dapatkan prediksi."""
    try:
        payload  = {"devices": batch}
        response = requests.post(
            BATCH_PREDICT_ENDPOINT,
            json=payload,
            timeout=10,
        )
        response.raise_for_status()
        result = response.json()
        return result["results"]
    except requests.exceptions.ConnectionError:
        log.error(
            f"❌ Tidak bisa konek ke Model API ({MODEL_API_URL})\n"
            f"   Pastikan 'python api/model_server.py' sudah jalan!"
        )
        return []
    except Exception as e:
        log.error(f"❌ Predict error: {e}")
        return []


# ─── DISPLAY SUMMARY ─────────────────────────────────────────
def display_summary(predictions: list, elapsed: float):
    """Tampilkan ringkasan hasil prediksi batch."""
    if not predictions:
        return

    anomalies = [p for p in predictions if p["is_anomaly"]]
    criticals = [p for p in predictions if p["severity"] == "critical"]
    avg_score = sum(p["anomaly_score"] for p in predictions) / len(predictions)
    avg_ms    = sum(p["inference_ms"]  for p in predictions) / len(predictions)

    log.info(
        f"📡 Prediksi: {len(predictions)} device | "
        f"Anomali: {len(anomalies)} | "
        f"Critical: {len(criticals)} | "
        f"Avg score: {avg_score:.3f} | "
        f"Inference: {avg_ms:.1f}ms"
    )

    # Tampilkan device yang kritis
    for p in criticals[:3]:
        log.warning(
            f"   🔴 {p['device_id']} [{p['region']}] "
            f"score={p['anomaly_score']:.3f}"
        )


# ─── MAIN LOOP ──────────────────────────────────────────────
def run_auto_predictor():
    log.info("🤖 Auto Predictor dimulai — sistem prediksi otomatis")
    log.info(f"   Kafka   : {KAFKA_BOOTSTRAP_SERVERS}")
    log.info(f"   API     : {MODEL_API_URL}")
    log.info(f"   Batch   : {BATCH_SIZE} device / {BATCH_TIMEOUT_SEC}s")
    log.info(f"   Threshold: warning={ANOMALY_THRESHOLD} critical={CRITICAL_THRESHOLD}")

    # Test koneksi ke Model API dulu
    try:
        r = requests.get(f"{MODEL_API_URL}/health", timeout=5)
        health = r.json()
        if not health.get("loaded"):
            log.error("❌ Model belum loaded! Jalankan train.py dulu.")
            return
        log.info(f"✅ Model API healthy: {health['model']}")
    except Exception as e:
        log.error(f"❌ Model API tidak bisa diakses: {e}")
        log.error(f"   Pastikan 'python api/model_server.py' sudah jalan di port yang benar")
        return

    # Setup Kafka Consumer
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
    log.info("✅ Terhubung ke Kafka — mulai prediksi otomatis...\n")

    batch      = []
    last_flush = time.time()
    total_preds = 0

    try:
        for message in consumer:
            record = message.value

            # Enrich dengan rolling features
            enriched = enrich_with_rolling(record)
            batch.append(enriched)

            should_predict = (
                len(batch) >= BATCH_SIZE or
                (time.time() - last_flush) >= BATCH_TIMEOUT_SEC
            )

            if should_predict and batch:
                start = time.time()
                predictions = predict_batch(batch)
                elapsed = time.time() - start

                if predictions:
                    display_summary(predictions, elapsed)

                    # Cek setiap prediksi untuk remediation
                    device_map = {d["device_id"]: d for d in batch}
                    for pred in predictions:
                        if pred["anomaly_score"] >= ANOMALY_THRESHOLD:
                            device_data = device_map.get(pred["device_id"], {})
                            trigger_remediation(pred, device_data)

                    total_preds += len(predictions)

                batch      = []
                last_flush = time.time()

    except KeyboardInterrupt:
        log.info(f"\n🛑 Auto Predictor dihentikan")
        log.info(f"📊 Total prediksi: {total_preds}")
    finally:
        consumer.close()


if __name__ == "__main__":
    run_auto_predictor()
