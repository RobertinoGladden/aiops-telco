/* Verify exported browser evidence without any telecom services. */
const fs = require("node:fs");
const path = require("node:path");
const M = require("../console/assets/twin-model.js");
try {
  const input = process.argv[2];
  if (!input) throw new Error("Usage: node scripts/replay_twin.cjs path/to/strata-twin-run.json");
  if (fs.statSync(input).size > 16 * 1024 * 1024) throw new Error("Replay file exceeds 16 MB");
  const run = JSON.parse(fs.readFileSync(input, "utf8"));
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "../console/assets/twin-blueprint.json"), "utf8"));
  if (M.canonical(run.siteDesigns) !== M.canonical(catalog.sites)) throw new Error("Site designs do not match this repository");
  const state = M.migrate(run);
  console.log(JSON.stringify({replay: "verified", source: "strata-twin-model", version: M.VERSION, originalVersion: run.version, migrated: run.version !== M.VERSION,
    tick: state.tick, commands: state.commands.length, jobs: state.jobs.map((j) => ({id: j.id, state: j.state})),
    objects: Object.keys(state.objects).length, storageLag: M.lag(state, "storage"), detectionLag: M.lag(state, "detection")}, null, 2));
} catch (error) { console.error(`Replay rejected: ${error.message}`); process.exitCode = 1; }
