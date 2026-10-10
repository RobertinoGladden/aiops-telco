# Validation evidence — 11 October 2026

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
