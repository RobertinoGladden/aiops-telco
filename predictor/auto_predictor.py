"""Telemetry -> ML/rules -> persisted detection -> Kafka acknowledgement."""
import logging
import os
import requests
from kafka import KafkaConsumer
from aiops.config import settings
from aiops.contracts import NetworkMetric, Detection
from aiops.features import FeatureBuilder, rule_detection
from aiops.kafka import producer, quarantine, commit_messages
from aiops.telemetry import WorkerMonitor

log = logging.getLogger(__name__)


def detect(record, session):
    method = "rules"
    severity, actions = rule_detection(record)
    evidence = {"telemetry": record}
    try:
        response = session.post(f"{settings.model_api_url}/predict", json=record, timeout=10)
        if response.status_code == 200:
            prediction = response.json()
            severity = prediction["severity"]
            method = "ml"
            evidence["prediction"] = prediction
        elif response.status_code not in (422, 503):
            response.raise_for_status()
    except requests.RequestException as error:
        log.warning("Model unavailable; applying measured rules: %s", type(error).__name__)
    return Detection(
        event_id=f"detection:{record['source']}:{record['event_id']}", source=record["source"], device_id=record["device_id"],
        timestamp=record["timestamp"], severity=severity, method=method,
        region=record["region"], summary=f"{severity} network telemetry ({method})",
        evidence=evidence, suggested_actions=actions if severity != "normal" else [],
    )


def process_batch(consumer, publisher, session, messages, records, monitor=None):
    fallbacks = 0
    for record in records:
        detection = detect(record, session)
        fallbacks += detection.method == "rules"
        response = session.post(f"{settings.hub_url}/detections", json=detection.model_dump(mode="json"),
                                headers={"Authorization": f"Bearer {settings.hub_token}"}, timeout=10)
        response.raise_for_status()
        publisher.send(settings.predictions_topic, key=detection.device_id,
                       value=detection.model_dump(mode="json")).get(timeout=15)
    commit_messages(consumer, messages)
    if monitor:
        monitor.acknowledged(len(records), len(messages) - len(records), fallbacks)


def run_auto_predictor():
    monitor = WorkerMonitor("predictor")
    monitor.start(int(os.getenv("PREDICTOR_METRICS_PORT", "9102")))
    consumer = KafkaConsumer(settings.metrics_topic, bootstrap_servers=settings.kafka_servers.split(","),
        group_id="telco-auto-predictor-v2", auto_offset_reset="earliest", enable_auto_commit=False,
        max_poll_interval_ms=600000)
    publisher = producer()
    builder = FeatureBuilder()
    session = requests.Session()
    try:
        while True:
            messages, records = [], []
            polled = consumer.poll(timeout_ms=1000, max_records=10)
            for batch in polled.values():
                for message in batch:
                    try:
                        record = NetworkMetric.model_validate_json(message.value).model_dump(mode="json")
                    except ValueError as error:
                        quarantine(publisher, message, error)
                        messages.append(message)
                        continue
                    records.append(builder.enrich(record))
                    messages.append(message)
            if messages:
                monitor.buffered.set(len(messages))
                process_batch(consumer, publisher, session, messages, records, monitor)
                log.info("Processed %s telemetry events", len(records))
            monitor.tick()
    except KeyboardInterrupt:
        log.info("Predictor stopped")
    except Exception:
        monitor.errors.inc()
        raise
    finally:
        session.close()
        consumer.close(autocommit=False)
        publisher.close(timeout=5)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    run_auto_predictor()
