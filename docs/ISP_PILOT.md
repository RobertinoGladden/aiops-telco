# Strata for ISP and network operations teams

**Positioning:** a unified operations workspace that connects your existing field tools, keeps incident evidence traceable, and makes AI recommendations reviewable.

Strata is suited to an engineering pilot with an ISP NOC, regional network operator, managed network service team, or an enterprise infrastructure team. It connects monitoring and inventory already used in operations rather than requiring their replacement. The application currently provides five configured adapter types and a common authenticated ingest contract for additional collectors.

## Demonstrate the operational value

| Operator problem | Implemented capability | Pilot evidence to collect |
|---|---|---|
| A device has different names across tools | NetBox context and explicit identity aliases | Match known devices across sources and review unmatched identities |
| Alerts arrive without enough context | Confirmed incidents, maintenance suppression, stored telemetry and transition history | Compare source events with the incident record |
| Pipeline failure looks like a quiet network | Current worker heartbeats, delivery retries, consumer lag, unknown-state handling | Stop a worker and verify an alert and visible degradation |
| AI recommendations lack accountability | Bounded evidence, typed actions, probabilities, model/stage audit, operator policy gates | Evaluate recommendations against labeled incident outcomes |
| Review requests are lost or duplicated | Persistent outbox, retry/backoff, receiver idempotency | Disconnect the receiver, reconnect, and confirm one accepted request |
| Lab demonstrations do not translate to field systems | GNS3/EVE-NG topology paired with real Zabbix/LibreNMS telemetry | Repeat a measured impairment on an approved lab interface |

No uptime, time-saving percentage, or remediation success rate is claimed before measurement. Empty UI states represent missing telemetry and are useful readiness indicators during onboarding.

## Run a scoped customer pilot

1. Select one region or lab segment, its owner, and a small set of known devices. Configure source aliases and maintenance windows.
2. Connect NetBox plus one monitoring source. Connect a network lab when evaluating topology-dependent recommendations. Validate credentials, units, timestamps, and the observed inventory against the vendor UI.
3. Start the full stack in field mode with `./start.ps1 -Mode field`. Verify both workers, topic lag, MinIO writes, and replay behavior in Operations and Grafana.
4. Reproduce approved scenarios: latency, packet loss, maintenance, worker outage, malformed telemetry, and receiver outage. Record detection and recovery timing from actual observations.
5. Enable approved AI credentials. Compare allowed recommendations, evidence completeness, confidence, and review eligibility against labeled cases. Calibrate thresholds before increasing scope.
6. Connect your review endpoint. Test idempotency, operator approval, prechecks, rollback, execution reporting, and post-action telemetry in that workflow.
7. Export operational snapshots and decision audits for the pilot review. Keep a written acceptance decision based on the measurements below.

## Measure acceptance

- **Coverage:** configured versus healthy collectors; matched versus unmatched device identities; expected versus observed telemetry fields.
- **Freshness:** source observation age, worker heartbeat age, and collection gaps.
- **Pipeline reliability:** consumer lag, persisted event counts, quarantine volume, delivery backlog age, and successful replay after interruptions.
- **Incident quality:** detection delay, duplicate transitions, maintenance behavior, false positives, and confirmed recovery delay.
- **Decision quality:** actionable recommendations, unsupported hypotheses, provider failures, gate rejections, calibrated confidence, and operator acceptance.
- **Operating cost:** provider-reported token usage, daily request count, infrastructure consumption, and measured engineering effort.

Set numeric acceptance targets with the customer before running the pilot. Current UI regional counts are an observed inventory footprint; they are not customer service availability or SLA compliance.

## Before a commercial production rollout

The current implementation is a single-broker, single-Hub lab/pilot stack. A production offering needs operator SSO/RBAC, tenant isolation where relevant, HA storage and messaging, backup/restore exercises, retention policies, managed secrets, deployment upgrades, capacity testing, and contractual support/SLOs. Customer service-to-device mapping and contractual SLA calculation are not implemented yet.

Prioritize these against measured pilot requirements. The brand and logo are project assets, without any claim of trademark or domain availability.
