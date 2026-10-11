/* Public deterministic demonstration only; no runtime configuration or environment reads. */
const fs=require("node:fs");
const path=require("node:path");
const M=require("../console/assets/twin-model.js");
const root=path.resolve(__dirname,"..");
const catalog=JSON.parse(fs.readFileSync(path.join(root,"console/assets/twin-blueprint.json"),"utf8"));
let state=M.step(M.initial(catalog),{type:"ADVANCE",ticks:1});
const run=command=>{state=M.step(state,{actor:"operator",...command});};
for(const [site,caseId] of [["JKT-001","mtu_trap"],["BDG-001","capacity_cascade"],["SBY-001","timing_rf"],["MDN-001","route_storm"],["DPS-001","power_chain"],["MKS-001","blind_noc"]])run({type:"APPLY_CASE",site,caseId});
run({type:"ADVANCE",ticks:5});
for(const c of state.cases)for(const probe of M.cases[c.caseId].probes)run({type:"RUN_PROBE",site:c.site,probe});
run({type:"PROPOSE",site:"JKT-001",action:"coordinated_recovery",reason:"Coordinate six coupled failures: protect routing, restore timing/RF/power, right-size shared capacity and recover event delivery"});
const jobId=state.jobs.at(-1).id;run({type:"APPROVE",actor:"reviewer",jobId});run({type:"EXECUTE",jobId});run({type:"ADVANCE",ticks:6});
if(state.jobs.at(-1).state!=="verified"||state.cases.some(c=>c.state!=="solved")||!Object.values(state.sites).every(s=>M.healthy(s.metrics)))throw new Error("Engineering campaign did not verify");
const journal=M.exportJournal(state,catalog);M.replay(journal);
fs.writeFileSync(path.join(root,"console/assets/twin-solved-example.json"),JSON.stringify(journal,null,2)+"\n");
console.log(`Solved campaign: ${state.cases.length} cases, ${Object.keys(state.sites).length} healthy sites, ${state.probes.length} probes, ${state.commands.length} reproducible commands at T+${state.tick}.`);
