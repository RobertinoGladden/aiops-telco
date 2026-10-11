/* Read-only monitoring projections. Provider readiness comes from the Hub, never inferred here. */
(function(root,factory){
  const api=factory(typeof module==="object"&&module.exports?require("./twin-model.js"):root.StrataTwin);
  if(typeof module==="object"&&module.exports)module.exports=api;else root.StrataMonitor=api;
})(typeof globalThis!=="undefined"?globalThis:this,function(M){
  "use strict";
  const round=n=>Math.round(n*100)/100;
  function severity(metric){
    if(!metric)return "unknown";
    if(!metric.available||metric.radioHealthy===false)return "critical";
    if(!M.healthy(metric)||metric.gridAvailable===false)return "warning";
    return "healthy";
  }
  function utilization(offered,capacity){return capacity>0?round(100*offered/capacity):null;}
  function capacityStatus(ratio){return ratio===null?"unknown":ratio>100?"critical":ratio>=80?"warning":"healthy";}
  function windowFrames(state,count){
    if(![60,120,300].includes(count))throw new Error("Use a declared dashboard window");
    return state.history.slice(-count);
  }
  function traffic(state,count){return windowFrames(state,count).map(f=>({tick:f.tick,offered:round(Object.values(f.sites).reduce((n,m)=>n+m.demandMbps,0)),delivered:round(Object.values(f.sites).reduce((n,m)=>n+m.throughputMbps,0)),healthy:Object.values(f.sites).filter(M.healthy).length}));}
  function healthHistory(state,count){
    const frames=windowFrames(state,count),stride=Math.max(1,Math.ceil(frames.length/60)),rank={healthy:0,unknown:1,warning:2,critical:3};
    return {stride,frames,rows:Object.keys(state.sites).map(site=>({site,cells:Array.from({length:Math.ceil(frames.length/stride)},(_,i)=>{
      const bucket=frames.slice(i*stride,(i+1)*stride);
      const status=bucket.reduce((current,f)=>{const next=severity(f.sites[site]);return rank[next]>rank[current]?next:current;},"healthy");
      return {from:bucket[0].tick,to:bucket.at(-1).tick,status};
    })}))};
  }
  function regions(state){return Object.values(state.regions).map(r=>{
    const members=Object.values(state.sites).filter(s=>s.region===r.id),offered=members.reduce((n,s)=>n+s.demand,0),ratio=utilization(offered,r.capacity);
    return {...r,offered,ratio,status:capacityStatus(ratio),sites:members.length,healthy:members.filter(s=>M.healthy(s.metrics)).length};
  });}
  function snapshot(state){
    const fleet=Object.values(state.sites),healthy=fleet.filter(s=>M.healthy(s.metrics)).length;
    const critical=fleet.filter(s=>severity(s.metrics)==="critical").length,warning=fleet.filter(s=>severity(s.metrics)==="warning").length;
    const unknown=fleet.filter(s=>!s.metrics).length;
    const offered=round(fleet.reduce((n,s)=>n+s.demand,0)),delivered=unknown===fleet.length?null:round(fleet.reduce((n,s)=>n+(s.metrics?.throughputMbps||0),0));
    const storageLag=M.lag(state,"storage"),detectionLag=M.lag(state,"detection"),outbox=state.outbox.length;
    const pipeline=state.services.broker&&state.services.storage&&state.services.detector&&!storageLag&&!detectionLag&&!outbox;
    return {total:fleet.length,healthy,critical,warning,unknown,offered,delivered,storageLag,detectionLag,outbox,pipeline,
      degraded:fleet.filter(s=>s.metrics&&!M.healthy(s.metrics)).length,solved:state.cases.filter(c=>c.state==="solved").length,
      activeCases:state.cases.filter(c=>c.state!=="solved").length,verified:state.jobs.filter(j=>j.state==="verified").length,
      coreRatio:utilization(offered,state.core.capacity)};
  }
  function brief(state,selected){
    const target=state.sites[selected];if(!target)throw new Error("Unknown site");
    const summary=snapshot(state),hypotheses=M.diagnose(state,selected),probeCount=state.probes.filter(p=>p.site===selected&&state.tick-p.tick<=30).length;
    const active=state.cases.filter(c=>c.state!=="solved"&&c.affected.includes(selected));
    return {source:"strata-model-monitoring-brief",tick:state.tick,site:selected,severity:severity(target.metrics),summary,
      headline:summary.unknown?`Awaiting observations from ${summary.unknown} site${summary.unknown===1?"":"s"}.`:!summary.pipeline?"Visibility is degraded. Validate the telemetry path.":summary.critical?`${summary.critical} site${summary.critical===1?" has":"s have"} critical service conditions.`:summary.degraded?`${summary.degraded} site${summary.degraded===1?" requires":"s require"} engineering investigation.`:summary.warning?"Service is up; containment needs attention.":"Fleet service thresholds are met.",
      selectedStatus:!target.metrics?"No observation":M.healthy(target.metrics)?"Service within thresholds":"Service outside thresholds",probeCount,activeCases:active.length,
      hypotheses:hypotheses.map(h=>({title:h.title,evidence:h.evidence,probe:h.probe,action:h.action})),
      nextStep:!target.metrics?"Advance the model clock to collect an observed baseline.":!summary.pipeline?"Collect Telemetry freshness inspection before relying on the incident count.":hypotheses[0]?`Collect ${M.probes[hypotheses[0].probe]} before staging a change.`:active.length?"Observe recovery and inspect case verification evidence.":"Establish a diagnostic baseline or inject an engineering case.",
      boundary:"Read-only rule-based model brief. No AI provider output, probability or approval is generated by this projection."};
  }
  return {severity,capacityStatus,utilization,windowFrames,traffic,healthHistory,regions,snapshot,brief};
});
