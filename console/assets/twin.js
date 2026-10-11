"use strict";
(() => {
  const M = window.StrataTwin;
  const D = window.StrataDevices;
  const V = window.StrataMonitor;
  let nativePack, generatedConfig, plans = {}, drafts = {}, rfSite = "";
  const key = "strata:twin:3";
  const checkpointKey = "strata:twin:checkpoints:3";
  const $t = (selector) => document.querySelector(selector);
  let state, catalog, tabName = "network", initialized = false, timer = null, forecast = null, checkpoints = [];
  const node = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const selected = () => $t("#twin-site").value;
  const actor = () => $t("#twin-actor").value;
  const label = (value) => value.replaceAll("_", " ");
  const number = (value, suffix = "") => value == null ? "—" : `${value}${suffix}`;
  function message(text, error = false) {
    $t("#twin-message").textContent = text;
    $t("#twin-message").classList.toggle("has-error", error);
  }
  function save() {
    try {localStorage.setItem(key, JSON.stringify(M.exportJournal(state, catalog)));}
    catch {message("Browser storage is full or unavailable. This run is in memory; export it before closing this page.", true);}
  }
  function run(command, note = "Model state updated. Advance the clock to observe the effect.") {
    try {
      if (!initialized) throw new Error("Wait for the model to load");
      state = M.step(state, {actor: actor(), ...command}); forecast = null;
      message(note); render(); save(); return true;
    } catch (error) {pause(); message(error.message, true); if (initialized) render(); return false;}
  }
  function button(text, callback, disabled = false, name = "") {
    const value = node("button", "button", text); value.type = "button"; value.disabled = disabled;
    if (name) value.id = name;
    value.addEventListener("click", callback); return value;
  }
  function table(headers, rows, empty = "No modeled records yet. Advance the clock or create an experiment.") {
    if (!rows.length) return node("p", "twin-empty", empty);
    const result = node("table", "twin-table"); const head = node("thead"); const header = node("tr");
    for (const text of headers) header.append(node("th", "", text)); head.append(header); result.append(head);
    const body = node("tbody");
    for (const row of rows) {const tr = node("tr"); for (const value of row) {const td = node("td");
      td.append(value instanceof Node ? value : document.createTextNode(String(value ?? "—"))); tr.append(td);} body.append(tr);}
    result.append(body); return result;
  }
  function json(title, value) {pause(); const pre = node("pre", "twin-json", JSON.stringify(value, null, 2)); detail(title, [pre], "MODELED EVIDENCE");}
  function switchTab(name) {
    if (name === "equipment" && timer) pause("Playback paused for configuration and commissioning work.");
    tabName = name;
    document.querySelectorAll("[data-twin-tab]").forEach((button) => {
      const active = button.dataset.twinTab === name; button.classList.toggle("selected", active); button.setAttribute("aria-pressed", String(active));
    });
    document.querySelectorAll("[data-twin-panel]").forEach((panel) => {panel.hidden = panel.dataset.twinPanel !== name; panel.classList.toggle("twin-panel-enter", !panel.hidden);});
  }
  function stats() {
    const verified = state.jobs.filter((j) => j.state === "verified").length;
    const summary=V.snapshot(state);
    const items=[
      [`${summary.healthy}/${summary.total}`,"Service healthy",`${Object.keys(state.regions).length} regions · calculated conditions`,summary.unknown?"unknown":summary.degraded?"warning":"healthy"],
      [summary.critical,"Critical sites","Transport or radio unavailable",summary.critical?"critical":"healthy"],
      [summary.warning,"Warning sites","Threshold breach / active containment",summary.warning?"warning":"healthy"],
      [summary.delivered===null?"—":summary.delivered.toLocaleString("en-US"),"Delivered throughput",`${summary.offered.toLocaleString("en-US")} Mbps offered`,summary.delivered===null?"unknown":"info"],
      [summary.detectionLag+summary.outbox,"Detection backlog",`${summary.outbox} unsent · ${summary.detectionLag} awaiting detection`,summary.pipeline?"healthy":"stale"],
      [summary.solved,"Cases resolved",`${summary.activeCases} active · ${verified} verified changes`,summary.activeCases?"warning":"healthy"],
    ];
    $t("#twin-stats").replaceChildren(...items.map(([count,title,hint,status])=>{
      const card=node("article",`twin-metric ${status}`);card.append(node("b","",title),node("strong","",count),node("small","",hint));return card;
    }));
    const experiment = state.experiments.at(-1);
    const currentCase = state.cases.at(-1);
    $t("#twin-experiment-name").textContent = state.cases.length && state.cases.every(c=>c.state==="solved") ? `${state.cases.length} investigation${state.cases.length===1?"":"s"}. Fleet recovery verified.` : currentCase ? M.cases[currentCase.caseId].label : experiment ? M.scenarios[experiment.scenario].label : "A network built to be investigated.";
    $t("#twin-experiment-status").textContent = `${selected()} selected · ${state.cases.filter(c=>c.state!=="solved").length} active investigations · ${state.schedule.filter((e) => e.state === "pending").length} scheduled faults · ${state.commands.length} replayable commands`;
    $t("#twin-clock").textContent = `T+${String(state.tick).padStart(4, "0")}`;
  }
  function selectSite(id) {
    $t("#twin-site").value=id;forecast=null;render();
  }
  function capacityRequest() {
    return $t("#twin-action").value==="capacity_plan" ? {plan:{accessCapacity:Number($t("#twin-plan-access").value),regionalCapacity:Number($t("#twin-plan-region").value),coreCapacity:Number($t("#twin-plan-core").value)}} : {};
  }
  function stageAction(action,reason) {
    pause();$t("#twin-action").value=action;$t("#twin-reason").value=reason.slice(0,200);changes();switchTab("changes");
    message("Plan selected. Inspect the scope and preview impact, then create a candidate for independent review.");
  }
  function topology() {
    const regions=Object.values(state.regions),fleet=Object.values(state.sites),target=state.sites[selected()];
    const ns="http://www.w3.org/2000/svg";
    const svgNode=(tag,attrs,text)=>{const el=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);if(text)el.textContent=text;return el;};
    const svg=svgNode("svg",{viewBox:"0 0 660 170",role:"img","aria-label":"Dual-core paths to regional aggregation domains"});
    for(const [i,region] of regions.entries()) {
      const x=regions.length===1?330:55+i*550/(regions.length-1),members=fleet.filter(s=>s.region===region.id);
      for(const [path,cx] of [["primary",225],["backup",435]]) {
        const active=members.some(s=>s.selected===path&&s.links[path].up);
        const degraded=members.some(s=>V.severity(s.metrics)==="critical");
        svg.append(svgNode("path",{d:`M${cx} 53 C${cx} 85 ${x} 85 ${x} 112`,class:`twin-wire ${path}${active?" selected":""}${degraded?" impaired":""}`}));
      }
      svg.append(svgNode("rect",{x:x-40,y:112,width:80,height:46,rx:10,class:`twin-node${target.region===region.id?" target":""}`}),
        svgNode("text",{x,y:131,"text-anchor":"middle",class:"twin-svg-title"},region.id),svgNode("text",{x,y:146,"text-anchor":"middle",class:"twin-svg-small"},`${region.capacity} Mbps`));
    }
    for(const [x,name] of [[225,"PRIMARY CORE"],[435,"BACKUP CORE"]])svg.append(svgNode("rect",{x:x-85,y:7,width:170,height:46,rx:12,class:"twin-node"}),svgNode("text",{x,y:27,"text-anchor":"middle",class:"twin-svg-title"},name),svgNode("text",{x,y:42,"text-anchor":"middle",class:"twin-svg-small"},`Shared budget ${state.core.capacity} Mbps`));
    $t("#twin-topology").replaceChildren(svg,node("small","twin-note",`Core demand ${fleet.reduce((n,s)=>n+s.demand,0)} / ${state.core.capacity} Mbps · Regional budgets constrain both paths`));
    const filter=$t("#twin-fleet-filter").value;
    const visible=fleet.filter(s=>filter==="degraded"?!M.healthy(s.metrics):filter==="selected-region"?s.region===target.region:true);
    $t("#twin-fleet-caption").textContent=`${visible.length} of ${fleet.length} sites shown · calculated at T+${state.tick} · ${state.services.broker&&state.services.detector?"detection active":"observability interrupted; inspect Operations"}`;
    const groups=regions.filter(r=>visible.some(s=>s.region===r.id)).map(region=> {
      const group=node("article","twin-region");const members=fleet.filter(s=>s.region===region.id),head=node("div","twin-region-heading");
      head.append(node("b","",region.name),node("span","",`${members.filter(s=>M.healthy(s.metrics)).length}/${members.length} healthy`));
      const demand=members.reduce((n,s)=>n+s.demand,0),bar=node("div",`twin-capacity-bar ${V.capacityStatus(V.utilization(demand,region.capacity))}`),fill=node("span");fill.style.width=`${Math.min(100,demand/region.capacity*100)}%`;bar.append(fill);
      const tiles=node("div","twin-site-tiles");
      for(const site of visible.filter(s=>s.region===region.id)) {
        const m=site.metrics,healthy=M.healthy(m),tile=button("",()=>selectSite(site.id),false,`twin-select-${site.id}`);
        const severity=V.severity(m);tile.className=`twin-site-tile ${severity}${site.id===selected()?" selected":""}${healthy?"":" degraded"}`;tile.setAttribute("aria-pressed",String(site.id===selected()));
        tile.setAttribute("aria-label",`${site.id}, ${severity}, select site`);
        const top=node("span","twin-tile-top");top.append(node("b","",site.id),node("span",`site-status-label ${severity}`,label(severity)));
        tile.append(top,node("small","",site.name),node("span","twin-tile-metrics",`${number(m?.latencyMs," ms")} / ${number(m?.lossPct,"% loss")}`),node("em","",healthy?`${site.selected} · ${number(m?.throughputMbps," Mbps")}`:m?.symptoms[0]||"Service outside thresholds"));tiles.append(tile);
      }
      group.append(head,node("small","twin-region-budget",`${demand} / ${region.capacity} Mbps offered`),bar,tiles);return group;
    });
    $t("#twin-network").replaceChildren(...(groups.length?groups:[node("p","twin-empty","No sites match this filter. All calculated service thresholds are currently met.")]));
    $t("#twin-fleet-ledger").replaceChildren(table(["Site / region","Service","Path","RTT","Loss","Delivered","CPU","Timing","VSWR","DC energy","Configuration","Evidence"],visible.map(s=> {
      const m=s.metrics;return [s.id+" / "+s.region,M.healthy(m)?"Healthy":"Degraded",s.selected||"none",number(m?.latencyMs," ms"),number(m?.lossPct,"%"),number(m?.throughputMbps," Mbps"),number(m?.cpuPct,"%"),number(m?.timingOffsetUs," µs"),m?.vswr,number(m?.batteryWh," Wh"),`r${s.revision} · ${M.canonical(s.config)===M.canonical(s.intent)?"matches intent":"intent drift"}`,button("Inspect",()=>json(`${s.id} / observed state`,s))];
    })));
    for(const [id,value,unit] of [["delay",target.links.primary.delay," ms"],["loss",target.links.primary.loss,"%"],["demand",target.demand," Mbps"]]) {$t(`#twin-${id}`).value=value;$t(`#twin-${id}-label`).textContent=`${value}${unit}`;}
  }
  function investigation() {
    const target=state.sites[selected()],causes=M.diagnose(state,selected());
    $t("#twin-diagnosis-title").textContent=`${selected()} / causal investigation`;
    $t("#twin-diagnosis").replaceChildren(...(causes.length?causes.map(c=> {
      const card=node("article","twin-cause");card.append(node("b","",c.title),node("p","",c.evidence));const controls=node("div","twin-cause-actions");
      controls.append(button("Collect evidence",()=>run({type:"RUN_PROBE",site:selected(),probe:c.probe},"Diagnostic evidence recorded. Inspect results before proposing a change."),actor()!=="operator"),button(c.action?"Stage recovery plan →":"Containment active",()=>{if(c.action)stageAction(c.action,`Investigate ${c.title}; verify service and scope after change`);},actor()!=="operator"||!c.action));card.append(controls);return card;
    }):[node("div","twin-cause twin-baseline", "No threshold-derived hypothesis for this site. Inject an engineering case to investigate coupled faults; inspect probes to establish the baseline.")]));
    $t("#twin-probes").replaceChildren(...Object.entries(M.probes).map(([type,title])=>button(title,()=>run({type:"RUN_PROBE",site:selected(),probe:type},"Probe evidence recorded with its site conditions and simulated timestamp."),actor()!=="operator",`twin-probe-${type}`)));
    const recent=state.probes.filter(p=>p.site===selected()).slice(-3).reverse();
    $t("#twin-probe-results").replaceChildren(...(recent.length?recent.map(p=> {
      const row=node("div","twin-probe-row");row.append(node("span","",M.probes[p.type]),node("code","",`T+${p.tick} · ${state.tick-p.tick>30?"expired":"≤30 tick window"}`),button("Inspect result",()=>json(`${p.id} / diagnostic result`,p)));return row;
    }):[node("p","twin-note","No probes recorded for this site. Advance after changing faults to sample current conditions.")]));
    $t("#twin-campaign").disabled=actor()!=="operator";
    $t("#twin-case-diagnostics").disabled=actor()!=="operator";
    $t("#twin-case-library").replaceChildren(...Object.entries(M.cases).map(([id,c])=> {
      const card=node("article","twin-engineering-card");const meta=node("div","twin-case-meta");meta.append(node("span","eyebrow",c.domain),node("span","tag",`LAB ${c.difficulty}`));
      card.append(meta,node("h3","",c.label),node("p","",c.description),node("small","",`${c.scope.toUpperCase()} SCOPE · ${c.probes.length} DIAGNOSTIC${c.probes.length===1?"":"S"}`));
      const active=state.cases.some(v=>v.caseId===id&&v.site===selected()&&v.state!=="solved");
      card.append(button(active?"Investigation active":"Inject & observe case →",()=>{if(run({type:"APPLY_CASE",caseId:id,site:selected()})){run({type:"ADVANCE",ticks:1},"Case injected and observed. Inspect the hypotheses, collect probes and stage a reviewed recovery plan.");switchTab("network");}},actor()!=="operator"||active,`twin-case-${id}`));return card;
    }));
    $t("#twin-case-register").replaceChildren(table(["Investigation","Origin / scope","State","Stable recovery","Evidence","Action"],[...state.cases].reverse().map(c=>[M.cases[c.caseId].label,`${c.site} / ${c.affected.length} sites`,label(c.state),`${Math.min(3,c.stableTicks)}/3 ticks`,c.solvedAt===null?"Awaiting service + visibility":`Solved at T+${c.solvedAt}`,button("Investigate",()=>{selectSite(c.site);switchTab("network");})]),"No engineering cases injected. Save a checkpoint, then choose an investigation above."));
  }
  function pipeline() {
    const services = [["broker", "Event broker", "broker_down"], ["storage", "Object store", "storage_down"], ["detector", "Detection consumer", "detector_down"]];
    $t("#twin-services").replaceChildren(...services.map(([key, title, fault]) => {
      const card = node("div", `twin-service ${state.services[key]?"healthy":"critical"}`); card.append(node("b", "", title), node("span", `tag ${state.services[key]?"healthy":"critical"}`, state.services[key] ? "AVAILABLE" : "STOPPED"),
        button(state.services[key] ? "Stop dependency" : "Restore dependency", () => run({type: "FAULT", fault, value: state.services[key]}), actor() !== "operator", `twin-service-${key}`)); return card;
    }));
    $t("#twin-pipeline").replaceChildren(table(["Topic / partition", "End offset", "Storage next offset", "Detection next offset"],
      state.topics.telemetry.map((records, index) => [`telemetry / ${index}`, records.length, state.groups.storage[index], state.groups.detection[index]])));
    const counters = node("div", "twin-counters");
    for (const [title, value] of [["Outbox", state.outbox.length], ["Stored objects", Object.keys(state.objects).length], ["Deduplicated effects", state.counters.duplicates],
      ["Dead-letter deliveries", state.counters.deadLetter], ["Detection lag", M.lag(state, "detection")]]) counters.append(node("span", "tag", `${title}: ${value}`));
    const records = state.topics.telemetry.flat().sort((a, b) => b.tick - a.tick).slice(0, 8);
    $t("#twin-stream").replaceChildren(counters, table(["Tick", "Site", "Event", "Schema", "Evidence"], records.map((r) =>
      [r.tick, r.payload.site, r.payload.eventId, r.payload.schema, button("Inspect", () => json("Modeled event", r))])));
  }
  function jobDetails(jobId) {
    pause();
    const value = state.jobs.find((job) => job.id === jobId);
    const content = [line("State", label(value.state)), line("Author", value.author), line("Reviewer", value.approval?.actor),
      line("Expires at", `T+${value.expiresAt}`), node("p", "", value.reason)];
    const changed=Object.keys(value.candidate).filter(key=>value.before.config[key]!==value.candidate[key]);
    const pre = node("pre", "twin-json", changed.map(key=>`${key}: ${value.before.config[key]} → ${value.candidate[key]}`).join("\n") || "No per-site policy patch; inspect shared service changes below."); content.push(pre);
    if(value.engineering)content.push(line("Operation",value.kind),line("Verification scope",`${value.affected.length} site${value.affected.length===1?"":"s"}`),line("Diagnostic evidence",(value.probeIds||[]).join(", ")||"Required before approval"),node("pre","twin-json",JSON.stringify(value.resources || (value.action==="restore_pipeline"?{broker:true,storage:true,detector:true}:{patch:M.actions[value.action].patch}),null,2)));
    const buttons = node("div", "twin-inline-actions");
    buttons.append(button(actor()==="operator"?"Use Reviewer actor":"Use Operator actor",()=>{$t("#twin-actor").value=actor()==="operator"?"reviewer":"operator";render();jobDetails(jobId);}));
    buttons.append(button("Approve as reviewer", () => {if (run({type: "APPROVE", jobId})) jobDetails(jobId);}, actor() !== "reviewer" || value.state !== "proposed" || state.tick >= value.expiresAt),
      button("Execute as operator", () => {if (run({type: "EXECUTE", jobId})) jobDetails(jobId);}, actor() !== "operator" || value.state !== "approved" || state.tick >= value.expiresAt),
      button("Accept verified intent", () => {if (run({type: "ACCEPT_INTENT", jobId})) jobDetails(jobId);}, actor() !== "reviewer" || value.state !== "verified" || value.intentAcceptedAt != null));
    const raw=node("details","twin-job-evidence");raw.append(node("summary","","Full change evidence JSON"),node("pre","twin-json",JSON.stringify(value,null,2)));
    if(value.bundle){const patches=node("details","twin-job-evidence");patches.append(node("summary","",`Inspect ${Object.keys(value.bundle).length} site patches & work orders`),node("pre","twin-json",JSON.stringify(value.bundle,null,2)));content.push(patches,line("Required probes",value.requirements.map(r=>`${r.site}: ${r.type}`).join(" · ")));}
    content.push(buttons,node("div","policy-note","Modeled actors demonstrate separation of duties. These browser controls are not production authentication. Use the actor switch above to review, then switch back to execute."),raw);
    detail(value.id, content, "MODELED CHANGE / REVIEW & EVIDENCE");
  }
  function changes() {
    const action=M.actions[$t("#twin-action").value];
    $t("#twin-capacity-plan").hidden=$t("#twin-action").value!=="capacity_plan";
    $t("#twin-plan-note").textContent=$t("#twin-action").value==="coordinated_recovery" ? "Compile declared remedies for active engineering cases into a reviewable site patch set, regional/core capacity plan and field work orders. Collect diagnostics for every active case. Verify the entire fleet; unrelated faults can still fail the campaign." : action.patch ? `${action.kind}. Verification scope: ${action.scope==="fleet"?Object.keys(state.sites).length+" sites":selected()}. Required diagnostics: ${action.probes.map(p=>M.probes[p]).join(" + ")}. Advanced patches describe model intent; field work requires a real work order.` : "Routing preference/capacity change in the selected site. Forecast compares every site; independent review and three post-convergence observations are required.";
    $t("#twin-jobs").replaceChildren(table(["Change", "Site", "Action", "State", "Approval", "Evidence"], [...state.jobs].reverse().map((job) =>
      [job.id, job.site, M.actions[job.action].label, label(job.state) + (["proposed", "approved"].includes(job.state) && state.tick >= job.expiresAt ? " · expired" : ""), job.approval?.actor || "Required", button("Inspect & review", () => jobDetails(job.id))]),
      "No changes yet. Inject a delay incident, then propose a backup path. Review the candidate under the Reviewer actor."));
    $t("#twin-incidents").replaceChildren(node("h3", "", "Modeled incidents"), table(["Incident", "Site", "Reason", "State", "Observed ticks"], [...state.incidents].reverse().map((i) =>
      [i.id, i.site, i.reason, i.state, `${i.openedAt} → ${i.resolvedAt ?? "open"}`]), "No confirmed incidents. Three consecutive breaches are required."));
    renderForecast();
    $t("#twin-propose").disabled = actor() !== "operator";
  }
  function mobile() {
    $t("#twin-mobile").replaceChildren(table(["Subscriber", "Site", "Slice", "Registration / PDU", "Address", "Mbps", "Actions"], state.sessions.map((s) => {
      const actions = node("div", "twin-row-actions"); const destination = $t("#twin-handover-target").value;
      actions.append(button("Handover", () => run({type: "HANDOVER_UE", site: destination, sessionId: s.id}, "Handover started. Step twice to calculate destination admission and address continuity."),
        actor() !== "operator" || s.state !== "pdu_active" || destination === s.site, `twin-handover-${s.id}`),
        button("Release", () => run({type: "RELEASE_UE", sessionId: s.id}), actor() !== "operator" || ["released", "rejected"].includes(s.state)));
      return [s.subscriber, s.site, M.slices[s.sliceKey].label, s.cause ? `${label(s.state)} · ${s.cause}` : label(s.state), s.address, s.throughputMbps, actions];
    })));
    $t("#twin-leases").replaceChildren(table(["Client", "Site", "Address", "VLAN", "Modeled DNS record", "Expires"], state.leases.map((l) =>
      [l.client, l.site, l.address, l.vlan, l.dns, `T+${l.expiresAt}`]), "No DHCP leases. Request one for the selected site."));
  }
  function evidence() {
    const previous=[];
    try {for(const version of [1,2])if(localStorage.getItem(`strata:twin:${version}`))previous.push(button(`Export previous v${version} run`,()=>downloadText(`strata-twin-v${version}-original.json`,localStorage.getItem(`strata:twin:${version}`))));}catch {}
    $t("#twin-legacy-exports").replaceChildren(...previous);
    $t("#twin-audit").replaceChildren(...state.audit.slice(-14).reverse().map((entry) => {
      const row = node("article", "twin-audit-row"); row.append(node("code", "", `T+${String(entry.tick).padStart(4, "0")}`),
        node("span", "tag", entry.actor), node("div", "", `${label(entry.type)} · ${entry.detail}`)); return row;
    }));
    $t("#twin-objects").replaceChildren(table(["Modeled object key", "Versions", "Evidence"], Object.entries(state.objects).slice(-8).reverse().map(([key, versions]) =>
      [key, versions.length, button("Inspect JSON", () => json(key, versions))]), "No modeled objects have been stored."));
  }
  function rules() {
    $t("#twin-assumptions").replaceChildren(...state.assumptions.map((text) => node("p", "policy-note", text)));
  }
  function pause(note) {
    if (timer) clearInterval(timer); timer = null;
    $t("#twin-play").textContent = "▶ Play"; $t("#twin-play").setAttribute("aria-pressed", "false");
    if (note) message(note);
  }
  function play() {
    if (timer) {pause("Playback paused. You can inspect or advance the run manually."); return;}
    if (document.hidden || !$t("#view-twin") || $t("#view-twin").hidden) return;
    $t("#twin-play").textContent = "Ⅱ Pause"; $t("#twin-play").setAttribute("aria-pressed", "true");
    message("Playback advances this visible browser only. Leaving the lab or hiding the page pauses it.");
    timer = setInterval(() => run({type: "ADVANCE", ticks: 1}, `Playback calculated T+${state.tick + 1}. Model results are browser-local.`), 1000 / Number($t("#twin-speed").value));
  }
  function scenarioTimeline() {
    $t("#twin-scenario-library").replaceChildren(...Object.entries(M.scenarios).map(([id, scenario]) => {
      const card = node("article", "twin-scenario-card"); card.append(node("span", "eyebrow", `${scenario.duration} TICKS / ${id.toUpperCase()}`),
        node("h3", "", scenario.label), node("p", "", scenario.description),
        button("Load scenario →", () => run({type: "APPLY_SCENARIO", scenarioId: id, site: selected()}, "Scenario appended to the current timeline. Press Play or advance the clock to execute it."), actor() !== "operator", `twin-scenario-${id}`)); return card;
    }));
    $t("#twin-schedule-list").replaceChildren(table(["Time", "Target", "Fault", "Value", "State", "Action"], state.schedule.map((entry) =>
      [`T+${entry.at}`, entry.site || "Platform", label(entry.fault), entry.value, entry.state,
        entry.state === "pending" ? button("Cancel fault", () => run({type: "CANCEL_SCHEDULE", scheduleId: entry.id}, "Pending fault cancelled. Already applied faults are unchanged."), actor() !== "operator", `twin-cancel-${entry.id}`) : "Recorded"]),
      "No scheduled faults. Load a scenario or schedule a failure and its recovery."));
    $t("#twin-schedule").disabled = actor() !== "operator";
  }
  function trends() {
    const count=Number($t("#twin-range").value);const summary = M.summarize(state, selected(),count); const frames = state.history.slice(-count); const ns = "http://www.w3.org/2000/svg";
    const plot = (field, title, unit) => {
      const card = node("article", "twin-trend"); const points = frames.map((f) => f.sites[selected()][field]);
      const values = points.filter((value) => Number.isFinite(value)); const max = Math.max(field === "lossPct" ? 5 : 30, ...values);
      card.append(node("span", "eyebrow", title), node("strong", "", number(points.at(-1), unit)));
      const svg = document.createElementNS(ns, "svg"); svg.setAttribute("viewBox", "0 0 400 84"); svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `${title}, ${selected()}, ${frames.length} calculated observations`);
      for (const y of [12, 40, 68]) {const line = document.createElementNS(ns, "path"); line.setAttribute("d", `M0 ${y} H400`); line.setAttribute("class", "twin-chart-grid"); svg.append(line);}
      let path = "", disconnected = true;
      points.forEach((value, index) => {
        if (!Number.isFinite(value)) {disconnected = true; return;}
        const x = points.length <= 1 ? 200 : index * 400 / (points.length - 1); const y = 68 - value / max * 56;
        path += `${disconnected ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)} `; disconnected = false;
        const dot = document.createElementNS(ns, "circle"); dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("r", "2"); dot.setAttribute("class", "twin-chart-dot"); svg.append(dot);
      });
      const trace = document.createElementNS(ns, "path"); trace.setAttribute("d", path); trace.setAttribute("class", "twin-chart-trace"); svg.append(trace);
      card.append(svg, node("small", "", frames.length ? `T+${frames[0].tick} — T+${frames.at(-1).tick} · ${max} ${unit.trim()} scale` : "Advance to calculate observations")); return card;
    };
    const sla = node("article", "twin-trend twin-sla"); sla.append(node("span", "eyebrow", `SLA WINDOW / LAST ${count} TICKS`), node("strong", "", number(summary.slaPct, "%")),
      node("p", "", `${summary.outageTicks} unavailable ticks · ${summary.healthyTicks} healthy observations`),
      node("small", "", "Healthy = transport thresholds + modeled radio timing, feeder and power. Calculated history."));
    $t("#twin-trends").replaceChildren(plot("latencyMs", "TARGET LATENCY", " ms"), plot("lossPct", "TARGET LOSS", "%"), sla);
  }
  function monitoring() {
    const count=Number($t("#twin-range").value),frames=V.windowFrames(state,count),series=V.traffic(state,count),summary=V.snapshot(state);
    const ns="http://www.w3.org/2000/svg",svgNode=(tag,attrs,text)=>{const e=document.createElementNS(ns,tag);for(const [k,v] of Object.entries(attrs))e.setAttribute(k,v);if(text!==undefined)e.textContent=text;return e;};
    const svg=svgNode("svg",{viewBox:"0 0 900 180",role:"img","aria-label":`Network offered and delivered throughput over ${series.length} calculated ticks`});
    const high=Math.max(1000,Math.ceil(Math.max(...series.map(p=>p.offered),0)/1000)*1000),left=58,right=880,top=8,bottom=145;
    for(let n=0;n<4;n++){const value=high*n/3,y=bottom-value/high*(bottom-top);svg.append(svgNode("path",{d:`M${left} ${y} H${right}`,class:"monitor-grid-line"}),svgNode("text",{x:left-12,y:y+4,"text-anchor":"end",class:"monitor-axis"},Math.round(value).toLocaleString("en-US")));}
    const xAt=i=>series.length===1?right:left+i*(right-left)/(series.length-1),yAt=v=>bottom-v/high*(bottom-top);
    for(const field of ["delivered","offered"]){let path="";series.forEach((p,i)=>{path+=`${i?"L":"M"}${xAt(i).toFixed(1)} ${yAt(p[field]).toFixed(1)} `;});
      if(field==="delivered"&&series.length>1)svg.append(svgNode("path",{d:`${path} L${right} ${bottom} L${left} ${bottom} Z`,class:"monitor-traffic-area"}));
      svg.append(svgNode("path",{d:path,class:`monitor-traffic-line ${field}`}));
      if(series.length){const latest=series.at(-1);svg.append(svgNode("circle",{cx:xAt(series.length-1),cy:yAt(latest[field]),r:3,class:`monitor-traffic-point ${field}`}));}
    }
    for(const [x,anchor,text] of [[left,"start",series.length?`T+${series[0].tick}`:"No observations"],[(left+right)/2,"middle",`${series.length} calculated ticks`],[right,"end",`T+${state.tick}`]])svg.append(svgNode("text",{x,y:171,"text-anchor":anchor,class:"monitor-axis"},text));
    const legend=node("div","monitor-chart-legend");for(const [name,value,className] of [["Delivered",summary.delivered,"delivered"],["Offered",summary.offered,"offered"]]){const entry=node("span",className);entry.append(node("i"),node("b","",name),node("code","",`${value===null?"—":value.toLocaleString("en-US")} Mbps`));legend.append(entry);}
    $t("#dashboard-traffic").replaceChildren(svg,legend);$t("#dashboard-traffic-range").textContent=`LAST ${count} TICKS`;
    // Aggregate long windows into at most 60 columns. A cell retains the worst status in its interval.
    const history=V.healthHistory(state,count),stride=history.stride,columns=history.rows[0]?.cells.length||0,fleet=Object.values(state.sites);
    const heat=svgNode("svg",{viewBox:`0 0 840 ${fleet.length*12+24}`,role:"img","aria-label":`Health history of ${fleet.length} sites; green healthy, amber warning, red critical, gray no data`});
    for(const [row,site] of fleet.entries()){
      const y=row*12+3;heat.append(svgNode("text",{x:4,y:y+8,class:`monitor-axis${selected()===site.id?" target":""}`},site.id));
      if(!columns){heat.append(svgNode("rect",{x:86,y,width:738,height:9,class:"health-cell unknown",rx:1}));continue;}
      for(let col=0;col<columns;col++){const cell=history.rows[row].cells[col];
        const rect=svgNode("rect",{x:86+col*738/columns,y,width:Math.max(1,738/columns-1.4),height:9,rx:1,class:`health-cell ${cell.status}`});
        rect.append(svgNode("title",{},`${site.id} / T+${cell.from}–${cell.to} / ${cell.status}`));heat.append(rect);
      }
    }
    heat.append(svgNode("text",{x:86,y:fleet.length*12+20,class:"monitor-axis"},frames.length?`T+${frames[0].tick}`:"No observations"),svgNode("text",{x:824,y:fleet.length*12+20,class:"monitor-axis","text-anchor":"end"},`T+${state.tick}${stride>1?` · worst of ${stride} ticks / cell`:""}`));
    $t("#dashboard-health").replaceChildren(heat);
    const capacities=V.regions(state).map(r=>({name:r.id,ratio:r.ratio,status:r.status,offered:r.offered,capacity:r.capacity}));
    capacities.push({name:"CORE",ratio:summary.coreRatio,status:V.capacityStatus(summary.coreRatio),offered:summary.offered,capacity:state.core.capacity});
    $t("#dashboard-capacity").replaceChildren(...capacities.map(r=>{const row=node("div",`monitor-capacity-row ${r.status}`),meta=node("div");meta.append(node("b","",r.name),node("small","",`${r.offered} / ${r.capacity}`),node("code","",`${r.ratio??"—"}%`));const bar=node("div","monitor-bar"),fill=node("span");fill.style.width=`${Math.min(100,r.ratio||0)}%`;bar.append(fill);row.append(meta,bar);return row;}));
    const freshness=$t("#dashboard-freshness");freshness.className=`tag ${summary.pipeline?"healthy":"stale"}`;freshness.textContent=summary.pipeline?"Current":"Delayed";
    const dependencies=[["Event broker",state.services.broker],["Object storage",state.services.storage],["Detection consumer",state.services.detector]];
    const stream=dependencies.map(([name,available])=>{const row=node("div","monitor-dependency-row");row.append(node("span","",name),node("span",`tag ${available?"healthy":"critical"}`,available?"Available":"Stopped"));return row;});
    const counters=node("div","monitor-stream-counters");for(const [name,value] of [["Storage lag",summary.storageLag],["Detection lag",summary.detectionLag],["Outbox",summary.outbox]]){const c=node("div");c.append(node("strong",value?"stale":"healthy",value),node("small","",name));counters.append(c);}
    const open=state.incidents.filter(i=>i.state==="open").length;stream.push(counters,node("p","monitor-stream-note",`${open} confirmed incident${open===1?"":"s"} · ${summary.pipeline?"all detection offsets caught up":"alarms may trail actual service conditions"}`),button("Inspect pipeline →",()=>switchTab("pipeline")));
    $t("#dashboard-streaming").replaceChildren(...stream);
    const brief=V.brief(state,selected()),meta=node("div","brief-meta");meta.append(node("span",`tag ${brief.severity}`,brief.selectedStatus),node("span","",`${selected()} · T+${state.tick}`));
    const evidence=node("div","brief-evidence-counts");evidence.append(node("span","",`${brief.probeCount} recent probe${brief.probeCount===1?"":"s"}`),node("span","",`${brief.activeCases} related case${brief.activeCases===1?"":"s"}`));
    $t("#dashboard-brief").replaceChildren(meta,node("h3","",brief.headline),node("p","",brief.nextStep),evidence,node("small","brief-source","Monitoring context · deterministic model rules"));
  }
  function renderForecast() {
    const area = $t("#twin-forecast"); if (!forecast) {area.replaceChildren(); return;}
    const card = node("article", "twin-forecast-card"); const meta = node("div", "twin-forecast-heading");
    meta.append(node("div", "", `${M.actions[forecast.action].label} · ${forecast.site} · next ${forecast.horizon} ticks`), node("span", "tag", `WHAT-IF / ${label(forecast.job.state).toUpperCase()}`));
    card.append(meta, table(["Site", "Baseline SLA", "Candidate SLA", "Δ SLA", "Δ Mbps", "Δ latency"], forecast.comparison.map((c) =>
      [c.site, `${c.baseline.slaPct}%`, `${c.candidate.slaPct}%`, `${c.delta.slaPoints > 0 ? "+" : ""}${c.delta.slaPoints} pp`, number(c.delta.throughputMbps), number(c.delta.latencyMs, " ms")])),
      node("p", "twin-note", forecast.boundary), button("Export comparison", () => downloadJSON("strata-twin-forecast.json", forecast)));
    area.replaceChildren(card);
  }
  function saveCheckpoint() {
    pause(); const checkpoint = {id: `checkpoint-${state.tick}-${Date.now()}`, name: `Checkpoint at T+${state.tick}`, tick: state.tick, run: M.exportJournal(state, catalog)};
    checkpoints = [checkpoint, ...checkpoints].slice(0, 4);
    try {localStorage.setItem(checkpointKey, JSON.stringify(checkpoints)); message("Checkpoint saved. Restore it from Evidence; the four most recent are retained.");}
    catch {message("Checkpoint is in memory only: browser storage is full or unavailable. Export the checkpoint from Evidence.", true);}
    renderCheckpoints();
  }
  function renderCheckpoints() {
    const heading = node("div", "twin-checkpoint-heading"); heading.append(node("h3", "", "Restore a known state"), node("span", "twin-note", "Four browser-local checkpoints · validated by replay"));
    const cards = node("div", "twin-checkpoint-grid");
    for (const checkpoint of checkpoints) {
      const savedState=checkpoint.run.finalSummary || checkpoint.run.finalState;
      const card = node("article", "twin-checkpoint-card"); card.append(node("b", "", checkpoint.name), node("small", "", `${checkpoint.run.commands.length} commands · ${savedState.jobs.length} change${savedState.jobs.length === 1 ? "" : "s"}`),
        button("Restore checkpoint", () => {
          pause(); detail("Restore checkpoint", [node("p", "", `Replace the current run with ${checkpoint.name}? Export or save the current run first to keep it.`),
            button("Restore this checkpoint", () => {
              try {state = M.replay(checkpoint.run); forecast = null; save(); render(); message(`Restored and replay verified at T+${state.tick}.`); $t("#detail-dialog").close();}
              catch (error) {message(`Checkpoint rejected: ${error.message}`, true);}
            })], "REPLACE CURRENT BROWSER RUN");
        }), button("Export checkpoint", () => downloadJSON(`${checkpoint.id}.json`, checkpoint.run))); cards.append(card);
    }
    $t("#twin-checkpoints").replaceChildren(heading, checkpoints.length ? cards : node("p", "twin-empty", "Save a checkpoint before an experiment to compare or restore its starting conditions."));
  }
  function configuration() {
    generatedConfig = D.render(state, selected(), $t("#twin-platform").value, $t("#twin-platform-action").value);
    const profile = D.profiles[generatedConfig.platform]; const meta = node("div", "twin-config-caption");
    const source = node("a", "text-button", "Platform documentation ↗"); source.href = profile.source; source.target = "_blank"; source.rel = "noopener noreferrer";
    meta.append(node("span", "tag", profile.os), source);
    const compatibility = node("details", "twin-compatibility"); compatibility.append(node("summary", "", "Compatibility & deployment notes"), node("p", "twin-note", generatedConfig.prerequisites));
    $t("#twin-config-meta").replaceChildren(meta, node("p", "twin-note", profile.scope), node("p", "twin-note", generatedConfig.validation), compatibility);
    $t("#twin-config-code").textContent = generatedConfig.text;
    $t("#twin-config-propose").disabled = actor() !== "operator" || generatedConfig.action === "running" || state.sites[selected()].config.backupPreference === generatedConfig.intent.backupPreference;
  }
  function downloadText(filename, value) {
    const url = URL.createObjectURL(new Blob([value], {type:"text/plain;charset=utf-8"})); const link = node("a"); link.href = url; link.download = filename;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  function equipment() {
    const target = state.sites[selected()];
    const stages = [["ANTENNA / RET", `VSWR ${target.metrics?.vswr ?? "—"} · physical model`], ["RADIO UNIT", target.metrics?.radioHealthy ? `Healthy · timing ${target.metrics.timingOffsetUs} µs` : "Modeled radio degraded"], ["DU / CU", "External RAN functions"], ["BACKHAUL", `${target.selected || "no route"} · VLAN ${target.serviceVlan}`], ["5G CORE / UPF", state.services.mobileCore ? "Modeled core available" : "Modeled core stopped"]];
    $t("#twin-equipment-map").replaceChildren(...stages.map(([name, detail]) => {const card = node("article", "twin-equipment-stage"); card.append(node("span", "eyebrow", name), node("b", "", detail)); return card;}));
    $t("#twin-equipment-list").replaceChildren(table(["Equipment", "Site role", "Implemented control / boundary"], D.equipment.map((item) => [item.name, item.role, item.control])));
    const p = plans[selected()] || D.rfDefaults;
    if (rfSite !== selected()) {
      for (const [key, value] of Object.entries(drafts[selected()] || p)) {const field = $t(`#twin-rf-${key}`); if (field) field.value = value;}
      rfSite = selected();
    }
    $t("#twin-rf-draft").textContent = drafts[selected()] ? "Uncalculated edits. Results and export still use the last calculated plan." : plans[selected()] ? "Calculated plan saved for this site. Export includes these values." : "Generic reference plan. Calculate and save after editing.";
    const result = D.budget(p); const cards = node("div", "twin-budget-grid");
    for (const [title, value] of [["EIRP", `${result.eirpDbm} dBm`], ["Free-space loss", `${result.freeSpaceLossDb} dB`], ["Received total power", `${result.receivedPowerDbm} dBm`], ["Battery arithmetic", `${result.batteryAutonomyHours} hours`]]) {
      const card = node("article"); card.append(node("small", "", title), node("strong", "", value)); cards.append(card);
    }
    $t("#twin-rf-result").replaceChildren(cards, node("p", "twin-note", result.boundary)); configuration();
  }
  function bindEquipment() {
    try {plans = JSON.parse(localStorage.getItem("strata:commissioning:1") || "{}");
      if (!plans || typeof plans !== "object" || Array.isArray(plans)) plans = {};
      for (const id of Object.keys(plans)) {try {if (!Object.hasOwn(state.sites,id)) throw new Error(); D.budget(plans[id]);} catch {delete plans[id];}}
    } catch {plans = {};}
    for (const [id, profile] of Object.entries(D.profiles)) {const option = node("option", "", profile.name); option.value = id; $t("#twin-platform").append(option);}
    for (const id of ["platform", "platform-action"]) $t(`#twin-${id}`).addEventListener("change", configuration);
    const fields = [["frequencyMHz","Carrier frequency (MHz)",100,100000],["distanceKm","Link distance (km)",.001,100],["txPowerDbm","Transmit power (dBm)",-30,60],
      ["antennaGainDbi","Antenna gain (dBi)",0,40],["feederLossDb","Feeder loss (dB)",0,40],["otherLossDb","Additional loss (dB)",0,100],
      ["azimuthDeg","Azimuth (degrees)",0,359],["electricalTiltDeg","Electrical tilt (degrees)",0,20],["mechanicalTiltDeg","Mechanical tilt (degrees)",0,20],
      ["batteryAh","Battery capacity (Ah)",1,10000],["dcVoltage","DC voltage magnitude (V)",1,1000],["loadW","Site load (W)",1,100000],["usableFraction","Usable energy fraction",.01,1]];
    const groups = {0:"01 / Radio link budget",6:"02 / Sector pointing",9:"03 / Site power"};
    $t("#twin-rf-fields").replaceChildren(...fields.flatMap(([id,title,min,max],index) => {const label = node("label", "", title); const input = node("input"); input.type = "number"; input.id = `twin-rf-${id}`; input.min = min; input.max = max; input.step = "any"; input.required = true; input.value = D.rfDefaults[id]; label.append(input); return groups[index] ? [node("h3","twin-rf-group",groups[index]),label] : [label];}));
    $t("#twin-rf-fields").addEventListener("input", () => {
      drafts[selected()] = Object.fromEntries(fields.map(([id]) => [id,$t(`#twin-rf-${id}`).value]));
      $t("#twin-rf-draft").textContent = "Uncalculated edits. Results and export still use the last calculated plan.";
    });
    $t("#twin-rf-calculate").addEventListener("click", () => {
      try {for (const [id,title] of fields) {const input = $t(`#twin-rf-${id}`); if (!input.value.trim() || !input.validity.valid) {input.focus(); throw new Error(`Enter ${title.toLowerCase()} between ${input.min} and ${input.max}.`);}}
        const p = Object.fromEntries(fields.map(([id]) => [id, Number($t(`#twin-rf-${id}`).value)])); D.budget(p); plans[selected()] = p; delete drafts[selected()];
        try {localStorage.setItem("strata:commissioning:1",JSON.stringify(plans)); message("Commissioning arithmetic saved for this site. It does not apply vendor OAM or change modeled transport/session capacity.");}
        catch {message("Plan is in memory only. Export it before leaving this page.",true);} equipment();
      } catch (error) {message(error.message,true);}
    });
    $t("#twin-rf-export").addEventListener("click", () => downloadJSON(`${selected().toLowerCase()}-commissioning.json`, {format:"strata-site-commissioning",site:selected(),equipment:D.equipment,budget:D.budget(plans[selected()] || D.rfDefaults)}));
    $t("#twin-config-export").addEventListener("click", () => downloadText(generatedConfig.fileName, `${["routeros","junos","vrp","sros"].includes(generatedConfig.platform) ? "#" : "!"} ${generatedConfig.prerequisites}\n${generatedConfig.text}`));
    $t("#twin-config-propose").addEventListener("click", () => {if (run({type:"PROPOSE",site:selected(),action:generatedConfig.action,reason:`Review ${D.profiles[generatedConfig.platform].name} routing intent; native fragment not executed`},"Typed routing intent proposed. Review under the Reviewer actor before execution in Twin.")) switchTab("changes");});
    $t("#twin-native-pack").addEventListener("click", async () => {
      const control = $t("#twin-native-pack"); control.disabled = true; control.setAttribute("aria-busy","true"); control.textContent = "Preparing native files…";
      try {if (!nativePack) {const response = await fetch("/assets/native-lab-pack.json"); if (!response.ok) throw new Error("Native lab pack unavailable"); nativePack = await response.json();}
        downloadJSON("strata-native-lab-pack.json", {...nativePack, currentSite:selected(), currentPolicies:Object.keys(D.profiles).map((id) => D.render(state,selected(),id)), commissioning:D.budget(plans[selected()] || D.rfDefaults)});
        message("Native config file contents exported. Run them only in the matching isolated lab; device execution remains unverified.");
      } catch (error) {message(error.message,true);}
      finally {control.disabled = false; control.removeAttribute("aria-busy"); control.textContent = "Export native lab pack";}
    });
  }
  function render() {
    const focus = document.activeElement?.id;
    stats(); topology(); trends(); monitoring(); investigation(); equipment(); scenarioTimeline(); pipeline(); changes(); mobile(); evidence(); renderCheckpoints();
    if (focus && document.getElementById(focus) && document.activeElement === document.body) document.getElementById(focus).focus();
  }
  function bind() {
    for (const [id,action] of Object.entries(M.actions)) if (!Array.from($t("#twin-action").options).some(o=>o.value===id)) {const option=node("option","",action.label);option.value=id;$t("#twin-action").append(option);}
    $t("#twin-campaign").addEventListener("click",()=>stageAction("coordinated_recovery","Coordinate active cases using observed diagnostics, review all site patches and verify the full fleet"));
    $t("#twin-case-diagnostics").addEventListener("click",()=>{
      pause();const active=state.cases.filter(c=>c.state!=="solved");if(!active.length){message("Inject a case before collecting its diagnostics.",true);return;}
      for(const c of active)for(const probe of M.cases[c.caseId].probes)if(!run({type:"RUN_PROBE",site:c.site,probe},"Case diagnostics recorded. Inspect each result in Fleet monitor before review."))return;
    });
    $t("#twin-example").addEventListener("click",()=>{
      pause();detail("Replay the solved campaign",[node("p","","This public example injects six failures across six regions, collects seven diagnostic probes and independently reviews a coordinated recovery. Its 19 commands rebuild the evidence and end with 24 healthy sites. Export or checkpoint your current run before replacing it."),button("Replace run with verified example",async()=>{
        try{const response=await fetch("/assets/twin-solved-example.json");if(!response.ok)throw new Error("Solved example unavailable");const journal=await response.json();if(M.canonical(journal.siteDesigns)!==M.canonical(catalog.sites))throw new Error("Example site designs differ");const restored=M.replay(journal);state=restored;forecast=null;render();save();switchTab("scenarios");message("Solved campaign replay verified: six investigations, seven probes and 24 healthy sites. Inspect the resolution register and change evidence.");$t("#detail-dialog").close();}catch(error){message(`Example rejected: ${error.message}`,true);}
      })],"REPRODUCIBLE ENGINEERING EXAMPLE");
    });
    $t("#twin-action").addEventListener("change",()=>{forecast=null;changes();});
    for(const id of ["access","region","core"])$t(`#twin-plan-${id}`).addEventListener("input",()=>{forecast=null;renderForecast();});
    $t("#twin-range").addEventListener("change",()=>{trends();monitoring();});
    $t("#dashboard-brief-inspect").addEventListener("click",()=>json("Monitoring context / calculated evidence",V.brief(state,selected())));
    $t("#twin-fleet-filter").addEventListener("change",topology);
    $t("#twin-case-export").addEventListener("click",()=>downloadJSON("strata-engineering-dossier.json",{format:"strata-engineering-dossier",version:M.VERSION,tick:state.tick,siteDesigns:catalog.sites,cases:state.cases,probes:state.probes,changes:state.jobs,resources:{regions:state.regions,core:state.core},commands:state.commands,boundary:"Deterministic model evidence. Physical work orders and advanced capacity/timing intent are not vendor commands or measured field outcomes. Export run separately for full replay."}));
    for (const target of Object.values(state.sites)) {const option = node("option", "", `${target.id} · ${target.name}`); option.value = target.id; $t("#twin-site").append(option);}
    for (const el of document.querySelectorAll("[data-twin-tab]")) el.addEventListener("click", () => switchTab(el.dataset.twinTab));
    for (const target of Object.values(state.sites)) {const option = node("option", "", target.id); option.value = target.id; $t("#twin-handover-target").append(option);}
    $t("#twin-handover-target").value = Object.keys(state.sites)[1];
    $t("#twin-handover-target").addEventListener("change", mobile);
    $t("#twin-play").addEventListener("click", play);
    $t("#twin-speed").addEventListener("change", () => {if (timer) {pause(); play();}});
    $t("#twin-checkpoint").addEventListener("click", saveCheckpoint);
    document.addEventListener("visibilitychange", () => {if (document.hidden && timer) pause("Playback paused because the page is hidden.");});
    document.addEventListener("strata:viewchange", (event) => {if (event.detail.view !== "twin" && timer) pause("Playback paused when leaving the lab.");});
    $t("#twin-preview").addEventListener("click", () => {
      pause(); try {forecast = M.forecast(state, {site: selected(), action: $t("#twin-action").value, ...capacityRequest()}); renderForecast(); message("What-if calculated. Current clock, configuration and approvals are unchanged.");}
      catch (error) {forecast = null; renderForecast(); message(error.message, true);}
    });
    $t("#twin-campaign").addEventListener("click",()=>stageAction("coordinated_recovery","Coordinate active cases using observed diagnostics, review all site patches and verify the full fleet"));
    $t("#twin-case-diagnostics").addEventListener("click",()=>{
      pause();const active=state.cases.filter(c=>c.state!=="solved");if(!active.length){message("Inject a case before collecting its diagnostics.",true);return;}
      for(const c of active)for(const probe of M.cases[c.caseId].probes)if(!run({type:"RUN_PROBE",site:c.site,probe},"Case diagnostics recorded. Inspect each result in Fleet monitor before review."))return;
    });
    $t("#twin-example").addEventListener("click",()=>{
      pause();detail("Replay the solved campaign",[node("p","","This public example injects six failures across six regions, collects seven diagnostic probes and independently reviews a coordinated recovery. Its 19 commands rebuild the evidence and end with 24 healthy sites. Export or checkpoint your current run before replacing it."),button("Replace run with verified example",async()=>{
        try{const response=await fetch("/assets/twin-solved-example.json");if(!response.ok)throw new Error("Solved example unavailable");const journal=await response.json();if(M.canonical(journal.siteDesigns)!==M.canonical(catalog.sites))throw new Error("Example site designs differ");const restored=M.replay(journal);state=restored;forecast=null;render();save();switchTab("scenarios");message("Solved campaign replay verified: six investigations, seven probes and 24 healthy sites. Inspect the resolution register and change evidence.");$t("#detail-dialog").close();}catch(error){message(`Example rejected: ${error.message}`,true);}
      })],"REPRODUCIBLE ENGINEERING EXAMPLE");
    });
    $t("#twin-action").addEventListener("change", () => {forecast = null; renderForecast();});
    $t("#twin-schedule").addEventListener("click", () => {
      const fault = $t("#twin-scheduled-fault").value; let value = Number($t("#twin-scheduled-value").value);
      if (fault.endsWith("_down")) {if (![0, 1].includes(value)) {message("Use 1 for down or 0 for restored.", true); return;} value = Boolean(value);}
      run({type: "SCHEDULE_FAULT", site: selected(), fault, value, after: Number($t("#twin-scheduled-after").value)}, "Fault scheduled. Press Play or advance to reach its execution time.");
    });
    for (const id of ["site", "actor"]) $t(`#twin-${id}`).addEventListener("change", () => {forecast = null; render();});
    $t("#twin-step").addEventListener("click", () => run({type: "ADVANCE", ticks: 1}, "One simulated second calculated. No wall-clock background jobs are running."));
    $t("#twin-advance").addEventListener("click", () => run({type: "ADVANCE", ticks: 5}, "Five simulated seconds calculated; consumers, incidents and change verification advanced."));
    for (const [id, fault] of [["delay", "primary_delay"], ["loss", "primary_loss"], ["demand", "demand"]]) $t(`#twin-${id}`).addEventListener("change", (event) => run({type: "FAULT", site: selected(), fault, value: Number(event.target.value)}));
    for (const el of document.querySelectorAll("[data-twin-command]")) el.addEventListener("click", () => {
      const type = el.dataset.twinCommand; const target = state.sites[selected()];
      if (["primary_down", "backup_down"].includes(type)) run({type: "FAULT", site: selected(), fault: type, value: target.links[type.split("_")[0]].up});
      else if (type === "core_down") run({type: "FAULT", fault: type, value: state.services.mobileCore});
      else if (type === "radio_down") run({type: "FAULT", site: selected(), fault: type, value: target.radioUp});
      else run({type, site: selected()});
    });
    $t("#twin-delay-demo").addEventListener("click", () => {
      if (run({type: "FAULT", site: selected(), fault: "primary_delay", value: 120})) {
        run({type: "ADVANCE", ticks: 5}, "Delay fault observed for five ticks. Inspect Change control to review a backup path."); switchTab("changes");
      }
    });
    $t("#twin-clear-fault").addEventListener("click", () => {
      for (const [fault, value] of [["primary_down", false], ["backup_down", false], ["primary_delay", 0], ["primary_loss", 0], ["demand", 100], ["radio_down", false]])
        if (!run({type: "FAULT", site: selected(), fault, value})) break;
    });
    $t("#twin-propose").addEventListener("click", () => run({type: "PROPOSE", site: selected(), action: $t("#twin-action").value, ...capacityRequest(), reason: $t("#twin-reason").value}, "Candidate created. Switch to Reviewer and inspect the change to approve it."));
    $t("#twin-lease").addEventListener("click", () => run({type: "LEASE", site: selected(), client: $t("#twin-client").value}));
    $t("#twin-register").addEventListener("click", () => run({type: "REGISTER_UE", site: selected(), subscriber: $t("#twin-subscriber").value, slice: $t("#twin-slice").value}, "Registration requested. Advance two ticks to attempt a modeled PDU session."));
    $t("#twin-export").addEventListener("click", () => downloadJSON("strata-twin-journal.json", M.exportJournal(state, catalog)));
    $t("#twin-native").addEventListener("click", () => {
      downloadText(`${selected().toLowerCase()}-candidate.conf`, M.nativeFrr(state, selected()));
      message("FRR candidate exported for the isolated lab. The model's capacity and physical fault settings are not included in FRR syntax.");
    });
    $t("#twin-reset").addEventListener("click", () => {
      pause();
      const content = [node("p", "", "Reset clears this browser's current modeled run. Export it first if you want to keep the evidence."),
        button("Reset local simulation", () => {state = M.step(M.initial(catalog), {type: "ADVANCE", ticks: 1}); forecast = null; render(); save(); message("New isolated model initialized. Previous browser state was replaced."); $t("#detail-dialog").close();})];
      detail("Reset this run", content, "LOCAL SIMULATION");
    });
    $t("#twin-import").addEventListener("click", () => $t("#twin-file").click());
    $t("#twin-file").addEventListener("change", async (event) => {
      try {const file = event.target.files[0]; if (!file) return;
        if (file.size > 16 * 1024 * 1024) throw new Error("Replay files must be smaller than 16 MB");
        pause(); const imported = JSON.parse(await file.text()); const restored = M.migrate(imported);
        // Import only this repository's declared site designs; custom designs belong in a separate model version.
        if (M.canonical(imported.siteDesigns) !== M.canonical(catalog.sites)) throw new Error("Site designs do not match this model deployment");
        state = restored; forecast = null; render(); save(); message(imported.version !== M.VERSION ? "Original replay verified and reinterpreted under current model rules. Export to preserve this run." : `Replay verified: ${state.commands.length} commands reproduce the exported state at T+${state.tick}.`);
      } catch (error) {message(`Replay rejected: ${error.message}`, true);} finally {event.target.value = "";}
    });
  }
  async function load() {
    $t("#view-twin").inert = true;
    try {
      const response = await fetch("/assets/twin-blueprint.json");
      if (!response.ok) throw new Error("Simulation blueprint is unavailable"); catalog = await response.json();
      state = M.step(M.initial(catalog), {type: "ADVANCE", ticks: 1});
      let restored = false, failedRestore = false, migrated = false;
      try {const stored = localStorage.getItem(key); if (stored) {const run = JSON.parse(stored);
        if (M.canonical(run.siteDesigns) !== M.canonical(catalog.sites)) throw new Error("Stored site designs differ");
        state = M.migrate(run); restored = true; migrated = run.version !== M.VERSION;}}
      catch {failedRestore = true;}
      try {const saved = JSON.parse(localStorage.getItem(checkpointKey) || "[]");
        if (Array.isArray(saved)) checkpoints = saved.slice(0, 4).filter((checkpoint) => {
          try {M.replay(checkpoint.run); return typeof checkpoint.name === "string" && M.canonical(checkpoint.run.siteDesigns) === M.canonical(catalog.sites);} catch {return false;}
        });} catch {}
      initialized = true; bind(); bindEquipment(); rules(); render();
      message(failedRestore ? "Saved run could not be replayed. A fresh model is open; the saved file has been preserved until your next change."
        : migrated ? "Older run verified and reinterpreted with current model rules. Original browser saves are retained."
        : restored ? "Browser-local run restored and replay verified. Press Play to run this visible lab."
        : "24-site fleet ready. Save a checkpoint, then open Engineering cases. Previous v1/v2 browser saves are retained separately.", failedRestore);
    } catch (error) {message(`Simulator unavailable: ${error.message}. Refresh after checking static deployment assets.`, true);}
    finally {
      $t("#view-twin").inert = false;
      const boot = $t("#twin-boot"); boot.classList.add("is-ready");
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) boot.hidden = true;
      else setTimeout(() => {boot.hidden = true;},200);
    }
  }
  load();
})();
