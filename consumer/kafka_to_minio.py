#!/usr/bin/env python3
"""
================================================================
TELCO AIOPS — Tahap 2: Kafka Consumer → MinIO
Fungsi: Membaca data streaming dari Kafka secara real-time,
        membersihkan data, lalu menyimpan ke Data Lake (MinIO)
        dalam format Parquet (efisien untuk ML training)

Jalankan: python consumer/kafka_to_minio.py
================================================================
"""

# ─── FIX IPv4 (Windows: localhost → IPv6 bug) ───────────────
# HARUS di paling atas sebelum import lainnya!
import socket
_orig_getaddrinfo = socket.getaddrinfo
def _ipv4_only(host, port, *args, **kwargs):
    results = _orig_getaddrinfo(host, port, *args, **kwargs)
    ipv4 = [r for r in results if r[0] == socket.AF_INET]
    return ipv4 if ipv4 else results
socket.getaddrinfo = _ipv4_only
# ────────────────────────────────────────────────────────────

import json
import time
import logging
import io
from datetime import datetime, timezone
from collections import defaultdict

import pandas as pd
import boto3
from botocore.client import Config
from kafka import KafkaConsumer

# ─── KONFIGURASI ────────────────────────────────────────────
KAFKA_BOOTSTRAP_SERVERS = ["127.0.0.1:29092"]
KAFKA_TOPIC             = "telco.network.metrics"
KAFKA_GROUP_ID          = "telco-data-pipeline"

MINIO_ENDPOINT    = "http://127.0.0.1:9000"
MINIO_ACCESS_KEY  = "telcoadmin"
MINIO_SECRET_KEY  = "telcopassword123"
MINIO_BUCKET_RAW  = "telco-raw-data"
MINIO_BUCKET_PROC = "telco-processed-data"

# Batch: simpan ke MinIO setiap N pesan atau M detik
BATCH_SIZE     = 500
BATCH_TIMEOUT  = 30   # detik

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
log = logging.getLogger(__name__)


# ─── KONEKSI MINIO ──────────────────────────────────────────
def create_minio_client():
    return boto3.client(
        "s3",
        endpoint_url=MINIO_ENDPOINT,
        aws_access_key_id=MINIO_ACCESS_KEY,
        aws_secret_access_key=MINIO_SECRET_KEY,
        config=Config(signature_version="s3v4"),
        region_name="us-east-1",
    )


# ─── FEATURE ENGINEERING ────────────────────────────────────
def clean_and_engineer(df: pd.DataFrame) -> pd.DataFrame:
    """
    Transformasi data mentah menjadi features yang siap untuk ML.
    Ini adalah inti dari Data Engineering.
    """
    # 1. Parse timestamp
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df["hour"]      = df["timestamp"].dt.hour
    df["dayofweek"] = df["timestamp"].dt.dayofweek

    # 2. Hapus nilai tidak masuk akal (data quality)
    df = df[df["latency_ms"] >= 0]
    df = df[df["packet_loss_pct"].between(0, 100)]
    df = df[df["cpu_usage_pct"].between(0, 100)]
    df = df[df["throughput_mbps"] >= 0]

    # 3. Rolling features: rata-rata 5 menit per device
    #    Ini penting untuk model time-series!
    df = df.sort_values(["device_id", "timestamp"])
    for col in ["latency_ms", "packet_loss_pct", "cpu_usage_pct"]:
        df[f"{col}_rolling5"] = (
            df.groupby("device_id")[col]
            .transform(lambda x: x.rolling(5, min_periods=1).mean())
        )

    # 4. Anomaly score sederhana (Z-score per device)
    #    Model ML akan belajar dari pola ini
    for col in ["latency_ms", "cpu_usage_pct"]:
        mean = df.groupby("device_id")[col].transform("mean")
        std  = df.groupby("device_id")[col].transform("std").fillna(1)
        df[f"{col}_zscore"] = (df[col] - mean) / std

    # 5. Flag: apakah perangkat dalam kondisi kritis?
    df["is_critical"] = (
        (df["latency_ms"] > 100) |
        (df["packet_loss_pct"] > 5) |
        (df["cpu_usage_pct"] > 90)
    ).astype(int)

    return df


