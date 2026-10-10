"""Manual offset acknowledgements and durable quarantine publishing."""
import json
from kafka import KafkaProducer
from kafka.structs import TopicPartition, OffsetAndMetadata
from aiops.config import settings
from aiops.contracts import utcnow


def producer(kafka_servers=None):
    return KafkaProducer(
        bootstrap_servers=(kafka_servers or settings.kafka_servers).split(","), acks="all", retries=5,
        max_in_flight_requests_per_connection=1,
        value_serializer=lambda value: json.dumps(value, allow_nan=False).encode(),
        key_serializer=lambda value: value.encode(),
    )


def commit_messages(consumer, messages):
    offsets = {}
    for message in messages:
        tp = TopicPartition(message.topic, message.partition)
        offsets[tp] = OffsetAndMetadata(max(message.offset + 1, offsets[tp].offset if tp in offsets else 0), "")
    if offsets:
        consumer.commit(offsets=offsets)


def quarantine(publisher, message, error):
    event = {
        "event_id": f"{message.topic}:{message.partition}:{message.offset}",
        "timestamp": utcnow(), "error": type(error).__name__,
        "topic": message.topic, "partition": message.partition, "offset": message.offset,
        "raw": message.value.decode("utf-8", errors="replace"),
    }
    publisher.send(settings.dlq_topic, key=event["event_id"], value=event).get(timeout=15)
