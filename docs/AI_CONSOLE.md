# Strata — network intelligence & operations

Strata brings field integrations, incident evidence, processing health, and AI decision audits into one English-language operations console. The layered network mark represents the path from network infrastructure through telemetry to operational decisions. The interface uses carbon surfaces, steel accents, orbital halftone, responsive layouts, animated dialogs, and reduced-motion support.

## Run the console

For the complete stack, run `./start.ps1` and open http://localhost:8082/. The console ships inside the Integration Hub image.

For the console and collectors on your Python host:

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements.txt
.\console.ps1
```

Sign in using `INTEGRATION_API_TOKEN` from your server `.env`. The browser holds this token in tab memory, clears it on disconnect, and loses it on reload. Data endpoints and mutations require the Bearer token. Provider keys stay on the server. The current shared token does not provide operator identities, RBAC, or tenant isolation; a customer deployment needs those controls and HTTPS.

Collectors follow their `*_ENABLED` configuration. Running the console alone does not start Kafka, MinIO, or vendor software. If Compose already owns port 8082, use that Hub or select `./console.ps1 -Port 8083`. Avoid collecting twice from the same targets.

## Monitor operations

| View | Operational coverage |
|---|---|
| Overview | Five collectors, unique observed devices, open incidents, outbox, platform probes, setup checklist |
| Integrations | Enabled state, collection errors, sample counts, last observation, connection configuration |
| Operations | Ten service probes, worker heartbeats/counters, Kafka consumer lag, dead-letter offsets, firing alerts, AI daily usage, regional footprint, delivery ledger |
| Incidents | Status filters, severity, source, evidence, persistent transition history |
| AI decision desk | Provider configuration, on-demand analysis, confidence, probabilities, policy gates, provider errors, durable audit export |
| Devices & topology | Source inventories, shared identities, maintenance, actual GNS3 links and EVE-NG network segments |

The UI refreshes every 10 seconds while visible. Service probes are cached for 30 seconds, run concurrently, and use 2-second request timeouts. Collector freshness beyond `max(90, poll_interval * 3)` seconds is stale. A failed refresh preserves the last snapshot and displays a warning.

Storage and detection workers expose Prometheus metrics on ports 9101 and 9102. A current heartbeat requires a completed poll or processing cycle within 90 seconds. Valid-event and quarantine counts advance after durable acknowledgement. The detection worker reports acknowledged rule fallbacks when ML is unavailable. Worker counters reset on process restart; Prometheus retains their history.

Kafka TCP reachability is distinct from broker readiness. Consumer lag and dead-letter offsets come from the Kafka exporter through Prometheus and require a successful exporter scrape. Missing series remain unknown. The dead-letter offset is the topic's reported cumulative write offset, not an unread-message count. MinIO probes storage readiness; they do not verify an individual object write. The model probe reports the loaded model, features, and available training metadata. Airflow health requires its database and scheduler to be healthy. Airflow is optional and must be configured separately:

```dotenv
AIRFLOW_URL=http://airflow-webserver:8080
```

Use `http://127.0.0.1:8080` for a host-run Hub. Actual Airflow DAG/task history remains in Airflow, and historical model evaluations remain in MLflow.

The delivery ledger shows the latest 100 event records without destination URLs or payloads. New events record creation and acknowledgement timestamps. Legacy events retain unknown timestamps. Retry metadata includes attempts, scheduled backoff, and error class. Export snapshot downloads observed operational metadata; Export audit downloads the latest 100 decision records. Exports contain operational identifiers and should follow your workspace's data policy.

## Enable AI

```dotenv
AI_ENABLED=true
GROQ_API_KEY=...
GROQ_MODEL=openai/gpt-oss-20b
OPENAI_API_KEY=...
DECISION_MODEL=gpt-6-luna
AI_TIMEOUT_SECONDS=20
AI_MAX_RUNS_PER_DAY=50
AI_COOLDOWN_SECONDS=30
AI_MAX_EVIDENCE_AGE_SECONDS=300
AI_MIN_CONFIDENCE=0.85
```

