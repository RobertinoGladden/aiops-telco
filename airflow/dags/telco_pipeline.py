"""Hourly quality/aggregation/export using the scheduled interval and all S3 pages."""
import io
import logging
import os
from datetime import datetime, timedelta, timezone
import boto3
import pandas as pd
from botocore.client import Config
from airflow import DAG
from airflow.operators.python import PythonOperator

log = logging.getLogger(__name__)
BUCKET_RAW = os.getenv("MINIO_BUCKET_RAW", "telco-raw-data")
BUCKET_PROC = os.getenv("MINIO_BUCKET_PROC", "telco-processed-data")


def client():
    return boto3.client("s3", endpoint_url=os.getenv("MINIO_ENDPOINT", "http://minio:9000"),
        aws_access_key_id=os.getenv("MINIO_ACCESS_KEY", "telcoadmin"),
        aws_secret_access_key=os.getenv("MINIO_SECRET_KEY", "telcopassword123"),
        config=Config(signature_version="s3v4"), region_name="us-east-1")


def files(s3, bucket, prefix):
    return [item for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix)
            for item in page.get("Contents", []) if item["Key"].endswith(".parquet")]


def validate_data(**context):
    stamp = context["data_interval_start"].astimezone(timezone.utc)
    prefix = f"year={stamp.year}/month={stamp.month:02d}/day={stamp.day:02d}/hour={stamp.hour:02d}/"
    found = files(client(), BUCKET_RAW, "metrics/" + prefix)
    if not found:
        raise ValueError(f"No raw telemetry for scheduled interval {stamp}")
    context["ti"].xcom_push(key="prefix", value=prefix)
    return {"files": len(found)}


def aggregate_hourly(**context):
    s3 = client()
    prefix = context["ti"].xcom_pull(key="prefix", task_ids="validate_data")
    found = files(s3, BUCKET_PROC, "features/" + prefix)
    if not found:
        raise ValueError("Raw data exists but processed features are missing")
    df = pd.concat([pd.read_parquet(io.BytesIO(s3.get_object(Bucket=BUCKET_PROC, Key=item["Key"])["Body"].read())) for item in found], ignore_index=True)
    if "event_id" in df:
        df = df.drop_duplicates("event_id")
    if "is_anomaly" not in df:
        df["is_anomaly"] = None
    agg = df.groupby(["source", "region", "device_type"], dropna=False).agg(
        observations=("device_id", "count"), total_devices=("device_id", "nunique"),
        avg_latency=("latency_ms", "mean"), avg_packet_loss=("packet_loss_pct", "mean"),
        avg_cpu=("cpu_usage_pct", "mean"), labeled_observations=("is_anomaly", "count"),
        labeled_anomalies=("is_anomaly", "sum"), critical_count=("is_critical", "sum"),
    ).reset_index()
    agg["anomaly_rate_pct"] = (agg["labeled_anomalies"] / agg["labeled_observations"].replace(0, float("nan")) * 100).round(2)
    buffer = io.BytesIO()
    agg.to_parquet(buffer, index=False)
    key = "hourly_agg/" + prefix + "summary.parquet"
    s3.put_object(Bucket=BUCKET_PROC, Key=key, Body=buffer.getvalue())
    log.info("Hourly aggregate: %s", key)
    context["ti"].xcom_push(key="agg_key", value=key)
    return {"rows": len(agg)}


def export_for_ml(**context):
    s3 = client()
    prefix = context["ti"].xcom_pull(key="prefix", task_ids="validate_data")
    found = files(s3, BUCKET_PROC, "features/" + prefix)
    if not found:
        raise ValueError("No processed telemetry for export")
    df = pd.concat([pd.read_parquet(io.BytesIO(s3.get_object(Bucket=BUCKET_PROC, Key=item["Key"])["Body"].read())) for item in found], ignore_index=True)
    if "event_id" in df:
        df = df.drop_duplicates("event_id")
    buffer = io.BytesIO()
    df.to_parquet(buffer, index=False)
    key = "ml_dataset/" + prefix + "training.parquet"
    s3.put_object(Bucket=BUCKET_PROC, Key=key, Body=buffer.getvalue())
    return {"observations": len(df), "key": key}


with DAG("telco_data_pipeline", description="Interval-based telemetry validation, aggregation and export",
         start_date=datetime(2026, 1, 1, tzinfo=timezone.utc), schedule="@hourly", catchup=False,
         default_args={"owner": "telco-aiops", "retries": 2, "retry_delay": timedelta(minutes=5)},
         tags=["telco", "aiops"]) as dag:
    validate = PythonOperator(task_id="validate_data", python_callable=validate_data)
    aggregate = PythonOperator(task_id="aggregate_hourly", python_callable=aggregate_hourly)
    export = PythonOperator(task_id="export_for_ml", python_callable=export_for_ml)
    validate >> [aggregate, export]
