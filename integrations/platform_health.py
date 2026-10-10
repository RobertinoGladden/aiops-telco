"""Bounded service probes and observed pipeline metrics, cached for 30 seconds."""
import json
import math
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from prometheus_client.parser import text_string_to_metric_families

from aiops.contracts import utcnow


class PlatformHealth:
    def __init__(self, config):
        self.config = config
        self.lock = threading.Lock()
        self.cached = []
        self.observability = {}
        self.expires = 0

    def snapshot(self):
        with self.lock:
            if time.monotonic() < self.expires:
                return self.cached
            c = self.config
            probes = [
                ("kafka", "Kafka", "tcp", c.kafka_servers.split(",")[0]),
                ("storage", "Storage worker", "worker", c.storage_metrics_url.rstrip("/") + "/metrics"),
                ("predictor", "Detection worker", "worker", c.predictor_metrics_url.rstrip("/") + "/metrics"),
                ("minio", "MinIO", "http", c.minio_endpoint.rstrip("/") + "/minio/health/ready"),
                ("model-api", "Model API", "model", c.model_api_url.rstrip("/") + "/model/info"),
                ("mlflow", "MLflow", "http", c.mlflow_uri.rstrip("/") + "/health"),
                ("prometheus", "Prometheus", "http", c.prometheus_url.rstrip("/") + "/-/ready"),
                ("alertmanager", "Alertmanager", "http", c.alertmanager_url.rstrip("/") + "/-/ready"),
                ("grafana", "Grafana", "grafana", c.grafana_url.rstrip("/") + "/api/health"),
                ("airflow", "Airflow", "airflow", c.airflow_url.rstrip("/") + "/health" if c.airflow_url else ""),
            ]
            with ThreadPoolExecutor(max_workers=11) as pool:
                observations = pool.submit(self.pipeline_metrics)
                self.cached = list(pool.map(self.probe, probes))
                self.observability = observations.result()
            self.expires = time.monotonic() + 30
            return self.cached

    @staticmethod
    def probe(spec):
        key, name, protocol, endpoint = spec
        result = {"id": key, "name": name, "checked_at": utcnow(), "state": "unavailable"}
        if not endpoint:
            return {**result, "state": "disabled", "detail": "Optional service is not configured"}
        started = time.monotonic()
        try:
            if protocol == "tcp":
                host, port = endpoint.rsplit(":", 1)
                with socket.create_connection((host.strip("[]"), int(port)), timeout=2):
                    result.update(state="reachable", detail="TCP reachable; broker readiness is not verified")
            else:
                response = requests.get(endpoint, timeout=2, allow_redirects=False)
                result.update(state="healthy" if response.status_code == 200 else "unavailable", detail=f"HTTP {response.status_code}")
                if response.status_code == 200 and protocol == "worker":
                    metrics = {}
                    for family in text_string_to_metric_families(response.text):
                        for sample in family.samples:
                            if sample.labels.get("worker") == key and sample.name.startswith("telco_worker_") and math.isfinite(sample.value):
                                metrics[sample.name.removeprefix("telco_worker_")] = sample.value
                    heartbeat = metrics.get("heartbeat_timestamp_seconds", 0)
                    age = time.time() - heartbeat
                    result.update(metrics=metrics, state="healthy" if heartbeat > 0 and -5 <= age <= 90 else "stale",
                                  detail="Worker heartbeat is current" if heartbeat > 0 and -5 <= age <= 90 else "Worker has no current heartbeat")
                elif response.status_code == 200 and protocol == "airflow":
                    health = response.json()
                    components = {component: health.get(component, {}).get("status", "unknown") for component in ("metadatabase", "scheduler")}
                    result.update(components=components, state="healthy" if all(value == "healthy" for value in components.values()) else "unavailable",
                                  detail="Database and scheduler: " + ", ".join(f"{key} {value}" for key, value in components.items()))
                elif response.status_code == 200 and protocol == "grafana":
                    database = response.json().get("database")
                    result.update(state="healthy" if database == "ok" else "unavailable", detail="Grafana database: " + str(database))
                elif response.status_code == 200 and protocol == "model":
                    info = response.json()
                    metadata = info.get("metadata", {})
                    result.update(detail="Loaded model is ready for inference", model={
                        "name": str(info["model_name"])[:100], "features": info["features"],
                        "training": {field: metadata.get(field) for field in ("trained_at", "train_rows", "test_rows", "train_end", "test_start", "evaluation")}})
        except Exception as error:
            result.update(state="unavailable", detail=type(error).__name__)
        result["latency_ms"] = round((time.monotonic() - started) * 1000)
        return result

    def pipeline_metrics(self):
        """Missing series remain null, so a disconnected exporter never looks idle."""
        base = self.config.prometheus_url.rstrip("/")
        result = {"checked_at": utcnow(), "available": False, "lag": {"storage": None, "predictor": None},
                  "dead_letter_offset": None, "firing_alerts": None, "errors": []}
        queries = {
            "lag": 'sum by (consumergroup) (kafka_consumergroup_lag{consumergroup=~"telco-.*-v2"} and on(job,instance) (up{job="kafka"} == 1))',
            "dead_letter_offset": 'sum(kafka_topic_partition_current_offset{topic=' + json.dumps(self.config.dlq_topic) + '} and on(job,instance) (up{job="kafka"} == 1))',
        }
        def query(item):
            name, expression = item
            try:
                response = requests.get(base + "/api/v1/query", params={"query": expression}, timeout=2, allow_redirects=False)
                response.raise_for_status()
                body = response.json()
                if body.get("status") != "success" or body.get("data", {}).get("resultType") != "vector":
                    raise ValueError("Invalid query result")
                return name, body["data"]["result"], None
            except Exception as error:
                return name, [], type(error).__name__
        with ThreadPoolExecutor(max_workers=2) as pool:
            for name, rows, error in pool.map(query, queries.items()):
                if error:
                    result["errors"].append({"signal": name, "error_type": error})
                    continue
                result["available"] = True
                for row in rows:
                    try:
                        value = float(row["value"][1])
                    except (KeyError, IndexError, TypeError, ValueError):
                        result["errors"].append({"signal": name, "error_type": "InvalidMetricValue"})
                        continue
                    if not math.isfinite(value) or value < 0:
                        continue
                    if name == "lag":
                        worker = {"telco-data-pipeline-v2": "storage", "telco-auto-predictor-v2": "predictor"}.get(row["metric"].get("consumergroup"))
                        if worker:
                            result["lag"][worker] = value
                    else:
                        result[name] = value
        try:
            response = requests.get(base + "/api/v1/alerts", timeout=2, allow_redirects=False)
            response.raise_for_status()
            body = response.json()
            if body.get("status") != "success":
                raise ValueError("Invalid alert result")
            result["firing_alerts"] = sum(row.get("state") == "firing" for row in body["data"]["alerts"])
        except Exception as error:
            result["errors"].append({"signal": "firing_alerts", "error_type": type(error).__name__})
        return result