Restart the host Hub after changing configuration. With Compose, run `docker compose up -d --build integration-hub`; a plain restart does not replace container environment values.

Groq uses [Structured Outputs](https://console.groq.com/docs/structured-outputs). The decision adapter uses the [OpenAI Decisions API](https://developers.openai.com/api/docs/guides/decisions), `POST /v1/decisions`, with `gpt-6-luna`, following the documentation checked on 11 October 2026.

In AI decision desk, select an open incident and choose Analyze with AI. This sends selected incident facts to both providers and may incur provider charges. Dashboard refreshes never trigger AI requests. Configured credentials are not proof of model access; access is established by the actual request.

Sent facts include bounded device/source identifiers, observation time, severity, numeric measured telemetry, selected monitoring labels, maintenance context, and topology availability. Free-form incident summaries, telemetry metadata, management IPs, connector configuration, secrets, and full inventories are excluded. Provider instructions treat facts and advisory text as untrusted input. Device identifiers and regions may still contain operational information.

Groq returns an English summary, a cause hypothesis, supporting evidence, missing evidence, an allowed action, and rationale. Decisions answers two named questions:

- `next_action`: one of `observe`, `collect_diagnostics`, `escalate_noc`, `review_failover`, or `review_capacity`.
- `evidence_sufficient`: a predicate with probability between 0 and 1.

The server validates named answers, types, allowed choices, confidence, complete probability distributions, finite ranges, and refusals. AI output never supplies executable commands.

## Review and delivery

Review requires an open incident, measured evidence within the configured age limit, no maintenance, and confidence/evidence probability at or above the threshold. Observation alone does not queue a workflow. Failover review also requires current device topology and measured latency of at least 100 ms or packet loss of at least 5%. The default 0.85 threshold needs calibration against labeled field incidents.

Each audit stores models, stage, timestamps, usage, latency, incident version, evidence hash, decision, policy, and review state. A new observation changes the evidence hash even when the incident transition version stays the same. The overview re-evaluates policy using current evidence; submission rechecks it inside a SQLite transaction.

Provider errors, refusals, invalid responses, and timeouts close the review gate. Error classes are stored without provider response bodies or credentials. Identical ready evidence reuses its audit. Cooldown and daily quotas persist across restarts. The daily limit counts analysis attempts, including failures; each attempt calls Groq and OpenAI at most once. It limits request count rather than currency spend. An interrupted running record remains visible and may be retried after cooldown.

```dotenv
WORKFLOW_ENABLED=true
WORKFLOW_WEBHOOK_URL=https://operations.example/review
WORKFLOW_WEBHOOK_TOKEN=...
```

Submit review request queues `action_mode=request_review`, `execution_status=not_executed`, and `Idempotency-Key=ai-review:<decision_id>`. The receiver must deduplicate, implement approval and runbooks, and report outcomes. Existing incident-transition workflows use `workflow:<incident_id>:<version>`. Destination acknowledgement confirms delivery; fresh telemetry and incident recovery confirm the network outcome.

## API and verification

| Endpoint | Purpose |
|---|---|
| `GET /console/overview` | Authenticated console snapshot and operational metadata |
| `GET /ai/status` | Configuration presence and policy limits without secrets |
| `GET /ai/decisions` | Latest 100 decision audits |
| `POST /incidents/{id}/analyze` | On-demand analysis with cache, cooldown, and quota |
| `POST /ai/decisions/{id}/request-review` | Transactional policy recheck and idempotent enqueue |

```powershell
.\venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\venv\Scripts\python.exe -m unittest discover -s tests -v
```

Tests cover provider contracts, secret exclusion, review gates, persistent quotas/audits, worker acknowledgement ordering, stale health, missing metrics, and legacy delivery migration. Vendor endpoints and actual provider access require field validation. See [the ISP pilot guide](ISP_PILOT.md) for a measurable customer evaluation.
