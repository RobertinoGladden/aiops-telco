/* Strata Twin: deterministic operational model, not a protocol or vendor emulator. */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./twin-model-v1.js") : root.StrataTwinLegacy, typeof module === "object" && module.exports ? require("./twin-model-v2.js") : root.StrataTwinV2, typeof module === "object" && module.exports ? require("./twin-engineering.js") : root.StrataEngineering);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StrataTwin = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Legacy, V2, E) {
  "use strict";
  const VERSION = "3.0.0";
  const MAX_COMMANDS = 1200;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  const canonical = (value) => JSON.stringify(sorted(value));
  const round = (value) => Math.round(value * 100) / 100;
  const assumptions = [
    "One tick is one simulated second; the clock advances on command or during visible-browser playback.",
    "Routing models local preference, a 3-tick failure detection delay and 2-tick configuration convergence. No BGP packets are exchanged.",
    "Fluid traffic model: demand is capped by link capacity, loss and regional aggregation and a shared declared core. This is not a TCP/packet simulator.",
    "Mobile registration, weighted slice allocation and a two-tick handover interruption are state machines. No NAS, SCTP, GTP, SIM cryptography or RF propagation runs here.",
    "Three event partitions, independent consumer offsets, acknowledge-before-commit, outbox retry and event-ID deduplication are modeled in browser memory.",
    "Object versions, monitoring confirmations and workflow review are modeled. No vendor REST API, database, consensus or production authentication is emulated.",
    "Scenario state is local to this browser. Exported command logs can be replayed; no background execution or shared cloud database is configured.",
  ];
  const actions = {
    ...E.actions,
    prefer_backup: {label: "Prefer backup path", field: "backupPreference", value: 200},
    restore_primary: {label: "Restore primary preference", field: "backupPreference", value: 80},
    expand_backup: {label: "Increase backup capacity to 350 Mbps", field: "backupCapacity", value: 350},
  };
  const slices = {
    broadband: {label: "Broadband", id: "1-000001", maxMbps: 25, weight: 1},
    critical: {label: "Critical", id: "1-000002", maxMbps: 10, weight: 3},
    iot: {label: "IoT", id: "1-000003", maxMbps: 2, weight: 1},
  };
  const scenarios = {
    failover: {label: "Transport failover", description: "Fail the primary link, observe hold-timer loss, then recover routing.", duration: 16},
    congestion: {label: "Regional congestion", description: "Competing site demand saturates the shared core before recovery.", duration: 20},
    streaming: {label: "Telemetry interruption", description: "Broker and storage outages exercise outbox retry and independent offsets.", duration: 22},
    mobility: {label: "Mobile continuity", description: "A cell outage tests handover timing and source-cell fallback.", duration: 18},
  };
  const faultTypes = ["primary_down", "backup_down", "primary_delay", "primary_loss", "demand", "broker_down", "storage_down", "detector_down", "core_down", "radio_down"];
  function assert(value, message) { if (!value) throw new Error(message); }
  function initial(catalog) {
    assert(catalog && Array.isArray(catalog.sites) && catalog.sites.length >= 3 && catalog.sites.length <= 48, "Declare 3–48 site designs");
    const state = {version: VERSION, tick: 0, serial: 0, commands: [], audit: [], jobs: [], incidents: [],
      inventoryRevision: 1, sites: {}, services: {broker: true, storage: true, detector: true, mobileCore: true},
      history: [], schedule: [], experiments: [], topics: {}, outbox: [], objects: {}, detections: {}, receipts: [], sessions: [], leases: [], failures: [],
      groups: {storage: [0, 0, 0], detection: [0, 0, 0]},
      counters: {published: 0, stored: 0, detected: 0, duplicates: 0, deadLetter: 0}, assumptions: clone(assumptions)};
    const ids = new Set(); const vlans = new Set(); const prefixes = [];
    for (const [index, input] of catalog.sites.entries()) {
      assert(/^[A-Z]{3}-\d{3}$/.test(input.id) && !ids.has(input.id), "Invalid or duplicate site ID"); ids.add(input.id);
      for (const key of ["management", "service"]) {
        const block = prefix(input[key]);
        assert(block.private, "Use private lab prefixes");
        assert(!prefixes.some((other) => block.start <= other.end && block.end >= other.start), "Overlapping site prefixes");
        prefixes.push(block);
      }
      assert(prefix(input.service).length === 24, "This model requires /24 service networks");
      for (const vlan of [input.service_vlan, input.management_vlan]) {
        assert(Number.isInteger(vlan) && vlan > 0 && vlan < 4095 && !vlans.has(vlan), "Duplicate or invalid VLAN"); vlans.add(vlan);
      }
      assert(Number.isInteger(input.asn) && input.asn >= 64512 && input.asn <= 65534, "Use a private lab ASN");
      assert(!Object.values(state.sites).some((site) => site.asn === input.asn), "Duplicate ASN");
      state.sites[input.id] = {id: input.id, name: String(input.name).slice(0, 80), index, management: input.management,
        service: input.service, serviceVlan: input.service_vlan, managementVlan: input.management_vlan, asn: input.asn,
        intent: {backupPreference: 80, backupCapacity: 180}, config: {backupPreference: 80, backupCapacity: 180},
        revision: 1, convergence: 0, selected: "primary", demand: 100, radioUp: true, consecutive: 0, recovery: 0,
        links: {primary: {up: true, knownUp: true, changedAt: 0, latency: 8 + (index % 3) * 3, delay: 0, loss: 0, capacity: 250},
                backup: {up: true, knownUp: true, changedAt: 0, latency: 20 + (index % 3) * 3, delay: 0, loss: 0, capacity: 180}}, metrics: null};
    }
    E.initialize(state, catalog.sites);
    state.assumptions.push("Engineering cases model MTU blackholes, route-import CPU pressure, PTP holdover, feeder mismatch and finite battery energy. Thresholds and capacity plans are declared lab assumptions, not vendor or 3GPP certification.", "RF feeder repair and battery commissioning are simulated field work orders. No physical equipment is controlled. Advanced capacity and timing patches are model intent, not exported vendor CLI.");
    for (const [name, count] of [["telemetry", 3], ["changes", 3], ["dead-letter", 1]])
      state.topics[name] = Array.from({length: count}, () => []);
    observe(state, "system", "bootstrap", "Declared site intent loaded; external services were not started");
    return state;
  }
  function prefix(value) {
    assert(typeof value === "string" && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(value), "Invalid IPv4 prefix");
    const [ip, bits] = value.split("/"); const bytes = ip.split(".").map(Number); const length = Number(bits);
    assert(bytes.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && length >= 8 && length <= 30, "Invalid IPv4 prefix");
    const number = bytes.reduce((total, n) => total * 256 + n, 0); const size = 2 ** (32 - length);
    const start = Math.floor(number / size) * size;
    assert(start === number, "Prefix must be a network address");
    const end = start + size - 1;
    const privateRange = [[167772160, 184549375], [2886729728, 2887778303], [3232235520, 3232301055]];
    return {start, end, length, private: privateRange.some(([lo, hi]) => start >= lo && end <= hi)};
  }
  function ip(number) { return [24, 16, 8, 0].map((bits) => Math.floor(number / 2 ** bits) % 256).join("."); }
  function id(state, name) { state.serial += 1; return `${name}-${String(state.serial).padStart(6, "0")}`; }
  function observe(state, actor, type, detail, extra = {}) {
    state.audit.push({id: id(state, "audit"), tick: state.tick, actor, type, detail, ...extra});
  }
  function site(state, siteId) { assert(Object.hasOwn(state.sites, siteId), "Unknown site"); return state.sites[siteId]; }
  function snap(value) { return {revision: value.revision, config: clone(value.config), intent: clone(value.intent),
    context: {demand: value.demand, radioUp: value.radioUp, engineering: E.context(value), links: Object.fromEntries(Object.entries(value.links)
      .map(([name, link]) => [name, {up: link.up, delay: link.delay, loss: link.loss}]))}}; }
  function job(state, jobId) { const value = state.jobs.find((j) => j.id === jobId); assert(value, "Unknown change"); return value; }
  function healthy(metric) { return metric && metric.available && metric.radioHealthy !== false && metric.lossPct <= 5 && Number.isFinite(metric.latencyMs)
    && metric.latencyMs <= 50 && metric.throughputMbps >= Math.min(100, metric.demandMbps * .95); }
  function emit(state, topic, partition, payload) {
    if (!state.services.broker) return null;
    const records = state.topics[topic][partition];
    const receipt = {topic, partition, offset: records.length, eventId: payload.eventId};
    records.push({offset: records.length, tick: state.tick, payload: clone(payload)});
    state.receipts.push(receipt); state.counters.published += 1;
    return receipt;
  }
  function publish(state, topic, partition, payload) {
    const receipt = emit(state, topic, partition, payload);
    if (!receipt) state.outbox.push({topic, partition, payload: clone(payload)});
    return receipt;
  }
  function validMetric(value) {
    return value && value.schema === 1 && value.source === "strata-twin-model" && typeof value.eventId === "string"
      && typeof value.site === "string" && typeof value.available === "boolean" && Number.isInteger(value.tick) && value.tick >= 0
      && Number.isFinite(value.lossPct) && value.lossPct >= 0 && value.lossPct <= 100
      && Number.isFinite(value.throughputMbps) && value.throughputMbps >= 0
      && (value.latencyMs === null || Number.isFinite(value.latencyMs) && value.latencyMs >= 0)
      && Number.isFinite(value.demandMbps) && value.demandMbps >= 0;
  }
  function object(state, key, body) {
    assert(state.services.storage, "Modeled storage is unavailable");
    const versions = state.objects[key] || (state.objects[key] = []);
    const content = canonical(body);
    if (versions.some((v) => canonical(v.body) === content)) return false;
    versions.push({version: versions.length + 1, tick: state.tick, contentType: "application/json", body: clone(body)});
    return true;
  }
  function detect(state, metric) {
    const value = state.sites[metric.site]; const open = state.incidents.find((i) => i.site === metric.site && i.state === "open");
    if (!healthy(metric)) {
      value.consecutive += 1; value.recovery = 0;
      if (value.consecutive >= 3 && !open) {
        state.incidents.push({id: id(state, "incident"), site: value.id, state: "open", openedAt: metric.tick, resolvedAt: null,
          evidence: [metric.eventId], reason: !metric.available ? "Path unavailable" : metric.radioHealthy === false ? "Radio timing, feeder or power degradation" : metric.lossPct > 5 ? "Packet loss above threshold" : metric.latencyMs > 50 ? "Latency above threshold" : "Capacity shortfall"});
        observe(state, "detector", "incident_open", `${value.id}: three consecutive modeled threshold breaches`);
      } else if (open) open.evidence.push(metric.eventId);
    } else {
      value.consecutive = 0; value.recovery += 1;
      if (open && value.recovery >= 2) { open.state = "resolved"; open.resolvedAt = metric.tick;
        observe(state, "detector", "incident_resolved", `${value.id}: two consecutive modeled recovery observations`); }
    }
  }
  function consume(state) {
    if (!state.services.broker) return;
    for (const group of ["storage", "detection"]) {
      if (!state.services[group === "detection" ? "detector" : "storage"]) continue;
      for (let partition = 0; partition < 3; partition++) {
        const records = state.topics.telemetry[partition];
        while (state.groups[group][partition] < records.length) {
          const record = records[state.groups[group][partition]]; const value = record.payload;
          if (!validMetric(value) || !Object.hasOwn(state.sites, value.site)) {
            const dlq = emit(state, "dead-letter", 0, {eventId: `dlq-${group}-${partition}-${record.offset}`, source: "strata-twin-model",
              reason: "Unsupported telemetry schema or site", sourcePartition: partition, sourceOffset: record.offset, group, original: value});
            if (!dlq) break;
            state.counters.deadLetter += 1;
          } else if (group === "storage") {
            const created = object(state, `telemetry/${value.site}/${value.eventId}.json`, value);
            if (created) state.counters.stored += 1; else state.counters.duplicates += 1;
          } else if (Object.hasOwn(state.detections, value.eventId)) state.counters.duplicates += 1;
          else { detect(state, value); state.detections[value.eventId] = {tick: value.tick, site: value.site}; state.counters.detected += 1; }
          state.groups[group][partition] = record.offset + 1;
        }
      }
    }
  }
  function engineeringContext() { return {assert, clone, site, snap, id, observe, healthy, finishJob, lag, canonical}; }
  function traffic(state) {
    E.prepare(state);
    const candidates = Object.values(state.sites).map((value) => {
      for (const link of Object.values(value.links)) if (state.tick - link.changedAt >= 3) link.knownUp = link.up;
      if (value.convergence > 0) value.convergence -= 1;
      if (value.convergence === 0) {
        const choices = Object.entries(value.links).filter(([, link]) => link.knownUp)
          .sort(([a], [b]) => (b === "primary" ? 100 : value.config.backupPreference) - (a === "primary" ? 100 : value.config.backupPreference));
        value.selected = choices[0]?.[0] || null;
      }
      const link = value.selected ? value.links[value.selected] : null;
      const condition = E.conditions(state,value);
      const available = Boolean(link?.up && condition.routerUp && !condition.mtuBlackhole); const capacity = value.selected === "backup" ? value.config.backupCapacity : value.config.primaryCapacity;
      return {value, link, available, capacity, delivered: available ? Math.min(value.demand, capacity) * (1 - link.loss / 100) : 0};
    });
    const regional = {};
    for (const c of candidates) regional[c.value.region] = (regional[c.value.region] || 0) + c.delivered;
    for (const c of candidates) {c.regionalScale = Math.min(1,state.regions[c.value.region].capacity / Math.max(1,regional[c.value.region]));c.delivered *= c.regionalScale;}
    const aggregate = candidates.reduce((total, c) => total + c.delivered, 0); const scale = Math.min(1,state.core.capacity / Math.max(1,aggregate));
    for (const c of candidates) {
      const throughput = c.delivered * scale;
      const loss = c.available ? 100 * (1 - (1 - c.link.loss / 100) * Math.min(1, c.capacity / Math.max(c.value.demand, 1)) * scale * c.regionalScale) : 100;
      const metric = {schema: 1, source: "strata-twin-model", eventId: id(state, "metric"), tick: state.tick, site: c.value.id,
        selectedPath: c.value.selected, available: c.available, latencyMs: c.available ? round(c.link.latency + c.link.delay + Math.max(0, c.value.demand / c.capacity - 1) * 20 + (c.value.region === "LEGACY" ? 0 : Math.max(0,regional[c.value.region]/state.regions[c.value.region].capacity-1)*20)) : null,
        lossPct: round(loss), throughputMbps: round(throughput), demandMbps: c.value.demand, coreCapacityMbps: state.core.capacity, regionalCapacityMbps: state.regions[c.value.region].capacity};
      E.enrich(state,c.value,metric);
      c.value.metrics = metric;
      c.value.observedContext = snap(c.value);
      publish(state, "telemetry", c.value.index % 3, metric);
    }
  }
  function finishJob(state, value) {
    value.finishedAt = state.tick; const target = site(state, value.site);
    value.after = snap(target); value.artifact = `changes/${value.id}.json`;
    const payload = {eventId: id(state, "change-event"), source: "strata-twin-model", jobId: value.id, site: value.site, state: value.state,
      before: value.before, after: value.after, observations: clone(value.observations), rollback: value.rollback || null, affected: value.affected || [value.site], probeIds: value.probeIds || [], scopeObservations: value.scopeObservations || [], resources: value.resources || null, kind: value.kind || "Modeled routing policy"};
    const receipt = publish(state, "changes", target.index % 3, payload);
    value.delivery = receipt ? "event_acknowledged" : "outbox_pending";
    value.evidenceState = state.services.storage ? "stored_in_model" : "storage_pending";
    if (state.services.storage) object(state, value.artifact, payload);
    else value.pendingArtifact = payload;
    observe(state, "executor", value.state, `${value.id}: ${value.action}`, {jobId: value.id});
  }
  function verification(state) {
    for (const value of state.jobs.filter((j) => j.state === "executing" && !j.engineering)) {
      const target = site(state, value.site);
      if (state.tick < value.startedAt + 2) continue;
      value.observations.push(clone(target.metrics));
      if (value.observations.length < 3) continue;
      if (value.observations.every(healthy)) value.state = "verified";
      else { target.config = clone(value.before.config); target.revision += 1; target.convergence = 2;
        value.rollback = {configRestoredAt: state.tick, recovery: "pending", observations: []}; value.state = "rolling_back";
        observe(state, "executor", "rollback_started", `${value.id}: modeled verification failed; restoring candidate baseline`); }
      if (value.state === "verified") finishJob(state, value);
    }
    for (const value of state.jobs.filter((j) => j.state === "rolling_back" && !j.engineering)) {
      if (state.tick < value.rollback.configRestoredAt + 2) continue;
      value.rollback.observations.push(clone(site(state, value.site).metrics));
      if (value.rollback.observations.length >= 2) {
        value.rollback.recovery = value.rollback.observations.every(healthy) ? "modeled_path_recovered" : "path_still_degraded";
        value.state = "rolled_back"; finishJob(state, value);
      }
    }
  }
  function applyFault(state, c, actor) {
    assert(faultTypes.includes(c.fault), "Unsupported fault");
      if (["broker_down", "storage_down", "detector_down", "core_down"].includes(c.fault)) {
        assert(typeof c.value === "boolean", "Fault toggle must be boolean");
        const key = {broker_down: "broker", storage_down: "storage", detector_down: "detector", core_down: "mobileCore"}[c.fault]; state.services[key] = !c.value;
      } else {
        const target = site(state, c.site);
        if (["primary_down", "backup_down"].includes(c.fault)) {
          assert(typeof c.value === "boolean", "Link toggle must be boolean"); const link = target.links[c.fault.split("_")[0]];
          if (link.up !== !c.value) {link.up = !c.value; link.changedAt = state.tick;}
        } else if (c.fault === "radio_down") {assert(typeof c.value === "boolean", "Cell toggle must be boolean"); target.radioUp = !c.value;}
        else {const range = {primary_delay: [0, 250], primary_loss: [0, 40], demand: [1, 1000]}[c.fault];
          assert(Number.isFinite(c.value) && c.value >= range[0] && c.value <= range[1], "Fault value outside model bounds");
          if (c.fault === "demand") target.demand = c.value; else target.links.primary[c.fault === "primary_delay" ? "delay" : "loss"] = c.value;}
      }
      observe(state, actor, "fault", `${["broker_down", "storage_down", "detector_down", "core_down"].includes(c.fault) ? "platform" : c.site}: ${c.fault} = ${c.value}`);
  }
  function scheduleFault(state, c, actor, experimentId = null) {
    assert(Number.isInteger(c.after) && c.after >= 1 && c.after <= 120, "Schedule 1–120 ticks ahead");
    assert(state.tick + c.after <= 1500, "Scheduled fault exceeds the 1500-tick session limit");
    assert(state.schedule.filter((entry) => entry.state === "pending").length < 16, "At most 16 faults may be pending");
    applyFault(clone(state), c, actor); // Validate without altering the current world.
    const entry = {id: id(state, "schedule"), site: ["broker_down", "storage_down", "detector_down", "core_down"].includes(c.fault) ? null : c.site, fault: c.fault, value: c.value,
      createdAt: state.tick, at: state.tick + c.after, state: "pending", experimentId};
    state.schedule.push(entry); observe(state, actor, "fault_scheduled", `${entry.id}: ${entry.fault} at T+${entry.at}`);
  }
  function allocateWeighted(peers, capacity) {
    const allocation = new Map(peers.map((p) => [p.id, 0])); let remaining = Math.max(0, capacity); let waiting = peers.slice();
    while (waiting.length && remaining > 1e-9) {
      const weights = waiting.reduce((n, p) => n + slices[p.sliceKey].weight, 0);
      const capped = waiting.filter((p) => p.maxMbps <= remaining * slices[p.sliceKey].weight / weights);
      if (!capped.length) {for (const p of waiting) allocation.set(p.id, remaining * slices[p.sliceKey].weight / weights); break;}
      for (const p of capped) {allocation.set(p.id, p.maxMbps); remaining -= p.maxMbps;}
      waiting = waiting.filter((p) => !capped.includes(p));
    }
    return new Map([...allocation].map(([id, value]) => [id, Math.floor((value + 1e-9) * 100) / 100]));
  }
  function sessions(state) {
    const reject = (session, cause) => {
      if (session.handover?.state === "pending") {session.handover.state = "failed"; session.handover.finishedAt = state.tick;}
      session.state = "rejected"; session.cause = cause; session.address = null; session.throughputMbps = 0;
      observe(state, "mobile-core", "session_rejected", `${session.id}: ${cause}`);
    };
    for (const session of state.sessions.filter((s) => !["released", "rejected"].includes(s.state))) {
      if (!state.services.mobileCore) {reject(session, "Core unavailable"); continue;}
      if (session.state === "handover_pending") {
        if (state.tick < session.handover.startedAt + 2) {session.throughputMbps = 0; continue;}
        const destination = site(state, session.handover.target);
        if (destination.radioUp && destination.metrics?.radioHealthy !== false) {
          session.site = destination.id; session.state = "pdu_active"; session.handover.state = "completed"; session.handover.finishedAt = state.tick;
          observe(state, "mobile-core", "handover_completed", `${session.id}: ${session.handover.source} → ${session.site}; IP retained`);
        } else if (site(state, session.handover.source).radioUp && site(state, session.handover.source).metrics?.radioHealthy !== false) {
          session.state = "pdu_active"; session.handover.state = "fallback"; session.handover.finishedAt = state.tick;
          observe(state, "mobile-core", "handover_fallback", `${session.id}: destination cell unavailable; returned to source`);
        } else {session.handover.state = "failed"; session.handover.finishedAt = state.tick; reject(session, "Both cells unavailable");}
        continue;
      }
      const target = site(state, session.site);
      if (!target.radioUp || target.metrics?.radioHealthy === false) reject(session, "Cell unavailable");
      else if (session.state === "registration_pending" && state.tick >= session.startedAt + 1) {
        session.state = "registered"; observe(state, "mobile-core", "registered", session.id);
      } else if (session.state === "registered" && state.tick >= session.startedAt + 2) {
        session.state = "pdu_active"; const used = new Set(state.sessions.map((s) => s.address));
        let host = 2; while (used.has(`10.45.0.${host}`)) host += 1; session.address = `10.45.0.${host}`;
        observe(state, "mobile-core", "pdu_active", `${session.id}: ${session.address}, slice ${session.slice}`);
      }
    }
    for (const target of Object.values(state.sites)) {
      const peers = state.sessions.filter((s) => s.state === "pdu_active" && s.site === target.id);
      const allocations = allocateWeighted(peers, Math.min(target.metrics?.radioBudgetMbps ?? 40, target.metrics?.throughputMbps || 0));
      for (const session of peers) session.throughputMbps = allocations.get(session.id);
    }
    for (const lease of state.leases.filter((lease) => lease.expiresAt <= state.tick))
      observe(state, "dhcp", "lease_expired", `${lease.site}: ${lease.client}, ${lease.address}`);
    state.leases = state.leases.filter((lease) => lease.expiresAt > state.tick);
  }
  function tick(state) {
    state.tick += 1;
    for (const entry of state.schedule.filter((entry) => entry.state === "pending" && entry.at === state.tick)) {
      applyFault(state, {site: entry.site, fault: entry.fault, value: entry.value}, "scheduler");
      entry.state = "applied"; entry.appliedAt = state.tick; observe(state, "scheduler", "scheduled_fault_applied", entry.id);
    }
    if (state.services.broker) {
      const pending = state.outbox; state.outbox = [];
      for (const message of pending) emit(state, message.topic, message.partition, message.payload);
      for (const value of state.jobs) if (value.delivery === "outbox_pending") value.delivery = "event_acknowledged";
    }
    if (state.services.storage) for (const value of state.jobs.filter((j) => j.pendingArtifact)) {
      object(state, value.artifact, value.pendingArtifact); delete value.pendingArtifact; value.evidenceState = "stored_in_model";
    }
    traffic(state); consume(state); sessions(state); verification(state); E.verify(state,engineeringContext());
    state.history.push({tick: state.tick, sites: Object.fromEntries(Object.values(state.sites).map((target) => [target.id, clone(target.metrics)]))});
  }
  function validateCommand(command) {
    assert(command && typeof command === "object" && !Array.isArray(command), "Invalid command");
    const keys = ["type", "site", "actor", "ticks", "fault", "value", "action", "reason", "jobId", "client", "subscriber", "sessionId", "slice", "after", "scheduleId", "scenarioId", "caseId", "probe", "plan"];
    assert(Object.keys(command).every((key) => keys.includes(key)), "Unknown command field");
    assert(typeof command.type === "string", "Command type is required");
    if (command.plan !== undefined) assert(command.type === "PROPOSE" && command.action === "capacity_plan", "Capacity plan is only valid for its proposal");
    for (const key of ["site", "actor", "fault", "action", "reason", "jobId", "client", "subscriber", "sessionId", "slice", "scheduleId", "scenarioId", "caseId", "probe"])
      if (command[key] !== undefined) assert(typeof command[key] === "string" && command[key].length <= 200, "Invalid command string");
  }
  function dispatch(state, command) {
    validateCommand(command); assert(state.commands.length < MAX_COMMANDS, "Session limit reached. Export this run and reset before continuing");
    const c = clone(command); const actor = c.actor || "operator";
    assert(["operator", "reviewer", "system"].includes(actor), "Unknown modeled actor");
    if (E.handles(state,c)) { E.handle(state,c,actor,engineeringContext());
    } else if (c.type === "ADVANCE") {
      assert(Number.isInteger(c.ticks) && c.ticks >= 1 && c.ticks <= 30, "Advance 1–30 ticks at a time");
      assert(state.tick + c.ticks <= 1500, "Session limit is 1500 ticks. Export and reset to continue");
      for (let i = 0; i < c.ticks; i++) tick(state);
    } else if (c.type === "FAULT") {
      assert(actor === "operator", "Only the modeled operator can inject faults"); assert(faultTypes.includes(c.fault), "Unsupported fault");
      applyFault(state, c, actor);
    } else if (c.type === "SCHEDULE_FAULT") {
      assert(actor === "operator", "Modeled operator required"); scheduleFault(state, c, actor);
    } else if (c.type === "CANCEL_SCHEDULE") {
      assert(actor === "operator", "Modeled operator required");
      const entry = state.schedule.find((entry) => entry.id === c.scheduleId);
      assert(entry && entry.state === "pending", "Only a pending fault can be cancelled");
      entry.state = "cancelled"; entry.cancelledAt = state.tick; observe(state, actor, "schedule_cancelled", entry.id);
    } else if (c.type === "APPLY_SCENARIO") {
      assert(actor === "operator", "Modeled operator required"); site(state, c.site);
      assert(Object.hasOwn(scenarios, c.scenarioId), "Unknown scenario");
      const experiment = {id: id(state, "experiment"), scenario: c.scenarioId, site: c.site, startedAt: state.tick};
      state.experiments.push(experiment); const other = Object.keys(state.sites).find((id) => id !== c.site);
      const plans = {
        failover: [[2, "primary_down", true, c.site], [12, "primary_down", false, c.site]],
        congestion: [[2, "demand", 500, c.site], [2, "demand", 500, other], [16, "demand", 100, c.site], [16, "demand", 100, other]],
        streaming: [[3, "broker_down", true], [6, "storage_down", true], [12, "broker_down", false], [18, "storage_down", false]],
        mobility: [[8, "radio_down", true, c.site], [14, "radio_down", false, c.site]],
      };
      for (const [after, fault, value, target] of plans[c.scenarioId])
        scheduleFault(state, {after, fault, value, ...(target ? {site: target} : {})}, actor, experiment.id);
      observe(state, actor, "experiment_started", `${experiment.id}: ${scenarios[c.scenarioId].label}`);
    } else if (c.type === "PROPOSE") {
      assert(actor === "operator", "Only the modeled operator can propose a change"); const target = site(state, c.site);
      assert(Object.hasOwn(actions, c.action), "Unsupported change"); assert(typeof c.reason === "string" && c.reason.trim().length >= 5, "A reason is required");
      assert(!state.jobs.some((j) => (j.site === c.site || (j.affected || []).includes(c.site)) && ["executing", "rolling_back"].includes(j.state)), "This site already has an active change");
      const before = snap(target); const candidate = {...target.config, [actions[c.action].field]: actions[c.action].value};
      assert(canonical(candidate) !== canonical(target.config), "Candidate is identical to running configuration");
      const value = {id: id(state, "job"), site: c.site, action: c.action, reason: c.reason.trim(), author: actor,
        state: "proposed", createdAt: state.tick, expiresAt: state.tick + 60, before, candidate, observations: [], approval: null};
      state.jobs.push(value); observe(state, actor, "change_proposed", `${value.id}: candidate captured with configuration revision ${target.revision}`);
    } else if (c.type === "APPROVE") {
      const value = job(state, c.jobId); assert(actor === "reviewer" && actor !== value.author, "Independent modeled reviewer required");
      assert(value.state === "proposed" && state.tick < value.expiresAt, "Proposal is no longer reviewable");
      value.state = "approved"; value.approval = {actor, tick: state.tick}; observe(state, actor, "change_approved", value.id);
    } else if (c.type === "EXECUTE") {
      assert(actor === "operator", "Only the modeled operator can execute an approved change"); const value = job(state, c.jobId); const target = site(state, value.site);
      assert(value.state === "approved" && value.approval && state.tick < value.expiresAt, "Current independent approval required");
      assert(!state.jobs.some((j) => j.id !== value.id && (j.site === value.site || (j.affected || []).includes(value.site)) && ["executing", "rolling_back"].includes(j.state)), "This site already has an active change");
      assert(canonical(snap(target)) === canonical(value.before), "Configuration or intent changed; propose and review again");
      target.config = clone(value.candidate); target.revision += 1; target.convergence = 2;
      value.startedAt = state.tick; value.state = "executing"; observe(state, actor, "change_executing", value.id);
    } else if (c.type === "DRIFT") {
      assert(actor === "operator", "Only the modeled operator can inject drift"); const target = site(state, c.site);
      assert(!state.jobs.some((j) => (j.site === c.site || (j.affected || []).includes(c.site)) && ["executing", "rolling_back"].includes(j.state)), "Wait for the active change before injecting drift");
      target.config.backupPreference = target.config.backupPreference === 80 ? 200 : 80; target.revision += 1; target.convergence = 2;
      observe(state, actor, "configuration_drift", `${c.site}: running preference changed outside reviewed workflow`);
    } else if (c.type === "ACCEPT_INTENT") {
      assert(actor === "reviewer", "Modeled reviewer required"); const value = job(state, c.jobId);
      assert(value.state === "verified", "Only a verified change can update intent"); const target = site(state, value.site);
      assert(canonical(target.config) === canonical(value.candidate) && target.revision === value.after.revision, "Running state changed since verification");
      assert(!value.intentAcceptedAt, "Intent has already been accepted"); target.intent = clone(value.candidate); value.intentAcceptedAt = state.tick; state.inventoryRevision += 1;
      observe(state, actor, "intent_updated", `${value.id}: approved candidate becomes intended configuration`);
    } else if (c.type === "LEASE") {
      assert(actor === "operator", "Modeled operator required"); const target = site(state, c.site);
      assert(typeof c.client === "string" && /^[a-zA-Z0-9-]{1,32}$/.test(c.client), "Use a simple client ID");
      const current = state.leases.find((l) => l.site === c.site && l.client === c.client);
      if (current) current.expiresAt = state.tick + 30;
      else {const used = new Set(state.leases.filter((l) => l.site === c.site).map((l) => l.address)); const start = prefix(target.service).start;
        let host = 10; while (host <= 49 && used.has(ip(start + host))) host++;
        assert(host <= 49, "Modeled DHCP pool exhausted"); state.leases.push({site: c.site, client: c.client, address: ip(start + host), vlan: target.serviceVlan,
          dns: `${c.site.toLowerCase()}.lab.test`, expiresAt: state.tick + 30});}
      observe(state, actor, "lease_allocated", `${c.site}: ${c.client}`);
    } else if (c.type === "REGISTER_UE") {
      assert(actor === "operator", "Modeled operator required"); site(state, c.site);
      assert(typeof c.subscriber === "string" && /^[a-zA-Z0-9-]{1,32}$/.test(c.subscriber), "Use a simple subscriber ID");
      assert(!state.sessions.some((s) => s.subscriber === c.subscriber && !["released", "rejected"].includes(s.state)), "Subscriber already has a registration");
      const sliceKey = c.slice || "broadband"; assert(Object.hasOwn(slices, sliceKey), "Unknown network slice");
      const profile = slices[sliceKey];
      const admitted = /^demo-[1-6]$/.test(c.subscriber) && state.sessions.filter((s) => !["released", "rejected"].includes(s.state)).length < 6;
      const value = {id: id(state, "ue"), site: c.site, subscriber: c.subscriber, state: admitted ? "registration_pending" : "rejected",
        cause: admitted ? null : "Unknown subscriber or slice admission limit", startedAt: state.tick, address: null, slice: profile.id, sliceKey, dnn: "internet", maxMbps: profile.maxMbps, throughputMbps: 0, handover: null};
      state.sessions.push(value); observe(state, "mobile-core", "registration_requested", `${value.subscriber}: ${value.state}`);
    } else if (c.type === "HANDOVER_UE") {
      assert(actor === "operator", "Modeled operator required");
      const value = state.sessions.find((s) => s.id === c.sessionId); const destination = site(state, c.site);
      assert(value && value.state === "pdu_active", "An active PDU session is required");
      assert(value.site !== c.site, "Choose a different destination site");
      assert(state.services.mobileCore && destination.radioUp, "Destination cell and mobile core must be available");
      value.handover = {state: "pending", source: value.site, target: c.site, startedAt: state.tick, finishedAt: null};
      value.state = "handover_pending"; value.throughputMbps = 0;
      observe(state, actor, "handover_started", `${value.id}: ${value.site} → ${c.site}; two-tick interruption`);
    } else if (c.type === "RELEASE_UE") {
      assert(actor === "operator", "Modeled operator required"); const value = state.sessions.find((s) => s.id === c.sessionId);
      assert(value && !["released", "rejected"].includes(value.state), "No active registration");
      if (value.handover?.state === "pending") {value.handover.state = "cancelled"; value.handover.finishedAt = state.tick;}
      value.state = "released"; value.address = null; value.throughputMbps = 0;
      observe(state, actor, "session_released", value.id);
    } else if (c.type === "INVALID_EVENT") {
      assert(actor === "operator", "Modeled operator required"); const target = site(state, c.site);
      publish(state, "telemetry", target.index % 3, {eventId: id(state, "invalid"), schema: 99, source: "strata-twin-model", site: target.id});
      observe(state, actor, "invalid_event_injected", `${c.site}: schema version 99`);
    } else if (c.type === "REDRIVE") {
      assert(actor === "operator", "Modeled operator required"); const target = site(state, c.site);
      assert(target.metrics, "Advance the clock to collect a modeled observation first");
      publish(state, "telemetry", target.index % 3, target.metrics); observe(state, actor, "event_redelivered", target.metrics.eventId);
    } else throw new Error("Unsupported command type");
    state.commands.push(c);
    return state;
  }
  function step(state, command) { const next = clone(state); return dispatch(next, command); }
  function exportRun(state, catalog) {
    return {format: "strata-twin-run", version: VERSION, source: "strata-twin-model", siteDesigns: clone(catalog.sites),
      commands: clone(state.commands), assumptions: clone(assumptions), finalState: clone(state)};
  }
  function replay(run) {
    if (run?.format === "strata-twin-journal") return replayJournal(run);
    assert(run && run.format === "strata-twin-run" && run.version === VERSION && run.source === "strata-twin-model", "Unsupported run format or model version");
    assert(Array.isArray(run.commands) && run.commands.length <= MAX_COMMANDS, "Run exceeds replay limit");
    assert(run.finalState && typeof run.finalState === "object" && !Array.isArray(run.finalState), "Run must include its claimed final state");
    assert(run.commands.reduce((n, c) => n + (c?.type === "ADVANCE" && Number.isInteger(c.ticks) ? c.ticks : 0), 0) <= 1500, "Run exceeds 1500-tick replay limit");
    const state = initial({sites: run.siteDesigns});
    for (const command of run.commands) dispatch(state, command);
    assert(canonical(state) === canonical(run.finalState), "Replay differs from exported state");
    return state;
  }
  function migrate(run) {
    if (run?.version === VERSION) return replay(run);
    assert((Legacy && run?.version === "1.0.0") || (V2 && run?.version === "2.0.0"), "Unsupported run format or model version");
    (run.version === "1.0.0" ? Legacy : V2).replay(run); // Verify the original claimed result before interpreting commands under v2 rules.
    const state = initial({sites: run.siteDesigns});
    for (const command of run.commands) dispatch(state, command); return state;
  }
  function journalSummary(state) {
    return {tick:state.tick,serial:state.serial,inventoryRevision:state.inventoryRevision,
      sites:Object.fromEntries(Object.values(state.sites).map(s=>[s.id,{...snap(s),metrics:clone(s.metrics),equipment:clone(s.equipment)}])),
      services:clone(state.services),regions:clone(state.regions),core:clone(state.core),jobs:clone(state.jobs),cases:clone(state.cases),probes:clone(state.probes),
      counters:clone(state.counters),groups:clone(state.groups),outboxCount:state.outbox.length,incidents:clone(state.incidents),sessions:clone(state.sessions),leases:clone(state.leases),schedule:clone(state.schedule)};
  }
  function exportJournal(state,catalog) {
    return {format:"strata-twin-journal",version:VERSION,source:"strata-twin-model",siteDesigns:clone(catalog.sites),commands:clone(state.commands),
      finalSummary:journalSummary(state),boundary:"Replay reconstructs full telemetry, history and object evidence from commands, then verifies this structural final summary. This is not a signed attestation or authentication mechanism."};
  }
  function replayJournal(run) {
    assert(run.version===VERSION && run.source==="strata-twin-model","Unsupported journal version or source");
    assert(Array.isArray(run.commands) && run.commands.length<=MAX_COMMANDS,"Journal exceeds replay limit");
    assert(run.commands.reduce((n,c)=>n+(c?.type==="ADVANCE"&&Number.isInteger(c.ticks)?c.ticks:0),0)<=1500,"Journal exceeds 1500-tick replay limit");
    const state=initial({sites:run.siteDesigns});for(const command of run.commands)dispatch(state,command);
    assert(canonical(journalSummary(state))===canonical(run.finalSummary),"Replay differs from journal summary");return state;
  }
  function summarizeMetrics(metrics) {
    const count = metrics.length; const latencies = metrics.filter((m) => Number.isFinite(m.latencyMs)).map((m) => m.latencyMs);
    const average = (values) => values.length ? round(values.reduce((n, v) => n + v, 0) / values.length) : null;
    return {observations: count, healthyTicks: metrics.filter(healthy).length, outageTicks: metrics.filter((m) => !m.available).length,
      slaPct: count ? round(100 * metrics.filter(healthy).length / count) : null,
      averageLatencyMs: average(latencies), averageThroughputMbps: average(metrics.map((m) => m.throughputMbps)),
      averageLossPct: average(metrics.map((m) => m.lossPct))};
  }
  function summarize(state, siteId, window = 60) {
    site(state, siteId); assert(Number.isInteger(window) && window > 0 && window <= 1500, "Invalid observation window");
    return summarizeMetrics(state.history.slice(-window).map((frame) => frame.sites[siteId]));
  }
  function forecast(state, request) {
    assert(request && Object.hasOwn(actions, request.action), "Unsupported forecast action"); site(state, request.site);
    const horizon = request.horizon ?? 12;
    assert(Number.isInteger(horizon) && horizon >= 8 && horizon <= 30, "Forecast horizon must be 8–30 ticks");
    assert(state.tick + horizon <= 1500, "Forecast exceeds the session limit");
    const baseline = clone(state); const candidate = clone(state);
    assert(candidate.commands.length + 3 < MAX_COMMANDS, "Export and reset before forecasting more changes");
    dispatch(candidate, {type: "PROPOSE", site: request.site, action: request.action, ...(request.plan ? {plan:request.plan} : {}), reason: "Detached what-if experiment", actor: "operator"});
    const jobId = candidate.jobs.at(-1).id;
    dispatch(candidate, {type: "APPROVE", jobId, actor: "reviewer"}); dispatch(candidate, {type: "EXECUTE", jobId, actor: "operator"});
    for (let n = 0; n < horizon; n++) {tick(baseline); tick(candidate);}
    const compare = Object.keys(state.sites).map((id) => {
      const before = summarizeMetrics(baseline.history.slice(-horizon).map((f) => f.sites[id]));
      const after = summarizeMetrics(candidate.history.slice(-horizon).map((f) => f.sites[id]));
      return {site: id, baseline: before, candidate: after, delta: {
        slaPoints: round(after.slaPct - before.slaPct), throughputMbps: round(after.averageThroughputMbps - before.averageThroughputMbps),
        latencyMs: after.averageLatencyMs == null || before.averageLatencyMs == null ? null : round(after.averageLatencyMs - before.averageLatencyMs)}};
    });
    return {source: "strata-twin-forecast", version: VERSION, inputTick: state.tick, horizon, site: request.site, action: request.action,
      job: clone(candidate.jobs.find((j) => j.id === jobId)), comparison: compare,
      boundary: "Deterministic model branch with the same scheduled faults, convergence and rollback rules. Actual state and approvals are unchanged. No AI or field prediction is used."};
  }
  function lag(state, group) { return state.topics.telemetry.reduce((n, records, p) => n + records.length - state.groups[group][p], 0); }
  function nativeFrr(state, siteId) {
    const value = site(state, siteId); const management = ip(prefix(value.management).start + 1);
    return ["! Strata Twin export: candidate for the matching isolated Docker lab, not a running router snapshot", "frr defaults traditional",
      `hostname ${value.id}`, "service integrated-vtysh-config", `ip prefix-list LOCAL seq 10 permit ${value.service}`,
      `ip prefix-list LOCAL seq 20 permit ${management}/32`, "ip prefix-list CORE seq 10 permit 10.90.0.0/24",
      "route-map PRIMARY permit 10", " match ip address prefix-list CORE", " set local-preference 100", "route-map SECONDARY permit 10",
      " match ip address prefix-list CORE", ` set local-preference ${value.config.backupPreference}`, "route-map EXPORT permit 10", " match ip address prefix-list LOCAL",
      `router bgp ${value.asn}`, ` bgp router-id ${management}`, " neighbor 10.250.0.1 remote-as 65100", " neighbor 10.251.0.1 remote-as 65200",
      " address-family ipv4 unicast", `  network ${value.service}`, `  network ${management}/32`, "  neighbor 10.250.0.1 route-map PRIMARY in",
      "  neighbor 10.251.0.1 route-map SECONDARY in", "  neighbor 10.250.0.1 route-map EXPORT out", "  neighbor 10.251.0.1 route-map EXPORT out", " exit-address-family", ""].join("\n");
  }
  return {VERSION, MAX_COMMANDS, assumptions, actions, slices, scenarios, cases:E.cases, probes:E.probes, diagnose:E.diagnose, initial, step, exportRun, exportJournal, replay, migrate, summarize, forecast, lag, nativeFrr, canonical, prefix, healthy};
});
