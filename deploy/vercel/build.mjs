import { mkdir, copyFile, readFile, writeFile, access, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const directory = fileURLToPath(new URL("./", import.meta.url));
const source = path.resolve(directory, "../../console");
const output = path.join(directory, "public");
// Remove known obsolete public reference assets from earlier local builds.
for (const name of ["ecosystem.js", "ecosystem.json", "twin-coverage.json"])
  await rm(path.join(output, "assets", name), {force: true});
const assets = ["app.js", "app.css", "logo.svg", "twin-model-v1.js", "twin-model.js", "twin.js", "twin-blueprint.json", "device-config.js", "native-lab-pack.json"];

let hasSource = false;
try { await access(path.join(source, "index.html")); hasSource = true; } catch {}
if (hasSource) {
  // Repository builds refresh the explicit public config pack without Python or container services.
  const generator = path.resolve(directory,"../../scripts/package_native_configs.cjs");
  try {
    await access(generator);
    const result = spawnSync(process.execPath,[generator],{stdio:"inherit"});
    if (result.status !== 0) throw new Error("Public native config generation failed");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(path.join(output, "assets"), { recursive: true });
  for (const file of assets)
    await copyFile(path.join(source, "assets", file), path.join(output, "assets", file));
  const html = (await readFile(path.join(source, "index.html"), "utf8"))
    .replaceAll("Hub token", "Workspace token")
    .replace(/Use <code>INTEGRATION_API_TOKEN<\/code> from your server\s*<code>\.env<\/code>\./,
      "Use the workspace access token supplied by your administrator.");
  await writeFile(path.join(output, "index.html"), html);
  const js = (await readFile(path.join(output, "assets", "app.js"), "utf8"))
    .replaceAll("Invalid Hub token. Reconnect your workspace.", "Invalid workspace token. Reconnect your workspace.");
  await writeFile(path.join(output, "assets", "app.js"), js);
  console.log("Built Strata console from the repository's console/ source.");
} else {
  // CLI packages already contain the public assets; GitHub builds require the repository source.
  try {
    for (const file of ["index.html", ...assets.map((name) => `assets/${name}`)])
      await access(path.join(output, file));
  } catch {
    throw new Error("Console source is missing. For GitHub deployments, enable 'Include source files outside of the Root Directory in the Build Step' and upload console/ at the repository root.");
  }
  console.log("Using the console assets included in the standalone CLI package.");
}
