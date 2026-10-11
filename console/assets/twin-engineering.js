/* Deterministic engineering experiments. Physical repairs are modeled work orders, not device commands. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StrataEngineering = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";
  const copy = value => JSON.parse(JSON.stringify(value));
  const round = value => Math.round(value * 100) / 100;
  const actions = {
    safe_failover: {label:"MTU-safe backup failover", patch:{backupPreference:200,mssClamp:true}, probes:["mtu"], kind:"Modeled transport policy"},
    capacity_plan: {label:"Coordinate regional & core capacity", patch:{primaryCapacity:350,backupCapacity:350}, probes:["queues"], scope:"fleet", kind:"Modeled capacity provisioning"},
    clock_backup: {label:"Enable alternate timing reference", patch:{clockBackup:true}, probes:["timing"], kind:"Modeled timing configuration"},
    recover_radio: {label:"Recover timing & repair RF feeder", patch:{clockBackup:true,rfRepaired:true}, probes:["timing","rf"], kind:"Timing policy + modeled field work order"},
    contain_leak: {label:"Restore exact-prefix import guard", patch:{prefixGuard:true}, probes:["bgp"], kind:"Modeled route-policy configuration"},
    reserve_power: {label:"Commission emergency battery reserve", patch:{reservePower:true}, probes:["power"], kind:"Modeled field work order · finite 480 Wh reserve"},
    restore_pipeline: {label:"Recover broker, storage & detection", patch:{}, probes:["telemetry"], scope:"fleet", kind:"Modeled service recovery"},
    coordinated_recovery: {label:"Coordinate multi-site recovery campaign", patch:{}, probes:[],scope:"fleet",kind:"Scoped multi-domain policy + modeled field work orders"},
  };
  const probes = {mtu:"Path MTU / packet-size test",queues:"Queue & capacity inspection",timing:"PTP holdover inspection",rf:"Feeder / VSWR inspection",bgp:"BGP import & CPU inspection",power:"DC supply & battery inspection",telemetry:"Telemetry freshness inspection"};
  const cases = {
    mtu_trap:{label:"The green-link blackhole",domain:"TRANSPORT / MTU",difficulty:"L3",description:"A delayed primary path makes backup attractive. Both links stay up, but large packets fail after failover. Investigate packet size before changing preference.",action:"safe_failover",probes:["mtu"],scope:"site"},
    capacity_cascade:{label:"A bottleneck that moves",domain:"REGIONAL / CORE",difficulty:"L4",description:"Four sites surge together. Access capacity, aggregation and the shared core all constrain delivery. A local upgrade can move the loss to another site.",action:"capacity_plan",probes:["queues"],scope:"region"},
    timing_rf:{label:"Transport is healthy. Radio is not.",domain:"PTP / RADIO / FEEDER",difficulty:"L4",description:"Holdover drift and feeder mismatch coexist. Timing recovery alone leaves the RF symptom unresolved; verify service health across both domains.",action:"recover_radio",probes:["timing","rf"],scope:"site"},
    route_storm:{label:"Interfaces up, routing exhausted",domain:"BGP / CONTROL PLANE",difficulty:"L4",description:"An import-policy drift admits a route burst and exhausts modeled CPU. A latency symptom distracts from the control-plane failure.",action:"contain_leak",probes:["bgp"],scope:"site"},
    power_chain:{label:"The delayed site brownout",domain:"POWER / TRANSPORT / RAN",difficulty:"L3",description:"Grid loss begins with working links. A depleted battery then takes transport and radio down together. A finite reserve must be commissioned and observed.",action:"reserve_power",probes:["power"],scope:"site"},
    blind_noc:{label:"Silent alarms, degraded service",domain:"EVENTS / OBSERVABILITY",difficulty:"L4",description:"The primary path degrades while event delivery and detection stop. Recover visibility, then repair transport; healthy ingestion alone cannot solve this case.",action:"restore_pipeline",probes:["telemetry"],scope:"fleet"},
  };
  function initialize(state, designs) {
    state.regions = {}; state.core = {capacity:designs.length === 3 ? 500 : 3200,revision:1};
    state.probes = []; state.cases = [];
    for (const value of Object.values(state.sites)) {
      const input = designs[value.index]; value.region = input.region || "LEGACY";
      if (!/^[A-Z]{3,8}$/.test(value.region)) throw new Error("Invalid region identifier");
      state.regions[value.region] ||= {id:value.region,name:input.region_name || value.region,capacity:500,revision:1};
      Object.assign(value.config,{primaryCapacity:250,mssClamp:false,prefixGuard:true,clockBackup:false,rfRepaired:false,reservePower:false});
      value.intent = copy(value.config);
      value.equipment = {packetBytes:1380,backupMtu:1400,pmtudBlocked:false,leakedPrefixes:0,ptpLostAt:null,vswr:1,gridLostAt:null,batteryWh:4800,reserveWh:480,loadW:800};
    }
  }
  function context(value) {
    const e = value.equipment;
    return {packetBytes:e.packetBytes,backupMtu:e.backupMtu,pmtudBlocked:e.pmtudBlocked,leakedPrefixes:e.leakedPrefixes,ptpLostAt:e.ptpLostAt,vswr:e.vswr,gridLostAt:e.gridLostAt};
  }
  function prepare(state) {
    for (const value of Object.values(state.sites)) {
      const e = value.equipment;
      if (e.gridLostAt !== null) {
        const draw = e.loadW / 3600;
        if (e.batteryWh > 0) e.batteryWh = Math.max(0,e.batteryWh-draw);
        else if (value.config.reservePower) e.reserveWh = Math.max(0,e.reserveWh-draw);
      }
    }
  }
  function conditions(state,value) {
    const e = value.equipment;
    const accepted = value.config.prefixGuard ? Math.min(1,e.leakedPrefixes) : e.leakedPrefixes;
    const cpu = Math.min(100,10+accepted*.08);
    const powered = e.gridLostAt === null || e.batteryWh > 0 || (value.config.reservePower && e.reserveWh > 0);
    const offset = e.ptpLostAt === null ? .2 : value.config.clockBackup ? .3 : .2+(state.tick-e.ptpLostAt)*.75;
    const vswr = value.config.rfRepaired ? 1.2 : e.vswr;
    const reflected = ((vswr-1)/(vswr+1))**2;
    const mtuBlackhole = value.selected === "backup" && e.packetBytes > e.backupMtu && e.pmtudBlocked && !value.config.mssClamp;
    return {routerUp:powered && cpu < 95,radioHealthy:powered && value.radioUp && offset <= 5 && vswr <= 2.5,
      powered,cpu,accepted,offset,vswr,reflected,mtuBlackhole,radioBudget:40*(1-reflected)};
  }
  function enrich(state,value,metric) {
    const c = conditions(state,value), e = value.equipment;
    Object.assign(metric,{region:value.region,cpuPct:round(c.cpu),acceptedPrefixes:c.accepted,pathMtu:value.selected === "backup" ? e.backupMtu : 1500,
      mtuBlackhole:c.mtuBlackhole,timingOffsetUs:round(c.offset),vswr:c.vswr,reflectedPowerPct:round(100*c.reflected),
      radioHealthy:c.radioHealthy,radioBudgetMbps:round(c.radioBudget),powered:c.powered,batteryWh:round(e.batteryWh),reserveWh:round(e.reserveWh),gridAvailable:e.gridLostAt === null});
    const symptoms = [];
    if (!metric.available) symptoms.push(c.mtuBlackhole ? "Large-packet delivery blackhole" : !c.powered ? "Transport lost after DC depletion" : c.cpu >= 95 ? "Control-plane overload" : "Selected path unavailable");
    if (metric.lossPct > 5) symptoms.push(`Delivery loss ${metric.lossPct}%`);
    if (metric.latencyMs > 50) symptoms.push(`RTT ${metric.latencyMs} ms`);
    if (c.offset > 5) symptoms.push(`Timing drift ${round(c.offset)} µs`);
    if (c.vswr > 2.5) symptoms.push(`Feeder mismatch / VSWR ${c.vswr}`);
    if (e.gridLostAt !== null) symptoms.push(`Grid absent / ${round(e.batteryWh)} Wh battery`);
    if (!value.radioUp) symptoms.push("Cell administratively stopped");
    metric.symptoms = symptoms;
  }
  function resourceSnapshot(state,ids,ctx) {
    return {sites:Object.fromEntries(ids.map(id => [id,ctx.snap(state.sites[id])])),regions:copy(state.regions),core:copy(state.core),services:copy(state.services)};
  }
  function probe(state,c,actor,ctx) {
    ctx.assert(actor === "operator","Modeled operator required"); ctx.assert(Object.hasOwn(probes,c.probe),"Unknown diagnostic probe");
    const target = ctx.site(state,c.site), m = target.metrics, e = target.equipment;
    ctx.assert(m && m.tick === state.tick,"Advance the clock before collecting diagnostic evidence");
    ctx.assert(ctx.canonical(target.observedContext) === ctx.canonical(ctx.snap(target)),"Site conditions changed; advance the clock before probing");
    const capacity = Object.values(state.sites).filter(s=>s.region===target.region);
    const result = {
      mtu:{selectedPath:target.selected,interfacesUp:Object.values(target.links).every(l=>l.up),packetBytes:e.packetBytes,backupMtu:e.backupMtu,pmtudBlocked:e.pmtudBlocked,mssClamp:target.config.mssClamp,largePacketFailure:m.mtuBlackhole},
      queues:{regionalOfferedMbps:capacity.reduce((n,s)=>n+s.demand,0),regionalCapacityMbps:state.regions[target.region].capacity,coreCapacityMbps:state.core.capacity,coreOfferedMbps:Object.values(state.sites).reduce((n,s)=>n+s.demand,0),sites:capacity.map(s=>({site:s.id,accessCapacity:s.selected==="backup"?s.config.backupCapacity:s.config.primaryCapacity,delivered:s.metrics.throughputMbps,loss:s.metrics.lossPct}))},
      timing:{offsetUs:m.timingOffsetUs,holdoverSince:e.ptpLostAt,alternateReference:target.config.clockBackup,labToleranceUs:5},
      rf:{vswr:m.vswr,reflectedPowerPct:m.reflectedPowerPct,modeledRadioBudgetMbps:m.radioBudgetMbps,feederWorkOrderCompleted:target.config.rfRepaired},
      bgp:{interfacesUp:Object.values(target.links).every(l=>l.up),importGuard:target.config.prefixGuard,receivedPrefixes:e.leakedPrefixes,acceptedPrefixes:m.acceptedPrefixes,cpuPct:m.cpuPct,controlPlaneAvailable:m.cpuPct<95},
      power:{gridAvailable:m.gridAvailable,batteryWh:m.batteryWh,reserveWh:m.reserveWh,loadW:e.loadW,reserveCommissioned:target.config.reservePower,powered:m.powered},
      telemetry:{services:copy(state.services),outbox:state.outbox.length,storageLag:ctx.lag(state,"storage"),detectionLag:ctx.lag(state,"detection"),lastDetectedTick:Math.max(-1,...Object.values(state.detections).filter(d=>d.site===target.id).map(d=>d.tick))},
    }[c.probe];
    const value = {id:ctx.id(state,"probe"),type:c.probe,site:c.site,region:target.region,tick:state.tick,context:ctx.snap(target),result,
      scopeContext:c.probe==="queues" ? resourceSnapshot(state,Object.keys(state.sites),ctx) : null,services:copy(state.services)};
    state.probes.push(value); ctx.observe(state,actor,"diagnostic_probe",`${value.id}: ${probes[c.probe]} / ${c.site}`);
  }
  function loadCase(state,c,actor,ctx) {
    ctx.assert(actor === "operator","Modeled operator required"); ctx.assert(Object.hasOwn(cases,c.caseId),"Unknown engineering case");
    const target = ctx.site(state,c.site), definition = cases[c.caseId];
    ctx.assert(!state.cases.some(v=>v.caseId===c.caseId && v.site===c.site && v.state!=="solved"),"This case is already active for the selected site");
    ctx.assert(!state.jobs.some(j=>["executing","rolling_back"].includes(j.state)),"Wait for active changes before injecting a case");
    const regional = Object.values(state.sites).filter(v=>v.region===target.region);
    const affected = definition.scope === "region" ? regional.map(s=>s.id) : definition.scope === "fleet" ? Object.keys(state.sites) : [c.site];
    if (c.caseId === "mtu_trap") {target.links.primary.delay=120; target.equipment.backupMtu=1280; target.equipment.pmtudBlocked=true;target.config.mssClamp=false;target.config.backupPreference=80;target.revision++;target.convergence=2;}
    if (c.caseId === "capacity_cascade") {for(const s of regional)s.demand=300; state.regions[target.region].capacity=400;state.regions[target.region].revision++;state.core.capacity=1900;state.core.revision++;}
    if (c.caseId === "timing_rf") {target.equipment.ptpLostAt=state.tick-8;target.equipment.vswr=3.8;target.config.clockBackup=false;target.config.rfRepaired=false;target.revision++;}
    if (c.caseId === "route_storm") {target.equipment.leakedPrefixes=1200;target.config.prefixGuard=false;target.links.primary.delay=30;target.revision++;}
    if (c.caseId === "power_chain") {target.equipment.gridLostAt=state.tick;target.equipment.batteryWh=1;target.equipment.reserveWh=480;target.config.reservePower=false;target.revision++;}
    if (c.caseId === "blind_noc") {target.links.primary.delay=120;state.services.broker=false;state.services.detector=false;}
    state.cases.push({id:ctx.id(state,"case"),caseId:c.caseId,site:c.site,region:target.region,affected,startedAt:state.tick,state:"investigating",stableTicks:0,solvedAt:null});
    ctx.observe(state,actor,"engineering_case_injected",`${definition.label}: ${affected.length} sites in investigation scope`);
  }
  function requiredProbes(state,value,ctx) {
    const requirements=value.requirements || actions[value.action].probes.map(type=>({type,site:value.site}));
    return requirements.map(({type,site:probeSite})=> {
      const expected=value.baseline.sites[probeSite] || value.before;
      const found = [...state.probes].reverse().find(p=>p.type===type && p.site===probeSite && state.tick-p.tick<=30 && p.tick>=value.createdAt-30 && ctx.canonical(p.context)===ctx.canonical(expected)
        && (type!=="queues" || ctx.canonical(p.scopeContext)===ctx.canonical(value.baseline)) && (type!=="telemetry" || ctx.canonical(p.services)===ctx.canonical(value.baseline.services)));
      ctx.assert(found,`Collect a current ${probes[type]} probe for ${probeSite} before approval (valid for 30 ticks)`); return found.id;
    });
  }
  function campaign(state,ctx) {
    const active=state.cases.filter(c=>c.state!=="solved");ctx.assert(active.length,"Inject engineering cases before proposing a coordinated campaign");
    const bundle={},regions={},requirements=[],servicesPatch={};
    for(const c of active){const action=actions[cases[c.caseId].action];bundle[c.site]={...bundle[c.site],...action.patch};
      for(const type of cases[c.caseId].probes)if(!requirements.some(r=>r.type===type&&r.site===c.site))requirements.push({site:c.site,type});
      if(c.caseId==="capacity_cascade"){const members=Object.values(state.sites).filter(s=>s.region===c.region);regions[c.region]=Math.max(1600,members.reduce((n,s)=>n+s.demand,0)*1.2);
        for(const s of members)bundle[s.id]={...bundle[s.id],primaryCapacity:Math.max(350,s.demand),backupCapacity:Math.max(350,s.demand)};}
      if(c.caseId==="blind_noc"){Object.assign(servicesPatch,{broker:true,storage:true,detector:true});bundle[c.site]={...bundle[c.site],backupPreference:200,mssClamp:true};}
    }
    return {bundle,requirements,servicesPatch,resources:{regions,coreCapacity:Math.max(state.core.capacity,5000,Object.values(state.sites).reduce((n,s)=>n+s.demand,0)*1.2)}};
  }
  function handles(state,c) {
    return ["APPLY_CASE","RUN_PROBE"].includes(c.type) || c.type === "PROPOSE" && Object.hasOwn(actions,c.action) || ["APPROVE","EXECUTE","ACCEPT_INTENT"].includes(c.type) && state.jobs.some(j=>j.id===c.jobId && j.engineering);
  }
  function handle(state,c,actor,ctx) {
    if(c.type==="APPLY_CASE")return loadCase(state,c,actor,ctx);
    if(c.type==="RUN_PROBE")return probe(state,c,actor,ctx);
    if(c.type==="PROPOSE") {
      ctx.assert(actor==="operator","Modeled operator required"); const target=ctx.site(state,c.site), action=actions[c.action];
      ctx.assert(typeof c.reason==="string" && c.reason.trim().length>=5,"A reason is required");
      const ids=action.scope==="fleet"?Object.keys(state.sites):[c.site];
      ctx.assert(!state.jobs.some(j=>["executing","rolling_back"].includes(j.state)&&(ids.includes(j.site)||(j.affected||[]).some(id=>ids.includes(id)))),"An overlapping change is active");
      const regionSites=Object.values(state.sites).filter(s=>s.region===target.region).map(s=>s.id);
      if(c.action==="coordinated_recovery") {
        const plan=campaign(state,ctx),candidate={...target.config,...(plan.bundle[c.site]||{})};
        const j={id:ctx.id(state,"job"),engineering:true,site:c.site,action:c.action,kind:action.kind,reason:c.reason.trim(),author:actor,state:"proposed",createdAt:state.tick,expiresAt:state.tick+60,
          before:ctx.snap(target),candidate,affected:ids,regionSites:[],...plan,baseline:resourceSnapshot(state,ids,ctx),observations:[],scopeObservations:[],approval:null,regressionGuard:Object.values(state.sites).filter(s=>ctx.healthy(s.metrics)).map(s=>s.id)};
        state.jobs.push(j);ctx.observe(state,actor,"change_proposed",`${j.id}: ${Object.keys(j.bundle).length} site patches; ${j.requirements.length} diagnostics required`);return;
      }
      const plan=c.plan || {accessCapacity:350,regionalCapacity:Math.max(1600,regionSites.length*350),coreCapacity:Math.max(5000,Object.keys(state.sites).length*350)};
      if(c.plan!==undefined){ctx.assert(c.action==="capacity_plan" && c.plan && typeof c.plan==="object" && !Array.isArray(c.plan) && Object.keys(c.plan).length===3 && Object.keys(c.plan).every(k=>["accessCapacity","regionalCapacity","coreCapacity"].includes(k)),"Use the three declared capacity plan fields");
        for(const [key,max] of [["accessCapacity",1000],["regionalCapacity",50000],["coreCapacity",50000]])ctx.assert(Number.isFinite(plan[key])&&plan[key]>=100&&plan[key]<=max,"Capacity plan value outside model bounds");}
      const patch=c.action==="capacity_plan"?{primaryCapacity:plan.accessCapacity,backupCapacity:plan.accessCapacity}:action.patch;
      const candidate={...target.config,...patch};
      const resources=c.action==="capacity_plan"?{region:target.region,regionalCapacity:plan.regionalCapacity,coreCapacity:plan.coreCapacity}:null;
      ctx.assert(ctx.canonical(candidate)!==ctx.canonical(target.config) || resources && (resources.regionalCapacity!==state.regions[target.region].capacity || resources.coreCapacity!==state.core.capacity || regionSites.some(id=>state.sites[id].config.primaryCapacity!==plan.accessCapacity || state.sites[id].config.backupCapacity!==plan.accessCapacity)) || c.action==="restore_pipeline" && (!state.services.broker||!state.services.storage||!state.services.detector),"Candidate is identical to running configuration");
      const j={id:ctx.id(state,"job"),engineering:true,site:c.site,action:c.action,kind:action.kind,reason:c.reason.trim(),author:actor,state:"proposed",createdAt:state.tick,expiresAt:state.tick+60,
        before:ctx.snap(target),candidate,patch:copy(patch),affected:ids,regionSites,resources,baseline:resourceSnapshot(state,ids,ctx),observations:[],scopeObservations:[],approval:null,regressionGuard:Object.values(state.sites).filter(s=>ctx.healthy(s.metrics)).map(s=>s.id)};
      state.jobs.push(j);ctx.observe(state,actor,"change_proposed",`${j.id}: ${action.kind}; ${ids.length} sites in verification scope`);return;
    }
    const j=state.jobs.find(j=>j.id===c.jobId), target=ctx.site(state,j.site);
    if(c.type==="APPROVE") {
      ctx.assert(actor==="reviewer" && actor!==j.author,"Independent modeled reviewer required");ctx.assert(j.state==="proposed" && state.tick<j.expiresAt,"Proposal is no longer reviewable");
      ctx.assert(ctx.canonical(resourceSnapshot(state,j.affected,ctx))===ctx.canonical(j.baseline),"Configuration or environment changed; propose again");
      j.probeIds=requiredProbes(state,j,ctx);j.approval={actor,tick:state.tick};j.state="approved";ctx.observe(state,actor,"change_approved",j.id);return;
    }
    if(c.type==="EXECUTE") {
      ctx.assert(actor==="operator","Modeled operator required");ctx.assert(j.state==="approved" && j.approval && state.tick<j.expiresAt,"Current independent approval required");
      ctx.assert(ctx.canonical(resourceSnapshot(state,j.affected,ctx))===ctx.canonical(j.baseline),"Configuration or environment changed; propose and review again");requiredProbes(state,j,ctx);
      ctx.assert(!state.jobs.some(other=>other.id!==j.id&&["executing","rolling_back"].includes(other.state)&&(j.affected.includes(other.site)||(other.affected||[]).some(id=>j.affected.includes(id)))),"An overlapping change is active");
      const patches=j.bundle || Object.fromEntries((j.action==="capacity_plan"?j.regionSites:[j.site]).map(id=>[id,j.patch]));
      for(const [id,patch] of Object.entries(patches)) {const s=state.sites[id];Object.assign(s.config,patch);s.revision++;s.convergence=2;}
      if(j.resources){const regional=j.resources.regions || {[j.resources.region]:j.resources.regionalCapacity};for(const [id,capacity] of Object.entries(regional)){state.regions[id].capacity=capacity;state.regions[id].revision++;}state.core.capacity=j.resources.coreCapacity;state.core.revision++;}
      if(j.servicesPatch)Object.assign(state.services,j.servicesPatch);
      if(j.action==="restore_pipeline")Object.assign(state.services,{broker:true,storage:true,detector:true});
      j.startedAt=state.tick;j.state="executing";ctx.observe(state,actor,"change_executing",j.id);return;
    }
    ctx.assert(actor==="reviewer" && j.state==="verified" && !j.intentAcceptedAt,"Only a verified, unaccepted change can update intent");
    const touched=j.bundle?Object.keys(j.bundle):j.action==="capacity_plan"?j.regionSites:[j.site];
    for(const id of touched)ctx.assert(ctx.canonical(state.sites[id].config)===ctx.canonical(j.afterScope[id].config)&&state.sites[id].revision===j.afterScope[id].revision,"Running state changed since verification");
    if(j.resources)ctx.assert(ctx.canonical(state.core)===ctx.canonical(j.afterResources.core)&&ctx.canonical(state.regions)===ctx.canonical(j.afterResources.regions),"Capacity changed since verification");
    for(const id of touched)state.sites[id].intent=copy(state.sites[id].config);
    j.intentAcceptedAt=state.tick;state.inventoryRevision++;ctx.observe(state,actor,"intent_updated",j.id);
  }
  function restore(state,j) {
    const touched=j.bundle?Object.keys(j.bundle):j.action==="capacity_plan"?j.regionSites:[j.site];
    for(const id of touched){const s=state.sites[id], completedWork={rfRepaired:s.config.rfRepaired,reservePower:s.config.reservePower};s.config=copy(j.baseline.sites[id].config);
      // A configuration rollback cannot undo a completed physical task. Its evidence remains visible.
      if(j.action==="recover_radio" || j.bundle?.[id].rfRepaired)s.config.rfRepaired=completedWork.rfRepaired;
      if(j.action==="reserve_power" || j.bundle?.[id].reservePower)s.config.reservePower=completedWork.reservePower;
      s.revision++;s.convergence=2;}
    if(j.resources){for(const id of Object.keys(state.regions)){state.regions[id].capacity=j.baseline.regions[id].capacity;state.regions[id].revision++;}state.core.capacity=j.baseline.core.capacity;state.core.revision++;}
    if(j.action==="restore_pipeline" || j.servicesPatch)state.services=copy(j.baseline.services);
  }
  function objective(state,j,ctx) {
    if(j.action==="restore_pipeline")return state.services.broker&&state.services.storage&&state.services.detector&&!state.outbox.length&&!ctx.lag(state,"storage")&&!ctx.lag(state,"detection");
    return j.affected.every(id=>ctx.healthy(state.sites[id].metrics)) && j.regressionGuard.every(id=>ctx.healthy(state.sites[id].metrics)) && (!j.servicesPatch || state.services.broker&&state.services.storage&&state.services.detector&&!state.outbox.length&&!ctx.lag(state,"storage")&&!ctx.lag(state,"detection"));
  }
  function verify(state,ctx) {
    for(const j of state.jobs.filter(j=>j.engineering&&j.state==="executing")) {
      if(state.tick<j.startedAt+2)continue;
      j.observations.push(copy(state.sites[j.site].metrics));
      j.scopeObservations.push({tick:state.tick,passed:objective(state,j,ctx),sites:Object.fromEntries(j.affected.map(id=>[id,copy(state.sites[id].metrics)])),storageLag:ctx.lag(state,"storage"),detectionLag:ctx.lag(state,"detection")});
      if(j.observations.length<3)continue;
      if(j.scopeObservations.every(o=>o.passed)){j.state="verified";j.afterScope=Object.fromEntries(j.affected.map(id=>[id,ctx.snap(state.sites[id])]));j.afterResources={core:copy(state.core),regions:copy(state.regions)};ctx.finishJob(state,j);}
      else{restore(state,j);j.state="rolling_back";j.rollback={configRestoredAt:state.tick,recovery:"pending",physicalWorkRetained:["recover_radio","reserve_power"].includes(j.action)||Object.values(j.bundle||{}).some(p=>p.rfRepaired||p.reservePower),observations:[]};ctx.observe(state,"executor","rollback_started",`${j.id}: scoped verification failed; ${j.rollback.physicalWorkRetained?"completed field work is retained":"configuration baseline restored"}`);}
    }
    for(const j of state.jobs.filter(j=>j.engineering&&j.state==="rolling_back")) {
      if(state.tick<j.rollback.configRestoredAt+2)continue;
      j.rollback.observations.push({tick:state.tick,scopeHealthy:objective(state,j,ctx),target:copy(state.sites[j.site].metrics)});
      if(j.rollback.observations.length>=2){j.rollback.recovery=j.rollback.observations.every(o=>o.scopeHealthy)?"modeled_scope_recovered":"scope_still_degraded";j.state="rolled_back";ctx.finishJob(state,j);}
    }
    for(const c of state.cases) {
      const definition=cases[c.caseId];
      const diagnostics=definition.probes.every(type=>state.probes.some(p=>p.site===c.site&&p.type===type&&p.tick>c.startedAt));
      const reviewed=state.jobs.some(j=>j.state==="verified"&&(j.site===c.site || j.bundle&&Object.hasOwn(j.bundle,c.site))&&j.createdAt>=c.startedAt);
      const service=c.affected.every(id=>ctx.healthy(state.sites[id].metrics));
      const fresh=state.services.broker&&state.services.storage&&state.services.detector&&!state.outbox.length&&!ctx.lag(state,"detection")&&!ctx.lag(state,"storage");
      if(service&&fresh&&diagnostics&&reviewed)c.stableTicks++;else c.stableTicks=0;
      c.state=c.stableTicks>=3?"solved":service?"validating":"investigating";
      if(c.state==="solved"&&c.solvedAt===null){c.solvedAt=state.tick;ctx.observe(state,"verifier","engineering_case_solved",`${c.id}: scoped service and observability stable for three ticks`);}
    }
  }
  function diagnose(state,siteId) {
    const s=state.sites[siteId],m=s.metrics;if(!m)return[];
    const causes=[];
    const add=(condition,title,evidence,probe,action)=>{if(condition)causes.push({title,evidence,probe,action});};
    add(m.mtuBlackhole || s.equipment.backupMtu<s.equipment.packetBytes&&s.equipment.pmtudBlocked&&!s.config.mssClamp,"Backup MTU / blocked PMTUD",`Packet ${s.equipment.packetBytes} B > backup MTU ${s.equipment.backupMtu} B. Interfaces can remain up.`,"mtu","safe_failover");
    const offered=Object.values(state.sites).reduce((n,s)=>n+s.demand,0),regionalOffered=Object.values(state.sites).filter(v=>v.region===s.region).reduce((n,s)=>n+s.demand,0);
    add(m.lossPct>5&&m.available&&(s.demand>(s.selected==="backup"?s.config.backupCapacity:s.config.primaryCapacity)||regionalOffered>state.regions[s.region].capacity||offered>state.core.capacity),"Access or shared capacity constraint",`${s.demand} Mbps offered; ${m.throughputMbps} delivered. Compare access, region and core queues.`,"queues","capacity_plan");
    add(m.lossPct>5&&m.available&&s.links[s.selected]?.loss>5,"Selected-path impairment",`Configured link loss ${s.links[s.selected].loss}% contributes to delivery loss. Inspect backup constraints before rerouting.`,"mtu","safe_failover");
    add(m.cpuPct>=95,"Route-import burst overload",`${m.acceptedPrefixes} accepted prefixes; modeled CPU ${m.cpuPct}%. Inspect import policy before rerouting.`,"bgp","contain_leak");
    add(m.timingOffsetUs>5,"PTP reference lost / holdover drift",`Offset ${m.timingOffsetUs} µs exceeds this lab's 5 µs tolerance.`,"timing","clock_backup");
    add(m.vswr>2.5,"RF feeder mismatch",`VSWR ${m.vswr}; calculated reflected power ${m.reflectedPowerPct}%. Physical repair is a work order.`,"rf","recover_radio");
    add(!m.gridAvailable,s.config.reservePower?"Grid loss / emergency reserve active":"Grid loss / finite DC autonomy",`Battery ${m.batteryWh} Wh; reserve ${m.reserveWh} Wh; load ${s.equipment.loadW} W. ${s.config.reservePower?"Reserve commissioned; monitor remaining autonomy.":"Commission reserve before depletion."}`,"power",s.config.reservePower?null:"reserve_power");
    add(!state.services.broker||!state.services.detector||state.outbox.length>0,"Observability is behind the network",`${state.outbox.length} unsent events. Missing alarms do not demonstrate service health.`,"telemetry","restore_pipeline");
    add(m.latencyMs>50&&!m.mtuBlackhole,"Primary delay or queueing",`RTT ${m.latencyMs} ms. Check alternate-path constraints before failover.`,"mtu","safe_failover");
    return causes;
  }
  return {actions,probes,cases,initialize,context,prepare,conditions,enrich,handles,handle,verify,diagnose};
});
