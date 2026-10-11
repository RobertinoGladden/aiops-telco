const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const M = require("../console/assets/twin-model.js");
const catalog = JSON.parse(fs.readFileSync(`${__dirname}/../console/assets/twin-blueprint.json`,"utf8"));
const site = "JKT-001";
const step = (s,c) => M.step(s,{actor:"operator",...c});
const advance = (s,ticks=5) => step(s,{type:"ADVANCE",ticks});
const start = () => advance(M.initial(catalog),1);
const inject = (s,caseId) => advance(step(s,{type:"APPLY_CASE",caseId,site}),1);
const probe = (s,type) => step(s,{type:"RUN_PROBE",site,probe:type});
function execute(s,action) {
  s=step(s,{type:"PROPOSE",site,action,reason:"Evidence-based engineering recovery"});
  const jobId=s.jobs.at(-1).id;
  s=step(s,{type:"APPROVE",actor:"reviewer",jobId});
  return step(s,{type:"EXECUTE",jobId});
}
test("24 unique sites are healthy across six bounded regions and all three partitions",()=> {
  const s=start();assert.equal(Object.keys(s.sites).length,24);assert.equal(Object.keys(s.regions).length,6);
  assert.ok(Object.values(s.sites).every(v=>M.healthy(v.metrics)));
  assert.deepEqual(s.topics.telemetry.map(p=>p.length),[8,8,8]);
  assert.equal(M.lag(s,"detection"),0);assert.deepEqual(M.replay(M.exportRun(s,catalog)),s);
  assert.throws(()=>M.initial({...catalog,sites:[...catalog.sites,...catalog.sites]}),/duplicate/);
});
test("MTU trap defeats a naive failover, rolls back, and requires a probe before a safe plan",()=> {
  let s=inject(start(),"mtu_trap");s=advance(execute(s,"prefer_backup"),8);
  assert.equal(s.jobs.at(-1).state,"rolled_back");assert.equal(s.jobs.at(-1).observations[0].mtuBlackhole,true);
  assert.equal(s.jobs.at(-1).rollback.recovery,"path_still_degraded");
  let proposed=step(s,{type:"PROPOSE",site,action:"safe_failover",reason:"Fix the packet size and path together"});
  assert.throws(()=>step(proposed,{type:"APPROVE",actor:"reviewer",jobId:proposed.jobs.at(-1).id}),/probe/);
  s=probe(s,"mtu");s=advance(execute(s,"safe_failover"),6);
  assert.equal(s.jobs.at(-1).state,"verified");assert.equal(s.cases[0].state,"solved");
  assert.equal(s.sites[site].metrics.mtuBlackhole,false);assert.ok(M.healthy(s.sites[site].metrics));
  assert.ok(!M.diagnose(s,site).some(c=>c.title==="Backup MTU / blocked PMTUD"),"The applied mitigation clears the active hypothesis");
  assert.deepEqual(M.replay(M.exportRun(s,catalog)),s);
});
test("capacity plan verifies all 24 sites and guards overlapping changes and stale resource approvals",()=> {
  let s=inject(start(),"capacity_cascade");
  assert.ok(Object.values(s.sites).some(v=>v.region!=="JKT"&&!M.healthy(v.metrics)),"The core bottleneck propagates outside the originating region");
  s=probe(s,"queues");s=execute(s,"capacity_plan");
  assert.throws(()=>step(s,{type:"PROPOSE",site:"BDG-001",action:"prefer_backup",reason:"Concurrent route change"}),/active change/);
  s=advance(s,6);const j=s.jobs.at(-1);assert.equal(j.state,"verified");assert.equal(j.scopeObservations.length,3);
  assert.equal(Object.keys(j.scopeObservations[0].sites).length,24);assert.ok(Object.values(s.sites).every(v=>M.healthy(v.metrics)));
  assert.equal(s.cases[0].state,"solved");assert.equal(s.regions.JKT.capacity,1600);
  assert.deepEqual(M.replay(M.exportRun(s,catalog)),s);
});
test("timing-only recovery fails with feeder mismatch, while the combined work order recovers service",()=> {
  let s=inject(start(),"timing_rf");assert.equal(s.sites[site].metrics.available,true);assert.equal(M.healthy(s.sites[site].metrics),false);
  s=probe(s,"timing");s=advance(execute(s,"clock_backup"),8);
  assert.equal(s.jobs.at(-1).state,"rolled_back");assert.equal(s.cases[0].state,"investigating");
  s=probe(probe(s,"timing"),"rf");s=advance(execute(s,"recover_radio"),6);
  assert.equal(s.jobs.at(-1).state,"verified");assert.equal(s.cases[0].state,"solved");
  assert.ok(s.jobs.at(-1).kind.includes("field work order"));assert.equal(s.sites[site].metrics.radioHealthy,true);
});
test("route leak is constrained by the reviewed prefix guard instead of changing physical link state",()=> {
  let s=inject(start(),"route_storm");assert.equal(s.sites[site].metrics.cpuPct,100);
  assert.ok(Object.values(s.sites[site].links).every(v=>v.up));
  s=probe(s,"bgp");s=advance(execute(s,"contain_leak"),6);
  assert.equal(s.sites[site].metrics.acceptedPrefixes,1);assert.equal(s.jobs.at(-1).state,"verified");assert.equal(s.cases[0].state,"solved");
});
test("grid failure depletes finite energy and emergency commissioning does not create perpetual power",()=> {
  let s=inject(start(),"power_chain");s=advance(s,5);assert.equal(s.sites[site].metrics.powered,false);
  s=probe(s,"power");s=advance(execute(s,"reserve_power"),6);assert.equal(s.jobs.at(-1).state,"verified");
  assert.ok(s.sites[site].equipment.reserveWh<480);assert.equal(s.sites[site].metrics.gridAvailable,false);
  assert.equal(M.diagnose(s,site).find(c=>c.probe==="power").action,null,"A commissioned reserve is monitored rather than proposed again");
  const before=s.sites[site].equipment.reserveWh;s=advance(s,30);assert.ok(s.sites[site].equipment.reserveWh<before);
});
test("restored ingestion verifies visibility but the blind NOC case needs transport recovery too",()=> {
  let s=inject(start(),"blind_noc");s=advance(s,3);assert.ok(s.outbox.length>0);assert.equal(s.incidents.length,0);
  s=probe(s,"telemetry");s=advance(execute(s,"restore_pipeline"),5);
  assert.equal(s.jobs.at(-1).state,"verified");assert.equal(M.lag(s,"detection"),0);assert.notEqual(s.cases[0].state,"solved");
  assert.ok(s.incidents.some(i=>i.site===site&&i.state==="open"));
  s=advance(execute(s,"prefer_backup"),6);assert.equal(s.cases[0].state,"solved");
});
test("diagnostics reject unobserved faults and expire; context changes invalidate a scoped approval",()=> {
  let s=step(start(),{type:"APPLY_CASE",caseId:"mtu_trap",site});
  assert.throws(()=>probe(s,"mtu"),/advance the clock/i);
  s=probe(advance(s,1),"mtu");s=advance(s,30);s=advance(s,1);
  let p=step(s,{type:"PROPOSE",site,action:"safe_failover",reason:"Recheck diagnostic freshness"});
  assert.throws(()=>step(p,{type:"APPROVE",actor:"reviewer",jobId:p.jobs.at(-1).id}),/probe/);
  s=probe(s,"mtu");s=step(s,{type:"PROPOSE",site,action:"safe_failover",reason:"Scoped baseline must remain stable"});
  const jobId=s.jobs.at(-1).id;s=step(s,{type:"APPROVE",actor:"reviewer",jobId});
  s=step(s,{type:"FAULT",site,fault:"demand",value:120});
  assert.throws(()=>step(s,{type:"EXECUTE",jobId}),/environment changed/);
});
test("advanced forecasts branch all sites without mutating current evidence or approval",()=> {
  let s=probe(inject(start(),"capacity_cascade"),"queues"), before=M.canonical(s);
  const result=M.forecast(s,{site,action:"capacity_plan"});assert.equal(result.comparison.length,24);
  assert.equal(result.job.state,"verified");assert.equal(M.canonical(s),before);
});
test("a partial capacity upgrade moves the bottleneck and fails scoped verification",()=> {
  const s=probe(inject(start(),"capacity_cascade"),"queues"),before=M.canonical(s);
  const partial=M.forecast(s,{site,action:"capacity_plan",plan:{accessCapacity:350,regionalCapacity:1600,coreCapacity:1900}});
  assert.equal(partial.job.state,"rolled_back");assert.ok(partial.job.scopeObservations.some(o=>!o.passed));
  assert.equal(partial.job.rollback.recovery,"scope_still_degraded");assert.equal(M.canonical(s),before);
  assert.throws(()=>M.forecast(s,{site,action:"capacity_plan",plan:{accessCapacity:0,regionalCapacity:1600,coreCapacity:5000}}),/bounds/);
});
test("a queue probe becomes stale when another region's offered demand changes",()=> {
  let s=probe(inject(start(),"capacity_cascade"),"queues");
  s=step(s,{type:"FAULT",site:"BDG-001",fault:"demand",value:150});
  s=step(s,{type:"PROPOSE",site,action:"capacity_plan",reason:"Verify network-wide diagnostic context"});
  assert.throws(()=>step(s,{type:"APPROVE",actor:"reviewer",jobId:s.jobs.at(-1).id}),/probe/);
});
test("compact journals rebuild complete state and reject altered summary evidence",()=> {
  let s=probe(inject(start(),"route_storm"),"bgp");s=advance(execute(s,"contain_leak"),6);s=advance(s,30);
  const journal=M.exportJournal(s,catalog);assert.deepEqual(M.replay(journal),s);
  assert.ok(JSON.stringify(journal).length<JSON.stringify(M.exportRun(s,catalog)).length/4);
  journal.finalSummary.cases[0].state="investigating";assert.throws(()=>M.replay(journal),/summary/);
});
test("rollback preserves completed field work while reverting the failed timing policy",()=> {
  let s=probe(probe(inject(start(),"timing_rf"),"timing"),"rf");
  s=step(s,{type:"FAULT",site,fault:"primary_delay",value:120});s=advance(s,1);s=probe(probe(s,"timing"),"rf");
  s=advance(execute(s,"recover_radio"),8);
  assert.equal(s.jobs.at(-1).state,"rolled_back");assert.equal(s.jobs.at(-1).rollback.physicalWorkRetained,true);
  assert.equal(s.sites[site].config.rfRepaired,true);assert.equal(s.sites[site].config.clockBackup,false);
});
test("frozen v2 runs verify before being reinterpreted under the current three-site compatibility model",()=> {
  const oldCatalog=JSON.parse(fs.readFileSync(`${__dirname}/../lab/reference/twin-blueprint-v2.json`,"utf8"));
  const V2=require("../console/assets/twin-model-v2.js");const old=V2.step(V2.initial(oldCatalog),{type:"ADVANCE",ticks:2});
  const run=V2.exportRun(old,oldCatalog);assert.equal(M.migrate(run).version,M.VERSION);
  run.finalState.tick++;assert.throws(()=>M.migrate(run),/Replay differs/);
});
test("the solved campaign reproduces six simultaneous cases with full-fleet evidence and rejects missing diagnostics",()=> {
  const journal=JSON.parse(fs.readFileSync(`${__dirname}/../console/assets/twin-solved-example.json`,"utf8"));
  const s=M.replay(journal),j=s.jobs[0];assert.equal(s.cases.length,6);assert.ok(s.cases.every(c=>c.state==="solved"));
  assert.equal(s.probes.length,7);assert.equal(j.approval.actor,"reviewer");assert.equal(j.state,"verified");
  assert.equal(j.affected.length,24);assert.equal(Object.keys(j.bundle).length,9);assert.equal(j.scopeObservations.length,3);
  assert.ok(s.history.find(h=>h.tick===6).sites["MDN-001"].cpuPct>=95);assert.equal(s.history.find(h=>h.tick===6).sites["DPS-001"].powered,false);
  assert.ok(Object.values(s.sites).every(s=>M.healthy(s.metrics)));
  let missing=M.initial(catalog);
  for(const command of journal.commands){if(command.type==="APPROVE")break;if(command.type==="RUN_PROBE"&&command.probe==="bgp")continue;missing=M.step(missing,command);}
  assert.throws(()=>step(missing,{type:"APPROVE",actor:"reviewer",jobId:missing.jobs[0].id}),/BGP.*MDN-001/);
});
