# Strata Twin — owned telecom operations simulator

Strata Twin runs entirely in the browser as static assets on Vercel. It needs no Docker, VPS, provider keys or Hub login. The development laptop can be off after deployment. Each visitor owns an isolated browser-local run; the simulated clock advances on commands or during visible-browser playback. Leaving the lab or hiding the page pauses playback. There is no shared cloud database or unattended scheduler.

This is an executable behavioral model, not a 100% reproduction of the cataloged software. The UI labels every result as modeled. Real protocol implementations, device operating systems, vendor APIs and physical RF require their actual software/equipment. A 100% equivalence claim would be incorrect.

## Start and demonstrate

For an existing Python environment:

```powershell
node deploy/vercel/build.mjs
.\venv\Scripts\python.exe -m http.server 8083 --bind 127.0.0.1 --directory deploy\vercel\public
```

Open `http://127.0.0.1:8083/#twin`. The initial observation at T+1 is computed from declared topology, not random telemetry.

The main navigation has three entries: **Digital Twin**, **Live Operations** (Overview, Service health, Incidents, Assets), and **Workspace** (Connections, AI review, Settings). The public software catalog page has been removed. Old `/#ecosystem` links resolve to Twin.

The lab has six layers: Network, Site equipment, Scenarios, Operations, Changes and Evidence. **Site equipment** provides seven representative vendor routing profiles, 12 equipment roles, native config exports and separate commissioning arithmetic. See [configuration targets and boundaries](DEVICE_CONFIGURATION.md).

The workspace uses a carbon/steel palette, rounded grid panels, halftone surfaces, sticky layer navigation, animated dialogs and panel transitions. A loading screen reflects actual blueprint/replay initialization; summary skeletons cover pending data. Reduced motion disables the decorative transitions. Playback pauses when entering the equipment workbench, and unsaved numeric edits survive model-clock updates.

1. **Save checkpoint** before experimenting. Under **Scenarios**, load **Transport failover**. Press **Play** at 1× or 4×, or advance manually. The timeline applies primary failure after two ticks and restoration after twelve; routing observes link changes three ticks later. Presets append faults to the current state rather than resetting it.
2. Pause, choose a site with its primary preference still at baseline, then **Inject delay incident**. The model applies 120 ms, advances five ticks and confirms an incident.
3. Under **Changes**, choose **Prefer backup path** and **Preview impact**. Compare the next 12 ticks of baseline and candidate SLA, throughput and latency for all three sites. This detached branch uses the same scheduled faults, configuration convergence, verification and rollback rules. It does not create a current-run approval or apply configuration. Export the comparison if needed.
4. **Create candidate**, switch to **Reviewer**, inspect and approve. Close the dialog, switch to **Operator**, inspect and execute. Advance five ticks to inspect verification and incident recovery. Intended configuration remains separate until the Reviewer accepts verified intent.
5. Under **Operations**, stop Object store and advance: its offsets stay fixed while detection continues. Restore it and advance to drain the backlog. Invalid schemas go to per-group DLQ before source offsets commit; redelivery demonstrates effect deduplication.
6. Under **Network**, expand **Access & mobile sessions**. Request a lease, register `demo-1` with a slice and step twice. Choose another **Handover target**, then **Handover** in its row. There is a two-tick modeled interruption; successful handover preserves the PDU address and reallocates throughput at the destination.
7. Under **Evidence**, restore a saved checkpoint. The confirmation replaces the current run only after its replay validates. The four most recent checkpoints are retained; export any checkpoint to keep it independently.
8. **Export run** and **Replay file** to recompute every command and check its claimed final state. Version 1 files first pass the original v1 engine, then their commands are reinterpreted under v2 rules. The original v1 browser save is retained. A new v2 export records the resulting v2 state.

The **Network** latency/loss graphs and SLA window use the last 60 calculated ticks, including ticks when the broker is unavailable. Gaps indicate unavailable latency. These calculations are not measurements from equipment.

