/* Strata Twin: deterministic operational model, not a protocol or vendor emulator. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StrataTwinLegacy = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const VERSION = "1.0.0";
  const MAX_COMMANDS = 1200;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const sorted = (value) => Array.isArray(value) ? value.map(sorted) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
  const canonical = (value) => JSON.stringify(sorted(value));
  const round = (value) => Math.round(value * 100) / 100;
  const assumptions = [
    "One tick is one simulated second; the clock advances only on command.",
    "Routing models local preference, a 3-tick failure detection delay and 2-tick configuration convergence. No BGP packets are exchanged.",
    "Fluid traffic model: demand is capped by link capacity, loss and a shared 500 Mbps core. This is not a TCP/packet simulator.",
    "Mobile registration, slice admission and address allocation are state machines. No NAS, SCTP, GTP, SIM cryptography or RF propagation runs here.",
    "Three event partitions, independent consumer offsets, acknowledge-before-commit, outbox retry and event-ID deduplication are modeled in browser memory.",
    "Object versions, monitoring confirmations and workflow review are modeled. No vendor REST API, database, consensus or production authentication is emulated.",
    "Scenario state is local to this browser. Exported command logs can be replayed; no background execution or shared cloud database is configured.",
  ];
  const actions = {
    prefer_backup: {label: "Prefer backup path", field: "backupPreference", value: 200},
    restore_primary: {label: "Restore primary preference", field: "backupPreference", value: 80},
    expand_backup: {label: "Increase backup capacity to 350 Mbps", field: "backupCapacity", value: 350},
  };
  const faultTypes = ["primary_down", "backup_down", "primary_delay", "primary_loss", "demand", "broker_down", "storage_down", "detector_down", "core_down", "radio_down"];
  function assert(value, message) { if (!value) throw new Error(message); }
  function initial(catalog) {
    assert(catalog && Array.isArray(catalog.sites) && catalog.sites.length === 3, "Exactly three site designs are required");
    const state = {version: VERSION, tick: 0, serial: 0, commands: [], audit: [], jobs: [], incidents: [],
      inventoryRevision: 1, sites: {}, services: {broker: true, storage: true, detector: true, mobileCore: true},
      topics: {}, outbox: [], objects: {}, detections: {}, receipts: [], sessions: [], leases: [], failures: [],
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
        links: {primary: {up: true, knownUp: true, changedAt: 0, latency: 8 + index * 3, delay: 0, loss: 0, capacity: 250},
                backup: {up: true, knownUp: true, changedAt: 0, latency: 20 + index * 3, delay: 0, loss: 0, capacity: 180}}, metrics: null};
    }
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
    context: {demand: value.demand, radioUp: value.radioUp, links: Object.fromEntries(Object.entries(value.links)
      .map(([name, link]) => [name, {up: link.up, delay: link.delay, loss: link.loss}]))}}; }
  function job(state, jobId) { const value = state.jobs.find((j) => j.id === jobId); assert(value, "Unknown change"); return value; }
  function healthy(metric) { return metric && metric.available && metric.lossPct <= 5 && Number.isFinite(metric.latencyMs)
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
          evidence: [metric.eventId], reason: !metric.available ? "Path unavailable" : metric.lossPct > 5 ? "Packet loss above threshold" : metric.latencyMs > 50 ? "Latency above threshold" : "Capacity shortfall"});
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
  function traffic(state) {
    const candidates = Object.values(state.sites).map((value) => {
      for (const link of Object.values(value.links)) if (state.tick - link.changedAt >= 3) link.knownUp = link.up;
      if (value.convergence > 0) value.convergence -= 1;
      if (value.convergence === 0) {
        const choices = Object.entries(value.links).filter(([, link]) => link.knownUp)
          .sort(([a], [b]) => (b === "primary" ? 100 : value.config.backupPreference) - (a === "primary" ? 100 : value.config.backupPreference));
        value.selected = choices[0]?.[0] || null;
      }
      const link = value.selected ? value.links[value.selected] : null;
      const available = Boolean(link?.up); const capacity = value.selected === "backup" ? value.config.backupCapacity : 250;
      return {value, link, available, capacity, delivered: available ? Math.min(value.demand, capacity) * (1 - link.loss / 100) : 0};
    });
    const aggregate = candidates.reduce((total, c) => total + c.delivered, 0); const scale = aggregate > 500 ? 500 / aggregate : 1;
    for (const c of candidates) {
      const throughput = c.delivered * scale;
      const loss = c.available ? 100 * (1 - (1 - c.link.loss / 100) * Math.min(1, c.capacity / Math.max(c.value.demand, 1)) * scale) : 100;
      const metric = {schema: 1, source: "strata-twin-model", eventId: id(state, "metric"), tick: state.tick, site: c.value.id,
        selectedPath: c.value.selected, available: c.available, latencyMs: c.available ? round(c.link.latency + c.link.delay + Math.max(0, c.value.demand / c.capacity - 1) * 20) : null,
        lossPct: round(loss), throughputMbps: round(throughput), demandMbps: c.value.demand, coreCapacityMbps: 500};
      c.value.metrics = metric;
      publish(state, "telemetry", c.value.index, metric);
    }
  }
  function finishJob(state, value) {
    value.finishedAt = state.tick; const target = site(state, value.site);
    value.after = snap(target); value.artifact = `changes/${value.id}.json`;
    const payload = {eventId: id(state, "change-event"), source: "strata-twin-model", jobId: value.id, site: value.site, state: value.state,
      before: value.before, after: value.after, observations: clone(value.observations), rollback: value.rollback || null};
    const receipt = publish(state, "changes", target.index, payload);
    value.delivery = receipt ? "event_acknowledged" : "outbox_pending";
    value.evidenceState = state.services.storage ? "stored_in_model" : "storage_pending";
    if (state.services.storage) object(state, value.artifact, payload);
    else value.pendingArtifact = payload;
    observe(state, "executor", value.state, `${value.id}: ${value.action}`, {jobId: value.id});
  }
  function verification(state) {
    for (const value of state.jobs.filter((j) => j.state === "executing")) {
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
    for (const value of state.jobs.filter((j) => j.state === "rolling_back")) {
      if (state.tick < value.rollback.configRestoredAt + 2) continue;
      value.rollback.observations.push(clone(site(state, value.site).metrics));
      if (value.rollback.observations.length >= 2) {
        value.rollback.recovery = value.rollback.observations.every(healthy) ? "modeled_path_recovered" : "path_still_degraded";
        value.state = "rolled_back"; finishJob(state, value);
      }
    }
  }
  function sessions(state) {
    for (const session of state.sessions.filter((s) => !["released", "rejected"].includes(s.state))) {
      const target = site(state, session.site);
      if (!state.services.mobileCore || !target.radioUp) {
        session.state = "rejected"; session.cause = !state.services.mobileCore ? "Core unavailable" : "Cell unavailable"; session.address = null; session.throughputMbps = 0;
        observe(state, "mobile-core", "session_rejected", `${session.id}: ${session.cause}`);
      } else if (session.state === "registration_pending" && state.tick >= session.startedAt + 1) {
        session.state = "registered"; observe(state, "mobile-core", "registered", session.id);
      }
      else if (session.state === "registered" && state.tick >= session.startedAt + 2) {
        session.state = "pdu_active"; const used = new Set(state.sessions.map((s) => s.address));
        let host = 2; while (used.has(`10.45.0.${host}`)) host += 1; session.address = `10.45.0.${host}`;
        observe(state, "mobile-core", "pdu_active", `${session.id}: ${session.address}, slice ${session.slice}`);
      }
    }
    for (const session of state.sessions.filter((s) => s.state === "pdu_active")) {
      const peers = state.sessions.filter((s) => s.state === "pdu_active" && s.site === session.site).length;
      const throughput = site(state, session.site).metrics?.throughputMbps || 0;
      session.throughputMbps = round(Math.min(40 / peers, throughput / peers, session.maxMbps));
    }
    for (const lease of state.leases.filter((lease) => lease.expiresAt <= state.tick))
      observe(state, "dhcp", "lease_expired", `${lease.site}: ${lease.client}, ${lease.address}`);
    state.leases = state.leases.filter((lease) => lease.expiresAt > state.tick);
  }
  function tick(state) {
    state.tick += 1;
    if (state.services.broker) {
      const pending = state.outbox; state.outbox = [];
      for (const message of pending) emit(state, message.topic, message.partition, message.payload);
      for (const value of state.jobs) if (value.delivery === "outbox_pending") value.delivery = "event_acknowledged";
    }
    if (state.services.storage) for (const value of state.jobs.filter((j) => j.pendingArtifact)) {
      object(state, value.artifact, value.pendingArtifact); delete value.pendingArtifact; value.evidenceState = "stored_in_model";
    }
    traffic(state); consume(state); sessions(state); verification(state);
  }
  function validateCommand(command) {
    assert(command && typeof command === "object" && !Array.isArray(command), "Invalid command");
    const keys = ["type", "site", "actor", "ticks", "fault", "value", "action", "reason", "jobId", "client", "subscriber", "sessionId"];
    assert(Object.keys(command).every((key) => keys.includes(key)), "Unknown command field");
    assert(typeof command.type === "string", "Command type is required");
    for (const key of ["site", "actor", "fault", "action", "reason", "jobId", "client", "subscriber", "sessionId"])
      if (command[key] !== undefined) assert(typeof command[key] === "string" && command[key].length <= 200, "Invalid command string");
  }
  function dispatch(state, command) {
    validateCommand(command); assert(state.commands.length < MAX_COMMANDS, "Session limit reached. Export this run and reset before continuing");
    const c = clone(command); const actor = c.actor || "operator";
    assert(["operator", "reviewer", "system"].includes(actor), "Unknown modeled actor");
    if (c.type === "ADVANCE") {
      assert(Number.isInteger(c.ticks) && c.ticks >= 1 && c.ticks <= 30, "Advance 1–30 ticks at a time");
      assert(state.tick + c.ticks <= 1500, "Session limit is 1500 ticks. Export and reset to continue");
      for (let i = 0; i < c.ticks; i++) tick(state);
    } else if (c.type === "FAULT") {
      assert(actor === "operator", "Only the modeled operator can inject faults"); assert(faultTypes.includes(c.fault), "Unsupported fault");
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
      observe(state, actor, "fault", `${c.site || "platform"}: ${c.fault} = ${c.value}`);
    } else if (c.type === "PROPOSE") {
      assert(actor === "operator", "Only the modeled operator can propose a change"); const target = site(state, c.site);
      assert(Object.hasOwn(actions, c.action), "Unsupported change"); assert(typeof c.reason === "string" && c.reason.trim().length >= 5, "A reason is required");
      assert(!state.jobs.some((j) => j.site === c.site && ["executing", "rolling_back"].includes(j.state)), "This site already has an active change");
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
      assert(!state.jobs.some((j) => j.id !== value.id && j.site === value.site && ["executing", "rolling_back"].includes(j.state)), "This site already has an active change");
      assert(canonical(snap(target)) === canonical(value.before), "Configuration or intent changed; propose and review again");
      target.config = clone(value.candidate); target.revision += 1; target.convergence = 2;
      value.startedAt = state.tick; value.state = "executing"; observe(state, actor, "change_executing", value.id);
    } else if (c.type === "DRIFT") {
      assert(actor === "operator", "Only the modeled operator can inject drift"); const target = site(state, c.site);
      assert(!state.jobs.some((j) => j.site === c.site && ["executing", "rolling_back"].includes(j.state)), "Wait for the active change before injecting drift");
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
      const admitted = /^demo-[1-6]$/.test(c.subscriber) && state.sessions.filter((s) => !["released", "rejected"].includes(s.state)).length < 6;
      const value = {id: id(state, "ue"), site: c.site, subscriber: c.subscriber, state: admitted ? "registration_pending" : "rejected",
        cause: admitted ? null : "Unknown subscriber or slice admission limit", startedAt: state.tick, address: null, slice: "1-000001", dnn: "internet", maxMbps: 25, throughputMbps: 0};
      state.sessions.push(value); observe(state, "mobile-core", "registration_requested", `${value.subscriber}: ${value.state}`);
    } else if (c.type === "RELEASE_UE") {
      assert(actor === "operator", "Modeled operator required"); const value = state.sessions.find((s) => s.id === c.sessionId);
      assert(value && !["released", "rejected"].includes(value.state), "No active registration"); value.state = "released"; value.address = null; value.throughputMbps = 0;
      observe(state, actor, "session_released", value.id);
    } else if (c.type === "INVALID_EVENT") {
      assert(actor === "operator", "Modeled operator required"); const target = site(state, c.site);
      publish(state, "telemetry", target.index, {eventId: id(state, "invalid"), schema: 99, source: "strata-twin-model", site: target.id});
      observe(state, actor, "invalid_event_injected", `${c.site}: schema version 99`);
    } else if (c.type === "REDRIVE") {
      assert(actor === "operator", "Modeled operator required"); const target = site(state, c.site);
      assert(target.metrics, "Advance the clock to collect a modeled observation first");
      publish(state, "telemetry", target.index, target.metrics); observe(state, actor, "event_redelivered", target.metrics.eventId);
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
    assert(run && run.format === "strata-twin-run" && run.version === VERSION && run.source === "strata-twin-model", "Unsupported run format or model version");
    assert(Array.isArray(run.commands) && run.commands.length <= MAX_COMMANDS, "Run exceeds replay limit");
    assert(run.finalState && typeof run.finalState === "object" && !Array.isArray(run.finalState), "Run must include its claimed final state");
    assert(run.commands.reduce((n, c) => n + (c?.type === "ADVANCE" && Number.isInteger(c.ticks) ? c.ticks : 0), 0) <= 1500, "Run exceeds 1500-tick replay limit");
    const state = initial({sites: run.siteDesigns});
    for (const command of run.commands) dispatch(state, command);
    assert(canonical(state) === canonical(run.finalState), "Replay differs from exported state");
    return state;
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
  return {VERSION, MAX_COMMANDS, assumptions, actions, initial, step, exportRun, replay, lag, nativeFrr, canonical, prefix, healthy};
});
