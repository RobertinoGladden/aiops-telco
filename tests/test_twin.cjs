const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const M = require("../console/assets/twin-model.js");
const catalog = JSON.parse(fs.readFileSync(`${__dirname}/../console/assets/twin-blueprint.json`, "utf8"));
const coverage = JSON.parse(fs.readFileSync(`${__dirname}/../lab/reference/twin-coverage.json`, "utf8"));
const target = "JKT-001";
const start = () => M.step(M.initial(catalog), {type: "ADVANCE", ticks: 1});
const advance = (state, ticks = 1) => M.step(state, {type: "ADVANCE", ticks});
const fault = (state, name, value) => M.step(state, {type: "FAULT", site: target, fault: name, value});
function propose(state, action = "prefer_backup") {
  return M.step(state, {type: "PROPOSE", site: target, action, reason: "Investigate modeled route degradation"});
}
function execute(state) {
  const jobId = state.jobs.at(-1).id;
  state = M.step(state, {type: "APPROVE", actor: "reviewer", jobId});
  return M.step(state, {type: "EXECUTE", jobId});
}
test("site intent rejects overlap, public addressing, duplicate VLAN and duplicate ASN", () => {
  for (const mutate of [(sites) => sites[1].service = sites[0].management,
    (sites) => sites[0].management = "8.8.8.0/24", (sites) => sites[1].service_vlan = sites[0].service_vlan,
    (sites) => sites[1].asn = sites[0].asn]) {
    const copy = JSON.parse(JSON.stringify(catalog)); mutate(copy.sites); assert.throws(() => M.initial(copy));
  }
});
test("traffic is calculated from the declared link and shared-core capacity", () => {
  let state = start(); assert.equal(state.sites[target].metrics.throughputMbps, 100);
  for (const site of Object.keys(state.sites)) state = M.step(state, {type: "FAULT", site, fault: "demand", value: 500});
  state = advance(state);
  const delivered = Object.values(state.sites).reduce((total, s) => total + s.metrics.throughputMbps, 0);
  assert.ok(Math.abs(delivered - 500) < .02); assert.ok(state.sites[target].metrics.lossPct > 50);
});
test("routing keeps a failed path until its hold timer, then chooses backup", () => {
  let state = fault(start(), "primary_down", true);
  state = advance(state); assert.equal(state.sites[target].selected, "primary"); assert.equal(state.sites[target].metrics.available, false);
  state = advance(state); assert.equal(state.sites[target].selected, "primary");
  state = advance(state); assert.equal(state.sites[target].selected, "backup"); assert.ok(M.healthy(state.sites[target].metrics));
  state = advance(fault(state, "backup_down", true), 3); assert.equal(state.sites[target].selected, null);
});
test("incident needs three breaches, review and three verification observations recover it", () => {
  let state = fault(start(), "primary_delay", 120); state = advance(state, 2);
  assert.equal(state.incidents.length, 0); state = advance(state); assert.equal(state.incidents[0].state, "open");
  state = propose(state); const jobId = state.jobs[0].id;
  assert.throws(() => M.step(state, {type: "APPROVE", actor: "operator", jobId}), /reviewer/);
  assert.throws(() => M.step(state, {type: "EXECUTE", jobId}), /approval/);
  state = execute(state); state = advance(state, 4);
  assert.equal(state.jobs[0].state, "verified"); assert.equal(state.jobs[0].observations.length, 3);
  assert.equal(state.sites[target].selected, "backup"); assert.equal(state.incidents[0].state, "resolved");
  assert.throws(() => M.step(state, {type: "EXECUTE", jobId}), /approval/);
  assert.notDeepEqual(state.sites[target].config, state.sites[target].intent);
  state = M.step(state, {type: "ACCEPT_INTENT", jobId, actor: "reviewer"});
  assert.deepEqual(state.sites[target].config, state.sites[target].intent);
  assert.throws(() => M.step(state, {type: "ACCEPT_INTENT", jobId, actor: "reviewer"}), /already/);
});
test("configuration drift or changed operational context invalidates an approval", () => {
  for (const invalidate of [(s) => M.step(s, {type: "DRIFT", site: target}), (s) => fault(s, "primary_delay", 120)]) {
    let state = propose(start()); const jobId = state.jobs[0].id;
    state = M.step(state, {type: "APPROVE", actor: "reviewer", jobId}); state = invalidate(state);
    assert.throws(() => M.step(state, {type: "EXECUTE", jobId}), /changed/);
    assert.equal(state.jobs[0].state, "approved");
  }
});
test("an expired proposal cannot be approved or executed", () => {
  let state = propose(start()); const jobId = state.jobs[0].id;
  state = advance(advance(state, 30), 30);
  assert.throws(() => M.step(state, {type: "APPROVE", actor: "reviewer", jobId}), /reviewable/);
});
test("failed verification restores configuration but does not claim a degraded path recovered", () => {
  let state = fault(fault(start(), "primary_delay", 120), "backup_down", true); state = advance(state, 3);
  state = execute(propose(state)); state = advance(state, 6);
  assert.equal(state.jobs[0].state, "rolling_back"); state = advance(state);
  assert.equal(state.jobs[0].state, "rolled_back"); assert.equal(state.sites[target].config.backupPreference, 80);
  assert.equal(state.jobs[0].rollback.recovery, "path_still_degraded");
  assert.equal(state.jobs[0].delivery, "event_acknowledged");
});
test("one site's concurrent changes cannot overwrite a running change", () => {
  let state = propose(start()); state = propose(state, "expand_backup");
  state = M.step(state, {type: "APPROVE", jobId: state.jobs[0].id, actor: "reviewer"});
  state = M.step(state, {type: "APPROVE", jobId: state.jobs[1].id, actor: "reviewer"});
  state = M.step(state, {type: "EXECUTE", jobId: state.jobs[0].id});
  assert.throws(() => M.step(state, {type: "EXECUTE", jobId: state.jobs[1].id}), /active change/);
});
test("broker outage keeps outbox pending; stopped storage does not commit offsets", () => {
  let state = fault(fault(start(), "broker_down", true), "storage_down", true); state = advance(state, 3);
  assert.equal(state.outbox.length, 9); assert.deepEqual(state.groups.storage, [1, 1, 1]);
  state = advance(fault(state, "broker_down", false)); assert.equal(state.outbox.length, 0);
  assert.equal(M.lag(state, "storage"), 12); assert.equal(M.lag(state, "detection"), 0);
  state = advance(fault(state, "storage_down", false)); assert.equal(M.lag(state, "storage"), 0);
  assert.equal(state.counters.stored, 18);
});
test("invalid events go to DLQ per group before source offset commit", () => {
  let state = M.step(start(), {type: "INVALID_EVENT", site: target}); state = advance(state);
  assert.equal(state.counters.deadLetter, 2);
  assert.equal(state.topics["dead-letter"][0].length, 2);
  assert.equal(state.groups.storage[0], 3); assert.equal(state.groups.detection[0], 3);
  assert.equal(state.counters.stored, 6); assert.equal(state.counters.detected, 6);
});
test("redelivery has duplicate records but only one storage/detection effect per event ID", () => {
  let state = M.step(start(), {type: "REDRIVE", site: target}); state = advance(state);
  assert.equal(state.topics.telemetry[0].length, 3);
  assert.equal(state.counters.stored, 6); assert.equal(state.counters.detected, 6); assert.equal(state.counters.duplicates, 2);
});
test("job evidence stays pending during storage/broker outage and retries after restoration", () => {
  let state = execute(propose(start())); state = fault(fault(state, "broker_down", true), "storage_down", true);
  state = advance(state, 4); assert.equal(state.jobs[0].state, "verified");
  assert.equal(state.jobs[0].delivery, "outbox_pending"); assert.equal(state.jobs[0].evidenceState, "storage_pending");
  state = advance(fault(fault(state, "broker_down", false), "storage_down", false));
  assert.equal(state.jobs[0].delivery, "event_acknowledged"); assert.equal(state.jobs[0].evidenceState, "stored_in_model");
  assert.ok(state.objects[state.jobs[0].artifact]);
});
test("DHCP allocates unique addresses, preserves renewals, expires leases and rejects exhaustion", () => {
  let state = start();
  for (let n = 0; n < 40; n++) state = M.step(state, {type: "LEASE", site: target, client: `client-${n}`});
  assert.equal(new Set(state.leases.map((l) => l.address)).size, 40);
  assert.throws(() => M.step(state, {type: "LEASE", site: target, client: "overflow"}), /exhausted/);
  state = advance(state, 2); state = M.step(state, {type: "LEASE", site: target, client: "client-0"});
  state = advance(state, 28); assert.equal(state.leases.length, 1); state = advance(state, 2); assert.equal(state.leases.length, 0);
});
test("subscriber admission and PDU states allocate unique addresses; core failure releases them", () => {
  let state = start();
  state = M.step(state, {type: "REGISTER_UE", site: target, subscriber: "unknown"}); assert.equal(state.sessions[0].state, "rejected");
  state = M.step(state, {type: "REGISTER_UE", site: target, subscriber: "demo-1"});
  assert.throws(() => M.step(state, {type: "REGISTER_UE", site: target, subscriber: "demo-1"}), /already/);
  state = M.step(state, {type: "REGISTER_UE", site: target, subscriber: "demo-2"});
  state = advance(state); assert.equal(state.sessions[1].state, "registered");
  state = advance(state); assert.equal(state.sessions[1].state, "pdu_active"); assert.equal(state.sessions[1].throughputMbps, 20);
  assert.notEqual(state.sessions[1].address, state.sessions[2].address);
  state = advance(fault(state, "core_down", true)); assert.ok(state.sessions.every((s) => s.state === "rejected" && s.address === null));
});
test("invalid commands leave original state unchanged and never execute arbitrary code", () => {
  const state = start(); const snapshot = M.canonical(state);
  for (const command of [{type: "ADVANCE", ticks: 9999}, {type: "FAULT", fault: "demand", site: target, value: NaN},
    {type: "PROPOSE", site: target, action: "__proto__", reason: "invalid action"},
    {type: "EXECUTE", jobId: "unknown"}, {type: "shell", command: "danger"}]) assert.throws(() => M.step(state, command));
  assert.equal(M.canonical(state), snapshot);
});
test("export replays exactly and rejects altered state, version or unbounded clocks", () => {
  let state = advance(fault(start(), "primary_loss", 12), 4); state = advance(execute(propose(state)), 4);
  const run = M.exportRun(state, catalog); assert.equal(M.canonical(M.replay(run)), M.canonical(state));
  const changed = structuredClone(run); changed.finalState.tick++; assert.throws(() => M.replay(changed), /differs/);
  assert.throws(() => M.replay({...run, version: "99"}), /version/);
  assert.throws(() => M.replay({...run, finalState: undefined}), /final state/);
  assert.throws(() => M.replay({...run, commands: Array.from({length: 51}, () => ({type: "ADVANCE", ticks: 30}))}), /1500/);
});
test("native FRR export follows reviewed preference and includes prefix filters", () => {
  const state = advance(execute(propose(start())), 4); const config = M.nativeFrr(state, target);
  assert.match(config, /set local-preference 200/); assert.match(config, /neighbor 10.251.0.1 remote-as 65200/);
  assert.match(config, /ip prefix-list LOCAL seq 10 permit 10.81.1.0\/24/); assert.match(config, /not a running router/);
});
test("native site allocations match the public blueprint and references retain explicit boundaries", () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(`${__dirname}/../lab/reference/software-catalog.json`, "utf8")).sites, catalog.sites);
  assert.deepEqual(coverage.components.map((c) => c.id).sort(), JSON.parse(fs.readFileSync(`${__dirname}/../lab/reference/software-catalog.json`, "utf8")).tools.map((t) => t.id).sort());
  assert.equal(new Set(coverage.components.map((c) => c.id)).size, 50);
  for (const c of coverage.components) {assert.ok(["modeled", "provider", "reference"].includes(c.mode)); assert.ok(c.contract && c.boundary);}
});

