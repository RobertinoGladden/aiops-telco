# Validation evidence — 11 October 2026

## Current monitoring dashboard redesign

**8/8 new monitoring projection tests passed.** They check missing observations, aggregate throughput and shared capacity, radio failure with working transport, finite emergency-power warnings, lost telemetry before alarms arrive, actual 60/120/300-tick windows, worst-condition heatmap aggregation, and read-only briefs preserving replay and review evidence. The existing model and real backend were not changed or rerun for this UI redesign.

Browser checks covered top navigation without a sidebar, AI decision-desk access with explicit Hub-offline state, time-range changes, radio-case injection, broker outage/outbox growth, evidence modal opening and keyboard Escape, device panels, and checkpoint restore. The original T+12 run was restored after UI fault testing. No browser warnings/errors or duplicate DOM IDs were observed.

At 1440 px, traffic/copilot panel heights matched at 298.78 px; health/capacity/pipeline matched at 340.80 px. The two equipment panels matched at 1006.73 px. At 375 px, document client and scroll widths both measured 360 px; the 700 px health map scrolls within its panel. The open context modal was 326 px wide and fit the viewport. Temporary viewport settings were reset.

Repository and standalone Vercel builds succeeded with the new dashboard CSS and monitoring module. JavaScript syntax checks passed. See [dashboard overview](assets/strata-monitoring-dashboard.jpg) and [radio plus broker fault monitoring](assets/strata-monitoring-fault.jpg). The brief is deterministic model context; real Groq/OpenAI calls were not executed. No Git push or online publication was performed. Workspace environment files and values were not opened.

## Earlier v3 fleet upgrade

**49 model/config Node tests and two native mobile YAML contract tests passed.** The Node suite covers the preserved 28 transport/mobile/event contracts, 15 engineering cases/journal/campaign contracts, and six device/config checks. The campaign test was corrected to reference the newly generated proposal ID after intentionally omitting a probe; the corrected failure-gate test passed. The unmodified backend/provider/proxy suite was not rerun in this upgrade.

The deterministic public campaign injects six concurrent cases at six regional origins, records seven probes, reviews a nine-site patch bundle with regional/core capacity changes, and verifies all 24 sites. Its 19 commands reproduce six solved cases at T+12, 289 stored model objects and zero consumer lag. The CLI replay and actual browser replay/reload both verified. Naive MTU failover, timing-only recovery and a partial capacity plan are separately tested to fail verification and roll back; completed field work remains recorded. Current-context and expired diagnostic evidence are rejected.

Desktop DOM measurements confirmed equal paired panel heights: network 542.64 px at 1440 px width (548.73 px at 1920 px), equipment 1039.08 px, and six engineering cards 269.17 px. At 375 px, Fleet, Equipment and Cases each had matching 360 px client/scroll widths. The mobile layer menu uses a three-column grid; the review modal fits the viewport and keyboard Escape closes it. Browser logs showed no observed errors. See [fleet monitoring](assets/strata-fleet-v3.jpg), [case investigations](assets/strata-cases-v3.jpg), and [aligned equipment panels](assets/strata-equipment-v3.jpg).

Compact command journals replace repeated full telemetry copies in browser storage/checkpoints. The public pack now contains 183 explicitly selected files: 168 routing fragments for seven profiles across 24 sites, plus 15 native reference/manifest files. File contents and SHA-256 hashes passed integrity checks. The optional native Docker topology remains three sites; additional exported fragments require native provisioning/interface mapping. No native daemon or physical/vendor device was executed.

Repository and standalone Vercel builds succeeded with the v3 engine, frozen v1/v2 validators, engineering module, 24-site blueprint and reproducible solved example. No Git push or online deployment was performed. Workspace environment files/values were not opened. Earlier validation below is historical evidence, not a new execution of the real backend.

## Earlier three-site Twin and native lab validation

**41/41 Node tests passed: 28 Twin model tests, 6 device/config tests and 7 Vercel proxy tests.** Coverage includes private allocations, shared capacity, delayed convergence, independent review, stale/expired approvals, verification/rollback, outbox retry, consumer offsets/DLQ/deduplication, DHCP, subscriber admission, weighted slices, handover interruption/fallback, fault schedules, detached what-if branches, checkpoints, legacy migration and strict replay. Configuration tests verify seven bounded routing profiles, unsafe-input rejection, commissioning arithmetic and the SHA-256 integrity of 36 explicitly selected public config files. All 50 catalog references retain explicit boundaries (25 selected modeled contracts, 23 reference-only and 2 external providers) in internal lab references.

The original seven-command T+11 run reproduced exactly through `scripts/replay_twin.cjs`. The expanded browser run reached T+43 with 35 commands and three verified modeled changes; reload recomputed and verified the stored state. Browser controls exercised scheduled failure/recovery, 4× playback and automatic pause on leaving the lab, what-if comparisons without current-run mutation, checkpoint restore, slice admission, two-tick handover preserving the PDU address, and the equipment studio's typed-intent → independent review → execution → verification workflow. Earlier controls covered offset retention/recovery, invalid-schema DLQ and DHCP/PDU state. Results are calculated model behavior, not equipment measurements.