# ─── SIMPAN KE MINIO ─────────────────────────────────────────
def save_to_minio(client, df: pd.DataFrame, bucket: str, prefix: str):
    """Simpan DataFrame sebagai file Parquet ke MinIO."""
    now = datetime.now(timezone.utc)

    # Path terstruktur: tahun/bulan/hari/jam/file.parquet
    # Ini memudahkan query data historis nanti
    key = (
        f"{prefix}/"
        f"year={now.year}/month={now.month:02d}/"
        f"day={now.day:02d}/hour={now.hour:02d}/"
        f"{now.strftime('%Y%m%d_%H%M%S')}_{len(df)}rows.parquet"
    )

    # Konversi ke Parquet (format kolumnar, efisien untuk ML)
    buffer = io.BytesIO()
    df.to_parquet(buffer, index=False, engine="pyarrow")
    buffer.seek(0)

    client.put_object(
        Bucket=bucket,
        Key=key,
        Body=buffer,
        ContentType="application/octet-stream",
    )

    size_kb = len(buffer.getvalue()) / 1024
    log.info(f"💾 Disimpan → {bucket}/{key} ({len(df)} baris, {size_kb:.1f} KB)")
    return key


# ─── STATISTIK BATCH ─────────────────────────────────────────
def log_batch_stats(records: list):
    """Tampilkan statistik dari batch yang baru diproses."""
    df = pd.DataFrame(records)
    anomaly_count = df["is_anomaly"].sum() if "is_anomaly" in df else 0
    regions = df["region"].value_counts().to_dict() if "region" in df else {}

    log.info(
        f"📊 Batch stats: {len(records)} pesan | "
        f"Anomali: {anomaly_count} | "
        f"Regions: {dict(list(regions.items())[:3])}"
    )
    if "latency_ms" in df:
        log.info(
            f"   Latency avg: {df['latency_ms'].mean():.1f}ms | "
            f"   max: {df['latency_ms'].max():.1f}ms"
        )


# ─── MAIN CONSUMER LOOP ─────────────────────────────────────
def run_consumer():
    log.info("🚀 Kafka Consumer dimulai")
    log.info(f"   Topic  : {KAFKA_TOPIC}")
    log.info(f"   Group  : {KAFKA_GROUP_ID}")
    log.info(f"   Batch  : {BATCH_SIZE} pesan / {BATCH_TIMEOUT}s")

    # Setup Kafka Consumer
    consumer = KafkaConsumer(
        KAFKA_TOPIC,
        bootstrap_servers=KAFKA_BOOTSTRAP_SERVERS,
        group_id=KAFKA_GROUP_ID,
        auto_offset_reset="latest",        # Mulai dari pesan terbaru
        enable_auto_commit=True,
        value_deserializer=lambda v: json.loads(v.decode("utf-8")),
        session_timeout_ms=30000,
        heartbeat_interval_ms=10000,
    )
    log.info("✅ Terhubung ke Kafka")

    # Setup MinIO
    minio = create_minio_client()
    log.info("✅ Terhubung ke MinIO")

    # Buffer untuk batch processing
    batch_raw  = []
    last_flush = time.time()
    total_processed = 0

    try:
        for message in consumer:
            record = message.value
            batch_raw.append(record)

            # Flush ke MinIO jika batch penuh atau timeout
            should_flush = (
                len(batch_raw) >= BATCH_SIZE or
                (time.time() - last_flush) >= BATCH_TIMEOUT
            )

            if should_flush and batch_raw:
                df_raw = pd.DataFrame(batch_raw)

                # Simpan data mentah (untuk audit/replay)
                save_to_minio(minio, df_raw, MINIO_BUCKET_RAW, "metrics")

                # Feature engineering + simpan data bersih
                df_processed = clean_and_engineer(df_raw.copy())
                save_to_minio(minio, df_processed, MINIO_BUCKET_PROC, "features")

                # Statistik
                log_batch_stats(batch_raw)

                total_processed += len(batch_raw)
                log.info(f"✅ Total diproses: {total_processed} pesan")

                # Reset batch
                batch_raw  = []
                last_flush = time.time()

    except KeyboardInterrupt:
        log.info("🛑 Consumer dihentikan")
        # Flush sisa data sebelum berhenti
        if batch_raw:
            df_raw = pd.DataFrame(batch_raw)
            save_to_minio(minio, df_raw, MINIO_BUCKET_RAW, "metrics")
            log.info(f"💾 Flush akhir: {len(batch_raw)} pesan")
    finally:
        consumer.close()
        log.info(f"📬 Total pesan diproses: {total_processed}")


if __name__ == "__main__":
    run_consumer()