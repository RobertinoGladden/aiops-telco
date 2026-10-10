"""Kafka -> raw/processed Parquet. Commit only after both writes succeed."""
import io
import json
import logging
import os
import time
from collections import defaultdict
import boto3
import pandas as pd
from botocore.client import Config
from kafka import KafkaConsumer
from aiops.config import settings
from aiops.contracts import NetworkMetric
from aiops.features import FeatureBuilder
from aiops.kafka import producer, quarantine, commit_messages
from aiops.telemetry import WorkerMonitor

log = logging.getLogger(__name__)


def create_minio_client():
    return boto3.client("s3", endpoint_url=settings.minio_endpoint,
        aws_access_key_id=settings.minio_access_key, aws_secret_access_key=settings.minio_secret_key,
        config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=30), region_name="us-east-1")


def clean_and_engineer(df):
    builder = FeatureBuilder()
    return pd.DataFrame([builder.enrich(record) for record in df.to_dict("records")])


def persist_batch(client, records, features, messages):
    locations = sorted((message.partition, message.offset) for message in messages)
    token = "_".join(f"p{partition}-{min(offset for p, offset in locations if p == partition)}-{max(offset for p, offset in locations if p == partition)}"
                     for partition in sorted({p for p, _ in locations}))
    groups = defaultdict(lambda: ([], []))
    for record, feature in zip(records, features):
        stamp = pd.Timestamp(str(record["timestamp"]))
        prefix = f"year={stamp.year}/month={stamp.month:02d}/day={stamp.day:02d}/hour={stamp.hour:02d}/{token}.parquet"
        groups[prefix][0].append(record)
        groups[prefix][1].append(feature)
    for prefix, (raw_rows, processed_rows) in groups.items():
        for bucket, folder, rows in ((settings.raw_bucket, "metrics", raw_rows), (settings.processed_bucket, "features", processed_rows)):
            df = pd.DataFrame(rows)
            if "metadata" in df:
                df["metadata"] = df["metadata"].map(lambda value: json.dumps(value, sort_keys=True))
            buffer = io.BytesIO()
            df.to_parquet(buffer, index=False, engine="pyarrow")
            client.put_object(Bucket=bucket, Key=f"{folder}/{prefix}", Body=buffer.getvalue(), ContentType="application/octet-stream")
    log.info("Stored raw + features: %s (%s events)", token, len(records))


def run_consumer():
    monitor = WorkerMonitor("storage")
    monitor.start(int(os.getenv("STORAGE_METRICS_PORT", "9101")))
    batch_size = int(os.getenv("STORAGE_BATCH_SIZE", "500"))
    timeout = float(os.getenv("STORAGE_BATCH_SECONDS", "30"))
    consumer = KafkaConsumer(settings.metrics_topic, bootstrap_servers=settings.kafka_servers.split(","),
        group_id="telco-data-pipeline-v2", auto_offset_reset="earliest", enable_auto_commit=False,
        max_poll_interval_ms=600000)
    publisher = producer()
    client = create_minio_client()
    builder = FeatureBuilder()
    records, features, messages = [], [], []
    last_flush = time.monotonic()

    def flush():
        if records:
            persist_batch(client, records, features, messages)
        commit_messages(consumer, messages)
        monitor.acknowledged(len(records), len(messages) - len(records))
        records.clear()
        features.clear()
        messages.clear()

    try:
        while True:
            polled = consumer.poll(timeout_ms=1000, max_records=batch_size)
            for partition_records in polled.values():
                for message in partition_records:
                    try:
                        record = NetworkMetric.model_validate_json(message.value).model_dump(mode="json")
                    except ValueError as error:
                        quarantine(publisher, message, error)
                        messages.append(message)
                        continue
                    records.append(record)
                    features.append(builder.enrich(record))
                    messages.append(message)
            if messages and (len(messages) >= batch_size or time.monotonic() - last_flush >= timeout):
                flush()
                last_flush = time.monotonic()
            monitor.tick(len(messages))
    except KeyboardInterrupt:
        flush()
    except Exception:
        monitor.errors.inc()
        raise
    finally:
        consumer.close(autocommit=False)
        publisher.close(timeout=5)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run_consumer()
