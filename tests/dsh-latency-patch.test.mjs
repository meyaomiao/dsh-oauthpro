import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { patchConversationSource, patchPiAiSource } from "../scripts/patch-dsh-latency.mjs";

test("third-party adapter starts API-key and context work together", async (t) => {
  const file = new URL("../node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js", import.meta.url);
  const source = await readFile(file, "utf8");
  if (!source.includes("const apiKey = await this.config.resolveApiKey(options.provider, profile);")
    || !source.includes("const context = attachments === void 0 ? toPiContext(options, void 0, onReplayDegrade) : await toPiContext({\n\t\t\t\t\t...options,\n\t\t\t\t\tsignal: watchdog.signal\n\t\t\t\t}, attachments, onReplayDegrade, profile.maxRequestImageBytes")) {
    t.skip("dsh-llm-pi-ai 0.1.5-rc.2 no longer has the 0.1.1-rc.2 credential waterfall this local patch targets");
    return;
  }
  const patched = patchPiAiSource(source);

  assert.match(patched, /const apiKeyPromise = Promise\.resolve\(\)\.then\(\(\) => this\.config\.resolveApiKey/);
  assert.match(patched, /const contextPromise = Promise\.resolve\(\)\.then\(\(\) =>/);
  assert.match(patched, /const \[apiKey, context\] = await Promise\.all\(\[apiKeyPromise, contextPromise\]\);/);
  assert.equal(patchPiAiSource(patched), patched);
});

test("conversation clock is visible before the first provider event", async (t) => {
  const file = new URL("../node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js", import.meta.url);
  const source = await readFile(file, "utf8");
  if (!source.includes("const showClock = elapsedMs >= 15e3;")) {
    t.skip("dsh-client-ui-conversation 0.1.5-rc.2 no longer hides the turn clock for 15s");
    return;
  }
  const patched = patchConversationSource(source);

  assert.match(patched, /const showClock = true;/);
  assert.doesNotMatch(patched, /const showClock = elapsedMs >= 15e3;/);
  assert.equal(patchConversationSource(patched), patched);
});
