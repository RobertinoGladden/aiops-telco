"""SQLite transactions keep ingestion, incident state and outbound delivery durable."""
import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from aiops.contracts import Detection, fingerprint, utcnow


class StateStore:
    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = str(path)
        self.lock = threading.RLock()
        with self.transaction() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, data TEXT NOT NULL, observed_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS seen (event_id TEXT PRIMARY KEY);
                CREATE TABLE IF NOT EXISTS ai_runs (
                    id TEXT PRIMARY KEY, incident_id TEXT NOT NULL, evidence_hash TEXT NOT NULL,
                    created_at TEXT NOT NULL, data TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS ai_runs_incident ON ai_runs(incident_id, created_at);
                CREATE TABLE IF NOT EXISTS incidents (key TEXT PRIMARY KEY, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS incident_history (
                    incident_id TEXT NOT NULL, version INTEGER NOT NULL, data TEXT NOT NULL,
                    PRIMARY KEY (incident_id, version));
                CREATE TABLE IF NOT EXISTS outbox (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
                    kind TEXT NOT NULL, destination TEXT NOT NULL, data TEXT NOT NULL,
                    state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
                    next_attempt REAL NOT NULL DEFAULT 0, last_error TEXT);
            """)
            columns = {row["name"] for row in db.execute("PRAGMA table_info(outbox)")}
            for column in ("created_at", "delivered_at"):
                if column not in columns:
                    db.execute(f"ALTER TABLE outbox ADD COLUMN {column} TEXT")

    @contextmanager
    def transaction(self):
        with self.lock:
            db = sqlite3.connect(self.path, timeout=15)
            db.row_factory = sqlite3.Row
            try:
                with db:
                    yield db
            finally:
                db.close()

    def snapshot(self, key, data):
        with self.transaction() as db:
            db.execute("INSERT OR REPLACE INTO snapshots VALUES (?,?,?)", (key, json.dumps(data), utcnow()))

    def snapshots(self, prefix):
        with self.transaction() as db:
            return {row["key"][len(prefix):]: {"data": json.loads(row["data"]), "observed_at": row["observed_at"]}
                    for row in db.execute("SELECT * FROM snapshots WHERE key LIKE ?", (prefix + "%",))}

    @staticmethod
    def _enqueue(db, event_id, kind, destination, data):
        cursor = db.execute("INSERT OR IGNORE INTO outbox (event_id,kind,destination,data,created_at) VALUES (?,?,?,?,?)",
                            (event_id, kind, destination, json.dumps(data), utcnow()))
        return cursor.rowcount == 1

    def enqueue(self, event_id, kind, destination, data):
        with self.transaction() as db:
            return self._enqueue(db, event_id, kind, destination, data)

    def pending(self, limit=100):
        with self.transaction() as db:
            return [dict(row) for row in db.execute("SELECT * FROM outbox WHERE state='pending' AND next_attempt<=? ORDER BY id LIMIT ?", (time.time(), limit))]

    def delivered(self, row_id):
        with self.transaction() as db:
            db.execute("UPDATE outbox SET state='sent',last_error=NULL,delivered_at=? WHERE id=?", (utcnow(), row_id))

    def failed(self, row_id, error):
        with self.transaction() as db:
            row = db.execute("SELECT attempts FROM outbox WHERE id=?", (row_id,)).fetchone()
            attempts = row["attempts"] + 1
            db.execute("UPDATE outbox SET attempts=?,last_error=?,next_attempt=? WHERE id=?",
                       (attempts, type(error).__name__, time.time() + min(300, 2 ** min(attempts, 8)), row_id))

    def delivery_counts(self):
        with self.transaction() as db:
            return {row["state"]: row["count"] for row in db.execute("SELECT state,COUNT(*) AS count FROM outbox GROUP BY state")}

    def operational_summary(self):
        """Bounded metadata only: no workflow URLs, credentials or payloads."""
        with self.transaction() as db:
            rows = [dict(row) for row in db.execute(
                "SELECT id,event_id,kind,state,attempts,next_attempt,last_error,created_at,delivered_at "
                "FROM outbox ORDER BY id DESC LIMIT 100")]
            counts = {row["state"]: row["count"] for row in db.execute("SELECT state,COUNT(*) AS count FROM outbox GROUP BY state")}
            oldest = db.execute("SELECT MIN(created_at) FROM outbox WHERE state='pending'").fetchone()[0]
            retrying = db.execute("SELECT COUNT(*) FROM outbox WHERE state='pending' AND attempts>0").fetchone()[0]
            today = [json.loads(row[0]) for row in db.execute("SELECT data FROM ai_runs WHERE created_at>=?", (utcnow()[:10],))]
            return {"delivery": {"pending": counts.get("pending", 0), "sent": counts.get("sent", 0),
                                 "retrying": retrying, "oldest_pending_at": oldest, "recent": rows},
                    "ai": {"runs_today": len(today), "ready_today": sum(row["status"] == "ready" for row in today),
                           "failed_today": sum(row["status"] == "failed" for row in today),
                           "running_today": sum(row["status"] == "running" for row in today)}}

    def incidents(self):
        with self.transaction() as db:
            return [json.loads(row["data"]) for row in db.execute("SELECT data FROM incidents ORDER BY key")]

    def incident_history(self, incident_id):
        with self.transaction() as db:
            return [json.loads(row["data"]) for row in db.execute(
                "SELECT data FROM incident_history WHERE incident_id=? ORDER BY version", (incident_id,))]

    def ai_runs(self, limit=100):
        with self.transaction() as db:
            return [json.loads(row["data"]) for row in db.execute(
                "SELECT data FROM ai_runs ORDER BY created_at DESC LIMIT ?", (limit,))]

    def ai_run(self, run_id):
        with self.transaction() as db:
            row = db.execute("SELECT data FROM ai_runs WHERE id=?", (run_id,)).fetchone()
            return json.loads(row["data"]) if row else None

    def reserve_ai_run(self, run, max_daily, cooldown):
        """Reserve before paying providers; the transaction enforces the shared quota."""
        from datetime import datetime, timezone
        with self.transaction() as db:
            db.execute("BEGIN IMMEDIATE")
            previous = db.execute("SELECT * FROM ai_runs WHERE incident_id=? ORDER BY created_at DESC LIMIT 1",
                                  (run["incident_id"],)).fetchone()
            if previous:
                saved = json.loads(previous["data"])
                if saved["evidence_hash"] == run["evidence_hash"] and saved["status"] == "ready":
                    return saved
                age = (datetime.now(timezone.utc) - datetime.fromisoformat(previous["created_at"])).total_seconds()
                if age < cooldown:
                    raise ValueError("cooldown")
            count = db.execute("SELECT COUNT(*) FROM ai_runs WHERE created_at>=?", (utcnow()[:10],)).fetchone()[0]
            if count >= max_daily:
                raise ValueError("daily_limit")
            db.execute("INSERT INTO ai_runs VALUES (?,?,?,?,?)", (run["id"], run["incident_id"], run["evidence_hash"],
                       run["created_at"], json.dumps(run)))
            return run

    def finish_ai_run(self, run):
        with self.transaction() as db:
            db.execute("UPDATE ai_runs SET data=? WHERE id=?", (json.dumps(run), run["id"]))

    def approve_ai_review(self, run_id, destination, validate):
        """Recheck the latest incident and atomically queue one review per decision."""
        with self.transaction() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM ai_runs WHERE id=?", (run_id,)).fetchone()
            if not row:
                raise KeyError(run_id)
            run = json.loads(row["data"])
            incident = next((json.loads(row["data"]) for row in db.execute("SELECT data FROM incidents")
                             if json.loads(row["data"])["incident_id"] == run["incident_id"]), None)
            validate(run, incident)
            if run.get("review_status") == "queued":
                return run
            payload = {"decision_id": run_id, "incident_id": run["incident_id"],
                       "incident_version": run["incident_version"], "device_id": run["device_id"],
                       "action": run["decision"]["action"], "analysis": run["analysis"],
                       "decision": run["decision"], "action_mode": "request_review", "execution_status": "not_executed"}
            self._enqueue(db, f"ai-review:{run_id}", "workflow", destination, payload)
            run.update(review_status="queued", reviewed_at=utcnow())
            db.execute("UPDATE ai_runs SET data=? WHERE id=?", (json.dumps(run), run_id))
            return run

    def observe(self, detection: Detection, confirmations=3, recovery_confirmations=3, maintenance=False, workflow_url=""):
        event = detection.model_dump(mode="json")
        key = f"{detection.source}:{detection.device_id}"
        with self.transaction() as db:
            if not db.execute("INSERT OR IGNORE INTO seen VALUES (?)", (f"{detection.source}:{detection.event_id}",)).rowcount:
                return {"duplicate": True}
            if detection.severity == "unknown":
                return {"ignored": "insufficient_telemetry"}
            row = db.execute("SELECT data FROM incidents WHERE key=?", (key,)).fetchone()
            incident = json.loads(row["data"]) if row else {
                "incident_id": fingerprint({"key": key}), "device_id": detection.device_id,
                "source": detection.source, "state": "observing", "streak": 0,
                "recovery_streak": 0, "version": 0, "opened_at": None,
            }
            if incident.get("timestamp", "") > event["timestamp"]:
                return {"ignored": "out_of_order"}
            if incident["state"] == "open" and detection.severity == "normal":
                previous_metrics = incident.get("evidence", {}).get("telemetry", {})
                current_metrics = detection.evidence.get("telemetry", {})
                missing = [key for key in ("latency_ms", "packet_loss_pct", "cpu_usage_pct")
                           if previous_metrics.get(key) is not None and current_metrics.get(key) is None]
                if missing or incident.get("method") != detection.method:
                    return {"ignored": "insufficient_recovery_evidence"}
            previous_state = incident["state"]
            previous_severity = incident.get("severity")
            incident.update({k: event[k] for k in ("timestamp", "severity", "summary", "evidence", "suggested_actions", "region", "method")})
            if maintenance:
                incident.update(state="suppressed", streak=0, recovery_streak=0)
            elif detection.severity == "normal":
                incident["streak"] = 0
                incident["recovery_streak"] += 1
                if previous_state == "open" and incident["recovery_streak"] >= recovery_confirmations:
                    incident["state"] = "resolved"
                elif previous_state != "open":
                    incident["state"] = "observing" if previous_state != "resolved" else "resolved"
                else:
                    # Preserve active severity until recovery is confirmed.
                    incident["severity"] = previous_severity
            else:
                incident["recovery_streak"] = 0
                incident["streak"] += 1
                if previous_state == "open" or incident["streak"] >= confirmations:
                    incident["state"] = "open"
                    if previous_state != "open":
                        incident["opened_at"] = utcnow()
                else:
                    incident["state"] = "observing"
            changed = (incident["state"] != previous_state or
                       (incident["state"] == "open" and previous_severity != incident["severity"]))
            if changed:
                incident["version"] += 1
                incident["updated_at"] = utcnow()
                db.execute("INSERT INTO incident_history VALUES (?,?,?)",
                           (incident["incident_id"], incident["version"], json.dumps(incident)))
                # Maintenance still updates local state, but creates no external action.
                if workflow_url and incident["state"] in ("open", "resolved"):
                    self._enqueue(db, f"workflow:{incident['incident_id']}:{incident['version']}", "workflow", workflow_url,
                                  {**incident, "action_mode": "request_review", "execution_status": "not_executed"})
            db.execute("INSERT OR REPLACE INTO incidents VALUES (?,?)", (key, json.dumps(incident)))
            return incident
