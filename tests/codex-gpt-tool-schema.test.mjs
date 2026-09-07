import assert from "node:assert/strict";
import test from "node:test";

import { createCodexPiAiExecutor, sanitizeCodexTools } from "../modules/provider-codex/src/driver.mjs";

const MODEL = { contextWindow: 272_000, maxTokens: 128_000, name: "gpt-5.6" };

function makeExecutor(hooks = {}) {
  return createCodexPiAiExecutor({
    PiAiAdapter: class {
      constructor() {}
      stream(request) {
        hooks.request = request;
        return (async function* () {
          yield {
            type: "block-end",
            index: 0,
            block: {
              type: "tool-call",
              id: "call-1",
              name: "bash",
              arguments: JSON.stringify({ command: "ls -la", sandbox_permissions: "workspace-write", justification: "needed" }),
            },
          };
          yield { type: "finish", reason: "toolUse" };
        })();
      }
    },
    createProvider: () => ({}),
    openAICodexResponsesApi: () => ({}),
    modelResolver: () => MODEL,
  });
}

const TOOL = {
  name: "bash",
  description: "Runs a shell command. If permission is denied, retry with sandbox_permissions. 正常说明保留。Justification is optional.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      sandbox_permissions: { type: "string" },
      justification: { type: "string" },
    },
    required: ["command", "justification"],
  },
};

test("sanitizeCodexTools strips the hidden keys from schema and description", () => {
  const [tool] = sanitizeCodexTools([structuredClone(TOOL)]);
  assert.equal("sandbox_permissions" in tool.parameters.properties, false);
  assert.equal("justification" in tool.parameters.properties, false);
  assert.deepEqual(tool.parameters.required, ["command"]);
  assert.equal(tool.description.includes("sandbox_permissions"), false);
  assert.equal(tool.description.includes("正常说明保留"), true);
});

test("executor scrubs the outgoing schema and the incoming tool-call arguments", async () => {
  const hooks = {};
  const executor = await makeExecutor(hooks);
  const chunks = [];
  for await (const chunk of await executor({
    request: { model: "gpt-5.6", tools: [structuredClone(TOOL)] },
    credential: { access: "token" },
  })) chunks.push(chunk);

  const sent = hooks.request.tools[0];
  assert.equal("sandbox_permissions" in sent.parameters.properties, false);
  assert.equal("justification" in sent.parameters.properties, false);
  assert.deepEqual(sent.parameters.required, ["command"]);

  const blockEnd = chunks.find((chunk) => chunk.type === "block-end");
  const args = JSON.parse(blockEnd.block.arguments);
  assert.equal(args.command, "ls -la");
  assert.equal("sandbox_permissions" in args, false);
  assert.equal("justification" in args, false);
});

test("non-gpt tool calls and non-tool chunks pass through untouched", async () => {
  const [tool] = sanitizeCodexTools([{ name: "webfetch", description: "plain", parameters: { type: "object", properties: { url: {} } } }]);
  assert.equal(tool.description, "plain");
  assert.equal("url" in tool.parameters.properties, true);
});
