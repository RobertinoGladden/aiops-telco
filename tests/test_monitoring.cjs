const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const M = require("../console/assets/twin-model.js");
const V = require("../console/assets/monitoring-view.js");
const catalog = JSON.parse(fs.readFileSync(`${__dirname}/../console/assets/twin-blueprint.json`, "utf8"));
const site = "JKT-001";
const step = (s, command) => M.step(s, {actor:"operator", ...command});
const advance = (s, ticks=1) => step(s, {type:"ADVANCE", ticks});
const start = () => advance(M.initial(catalog));
const inject = (s, caseId) => advance(step(s, {type:"APPLY_CASE", caseId, site}));

test("missing observations stay unknown rather than healthy or zero throughput", () => {
  const state = M.initial(catalog), summary = V.snapshot(state);
  assert.equal(V.severity(state.sites[site].metrics), "unknown");
  assert.equal(summary.unknown, 24);
  assert.equal(summary.healthy, 0);
  assert.equal(summary.degraded, 0);
  assert.equal(summary.delivered, null);
  assert.deepEqual(V.traffic(state, 60), []);
  assert.match(V.brief(state, site).headline, /Awaiting observations/);
});

test("fleet traffic and shared capacity agree with the engineering model", () => {
  const state = inject(start(), "capacity_cascade"), summary = V.snapshot(state);
  assert.deepEqual(V.traffic(state, 60).at(-1), {
    tick:state.tick, offered:summary.offered, delivered:summary.delivered, healthy:summary.healthy
  });
  assert.equal(V.regions(state).reduce((n, r) => n+r.offered, 0), summary.offered);
  assert.ok(summary.degraded > 4, "Core congestion reaches other regions");
  assert.ok(V.regions(state).some(r => r.status === "critical"));
  assert.equal(V.capacityStatus(summary.coreRatio), "critical");
  assert.equal(V.capacityStatus(V.utilization(400, 500)), "warning");
  assert.equal(V.capacityStatus(V.utilization(400, 0)), "unknown");
});

test("radio failure is critical even when the transport interface stays available", () => {
  const state = inject(start(), "timing_rf"), metric = state.sites[site].metrics;
  assert.equal(metric.available, true);
  assert.equal(metric.radioHealthy, false);
  assert.equal(V.severity(metric), "critical");
  assert.ok(V.snapshot(state).critical > 0);
});

test("finite emergency power is warning while the recovered service meets thresholds", () => {
  const journal = JSON.parse(fs.readFileSync(`${__dirname}/../console/assets/twin-solved-example.json`, "utf8"));
  const state = M.replay(journal), metric = state.sites["DPS-001"].metrics;
  assert.ok(M.healthy(metric));
  assert.equal(metric.gridAvailable, false);
  assert.equal(V.severity(metric), "warning");
  assert.equal(V.snapshot(state).healthy, 24);
  assert.match(V.brief(state, "DPS-001").headline, /containment needs attention/);
});

test("pipeline outage remains visible before incident detection catches up", () => {
  let state = step(start(), {type:"FAULT", fault:"broker_down", value:true});
  state = advance(state, 3);
  const summary = V.snapshot(state), brief = V.brief(state, site);
  assert.equal(summary.healthy, 24);
  assert.equal(summary.pipeline, false);
  assert.ok(summary.outbox > 0);
  assert.match(brief.headline, /Visibility is degraded/);
  assert.match(brief.nextStep, /Telemetry freshness/);
});

test("time windows use actual ticks without padding an invented history", () => {
  let state = start();
  assert.equal(V.windowFrames(state, 300).length, 1);
  for (let n=0; n<10; n++) state = advance(state, 30);
  for (const count of [60,120,300]) {
    const frames = V.windowFrames(state, count);
    assert.equal(frames.length, count);
    assert.equal(frames.at(-1).tick, state.tick);
    assert.equal(frames[0].tick, state.tick-count+1);
  }
  assert.throws(() => V.windowFrames(state, 42), /declared dashboard window/);
});

test("heatmap aggregation preserves brief faults and missing observations", () => {
  const state = start(), metric = state.sites[site].metrics;
  state.history = Array.from({length:120}, (_, i) => ({tick:i+1, sites:{[site]:{...metric}}}));
  state.history[1].sites[site].radioHealthy = false;
  delete state.history[2].sites[site];
  const heat = V.healthHistory(state, 120), row = heat.rows.find(r => r.site === site);
  assert.equal(heat.stride, 2);
  assert.equal(row.cells.length, 60);
  assert.deepEqual(row.cells[0], {from:1, to:2, status:"critical"});
  assert.equal(row.cells[1].status, "unknown");
  assert.equal(row.cells[2].status, "healthy");
});

test("the monitoring brief is read-only model context and preserves review evidence", () => {
  const state = inject(start(), "mtu_trap"), before = M.canonical(state);
  V.traffic(state, 60); V.regions(state); V.healthHistory(state, 60);
  const brief = V.brief(state, site);
  assert.ok(brief.hypotheses.some(h => h.probe === "mtu"));
  assert.match(brief.nextStep, /before staging a change/);
  assert.match(brief.boundary, /No AI provider output/);
  assert.equal(state.jobs.length, 0);
  assert.equal(M.canonical(state), before);
  assert.deepEqual(M.replay(M.exportJournal(state, catalog)), state);
});