test("scheduled faults execute exactly once, cancellations remain auditable and replay preserves the timeline", () => {
  let state = M.step(start(), {type: "SCHEDULE_FAULT", site: target, fault: "primary_delay", value: 120, after: 3});
  state = M.step(state, {type: "SCHEDULE_FAULT", site: target, fault: "primary_down", value: true, after: 2});
  const cancelled = state.schedule.at(-1).id; state = M.step(state, {type: "CANCEL_SCHEDULE", scheduleId: cancelled});
  state = advance(state, 2); assert.equal(state.sites[target].links.primary.delay, 0);
  state = advance(state); assert.equal(state.sites[target].metrics.latencyMs, 128);
  assert.equal(state.schedule[0].appliedAt, 4); assert.equal(state.schedule[1].state, "cancelled");
  state = advance(state, 4); assert.equal(state.audit.filter((a) => a.type === "scheduled_fault_applied").length, 1);
  assert.throws(() => M.step(state, {type: "CANCEL_SCHEDULE", scheduleId: state.schedule[0].id}), /pending/);
  assert.deepEqual(M.replay(M.exportRun(state, catalog)), state);
});
test("scheduling rejects invalid values, forbidden actors, full timelines and clocks beyond the session", () => {
  let state = start(); const before = M.canonical(state);
  for (const c of [{after: 0}, {after: 121}, {after: 1, value: 999}, {after: 1, actor: "reviewer"}])
    assert.throws(() => M.step(state, {type: "SCHEDULE_FAULT", site: target, fault: "primary_delay", value: 120, ...c}));
  assert.equal(M.canonical(state), before);
  for (let i = 0; i < 16; i++) state = M.step(state, {type: "SCHEDULE_FAULT", site: target, fault: "primary_delay", value: i, after: 100});
  assert.throws(() => M.step(state, {type: "APPLY_SCENARIO", site: target, scenarioId: "failover"}), /16/);
  assert.equal(state.experiments.length, 0);
  let late = start(); for (let i = 0; i < 49; i++) late = advance(late, 30);
  late = advance(late, 28);
  assert.throws(() => M.step(late, {type: "SCHEDULE_FAULT", site: target, fault: "primary_down", value: true, after: 2}), /1500/);
});
test("all scenario presets replay with one command per action and preserve delayed failure semantics", () => {
  for (const scenarioId of Object.keys(M.scenarios)) {
    let state = M.step(start(), {type: "APPLY_SCENARIO", site: target, scenarioId});
    assert.equal(state.commands.length, 2); state = advance(state, M.scenarios[scenarioId].duration);
    assert.equal(state.commands.length, 3); assert.ok(state.schedule.every((e) => e.state === "applied"));
    assert.deepEqual(M.replay(M.exportRun(state, catalog)), state);
    if (scenarioId === "failover") {assert.equal(M.summarize(state, target).outageTicks, 3); assert.equal(state.sites[target].selected, "primary");}
    if (scenarioId === "streaming") {assert.equal(state.outbox.length, 0); assert.equal(M.lag(state, "storage"), 0);}
  }
});
test("what-if isolates input state and evaluates verification, all-site impact and rollback", () => {
  const state = advance(fault(start(), "primary_delay", 120), 3); const snapshot = M.canonical(state);
  const result = M.forecast(state, {site: target, action: "prefer_backup"});
  assert.equal(M.canonical(state), snapshot); assert.equal(state.jobs.length, 0); assert.equal(result.job.state, "verified");
  assert.equal(result.comparison.length, 3); assert.equal(result.comparison[0].baseline.slaPct, 0);
  assert.ok(result.comparison[0].delta.slaPoints > 80); assert.ok(result.comparison[0].delta.latencyMs < -90);
  const degraded = advance(fault(state, "backup_down", true), 3);
  const failure = M.forecast(degraded, {site: target, action: "prefer_backup"});
  assert.equal(failure.job.state, "rolled_back"); assert.equal(failure.job.rollback.recovery, "path_still_degraded");
  assert.throws(() => M.forecast(state, {site: target, action: "prefer_backup", horizon: 100}), /horizon/);
});
test("forecast includes the same scheduled shocks on both branches", () => {
  let state = M.step(start(), {type: "SCHEDULE_FAULT", site: "BDG-001", fault: "primary_delay", value: 120, after: 2});
  const result = M.forecast(state, {site: target, action: "prefer_backup"});
  assert.equal(result.comparison[1].baseline.healthyTicks, 1); assert.equal(result.comparison[1].candidate.healthyTicks, 1);
  assert.equal(state.schedule[0].state, "pending");
});
test("model history retains loss and outage observations even when the broker cannot deliver them", () => {
  let state = fault(fault(start(), "broker_down", true), "primary_down", true); state = advance(state, 4);
  const summary = M.summarize(state, target); assert.equal(summary.observations, 5); assert.equal(summary.outageTicks, 2);
  assert.equal(summary.healthyTicks, 3); assert.equal(summary.slaPct, 60); assert.equal(state.outbox.length, 12);
  assert.equal(state.history.length, 5); assert.equal(state.history[1].sites[target].latencyMs, null);
});
test("weighted slices honor per-session caps and share both cell and transport budgets", () => {
  let state = start();
  for (let i = 1; i <= 6; i++) state = M.step(state, {type: "REGISTER_UE", site: target, subscriber: `demo-${i}`, slice: i <= 2 ? "critical" : "broadband"});
  state = advance(fault(state, "demand", 20), 2);
  assert.deepEqual(state.sessions.map((s) => s.throughputMbps), [6, 6, 2, 2, 2, 2]);
  state = advance(fault(state, "demand", 100));
  assert.deepEqual(state.sessions.map((s) => s.throughputMbps), [10, 10, 5, 5, 5, 5]);
  assert.ok(state.sessions.reduce((n, s) => n + s.throughputMbps, 0) <= 40);
  assert.throws(() => M.step(start(), {type: "REGISTER_UE", site: target, subscriber: "demo-1", slice: "__proto__"}), /slice/);
  let iot = M.step(start(), {type: "REGISTER_UE", site: target, subscriber: "demo-1", slice: "iot"});
  iot = advance(iot, 2); assert.equal(iot.sessions[0].throughputMbps, 2);
});
function activeUE() {
  return advance(M.step(start(), {type: "REGISTER_UE", site: target, subscriber: "demo-1"}), 2);
}
test("handover interrupts for two ticks, retains the address and reallocates at the destination", () => {
  let state = activeUE(); const address = state.sessions[0].address; const sessionId = state.sessions[0].id;
  assert.throws(() => M.step(state, {type: "HANDOVER_UE", site: target, sessionId}), /different/);
  state = M.step(state, {type: "HANDOVER_UE", site: "BDG-001", sessionId});
  assert.equal(state.sessions[0].throughputMbps, 0); state = advance(state);
  assert.equal(state.sessions[0].state, "handover_pending"); state = advance(state);
  assert.equal(state.sessions[0].state, "pdu_active"); assert.equal(state.sessions[0].site, "BDG-001");
  assert.equal(state.sessions[0].address, address); assert.equal(state.sessions[0].handover.state, "completed");
  assert.equal(state.sessions[0].throughputMbps, 25); assert.deepEqual(M.replay(M.exportRun(state, catalog)), state);
});
test("handover falls back when the target cell fails and rejects when both cells or the core fail", () => {
  for (const condition of ["target", "both", "core"]) {
    let state = activeUE(); const sessionId = state.sessions[0].id; const address = state.sessions[0].address;
    state = M.step(state, {type: "HANDOVER_UE", site: "BDG-001", sessionId});
    state = M.step(state, {type: "FAULT", site: "BDG-001", fault: "radio_down", value: true});
    if (condition === "both") state = fault(state, "radio_down", true);
    if (condition === "core") state = fault(state, "core_down", true);
    state = advance(state, 2);
    if (condition === "target") {assert.equal(state.sessions[0].site, target); assert.equal(state.sessions[0].address, address); assert.equal(state.sessions[0].handover.state, "fallback");}
    else {assert.equal(state.sessions[0].state, "rejected"); assert.equal(state.sessions[0].address, null); assert.equal(state.sessions[0].handover.state, "failed");}
  }
});
test("v1 imports must pass their original replay before migration; v2 checkpoints replay exactly", () => {
  const Legacy = require("../console/assets/twin-model-v1.js");
  let old = Legacy.step(Legacy.initial(catalog), {type: "ADVANCE", ticks: 1});
  old = Legacy.step(old, {type: "REGISTER_UE", site: target, subscriber: "demo-1"});
  old = Legacy.step(old, {type: "ADVANCE", ticks: 2}); const run = Legacy.exportRun(old, catalog);
  const migrated = M.migrate(run); assert.equal(migrated.version, M.VERSION); assert.equal(migrated.sessions[0].sliceKey, "broadband");
  assert.equal(migrated.history.length, 3); assert.deepEqual(M.replay(M.exportRun(migrated, catalog)), migrated);
  const tampered = structuredClone(run); tampered.finalState.tick++; assert.throws(() => M.migrate(tampered), /differs/);
});
