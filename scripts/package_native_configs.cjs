/* Fixed public lab fixtures only. Never enumerate runtime directories or environment files. */
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const M = require("../console/assets/twin-model.js");
const D = require("../console/assets/device-config.js");
const root = path.resolve(__dirname, "..");
const blueprint = JSON.parse(fs.readFileSync(path.join(root, "console/assets/twin-blueprint.json"), "utf8"));
const state = M.initial(blueprint);
const manifest = [];
for (const platform of Object.keys(D.profiles)) {
  for (const site of Object.keys(state.sites)) {
    const item = D.render(state, site, platform);
    const relative = `lab/config/vendors/${platform}/${item.fileName}`;
    fs.mkdirSync(path.dirname(path.join(root, relative)), {recursive: true});
    const comment = ["junos", "routeros", "vrp", "sros"].includes(platform) ? "#" : "!";
    fs.writeFileSync(path.join(root, relative), `${comment} ${item.prerequisites}\n${item.text}`);
    manifest.push({path: relative, platform, site, os: item.os, intent: item.intent, source: item.source, validation: item.validation});
  }
}
fs.writeFileSync(path.join(root, "lab/config/vendors/manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
const fixed = ["sites.json", "frr/jkt.conf", "frr/bdg.conf", "frr/sby.conf", "frr/core-primary.conf", "frr/core-backup.conf",
  "mobile/amf.yaml", "mobile/smf.yaml", "mobile/upf.yaml", "mobile/gnb.yml", "mobile/ue.yml", "mobile/subscriber.json",
  "prometheus.yml", "grafana/datasources/lab.yml", "vendors/manifest.json"].map(name => `lab/config/${name}`);
const files = [...fixed, ...manifest.map(item => item.path)].map(relative => {
  const text = fs.readFileSync(path.join(root, relative), "utf8");
  return {path: relative, text, sha256: crypto.createHash("sha256").update(text).digest("hex")};
});
const pack = {format: "strata-native-lab-pack", version: 1, liveValidated: false,
  targets: {open5gs: "v2.7.6", ueransim: "v3.2.7", routing: D.profiles},
  boundary: "Native lab definitions and version-scoped routing fragments. No daemons or vendor OS run in the browser. Public test subscriber only; no operator credentials. Apply only after interface mapping and native validation in the matching isolated lab.", files};
fs.writeFileSync(path.join(root, "console/assets/native-lab-pack.json"), JSON.stringify(pack, null, 2) + "\n");
console.log(`Public native lab pack: ${files.length} explicit config files, no runtime credentials.`);
