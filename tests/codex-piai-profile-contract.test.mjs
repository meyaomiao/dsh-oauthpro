import assert from "node:assert/strict";
import test from "node:test";

import { createCodexPiAiExecutor } from "../modules/provider-codex/src/driver.mjs";

/**
 * Regression test for issue #57.
 *
 * DSH >= 0.1.5-rc.2 ships `@deepseek-ai/dsh-llm-pi-ai@0.1.5-rc.2`, whose
 * `PiAiAdapter.modelOf()` reads `profile.modelErrors.get(model)` right after
 * `profileOf()` and without a guard:
 *
 *   const failure = profile.modelErrors.get(model)
 *     ?? (profile.piProvider === void 0 ? profile.catalogError : void 0);
 *
 * oauthpro builds its own profile for the codex route, so the profile must
 * carry the same shape the host's own builder emits
 * (`modelErrors: catalog?.modelErrors ?? new Map()`). Without it every codex
 * request dies with `Cannot read properties of undefined (reading 'get')`
 * before any network call.
 */

const MODEL = { contextWindow: 272_000, maxTokens: 128_000, name: "gpt-6-astra" };

/** Minimal stand-in that performs exactly the host's unguarded dereference. */
function hostLikeExecutor(captured) {
  class HostLikePiAiAdapter {
    constructor(config) {
      this.config = config;
      captured.config = config;
    }
    stream(options) {
      const snapshot = { profiles: this.config.profiles() };
      const profile = snapshot.profiles.get(options.provider);
      assert.notEqual(profile, undefined, "the adapter must own the codex provider");
      // The exact expression from dsh-llm-pi-ai/lib/index.js:1769.
      const failure = profile.modelErrors.get(options.model)
        ?? (profile.piProvider === void 0 ? profile.catalogError : void 0);
      assert.equal(failure, undefined, "the profile must not pre-report a model failure");
      return (async function* () {
        yield { type: "finish", reason: "stop" };
      })();
    }
  }
  return createCodexPiAiExecutor({
    PiAiAdapter: HostLikePiAiAdapter,
    createProvider: () => ({}),
    openAICodexResponsesApi: () => ({}),
    modelResolver: () => MODEL,
  });
}

test("codex profile carries the modelErrors map the host adapter dereferences", () => {
  const captured = {};
  const executor = hostLikeExecutor(captured);
  const chunks = [];
  return executor({
    request: { provider: "openai-codex", model: "gpt-6-astra" },
    credential: { access: "token" },
  }).then(async (stream) => {
    for await (const chunk of stream) chunks.push(chunk);
    const profile = captured.config.profiles().get("openai-codex");
    assert.equal(profile.modelErrors instanceof Map, true);
    assert.equal(typeof profile.modelErrors.get, "function");
    assert.equal(profile.modelErrors.size, 0);
    assert.equal(chunks.at(-1).reason, "stop");
  });
});
