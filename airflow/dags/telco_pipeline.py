"""
================================================================
TELCO AIOPS — Tahap 2: Apache Airflow DAG
Fungsi: Orkestrasi pipeline data otomatis — setiap jam
        Airflow menjalankan: validasi → agregasi → export

Airflow adalah "manajer" yang memastikan pipeline berjalan
tepat waktu dan dalam urutan yang benar.
================================================================
"""

from datetime import datetime, timedelta
import json
import logging

from airflow import DAG
from airflow.operators.python import PythonOperator
from airflow.operators.bash import BashOperator
from airflow.utils.dates import days_ago

import pandas as pd
import boto3
from botocore.client import Config
import io

# ─── KONFIGURASI ────────────────────────────────────────────
MINIO_CONFIG = {
    "endpoint_url":          "http://telco-minio:9000",
    "aws_access_key_id":     "telcoadmin",
    "aws_secret_access_key": "telcopassword123",
    "config":                Config(signature_version="s3v4"),
    "region_name":           "us-east-1",
}
BUCKET_RAW  = "telco-raw-data"
BUCKET_PROC = "telco-processed-data"

log = logging.getLogger(__name__)


# ─── DEFAULT ARGS ────────────────────────────────────────────
default_args = {
    "owner":            "telco-aiops",
    "depends_on_past":  False,
    "start_date":       days_ago(1),
    "email_on_failure": False,
    "retries":          2,
    "retry_delay":      timedelta(minutes=5),
}


# ─── TASK FUNCTIONS ─────────────────────────────────────────

def validate_data(**context):
    """
    Task 1: Validasi kualitas data di MinIO.
    Cek apakah ada file baru dalam 1 jam terakhir.
    """
    client = boto3.client("s3", **MINIO_CONFIG)
    now = datetime.utcnow()

    # List file dari jam ini
    prefix = (
        f"metrics/year={now.year}/month={now.month:02d}/"
        f"day={now.day:02d}/hour={now.hour:02d}/"
    )

    response = client.list_objects_v2(Bucket=BUCKET_RAW, Prefix=prefix)
    files = response.get("Contents", [])

    if not files:
        raise ValueError(f"❌ Tidak ada data baru di {BUCKET_RAW}/{prefix}")

    total_size = sum(f["Size"] for f in files)
    log.info(f"✅ Validasi OK: {len(files)} file, {total_size/1024:.1f} KB")

    # Pass info ke task berikutnya via XCom
    context["ti"].xcom_push(key="file_count", value=len(files))
    context["ti"].xcom_push(key="prefix",     value=prefix)
    return {"status": "valid", "files": len(files)}


def aggregate_hourly(**context):
    """
    Task 2: Agregasi data per jam per region per device_type.
    Hasilnya dipakai untuk training model dan dashboard Grafana.
    """
    client = boto3.client("s3", **MINIO_CONFIG)
    prefix = context["ti"].xcom_pull(key="prefix", task_ids="validate_data")

    # Download semua file Parquet dari jam ini
    response = client.list_objects_v2(Bucket=BUCKET_PROC, Prefix=prefix.replace("metrics", "features"))
    files = response.get("Contents", [])

    if not files:
        log.warning("Tidak ada file processed untuk diagregasi")
        return

    dfs = []
    for f in files:
        obj = client.get_object(Bucket=BUCKET_PROC, Key=f["Key"])
        df  = pd.read_parquet(io.BytesIO(obj["Body"].read()))
        dfs.append(df)

    df_all = pd.concat(dfs, ignore_index=True)

    # Agregasi per region + device_type
    agg = df_all.groupby(["region", "device_type"]).agg(
        avg_latency     =("latency_ms",       "mean"),
        max_latency     =("latency_ms",       "max"),
        avg_packet_loss =("packet_loss_pct",  "mean"),
        avg_cpu         =("cpu_usage_pct",    "mean"),
        anomaly_count   =("is_anomaly",       "sum"),
        total_devices   =("device_id",        "nunique"),
        critical_count  =("is_critical",      "sum"),
    ).reset_index()

    # Tambah anomaly_rate
    agg["anomaly_rate_pct"] = (
        agg["anomaly_count"] / agg["total_devices"] * 100
    ).round(2)

    # Simpan hasil agregasi
    now = datetime.utcnow()
    key = (
        f"hourly_agg/year={now.year}/month={now.month:02d}/"
        f"day={now.day:02d}/hour={now.hour:02d}/summary.parquet"
    )
    buffer = io.BytesIO()
    agg.to_parquet(buffer, index=False)
    buffer.seek(0)
    client.put_object(Bucket=BUCKET_PROC, Key=key, Body=buffer)

    log.info(f"✅ Agregasi selesai: {len(agg)} baris → {BUCKET_PROC}/{key}")
    log.info(f"\n{agg.to_string()}")

    context["ti"].xcom_push(key="agg_key", value=key)
    return {"rows": len(agg)}