The actor selector is a demonstration of review rules, not secure multi-user authentication. Users can edit their local browser data. Replay detects disagreement between a command log and its claimed state, but does not authenticate who created the log or prevent a fully rewritten consistent log.

## Implemented contracts

| Domain | Model behavior | Boundary |
|---|---|---|
| Inventory/IPAM | Private non-overlapping prefixes, unique VLAN/ASN allocation, intent vs running revisions | Selected three-site design; no NetBox API/ORM |
| Routing | Primary preference 100, backup 80/200; usable route selection, failure hold delay, convergence | No complete BGP selection algorithm or protocol packets |
| Traffic | Link demand/capacity/loss, extra delay, shared core bottleneck | Fluid arithmetic, no TCP or packet scheduler |
| Access | 40-address DHCP pool, collision prevention, renewal/expiry, derived DNS label | No DHCP/DNS/RADIUS servers |
| Mobile | Subscriber allowlist, admission, registration, PDU IP, release, weighted slices, two-tick handover, source-cell fallback and capacity sharing | No 3GPP messages, cryptography, physical RF or MAC scheduling |
| Event stream | Three partitions, independent groups, pending outbox, retry, DLQ and event-ID dedup | No Kafka brokers, consensus, rebalance or wire protocol |
| Storage | Idempotent JSON objects and model object versions, availability failure | Browser-local state; no S3 protocol, erasure coding or Parquet |
| Monitoring | Three breaches confirm, two recoveries resolve; explicit missing latency for failed paths | Calculated metrics, no SNMP/PromQL or actual measurements |
| Changes | Independent modeled review, 60-tick expiry, context/revision guard, serial site execution, convergence/verification/rollback | No SSH/device execution; failed rollback recovery remains explicitly degraded |
| Evidence | Command log, audit transitions, observations, pending/acknowledged delivery, reproducible replay | Not authenticated or tamper-proof audit storage |

`lab/reference/twin-coverage.json` maps **all 50 catalog entries**: **25 selected contracts are modeled**, **23 are reference only**, and **2 are external AI providers**. Shared contracts represent operational roles; they are not 25 original software installations. The software catalog and coverage map are internal references excluded from the public deployment; see [the native software reference](LAB_REFERENCE.md). Twin never calls Groq/OpenAI or fabricates an AI response. Existing provider adapters remain in the separate real backend.

## Model rules

- One tick equals one simulated second. Link failures update routing knowledge after three ticks. A reviewed preference change converges after two ticks.
- Each primary has 250 Mbps capacity, backup 180 Mbps (350 after the allowed capacity change), and all sites share 500 Mbps core capacity.
- Base RTTs are 8/11/14 ms primary and 20/23/26 ms backup. Extra queue delay is `max(0, demand/capacity - 1) × 20 ms`.
- Per-site delivery before the core bottleneck is `min(demand, capacity) × (1 - linkLoss/100)`. If aggregate delivery exceeds 500 Mbps, all deliveries are scaled by `500/aggregate`.
- Modeled loss also includes excess demand and core overflow. These fluid loss assumptions are intentionally simple; they do not predict real TCP throughput.
- Path thresholds are availability, loss ≤5%, RTT ≤50 ms, and delivery ≥`min(100, demand × 0.95)` Mbps. Three post-convergence observations decide a change. Failed verification restores the baseline configuration, then collects two recovery observations. Restored configuration can still have a degraded path.
- Storage and detection groups commit independently after their own modeled effect. Schema 99 is deliberately invalid. Duplicate effects are suppressed by event ID; duplicate stream records are retained.
- DHCP addresses use hosts .10–.49 of each /24 and expire after 30 ticks. Subscribers demo-1…demo-6 use DNN internet. Broadband slice 1-000001 has a 25 Mbps cap/weight 1; Critical 1-000002 has a 10 Mbps cap/weight 3; IoT 1-000003 has a 2 Mbps cap/weight 1. Weighted max-min allocation redistributes unused capped shares within the smaller of 40 Mbps cell budget and transport delivery. Allocations are floored to 0.01 Mbps to avoid oversubscription. PDU addresses come from 10.45.0.x.
- Handover requires an active PDU, a different target cell and an available modeled core/target cell. It interrupts throughput until the second tick. A target-cell failure falls back to an available source cell; both-cell or core failure rejects the session. There is no RF measurement or real 3GPP handover signaling.
- Scheduled faults accept a 1–120 tick delay, at most 16 pending entries and the same bounded values as direct faults. Cancelling a pending entry does not undo applied faults. Scenario presets operate on the current world, so an existing preference change or impairment can alter the result.
- What-if uses a detached baseline and approved candidate branch, advancing each for 12 ticks by default. The reported job state covers the normal three-observation verification window; the longer comparison can still reveal later degradation. Preview is deterministic arithmetic, not an AI prediction or an approval.
- Checkpoints and run saves use browser storage. The four-checkpoint limit retains recent snapshots; quota failure is explicit and an in-memory checkpoint can still be exported. Restore confirms replacement and validates replay.
- Runs are bounded to 1,200 commands and 1,500 ticks. There is no silent history truncation. Export/reset when the limit is reached. Browser storage quotas vary; on save failure the UI says the run is in memory and should be exported.