Browser checks confirmed all seven profile previews, commissioning distance changes (+6.02 dB free-space loss on doubling distance), empty-input rejection, draft retention across site/clock changes and saved-plan persistence. Layouts at 1440px and 375px were inspected; the mobile document had equal 360px client/scroll widths on Network and Site equipment. Loading completion, panel navigation, dialog closing, keyboard dismissal and the final reload produced no observed browser console errors. The normal viewport was restored. See [workspace preview](assets/strata-studio.jpg) and [equipment editor](assets/strata-equipment.jpg).

Export handlers prepared config text/JSON and displayed their completion status. Saving the newly generated downloads to disk was not observed in the in-app browser. The checked-in native files and public JSON pack are present and integrity-checked; this browser limitation is not evidence of native device execution.

**Two native mobile configuration tests passed.** They verify reproducible AMF/SMF/UPF YAML and matching PLMN, TAC, NGAP/PFCP bindings, UE subnet/gateway, DNN, slice and public test subscriber key across Open5GS/UERANSIM fixtures. Python compilation passed. These are static contract checks; no native parser/daemon or vendor CLI was exercised.

Both repository and standalone Vercel builds include the new simulator/studio assets and regenerate the explicit public config pack with Node.js. Obsolete public Ecosystem assets are removed from builds. The source export excludes lab environment credentials and runtime SSH keys. No Git push or Vercel publication was performed.

Optional `lab/compose.yml` and the root Compose pass all-profile `config --quiet` with the checksum-verified official Compose v5.6.0 executable. Native config generation and Python compilation pass; `scripts.lab doctor` explicitly reports Docker CLI absent. No images were built or containers started. Native FRR, NetBox, Ansible, Kafka/MinIO and Open5GS/UERANSIM interoperability remains unverified. See [the optional lab guide](EXECUTABLE_LAB.md).

## Existing real-stack validation

**65 unittest cases passed** in the project's Python 3.10 virtual environment. Coverage includes all five adapter fixtures, authentication, telemetry validation, causal features, chronological evaluation, actual scikit-learn inference, persistent incident history, maintenance, recovery, ingestion deduplication, Parquet storage, Kafka acknowledgement ordering, provider contracts, AI review gates, quota/cache persistence, delivery migration and online origin access.

**7 Node.js proxy tests passed.** They verify pre-forward operator authentication, route/method restrictions, server-side credential separation, redirect/non-JSON rejection, sanitized upstream failures, mutation payload rejection, and closed behavior for incomplete or unsafe deployment settings. The Vercel package contains only public console assets, the bounded proxy and its configuration. Publication remains unverified: the local Vercel CLI has no authenticated account.

The Vercel configuration passes validation against the published configuration constraints using a Draft 7 validator. The upstream schema labels itself Draft 4 while including newer schema constructs; its Draft 4 meta-schema self-check does not pass. Native Vercel build/deployment validation remains pending account authentication.

Online origin tests use actual RSA-signed JWTs and reject wrong signatures, algorithms, issuer/audience, expiry and missing required claims. They confirm that a Hub token alone cannot access the online console, that private worker/probe routes remain usable internally, that docs are disabled in online mode and that identity-provider failures do not grant access. The online Compose merge passed all-profile validation with official checksum-verified Compose v5.6.0 and no published host ports. A subsequent container UID/GID setting for tunnel-secret readability received YAML/reference validation; no Docker containers were started.

Operational monitoring tests verify:

- An HTTP 200 alone does not make a worker healthy; its heartbeat must be current.
- Worker processed counts advance only after durable acknowledgements.
- Missing Prometheus series and failed probes remain unknown rather than zero.
- Consumer lag uses real group names and an active Kafka-exporter scrape.
- Airflow needs both scheduler and database health.
- Model probes expose selected training metadata without arbitrary fields.
- Legacy outbox records retain unknown timestamps; new events record creation and delivery.
- Error metadata and operational ledgers omit credentials, destination URLs, and payloads.
- Failed collection attempts do not claim successful data observations.
- Prometheus connector health expires with data freshness.

The updated root Compose passes the official compose-spec draft 2020-12 JSON Schema. Monitoring YAML, service dependencies, Python compilation, JavaScript syntax, and PowerShell parsing also pass. The earlier full-stack configuration passed `docker compose config --quiet` across all profiles using the checksum-verified official Compose v5.6.0 binary; the current worker-monitoring additions received schema and reference validation.

Browser verification used the actual local Hub plus an isolated temporary QA workspace. It covered English navigation, actual unavailable/disabled states, desktop and 390px mobile layouts without document overflow, modal opening/closing and keyboard dismissal, populated regional and delivery views, incident evidence, AI probability meters, review-disabled states, cross-source inventory, GNS3 port 0 rendering, and downloaded operational/audit JSON. The temporary QA database never populated the real workspace. No browser console errors were observed during these checks.

Screenshots show the actual workspace in [Overview](assets/strata-overview.jpg) and [Operations](assets/strata-operations.jpg). Unavailable services and empty inventories reflect the current local environment.

Docker Engine was unavailable. Image builds, live container startup, actual Prometheus scrapes, Grafana provisioning, scheduled Airflow DAG runs, router-side Ansible execution, and vendor connectivity were not tested live. AI credentials were not supplied; Groq and OpenAI responses were mocked in tests, so real provider/model access remains unverified.

Use `start.ps1` for the full stack or `console.ps1` for the host console. Follow [the console guide](AI_CONSOLE.md) and [ISP pilot guide](ISP_PILOT.md) to validate a configured deployment against measured field outcomes.
