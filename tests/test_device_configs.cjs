const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const M = require("../console/assets/twin-model.js");
const D = require("../console/assets/device-config.js");
const root = path.resolve(__dirname, "..");
const blueprint = JSON.parse(fs.readFileSync(path.join(root,"console/assets/twin-blueprint.json"),"utf8"));

test("seven platform fragments preserve private routing intent across three sites and two candidate preferences", () => {
  const state = M.initial(blueprint), original = M.canonical(state);
  const preferences = {running:80,prefer_backup:200,restore_primary:80};
  for (const site of Object.values(state.sites)) for (const platform of Object.keys(D.profiles)) for (const [action, preference] of Object.entries(preferences)) {
    const config = D.render(state,site.id,platform,action);
    assert.equal(config.intent.asn,site.asn); assert.equal(config.intent.backupPreference,preference);
    assert.deepEqual(config.intent.importExact,["10.90.0.0/24"]);
    assert.equal(config.intent.exportExact[0],site.service);
    assert.equal(config.intent.exportExact[1],site.management.replace(/\.0\/24$/,".1/32"));
    assert.match(config.text,new RegExp(`(?:local-preference|bgp-local-pref) ${preference}(?:\\s|;)`)); assert.match(config.validation,/not been tested/);
    assert.ok(config.source.startsWith("https://"));
  }
  assert.equal(M.canonical(state),original,"Rendering is read-only, with no approval or execution side effect");
});
test("unknown platforms, actions and unsafe lab identities are rejected", () => {
  const state = M.initial(blueprint);
  assert.throws(()=>D.render(state,"JKT-001","missing"),/platform/);
  assert.throws(()=>D.render(state,"missing","frr"),/site/);
  assert.throws(()=>D.render(state,"JKT-001","iosxe","reboot"),/action/);
  state.sites["JKT-001"].asn=123; assert.throws(()=>D.render(state,"JKT-001","frr"),/ASN/);
  state.sites["JKT-001"].asn=65011; state.sites["JKT-001"].service="8.8.8.0/24";
  assert.throws(()=>D.render(state,"JKT-001","frr"),/private/);
  state.sites["JKT-001"].service="10.81.0.0/16";
  assert.throws(()=>D.render(state,"JKT-001","iosxe"),/\/24/);
  state.sites["JKT-001"].service="10.81.1.0/24"; state.sites["JKT-001"].management="10.80.1.4/30";
  for (const platform of Object.keys(D.profiles)) assert.equal(D.render(state,"JKT-001",platform).intent.routerId,"10.80.1.5");
});
test("RouterOS is explicitly filter-only, with accept/reject boundaries rather than invented universal connection commands", () => {
  const config = D.render(M.initial(blueprint),"JKT-001","routeros","prefer_backup");
  assert.match(config.text,/bgp-local-pref 200/); assert.match(config.text,/else \{ reject; \}/);
  assert.doesNotMatch(config.text,/\/routing\/bgp\/(connection|instance)/);
  assert.match(D.profiles.routeros.scope,/Filter chains only/);
});
test("commissioning arithmetic has correct distance, gain, loss and energy relationships and an explicit RF boundary", () => {
  const base = D.budget({}), distant=D.budget({distanceKm:1});
  assert.equal(base.eirpDbm,46); assert.equal(base.batteryAutonomyHours,4.8);
  assert.ok(Math.abs(distant.freeSpaceLossDb-base.freeSpaceLossDb-6.02)<.02);
  assert.ok(Math.abs(distant.receivedPowerDbm-base.receivedPowerDbm+6.02)<.02);
  assert.equal(D.budget({antennaGainDbi:20}).eirpDbm,49);
  assert.equal(D.budget({loadW:1600}).batteryAutonomyHours,2.4);
  assert.match(base.boundary,/not NR RSRP/);
  assert.equal(D.budget({azimuthDeg:90,electricalTiltDeg:10}).receivedPowerDbm,base.receivedPowerDbm,"No antenna pattern or RF equivalence is fabricated");
});
test("commissioning rejects nonfinite, unsupported and out-of-range values", () => {
  for (const value of [{distanceKm:0},{distanceKm:NaN},{loadW:0},{frequencyMHz:Infinity},{usableFraction:2},{txPowerDbm:"30"},{fake:1}])
    assert.throws(()=>D.budget(value));
});
test("public native pack hashes match only explicit config sources, without environment or runtime files", () => {
  const pack = JSON.parse(fs.readFileSync(path.join(root,"console/assets/native-lab-pack.json"),"utf8"));
  assert.equal(pack.liveValidated,false); assert.equal(pack.files.length,36);
  const seen = new Set();
  for (const file of pack.files) {
    assert.ok(file.path.startsWith("lab/config/"));
    assert.doesNotMatch(file.path,/\.env|secrets|runtime|\.\.\/|ssh/i); assert.ok(!seen.has(file.path)); seen.add(file.path);
    assert.equal(file.text,fs.readFileSync(path.join(root,file.path),"utf8"));
    assert.equal(file.sha256,crypto.createHash("sha256").update(file.text).digest("hex"));
  }
  for (const name of ["amf.yaml","smf.yaml","upf.yaml","gnb.yml","ue.yml"])
    assert.ok(seen.has(`lab/config/mobile/${name}`));
  assert.equal(pack.files.filter(file=>file.path.includes("/vendors/") && !file.path.endsWith("manifest.json")).length,21);
});