The fixed topology and public subscriber IDs are declared scenario fixtures. Metrics and state transitions are derived from those inputs; they are never labeled as live equipment data.

## Export and extend

**Export FRR candidate** downloads a prefix-filtered configuration matching the isolated lab's two cores. It contains the modeled preference only; capacity, loss and delay are not FRR configuration. Review it against `lab/config/frr/` and the actual interfaces before lab execution. Export does not apply a change.

Verify a run without services:

```powershell
node scripts/replay_twin.cjs "$env:USERPROFILE\Downloads\strata-twin-run.json"
node --test tests/test_twin.cjs tests/test_device_configs.cjs tests/test_vercel.mjs
```

The v2 blueprint is `console/assets/twin-blueprint.json`; `twin-model-v1.js` exists only to verify legacy evidence.

The pure engine is `console/assets/twin-model.js`; rendering/persistence is `console/assets/twin.js`. Add behavior by defining a bounded command, transition rules, failure semantics, coverage boundary and scenario test. Keep model results separate from real Hub measurements.

For protocol comparison, use the optional [Docker lab definitions](EXECUTABLE_LAB.md). Those definitions have not been executed on this laptop. Until a real FRR/Open5GS/Kafka run supplies comparable observations, this model has no empirical equivalence validation.

## Deploy from this folder through Git remote

The repository is already initialized with origin pointing to `https://github.com/RobertinoGladden/aiops-telco.git`. No clone is required. Inspect what you are committing; `.env`, `lab/.env`, private SSH keys and runtime data must remain ignored.

```powershell
git status --short
git add README.md console deploy scripts tests docs lab Dockerfile docker-compose.yml .gitignore .dockerignore
git diff --cached --stat
git commit -m "Add Strata Twin operational simulator and optional lab definitions"
git push origin main
```

If push reports that remote main has newer commits, fetch and inspect them before integrating. Do not force push. See [the Git remote guide](GIT_REMOTE_QUICKSTART.md).

In Vercel, import the GitHub repository, select **Other**, set **Root Directory** to `deploy/vercel`, and enable **Include source files outside of the Root Directory in the Build Step**. The checked-in configuration sets build command `node build.mjs`, output `public`, and no install command. Leave backend/proxy environment variables empty for Twin; the simulator does not use them. Open the generated deployment's `/#twin` URL.

Vercel serves these static assets while your development laptop is off. This does not run a Kafka broker or persistent router daemon. Shared users, secure roles and unattended workflows need a separate durable backend design. Native [Vercel Functions have execution limits](https://vercel.com/docs/functions/limitations); a request handler is not a replacement for every long-running telecom process. Git integration is documented in [Vercel for GitHub](https://vercel.com/docs/git/vercel-for-github).
