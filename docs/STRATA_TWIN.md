# Strata Twin — multi-region engineering lab

Strata runs as static browser assets on Vercel. No Docker, VPS, provider key or Hub login is required for Twin. Each visitor has an isolated local run; playback pauses when the browser is hidden or the lab is left. Live Operations remains a separate Hub integration.

The v3 fleet contains **24 sites across Jakarta, Bandung, Surabaya, Medan, Denpasar and Makassar**. Every site has private management/service prefixes, distinct VLANs/ASN, primary/backup routing, service telemetry and modeled radio/power dependencies. Results are calculated behavior, not measurements or complete vendor/protocol emulation.

## Start

```powershell
node deploy/vercel/build.mjs
.\venv\Scripts\python.exe -m http.server 8083 --bind 127.0.0.1 --directory deploy\vercel\public
```

Open `http://127.0.0.1:8083/#twin`. The first observation is calculated at T+1.

The six lab layers are **Fleet monitor**, **Site equipment**, **Engineering cases**, **Operations**, **Changes** and **Evidence**. Fleet monitoring uses six regional groups with compact site tiles, filters and an expandable telemetry ledger. Network and equipment panels stretch to equal heights within each desktop row. The carbon/steel palette, rounded borders, halftone, loading/skeleton states, dialog animation and reduced-motion support remain consistent.

## Demonstrate an engineering investigation

1. Save a checkpoint. Open **Engineering cases**, select **The green-link blackhole** and inject it. The UI observes one tick and opens the fleet investigation.
2. Inspect the latency and the MTU hypothesis. Collect a **Path MTU / packet-size test**. It records both link state and packet/backup-MTU constraints against the current site configuration and fault context.
3. To demonstrate a wrong fix, propose **Prefer backup path** in Changes. Review independently, execute as Operator and advance eight ticks. Large packets fail despite up interfaces. Three failed verification samples trigger rollback; recovery still reports the delayed primary as degraded.
4. Collect a fresh MTU probe, stage **MTU-safe backup failover**, then preview. Create the candidate, open its detail dialog, use Reviewer to approve and Operator to execute. These are explicitly modeled roles, not secure authentication.
5. Advance six ticks. The change passes three observations after convergence; the case requires diagnostics, a verified change and three stable scoped service/visibility observations before reporting solved.
6. Export the **resolution dossier** for probes, patches, resource budgets, scope observations, rollback and case history. Export the **run journal** for exact command reproduction. Evidence also supports four replay-validated checkpoints.

Cases append faults to the current world. They do not reset unrelated faults. Use a checkpoint or reset before isolated demonstrations; compound cases can prevent an otherwise reasonable fix from verifying.

| Case | Coupled symptoms | Investigation / recovery |
|---|---|---|
| Green-link blackhole | Delayed primary; backup is up but has smaller MTU and blocked PMTUD | MTU probe, size mitigation plus preference change |
| A bottleneck that moves | Four regional sites surge; access, aggregation and core constrain delivery; other regions lose traffic | Queue probe; edit access, regional and core budgets; verify all 24 sites |
| Transport healthy, radio degraded | PTP holdover exceeds lab tolerance while feeder VSWR also degrades radio | Timing and RF probes; alternate clock plus modeled feeder work order. Clock alone fails |
| Interfaces up, routing exhausted | Policy drift accepts 1,200 prefixes; modeled CPU saturates; path delay distracts | BGP/CPU probe; exact-prefix import guard |
| Delayed site brownout | Grid absent, initially working links, battery depletion, simultaneous transport/radio loss | DC/battery probe; commission finite reserve; energy continues draining |
| Silent alarms, degraded service | Broker/detection unavailable; telemetry backlogs conceal primary degradation | Recover ingestion/visibility first, then repair transport. Pipeline verification alone does not solve service |

Lab L3/L4 labels indicate scenario difficulty, not an industry certification or production severity.

## Coordinated recovery demonstration

**Replay solved campaign** opens a reviewed replacement dialog and loads the checked-in public example. It injects all six cases at separate regional origins, observes the resulting service/visibility failures, collects seven probes, reviews one nine-site patch set with shared capacity changes, and verifies every site. At T+12 all six cases are solved with 24 healthy sites and zero consumer lag. Its 19 commands are reproducible with:

```powershell
node scripts/replay_twin.cjs console/assets/twin-solved-example.json
```

For your own compound run, inject cases at different sites, advance to observe current conditions, then **Run active-case diagnostics**. This issues actual bounded probe commands for each active case. **Stage coordinated recovery** compiles the declared case remedies into a reviewable normalized patch bundle, shared resource plan and modeled work orders. It does not execute on selection. Inspect the bundle and required probe list, preview impact, create/review/execute, then observe scoped verification. Unrelated faults outside the declared remedy set can still fail the plan and trigger rollback.

## Model rules and boundaries

