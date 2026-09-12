import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { createCodexDshCatalogLoader, createPiAiModelRegistryLoader } from "../packages/dsh-plugin/src/codex-transport.mjs";

async function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

function dshLlmPiAiPackage() {
  return {
    "package.json": JSON.stringify({
      name: "@deepseek-ai/dsh-llm-pi-ai",
      version: "0.0.0-fixture",
      type: "module",
      exports: { ".": "./lib/index.js" },
    }),
    "lib/index.js": "export const PiAiAdapter = class PiAiAdapter {};\n",
  };
}

function piAiPackage({ models }) {
  return {
    "package.json": JSON.stringify({
      name: "@earendil-works/pi-ai",
      version: "0.0.0-fixture",
      type: "module",
      exports: {
        ".": "./dist/index.js",
        "./api/openai-codex-responses.lazy": "./dist/api/openai-codex-responses.lazy.js",
        "./providers/openai-codex": "./dist/providers/openai-codex.js",
        "./providers/all": "./dist/providers/all.js",
      },
    }),
    "dist/index.js": "export const createProvider = () => { throw new Error('fixture only'); };\n",
    "dist/api/openai-codex-responses.lazy.js": "export const openAICodexResponsesApi = { fixture: true };\n",
    "dist/providers/openai-codex.js": "export const openaiCodexProvider = () => ({ getModels: () => [] });\n",
    "dist/providers/all.js": `export const getBuiltinProviders = () => ["xai"];
export const getBuiltinModels = (provider) => provider === "xai" ? ${JSON.stringify(models)} : [];
`,
  };
}

test("pi-ai resolution prefers the installation that owns dsh-llm-pi-ai", async () => {
  const root = await mkdtemp(join(tmpdir(), "dockyard-pi-ai-install-"));
  try {
    // A fixture installation whose built-in catalog knows grok-4.6, i.e. the
    // shape DSH ships. This repo's own older pi-ai copy must not win.
    await writeFiles(join(root, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai"), dshLlmPiAiPackage());
    await writeFiles(join(root, "node_modules", "@earendil-works", "pi-ai"), piAiPackage({
      models: [{ id: "grok-4.6", name: "Grok 4.6", provider: "xai", api: "openai-responses" }],
    }));
    const moduleAnchor = pathToFileURL(join(root, "anchor.mjs")).href;

    const models = await createPiAiModelRegistryLoader({ moduleAnchor })();
    assert.deepEqual(models, [{ id: "grok-4.6", name: "Grok 4.6", provider: "xai", api: "openai-responses" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex catalog also resolves from the installation that owns dsh-llm-pi-ai", async () => {
  const root = await mkdtemp(join(tmpdir(), "dockyard-codex-install-"));
  try {
    await writeFiles(join(root, "node_modules", "@deepseek-ai", "dsh-llm-pi-ai"), dshLlmPiAiPackage());
    await writeFiles(join(root, "node_modules", "@earendil-works", "pi-ai"), {
      ...piAiPackage({ models: [] }),
      "dist/providers/openai-codex.js": `export const openaiCodexProvider = () => ({ getModels: () => ${JSON.stringify([{ id: "gpt-fixture", name: "GPT Fixture", contextWindow: 1234 }])} });\n`,
    });
    const moduleAnchor = pathToFileURL(join(root, "anchor.mjs")).href;

    const catalog = await createCodexDshCatalogLoader({ moduleAnchor })();
    assert.deepEqual(catalog, {
      models: [{ id: "gpt-fixture", name: "GPT Fixture", contextWindow: 1234 }],
      source: "dsh_pi_ai_provider_catalog",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
