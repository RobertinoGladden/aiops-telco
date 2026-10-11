# Monitoring dashboard

Open **Dashboards** for the browser-local 24-site lab. Top navigation replaces the sidebar across the application. The panel grid follows [Grafana dashboard](https://grafana.com/docs/grafana/latest/visualizations/dashboards/) conventions; this is Strata's own UI and simulator.

## Reading the panels

| Signal | Meaning |
| --- | --- |
| Green | Service thresholds met or dependency available |
| Amber | Threshold breach, capacity at 80–100%, or grid loss with working backup power |
| Red | Transport/radio unavailable, dependency stopped, or offered capacity above 100% |
| Blue | Throughput and network traffic |
| Blue-gray | Delayed observability, undelivered events or consumer backlog |
| Gray | No observation or provider state unavailable |
| Purple | AI workflow and evidence controls |

Text labels accompany status colors. **Service healthy** counts the model's transport and radio thresholds; **Warning sites** also includes sites using finite backup power. These counts intentionally overlap when service is working under containment. Capacity colors express planning headroom, separately from observed service health.

**Network traffic** sums offered and delivered Mbps across all sites at each observed tick. **Site health history** uses the worst condition in each time bucket, preserving short failures in long windows. A bucket with missing observations cannot silently become healthy. Hover a cell for its site, tick range and status.

Select **Last 60 / 120 / 300 ticks** to change the traffic and health windows. An early run displays only observations that exist. It never pads a fabricated history. **Regional capacity** compares offered demand with provisioned region/core budgets. **Telemetry pipeline** reads dependency availability, actual modeled consumer offsets and the outbox, independent of the incident count.

## Investigate and recover

1. Save a **Checkpoint** and choose an **Engineering case**.
2. Return to **Network overview** to inspect fleet impact, health history and the selected-site context.
3. Collect diagnostic probes, preview a scoped plan in **Changes**, then perform independent modeled review and execution.
4. Inspect stable recovery and rollback evidence. Checkpoints and replay exports remain in **Evidence**. **Run tools** contains import, export and reset.

Topology, manual fault injection and selected-site trends are grouped under **Engineering controls**. Device configuration, commissioning, operations and evidence remain available in the layer tabs.

## AI boundary

The copilot panel's monitoring brief is a read-only calculation from the Twin's current evidence and rule-based hypotheses. It does not synthesize an AI response, confidence score or approval. **Inspect context** shows the evidence boundary and next diagnostic step.

**Open AI decision desk** enters the existing measured-incident workflow: Groq analysis → OpenAI Decisions → policy checks → operator review. Provider readiness comes from the connected Hub. Without a configured Hub/provider connection, the dashboard displays **Hub offline** or **Setup required**. This UI update does not execute live AI provider calls or change equipment.

## Deployment

`node deploy/vercel/build.mjs` includes `dashboard.css` and `monitoring-view.js` in the public build. `node scripts/package_vercel.mjs` creates the standalone package. The lab remains usable as static Vercel assets; live Hub views require the existing authenticated backend.
