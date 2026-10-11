"""Actual, allowlisted FRR lab changes with review, stale-state checks and measured verification."""
import difflib
import hashlib
import hmac
import json
import os
import shutil
import sqlite3
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal
from uuid import uuid4

import boto3
import requests
from botocore.client import Config
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from kafka import KafkaProducer
from prometheus_client import CollectorRegistry, Gauge, generate_latest, CONTENT_TYPE_LATEST
from pydantic import BaseModel, ConfigDict, Field

ROOT = Path(os.getenv("LAB_ROOT", "/lab"))
EVIDENCE = ROOT / "evidence"
EVIDENCE.mkdir(parents=True, exist_ok=True)
SITES = {item["id"]: item for item in json.loads((ROOT / "config/sites.json").read_text())}
TOKEN = os.environ["LAB_API_TOKEN"]
if len(TOKEN) < 32:
    raise RuntimeError("Generate a strong lab API token with prepare_lab")
LOCK = threading.Lock()
AUTH = HTTPBearer(auto_error=False)
REGISTRY = CollectorRegistry()
PROBE_TIME = Gauge("strata_lab_probe_timestamp_seconds", "Last completed real path measurement", ["site"], registry=REGISTRY)
PROBE_LOSS = Gauge("strata_lab_packet_loss_percent", "Real ping loss", ["site"], registry=REGISTRY)
PROBE_RTT = Gauge("strata_lab_latency_ms", "Real average ping RTT", ["site"], registry=REGISTRY)
PROBE_THROUGHPUT = Gauge("strata_lab_throughput_mbps", "Real iperf receiver throughput", ["site"], registry=REGISTRY)
app = FastAPI(title="Strata executable network lab", version="1.0")


def stamp():
    return datetime.now(timezone.utc).isoformat()


def auth(credentials: HTTPAuthorizationCredentials = Depends(AUTH)):
    if not credentials or not hmac.compare_digest(credentials.credentials, TOKEN):
        raise HTTPException(401, "Valid lab operator token required")


def db():
    connection = sqlite3.connect(EVIDENCE / "jobs.sqlite", timeout=30)
    connection.execute("CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, document TEXT NOT NULL)")
    return connection


def save(job):
    with db() as connection:
        connection.execute("INSERT INTO jobs VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document=excluded.document", (job["id"], json.dumps(job)))


