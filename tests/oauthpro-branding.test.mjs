import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DOCKYARD_LOCALES } from "../packages/dsh-plugin/src/dockyard-locale.mjs";

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

test("user-visible locale strings no longer say Dockyard", () => {
  for (const [locale, messages] of Object.entries(DOCKYARD_LOCALES)) {
    for (const [key, value] of Object.entries(messages)) {
      assert.equal(typeof value, "string", `${locale}.${key}`);
      assert.doesNotMatch(value, /Dockyard|DOCKYARD/, `${locale}.${key} still brands Dockyard: ${value}`);
    }
  }
});

test("published package.json description is not macOS-only", async () => {
  const root = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const plugin = JSON.parse(await readFile(join(repoRoot, "packages/dsh-plugin/package.json"), "utf8"));
  for (const [label, pkg] of [["root", root], ["plugin", plugin]]) {
    assert.equal(pkg.version, "0.1.5", `${label} version`);
    assert.match(pkg.description, /dsh-oauthpro/i, `${label} description`);
    assert.doesNotMatch(pkg.description, /macOS-only/i, `${label} description still says macOS-only`);
    assert.match(pkg.description, /Windows/i, `${label} description should mention Windows`);
  }
});
