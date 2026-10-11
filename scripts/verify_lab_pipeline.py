"""Require real Kafka events and matching stored Parquet, never substitute generated data."""
import argparse
import io
import json
import time

import pandas as pd
from kafka import KafkaConsumer
from aiops.config import settings
from consumer.kafka_to_minio import create_minio_client


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", required=True)
    parser.add_argument("--event-id", required=True)
    args = parser.parse_args()
    consumer = KafkaConsumer(settings.metrics_topic, bootstrap_servers=settings.kafka_servers.split(","),
        group_id=None, enable_auto_commit=False, auto_offset_reset="earliest", consumer_timeout_ms=20000)
    events = {}
    try:
        for message in consumer:
            event = json.loads(message.value)
            if event.get("device_id") == args.site and event.get("source") == "strata-lab-probe" and event.get("event_id") == args.event_id:
                events[event["event_id"]] = {"partition": message.partition, "offset": message.offset}
            if events:
                break
    finally:
        consumer.close(autocommit=False)
    if not events:
        raise SystemExit("FAILED: no actual lab probe was found in Kafka")
    client = create_minio_client()
    deadline = time.monotonic() + 45
    matched = {settings.raw_bucket: set(), settings.processed_bucket: set()}
    while time.monotonic() < deadline:
        for bucket, prefix in ((settings.raw_bucket, "metrics/"), (settings.processed_bucket, "features/")):
            for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix):
                for item in page.get("Contents", []):
                    data = client.get_object(Bucket=bucket, Key=item["Key"])["Body"].read()
                    frame = pd.read_parquet(io.BytesIO(data), columns=["event_id"])
                    matched[bucket].update(set(frame["event_id"]) & events.keys())
        if all(matched.values()):
            print(json.dumps({"state": "verified", "source": "actual-kafka-and-minio",
                              "matched_events": events, "buckets": list(matched)}, indent=2))
            return
        time.sleep(2)
    raise SystemExit("FAILED: Kafka events were not found in stored raw Parquet within the deadline")


if __name__ == "__main__":
    main()