def get(job_id):
    with db() as connection:
        row = connection.execute("SELECT document FROM jobs WHERE id=?", (job_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Lab job not found")
    return json.loads(row[0])


def site_name(site_id):
    if site_id not in SITES:
        raise HTTPException(404, "Unknown dedicated lab site")
    return site_id.split("-")[0].lower()


def ssh(site_id, client, script, *arguments):
    host = site_name(site_id) + ("-client" if client else "-router")
    private_key = Path("/tmp/strata_lab_identity")
    if not private_key.exists():
        shutil.copyfile(ROOT / "ssh/id_ed25519", private_key)
        private_key.chmod(0o600)
    # Inputs are fixed site IDs and fixed helper arguments; no arbitrary commands or hosts are accepted.
    result = subprocess.run(["ssh", "-i", str(private_key), "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
        "-o", "StrictHostKeyChecking=accept-new", "-o", f"UserKnownHostsFile={EVIDENCE / 'known_hosts'}",
        f"root@{host}", "python3", f"/opt/strata/{script}.py", *arguments], capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Lab SSH/helper execution failed")
    return json.loads(result.stdout)


def check_intent(site_id):
    if os.getenv("LAB_NETBOX_ENABLED", "false").lower() != "true":
        return {"source": "committed-lab-plan", "site": SITES[site_id]}
    response = requests.get("http://netbox:8080/api/ipam/prefixes/", params={"prefix": SITES[site_id]["service"]},
                            headers={"Authorization": "Token " + os.environ["NETBOX_TOKEN"]}, timeout=10, allow_redirects=False)
    response.raise_for_status()
    matches = response.json()["results"]
    if len(matches) != 1 or matches[0]["prefix"] != SITES[site_id]["service"]:
        raise RuntimeError("NetBox does not contain the unique intended service prefix")
    return {"source": "netbox", "prefix_id": matches[0]["id"], "prefix": matches[0]["prefix"]}


def probe(site_id, deliver=True):
    result = ssh(site_id, True, "probe")
    result.update({"device_id": site_id, "source": "strata-lab-probe", "region": SITES[site_id]["name"], "device_type": "virtual-frr-site"})
    PROBE_TIME.labels(site_id).set(time.time())
    PROBE_LOSS.labels(site_id).set(result["packet_loss_pct"])
    for gauge, field in ((PROBE_RTT, "latency_ms"), (PROBE_THROUGHPUT, "throughput_mbps")):
        if result[field] is not None:
            gauge.labels(site_id).set(result[field])
        else:
            try:
                gauge.remove(site_id)
            except KeyError:
                pass
    if deliver and os.getenv("LAB_PIPELINE_ENABLED", "false").lower() == "true":
        event = {key: value for key, value in result.items() if key != "evidence"}
        event["metadata"] = {"lab": "strata-engineering-lab", "probe_event_id": result["event_id"], "measurement": "ping-and-iperf3"}
        response = requests.post("http://integration-hub:8082/ingest/metrics", json={"events": [event]},
            headers={"Authorization": "Bearer " + os.environ["INTEGRATION_API_TOKEN"]}, timeout=10, allow_redirects=False)
        response.raise_for_status()
        result["hub_delivery"] = response.json()
    (EVIDENCE / f"probe-{result['event_id']}.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def archive(job):
    if os.getenv("LAB_PIPELINE_ENABLED", "false").lower() != "true":
        return {"state": "local-only", "reason": "Data profile is disabled"}
    client = boto3.client("s3", endpoint_url="http://minio:9000", aws_access_key_id=os.environ["MINIO_ACCESS_KEY"],
        aws_secret_access_key=os.environ["MINIO_SECRET_KEY"], region_name="us-east-1",
        config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=15))
    bucket = "strata-lab-evidence"
    try:
        client.head_bucket(Bucket=bucket)
    except client.exceptions.ClientError as error:
        if error.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 404:
            raise
        client.create_bucket(Bucket=bucket)
    key = f"changes/{job['site']}/{job['id']}.json"
    client.put_object(Bucket=bucket, Key=key, Body=json.dumps(job).encode(), ContentType="application/json")
    producer = KafkaProducer(bootstrap_servers="kafka:9092", request_timeout_ms=10000,
                             value_serializer=lambda value: json.dumps(value).encode())
    try:
        receipt = producer.send("strata.lab.changes", key=job["site"].encode(),
                                value={"job_id": job["id"], "site": job["site"], "state": job["state"], "artifact": key}).get(timeout=15)
        return {"state": "acknowledged", "bucket": bucket, "key": key, "partition": receipt.partition, "offset": receipt.offset}
    finally:
        producer.close(timeout=5)


class Candidate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["prefer_backup", "restore_primary", "impair_primary", "clear_impairment"]
    reason: str = Field(min_length=5, max_length=300)


class Approval(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reviewer: str = Field(min_length=2, max_length=80)


@app.get("/health")
def health():
    return {"process": "ready", "scope": "Dedicated virtual-site execution only", "device_health": "Use measured probes"}


@app.get("/metrics")
def metrics():
    return Response(generate_latest(REGISTRY), media_type=CONTENT_TYPE_LATEST)


@app.get("/sites", dependencies=[Depends(auth)])
def sites():
    return list(SITES.values())


@app.post("/sites/{site_id}/probe", dependencies=[Depends(auth)])
def measure(site_id: str):
    site_name(site_id)
    with LOCK:
        try:
            return probe(site_id)
        except (RuntimeError, requests.RequestException, subprocess.TimeoutExpired) as error:
            raise HTTPException(503, "Real probe failed: " + type(error).__name__) from None


@app.post("/sites/{site_id}/candidates", dependencies=[Depends(auth)], status_code=201)
def propose(site_id: str, request: Candidate):
    site_name(site_id)
    with LOCK:
        intent = check_intent(site_id)
        before = ssh(site_id, False, "device", "inspect")
        job = {"id": str(uuid4()), "site": site_id, "action": request.action, "reason": request.reason,
               "state": "proposed", "created_at": stamp(), "expires_at": time.time() + 600,
               "before": before, "intent": intent, "events": [{"state": "proposed", "at": stamp()}]}
        save(job)
        return job


@app.get("/jobs/{job_id}", dependencies=[Depends(auth)])
def job(job_id: str):
    return get(job_id)


@app.post("/jobs/{job_id}/approve", dependencies=[Depends(auth)])
def approve(job_id: str, approval: Approval):
    with LOCK:
        job = get(job_id)
        if job["state"] != "proposed" or time.time() >= job["expires_at"]:
            raise HTTPException(409, "Only a current proposed job can be approved")
        job.update(state="approved", reviewer=approval.reviewer)
        job["events"].append({"state": "approved", "at": stamp(), "reviewer": approval.reviewer})
        save(job)
        return job


@app.post("/jobs/{job_id}/execute", dependencies=[Depends(auth)])
def execute(job_id: str):
    with LOCK:
        job = get(job_id)
        if job["state"] != "approved" or time.time() >= job["expires_at"]:
            raise HTTPException(409, "A current approval is required; completed jobs cannot execute again")
        current = ssh(job["site"], False, "device", "inspect")
        if current["hash"] != job["before"]["hash"] or current["qdisc"] != job["before"]["qdisc"]:
            raise HTTPException(409, "Router state changed; generate and review a new candidate")
        job["state"] = "executing"
        job["events"].append({"state": "executing", "at": stamp()})
        save(job)
        target = site_name(job["site"]) + "-router"
        inventory = {"all": {"children": {"lab_target": {"hosts": {job["site"]: {"ansible_host": target,
          "ansible_user": "root", "ansible_python_interpreter": "/usr/bin/python3",
          "ansible_ssh_private_key_file": "/tmp/strata_lab_identity",
          "ansible_ssh_common_args": f"-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile={EVIDENCE / 'known_hosts'}"}}}}}}
        import yaml
        inventory_path = EVIDENCE / f"inventory-{job['id']}.yml"
        inventory_path.write_text(yaml.safe_dump(inventory), encoding="utf-8")
        try:
            result = subprocess.run(["ansible-playbook", "-i", str(inventory_path), str(ROOT / "automation/change.yml"),
                "-e", json.dumps({"lab_approved": True, "lab_action": job["action"]})], capture_output=True, text=True, timeout=90)
            job["ansible"] = {"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}
            if result.returncode:
                raise RuntimeError("Ansible execution failed")
            job["after"] = ssh(job["site"], False, "device", "inspect")
            if job["action"] in ("prefer_backup", "restore_primary"):
                expected = "10.251.0.1" if job["action"] == "prefer_backup" else "10.250.0.1"
                deadline = time.monotonic() + 20
                while not any(route.get("gateway") == expected for route in job["after"]["forwarding"]):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("BGP forwarding did not converge to the reviewed path")
                    time.sleep(0.5)
                    job["after"] = ssh(job["site"], False, "device", "inspect")
            job["diff"] = "\n".join(difflib.unified_diff(job["before"]["configuration"].splitlines(), job["after"]["configuration"].splitlines(), fromfile="before", tofile="after"))
            # Verification uses three real measurements to reduce sensitivity to one dropped packet.
            observations = [probe(job["site"]) for _ in range(3)]
            job["verification"] = observations
            healthy = all(value["packet_loss_pct"] <= 5 and value["latency_ms"] is not None
                          and value["throughput_mbps"] is not None and value["throughput_mbps"] > 0 for value in observations)
            if job["action"] == "impair_primary":
                if not any(q.get("kind") == "netem" and q.get("handle") == "7a10:" for q in job["after"]["qdisc"]):
                    raise RuntimeError("The owned impairment qdisc was not observed")
                job["state"] = "experiment_applied"
            elif healthy:
                job["state"] = "verified"
            else:
                rollback = ("impair_primary" if any(qdisc.get("kind") == "netem" and qdisc.get("handle") == "7a10:"
                            for qdisc in job["before"]["qdisc"]) else "clear_impairment") if job["action"] == "clear_impairment" else (
                    "prefer_backup" if "set local-preference 200" in job["before"]["configuration"] else "restore_primary")
                ssh(job["site"], False, "device", rollback)
                job["rollback"] = {"action": rollback, "observations": [probe(job["site"])]}
                job["state"] = "rolled_back_needs_review"
        except (RuntimeError, subprocess.TimeoutExpired, requests.RequestException) as error:
            job.update(state="execution_failed_needs_review", error=type(error).__name__)
        job["events"].append({"state": job["state"], "at": stamp()})
        save(job)
        try:
            job["delivery"] = archive(job)
        except Exception as error:
            job["delivery"] = {"state": "delivery_failed", "error": type(error).__name__, "local_evidence_retained": True}
        save(job)
        return job
