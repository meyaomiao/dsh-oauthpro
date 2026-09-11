import assert from "node:assert/strict";
import test from "node:test";
import { createDockyardLlmAdapter } from "../packages/dsh-bridge/src/index.mjs";

/**
 * Every method DSH calls on the object returned by `createDockyardLlmAdapter`.
 *
 * This bridge is deliberately structural: it does not import DSH at module load
 * and does not extend the harness's `LlmAdapter` class, so it inherits none of
 * the base-class defaults. Nothing else keeps this list in sync with the host —
 * when DSH grows a contract method, a missing implementation only shows up as a
 * `TypeError` deep inside an unrelated subsystem that happens to call it.
 *
 * That is exactly how it broke once: DSH 0.1.5-rc.2 added
 * `imageRequestPricing` and started calling it from `token-meter` on every
 * measurement, so automatic compaction silently stopped triggering and
 * `/compact` failed with `adapter.imageRequestPricing is not a function`.
 * See https://github.com/meyaomiao/dsh-oauthpro/issues/42
 */
const DSH_LLM_ADAPTER_CONTRACT = [
  "providerInfo",
  "providerRetryPolicy",
  "imageRequestPricing",
  "listModels",
  "resolveModel",
  "prepareCall",
  "stream",
];

function fakeRuntime() {
  return {
    listProviderIds: () => ["openai-codex"],
    listProviderManifests: () => [{ id: "openai-codex", displayName: "Live Codex" }],
    async getCatalog() {
      return { models: [{ id: "live-model", name: "Live model", contextWindow: 128000 }] };
    },
    async stream() {
      return (async function* chunks() {
        yield { type: "text-delta", index: 0, text: "ok" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  };
}

test("DSH LLM adapter implements every method the harness calls on it", () => {
  const adapter = createDockyardLlmAdapter({ runtime: fakeRuntime() });
  for (const method of DSH_LLM_ADAPTER_CONTRACT) {
    assert.equal(
      typeof adapter[method],
      "function",
      `Dockyard adapter is missing the DSH contract method "${method}"`,
    );
  }
  assert.equal(typeof adapter.providers, "function");
});

test("DSH LLM adapter declares no image pricing instead of throwing", () => {
  const adapter = createDockyardLlmAdapter({ runtime: fakeRuntime() });
  // token-meter calls this synchronously on every pressure measurement; the
  // neutral answer is `undefined`, which prices images with its own estimate.
  assert.equal(adapter.imageRequestPricing("openai-codex", "live-model"), undefined);
  assert.equal(adapter.imageRequestPricing(), undefined);
});
