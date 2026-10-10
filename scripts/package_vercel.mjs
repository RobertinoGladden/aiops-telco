import { mkdir, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "dist", "strata-vercel");
await mkdir(path.join(output, "public", "assets"), { recursive: true });
await mkdir(path.join(output, "api"), { recursive: true });
for (const file of ["package.json", "vercel.json", "build.mjs", "api/proxy.mjs"])
  await copyFile(path.join(root, "deploy", "vercel", file), path.join(output, file));
const build = spawnSync(process.execPath, [path.join(output, "build.mjs")], { stdio: "inherit" });
if (build.status !== 0) process.exit(build.status || 1);
console.log(`Vercel package ready: ${output}`);
console.log("Only console assets and the authenticated proxy are included. Backend configuration stays on its host.");