def detect_degradation(**context):
    """
    Task 3: Deteksi degradasi jaringan dari data agregasi.
    Ini adalah "pre-AIOps" — aturan sederhana sebelum pakai ML.
    """
    client = boto3.client("s3", **MINIO_CONFIG)
    agg_key = context["ti"].xcom_pull(key="agg_key", task_ids="aggregate_hourly")

    if not agg_key:
        log.warning("Tidak ada agg_key, skip detection")
        return

    obj = client.get_object(Bucket=BUCKET_PROC, Key=agg_key)
    agg = pd.read_parquet(io.BytesIO(obj["Body"].read()))

    # Rules-based detection (akan digantikan ML di Tahap 3)
    alerts = []
    for _, row in agg.iterrows():
        if row["avg_latency"] > 80:
            alerts.append({
                "region":   row["region"],
                "type":     row["device_type"],
                "alert":    "HIGH_LATENCY",
                "value":    round(row["avg_latency"], 2),
                "severity": "WARNING" if row["avg_latency"] < 150 else "CRITICAL"
            })
        if row["anomaly_rate_pct"] > 10:
            alerts.append({
                "region":   row["region"],
                "type":     row["device_type"],
                "alert":    "HIGH_ANOMALY_RATE",
                "value":    round(row["anomaly_rate_pct"], 2),
                "severity": "WARNING"
            })

    if alerts:
        log.warning(f"🚨 {len(alerts)} alert terdeteksi:")
        for a in alerts:
            log.warning(f"   [{a['severity']}] {a['region']} {a['type']}: {a['alert']} = {a['value']}")
    else:
        log.info("✅ Tidak ada degradasi jaringan terdeteksi")

    context["ti"].xcom_push(key="alert_count", value=len(alerts))
    return {"alerts": alerts}


def export_for_ml(**context):
    """
    Task 4: Ekspor dataset bersih untuk training ML (Tahap 3).
    Format: satu file Parquet besar dengan semua features.
    """
    client  = boto3.client("s3", **MINIO_CONFIG)
    response = client.list_objects_v2(Bucket=BUCKET_PROC, Prefix="features/")
    files   = response.get("Contents", [])[-100:]   # 100 file terakhir

    if not files:
        log.warning("Belum ada data untuk di-export")
        return

    dfs = []
    for f in files:
        try:
            obj = client.get_object(Bucket=BUCKET_PROC, Key=f["Key"])
            dfs.append(pd.read_parquet(io.BytesIO(obj["Body"].read())))
        except Exception as e:
            log.warning(f"Skip {f['Key']}: {e}")

    if not dfs:
        return

    df_ml = pd.concat(dfs, ignore_index=True)

    # Pilih hanya kolom yang dibutuhkan ML
    ml_cols = [
        "device_id", "device_type", "region", "timestamp",
        "latency_ms", "packet_loss_pct", "cpu_usage_pct",
        "throughput_mbps", "signal_strength_dbm", "error_rate",
        "latency_ms_rolling5", "packet_loss_pct_rolling5",
        "cpu_usage_pct_rolling5", "latency_ms_zscore",
        "cpu_usage_pct_zscore", "hour", "dayofweek",
        "is_critical", "is_anomaly",   # Label untuk supervised learning
    ]
    existing_cols = [c for c in ml_cols if c in df_ml.columns]
    df_ml = df_ml[existing_cols].dropna()

    # Simpan ke bucket processed dengan nama khusus untuk ML
    now = datetime.utcnow()
    key = f"ml_dataset/training_data_{now.strftime('%Y%m%d_%H')}.parquet"
    buffer = io.BytesIO()
    df_ml.to_parquet(buffer, index=False)
    buffer.seek(0)
    client.put_object(Bucket=BUCKET_PROC, Key=key, Body=buffer)

    log.info(f"✅ ML Dataset siap: {len(df_ml)} baris, {len(existing_cols)} fitur → {key}")
    return {"rows": len(df_ml), "features": len(existing_cols)}


# ─── DAG DEFINITION ─────────────────────────────────────────
with DAG(
    dag_id="telco_data_pipeline",
    description="Pipeline data Telco AIOps: Kafka → MinIO → ML Dataset",
    default_args=default_args,
    schedule_interval="@hourly",     # Jalankan setiap jam
    catchup=False,
    tags=["telco", "aiops", "data-engineering"],
) as dag:

    # Task 1: Validasi data masuk
    t1_validate = PythonOperator(
        task_id="validate_data",
        python_callable=validate_data,
    )

    # Task 2: Agregasi per jam
    t2_aggregate = PythonOperator(
        task_id="aggregate_hourly",
        python_callable=aggregate_hourly,
    )

    # Task 3: Deteksi degradasi
    t3_detect = PythonOperator(
        task_id="detect_degradation",
        python_callable=detect_degradation,
    )

    # Task 4: Export untuk ML
    t4_export = PythonOperator(
        task_id="export_for_ml",
        python_callable=export_for_ml,
    )

    # Task 5: Log summary ke console
    t5_summary = BashOperator(
        task_id="log_summary",
        bash_command=(
            'echo "Pipeline selesai: $(date)" && '
            'echo "Data siap untuk Tahap 3 MLOps"'
        ),
    )

    # Urutan eksekusi: t1 → t2 → t3 → t4 → t5
    # t3 dan t4 bisa jalan paralel setelah t2
    t1_validate >> t2_aggregate >> [t3_detect, t4_export] >> t5_summary
