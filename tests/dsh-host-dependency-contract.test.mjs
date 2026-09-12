import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const HOST_PACKAGES = [
  "@deepseek-ai/dsh-api-remotes",
  "@deepseek-ai/dsh-client-ui-conversation",
  "@deepseek-ai/dsh-client-ui-model-selection",
  "@deepseek-ai/dsh-llm",
  "@deepseek-ai/dsh-llm-pi-ai",
  "@deepseek-ai/dsh-typert-protocol",
  "@earendil-works/pi-ai",
];

function assertHostPackagesArePeers(pkg, label) {
  const dependencies = pkg.dependencies ?? {};
  for (const name of HOST_PACKAGES) {
    assert.equal(
      dependencies[name],
      undefined,
      `${label} must not list ${name} as a runtime dependency (dsh plugin add would hoist it into the profile)`,
    );
    assert.equal(typeof pkg.peerDependencies?.[name], "string", `${label} must declare ${name} as a peer`);
    assert.equal(pkg.peerDependenciesMeta?.[name]?.optional, true, `${label} must mark ${name} optional so install does not fail without DSH`);
    assert.equal(typeof pkg.devDependencies?.[name], "string", `${label} must keep ${name} in devDependencies for local tests/build`);
  }
  assert.equal(typeof dependencies.react, "string");
  assert.equal(typeof dependencies.zod, "string");
}

test("published package.json does not install DSH host packages into a profile", async () => {
  const root = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const plugin = JSON.parse(await readFile(join(repoRoot, "packages/dsh-plugin/package.json"), "utf8"));
  assertHostPackagesArePeers(root, "root package.json");
  assertHostPackagesArePeers(plugin, "packages/dsh-plugin/package.json");
});

test("hoisted profile install of this plugin cannot shadow DSH's llm-pi-ai loader", async () => {
  const root = await mkdtemp(join(tmpdir(), "dockyard-host-contract-"));
  try {
    const profile = join(root, "profile");
    const dshInstall = join(root, "dsh-install");
    await mkdir(join(profile, "node_modules", "dsh-oauthpro"), { recursive: true });
    await mkdir(join(dshInstall, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai"), { recursive: true });

    const published = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const installable = {
      name: published.name,
      version: published.version,
      type: "module",
      dependencies: published.dependencies,
      peerDependencies: published.peerDependencies,
      peerDependenciesMeta: published.peerDependenciesMeta,
    };
    await writeFile(
      join(profile, "node_modules", "dsh-oauthpro", "package.json"),
      JSON.stringify(installable, null, 2),
    );
    await writeFile(join(profile, "package.json"), JSON.stringify({ name: "dsh-profile-web", private: true }, null, 2));
    await writeFile(
      join(dshInstall, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai", "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-llm-pi-ai", version: "0.1.5-rc.2", type: "module" }, null, 2),
    );
    await writeFile(join(dshInstall, "package.json"), JSON.stringify({ name: "dsh", private: true }, null, 2));

    const fromProfile = createRequire(join(profile, "package.json"));
    assert.throws(
      () => fromProfile.resolve("@deepseek-ai/dsh-llm-pi-ai"),
      /Cannot find module/,
      "installing oauthpro must not place @deepseek-ai/dsh-llm-pi-ai on the profile resolution path",
    );

    const fromDsh = createRequire(join(dshInstall, "package.json"));
    const resolved = fromDsh.resolve("@deepseek-ai/dsh-llm-pi-ai/package.json");
    assert.ok(resolved.includes(join("dsh-install", "node_modules")), resolved);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
