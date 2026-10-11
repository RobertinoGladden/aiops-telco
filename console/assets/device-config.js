/* Native policy fragments and commissioning arithmetic; no device connection is opened. */
(function (root, factory) {
  const api = factory(typeof module === "object" && module.exports ? require("./twin-model.js") : root.StrataTwin);
  if (typeof module === "object" && module.exports) module.exports = api; else root.StrataDevices = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (M) {
  "use strict";
  const profiles = {
    frr: {name: "FRRouting", os: "Debian Bookworm FRR · record installed version", extension: "conf", scope: "Integrated BGP configuration for the isolated native lab", source: "https://docs.frrouting.org/en/stable-8.4/routemap.html"},
    iosxe: {name: "Cisco IOS XE", os: "IOS XE 17.x · policy fragment", extension: "cfg", scope: "IPv4 BGP, prefix lists and inbound local preference", source: "https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/ip-routing/b-ip-routing/m_irg-external-sp-0.html"},
    iosxr: {name: "Cisco IOS XR", os: "IOS XR 7.x · RPL fragment", extension: "cfg", scope: "IPv4 BGP prefix sets and route policies", source: "https://www.cisco.com/c/en/us/td/docs/iosxr/ncs5000/routing/72x/b-routing-cg-ncs5000-72x/implementing-routing-policy.html"},
    junos: {name: "Juniper Junos", os: "Junos OS · set-style policy fragment", extension: "set", scope: "IPv4 external BGP and exact route-filter policies", source: "https://www.juniper.net/documentation/us/en/software/junos/bgp/topics/topic-map/basic-routing-policies.html"},
    routeros: {name: "MikroTik RouterOS", os: "RouterOS 7 · routing filter fragment", extension: "rsc", scope: "Filter chains only; bind to the installed version's BGP connections", source: "https://help.mikrotik.com/docs/spaces/ROS/pages/74678285/Route+Selection+and+Filters"},
    vrp: {name: "Huawei VRP", os: "VRP · route-policy fragment", extension: "cfg", scope: "IPv4 BGP, exact IP prefixes and inbound local preference", source: "https://info.support.huawei.com/hedex/api/pages/EDOC1100277650/AZM1016J/04/resources/command/yunshan/APPLY-LOCAL-PREF%28RTPOM%29.html"},
    sros: {name: "Nokia SR OS", os: "SR OS Classic CLI · policy fragment", extension: "cfg", scope: "Base-router BGP and transactional policy options", source: "https://documentation.nokia.com/sr/22-10-4/books/unicast-routing-protocols/route-policies.html"},
  };
  function assert(value, text) {if (!value) throw new Error(text);}
  function render(state, siteId, profileId, action = "running") {
    assert(Object.hasOwn(profiles, profileId), "Unknown platform profile");
    assert(Object.hasOwn(state.sites, siteId), "Unknown site"); const site = state.sites[siteId];
    assert(["running", "prefer_backup", "restore_primary"].includes(action), "Unsupported configuration action");
    assert(/^[A-Z]{3}-\d{3}$/.test(site.id) && Number.isInteger(site.asn) && site.asn >= 64512 && site.asn <= 65534, "Invalid site identity or ASN");
    const servicePrefix = M.prefix(site.service), managementPrefix = M.prefix(site.management);
    assert(servicePrefix.private && managementPrefix.private, "Use private lab addressing");
    assert(servicePrefix.length === 24, "This profile contract requires /24 service addressing");
    const management = [24,16,8,0].map(bits => Math.floor((managementPrefix.start+1) / 2**bits) % 256).join(".");
    const local = [site.service, `${management}/32`]; const core = "10.90.0.0/24";
    const preference = action === "running" ? site.config.backupPreference : action === "prefer_backup" ? 200 : 80;
    assert([80, 200].includes(preference), "This contract supports backup preference 80 or 200");
    const lines = [];
    if (profileId === "frr") {
      const copy = JSON.parse(JSON.stringify(state)); copy.sites[siteId].config.backupPreference = preference;
      lines.push(M.nativeFrr(copy, siteId));
    } else if (profileId === "iosxe") {
      lines.push(`hostname ${site.id}`, ...local.map((prefix, n) => `ip prefix-list STRATA-LOCAL seq ${10 + n * 10} permit ${prefix}`),
        `ip prefix-list STRATA-CORE seq 10 permit ${core}`);
      for (const [name, value] of [["PRIMARY", 100], ["BACKUP", preference]])
        lines.push(`route-map STRATA-${name} permit 10`, " match ip address prefix-list STRATA-CORE", ` set local-preference ${value}`, "!");
      lines.push("route-map STRATA-EXPORT permit 10", " match ip address prefix-list STRATA-LOCAL", `router bgp ${site.asn}`, ` bgp router-id ${management}`,
        " neighbor 10.250.0.1 remote-as 65100", " neighbor 10.251.0.1 remote-as 65200", " address-family ipv4 unicast",
        `  network ${site.service.split("/")[0]} mask 255.255.255.0`, `  network ${management} mask 255.255.255.255`);
      for (const [peer, name] of [["10.250.0.1", "PRIMARY"], ["10.251.0.1", "BACKUP"]])
        lines.push(`  neighbor ${peer} activate`, `  neighbor ${peer} route-map STRATA-${name} in`, `  neighbor ${peer} route-map STRATA-EXPORT out`);
      lines.push(" exit-address-family");
    } else if (profileId === "iosxr") {
      lines.push("prefix-set STRATA-LOCAL", ` ${local.join(",\n ")}`, "end-set", "prefix-set STRATA-CORE", ` ${core}`, "end-set");
      for (const [name, value] of [["PRIMARY", 100], ["BACKUP", preference], ["EXPORT", null]]) {
        lines.push(`route-policy STRATA-${name}`, ` if destination in STRATA-${name === "EXPORT" ? "LOCAL" : "CORE"} then`);
        if (value != null) lines.push(`  set local-preference ${value}`);
        lines.push("  pass", " else", "  drop", " endif", "end-policy");
      }
      lines.push(`router bgp ${site.asn}`, ` bgp router-id ${management}`, " address-family ipv4 unicast", ...local.map((p) => `  network ${p}`), " !");
      for (const [peer, asn, name] of [["10.250.0.1", 65100, "PRIMARY"], ["10.251.0.1", 65200, "BACKUP"]])
        lines.push(` neighbor ${peer}`, `  remote-as ${asn}`, "  address-family ipv4 unicast", `   route-policy STRATA-${name} in`, "   route-policy STRATA-EXPORT out", "  !", " !");
    } else if (profileId === "junos") {
      lines.push(`set routing-options autonomous-system ${site.asn}`, `set routing-options router-id ${management}`);
      for (const [name, value] of [["PRIMARY", 100], ["BACKUP", preference]]) lines.push(
        `set policy-options policy-statement STRATA-${name} term allowed from route-filter ${core} exact`,
        `set policy-options policy-statement STRATA-${name} term allowed then local-preference ${value}`,
        `set policy-options policy-statement STRATA-${name} term allowed then accept`, `set policy-options policy-statement STRATA-${name} term remainder then reject`);
      lines.push(...local.map((p) => `set policy-options policy-statement STRATA-EXPORT term allowed from route-filter ${p} exact`),
        "set policy-options policy-statement STRATA-EXPORT term allowed then accept", "set policy-options policy-statement STRATA-EXPORT term remainder then reject");
      for (const [peer, asn, name] of [["10.250.0.1", 65100, "PRIMARY"], ["10.251.0.1", 65200, "BACKUP"]]) lines.push(
        `set protocols bgp group STRATA-${name} type external`, `set protocols bgp group STRATA-${name} family inet unicast`,
        `set protocols bgp group STRATA-${name} peer-as ${asn}`, `set protocols bgp group STRATA-${name} neighbor ${peer}`,
        `set protocols bgp group STRATA-${name} import STRATA-${name}`, `set protocols bgp group STRATA-${name} export STRATA-EXPORT`);
    } else if (profileId === "routeros") {
      for (const [name, value] of [["PRIMARY", 100], ["BACKUP", preference]])
        lines.push(`/routing/filter/rule add chain=STRATA-${name} rule="if (dst == ${core}) { set bgp-local-pref ${value}; accept; } else { reject; }"`);
      lines.push(`/routing/filter/rule add chain=STRATA-EXPORT rule="if (dst == ${local[0]} || dst == ${local[1]}) { accept; } else { reject; }"`);
    } else if (profileId === "vrp") {
      lines.push(...local.map((p, n) => `ip ip-prefix STRATA-LOCAL index ${10 + 10 * n} permit ${p.replace("/", " ")}`), `ip ip-prefix STRATA-CORE index 10 permit ${core.replace("/", " ")}`);
      for (const [name, value] of [["PRIMARY", 100], ["BACKUP", preference], ["EXPORT", null]]) {
        lines.push(`route-policy STRATA-${name} permit node 10`, ` if-match ip-prefix STRATA-${name === "EXPORT" ? "LOCAL" : "CORE"}`);
        if (value != null) lines.push(` apply local-preference ${value}`); lines.push(" quit");
      }
      lines.push(`bgp ${site.asn}`, ` router-id ${management}`, " peer 10.250.0.1 as-number 65100", " peer 10.251.0.1 as-number 65200", " ipv4-family unicast",
        ...local.map((p) => `  network ${p.replace("/", " ")}`), "  peer 10.250.0.1 route-policy STRATA-PRIMARY import", "  peer 10.251.0.1 route-policy STRATA-BACKUP import",
        "  peer 10.250.0.1 route-policy STRATA-EXPORT export", "  peer 10.251.0.1 route-policy STRATA-EXPORT export", " quit", "quit");
    } else if (profileId === "sros") {
      lines.push("configure router", ` autonomous-system ${site.asn}`, ` router-id ${management}`, " policy-options", "  begin", '  prefix-list "STRATA-LOCAL"', ...local.map((p) => `   prefix ${p} exact`), "  exit", '  prefix-list "STRATA-CORE"', `   prefix ${core} exact`, "  exit");
      for (const [name, value] of [["PRIMARY", 100], ["BACKUP", preference], ["EXPORT", null]]) {
        lines.push(`  policy-statement "STRATA-${name}"`, "   entry 10", "    from", `     prefix-list "STRATA-${name === "EXPORT" ? "LOCAL" : "CORE"}"`, "    exit", "    action accept");
        if (value != null) lines.push(`     local-preference ${value}`);
        lines.push("    exit", "   exit", "   default-action reject", "   exit", "  exit");
      }
      lines.push("  commit", " exit", " bgp");
      for (const [peer, asn, name] of [["10.250.0.1", 65100, "PRIMARY"], ["10.251.0.1", 65200, "BACKUP"]]) lines.push(
        `  group "STRATA-${name}"`, "   type external", `   peer-as ${asn}`, `   import "STRATA-${name}"`, '   export "STRATA-EXPORT"', `   neighbor ${peer}`, "   exit", "  exit");
      lines.push(" exit", "exit all");
    }
    const profile = profiles[profileId];
    return {format: "strata-native-policy", site: site.id, platform: profileId, os: profile.os, action, runningRevision: site.revision,
      intent: {asn: site.asn, routerId: management, importExact: [core], exportExact: local, primaryPreference: 100, backupPreference: preference},
      fileName: `${site.id.toLowerCase()}-${profileId}.${profile.extension}`, text: lines.join("\n") + "\n", source: profile.source,
      validation: "Generated from bounded intent. Native parser and device execution have not been tested.",
      prerequisites: "Lab-only fragment. Map actual interfaces and install connected site/loopback/transit routes first. Review existing policies, OS release and licenses. RouterOS exports filter definitions only. No QoS, RF, credentials or physical commissioning is applied."};
  }
  const equipment = [
    {id: "router", name: "Site transport router", role: "Dual-core IP backhaul · BGP import/export policy", control: "Native policy export + reviewed Twin preference change"},
    {id: "switch", name: "Access switch / VLAN", role: "Service isolation and Ethernet handoff", control: "Native Linux VLAN lab; commercial switch configuration is external"},
    {id: "radio", name: "Radio unit / RRU / AAU", role: "RF transmit/receive chain and carrier parameters", control: "Commissioning plan + link-budget calculation; vendor OAM is external"},
    {id: "du", name: "Distributed unit / baseband", role: "RAN processing and fronthaul termination", control: "Inventory reference; no DU/MAC scheduler emulation"},
    {id: "cu", name: "Central unit", role: "RAN control/user-plane split", control: "Inventory reference; UERANSIM is a separate simulated gNB track"},
    {id: "antenna", name: "Sector antenna / RET", role: "Gain, pointing, mechanical/electrical downtilt", control: "Commissioning values; RET requires a compatible AISG controller"},
    {id: "feeder", name: "Feeder / jumper / connectors", role: "RF chain insertion loss", control: "Budget parameter; measurements and VSWR/PIM tests are external"},
    {id: "fiber", name: "Fiber / optics / fronthaul", role: "Site-to-aggregation and RU-to-baseband transport", control: "Inventory reference; optical power and eCPRI are not emulated"},
    {id: "microwave", name: "Microwave backhaul", role: "Optional alternative transport path", control: "Inventory reference; RF modem and licensed spectrum are external"},
    {id: "power", name: "Rectifier / battery / DC plant", role: "Power and backup autonomy", control: "Energy arithmetic from commissioning values; no electrical protection model"},
    {id: "timing", name: "GNSS / PTP / SyncE", role: "Site frequency, phase and time reference", control: "Inventory reference; no synchronization protocol or jitter simulation"},
    {id: "core", name: "5G core / UPF", role: "Subscriber admission and user-plane anchoring", control: "Native Open5GS/UERANSIM configs; modeled Twin sessions remain separate"},
  ];
  const rfDefaults = {frequencyMHz: 3500, distanceKm: .5, txPowerDbm: 30, antennaGainDbi: 17, feederLossDb: 1,
    otherLossDb: 15, azimuthDeg: 0, electricalTiltDeg: 6, mechanicalTiltDeg: 0, batteryAh: 100, dcVoltage: 48, loadW: 800, usableFraction: .8};
  function budget(input) {
    const ranges = {frequencyMHz:[100,100000],distanceKm:[.001,100],txPowerDbm:[-30,60],antennaGainDbi:[0,40],feederLossDb:[0,40],otherLossDb:[0,100],
      azimuthDeg:[0,359],electricalTiltDeg:[0,20],mechanicalTiltDeg:[0,20],batteryAh:[1,10000],dcVoltage:[1,1000],loadW:[1,100000],usableFraction:[.01,1]};
    assert(input && typeof input === "object" && Object.keys(input).every((key) => Object.hasOwn(ranges,key)), "Unknown commissioning parameter");
    const p = {...rfDefaults, ...input}; for (const [key, [min,max]] of Object.entries(ranges)) assert(Number.isFinite(p[key]) && p[key]>=min && p[key]<=max, `Invalid ${key}`);
    const round = (v) => Math.round(v*100)/100; const fspl = 32.44 + 20*Math.log10(p.frequencyMHz) + 20*Math.log10(p.distanceKm);
    const eirp = p.txPowerDbm + p.antennaGainDbi - p.feederLossDb;
    return {source:"strata-commissioning-calculation",parameters:p,freeSpaceLossDb:round(fspl),eirpDbm:round(eirp),receivedPowerDbm:round(eirp-fspl-p.otherLossDb),
      batteryAutonomyHours:round(p.dcVoltage*p.batteryAh*p.usableFraction/p.loadW),
      boundary:"Free-space reference with declared additional loss and 0 dBi receiver gain. This is total received power, not NR RSRP/SINR, a coverage prediction or a measured drive test. Tilt/azimuth are recorded commissioning settings; no antenna pattern is modeled. Battery arithmetic excludes voltage curve, temperature, aging and protection losses."};
  }
  return {profiles, render, equipment, rfDefaults, budget};
});
