// R0 guard: every dsh.client.inject entry must exist in the installed DSH,
// otherwise the client loader fails the whole plugin at boot (issue #13/#15).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dshRoot = process.env.DSH_INSTALL
  ?? join(process.env.HOME ?? "", ".local", "lib", "node_modules", "@deepseek-ai", "dsh");
const dshNm = join(dshRoot, "node_modules"); // inject entries are already scoped names

if (!existsSync(dshNm)) {
  console.log("[check-platform-injects] DSH install not found, skipping");
  process.exit(0);
}

let missing = 0;
for (const manifest of ["package.json", "packages/dsh-plugin/package.json"]) {
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  for (const name of pkg?.dsh?.client?.inject ?? []) {
    if (!existsSync(join(dshNm, name))) {
      console.error(`[check-platform-injects] ${manifest}: dsh.client.inject lists "${name}", but the installed DSH has no such package — the client loader would reject the plugin at boot`);
      missing += 1;
    }
  }
}

if (missing > 0) process.exit(1);
console.log("[check-platform-injects] OK");
