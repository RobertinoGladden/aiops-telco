"""Process-local worker telemetry; counts advance only after durable acknowledgement."""
import time

from prometheus_client import CollectorRegistry, Counter, Gauge, start_http_server


class WorkerMonitor:
    def __init__(self, worker):
        self.registry = CollectorRegistry()
        labels = {"worker": worker}
        def gauge(name, description):
            return Gauge("telco_worker_" + name, description, labels.keys(), registry=self.registry).labels(**labels)
        def counter(name, description):
            return Counter("telco_worker_" + name, description, labels.keys(), registry=self.registry).labels(**labels)
        self.heartbeat = gauge("heartbeat_timestamp_seconds", "Most recent successful poll or processing cycle")
        self.last_success = gauge("last_success_timestamp_seconds", "Last acknowledged batch; zero before any batch")
        self.buffered = gauge("buffered_events", "Events waiting for this process to acknowledge")
        self.processed = counter("processed_events", "Valid events acknowledged by this process")
        self.quarantined = counter("quarantined_events", "Invalid events acknowledged in the dead-letter topic")
        self.errors = counter("errors", "Worker errors requiring process recovery")
        self.fallbacks = counter("rule_fallbacks", "Acknowledged predictions using measured rules instead of ML")

    def start(self, port):
        start_http_server(port, registry=self.registry)

    def tick(self, buffered=0):
        self.heartbeat.set(time.time())
        self.buffered.set(buffered)

    def acknowledged(self, processed, quarantined=0, fallbacks=0):
        self.processed.inc(processed)
        self.quarantined.inc(quarantined)
        self.fallbacks.inc(fallbacks)
        self.last_success.set(time.time())
        self.tick()