- One tick is one simulated second. Routing observes link changes after three ticks; configuration converges after two. Base primary RTT repeats 8/11/14 ms; backup 20/23/26 ms.
- Access capacities start at 250 Mbps primary and 180 Mbps backup. Each region has 500 Mbps; the shared fleet core has 3,200 Mbps. The preserved three-site compatibility model uses a 500 Mbps core.
- Fluid delivery starts at `min(demand, accessCapacity) × (1 - linkLoss/100)`, then scales within the region and shared core. Excess demand and regional queueing add modeled delay. This is not TCP or a packet scheduler.
- The MTU case models a 1,380-byte packet against a 1,280-byte backup path with blocked PMTUD. MSS mitigation is a model rule, not an implementation of TCP negotiation or ICMP.
- Import overload models `min(100, 10 + acceptedPrefixes × 0.08)` percent CPU. Exact-prefix guarding admits at most one of the injected prefixes. These are declared causal assumptions, not calibrated router performance.
- PTP loss increases offset by 0.75 µs per tick; alternate reference returns it to 0.3 µs. A 5 µs tolerance is a **lab threshold**, not a universal RAN timing standard.
- Feeder reflected-power fraction is `((VSWR - 1)/(VSWR + 1))²`. High VSWR and timing failure independently degrade modeled radio health. There is no antenna pattern, propagation map, baseband or real RF measurement.
- Grid loss drains usable energy at `loadW / 3600` Wh per tick. The case starts with 1 Wh battery; emergency commissioning enables a finite 480 Wh reserve at an 800 W load. The model omits voltage curves, temperature, aging and protection losses.
- Service health requires available transport, loss ≤5%, RTT ≤50 ms, delivery ≥`min(100, demand × 0.95)` Mbps, and healthy modeled radio/timing/power. Visibility health separately requires broker, storage, detection, zero outbox and caught-up consumer offsets.
- Advanced changes require current diagnostic evidence (30-tick window), independent review and unchanged site/resource context. Queue diagnostics also bind the whole fleet's configuration/demand/resource context. Active scopes cannot overlap. Global capacity plans verify every site and retain previously healthy sites as regression guards.
- Editable capacity plans accept 100–1,000 Mbps access and 100–50,000 Mbps regional/core budgets. A local upgrade with an unchanged congested core rolls back. Preview uses the same probes, faults and verification rules in detached branches; it cannot manufacture missing evidence.
- Three post-convergence observations decide verification. Failed plans revert touched configuration/resources, then observe recovery twice. Completed modeled field work is retained; rollback cannot unrepair a physical feeder. A reverted baseline may remain degraded.
- A solved case can become degraded again after later faults. Its first solved timestamp remains historical evidence; the current state follows current health.
- The event model retains three partitions, independent acknowledge-before-commit consumer offsets, outbox retry, per-group dead-letter delivery and event-ID effect deduplication. No Kafka brokers, consensus or S3 protocol run in the browser.
- DHCP pools have 40 addresses and 30-tick leases. Six public demo subscribers use weighted Broadband/Critical/IoT slice caps and a modeled cell/transport budget. Handover interrupts for two ticks and preserves the PDU address on success; radio or core failure can reject/fall back. No NAS, SCTP, GTP or SIM cryptography is implemented.
- Scheduled playbooks remain available under Engineering cases. Scheduling permits 1–120 ticks ahead and at most 16 pending faults. Commands are bounded to 1,200 and the clock to 1,500 ticks.

The optional native software reference still covers 50 catalog roles, with explicit modeled/reference/provider boundaries. Twin does not call Groq/OpenAI or fabricate provider output.

## Evidence and compatibility

Browser saves, checkpoints and **Export run** use compact `strata-twin-journal` files. They contain site designs, all commands and a structural final summary (configurations, resources, cases, probes, changes, counters, offsets and current observations). Replay rebuilds the full telemetry history/object evidence and compares the summary. This avoids repeatedly storing all generated telemetry in local storage. It is reproducibility validation, not a signed audit or creator authentication.

The pure API retains full `strata-twin-run` export/replay and verifies v1/v2 runs with frozen engines before reinterpretation into the three-site compatibility model. The current fleet UI accepts its own declared 24-site designs; it does not silently expand old three-site runs. Browser keys v1/v2 and their checkpoints are retained separately. Export prior runs from Evidence if present. Quota errors are explicit; export in-memory evidence before closing.

```powershell
node scripts/replay_twin.cjs path/to/strata-twin-journal.json
node --test tests/test_twin.cjs tests/test_engineering.cjs tests/test_device_configs.cjs
```

The public blueprint is `console/assets/twin-blueprint.json`; frozen three-site designs are `lab/reference/twin-blueprint-v2.json`. `twin-model.js` handles transport/mobile/events; `twin-engineering.js` handles causal equipment, cases, diagnostic evidence and scoped changes; `twin.js` renders the workspace.

Seven version-scoped routing profiles generate 168 fleet fragments; the public pack contains 183 explicit config files. Advanced RF/timing/energy/capacity actions are model intent and field work orders, not universal vendor CLI. The optional Docker topology remains a three-site reference lab and has not been run here. See [configuration boundaries](DEVICE_CONFIGURATION.md) and [the native lab guide](EXECUTABLE_LAB.md).

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
