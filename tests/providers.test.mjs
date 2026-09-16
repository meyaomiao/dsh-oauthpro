import test from "node:test";
// Never let the suite mirror permissions into (or read) the real user config:
// executors that omit `settingsFile` default to ~/.gemini/antigravity-cli.
process.env.DOCKYARD_ANTIGRAVITY_SETTINGS_FILE ||= join(tmpdir(), `agy-test-settings-${process.pid}.json`);
process.env.DOCKYARD_ANTIGRAVITY_CONVERSATIONS_FILE ||= join(tmpdir(), `agy-test-convs-${process.pid}.json`);
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { dirname, join } from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { MemorySecretStore } from "../packages/vault/src/index.mjs";
import { createBrowserOAuthAuthorizer } from "../packages/oauth/src/browser-oauth-authorizer.mjs";
import { createCliOAuthAuthorizer } from "../packages/oauth/src/cli-oauth-authorizer.mjs";
import { createCliStatusAuthorizer } from "../packages/oauth/src/cli-status-authorizer.mjs";
import { createOfficialSessionAuthorizer } from "../packages/oauth/src/official-session-authorizer.mjs";
import {
  createCodexDriver,
  createCodexPiAiExecutor,
  mergeCodexLiveCatalog,
  parseCodexLiveModelCatalog,
  synthesizeCodexPiAiModel,
} from "../modules/provider-codex/src/index.mjs";
import {
  ANTIGRAVITY_DEFAULT_ALLOW_RULES,
  createAntigravityCatalogLoader,
  createAntigravityConversationStore,
  antigravityHistoryImport,
  antigravityRepeatRatio,
  isAntigravitySidebandRequest,
  createAntigravityCliExecutor,
  createAntigravityDriver,
  createAntigravityOAuthAuthorizer,
  detectFakeIpEnvironment,
  createAntigravityNativeQuotaReader,
  enrichAntigravityModelCatalog,
  extractAntigravityAccountEmail,
  antigravityPromptInvocation,
  antigravityRequestPrompt,
  parseAntigravityNativeQuota,
  parseAntigravityKeychainValue,
  parseAntigravityModelCatalog,
  readAntigravityTokenFile,
  resolveAntigravityInvocationModel,
  resolveAntigravityNativeInvocationModel,
} from "../modules/provider-antigravity/src/index.mjs";
import {
  createGrokCatalogLoader,
  createGrokCliExecutor,
  createGrokDriver,
  grokRequestPromptBlocks,
  parseGrokAuth,
  parseGrokCreditsConfig,
  parseGrokModelCatalog,
} from "../modules/provider-grok/src/index.mjs";
import {
  createClaudeCatalogLoader,
  createClaudeCliExecutor,
  createClaudeDriver,
  parseClaudeAuthStatus,
} from "../modules/provider-claude/src/index.mjs";
import {
  BUILTIN_CURSOR_CATALOG,
  createCursorCatalogLoader,
  createCursorCliExecutor,
  createCursorDriver,
  createCursorNativeExecutor,
  parseCursorAuthStatus,
} from "../modules/provider-cursor/src/index.mjs";
import { frameConnectMessage, decodeCursorConnectTrailer } from "../modules/provider-cursor/src/native-protocol.mjs";
import { codexModelToDshCatalog } from "../packages/dsh-plugin/src/codex-transport.mjs";
import { cliEventText } from "../packages/providers/src/cli-agent-transport.mjs";

function jwt(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

const antigravityTestEnv = {
  ...process.env,
  DOCKYARD_ANTIGRAVITY_CLIENT_ID: "test-google-client-id",
  DOCKYARD_ANTIGRAVITY_CLIENT_SECRET: "test-google-client-secret",
};

test("Codex driver imports local OAuth and parses live multi-window quota", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockyard-codex-"));
  try {
    const authPath = join(home, "auth.json");
    const access = jwt({
      exp: Math.floor(Date.now() / 1000) + 3600,
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-live", chatgpt_plan_type: "pro" },
      "https://api.openai.com/profile": { email: "live@example.test", name: "Live User" },
    });
    await writeFile(authPath, JSON.stringify({
      tokens: { access_token: access, refresh_token: "refresh-live", account_id: "acct-live" },
      last_refresh: "2026-08-14T12:00:00.000Z",
    }));
    const driver = createCodexDriver({
      authFilePath: authPath,
      usageUrls: ["https://provider.test/primary", "https://provider.test/fallback"],
      fetchImpl: async (url) => url.endsWith("primary")
        ? response(403, {})
        : response(200, {
          account_id: "acct-live",
          email: "live@example.test",
          plan_type: "pro",
          rate_limit: {
            primary_window: { used_percent: 20, reset_at: 1_900_000_000_000 },
            secondary_window: { used_percent: 5, reset_after_seconds: 300 },
          },
        }),
    });
    const secretStore = new MemorySecretStore();
    const discovered = await driver.discover({ now: new Date("2026-08-14T12:00:00.000Z") });
    assert.equal(discovered.candidates.length, 1);
    const account = await driver.importAccount(discovered.candidates[0], { secretStore, now: new Date("2026-08-14T12:00:00.000Z") });
    const quota = await driver.getQuota(account, { secretStore, now: new Date("2026-08-14T12:00:00.000Z") });
    assert.equal(quota.subscription.plan, "pro");
    assert.equal(quota.identity.email, "live@example.test");
    assert.equal(quota.quota.remaining, 80);
    assert.equal(quota.quota.unit, "percent");
    assert.equal(quota.quota.windows.length, 2);
    assert.equal((await driver.getCatalog()).models.length, 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Codex live model catalog parse hides entries and sorts by priority", () => {
  const models = parseCodexLiveModelCatalog({
    models: [
      { slug: "gpt-5.4", priority: 20 },
      { slug: "secret", visibility: "hidden", priority: 1 },
      { slug: "gpt-6", priority: 10, display_name: "GPT-6" },
      { slug: "gpt-6" },
    ],
  });
  assert.deepEqual(models.map((model) => model.id), ["gpt-6", "gpt-5.4"]);
  assert.equal(models[0].name, "GPT-6");
});

test("Codex live merge synthesizes registry-backed capacities for unknown slugs", () => {
  const registry = [{
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
  }];
  const merged = mergeCodexLiveCatalog([{ id: "gpt-6", name: "GPT-6" }, { id: "gpt-5.6-luna" }], registry);
  const gpt6 = merged.find((model) => model.id === "gpt-6");
  assert.equal(gpt6.name, "GPT-6");
  assert.equal(gpt6.contextWindow, 272_000);
  assert.equal(gpt6.maxTokens, 128_000);
  assert.deepEqual(gpt6.thinkingLevelMap, { xhigh: "xhigh", minimal: "low" });
  assert.equal(gpt6.api, "openai-codex-responses");
  const known = merged.find((model) => model.id === "gpt-5.6-luna");
  assert.equal(known.name, "GPT-5.6 Luna");
});

test("Codex driver fetches the official live model catalog with account headers", async () => {
  let seen;
  const registry = [{
    id: "gpt-5.4",
    name: "GPT-5.4",
    contextWindow: 272_000,
    maxTokens: 128_000,
    input: ["text", "image"],
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", minimal: "low" },
  }];
  const driver = createCodexDriver({
    fetchImpl: async (url, init = {}) => {
      seen = { url, headers: init.headers ?? {} };
      return response(200, { models: [
        { slug: "gpt-5.4", priority: 20 },
        { slug: "gpt-6", priority: 10, display_name: "GPT-6" },
        { slug: "secret", visibility: "hidden", priority: 1 },
      ] });
    },
    catalogLoader: async () => ({ models: registry, source: "dsh_pi_ai_provider_catalog" }),
  });
  const secretStore = new MemorySecretStore();
  const access = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-live", chatgpt_plan_type: "pro" },
  });
  const [account] = await driver.importSource({
    content: JSON.stringify({
      tokens: { access_token: access, refresh_token: "refresh-live", account_id: "acct-live" },
    }),
  }, { secretStore });
  const catalog = await driver.getCatalog({ accounts: [account], secretStore });
  assert.match(seen.url, /chatgpt\.com\/backend-api\/codex\/models/);
  assert.equal(seen.headers.authorization, `Bearer ${access}`);
  assert.equal(seen.headers["chatgpt-account-id"], "acct-live");
  assert.equal(catalog.source, "official_codex_models_api");
  assert.deepEqual(catalog.models.map((model) => model.id), ["gpt-6", "gpt-5.4"]);
  const gpt6 = catalog.models[0];
  assert.equal(gpt6.name, "GPT-6");
  assert.equal(gpt6.contextWindow, 272_000);
  assert.equal(gpt6.maxTokens, 128_000);
});

test("Codex driver falls back to the registry catalog when the live endpoint fails", async () => {
  const registry = [{ id: "gpt-5.4", name: "GPT-5.4", contextWindow: 272_000, maxTokens: 128_000 }];
  const driver = createCodexDriver({
    fetchImpl: async () => response(500, {}),
    catalogLoader: async () => ({ models: registry, source: "dsh_pi_ai_provider_catalog" }),
  });
  const secretStore = new MemorySecretStore();
  const access = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-live" },
  });
  const [account] = await driver.importSource({
    content: JSON.stringify({
      tokens: { access_token: access, refresh_token: "refresh-live", account_id: "acct-live" },
    }),
  }, { secretStore });
  const catalog = await driver.getCatalog({ accounts: [account], secretStore });
  assert.equal(catalog.source, "dsh_pi_ai_provider_catalog");
  assert.deepEqual(catalog.models.map((model) => model.id), ["gpt-5.4"]);
});

test("Codex executor synthesizes capacities for slugs missing from the registry", async () => {
  class StubPiAiAdapter {
    stream(request) { return "stream-result"; }
  }
  const executor = createCodexPiAiExecutor({
    PiAiAdapter: StubPiAiAdapter,
    createProvider: (options) => options,
    openAICodexResponsesApi: () => ({}),
    modelResolver: () => null,
    registryModels: [],
  });
  await executor({
    request: { model: "gpt-6", input: [{ type: "text", text: "hello" }] },
    credential: { access: "oauth-access" },
    context: {},
  });
  const synthesized = synthesizeCodexPiAiModel("gpt-6", []);
  assert.equal(synthesized.contextWindow, 272_000);
  assert.equal(synthesized.maxTokens, 128_000);
  assert.equal(synthesized.api, "openai-codex-responses");
});

test("Codex PiAI transport forwards DSH durable attachments", async () => {  let adapterOptions;
  let streamedRequest;
  class StubPiAiAdapter {
    constructor(options) {
      adapterOptions = options;
    }

    stream(request) {
      streamedRequest = request;
      return "stream-result";
    }
  }
  const executor = createCodexPiAiExecutor({
    PiAiAdapter: StubPiAiAdapter,
    createProvider: (options) => options,
    openAICodexResponsesApi: () => ({}),
    modelResolver: () => ({
      name: "Live Codex",
      contextWindow: 272_000,
      maxTokens: 128_000,
      input: ["text", "image"],
    }),
  });
  const attachments = { id: "durable-attachments" };
  const request = { model: "live-codex", input: [{ type: "text", text: "hello" }] };
  const result = await executor({
    request,
    credential: { access: "oauth-access" },
    context: { attachments },
  });

  assert.equal(result, "stream-result");
  assert.equal(streamedRequest, request);
  assert.equal(adapterOptions.resolveAttachments(), attachments);
});

test("Codex preserves a 401 OAuth signal across quota endpoint fallback", async () => {
  const access = jwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-stale", chatgpt_plan_type: "plus" },
    "https://api.openai.com/profile": { email: "stale@example.test", name: "Stale User" },
  });
  const driver = createCodexDriver({
    usageUrls: ["https://provider.test/primary", "https://provider.test/fallback"],
    fetchImpl: async (url) => url.endsWith("primary") ? response(401, {}) : response(403, {}),
  });
  const secretStore = new MemorySecretStore();
  const [account] = await driver.importSource({
    content: JSON.stringify({
      tokens: { access_token: access, refresh_token: "refresh-stale", account_id: "acct-stale" },
    }),
  }, { secretStore });

  await assert.rejects(
    driver.getQuota(account, { secretStore }),
    (error) => {
      assert.equal(error.authExpired, true);
      assert.equal(error.authForbidden, false);
      assert.match(error.message, /reauthorization required/);
      return true;
    },
  );
});

test("Codex does not classify an unrelated 400 refresh failure as expired OAuth", async () => {
  const driver = createCodexDriver({
    tokenUrl: "https://provider.test/oauth/token",
    fetchImpl: async () => response(400, { error: "server_error" }),
  });
  const secretStore = new MemorySecretStore();
  await secretStore.write("keychain://codex/account-a", {
    access: "access-token",
    refresh: "refresh-token",
    accountId: "account-a",
  });
  await assert.rejects(
    () => driver.refreshAccount({
      accountId: "account-a",
      auth: { credentialRef: "keychain://codex/account-a" },
      refresh: {},
    }, { secretStore, force: true }),
    (error) => error.authExpired === false,
  );
});

test("CLI OAuth authorizer waits for the official login process and imports its isolated profile", async () => {
  const authState = JSON.stringify({ login: "completed" });
  const childScript = [
    "const { writeFileSync } = require('node:fs');",
    "const { join } = require('node:path');",
    `writeFileSync(join(process.env.DOCKYARD_TEST_OAUTH_HOME, 'auth.json'), ${JSON.stringify(authState)});`,
    "console.error('https://provider.test/oauth/authorize\\u001b[0m');",
  ].join(" ");
  const authorizer = createCliOAuthAuthorizer({
    providerId: "test-provider",
    cliPath: process.execPath,
    loginArgs: ["-e", childScript],
    environmentKey: "DOCKYARD_TEST_OAUTH_HOME",
    importCredentials: async (raw) => [{
      providerId: "test-provider",
      accountId: raw.login,
      credentialRef: "keychain://test-provider/login",
    }],
  });
  const started = await authorizer.begin();
  assert.equal(started.status, "pending");
  let result = await authorizer.poll(started.sessionId, {});
  for (let attempt = 0; result.status === "pending" && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = await authorizer.poll(started.sessionId, {});
  }
  assert.equal(result.status, "completed");
  assert.equal(result.accounts[0].accountId, "completed");
  assert.equal(result.authorizationUrl, "https://provider.test/oauth/authorize");
});

test("CLI OAuth authorizer can keep a provider profile and report CLI-owned browser flow", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockyard-provider-oauth-"));
  try {
    const authState = JSON.stringify({ login: "provider-profile" });
    const childScript = [
      "const { writeFileSync } = require('node:fs');",
      "const { join } = require('node:path');",
      `writeFileSync(join(process.env.DOCKYARD_TEST_OAUTH_HOME, 'auth.json'), ${JSON.stringify(authState)});`,
      "console.error('https://provider.test/oauth/authorize\\u001b[0m');",
    ].join(" ");
    const authorizer = createCliOAuthAuthorizer({
      providerId: "test-provider-profile",
      cliPath: process.execPath,
      loginArgs: ["-e", childScript],
      environmentKey: "DOCKYARD_TEST_OAUTH_HOME",
      profileDirectory: home,
      browserOpened: true,
      importCredentials: async (raw) => [{
        providerId: "test-provider-profile",
        accountId: raw.login,
        credentialRef: "keychain://test-provider-profile/login",
      }],
    });
    const started = await authorizer.begin();
    assert.equal(started.status, "pending");
    assert.equal(started.browserOpened, true);
    let result = await authorizer.poll(started.sessionId, {});
    for (let attempt = 0; result.status === "pending" && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      result = await authorizer.poll(started.sessionId, {});
    }
    assert.equal(result.status, "completed");
    assert.equal(result.browserOpened, true);
    assert.equal(result.accounts[0].accountId, "provider-profile");
    assert.equal(result.authorizationUrl, "https://provider.test/oauth/authorize");
    assert.equal(await readFile(join(home, "auth.json"), "utf8"), authState);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("CLI status authorizer reports a browser already opened by the provider CLI", async () => {
  const childScript = "console.error('https://provider.test/oauth/authorize');";
  const authorizer = createCliStatusAuthorizer({
    providerId: "test-status-provider",
    cliPath: process.execPath,
    loginArgs: ["-e", childScript],
    browserOpened: true,
    importStatus: async () => [{
      providerId: "test-status-provider",
      accountId: "active-account",
    }],
  });
  const started = await authorizer.begin();
  assert.equal(started.browserOpened, true);
  let result = await authorizer.poll(started.sessionId, {});
  for (let attempt = 0; result.status === "pending" && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = await authorizer.poll(started.sessionId, {});
  }
  assert.equal(result.status, "completed");
  assert.equal(result.browserOpened, true);
  assert.equal(result.accounts[0].accountId, "active-account");
  assert.equal(result.authorizationUrl, "https://provider.test/oauth/authorize");
});

test("browser OAuth authorizer validates state and imports a loopback callback", async () => {
  let request;
  const authorizer = createBrowserOAuthAuthorizer({
    providerId: "test-browser-provider",
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    authorizationUrlBuilder: async (value) => {
      request = value;
      return `https://example.test/authorize?state=${value.state}`;
    },
    exchangeCode: async (value) => {
      assert.equal(value.code, "browser-code");
      assert.equal(value.state, request.state);
      assert.equal(typeof value.codeVerifier, "string");
      return { access_token: "opaque-token" };
    },
    importCredentials: async (value) => [{ providerId: "test-browser-provider", accountId: value.access_token }],
  });
  const started = await authorizer.begin();
  const callback = new URL(request.redirectUri);
  callback.searchParams.set("code", "browser-code");
  callback.searchParams.set("state", request.state);
  const responseValue = await fetch(callback).then((response) => response.text());
  assert.match(responseValue, /授权成功/);
  const completed = await authorizer.poll(started.sessionId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.accounts[0].accountId, "opaque-token");
});

test("browser OAuth rejects callbacks and pasted codes without matching state", async () => {
  let callbackRequest;
  const callbackAuthorizer = createBrowserOAuthAuthorizer({
    providerId: "test-browser-state-provider",
    callbackHost: "127.0.0.1",
    callbackPort: 0,
    authorizationUrlBuilder: async (value) => {
      callbackRequest = value;
      return "https://example.test/authorize";
    },
    exchangeCode: async () => { throw new Error("must not exchange an invalid callback"); },
    importCredentials: async () => [],
  });
  const callbackStarted = await callbackAuthorizer.begin();
  const callback = new URL(callbackRequest.redirectUri);
  callback.searchParams.set("error", "access_denied");
  const callbackResponse = await fetch(callback);
  assert.match(await callbackResponse.text(), /安全校验失败/);
  const callbackResult = await callbackAuthorizer.poll(callbackStarted.sessionId);
  assert.equal(callbackResult.status, "failed");
  assert.match(callbackResult.diagnostic, /OAuth state 校验失败/);

  const pastedAuthorizer = createBrowserOAuthAuthorizer({
    providerId: "test-pasted-state-provider",
    redirectUri: "https://example.test/oauth/callback",
    callbackPort: null,
    authorizationUrlBuilder: async () => "https://example.test/authorize",
    exchangeCode: async () => { throw new Error("must not exchange a bare code"); },
    importCredentials: async () => [],
  });
  const pastedStarted = await pastedAuthorizer.begin();
  const pastedResult = await pastedAuthorizer.submitAuthorizationCode(pastedStarted.sessionId, "bare-code");
  assert.equal(pastedResult.status, "failed");
  assert.match(pastedResult.diagnostic, /OAuth state 校验失败/);
});

test("browser OAuth cancellation wins a concurrent exchange", async () => {
  let request;
  let release;
  let imports = 0;
  const authorizer = createBrowserOAuthAuthorizer({
    providerId: "test-browser-cancel-provider",
    redirectUri: "https://example.test/oauth/callback",
    callbackPort: null,
    authorizationUrlBuilder: async (value) => {
      request = value;
      return "https://example.test/authorize";
    },
    exchangeCode: async () => new Promise((resolve) => { release = () => resolve({ access_token: "late" }); }),
    importCredentials: async () => { imports += 1; return [{ accountId: "late" }]; },
  });
  const started = await authorizer.begin();
  const submitted = authorizer.submitAuthorizationCode(started.sessionId, `code#${request.state}`);
  const cancelled = await authorizer.cancel(started.sessionId);
  assert.equal(cancelled.status, "cancelled");
  release?.();
  const result = await submitted;
  assert.equal(result.status, "cancelled");
  assert.equal(imports, 0);
});

test("official client session authorizer polls a provider-owned desktop session", async () => {
  let ready = false;
  const authorizer = createOfficialSessionAuthorizer({
    providerId: "test-client-provider",
    readSession: async () => ready
      ? { accounts: [{ providerId: "test-client-provider", accountId: "desktop-account" }] }
      : { accounts: [] },
  });
  const started = await authorizer.begin();
  assert.equal(started.status, "pending");
  assert.equal((await authorizer.poll(started.sessionId)).status, "pending");
  ready = true;
  const completed = await authorizer.poll(started.sessionId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.accounts[0].accountId, "desktop-account");
});

test("Antigravity OAuth authorizer captures agy's browser URL and imports its isolated token", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { writable: true, write() {} };
  child.kill = () => true;
  const authorizer = createAntigravityOAuthAuthorizer({
    cliPath: "agy",
    spawnImpl: (_command, _args, options) => {
      queueMicrotask(async () => {
        child.stderr.emit("data", "https://accounts.google.com/o/oauth2/auth?state=test&code_challenge=test\n");
        await mkdir(dirname(options.env.DOCKYARD_ANTIGRAVITY_TOKEN_FILE), { recursive: true });
        await writeFile(options.env.DOCKYARD_ANTIGRAVITY_TOKEN_FILE, JSON.stringify({ access_token: "isolated-token" }));
      });
      return child;
    },
  });
  const started = await authorizer.begin({ accounts: [] });
  assert.equal(started.status, "pending");
  let result = await authorizer.poll(started.sessionId, { accounts: [] });
  for (let attempt = 0; result.status === "pending" && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    result = await authorizer.poll(started.sessionId, { accounts: [] });
  }
  assert.equal(result.status, "completed");
  assert.equal(result.authorizationUrl, "https://accounts.google.com/o/oauth2/auth?state=test&code_challenge=test");
  assert.equal(result.accounts[0].resources.sessionPersistence, "captured");
  assert.equal(result.accounts[0].resources.sessionSource, "browser");
  assert.equal(result.accounts[0].resources.credentialRefreshMode, "agy_session");
  assert.equal(result.accounts[0].source, "official_antigravity_browser_oauth");
  assert.equal(started.browserOpened, true);
});

test("Antigravity OAuth authorizer reports submitted codes as processing", async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  child.stdin = { writable: true, write(value) { writes.push(value); } };
  child.kill = () => true;
  const authorizer = createAntigravityOAuthAuthorizer({
    cliPath: "agy",
    spawnImpl: () => child,
  });
  const started = await authorizer.begin();
  const submitted = await authorizer.submitAuthorizationCode(started.sessionId, "fresh-code");
  assert.equal(submitted.status, "processing");
  assert.match(submitted.instructions, /正在等待官方登录完成/);
  assert.deepEqual(writes, ["fresh-code\n"]);
  await authorizer.cancel(started.sessionId);
});

test("Antigravity decodes the official go-keyring Keychain session", () => {
  const encoded = Buffer.from(JSON.stringify({
    auth_method: "consumer",
    token: {
      access_token: "keychain-access",
      refresh_token: "keychain-refresh",
      expiry: "2026-08-27T04:00:00.000Z",
    },
  })).toString("base64");
  assert.deepEqual(parseAntigravityKeychainValue(`go-keyring-base64:${encoded}`), {
    token: "keychain-access",
    refreshToken: "keychain-refresh",
    expiresAt: "2026-08-27T04:00:00.000Z",
    kind: "oauth",
    source: "antigravity_keychain",
    email: null,
  });
});

test("Antigravity token files retain the OAuth refresh token and expiry", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockyard-antigravity-token-file-"));
  try {
    const tokenPath = join(home, "antigravity-oauth-token.json");
    await writeFile(tokenPath, JSON.stringify({
      credentials: {
        access_token: "google-access",
        refresh_token: "google-refresh",
        expiry_date: Date.parse("2026-08-25T00:00:00.000Z"),
      },
    }));
    assert.deepEqual(readAntigravityTokenFile({
      env: { DOCKYARD_ANTIGRAVITY_TOKEN_FILE: tokenPath },
      home,
    }), {
      token: "google-access",
      refreshToken: "google-refresh",
      expiresAt: "2026-08-25T00:00:00.000Z",
      kind: "oauth",
      email: null,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Antigravity driver uses official CLI data without requiring token storage", async () => {
  const commandRunner = async (_command, args) => {
    const command = args[1];
    if (command === "/quota") return { output: JSON.stringify({ status: "SUCCESS", command: { data: { groups: [{ name: "Live group", buckets: [{ id: "window-live", name: "Live window", remaining_fraction: 0.75, reset_time: 1_900_000_000_000 }] }] } }, response: "" }), errorOutput: "" };
    if (command === "/credits") return { output: JSON.stringify({ status: "SUCCESS", command: { data: { remaining_credits: 4, upgrade_uri: "https://provider.test/upgrade" } }, response: "" }), errorOutput: "" };
    if (args[0] === "models") return { output: "Fetching available models...\nmodel-from-provider\tLive model\n", errorOutput: "" };
    throw new Error("unexpected command");
  };
  // The default catalog cache is the shared ~/.dockyard-dsh/antigravity-catalog.json,
  // which a running DSH host (and other suites) write live provider data into.
  // Reading it here made this test pass or fail depending on the machine state.
  const home = await mkdtemp(join(tmpdir(), "agy-driver-catalog-"));
  try {
    const driver = createAntigravityDriver({
      commandRunner,
      tokenResolver: () => null,
      env: {
        ...process.env,
        DOCKYARD_DSH_HOME: home,
        DOCKYARD_ANTIGRAVITY_CATALOG_CACHE: join(home, "antigravity-catalog.json"),
      },
    });
    const secretStore = new MemorySecretStore();
    const discovered = await driver.discover({ now: new Date("2026-08-14T12:00:00.000Z") });
    assert.equal(discovered.candidates.length, 1);
    const account = await driver.importAccount(discovered.candidates[0], { secretStore });
    const quota = await driver.getQuota(account, { secretStore, now: new Date("2026-08-14T12:00:00.000Z") });
    assert.equal(quota.quota.remaining, 0.75);
    assert.equal(quota.resources, undefined);
    assert.equal(quota.credits.remaining, 4);
    assert.deepEqual((await driver.getCatalog()).models, [{ id: "model-from-provider", name: "Live model" }]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Antigravity account discovery keeps provider identity and captures distinct local sessions", async () => {
  const commandRunner = async () => ({
    output: JSON.stringify({
      status: "SUCCESS",
      command: { data: { groups: [{ buckets: [{ id: "window-live", remaining_fraction: 0.75 }] }] } },
      response: "",
    }),
    errorOutput: "applyAuthResult: email=first@example.test",
  });
  const driver = createAntigravityDriver({
    commandRunner,
    tokenResolver: () => ({ token: "session-token-first" }),
  });
  const discovered = await driver.discover({ now: new Date("2026-08-14T12:00:00.000Z") });
  const candidate = discovered.candidates[0];
  assert.equal(extractAntigravityAccountEmail("OAuth: authenticated successfully as first@example.test"), "first@example.test");
  assert.equal(candidate.email, "first@example.test");
  assert.equal(candidate.displayName, "first@example.test");
  assert.equal(candidate.resources.sessionPersistence, "captured");
  assert.equal(candidate.resources.identitySource, "official_cli_auth_status");

  const secretStore = new MemorySecretStore();
  const account = await driver.importAccount(candidate, { secretStore });
  assert.deepEqual(await secretStore.read(account.credentialRef), {
    type: "official_session",
    providerId: "antigravity",
    access: "session-token-first",
    email: "first@example.test",
  });

  const second = createAntigravityDriver({
    commandRunner: async () => ({
      output: JSON.stringify({ status: "SUCCESS", command: { data: { groups: [{ buckets: [{ id: "window-live", remaining_fraction: 0.75 }] }] } } }),
      errorOutput: "applyAuthResult: email=second@example.test",
    }),
    tokenResolver: () => ({ token: "session-token-second" }),
  });
  const secondCandidate = (await second.discover({ now: new Date("2026-08-14T12:00:00.000Z") })).candidates[0];
  assert.notEqual(secondCandidate.accountId, candidate.accountId);
  assert.notEqual(secondCandidate.resources.sessionFingerprint, candidate.resources.sessionFingerprint);
});

test("Antigravity resolves the active session email from Google userinfo", async () => {
  const commandRunner = async () => ({
    output: JSON.stringify({
      status: "SUCCESS",
      command: { data: { groups: [{ buckets: [{ id: "window-live", remaining_fraction: 0.75 }] }] } },
      response: "",
    }),
    errorOutput: "",
  });
  let userInfoCalls = 0;
  const driver = createAntigravityDriver({
    commandRunner,
    tokenResolver: () => ({ token: "session-token" }),
    fetchImpl: async (url) => {
      userInfoCalls += 1;
      assert.match(url, /googleapis\.com\/oauth2\/v1\/userinfo/);
      return response(200, { email: "userinfo@example.test" });
    },
  });
  const found = (await driver.discover({ now: new Date("2026-08-14T12:00:00.000Z") })).candidates[0];
  assert.equal(found.email, "userinfo@example.test");
  assert.equal(found.displayName, "userinfo@example.test");
  assert.equal(userInfoCalls, 1);
});

test("Antigravity rejects a captured account after the local session changes", async () => {
  let currentToken = "session-token-first";
  const commandRunner = async () => ({
    output: JSON.stringify({
      status: "SUCCESS",
      command: { data: { groups: [{ buckets: [{ id: "window-live", remaining_fraction: 0.75 }] }] } },
      response: "",
    }),
    errorOutput: "applyAuthResult: email=first@example.test",
  });
  let invoked = false;
  const driver = createAntigravityDriver({
    commandRunner,
    tokenResolver: () => ({ token: currentToken }),
    requestExecutor: async () => { invoked = true; },
  });
  const candidate = (await driver.discover()).candidates[0];
  const account = await driver.importAccount(candidate, { secretStore: new MemorySecretStore() });
  currentToken = "session-token-second";

  await assert.rejects(
    () => driver.invoke({}, { account }),
    (error) => error.authExpired === true && error.accountMismatch === true,
  );
  assert.equal(invoked, false);
});

test("Antigravity refreshAccount reuses the live quota response", async () => {
  const calls = [];
  const commandRunner = async (_command, args) => {
    const command = args[1];
    calls.push(command);
    if (command === "/quota") {
      return { output: JSON.stringify({ status: "SUCCESS", command: { data: { groups: [{ name: "Live group", buckets: [{ id: "window-live", name: "Live window", remaining_fraction: 0.8, reset_time: 1_900_000_000_000 }] }] } }, response: "" }), errorOutput: "" };
    }
    if (command === "/credits") {
      return { output: JSON.stringify({ status: "SUCCESS", command: { data: { remaining_credits: 5 } }, response: "" }), errorOutput: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  };
  const driver = createAntigravityDriver({ commandRunner, tokenResolver: () => null });
  const discovered = await driver.discover({ now: new Date("2026-08-14T12:00:00.000Z") });
  const account = await driver.importAccount(discovered.candidates[0], { secretStore: new MemorySecretStore() });
  calls.length = 0;

  const refreshed = await driver.refreshAccount(account, { now: new Date("2026-08-14T12:00:00.000Z") });
  assert.equal(refreshed.quota.remaining, 0.8);
  assert.equal(refreshed.credits.remaining, 5);
  assert.deepEqual(calls.sort(), ["/credits", "/quota"]);
});

test("Antigravity does not fall back to the global CLI quota for a selected account", async () => {
  let cliCalls = 0;
  const driver = createAntigravityDriver({
    quotaReader: async () => {
      throw new Error("selected account quota unavailable");
    },
    tokenResolver: () => null,
    commandRunner: async () => {
      cliCalls += 1;
      throw new Error("global CLI must not be used");
    },
  });
  await assert.rejects(
    () => driver.refreshAccount({
      accountId: "account-a",
      auth: { credentialRef: "keychain://account-a" },
    }),
    /selected account quota unavailable/,
  );
  assert.equal(cliCalls, 0);
});

test("Antigravity browser OAuth refreshes persisted Google credentials after restart", async () => {
  const secretStore = new MemorySecretStore();
  const credentialRef = "keychain://antigravity/browser-account";
  await secretStore.write(credentialRef, {
    type: "official_session",
    providerId: "antigravity",
    access: "expired-access",
    refresh: "google-refresh",
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  let refreshCalls = 0;
  let quotaCredential = null;
  const driver = createAntigravityDriver({
    cliPath: "missing-agy",
    commandRunner: async () => { throw new Error("CLI must not be used for persisted browser OAuth"); },
    clientId: "dockyard-google-client",
    clientSecret: "dockyard-google-secret",
    quotaReader: async ({ credential }) => {
      quotaCredential = credential;
      return {
        quotaGroups: [{
          name: "Persisted browser group",
          buckets: [{ id: "daily", name: "Daily", remainingFraction: 0.8, resetTime: 1_900_000_000_000 }],
        }],
      };
    },
    fetchImpl: async (url) => {
      assert.match(url, /oauth2\.googleapis\.com\/token/);
      refreshCalls += 1;
      return response(200, { access_token: "refreshed-access", expires_in: 3600 });
    },
  });
  const account = {
    providerId: "antigravity",
    accountId: "antigravity:google:browser-account",
    email: "google@example.test",
    credentialRef,
    auth: { kind: "official_session", credentialRef, scopes: [] },
    resources: { sessionSource: "browser" },
    refresh: { accessTokenExpiresAt: "2020-01-01T00:00:00.000Z" },
  };

  const refreshed = await driver.refreshAccount(account, {
    secretStore,
    now: new Date("2026-08-16T12:00:00.000Z"),
  });
  assert.equal(refreshCalls, 1);
  assert.equal(quotaCredential.access, "refreshed-access");
  assert.equal(refreshed.quota.remaining, 0.8);
  assert.equal((await secretStore.read(credentialRef)).access, "refreshed-access");
  assert.equal((await secretStore.read(credentialRef)).refresh, "google-refresh");
});

test("Antigravity agy browser sessions refresh captured and legacy credentials through agy", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockyard-antigravity-agy-session-"));
  const tokenPath = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const secretStore = new MemorySecretStore();
  const credentialRef = "keychain://antigravity/agy-browser-account";
  await secretStore.write(credentialRef, {
    type: "official_session",
    providerId: "antigravity",
    access: "agy-expired-access",
    refresh: "agy-refresh",
    expiresAt: null,
  });
  let refreshCalls = 0;
  let quotaCredential = null;
  const driver = createAntigravityDriver({
    cliPath: "agy",
    env: { HOME: home, DOCKYARD_ANTIGRAVITY_TOKEN_FILE: tokenPath },
    commandRunner: async (_command, args, options) => {
      refreshCalls += 1;
      assert.deepEqual(args, ["models"]);
      assert.equal(options.env.AGY_CLI_HIDE_ACCOUNT_INFO, "1");
      assert.equal(options.env.HOME, home);
      assert.equal(options.env.GEMINI_FORCE_FILE_STORAGE, "true");
      await mkdir(dirname(options.env.DOCKYARD_ANTIGRAVITY_TOKEN_FILE), { recursive: true });
      await writeFile(options.env.DOCKYARD_ANTIGRAVITY_TOKEN_FILE, JSON.stringify({
        auth_method: "consumer",
        token: {
          access_token: "agy-refreshed-access",
          refresh_token: "agy-refreshed-refresh",
          expiry: "2026-08-25T13:00:00.000Z",
        },
      }));
      return { output: "", errorOutput: "" };
    },
    tokenResolver: () => null,
    quotaReader: async ({ credential }) => {
      quotaCredential = credential;
      return {
        quotaGroups: [{
          name: "Captured agy group",
          buckets: [{ id: "daily", name: "Daily", remainingFraction: 0.72, resetTime: 1_900_000_000_000 }],
        }],
      };
    },
    fetchImpl: async () => {
      refreshCalls += 1;
      throw new Error("DSH Google refresh must not run for agy sessions");
    },
  });
  const account = {
    providerId: "antigravity",
    accountId: "antigravity:session:agy-browser-account",
    credentialRef,
    auth: { kind: "official_session", credentialRef, scopes: [] },
    resources: {
      sessionSource: "browser",
      // This intentionally omits credentialRefreshMode to cover accounts
      // imported before the mode was persisted in the account snapshot.
      sessionPersistence: "captured",
    },
    refresh: { accessTokenExpiresAt: null, refreshable: true },
  };

  const refreshed = await driver.refreshAccount(account, {
    secretStore,
    now: new Date("2026-08-25T12:00:00.000Z"),
  });
  assert.equal(refreshCalls, 1);
  assert.equal(quotaCredential.access, "agy-refreshed-access");
  assert.equal(quotaCredential.refresh, "agy-refreshed-refresh");
  assert.equal(refreshed.quota.remaining, 0.72);
  assert.equal(refreshed.refresh.accessTokenExpiresAt, "2026-08-25T13:00:00.000Z");
  assert.equal(refreshed.refresh.refreshable, true);
  assert.equal((await secretStore.read(credentialRef)).access, "agy-refreshed-access");
  assert.equal((await secretStore.read(credentialRef)).refresh, "agy-refreshed-refresh");
  await rm(home, { recursive: true, force: true });
});

test("Antigravity local agy sessions refresh the canonical token before native quota", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockyard-antigravity-active-session-"));
  const tokenPath = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const secretStore = new MemorySecretStore();
  const credentialRef = "keychain://antigravity/active-session";
  await mkdir(dirname(tokenPath), { recursive: true });
  await writeFile(tokenPath, JSON.stringify({
    auth_method: "consumer",
    token: {
      access_token: "active-expired-access",
      refresh_token: "active-refresh",
      expiry: "2026-08-25T13:00:00.000Z",
    },
  }));
  let refreshCalls = 0;
  let quotaCredential = null;
  const driver = createAntigravityDriver({
    cliPath: "agy",
    env: { HOME: home, DOCKYARD_ANTIGRAVITY_TOKEN_FILE: tokenPath },
    usePtyForSessionRefresh: false,
    commandRunner: async (_command, args, options) => {
      refreshCalls += 1;
      assert.deepEqual(args, ["models"]);
      assert.equal(options.env.AGY_CLI_HIDE_ACCOUNT_INFO, "1");
      assert.equal(options.env.HOME, home);
      assert.equal(options.env.GEMINI_FORCE_FILE_STORAGE, "true");
      await writeFile(options.env.DOCKYARD_ANTIGRAVITY_TOKEN_FILE, JSON.stringify({
        auth_method: "consumer",
        token: {
          access_token: "active-refreshed-access",
          refresh_token: "active-refreshed-refresh",
          expiry: "2026-08-25T14:00:00.000Z",
        },
      }));
      return { output: "", errorOutput: "" };
    },
    quotaReader: async ({ credential }) => {
      quotaCredential = credential;
      return {
        quotaGroups: [{
          name: "Active agy group",
          buckets: [{ id: "daily", name: "Daily", remainingFraction: 0.81, resetTime: 1_900_000_000_000 }],
        }],
      };
    },
  });
  const account = {
    providerId: "antigravity",
    accountId: "antigravity:active",
    auth: { kind: "official_session", credentialRef, scopes: [] },
    resources: { sessionSource: "cli" },
    refresh: { accessTokenExpiresAt: "2026-08-25T13:00:00.000Z", refreshable: true },
  };

  const refreshed = await driver.refreshAccount(account, {
    secretStore,
    now: new Date("2026-08-25T13:30:00.000Z"),
  });
  assert.equal(refreshCalls, 1);
  assert.equal(quotaCredential.access, "active-refreshed-access");
  assert.equal(quotaCredential.refresh, "active-refreshed-refresh");
  assert.equal(refreshed.quota.remaining, 0.81);
  assert.equal(refreshed.refresh.accessTokenExpiresAt, "2026-08-25T14:00:00.000Z");
  assert.equal((await secretStore.read(credentialRef)).access, "active-refreshed-access");
  await rm(home, { recursive: true, force: true });
});

test("Antigravity native quota reader uses the first-party summary endpoint", async () => {
  let request;
  const reader = createAntigravityNativeQuotaReader({
    endpoint: "https://provider.test/v1internal:retrieveUserQuotaSummary",
    project: null,
    tokenResolver: () => ({ token: "oauth-token" }),
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        status: 200,
        ok: true,
        async json() {
          return {
            quotaGroups: [{
              name: "Live group",
              buckets: [{ id: "weekly", name: "Weekly", remainingFraction: 0.91, resetTime: 1_900_000_000_000 }],
            }],
            remainingCredits: 7,
          };
        },
      };
    },
  });
  const raw = await reader({});
  const quota = parseAntigravityNativeQuota(raw, new Date("2026-08-14T12:00:00.000Z"));
  assert.equal(request.url, "https://provider.test/v1internal:retrieveUserQuotaSummary");
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.headers.authorization, "Bearer oauth-token");
  assert.deepEqual(JSON.parse(request.init.body), {});
  assert.equal(quota.windows[0].remaining, 0.91);
  assert.equal(quota.windows[0].source, "antigravity_native");
  assert.equal(quota.credits.remaining, 7);
});

test("Antigravity catalog stays mounted when the optional CLI is unavailable", async () => {
  let calls = 0;
  const loader = createAntigravityCatalogLoader({
    cacheFilePath: null,
    cacheTtlMs: 60_000,
    commandRunner: async () => {
      calls += 1;
      const error = new Error("spawn agy ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  });

  const first = await loader();
  const second = await loader();
  assert.deepEqual(first.models, []);
  assert.equal(first.source, "antigravity_cli_not_found");
  assert.match(first.diagnostics[0], /spawn agy ENOENT/);
  assert.deepEqual(second, first);
  assert.equal(calls, 1);
});

test("Antigravity catalog loader falls back to the DSH registry when the official CLI is unavailable", async () => {
  const loader = createAntigravityCatalogLoader({
    cacheFilePath: null,
    commandRunner: async () => {
      const error = new Error("spawn agy ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    registryLoader: async () => [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", provider: "google", contextWindow: 1_048_576, maxTokens: 65_536, input: ["text", "image"] },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google-vertex" },
      { id: "unrelated", provider: "xai" },
    ],
  });
  const catalog = await loader();
  assert.equal(catalog.source, "dsh_live_provider_registry");
  assert.equal(catalog.diagnostics, undefined);
  assert.deepEqual(catalog.models.map((model) => model.id), ["gemini-2.5-flash", "gemini-2.5-pro"]);
  assert.equal(catalog.models[0].contextWindow, 1_048_576);
});

test("Antigravity catalog loader prefers live CLI models over the registry", async () => {
  let registryCalls = 0;
  const loader = createAntigravityCatalogLoader({
    cacheFilePath: null,
    commandRunner: async () => ({ output: "gemini-live\tGemini Live\n" }),
    registryLoader: async () => {
      registryCalls += 1;
      return [{ id: "gemini-2.5-flash", provider: "google" }];
    },
  });
  const catalog = await loader({ force: true });
  assert.deepEqual(catalog.models.map((model) => model.id), ["gemini-live"]);
  assert.equal(catalog.source, "official_antigravity_cli");
  assert.equal(catalog.diagnostics, undefined);
  assert.equal(registryCalls, 1);
});

test("Antigravity catalog loader never reports a failed read while a previous catalog exists", async () => {
  let calls = 0;
  const loader = createAntigravityCatalogLoader({
    cacheFilePath: null,
    cacheTtlMs: 1,
    commandRunner: async () => {
      calls += 1;
      if (calls === 1) return { output: "gemini-live\tGemini Live\n" };
      const error = new Error("spawn agy ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  });
  const first = await loader({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await loader({ force: true });
  assert.deepEqual(first.models.map((model) => model.id), ["gemini-live"]);
  assert.deepEqual(second.models.map((model) => model.id), ["gemini-live"]);
  assert.equal(second.diagnostics, undefined);
});

test("provider model metadata exposes only returned reasoning tiers", () => {
  // Tier suffixes live in the id, so parse must not declare a second selector
  // (Refs #65). Non-tier rows are unaffected.
  assert.deepEqual(parseAntigravityModelCatalog([
    "Fetching available models...",
    "gemini-live-low\tGemini Live (Low)",
    "gemini-live-medium\tGemini Live (Medium)",
    "gemini-live-high\tGemini Live (High)",
    "claude-live\tClaude Live (Thinking)",
  ].join("\n")), [
    { id: "gemini-live-low", name: "Gemini Live (Low)" },
    { id: "gemini-live-medium", name: "Gemini Live (Medium)" },
    { id: "gemini-live-high", name: "Gemini Live (High)" },
    { id: "claude-live", name: "Claude Live (Thinking)" },
  ]);

  assert.deepEqual(codexModelToDshCatalog({
    id: "live-gpt",
    name: "Live GPT",
    reasoning: true,
    thinkingLevelMap: { minimal: "low", xhigh: "xhigh", off: "none" },
  }).reasoning, {
    efforts: [
      { id: "minimal", name: "Minimal", description: "provider value: low" },
      { id: "xhigh", name: "Xhigh" },
    ],
  });
});

test("Antigravity tier rows declare their own effort when the registry is unavailable", () => {
  // Account-scoped catalog reads were observed without registry metadata, which
  // left every row bare. DSH then rejects any stored reasoningEffort outright
  // (`UNSUPPORTED_REASONING_EFFORT`) even though the effort is exactly the tier
  // the row already encodes — every antigravity conversation carrying an effort
  // became unusable. The row therefore declares the single effort it is.
  const live = parseAntigravityModelCatalog([
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
    "claude-live\tClaude Live (Thinking)",
  ].join("\n"));
  assert.deepEqual(enrichAntigravityModelCatalog(live, []).map((model) => [model.id, model.reasoning]), [
    ["gemini-3.8-flash-high", { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" }],
    ["gemini-3.8-flash-low", { efforts: [{ id: "low", name: "Low" }], defaultEffort: "low" }],
    // No tier in the id, nothing to declare: a row that never had a reasoning
    // control must not grow one.
    ["claude-live", undefined],
  ]);
});

test("Antigravity keeps the registry's own reasoning tiers when it provides them", () => {
  const live = parseAntigravityModelCatalog([
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  ].join("\n"));
  const registry = [{
    id: "gemini-3.8-flash",
    reasoning: {
      efforts: [{ id: "high", name: "High" }, { id: "medium", name: "Medium" }, { id: "low", name: "Low" }],
      defaultEffort: "high",
    },
  }];
  assert.deepEqual(enrichAntigravityModelCatalog(live, registry)[0].reasoning, {
    efforts: [{ id: "high", name: "High" }, { id: "medium", name: "Medium" }, { id: "low", name: "Low" }],
    defaultEffort: "high",
  });
});

test("Antigravity never declares an empty reasoning effort list", () => {
  // DSH rejects `efforts: []` with INVALID_MODEL_REASONING, so the fallback must
  // either declare a real effort or leave the field out entirely.
  const live = parseAntigravityModelCatalog([
    "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
    "claude-live\tClaude Live (Thinking)",
  ].join("\n"));
  for (const model of enrichAntigravityModelCatalog(live, [])) {
    if (model.reasoning !== undefined) assert.ok(model.reasoning.efforts.length > 0);
    if (model.reasoning?.defaultEffort !== undefined) {
      assert.ok(model.reasoning.efforts.some((effort) => effort.id === model.reasoning.defaultEffort));
    }
  }
});

test("Antigravity capacity metadata is enriched only from a live-compatible registry family", () => {
  const live = parseAntigravityModelCatalog([
    "gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
    "gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)",
  ].join("\n"));
  assert.deepEqual(enrichAntigravityModelCatalog(live, [{
    id: "gemini-3.6-flash",
    contextWindow: 1048576,
    maxTokens: 65536,
    input: ["text", "image"],
  }]), [
    {
      id: "gemini-3.6-flash-high",
      name: "Gemini 3.6 Flash (High)",
      contextWindow: 1048576,
      maxTokens: 65536,
      inputModalities: ["text", "image"],
      reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" },
    },
    {
      id: "gemini-3.6-flash-medium",
      name: "Gemini 3.6 Flash (Medium)",
      contextWindow: 1048576,
      maxTokens: 65536,
      inputModalities: ["text", "image"],
      reasoning: { efforts: [{ id: "medium", name: "Medium" }], defaultEffort: "medium" },
    },
  ]);
  assert.deepEqual(enrichAntigravityModelCatalog(live, [{ id: "gemini-3.7-flash" }])[0].contextWindow, undefined);
});

test("Antigravity catalog supplies the published Gemini 3.7 capacity fallback", async () => {
  const loader = createAntigravityCatalogLoader({
    cacheFilePath: null,
    commandRunner: async () => ({
      output: [
        "gemini-3.7-flash-high\tGemini 3.7 Flash (High)",
        "gemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)",
      ].join("\n"),
    }),
    registryLoader: async () => [],
  });
  const catalog = await loader({ force: true });
  assert.deepEqual(catalog.models.map((model) => ({
    id: model.id,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  })), [
    { id: "gemini-3.7-flash-high", contextWindow: 1_048_576, maxTokens: 65_536 },
    { id: "gemini-3.7-flash-medium", contextWindow: 1_048_576, maxTokens: 65_536 },
  ]);
  assert.equal(catalog.source, "official_antigravity_cli+model_registry");
});

test("Antigravity prompt keeps the newest messages inside returned model capacity", () => {
  const prompt = antigravityRequestPrompt({
    modelContext: { contextWindow: 16, maxTokens: 1 },
    messages: [
      { role: "user", content: "old ".repeat(100) },
      { role: "assistant", content: "previous answer" },
      { role: "user", content: "new" },
    ],
  });
  assert.equal(prompt.includes("old ".repeat(10)), false);
  assert.equal(prompt.includes("new"), true);
});

test("Antigravity executor calls the official CLI with the selected model and effort", async () => {
  let command;
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    env: { PATH: "/provider/bin" },
    streamCommandRunner: async function* (path, args, options) {
      command = { path, args, options };
      yield JSON.stringify({ event: "content_block_delta", delta: { text_delta: "provider" } });
      yield JSON.stringify({ event: "content_block_delta", delta: { text_delta: " response" } });
      yield JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "provider response",
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      });
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      reasoningEffort: "medium",
      system: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(command.args.slice(-9), ["--model", "gemini-live-medium", "--effort", "medium", "--sandbox", "--print-timeout", "900s", "--output-format", "stream-json"]);
  assert.equal(command.args[0], "-p");
  assert.match(command.args[1], /system:\nBe concise\./);
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: "provider" },
    { type: "text-delta", index: 0, text: " response" },
    { type: "block-end", index: 0, block: { type: "text", text: "provider response" } },
    { type: "usage", usage: { inputTokens: 3, outputTokens: 2 } },
    { type: "finish", reason: { kind: "stop" } },
  ]);
});

test("Antigravity keeps the argv prompt while it fits the kernel budget", () => {
  const invocation = antigravityPromptInvocation("system:\nbe brief");
  assert.deepEqual(invocation.args, ["-p", "system:\nbe brief"]);
  assert.equal(invocation.stdin, null);
});

test("Antigravity measures the prompt budget in bytes, not characters", () => {
  // 40k CJK characters are ~120KB on the wire: under the character count, but
  // well past the 64 KiB argv budget, so it must use the stdin transport.
  const cjk = "汉".repeat(40_000);
  const invocation = antigravityPromptInvocation(cjk);
  assert.deepEqual(invocation.args, ["--input-format", "stream-json"]);
  const payload = JSON.parse(invocation.stdin);
  assert.equal(payload.event, "user");
  assert.equal(payload.message.role, "user");
  // agy's stream decoder requires message.content as a plain string; a
  // content-parts array decodes to an empty prompt and the CLI hangs forever.
  assert.equal(payload.message.content, cjk);
});

test("Antigravity moves an oversized prompt off argv onto stdin", () => {
  const prompt = `system:\n${"x".repeat(200_000)}`;
  const invocation = antigravityPromptInvocation(prompt);
  assert.deepEqual(invocation.args, ["--input-format", "stream-json"]);
  // Nothing resembling the conversation may stay in argv: that is what the
  // kernel rejects with E2BIG before the CLI can even start.
  assert.ok(invocation.args.every((arg) => arg.length < 64));
  assert.ok(invocation.stdin.endsWith("\n"));
  const payload = JSON.parse(invocation.stdin);
  assert.equal(payload.event, "user");
  assert.equal(typeof payload.message.content, "string");
  assert.equal(payload.message.content, prompt);
});

test("Antigravity executor hands an oversized prompt to the CLI runner as stdin", async () => {
  let command;
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (path, args, options) {
      command = { path, args, options };
      yield JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "ok", usage: { input_tokens: 1, output_tokens: 1 } },
      });
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      system: "s".repeat(300_000),
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
  });
  for await (const _chunk of stream) { /* drain */ }
  assert.deepEqual(command.args.slice(0, 2), ["--input-format", "stream-json"]);
  assert.equal(command.args.includes("-p"), false);
  assert.ok(command.args.every((arg) => arg.length < 64));
  const payload = JSON.parse(command.options.stdin);
  assert.match(payload.message.content, /^system:\ns{300000}/);
  assert.equal(typeof payload.message.content, "string");
});

test("Antigravity executor delivered a >ARG_MAX prompt through real CLI stdin", {
  // The fixture is a POSIX shell script: the negative control relies on
  // execve-level argv limits that Windows does not express the same way.
  skip: process.platform === "win32" ? "POSIX shell fixture" : false,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-e2big-"));
  try {
    const capturePath = join(dir, "input.ndjson");
    const argvPath = join(dir, "argv.txt");
    const scriptPath = join(dir, "fake-agy.sh");
    await writeFile(scriptPath, [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${JSON.stringify(argvPath)}`,
      `cat > ${JSON.stringify(capturePath)}`,
      `printf '{"event":"result","result":{"status":"SUCCESS","response":"received %s bytes","usage":{"input_tokens":1,"output_tokens":1}}}\\n' "$(wc -c < ${JSON.stringify(capturePath)} | tr -d ' ')"`,
      "",
    ].join("\n"), { mode: 0o755 });

    const request = {
      model: "gemini-live-medium",
      system: "x".repeat(1_500_000),
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    };
    const prompt = antigravityRequestPrompt(request);
    // Negative control: the pre-fix `-p <prompt>` transport cannot even exec.
    const argvFailure = spawnSync(scriptPath, ["-p", prompt]);
    assert.equal(argvFailure.error?.code, "E2BIG");

    const executor = createAntigravityCliExecutor({ cliPath: scriptPath, env: process.env });
    const stream = await executor({ request });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);

    const argvLines = (await readFile(argvPath, "utf8")).split("\n").filter(Boolean);
    assert.ok(argvLines.includes("--input-format"));
    assert.equal(argvLines.includes("-p"), false);
    assert.ok(argvLines.every((line) => line.length < 128));

    const raw = await readFile(capturePath, "utf8");
    const delivered = JSON.parse(raw);
    assert.equal(delivered.event, "user");
    assert.equal(typeof delivered.message.content, "string");
    assert.equal(delivered.message.content, prompt);

    const text = chunks.find((chunk) => chunk.type === "text-delta")?.text ?? "";
    assert.equal(text, `received ${Buffer.byteLength(raw, "utf8")} bytes`);
    assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "stop" } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Antigravity maps a native run_command event into DSH bash", async () => {
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "pwd", Cwd: "/tmp" } },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "bash", description: "Execute bash", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "check" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "block-end", index: 0, block: { type: "text", text: "" } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    {
      type: "block-end",
      index: 1,
      block: {
        type: "tool-call",
        id: chunks[3].block.id,
        name: "bash",
        arguments: JSON.stringify({ command: "pwd", description: "运行：pwd", workdir: "/tmp" }),
      },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
});

test("Antigravity maps the CLI read_url_content tool into DSH web_fetch", async () => {
  // Payload copied from a real `agy --output-format stream-json` run: the CLI
  // asks to read a URL, print mode cannot prompt, and the tool is auto-denied
  // unless the intent is forwarded to a DSH tool first.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => false,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "read_url_content",
          tool_info: { name: "read_url_content", parameters: { Url: "https://moiraism.org" } },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "web_fetch", description: "Fetch a URL", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "check my site" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "block-end", index: 0, block: { type: "text", text: "" } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    {
      type: "block-end",
      index: 1,
      block: {
        type: "tool-call",
        id: chunks[3].block.id,
        name: "web_fetch",
        arguments: JSON.stringify({ url: "https://moiraism.org" }),
      },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
});

test("Antigravity maps the CLI's read_url spelling into DSH web_fetch", async () => {
  // Same capability as read_url_content, different name in the CLI payload;
  // reproduced from a real denial (`user denied permission for read_url
  // "design.momotoken.win"`). Before the alias existed the name matched neither
  // the request's tools nor the translation map, so no tool-call was emitted and
  // the anchored turn ended empty — then got retried twice as a deterministic
  // failure.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => false,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "read_url",
          tool_info: {
            name: "read_url",
            parameters: { url: "https://design.momotoken.win/#video" },
          },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "web_fetch", description: "Fetch a URL", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "look at my site" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "block-end", index: 0, block: { type: "text", text: "" } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    {
      type: "block-end",
      index: 1,
      block: {
        type: "tool-call",
        id: chunks[3].block.id,
        name: "web_fetch",
        arguments: JSON.stringify({ url: "https://design.momotoken.win/#video" }),
      },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
});

test("Antigravity accepts a capitalized Url parameter on the read_url spelling", async () => {
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => false,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "read_url",
          tool_info: { name: "read_url", parameters: { Url: "https://moiraism.org" } },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "web_fetch", description: "Fetch a URL", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "check my site" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "block-end", index: 0, block: { type: "text", text: "" } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    {
      type: "block-end",
      index: 1,
      block: {
        type: "tool-call",
        id: chunks[3].block.id,
        name: "web_fetch",
        arguments: JSON.stringify({ url: "https://moiraism.org" }),
      },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
});

test("Antigravity does not forward an unmapped CLI tool through a read alias", async () => {
  // Aliasing must not widen: a name whose canonical form is unmapped stays
  // unmapped. `write_file` is deliberately not translated (the CLI is expected
  // to hold the file grant), so it must not be smuggled into `web_fetch`-like
  // forwarding — the turn keeps the existing silent-run behaviour instead.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => false,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "write_file",
          tool_info: { name: "write_file", parameters: { path: "/tmp/x.txt" } },
        },
      });
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", text: "done" } });
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "web_fetch", description: "Fetch a URL", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
    },
  });
  await assert.rejects(async () => {
    for await (const _chunk of stream) { /* drain */ }
  }, (error) => error.code === "ANTIGRAVITY_CLI_NO_OUTPUT");
});

test("Antigravity maps the CLI's CamelCase ReadUrlContent spelling into DSH web_fetch", async () => {
  // The spelling that actually reaches the driver in the wild: the CLI's own
  // permission log and generic step confirmation say
  // `soft-denying tool confirmation "ReadUrlContent"` (agy 1.2.3). The
  // translation table is snake_case, so a case-sensitive lookup returned null,
  // emitted no tool-call, and left the turn empty — every page read then cost
  // one empty anchored run plus two retries before degrading.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => false,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "ReadUrlContent",
          tool_info: { name: "ReadUrlContent", parameters: { Url: "https://design.momotoken.win/" } },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "web_fetch", description: "Fetch a URL", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "look at my site" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "block-end", index: 0, block: { type: "text", text: "" } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    {
      type: "block-end",
      index: 1,
      block: {
        type: "tool-call",
        id: chunks[3].block.id,
        name: "web_fetch",
        arguments: JSON.stringify({ url: "https://design.momotoken.win/" }),
      },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
});

test("Antigravity normalizes CamelCase CLI names for the other translated tools too", async () => {
  for (const [cliName, target, parameters, expected] of [
    ["RunCommand", "bash", { command: "ls -la" }, { command: "ls -la" }],
    ["SearchWeb", "web_search", { query: "momotoken" }, { queries: ["momotoken"] }],
  ]) {
    const executor = createAntigravityCliExecutor({
      cliPath: "agy-test",
      detectFakeIp: async () => false,
      streamCommandRunner: async function* () {
        yield JSON.stringify({
          event: "step_update",
          step_update: {
            state: "ACTIVE",
            step_type: "tool",
            tool_name: cliName,
            tool_info: { name: cliName, parameters },
          },
        });
        throw new Error("the bridge should stop after forwarding the tool call");
      },
    });
    const stream = await executor({
      request: {
        model: "gemini-live-medium",
        tools: [{ name: target, description: "", parameters: {} }],
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      },
    });
    const calls = [];
    try {
      for await (const chunk of stream) {
        if (chunk.block?.type === "tool-call") calls.push(chunk.block);
      }
    } catch { /* forwarding throws by design in this harness */ }
    assert.equal(calls.length, 1, `${cliName} should forward exactly one tool call`);
    assert.equal(calls[0].name, target);
    const forwarded = JSON.parse(calls[0].arguments);
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(forwarded[key], value);
  }
});

test("Antigravity still forwards a request-declared tool name unchanged", async () => {
  // Guard against over-normalizing: the raw name keeps winning the exact match,
  // so a request that declares a tool in the CLI's casing is untouched.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => false,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "bash",
          tool_info: { name: "bash", parameters: { command: "echo hi" } },
        },
      });
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", text: "done" } });
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "bash", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    },
  });
  const calls = [];
  try {
    for await (const chunk of stream) {
      if (chunk.block?.type === "tool-call") calls.push(chunk.block);
    }
  } catch { /* silent-run guard */ }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "bash");
  assert.deepEqual(JSON.parse(calls[0].arguments).command, "echo hi");
});

test("Antigravity reads URLs through curl when the proxy answers DNS with fake IPs", async () => {
  // A TUN proxy in fake-IP mode resolves every hostname to 198.18.0.0/15, which
  // DSH's guarded web_fetch rejects before connecting. The connection itself is
  // fine, so the URL read is routed through the request's own bash tool.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => true,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "read_url_content",
          tool_info: { name: "read_url_content", parameters: { Url: "https://moiraism.org/" } },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "bash" }, { name: "web_fetch" }],
      messages: [{ role: "user", content: [{ type: "text", text: "check my site" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const call = chunks.find((chunk) => chunk.type === "block-end" && chunk.block?.type === "tool-call").block;
  assert.equal(call.name, "bash");
  const parsed = JSON.parse(call.arguments);
  // Transient TLS resets through a TUN proxy are retried, and the extractor runs
  // Node (always present beside this plugin) with a sed-only fallback.
  assert.match(parsed.command, /^curl -sSL --retry 2 --retry-connrefused --retry-delay 1 --max-time 30 --max-filesize 5000000 -- 'https:\/\/moiraism\.org\/'/);
  assert.match(parsed.command, /command -v node >\/dev\/null 2>&1; then node -e '/);
  assert.match(parsed.command, /else sed -e 's\/<\[\^>\]\*>\//);
  assert.equal(parsed.description, "Fetch https://moiraism.org/ through the local network stack");
});

test("Antigravity reuses an already fetched URL instead of fetching it again", async () => {
  const command = "curl -sSL --max-time 30 --max-filesize 5000000 -- 'https://moiraism.org/'";
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => true,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "read_url_content",
          tool_info: { name: "read_url_content", parameters: { Url: "https://moiraism.org/" } },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const history = [
    { role: "user", content: [{ type: "text", text: "check my site" }] },
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        id: "agy-fetch-1",
        name: "bash",
        arguments: JSON.stringify({ command, description: "Fetch https://moiraism.org/ through the local network stack" }),
      }],
    },
    {
      role: "user",
      content: [{ type: "tool-result", toolCallId: "agy-fetch-1", content: [{ type: "text", text: "MOIRAISM 首页正文 ".repeat(30) }] }],
    },
  ];
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "bash" }, { name: "web_fetch" }],
      messages: history,
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const call = chunks.find((chunk) => chunk.type === "block-end" && chunk.block?.type === "tool-call").block;
  const parsed = JSON.parse(call.arguments);
  assert.match(parsed.description, /^Reuse the fetched content of https:\/\/moiraism\.org\//);
  assert.match(parsed.command, /^echo '/);
  assert.equal(/curl /.test(parsed.command), false, "a successful fetch must not be repeated");
});

test("Antigravity still fetches when the previous attempt failed", async () => {
  const command = "curl -sSL --max-time 30 --max-filesize 5000000 -- 'https://moiraism.org/'";
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => true,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "read_url_content",
          tool_info: { name: "read_url_content", parameters: { Url: "https://moiraism.org/" } },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const history = [
    { role: "user", content: [{ type: "text", text: "check my site" }] },
    {
      role: "assistant",
      content: [{
        type: "tool-call",
        id: "agy-fetch-1",
        name: "bash",
        arguments: JSON.stringify({ command, description: "Fetch https://moiraism.org/ through the local network stack" }),
      }],
    },
    {
      role: "user",
      content: [{
        type: "tool-result",
        toolCallId: "agy-fetch-1",
        content: [{ type: "text", text: "[stderr]\ncurl: (35) LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to moiraism.org:443 \n" }],
      }],
    },
  ];
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "bash" }, { name: "web_fetch" }],
      messages: history,
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const call = chunks.find((chunk) => chunk.type === "block-end" && chunk.block?.type === "tool-call").block;
  const parsed = JSON.parse(call.arguments);
  assert.match(parsed.description, /^Fetch https:\/\/moiraism\.org\//);
  assert.match(parsed.command, /^curl -sSL /);
});

test("Antigravity escapes quotes in the local fetch command", async () => {
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    detectFakeIp: async () => true,
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "read_url_content",
          tool_info: { name: "read_url_content", parameters: { Url: "https://example.test/?q=it's; rm -rf /" } },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "bash" }, { name: "web_fetch" }],
      messages: [{ role: "user", content: [{ type: "text", text: "check" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const call = chunks.find((chunk) => chunk.type === "block-end" && chunk.block?.type === "tool-call").block;
  const command = JSON.parse(call.arguments).command;
  // The whole URL stays inside one single-quoted shell word: no command runs.
  assert.ok(command.includes(`'https://example.test/?q=it'\\''s; rm -rf /'`), command);
});

test("detectFakeIpEnvironment recognizes a virtualized resolver", async () => {
  const fake = async () => [{ address: "198.19.0.33", family: 4 }];
  const publicOnly = async () => [{ address: "93.184.216.34", family: 4 }];
  const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "198.19.0.33", family: 4 }];
  const failing = async () => {
    throw new Error("no dns");
  };
  assert.equal(await detectFakeIpEnvironment({ resolver: fake, useCache: false, host: "probe-fake.test" }), true);
  assert.equal(await detectFakeIpEnvironment({ resolver: async () => [{ address: "10.0.0.1", family: 4 }], useCache: false, host: "probe-private.test" }), true);
  assert.equal(await detectFakeIpEnvironment({ resolver: publicOnly, useCache: false, host: "probe-public.test" }), false);
  assert.equal(await detectFakeIpEnvironment({ resolver: mixed, useCache: false, host: "probe-mixed.test" }), false);
  assert.equal(await detectFakeIpEnvironment({ resolver: failing, useCache: false, host: "probe-error.test" }), false);
});

test("Antigravity maps the CLI search_web tool into DSH web_search", async () => {
  // Payload copied from a real `agy --output-format stream-json` run: the CLI
  // searches with a single `query` string, while DSH's web_search requires
  // `queries: [...]`.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "search_web",
          tool_info: { name: "search_web", parameters: { query: "site:moiraism.org" } },
        },
      });
      throw new Error("the bridge should stop after forwarding the tool call");
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "web_search", description: "Search the web", parameters: {} }],
      messages: [{ role: "user", content: [{ type: "text", text: "check my site" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(chunks, [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "block-end", index: 0, block: { type: "text", text: "" } },
    { type: "block-start", index: 1, blockType: "tool-call" },
    {
      type: "block-end",
      index: 1,
      block: {
        type: "tool-call",
        id: chunks[3].block.id,
        name: "web_search",
        arguments: JSON.stringify({ queries: ["site:moiraism.org"] }),
      },
    },
    { type: "finish", reason: { kind: "tool-calls" } },
  ]);
});

test("Antigravity reports an auto-denied CLI tool instead of an empty response", async () => {
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (_path, _args, options) {
      options?.onStderr?.(
        "jetski: no output produced — a tool required the \"read_url\" permission that headless mode cannot prompt for, so it was auto-denied.",
      );
      yield JSON.stringify({
        event: "step_update",
        step_update: { state: "DONE", step_type: "agent_response" },
      });
      yield JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: "", denied_actions: [{ action: "read_url" }] },
      });
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      messages: [{ role: "user", content: [{ type: "text", text: "check my site" }] }],
    },
  });
  await assert.rejects(
    async () => {
      for await (const _chunk of stream) {
        // Drain until the executor reports the diagnosis.
      }
    },
    (error) => error.code === "ANTIGRAVITY_CLI_NO_OUTPUT" && /read_url/.test(error.message),
  );
});

test("Antigravity replays a tool round trip with the command and its call id", () => {
  // Regression: the transcript once rendered tool-call arguments as
  // "[object Object]" and dropped the call id from tool results, so the model
  // could not tell which command had already run and re-issued it every turn.
  const prompt = antigravityRequestPrompt({
    system: "Be concise.",
    messages: [
      { role: "user", content: [{ type: "text", text: "run pwd" }] },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          id: "call_abc123",
          name: "bash",
          arguments: { command: "pwd", description: "Print the working directory" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "call_abc123",
          content: [{ type: "text", text: "/Users/xzb" }],
        }],
      },
    ],
  });
  assert.ok(!prompt.includes("[object Object]"), prompt);
  assert.match(prompt, /\[tool call: bash id=call_abc123] \{"command":"pwd"/);
  assert.match(prompt, /\[tool result for id=call_abc123]\n\/Users\/xzb/);
});

test("Antigravity prompt carries convergence rules for the stateless CLI turn", () => {
  // Regression: the CLI is spawned once per turn with the whole transcript
  // flattened into one prompt, so the model treated its own past tool calls as
  // reference material — re-running similar commands every turn with zero
  // prose and never converging on a final answer.
  const prompt = antigravityRequestPrompt({
    system: "Be concise.",
    messages: [{ role: "user", content: [{ type: "text", text: "run pwd" }] }],
  });
  assert.match(prompt, /不要重复执行相同或相似的命令/);
  assert.match(prompt, /绝对不要在回复文本里书写工具调用/);
  assert.match(prompt, /必须直接输出最终结论，禁止再发起任何工具调用/);
  assert.match(prompt, /先用一句话向用户说明你要做什么/);
  // The rules must not disturb the caller's system section.
  assert.match(prompt, /system:\nBe concise\./);
});

test("Antigravity reports a silent empty run instead of an empty response", async () => {
  // Regression: an empty turn used to end in an empty text block, which the
  // route classified as EMPTY_RESPONSE and replayed five times — six agy
  // processes and six full prompts for a turn that produced nothing.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: { state: "DONE", step_type: "agent_response", usage: { input_tokens: 12, output_tokens: 3 } },
      });
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } });
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    },
  });
  await assert.rejects(
    async () => {
      for await (const _chunk of stream) {
        // The executor must fail the turn, never emit a bare empty message.
      }
    },
    (error) => error.code === "ANTIGRAVITY_CLI_NO_OUTPUT"
      && /没有产生任何可见文本/.test(error.message)
      && /result\.status=SUCCESS/.test(error.message),
  );
});

test("Antigravity harvests a permission denial reported as a tool step error", async () => {
  // Newer CLI builds no longer fill `result.denied_actions`; the denial only
  // appears as a step_update ERROR, which the old guard ignored. The CLI names
  // the exact missing grant, and that path is what tells the user which
  // allow-rule to add (a bare tool name is not actionable).
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ERROR",
          step_index: 2,
          step_type: "tool",
          tool_name: "write_to_file",
          tool_info: {
            name: "write_to_file",
            parameters: { TargetFile: "/tmp/x.txt" },
            error: { type: "TOOL_ERROR", message: 'permission check failed for write_file "/tmp/x.txt": user denied permission for write_file(/private/tmp/x.txt)' },
          },
        },
      });
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } });
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      messages: [{ role: "user", content: [{ type: "text", text: "write a file" }] }],
    },
  });
  await assert.rejects(
    async () => {
      for await (const _chunk of stream) {
        // Drain until the denial diagnosis is raised.
      }
    },
    (error) => error.code === "ANTIGRAVITY_CLI_NO_OUTPUT"
      && /write_file\(\/private\/tmp\/x\.txt\)/.test(error.message),
  );
});

test("Antigravity reports each step's tokens on a tool-call turn", async () => {
  // Tool turns return before the cumulative `result` event, so the usage of the
  // steps already executed must be summed and emitted with the tool call.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "DONE",
          step_type: "agent_response",
          usage: { input_tokens: 100, output_tokens: 10, thinking_tokens: 5, cache_read_tokens: 20 },
        },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: {
          state: "ACTIVE",
          step_type: "tool",
          tool_name: "run_command",
          tool_info: { parameters: { CommandLine: "pwd" } },
        },
      });
    },
  });
  const stream = await executor({
    request: {
      model: "gemini-live-medium",
      tools: [{ name: "bash" }],
      messages: [{ role: "user", content: [{ type: "text", text: "check" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.deepEqual(chunks.at(-2), {
    type: "usage",
    usage: { inputTokens: 100, outputTokens: 10, reasoningTokens: 5, cacheReadTokens: 20 },
  });
  assert.deepEqual(chunks.at(-1), { type: "finish", reason: { kind: "tool-calls" } });
});

test("Antigravity fails a timed-out turn even when the CLI exits cleanly", {
  // The fixture is a POSIX shell script spawned without an extension, which
  // Windows cannot exec (spawn ENOENT).
  skip: process.platform === "win32" ? "POSIX shell fixture" : false,
}, async () => {
  // Regression: agy exits 0 after SIGTERM, so a killed turn used to look like a
  // completed empty response; the timeout must be checked before the exit code.
  const dir = await mkdtemp(join(tmpdir(), "agy-timeout-"));
  try {
    const scriptPath = join(dir, "agy");
    await writeFile(scriptPath, [
      "#!/bin/sh",
      // Exit 0 on SIGTERM like the real CLI, but take the sleeping child with
      // us so the stdout pipe closes and the test does not wait it out.
      "trap 'kill \"$child\" 2>/dev/null; exit 0' TERM",
      `printf '%s\\n' '{"event":"step_update","step_update":{"state":"DONE","step_type":"agent_response"}}'`,
      "sleep 30 &",
      "child=$!",
      "wait \"$child\"",
      "",
    ].join("\n"), { mode: 0o755 });

    const executor = createAntigravityCliExecutor({ cliPath: scriptPath, env: process.env, timeoutMs: 400 });
    const stream = await executor({
      request: {
        model: "gemini-live-medium",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      },
    });
    await assert.rejects(
      async () => {
        for await (const _chunk of stream) {
          // The turn must end in a timeout failure, not an empty success.
        }
      },
      (error) => error.code === "TIMEOUT" && /timed out after 400ms/.test(error.message),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Antigravity maps a selected effort to the exact returned model row", async () => {
  const catalogLoader = async () => ({
    models: [
      {
        id: "gemini-live-high",
        name: "Gemini Live (High)",
        reasoning: { efforts: [{ id: "high", name: "High" }, { id: "medium", name: "Medium" }], defaultEffort: "high" },
      },
      {
        id: "gemini-live-medium",
        name: "Gemini Live (Medium)",
        reasoning: { efforts: [{ id: "high", name: "High" }, { id: "medium", name: "Medium" }], defaultEffort: "medium" },
      },
    ],
  });
  assert.deepEqual(await resolveAntigravityInvocationModel({
    catalogLoader,
    model: "gemini-live-medium",
    reasoningEffort: "high",
  }), { model: "gemini-live-high", reasoningEffort: undefined });
  assert.deepEqual(await resolveAntigravityNativeInvocationModel({
    catalogLoader,
    model: "gemini-live-medium",
    reasoningEffort: "medium",
  }), { model: "gemini-live-medium", reasoningEffort: "medium" });

  let calls = 0;
  const cachedLoader = createAntigravityCatalogLoader({
    cacheFilePath: null,
    cacheTtlMs: 60_000,
    commandRunner: async () => {
      calls += 1;
      return { output: "live-model\tLive model\n", errorOutput: "" };
    },
  });
  await cachedLoader();
  await cachedLoader();
  assert.equal(calls, 1);
});

test("Antigravity catalog persists an account-scoped last-known result", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockyard-antigravity-catalog-"));
  const cacheFilePath = join(home, "catalog.json");
  const accounts = [{ accountId: "antigravity-account-a" }];
  try {
    const first = createAntigravityCatalogLoader({
      cacheFilePath,
      commandRunner: async () => ({ output: "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n" }),
      registryLoader: async () => [],
    });
    const live = await first({ force: true, accounts });
    assert.equal(live.models[0].contextWindow, 1_048_576);

    const rawCache = await readFile(cacheFilePath, "utf8");
    assert.equal(rawCache.includes("antigravity-account-a"), false);

    let refreshCalls = 0;
    const restoredLoader = createAntigravityCatalogLoader({
      cacheFilePath,
      commandRunner: async () => {
        refreshCalls += 1;
        return { output: "gemini-3.7-flash-high\tGemini 3.7 Flash (High)\ngemini-3.7-flash-medium\tGemini 3.7 Flash (Medium)\n" };
      },
      registryLoader: async () => [],
    });
    const restored = await restoredLoader({ accounts });
    assert.deepEqual(restored.models.map((model) => model.id), [
      "gemini-3.7-flash-high",
      "gemini-3.7-flash-medium",
    ]);
    assert.match(restored.source, /persistent_cache/);
    assert.equal(refreshCalls, 1);
    // The cached-catalog path refreshes in the background without awaiting
    // the persisted write. Settle it before removing the temp directory so
    // the cleanup cannot race the catalog.json write (ENOTEMPTY flake).
    await first.whenIdle();
    await restoredLoader.whenIdle();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Grok imports every OAuth account in a provider source without exposing tokens", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockyard-grok-"));
  try {
    const raw = {
      "https://auth.x.ai::account-a": {
        key: "access-a",
        refresh_token: "refresh-a",
        user_id: "grok-account-a",
        email: "a@example.test",
        first_name: "Account A",
        expires_at: "2026-08-15T12:00:00.000Z",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "client-a",
      },
      "https://auth.x.ai::account-b": {
        key: "access-b",
        refresh_token: "refresh-b",
        user_id: "grok-account-b",
        email: "b@example.test",
        expires_at: "2026-08-15T12:00:00.000Z",
        oidc_issuer: "https://auth.x.ai",
        oidc_client_id: "client-b",
      },
    };
    assert.deepEqual(parseGrokAuth(raw).map(({ access: _access, refresh: _refresh, ...value }) => value), [
      {
        accountId: "grok-account-a",
        email: "a@example.test",
        displayName: "Account A",
        plan: null,
        expiresAt: "2026-08-15T12:00:00.000Z",
        createdAt: null,
        scopes: [],
        issuer: "https://auth.x.ai",
        clientId: "client-a",
        authMode: null,
        scopeKey: "https://auth.x.ai::account-a",
      },
      {
        accountId: "grok-account-b",
        email: "b@example.test",
        displayName: "b@example.test",
        plan: null,
        expiresAt: "2026-08-15T12:00:00.000Z",
        createdAt: null,
        scopes: [],
        issuer: "https://auth.x.ai",
        clientId: "client-b",
        authMode: null,
        scopeKey: "https://auth.x.ai::account-b",
      },
    ]);
    const driver = createGrokDriver({
      authFilePath: join(home, "auth.json"),
      grokHome: home,
      catalogLoader: async () => ({ models: [] }),
    });
    const secretStore = new MemorySecretStore();
    const imported = await driver.importSource({ content: JSON.stringify(raw), fileName: "auth.json" }, { secretStore });
    assert.deepEqual(imported.map((account) => account.accountId), ["grok-account-a", "grok-account-b"]);
    assert.equal(imported[0].auth.credentialRef, undefined);
    assert.equal((await secretStore.read(imported[0].credentialRef)).access, "access-a");
    assert.equal((await secretStore.read(imported[0].credentialRef)).email, "a@example.test");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Grok quota reads the official credits config and weekly period", async () => {
  const secretStore = new MemorySecretStore();
  const credentialRef = "keychain://grok/credits";
  await secretStore.write(credentialRef, { access: "grok-access", accountId: "grok-account" });
  let call = null;
  const driver = createGrokDriver({
    catalogLoader: async () => ({ models: [] }),
    creditsUrl: "https://grok.test/v1/billing?format=credits",
    clientVersion: "0.2.test",
    fetchImpl: async (url, init) => {
      call = { url, init };
      return response(200, {
        config: {
          creditUsagePercent: 42.5,
          currentPeriod: {
            type: "USAGE_PERIOD_TYPE_WEEKLY",
            start: "2026-08-15T22:06:42.000Z",
            end: "2026-08-22T22:06:42.000Z",
          },
        },
      });
    },
  });
  const quota = await driver.getQuota({
    accountId: "grok-account",
    auth: { credentialRef },
    subscription: { plan: null },
  }, { secretStore, now: new Date("2026-08-16T12:00:00.000Z") });
  assert.equal(call.url, "https://grok.test/v1/billing?format=credits");
  assert.equal(call.init.headers.authorization, "Bearer grok-access");
  assert.equal(call.init.headers["x-xai-token-auth"], "xai-grok-cli");
  assert.equal(call.init.headers["x-userid"], "grok-account");
  assert.equal(call.init.headers["x-grok-client-version"], "0.2.test");
  assert.equal(quota.quota.remaining, 57.5);
  assert.equal(quota.quota.limit, 100);
  assert.equal(quota.quota.unit, "percent");
  assert.equal(quota.quota.resetAt, "2026-08-22T22:06:42.000Z");
  assert.equal(quota.quota.windows[0].name, "官方周额度周期");
  assert.equal(quota.resources.quotaDiagnostic, null);
  assert.equal(quota.resources.quotaUrl, "https://grok.com/?_s=usage");
});

test("Grok credits parser keeps an official period when remaining usage is omitted", () => {
  const parsed = parseGrokCreditsConfig({
    config: {
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-08-15T22:06:42.000Z",
        end: "2026-08-22T22:06:42.000Z",
      },
      prepaidBalance: { val: 0 },
    },
  }, { now: new Date("2026-08-16T12:00:00.000Z") });
  assert.equal(parsed.quota.remaining, null);
  assert.equal(parsed.quota.windows.length, 1);
  assert.equal(parsed.quota.windows[0].resetAt, "2026-08-22T22:06:42.000Z");
  assert.match(parsed.resources.quotaDiagnostic, /未返回剩余百分比/);
});

test("Grok credits authorization failures remain quota errors", async () => {
  const secretStore = new MemorySecretStore();
  const credentialRef = "keychain://grok/quota-401";
  await secretStore.write(credentialRef, { access: "grok-access", accountId: "grok-account", email: "grok@example.test" });
  const driver = createGrokDriver({
    catalogLoader: async () => ({ models: [] }),
    creditsUrl: "https://grok.test/v1/billing?format=credits",
    fetchImpl: async () => response(401, {}),
  });
  await assert.rejects(
    () => driver.getQuota({
      providerId: "grok",
      accountId: "grok-account",
      email: "grok@example.test",
      auth: { credentialRef },
    }, { secretStore }),
    (error) => error.quotaUnavailable === true && error.authExpired !== true,
  );
});

test("Grok model metadata comes from the provider cache, including returned reasoning tiers", () => {
  assert.deepEqual(parseGrokModelCatalog("", {
    models: {
      "grok-live": {
        info: {
          model: "grok-live",
          name: "Grok Live",
          context_window: 123456,
          reasoning_effort: "high",
          reasoning_efforts: [
            { id: "low", value: "low", label: "Low Effort" },
            { id: "high", value: "high", label: "High Effort", description: "provider returned", default: true },
          ],
        },
      },
    },
  }), [{
    id: "grok-live",
    name: "Grok Live",
    reasoning: {
      efforts: [
        { id: "low", name: "Low Effort" },
        { id: "high", name: "High Effort", description: "provider returned" },
      ],
      defaultEffort: "high",
    },
    contextWindow: 123456,
  }]);
});

test("Grok catalog loader caches a local provider response", async () => {
  let reads = 0;
  const loader = createGrokCatalogLoader({
    grokHome: "/provider/grok",
    readJson: async (path) => {
      reads += 1;
      assert.match(path, /models_cache\.json$/);
      return { models: { "grok-live": { info: { model: "grok-live" } } } };
    },
    cacheTtlMs: 60_000,
  });
  const first = await loader();
  const second = await loader();
  assert.deepEqual(first.models, [{ id: "grok-live", name: "grok-live" }]);
  assert.strictEqual(first, second);
  assert.equal(reads, 1);
  const forced = await loader({ force: true });
  assert.equal(reads, 2);
  assert.deepEqual(forced.models, [{ id: "grok-live", name: "grok-live" }]);
});

test("Grok catalog loader force refresh does not join an in-flight request", async () => {
  let calls = 0;
  let releaseFirst;
  let enteredFirst;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const loader = createGrokCatalogLoader({
    grokHome: "/provider/grok",
    readJson: async () => {
      const call = ++calls;
      if (call === 1) {
        enteredFirst();
        await firstStarted;
      }
      return { models: { [`grok-${call}`]: { info: { model: `grok-${call}` } } } };
    },
    cacheTtlMs: 60_000,
  });
  const firstPromise = loader();
  await firstEntered;
  const forced = await loader({ force: true });
  releaseFirst();
  const first = await firstPromise;
  assert.equal(calls, 2);
  assert.deepEqual(forced.models, [{ id: "grok-2", name: "grok-2" }]);
  assert.deepEqual(first.models, [{ id: "grok-1", name: "grok-1" }]);
});

test("Grok catalog loader returns persisted models before a slow CLI refresh", async () => {
  let refreshStarted = false;
  let releaseRefresh;
  const refresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const loader = createGrokCatalogLoader({
    grokHome: "/provider/grok",
    readJson: async () => ({ models: { "grok-live": { info: { model: "grok-live" } } } }),
    commandRunner: async () => {
      refreshStarted = true;
      await refresh;
      return { output: "" };
    },
  });
  const result = await loader();
  assert.deepEqual(result.models, [{ id: "grok-live", name: "grok-live" }]);
  assert.equal(result.source, "official_grok_local_cache");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(refreshStarted, true);
  releaseRefresh();
});

test("Grok catalog loader falls back to the DSH registry when the official CLI is unavailable", async () => {
  const cliCalls = [];
  const loader = createGrokCatalogLoader({
    grokHome: "/provider/grok",
    readJson: async () => null,
    commandRunner: async (command, args) => {
      cliCalls.push([command, args]);
      const error = new Error("spawn grok ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    registryLoader: async () => [
      {
        id: "grok-4.5",
        name: "Grok 4.5",
        api: "openai-responses",
        provider: "xai",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 500_000,
        maxTokens: 30_000,
        thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
      },
      { id: "unrelated", provider: "other" },
    ],
  });
  // The browser-OAuth-only install never has a model cache and never has the
  // official CLI; the provider must still publish a selectable catalog.
  assert.deepEqual(await loader(), {
    models: [{
      id: "grok-4.5",
      name: "Grok 4.5",
      inputModalities: ["text", "image"],
      contextWindow: 500_000,
      maxTokens: 30_000,
      reasoning: {
        efforts: [
          { id: "low", name: "Low" },
          { id: "medium", name: "Medium" },
          { id: "high", name: "High" },
        ],
      },
    }],
    source: "dsh_live_provider_registry",
  });
  assert.deepEqual(cliCalls, [["grok", ["models"]]]);
});

test("Grok catalog loader keeps the CLI diagnostic when no source yields models", async () => {
  const loader = createGrokCatalogLoader({
    grokHome: "/provider/grok",
    readJson: async () => null,
    commandRunner: async () => {
      const error = new Error("spawn grok ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    registryLoader: async () => [{ id: "unrelated", provider: "other" }],
  });
  const result = await loader();
  assert.deepEqual(result.models, []);
  assert.equal(result.source, "official_grok_cli");
  assert.deepEqual(result.diagnostics, ["Grok 官方模型目录读取失败：spawn grok ENOENT"]);
});

test("Grok catalog loader prefers live CLI models over the registry", async () => {
  let registryCalls = 0;
  const loader = createGrokCatalogLoader({
    grokHome: "/provider/grok",
    readJson: async () => null,
    commandRunner: async () => ({ output: "Available models:\n  * grok-4.6 (default)\n  - grok-4.7\n" }),
    registryLoader: async () => {
      registryCalls += 1;
      return [{ id: "grok-4.5", name: "Grok 4.5", provider: "xai" }];
    },
  });
  const result = await loader();
  assert.deepEqual(result.models, [
    { id: "grok-4.6", name: "grok-4.6" },
    { id: "grok-4.7", name: "grok-4.7" },
  ]);
  assert.equal(result.source, "official_grok_cli");
  assert.equal(result.diagnostics, undefined);
  assert.equal(registryCalls, 0);
});

test("Grok catalog loader survives a failing registry loader", async () => {
  const loader = createGrokCatalogLoader({
    grokHome: "/provider/grok",
    readJson: async () => null,
    commandRunner: async () => {
      throw new Error("spawn grok ENOENT");
    },
    registryLoader: async () => {
      throw new Error("registry unavailable");
    },
  });
  const result = await loader();
  assert.deepEqual(result.models, []);
  assert.deepEqual(result.diagnostics, ["Grok 官方模型目录读取失败：spawn grok ENOENT"]);
});

test("Grok catalog loader never reports a failed read while persisted models exist", async () => {
  const loader = createGrokCatalogLoader({
    grokHome: "/provider/grok",
    readJson: async () => ({ models: { "grok-live": { info: { model: "grok-live", name: "Grok Live" } } } }),
    commandRunner: async () => {
      throw new Error("spawn grok ENOENT");
    },
    registryLoader: async () => [{ id: "grok-4.5", provider: "xai" }],
  });
  const result = await loader({ force: true });
  assert.deepEqual(result.models, [{ id: "grok-live", name: "Grok Live" }]);
  assert.equal(result.source, "official_grok_local_cache");
  assert.equal(result.diagnostics, undefined);
});

test("Claude subscription status rejects API keys and maps live registry metadata", async () => {
  const apiKey = parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: "api_key",
    apiProvider: "firstParty",
    apiKeySource: "ANTHROPIC_API_KEY",
  }));
  assert.equal(apiKey.isApiKey, true);
  assert.equal(apiKey.isSubscription, false);

  const subscription = parseClaudeAuthStatus(JSON.stringify({
    loggedIn: true,
    authMethod: "oauth",
    apiProvider: "firstParty",
    email: "claude@example.test",
    plan: "max",
  }));
  assert.equal(subscription.isSubscription, true);
  assert.equal(subscription.email, "claude@example.test");

  const loader = createClaudeCatalogLoader({
    registryLoader: async () => [
      {
        id: "claude-live",
        name: "Claude Live",
        provider: "anthropic",
        api: "anthropic-messages",
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 32_000,
        thinkingLevelMap: { off: {}, low: {}, high: {} },
      },
      { id: "unrelated", provider: "other" },
    ],
  });
  assert.deepEqual((await loader()).models, [{
    id: "claude-live",
    name: "Claude Live",
    inputModalities: ["text", "image"],
    contextWindow: 200_000,
    maxTokens: 32_000,
    reasoning: {
      efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }],
    },
  }]);
});

test("CLI subscription drivers reject a non-active selected account before invoking", async () => {
  let claudeInvoked = false;
  const claude = createClaudeDriver({
    commandRunner: async () => ({
      output: JSON.stringify({
        loggedIn: true,
        authMethod: "oauth",
        apiProvider: "firstParty",
        accountId: "current-claude",
        email: "current@example.test",
      }),
    }),
    requestExecutor: async () => { claudeInvoked = true; },
  });
  await assert.rejects(
    () => claude.invoke({}, { account: { accountId: "old-claude", auth: { kind: "official_cli_session" } } }),
    (error) => error.authExpired === true && error.accountMismatch === true,
  );
  assert.equal(claudeInvoked, false);

  let cursorInvoked = false;
  const cursor = createCursorDriver({
    commandRunner: async () => ({
      output: JSON.stringify({ loggedIn: true, accountId: "current-cursor", email: "current@example.test" }),
    }),
    requestExecutor: async () => { cursorInvoked = true; },
  });
  await assert.rejects(
    () => cursor.invoke({}, { account: { accountId: "old-cursor", auth: { kind: "official_cli_session" } } }),
    (error) => error.authExpired === true && error.accountMismatch === true,
  );
  assert.equal(cursorInvoked, false);
});

test("browser OAuth invocations refresh Claude and Cursor access tokens", async () => {
  const secretStore = new MemorySecretStore();
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const futureAccess = jwt({ exp: Math.floor(Date.now() / 1000) + 3600, sub: "cursor-browser-account", email: "cursor@example.test" });

  let claudeRefreshCalls = 0;
  const claudeRef = "keychain://claude/browser-refresh";
  await secretStore.write(claudeRef, {
    type: "oauth",
    access: "claude-old-access",
    refresh: "claude-old-refresh",
    expiresAt: expiredAt,
  });
  const claude = createClaudeDriver({
    fetchImpl: async () => {
      claudeRefreshCalls += 1;
      return response(200, { access_token: "claude-new-access", refresh_token: "claude-new-refresh", expires_in: 3600 });
    },
    requestExecutor: async () => "claude-response",
  });
  const claudeResult = await claude.invoke({}, {
    account: {
      accountId: "claude-browser-account",
      email: "claude@example.test",
      auth: { credentialRef: claudeRef },
      resources: { authSource: "official_claude_browser_oauth" },
    },
  }, { secretStore });
  assert.equal(claudeResult, "claude-response");
  assert.equal(claudeRefreshCalls, 1);
  assert.equal((await secretStore.read(claudeRef)).access, "claude-new-access");

  let cursorRefreshCalls = 0;
  const cursorRef = "keychain://cursor/browser-refresh";
  await secretStore.write(cursorRef, {
    type: "oauth",
    access: jwt({ exp: Math.floor(Date.now() / 1000) - 60, sub: "cursor-browser-account" }),
    refresh: "cursor-old-refresh",
    expiresAt: expiredAt,
  });
  const cursor = createCursorDriver({
    fetchImpl: async (url) => {
      if (url.endsWith("/auth/exchange_user_api_key")) {
        cursorRefreshCalls += 1;
        return response(200, { accessToken: futureAccess, refreshToken: "cursor-new-refresh" });
      }
      throw new Error(`unexpected Cursor request: ${url}`);
    },
    requestExecutor: async () => "cursor-response",
  });
  const cursorResult = await cursor.invoke({}, {
    account: {
      accountId: "cursor-browser-account",
      email: "cursor@example.test",
      auth: { credentialRef: cursorRef },
      resources: { authSource: "official_cursor_browser_oauth" },
    },
  }, { secretStore });
  assert.equal(cursorResult, "cursor-response");
  assert.equal(cursorRefreshCalls, 1);
  assert.equal((await secretStore.read(cursorRef)).refresh, "cursor-new-refresh");
});

test("Claude CLI OAuth credentials are captured and refreshed from the persisted session", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockyard-claude-oauth-file-"));
  const secretStore = new MemorySecretStore();
  try {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", ".credentials.json"), JSON.stringify({
      claudeAiOauth: {
        accessToken: "claude-file-old-access",
        refreshToken: "claude-file-refresh",
        expiresAt: "2020-01-01T00:00:00.000Z",
      },
    }));
    let refreshCalls = 0;
    const driver = createClaudeDriver({
      home,
      cliPath: "missing-claude",
      commandRunner: async () => ({
        output: JSON.stringify({
          loggedIn: true,
          authMethod: "oauth",
          apiProvider: "firstParty",
          accountId: "claude-file-account",
          email: "claude-file@example.test",
        }),
      }),
      fetchImpl: async () => {
        refreshCalls += 1;
        return response(200, {
          access_token: "claude-file-new-access",
          refresh_token: "claude-file-new-refresh",
          expires_in: 3600,
        });
      },
      requestExecutor: async () => "claude-file-response",
    });
    const active = await driver.getActiveSession({ secretStore });
    const account = active.accounts[0];
    assert.equal(account.refresh.refreshable, true);
    assert.equal((await secretStore.read(account.credentialRef)).refresh, "claude-file-refresh");
    const result = await driver.invoke({}, { account }, {
      secretStore,
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    assert.equal(result, "claude-file-response");
    assert.equal(refreshCalls, 1);
    assert.equal((await secretStore.read(account.credentialRef)).access, "claude-file-new-access");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("official desktop session readers can replace CLI detection and login", async () => {
  const claudeStore = new MemorySecretStore();
  const claude = createClaudeDriver({
    cliPath: "missing-claude",
    commandRunner: async () => { throw new Error("CLI should not be called"); },
    sessionReader: async () => ({
      source: "claude_desktop_app",
      sourceKind: "desktop_app",
      loggedIn: true,
      authMethod: "oauth",
      apiProvider: "firstParty",
      accountId: "claude-desktop-account",
      email: "desktop-claude@example.test",
    }),
  });
  const claudeActive = await claude.getActiveSession({ secretStore: claudeStore });
  assert.equal(claudeActive.status, "completed");
  assert.equal(claudeActive.accounts[0].auth.kind, "official_session");
  assert.equal(claudeActive.accounts[0].resources.sessionSource, "desktop_app");
  assert.equal((await claudeStore.read(claudeActive.accounts[0].credentialRef)).type, "official_session");
  const claudeStarted = await claude.startAuthorization();
  assert.equal(claudeStarted.status, "pending");
  assert.equal(claudeStarted.authorizationCodeRequired, true);
  await claude.cancelAuthorization(claudeStarted.sessionId);

  const cursorStore = new MemorySecretStore();
  const cursor = createCursorDriver({
    cliPath: "missing-cursor-agent",
    commandRunner: async () => { throw new Error("CLI should not be called"); },
    sessionReader: async () => ({
      source: "cursor_desktop_app",
      sourceKind: "desktop_app",
      loggedIn: true,
      accountId: "cursor-desktop-account",
      email: "desktop-cursor@example.test",
      plan: "pro",
    }),
  });
  const cursorActive = await cursor.getActiveSession({ secretStore: cursorStore });
  assert.equal(cursorActive.status, "completed");
  assert.equal(cursorActive.accounts[0].auth.kind, "official_session");
  assert.equal(cursorActive.accounts[0].resources.sessionSource, "desktop_app");
  const cursorStarted = await cursor.startAuthorization();
  assert.equal(cursorStarted.status, "pending");
  assert.match(cursorStarted.authorizationUrl, /^https:\/\/cursor\.com\/loginDeepControl/);
  await cursor.cancelAuthorization(cursorStarted.sessionId);
});

test("subscription drivers start browser OAuth without a local CLI", async () => {
  const cliCalls = [];
  const commandRunner = async (...args) => {
    cliCalls.push(args);
    throw new Error("CLI must not be required for browser OAuth");
  };
  const codex = createCodexDriver({ cliPath: "missing-codex", commandRunner });
  const codexStarted = await codex.startAuthorization();
  assert.equal(codexStarted.status, "pending");
  const codexUrl = new URL(codexStarted.authorizationUrl);
  assert.equal(codexUrl.origin, "https://auth.openai.com");
  assert.equal(codexUrl.pathname, "/oauth/authorize");
  assert.equal(codexUrl.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(codexUrl.searchParams.get("code_challenge_method"), "S256");
  await codex.cancelAuthorization(codexStarted.sessionId);

  const antigravity = createAntigravityDriver({ cliPath: "missing-agy", commandRunner, env: antigravityTestEnv });
  const antigravityStarted = await antigravity.startAuthorization();
  assert.equal(antigravityStarted.status, "pending");
  const antigravityUrl = new URL(antigravityStarted.authorizationUrl);
  assert.equal(antigravityUrl.origin, "https://accounts.google.com");
  assert.equal(antigravityUrl.pathname, "/o/oauth2/v2/auth");
  assert.equal(antigravityUrl.searchParams.get("redirect_uri"), "http://localhost:51121/oauth-callback");
  assert.equal(antigravityUrl.searchParams.get("code_challenge_method"), "S256");
  await antigravity.cancelAuthorization(antigravityStarted.sessionId);

  const grok = createGrokDriver({ cliPath: "missing-grok", commandRunner });
  const grokStarted = await grok.startAuthorization();
  assert.equal(grokStarted.status, "pending");
  const grokUrl = new URL(grokStarted.authorizationUrl);
  assert.equal(grokUrl.origin, "https://auth.x.ai");
  assert.equal(grokUrl.pathname, "/oauth2/authorize");
  assert.equal(new URL(grokUrl.searchParams.get("redirect_uri")).pathname, "/callback");
  assert.equal(grokUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(grokUrl.searchParams.get("referrer"), "grok-build");
  await grok.cancelAuthorization(grokStarted.sessionId);

  const cursor = createCursorDriver({ cliPath: "missing-cursor-agent", commandRunner });
  const cursorStarted = await cursor.startAuthorization();
  assert.equal(cursorStarted.status, "pending");
  const cursorUrl = new URL(cursorStarted.authorizationUrl);
  assert.equal(cursorUrl.origin, "https://cursor.com");
  assert.equal(cursorUrl.pathname, "/loginDeepControl");
  assert.equal(cursorUrl.searchParams.get("mode"), "login");
  assert.equal(cursorUrl.searchParams.get("redirectTarget"), "cli");
  assert.equal(cursorUrl.searchParams.has("redirect_uri"), false);
  assert.ok(cursorUrl.searchParams.get("challenge"));
  assert.ok(cursorUrl.searchParams.get("uuid"));
  await cursor.cancelAuthorization(cursorStarted.sessionId);

  const claude = createClaudeDriver({ cliPath: "missing-claude", commandRunner });
  const claudeStarted = await claude.startAuthorization();
  assert.equal(claudeStarted.status, "pending");
  assert.equal(claudeStarted.authorizationCodeRequired, true);
  const claudeUrl = new URL(claudeStarted.authorizationUrl);
  assert.equal(claudeUrl.origin, "https://claude.com");
  assert.equal(claudeUrl.pathname, "/cai/oauth/authorize");
  assert.equal(claudeUrl.searchParams.get("code"), "true");
  assert.equal(claudeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.equal(claudeUrl.searchParams.get("redirect_uri"), "https://platform.claude.com/oauth/code/callback");
  await claude.cancelAuthorization(claudeStarted.sessionId);
  assert.equal(cliCalls.length, 0);
});

test("browser OAuth adapters exchange and import provider credentials", async () => {
  const secretStore = new MemorySecretStore();
  const commandRunner = async () => { throw new Error("CLI must not be used"); };
  const completeLoopback = async (driver, started) => {
    const redirect = new URL(new URL(started.authorizationUrl).searchParams.get("redirect_uri"));
    redirect.searchParams.set("code", "browser-code");
    redirect.searchParams.set("state", new URL(started.authorizationUrl).searchParams.get("state"));
    await fetch(redirect).then((value) => value.text());
    return driver.pollAuthorization(started.sessionId, { secretStore });
  };

  const codex = createCodexDriver({
    cliPath: "missing-codex",
    browserCallbackPort: 1455,
    commandRunner,
    fetchImpl: async () => response(200, {
      access_token: jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "codex-browser-account" } }),
      refresh_token: "codex-refresh",
      id_token: jwt({ "https://api.openai.com/profile": { email: "codex@example.test" } }),
    }),
  });
  const codexStarted = await codex.startAuthorization();
  const codexResult = await completeLoopback(codex, codexStarted);
  assert.equal(codexResult.status, "completed");
  assert.equal(codexResult.accounts[0].resources.sessionSource, "browser");
  assert.equal((await secretStore.read(codexResult.accounts[0].credentialRef)).refresh, "codex-refresh");

  const grok = createGrokDriver({
    cliPath: "missing-grok",
    commandRunner,
    fetchImpl: async () => response(200, {
      access_token: jwt({ sub: "grok-browser-account", email: "grok@example.test" }),
      refresh_token: "grok-refresh",
      expires_in: 3600,
    }),
  });
  const grokStarted = await grok.startAuthorization();
  const grokResult = await completeLoopback(grok, grokStarted);
  assert.equal(grokResult.status, "completed");
  assert.equal(grokResult.accounts[0].email, "grok@example.test");
  assert.equal(grokResult.accounts[0].resources.sessionSource, "browser");

  const claude = createClaudeDriver({
    cliPath: "missing-claude",
    commandRunner,
    fetchImpl: async () => response(200, {
      access_token: "claude-access",
      refresh_token: "claude-refresh",
      expires_in: 3600,
      email: "claude@example.test",
    }),
  });
  const claudeStarted = await claude.startAuthorization();
  const claudeRedirect = new URL(new URL(claudeStarted.authorizationUrl).searchParams.get("redirect_uri"));
  claudeRedirect.searchParams.set("code", "manual-code");
  claudeRedirect.searchParams.set("state", new URL(claudeStarted.authorizationUrl).searchParams.get("state"));
  const claudeResult = await claude.submitAuthorizationCode(claudeStarted.sessionId, claudeRedirect.toString(), { secretStore });
  assert.equal(claudeResult.status, "completed");
  assert.equal(claudeResult.accounts[0].resources.sessionSource, "browser");

  const antigravity = createAntigravityDriver({
    cliPath: "missing-agy",
    commandRunner,
    env: antigravityTestEnv,
    fetchImpl: async (url) => url.includes("userinfo")
      ? response(200, { email: "google@example.test", name: "Google Browser" })
      : response(200, { access_token: "google-access", refresh_token: "google-refresh", expires_in: 3600 }),
  });
  const antigravityStarted = await antigravity.startAuthorization();
  const antigravityResult = await completeLoopback(antigravity, antigravityStarted);
  assert.equal(antigravityResult.status, "completed");
  assert.equal(antigravityResult.accounts[0].email, "google@example.test");
  assert.equal(antigravityResult.accounts[0].resources.sessionSource, "browser");
  assert.equal(antigravityResult.accounts[0].resources.credentialRefreshMode, "dockyard_browser_oauth");
  const antigravityCredential = await secretStore.read(antigravityResult.accounts[0].credentialRef);
  assert.equal(antigravityCredential.access, "google-access");
  assert.equal(antigravityCredential.refresh, "google-refresh");
  assert.ok(antigravityCredential.expiresAt);

  const cursor = createCursorDriver({
    cliPath: "missing-cursor-agent",
    commandRunner,
    fetchImpl: async (url) => url.includes("/auth/poll")
      ? response(200, {
        accessToken: jwt({ sub: "cursor-browser-account", email: "cursor@example.test" }),
        refreshToken: "cursor-refresh",
      })
      : response(500, {}),
  });
  const cursorStarted = await cursor.startAuthorization();
  const cursorResult = await cursor.pollAuthorization(cursorStarted.sessionId, { secretStore });
  assert.equal(cursorResult.status, "completed");
  assert.equal(cursorResult.accounts[0].email, "cursor@example.test");
  assert.equal(cursorResult.accounts[0].resources.sessionSource, "browser");
});

test("Claude catalog collapses duplicate registry aliases", async () => {
  const loader = createClaudeCatalogLoader({
    registryLoader: async () => [
      { id: "claude-live", name: "Claude Live", provider: "anthropic", contextWindow: 200_000 },
      { id: "claude-live", name: "Claude Live", api: "anthropic-messages", maxTokens: 32_000 },
    ],
  });
  assert.deepEqual((await loader()).models, [{
    id: "claude-live",
    name: "Claude Live",
    contextWindow: 200_000,
    maxTokens: 32_000,
  }]);
});

test("Claude official CLI executor preserves streaming output and selected model tier", async () => {
  const calls = [];
  const executor = createClaudeCliExecutor({
    cliPath: "claude",
    streamCommandRunner: async function* (command, args, options) {
      calls.push({ command, args, options });
      yield JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } } });
      yield JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } });
      yield JSON.stringify({ type: "result", result: "Hello", usage: { input_tokens: 2, output_tokens: 3 } });
    },
  });
  const stream = await executor({
    request: {
      model: "claude-live",
      reasoningEffort: "high",
      messages: [{ role: "user", content: "Say hello" }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "claude");
  assert.deepEqual(calls[0].args.slice(0, 4), ["-p", "user:\nSay hello", "--output-format", "stream-json"]);
  assert.ok(calls[0].args.includes("--model") && calls[0].args.includes("claude-live"));
  assert.ok(calls[0].args.includes("--effort") && calls[0].args.includes("high"));
  assert.deepEqual(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text), ["Hel", "lo"]);
  assert.deepEqual(chunks.find((chunk) => chunk.type === "usage")?.usage, { inputTokens: 2, outputTokens: 3 });
});

test("CLI event parsing only exposes assistant content", () => {
  assert.deepEqual(cliEventText({ type: "message", role: "user", content: "secret input" }), []);
  assert.deepEqual(cliEventText({ type: "assistant", role: "assistant", content: "answer" }), ["answer"]);
  assert.deepEqual(cliEventText({ type: "tool_result", content: "tool output" }), []);
});

test("text-only subscription CLIs reject images instead of dropping them", async () => {
  const imageRequest = {
    messages: [{
      role: "user",
      content: [{ type: "text", text: "Inspect this" }, { type: "image", attachment: { attachmentId: "img-1" } }],
    }],
  };
  const executor = createClaudeCliExecutor({ cliPath: "claude" });
  await assert.rejects(
    () => executor({ request: imageRequest }),
    (error) => error.code === "UNSUPPORTED_CONTENT" && /image attachments/.test(error.message),
  );
});

test("text-only subscription CLIs can continue after an earlier failed image turn", async () => {
  const calls = [];
  const executor = createClaudeCliExecutor({
    cliPath: "claude",
    streamCommandRunner: async function* (command, args) {
      calls.push({ command, args });
      yield JSON.stringify({ type: "text_delta", text: "continued" });
    },
  });
  const stream = await executor({
    request: {
      messages: [
        { role: "user", content: [{ type: "image", attachment: { attachmentId: "failed-image" } }] },
        { role: "assistant", content: "The image turn failed." },
        { role: "user", content: "Continue with text only." },
      ],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(calls.length, 1);
  assert.match(calls[0].args[1], /previous image attachment omitted by native CLI/);
  assert.equal(chunks.find((chunk) => chunk.type === "text-delta")?.text, "continued");
});

test("Grok ACP prompt preserves durable image bytes and media type", async () => {
  const blocks = await grokRequestPromptBlocks({
    system: "Use the image.",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "What is here?" },
        { type: "image", attachment: { attachmentId: "img-1", mediaType: "image/png" } },
      ],
    }],
  }, {
    async readImage(ref) {
      assert.equal(ref.attachmentId, "img-1");
      return { ref: { mediaType: "image/png" }, data: Uint8Array.from([1, 2, 3]) };
    },
  });
  assert.deepEqual(blocks.at(-1), { type: "image", data: "AQID", mimeType: "image/png" });
});

test("Grok image requests use the native ACP executor", async () => {
  let textExecutorCalled = false;
  let acpRequest;
  const executor = createGrokCliExecutor({
    streamCommandRunner: async function* () {
      textExecutorCalled = true;
    },
    acpExecutor: async ({ request }) => {
      acpRequest = request;
      return (async function* () {
        yield { type: "text-delta", index: 0, text: "image ok" };
        yield { type: "finish", reason: { kind: "stop" } };
      })();
    },
  });
  const stream = await executor({
    request: {
      model: "grok-vision-live",
      messages: [{ role: "user", content: [{ type: "image", data: "AQID", mimeType: "image/png" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(textExecutorCalled, false);
  assert.equal(acpRequest.model, "grok-vision-live");
  assert.equal(chunks[0].text, "image ok");
});

test("Cursor status/catalog are sourced from the official CLI response", async () => {
  const output = JSON.stringify({
    loggedIn: true,
    email: "cursor@example.test",
    plan: "pro",
    models: [{ id: "cursor-live", name: "Cursor Live", contextWindow: 128_000, maxTokens: 16_000 }],
  });
  const status = parseCursorAuthStatus(output);
  assert.equal(status.loggedIn, true);
  assert.equal(status.email, "cursor@example.test");
  assert.equal(status.models[0].id, "cursor-live");
  const loader = createCursorCatalogLoader({
    commandRunner: async (command, args) => {
      assert.equal(command, "cursor-agent");
      assert.deepEqual(args, ["status"]);
      return { output, errorOutput: "" };
    },
  });
  assert.deepEqual((await loader()).models, [{
    id: "cursor-live",
    name: "Cursor Live",
    contextWindow: 128_000,
    maxTokens: 16_000,
  }]);
});

test("Cursor catalog loader force refresh does not join an in-flight request", async () => {
  let calls = 0;
  let releaseFirst;
  let enteredFirst;
  const firstStarted = new Promise((resolve) => { releaseFirst = resolve; });
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  const loader = createCursorCatalogLoader({
    commandRunner: async () => {
      const call = ++calls;
      if (call === 1) {
        enteredFirst();
        await firstStarted;
      }
      return {
        output: JSON.stringify({
          loggedIn: true,
          models: [{ id: `cursor-${call}`, name: `Cursor ${call}` }],
        }),
        errorOutput: "",
      };
    },
  });
  const firstPromise = loader();
  await firstEntered;
  const forced = await loader({ force: true });
  releaseFirst();
  const first = await firstPromise;
  assert.equal(calls, 2);
  assert.equal(forced.models[0].id, "cursor-2");
  assert.equal(first.models[0].id, "cursor-1");
});

test("Cursor Connect trailers expose upstream quota errors instead of an empty success", () => {
  const trailer = new TextEncoder().encode(JSON.stringify({
    error: { code: "resource_exhausted", message: "Error" },
  }));
  assert.deepEqual(decodeCursorConnectTrailer(trailer), {
    code: "resource_exhausted",
    message: "Error",
  });
  assert.equal(decodeCursorConnectTrailer(new TextEncoder().encode("{}")), null);
});

test("Cursor native executor rejects a quota trailer instead of yielding blank text", async () => {
  const http2Module = {
    constants: { NGHTTP2_CANCEL: 8 },
    connect() {
      const session = new EventEmitter();
      session.closed = false;
      session.destroyed = false;
      session.request = () => {
        const stream = new EventEmitter();
        stream.closed = false;
        stream.destroyed = false;
        stream.write = () => true;
        stream.close = () => {
          stream.closed = true;
          stream.destroyed = true;
        };
        queueMicrotask(() => {
          stream.emit("response", { ":status": 200 });
          stream.emit("data", Buffer.from(frameConnectMessage(
            new TextEncoder().encode(JSON.stringify({
              error: { code: "resource_exhausted", message: "Error" },
            })),
            0x02,
          )));
          stream.emit("end");
        });
        return stream;
      };
      session.close = () => {
        session.closed = true;
        session.destroyed = true;
      };
      return session;
    },
  };
  const executor = createCursorNativeExecutor({
    endpoint: "https://cursor.test/agent.v1.AgentService/Run",
    http2Module,
    tokenResolver: async () => ({ token: "opaque-test-token" }),
  });
  await assert.rejects(async () => {
    const stream = await executor({
      request: { model: "composer-2.5", messages: [{ role: "user", content: "Hello" }] },
      context: { requestId: "cursor-test", sessionId: "cursor-test" },
    });
    for await (const _chunk of stream) {
      // The quota trailer must fail before the synthetic finish event.
    }
  }, (error) => {
    assert.equal(error.code, "resource_exhausted");
    assert.equal(error.quotaExhausted, true);
    assert.match(error.message, /额度或上游资源已耗尽/);
    return true;
  });
});

test("Cursor browser OAuth resolves an email through the official identity RPC", async () => {
  const secretStore = new MemorySecretStore();
  let identityRequest = null;
  const driver = createCursorDriver({
    home: join(tmpdir(), "dockyard-cursor-rpc-test-no-desktop"),
    cliPath: "missing-cursor-agent",
    commandRunner: async () => { throw new Error("CLI must not be used"); },
    fetchImpl: async (url, init = {}) => {
      if (url.includes("/auth/poll")) {
        return response(200, {
          accessToken: jwt({ sub: "google-oauth2|user_cursor" }),
          refreshToken: "cursor-refresh",
          expiresIn: 3600,
        });
      }
      identityRequest = { url, init };
      return response(200, { email: "cursor-rpc@example.test" });
    },
  });
  const started = await driver.startAuthorization();
  const result = await driver.pollAuthorization(started.sessionId, { secretStore });
  assert.equal(result.accounts[0].email, "cursor-rpc@example.test");
  assert.equal(result.accounts[0].displayName, "cursor-rpc@example.test");
   assert.equal(result.accounts[0].refresh.refreshable, true);
   assert.ok(result.accounts[0].refresh.accessTokenExpiresAt);
   assert.equal((await secretStore.read(result.accounts[0].credentialRef)).expiresAt !== undefined, true);
  assert.equal(identityRequest.url, "https://api2.cursor.sh/aiserver.v1.AuthService/GetEmail");
  assert.equal(identityRequest.init.method, "POST");
  assert.deepEqual(JSON.parse(identityRequest.init.body), {});
  assert.equal((await secretStore.read(result.accounts[0].credentialRef)).email, "cursor-rpc@example.test");
});

test("Cursor refresh repairs an existing browser account's missing email", async () => {
  const secretStore = new MemorySecretStore();
  const credentialRef = "keychain://cursor/missing-email";
  await secretStore.write(credentialRef, { access: "cursor-access", refresh: "cursor-refresh" });
  const driver = createCursorDriver({
    home: join(tmpdir(), "dockyard-cursor-refresh-email-no-desktop"),
    commandRunner: async () => { throw new Error("CLI must not be used"); },
    fetchImpl: async (url) => url.includes("/GetEmail")
      ? response(200, { email: "repaired@example.test" })
      : response(500, {}),
  });
  const refreshed = await driver.refreshAccount({
    accountId: "google-oauth2|user_cursor",
    displayName: "google-oauth2|user_cursor",
    email: null,
    auth: { credentialRef, kind: "official_session" },
    resources: { authSource: "official_cursor_browser_oauth", sessionSource: "browser" },
    subscription: { plan: null },
  }, { secretStore, now: new Date("2026-08-16T12:00:00.000Z") });
  assert.equal(refreshed.identity.email, "repaired@example.test");
  assert.equal(refreshed.identity.displayName, "repaired@example.test");
});

test("Cursor browser OAuth rejects an expired access token before invocation", async () => {
  const secretStore = new MemorySecretStore();
  const credentialRef = "keychain://cursor/expired-browser";
  await secretStore.write(credentialRef, {
    access: jwt({ exp: Math.floor(Date.now() / 1000) - 60 }),
    refresh: "cursor-refresh",
  });
  const driver = createCursorDriver({
    commandRunner: async () => { throw new Error("CLI must not be used"); },
    fetchImpl: async () => { throw new Error("identity RPC must not be called"); },
  });
  await assert.rejects(
    driver.refreshAccount({
      accountId: "google-oauth2|user_expired",
      displayName: "Expired Cursor",
      email: "expired@example.test",
      auth: { credentialRef, kind: "official_session" },
      resources: { authSource: "official_cursor_browser_oauth", sessionSource: "browser" },
      subscription: { plan: null },
    }, { secretStore }),
    (error) => {
      assert.equal(error.authExpired, true);
      assert.match(error.message, /access token expired/);
      return true;
    },
  );
});

test("Cursor browser OAuth loads the official account model catalog without the CLI", async () => {
  const secretStore = new MemorySecretStore();
  const credentialRef = "keychain://cursor/browser-catalog";
  await secretStore.write(credentialRef, { access: "cursor-access" });
  let request = null;
  const loader = createCursorCatalogLoader({
    cliPath: "missing-cursor-agent",
    commandRunner: async () => { throw new Error("CLI must not be used for browser catalog"); },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(200, {
        models: [
          { name: "default", clientDisplayName: "Auto", supportsAgent: true },
          { name: "claude-4.5-sonnet", clientDisplayName: "Claude 4.5 Sonnet", contextTokenLimit: 200_000 },
        ],
      });
    },
  });
  const catalog = await loader({
    accounts: [{
      auth: { credentialRef },
      resources: { sessionSource: "browser", authSource: "official_cursor_browser_oauth" },
    }],
    secretStore,
  });
  assert.equal(catalog.source, "official_cursor_browser_oauth_api");
  assert.deepEqual(catalog.models, [
    { id: "default", name: "Auto" },
    { id: "claude-4.5-sonnet", name: "Claude 4.5 Sonnet", contextWindow: 200_000 },
  ]);
  assert.equal(request.url, "https://api2.cursor.sh/aiserver.v1.AiService/AvailableModels");
  assert.equal(request.init.headers.authorization, "Bearer cursor-access");
  assert.equal(JSON.parse(request.init.body).useReactModelPicker, true);
});

test("Cursor catalog loader falls back to a Cursor registry row when RPC and CLI are unavailable", async () => {
  const loader = createCursorCatalogLoader({
    commandRunner: async () => {
      const error = new Error("spawn cursor-agent ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    fetchImpl: async () => { throw new Error("RPC must not be required without a browser account"); },
    registryLoader: async () => [
      { id: "cursor-live", name: "Cursor Live", provider: "cursor", contextWindow: 128_000 },
      { id: "claude-haiku-4-5", provider: "anthropic" },
      { id: "gemini-2.5-flash", provider: "google" },
    ],
  });
  const catalog = await loader();
  assert.equal(catalog.source, "dsh_live_provider_registry");
  assert.equal(catalog.diagnostics, undefined);
  assert.deepEqual(catalog.models, [{ id: "cursor-live", name: "Cursor Live", contextWindow: 128_000 }]);
});

test("Cursor catalog loader does not dump Claude or Gemini rows as a Cursor menu", async () => {
  const loader = createCursorCatalogLoader({
    commandRunner: async () => {
      const error = new Error("spawn cursor-agent ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    registryLoader: async () => [
      { id: "claude-haiku-4-5", provider: "anthropic" },
      { id: "gpt-4o", provider: "openai" },
      { id: "gemini-2.5-flash", provider: "google" },
    ],
  });
  const catalog = await loader();
  assert.equal(catalog.source, "oauthpro_builtin_cursor_catalog");
  assert.equal(catalog.diagnostics, undefined);
  assert.deepEqual(catalog.models.map((model) => model.id), BUILTIN_CURSOR_CATALOG.map((model) => model.id));
  assert.ok(!catalog.models.some((model) => ["claude-haiku-4-5", "gpt-4o", "gemini-2.5-flash"].includes(model.id)));
});

test("Cursor catalog loader publishes builtin slugs when no live directory exists", async () => {
  const loader = createCursorCatalogLoader({
    commandRunner: async () => {
      const error = new Error("spawn cursor-agent ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  });
  const catalog = await loader();
  assert.equal(catalog.source, "oauthpro_builtin_cursor_catalog");
  assert.equal(catalog.diagnostics, undefined);
  assert.ok(catalog.models.some((model) => model.id === "default"));
  assert.ok(catalog.models.some((model) => model.id === "claude-4.5-sonnet"));
});

test("Cursor catalog loader keeps the last live catalog when a later CLI read fails", async () => {
  let calls = 0;
  const loader = createCursorCatalogLoader({
    commandRunner: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          output: JSON.stringify({ loggedIn: true, models: [{ id: "cursor-live", name: "Cursor Live" }] }),
          errorOutput: "",
        };
      }
      const error = new Error("spawn cursor-agent ENOENT");
      error.code = "ENOENT";
      throw error;
    },
  });
  const first = await loader();
  const second = await loader({ force: true });
  assert.deepEqual(first.models, [{ id: "cursor-live", name: "Cursor Live" }]);
  assert.deepEqual(second.models, [{ id: "cursor-live", name: "Cursor Live" }]);
  assert.equal(second.diagnostics, undefined);
  assert.equal(calls, 2);
});

test("Cursor official CLI executor passes the selected model and normalizes stream-json", async () => {
  const calls = [];
  const executor = createCursorCliExecutor({
    cliPath: "cursor-agent",
    streamCommandRunner: async function* (command, args, options) {
      calls.push({ command, args, options });
      yield JSON.stringify({ type: "text_delta", text: "Cursor response" });
      yield JSON.stringify({ type: "result", result: "Cursor response", usage: { input_tokens: 4, output_tokens: 5 } });
    },
  });
  const stream = await executor({
    request: { model: "cursor-live", messages: [{ role: "user", content: "Hello" }] },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(calls[0].command, "cursor-agent");
  assert.deepEqual(calls[0].args.slice(0, 4), ["-p", "user:\nHello", "--output-format", "stream-json"]);
  assert.ok(calls[0].args.includes("--model") && calls[0].args.includes("cursor-live"));
  assert.deepEqual(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text), ["Cursor response"]);
  assert.deepEqual(chunks.find((chunk) => chunk.type === "usage")?.usage, { inputTokens: 4, outputTokens: 5 });
});

test("Grok OAuth account execution uses an isolated official CLI profile", async () => {
  const home = await mkdtemp(join(tmpdir(), "dockyard-grok-exec-"));
  const secretStore = new MemorySecretStore();
  let profileDir = null;
  try {
    const driver = createGrokDriver({
      grokHome: home,
      commandRunner: async () => ({ output: "", errorOutput: "" }),
      catalogLoader: async () => ({ models: [] }),
      requestExecutor: async ({ context }) => {
        profileDir = context.env.GROK_HOME;
        const raw = JSON.parse(await readFile(join(profileDir, "auth.json"), "utf8"));
        assert.equal(raw["grok-account"].key, "access-token");
        return (async function* () {
          yield { type: "text-delta", index: 0, text: "ok" };
          yield { type: "finish", reason: { kind: "stop" } };
        })();
      },
    });
    const [account] = await driver.importSource({
      content: JSON.stringify({
        "grok-account": {
          key: "access-token",
          refresh_token: "refresh-token",
          user_id: "grok-account",
        },
      }),
    }, { secretStore });
    const stream = await driver.stream({ messages: [{ role: "user", content: "Hi" }] }, { account }, { secretStore });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(chunks[0].text, "ok");
    assert.ok(profileDir);
    await assert.rejects(readFile(join(profileDir, "auth.json")));
  } finally {
    await rm(home, { recursive: true, force: true });
    if (profileDir) await rm(profileDir, { recursive: true, force: true });
  }
});

test("Grok native invocation refreshes an expired OAuth credential before sending", async () => {
  const secretStore = new MemorySecretStore();
  const credentialRef = "keychain://grok/native-refresh";
  await secretStore.write(credentialRef, {
    type: "oauth",
    access: "grok-old-access",
    refresh: "grok-old-refresh",
    expiresAt: "2020-01-01T00:00:00.000Z",
    accountId: "grok-native-account",
  });
  let refreshRequest = null;
  let sentCredential = null;
  const executor = async ({ credential }) => {
    sentCredential = credential;
    return "grok-response";
  };
  executor.nativeTransport = "xai-chat-completions";
  const driver = createGrokDriver({
    tokenUrl: "https://auth.x.ai/oauth2/token",
    requestExecutor: executor,
    fetchImpl: async (url, init) => {
      refreshRequest = { url, init };
      return response(200, {
        access_token: "grok-new-access",
        refresh_token: "grok-new-refresh",
        expires_in: 3600,
      });
    },
  });
  const result = await driver.invoke({}, {
    account: {
      providerId: "grok",
      accountId: "grok-native-account",
      credentialRef,
      auth: { credentialRef },
      refresh: { accessTokenExpiresAt: "2020-01-01T00:00:00.000Z", refreshable: true },
    },
  }, {
    secretStore,
    now: new Date("2026-08-24T12:00:00.000Z"),
  });
  assert.equal(result, "grok-response");
  assert.equal(refreshRequest.url, "https://auth.x.ai/oauth2/token");
  assert.equal(refreshRequest.init.method, "POST");
  assert.match(String(refreshRequest.init.body), /grant_type=refresh_token/);
  assert.equal(sentCredential.access, "grok-new-access");
  assert.equal((await secretStore.read(credentialRef)).refresh, "grok-new-refresh");
});

test("Grok official CLI executor keeps streaming-json and live model selection", async () => {
  const calls = [];
  const executor = createGrokCliExecutor({
    cliPath: "grok",
    streamCommandRunner: async function* (command, args, options) {
      calls.push({ command, args, options });
      yield JSON.stringify({ type: "text_delta", text: "Grok response" });
      yield JSON.stringify({ type: "result", result: "Grok response" });
    },
  });
  const stream = await executor({
    request: { model: "grok-live", messages: [{ role: "user", content: "Hello" }], reasoningEffort: "high" },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(calls[0].command, "grok");
  assert.deepEqual(calls[0].args.slice(0, 4), ["--single", "user:\nHello", "--output-format", "streaming-json"]);
  assert.ok(calls[0].args.includes("--model") && calls[0].args.includes("grok-live"));
  assert.ok(calls[0].args.includes("--reasoning-effort") && calls[0].args.includes("high"));
  assert.deepEqual(chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.text), ["Grok response"]);
});

test("Antigravity caps flattened history so mid-conversation turns stay in the verified regime", () => {
  // Regression: a day-long session replayed the whole history in one prompt;
  // agy's per-turn latency scales linearly with input, so the turn exceeded
  // the executor's 300s kill and looked like a silent hang. The oldest
  // message sections must be dropped until the prompt fits the cap, while
  // system, rules, and the newest turns survive.
  const prompt = antigravityRequestPrompt({
    system: "Be concise.",
    messages: [
      { role: "user", content: "old context ".repeat(4_000) },
      { role: "assistant", content: "old answer ".repeat(4_000) },
      { role: "user", content: "最新的问题" },
    ],
  });
  assert.ok(Buffer.byteLength(prompt, "utf8") <= 60_000, `prompt too large: ${Buffer.byteLength(prompt, "utf8")}`);
  assert.ok(prompt.includes("最新的问题"), "newest turn must survive");
  assert.match(prompt, /system:\nBe concise\./);
  assert.ok(!prompt.includes("old context ".repeat(50)), "oldest history must be trimmed");
});

// --- Session-anchor mode (docs/antigravity-persistent-bridge-design.md §8) ---

function fakeAgyScript(options = {}) {
  // A drop-in agy: emits init + result NDJSON, records argv and stdin, and can
  // be told to fail specific invocation shapes.
  return [
    "#!/bin/sh",
    `printf '%s\\n' "$@" >> ${JSON.stringify(options.argvLog)}`,
    `cat >> ${JSON.stringify(options.stdinLog)}`,
    ...(options.failAnchored ? [
      `if grep -q -- --input-format ${JSON.stringify(options.argvLog)}; then exit 1; fi`,
    ] : []),
    `if grep -q -- --input-format ${JSON.stringify(options.argvLog)}; then`,
    '  CID=$(head -c 4000 /dev/null; echo anchored-conv-id)',
    '  printf \'{"event":"init","conversation_id":"anchored-conv-id"}\\n\'',
    '  printf \'{"event":"step_update","step_update":{"state":"DONE","step_type":"agent_response","text_delta":"anchored reply","usage":{"input_tokens":10,"output_tokens":2}}}\\n\'',
    '  printf \'{"event":"result","result":{"conversation_id":"anchored-conv-id","status":"SUCCESS","response":"anchored reply","usage":{"input_tokens":10,"output_tokens":2}}}\\n\'',
    'else',
    '  printf \'{"event":"result","result":{"status":"SUCCESS","response":"legacy reply","usage":{"input_tokens":5,"output_tokens":1}}}\\n\'',
    'fi',
    "",
  ].join("\n");
}

test("Antigravity session-anchor first turn creates a conversation and persists the mapping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-anchor-"));
  const storeFile = join(dir, "convs.json");
  const executor = createAntigravityCliExecutor({
    cliPath: "/bin/echo", // replaced below by script path
    streamCommandRunner: async function* (path, args, opts) {
      // Pretend to be agy: first turn gets no --conversation.
      assert.ok(!args.includes("--conversation"));
      assert.ok(args.includes("--input-format"));
      assert.ok(args.includes("--print-timeout"));
      const payload = JSON.parse(opts.stdin.trim());
      assert.equal(payload.event, "user");
      assert.match(payload.message.content, /会话约定/);
      assert.match(payload.message.content, /hello anchored/);
      yield JSON.stringify({ event: "init", conversation_id: "cid-1" });
      yield JSON.stringify({ event: "result", result: { conversation_id: "cid-1", status: "SUCCESS", response: "anchored reply", usage: { input_tokens: 10, output_tokens: 2 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: storeFile }),
    anchorLogPath: join(dir, "anchor.log"),
  });
  const stream = await executor({
    request: {
      sessionId: "dsh-session-1",
      system: "Be concise.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello anchored" }] }],
    },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(chunks.at(-1).reason.kind, "stop");
  const stored = JSON.parse(await readFile(storeFile, "utf8"));
  assert.equal(stored["dsh-session-1"].cid, "cid-1");
  assert.equal(stored["dsh-session-1"].msgsLen, 1);
});

test("Antigravity session-anchor reattaches and sends only the tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-anchor-"));
  const storeFile = join(dir, "convs.json");
  const seenArgs = [];
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (path, args, opts) {
      seenArgs.push(args);
      const isReattach = args.includes("--conversation");
      const payload = JSON.parse(opts.stdin.trim());
      if (seenArgs.length === 1) {
        assert.ok(!isReattach);
        yield JSON.stringify({ event: "init", conversation_id: "cid-A" });
        yield JSON.stringify({ event: "result", result: { conversation_id: "cid-A", status: "SUCCESS", response: "first", usage: { input_tokens: 1, output_tokens: 1 } } });
        return;
      }
      assert.ok(isReattach);
      assert.equal(args[args.indexOf("--conversation") + 1], "cid-A");
      // Only the NEW user turn travels; history is agy's job now.
      assert.equal(payload.message.content, "第二个问题");
      yield JSON.stringify({ event: "result", result: { conversation_id: "cid-A", status: "SUCCESS", response: "second", usage: { input_tokens: 2, output_tokens: 1 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: storeFile }),
    anchorLogPath: join(dir, "anchor.log"),
  });
  const base = { sessionId: "dsh-session-2", system: "Be concise." };
  for await (const _c of await executor({ request: { ...base, messages: [{ role: "user", content: [{ type: "text", text: "第一个问题" }] }] } })) { /* drain */ }
  for await (const _c of await executor({ request: { ...base, messages: [
    { role: "user", content: [{ type: "text", text: "第一个问题" }] },
    { role: "assistant", content: [{ type: "text", text: "第一个回答" }] },
    { role: "user", content: [{ type: "text", text: "第二个问题" }] },
  ] } })) { /* drain */ }
  assert.equal(seenArgs.length, 2);
});

test("Antigravity session-anchor starts a fresh conversation after a history edit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-anchor-"));
  const storeFile = join(dir, "convs.json");
  const seenArgs = [];
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (path, args, opts) {
      seenArgs.push(args);
      yield JSON.stringify({ event: "init", conversation_id: seenArgs.length === 1 ? "cid-orig" : "cid-new" });
      yield JSON.stringify({ event: "result", result: { conversation_id: seenArgs.length === 1 ? "cid-orig" : "cid-new", status: "SUCCESS", response: "ok", usage: { input_tokens: 1, output_tokens: 1 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: storeFile }),
    anchorLogPath: join(dir, "anchor.log"),
  });
  const base = { sessionId: "dsh-session-3" };
  for await (const _c of await executor({ request: { ...base, messages: [{ role: "user", content: [{ type: "text", text: "原始问题" }] }] } })) { /* drain */ }
  // The user edits the first message: the prefix no longer matches, so the
  // anchor must NOT reattach (stale memory would answer the edited-away turn).
  for await (const _c of await executor({ request: { ...base, messages: [{ role: "user", content: [{ type: "text", text: "改写后的问题" }] }] } })) { /* drain */ }
  assert.equal(seenArgs[1].includes("--conversation"), false);
});

test("Antigravity requests without a session id keep the legacy replay path", async () => {
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (path, args) {
      assert.ok(args[0] === "-p");
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "legacy reply", usage: { input_tokens: 1, output_tokens: 1 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: join(tmpdir(), `agy-anchor-${Date.now()}.json`) }),
    anchorLogPath: join(tmpdir(), `agy-anchor-log-${Date.now()}.log`),
  });
  const stream = await executor({
    request: { messages: [{ role: "user", content: [{ type: "text", text: "no session" }] }] },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.match(JSON.stringify(chunks), /legacy reply/);
});

test("Antigravity anchored failure degrades to the legacy replay path", async () => {
  let calls = 0;
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (path, args) {
      calls += 1;
      if (args.includes("--input-format")) throw new Error("spawn failed");
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "degraded legacy reply", usage: { input_tokens: 1, output_tokens: 1 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: join(tmpdir(), `agy-anchor-${Date.now()}.json`) }),
    anchorLogPath: join(tmpdir(), `agy-anchor-log-${Date.now()}.log`),
  });
  const stream = await executor({
    request: { sessionId: "dsh-session-4", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.match(JSON.stringify(chunks), /degraded legacy reply/);
  // Two anchored attempts (the empty-retry policy) before the legacy replay.
  assert.equal(calls, 3);
});

test("Antigravity session-anchor reads the session id from the invoke context", async () => {
  // The harness puts the conversation handle in the context (runtime.stream's
  // third argument), not on the request; the anchor must accept both or it
  // silently never engages.
  const dir = await mkdtemp(join(tmpdir(), "agy-anchor-ctx-"));
  const storeFile = join(dir, "convs.json");
  const seenArgs = [];
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (path, args) {
      seenArgs.push(args);
      yield JSON.stringify({ event: "init", conversation_id: "cid-ctx" });
      yield JSON.stringify({ event: "result", result: { conversation_id: "cid-ctx", status: "SUCCESS", response: "ok", usage: { input_tokens: 1, output_tokens: 1 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: storeFile }),
    anchorLogPath: join(dir, "anchor.log"),
  });
  const stream = await executor({
    request: { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
    context: { sessionId: "dsh-session-ctx" },
  });
  for await (const _c of stream) { /* drain */ }
  const stored = JSON.parse(await readFile(storeFile, "utf8"));
  assert.equal(stored["dsh-session-ctx"].cid, "cid-ctx");
});

test("Antigravity retries the anchored turn once before degrading to replay", async () => {
  // Observed in the wild: agy occasionally returns SUCCESS with empty text
  // (~10 events, ~14s). Retrying the anchor is far cheaper than a full replay,
  // so the first empty run must not immediately fall back.
  const dir = await mkdtemp(join(tmpdir(), "agy-anchor-retry-"));
  const storeFile = join(dir, "convs.json");
  let calls = 0;
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      calls += 1;
      if (calls === 1) {
        yield JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "" } });
        return;
      }
      yield JSON.stringify({ event: "init", conversation_id: "cid-retry" });
      yield JSON.stringify({ event: "result", result: { conversation_id: "cid-retry", status: "SUCCESS", response: "second attempt reply", usage: { input_tokens: 3, output_tokens: 2 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: storeFile }),
    anchorLogPath: join(dir, "anchor.log"),
  });
  const stream = await executor({
    request: { sessionId: "dsh-session-retry", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(calls, 2);
  assert.match(JSON.stringify(chunks), /second attempt reply/);
  const stored = JSON.parse(await readFile(storeFile, "utf8"));
  assert.equal(stored["dsh-session-retry"].cid, "cid-retry");
});

test("Antigravity recognises sideband requests (titles, compaction)", () => {
  assert.equal(isAntigravitySidebandRequest({ purpose: "session-title" }), true);
  assert.equal(isAntigravitySidebandRequest({ purpose: "compaction" }), true);
  assert.equal(isAntigravitySidebandRequest({ purpose: "assistant" }), false);
  assert.equal(isAntigravitySidebandRequest({}), false);
  // Fallback marker for callers that do not forward `purpose`.
  assert.equal(
    isAntigravitySidebandRequest({ system: "Create a concise title for an AI coding-assistant session from the supplied human messages.\nMore." }),
    true,
  );
});

test("Antigravity never anchors a sideband request into the user conversation", async () => {
  // A session-title run shares the conversation's sessionId; anchoring it would
  // write the title prompt into agy's memory and burn the fast path.
  const dir = await mkdtemp(join(tmpdir(), "agy-sideband-"));
  const storeFile = join(dir, "convs.json");
  const seen = [];
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (path, args) {
      seen.push(args);
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Some Title", usage: { input_tokens: 5, output_tokens: 2 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: storeFile }),
    anchorLogPath: join(dir, "anchor.log"),
  });
  const stream = await executor({
    request: {
      sessionId: "dsh-session-sideband",
      purpose: "session-title",
      messages: [{ role: "user", content: [{ type: "text", text: "Generate the session title" }] }],
    },
  });
  for await (const _c of stream) { /* drain */ }
  assert.equal(seen[0].includes("--conversation"), false);
  assert.equal(seen[0][0], "-p");
  // No mapping may be created for the session by a sideband run.
  await assert.rejects(readFile(storeFile, "utf8"));
});

test("Antigravity mirrors permission rules into agy settings before spawning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-perm-"));
  const settingsFile = join(dir, "settings.json");
  await writeFile(settingsFile, JSON.stringify({ permissions: { allow: ["command(ls)", "custom(rule)"] } }), "utf8");
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok", usage: { input_tokens: 1, output_tokens: 1 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: join(dir, "convs.json") }),
    anchorLogPath: join(dir, "anchor.log"),
    settingsFile,
  });
  const stream = await executor({
    request: { sessionId: "dsh-session-perm", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
  });
  for await (const _c of stream) { /* drain */ }
  const merged = JSON.parse(await readFile(settingsFile, "utf8"));
  // User rules survive; the DSH-side baseline is appended.
  assert.ok(merged.permissions.allow.includes("custom(rule)"));
  assert.ok(merged.permissions.allow.includes("command(*)"));
  assert.ok(merged.permissions.allow.includes("unsandboxed(*)"));
  // A backup of the pre-merge file is kept next to it.
  assert.ok((await readFile(`${settingsFile}.bak`, "utf8")).includes("custom(rule)"));
});

test("Antigravity permission mirroring can be disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-perm-off-"));
  const settingsFile = join(dir, "settings.json");
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok", usage: { input_tokens: 1, output_tokens: 1 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: join(dir, "convs.json") }),
    anchorLogPath: join(dir, "anchor.log"),
    settingsFile,
    mirrorPermissions: false,
  });
  const stream = await executor({ request: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] } });
  for await (const _c of stream) { /* drain */ }
  await assert.rejects(readFile(settingsFile, "utf8"));
});

test("Antigravity labels imported history so a model switch keeps context", () => {
  // Regression: the first anchored turn flattened the foreign-model history into
  // unlabelled prose, so the model could not tell its own answers from the
  // user's questions and appeared to ignore the earlier conversation.
  const rendered = antigravityHistoryImport([
    { role: "user", content: [{ type: "text", text: "帮我看看登录流程" }] },
    { role: "assistant", content: [{ type: "text", text: "先查 auth 模块" }] },
    { role: "user", content: [{ type: "text", text: "那就继续" }] },
  ]);
  assert.match(rendered, /user:\n帮我看看登录流程/);
  assert.match(rendered, /assistant:\n先查 auth 模块/);
  assert.match(rendered, /user:\n那就继续/);
});

test("Antigravity caps the imported history and keeps the newest turns", () => {
  const rendered = antigravityHistoryImport([
    { role: "user", content: [{ type: "text", text: "OLD ".repeat(20_000) }] },
    { role: "assistant", content: [{ type: "text", text: "OLD ANSWER ".repeat(20_000) }] },
    { role: "user", content: [{ type: "text", text: "最新的问题" }] },
  ]);
  assert.ok(Buffer.byteLength(rendered, "utf8") <= 60_000, `import too large: ${Buffer.byteLength(rendered, "utf8")}`);
  assert.match(rendered, /最新的问题/);
  assert.ok(!rendered.includes("OLD ".repeat(100)), "oldest turns must be trimmed");
});

test("Antigravity sends a labelled import on the first anchored turn of an existing session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agy-import-"));
  const storeFile = join(dir, "convs.json");
  let sent = null;
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (path, args, opts) {
      sent = JSON.parse(opts.stdin.trim()).message.content;
      yield JSON.stringify({ event: "init", conversation_id: "cid-import" });
      yield JSON.stringify({ event: "result", result: { conversation_id: "cid-import", status: "SUCCESS", response: "ok", usage: { input_tokens: 3, output_tokens: 1 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: storeFile }),
    anchorLogPath: join(dir, "anchor.log"),
    settingsFile: join(dir, "settings.json"),
  });
  const stream = await executor({
    request: {
      sessionId: "dsh-session-import",
      system: "Be concise.",
      messages: [
        { role: "user", content: [{ type: "text", text: "历史问题" }] },
        { role: "assistant", content: [{ type: "text", text: "历史回答" }] },
        { role: "user", content: [{ type: "text", text: "新问题" }] },
      ],
    },
  });
  for await (const _c of stream) { /* drain */ }
  assert.match(sent, /此前的对话历史/);
  assert.match(sent, /user:\n历史问题/);
  assert.match(sent, /assistant:\n历史回答/);
  assert.match(sent, /user:\n新问题/);
});

test("Antigravity labels the tail when the user switched away and back", async () => {
  // Scenario: the session already has an agy conversation, the user chats with
  // another model for a turn, then returns. Those foreign turns sit in the tail
  // and must be labelled, otherwise they read as one undifferentiated block.
  const dir = await mkdtemp(join(tmpdir(), "agy-tail-label-"));
  const sent = [];
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* (path, args, opts) {
      sent.push(JSON.parse(opts.stdin.trim()).message.content);
      yield JSON.stringify({ event: "init", conversation_id: "cid-tail" });
      yield JSON.stringify({ event: "result", result: { conversation_id: "cid-tail", status: "SUCCESS", response: "ok", usage: { input_tokens: 3, output_tokens: 1 } } });
    },
    conversationStore: createAntigravityConversationStore({ file: join(dir, "convs.json") }),
    anchorLogPath: join(dir, "anchor.log"),
    settingsFile: join(dir, "settings.json"),
  });
  const base = { sessionId: "dsh-session-tail" };
  const first = [{ role: "user", content: [{ type: "text", text: "第一问" }] }];
  for await (const _c of await executor({ request: { ...base, messages: first } })) { /* drain */ }
  // Turn two: agy's own reply to turn one, then a foreign-model answer and a
  // new question. Only agy's reply may be dropped; the foreign one must stay.
  for await (const _c of await executor({ request: { ...base, messages: [
    ...first,
    { role: "assistant", content: [{ type: "text", text: "agy 自己的回答" }] },
    { role: "user", content: [{ type: "text", text: "切到别的模型问" }] },
    { role: "assistant", content: [{ type: "text", text: "别的模型的回答" }] },
    { role: "user", content: [{ type: "text", text: "接着问" }] },
  ] } })) { /* drain */ }
  assert.ok(!sent[1].includes("agy 自己的回答"), "agy's own reply must not be echoed back");
  assert.match(sent[1], /assistant:\n别的模型的回答/);
  assert.match(sent[1], /user:\n接着问/);
});

test("Antigravity drops a re-rendered duplicate from the final response", async () => {
  // Observed in the wild: the CLI streamed the answer once, then its final
  // `result.response` carried the same answer a second time re-rendered (the
  // two copies differed only in ASCII box widths), and the append-only merge
  // printed the whole reply twice.
  const once = [
    "已收到你的明确反馈！针对这 4 点整理如下：",
    "",
    "┌──────────────────────────────┐",
    "│ [≡] ✦ 米云创作 | 图像 | 视频 │",
    "└──────────────────────────────┘",
    "",
    "### 一、布局定稿\n" + "左栏 360px，输入框自顶向下撑开。".repeat(6),
    "### 二、主题方案\n" + "深浅色 token 与圆角规范。".repeat(6),
  ].join("\n");
  const reRendered = once.replace(/─{10,}/g, "─".repeat(46)).replace("已收到", "已收到");
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: { state: "ACTIVE", step_type: "agent_response", text_delta: once },
      });
      yield JSON.stringify({
        event: "step_update",
        step_update: { state: "DONE", step_type: "agent_response", usage: { input_tokens: 10, output_tokens: 5 } },
      });
      // Final response repeats the same answer, reflowed.
      yield JSON.stringify({
        event: "result",
        result: { status: "SUCCESS", response: `${once}\n${reRendered}`, usage: { input_tokens: 10, output_tokens: 5 } },
      });
    },
  });
  const stream = await executor({
    request: { messages: [{ role: "user", content: [{ type: "text", text: "定稿方案" }] }] },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  assert.equal(text.split("已收到你的明确反馈").length - 1, 1, "answer must appear exactly once");
  assert.ok(text.includes("布局定稿"));
});

test("Antigravity repeat ratio ignores whitespace reflows but keeps new text", () => {
  const a = "左栏 360px，输入框自顶向下撑开。".repeat(20);
  const reflowed = a.replace(/，/g, "， ").replace(/。/g, "。 ");
  assert.ok(antigravityRepeatRatio(a, reflowed) >= 0.8);
  assert.ok(antigravityRepeatRatio(a, "完全不同的新内容。".repeat(40)) < 0.2);
});

test("Antigravity keeps streamed text when the upstream ends in ERROR", async () => {
  // Observed: the upstream dropped streamGenerateContent with EOF after most of
  // the answer had been generated; the turn then failed and threw away visible
  // content. Partial text must survive, with a short explanation appended.
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({
        event: "step_update",
        step_update: { state: "ACTIVE", step_type: "agent_response", text_delta: "已经写完一大半的实现方案……" },
      });
      yield JSON.stringify({
        event: "result",
        result: { status: "ERROR", response: "", error: "Post \"https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent\": EOF" },
      });
    },
  });
  const stream = await executor({
    request: { messages: [{ role: "user", content: [{ type: "text", text: "写方案" }] }] },
  });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const text = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  assert.match(text, /已经写完一大半的实现方案/);
  assert.match(text, /本轮被上游中断/);
  assert.equal(chunks.at(-1).type, "finish");
});

test("Antigravity still fails a run that produced nothing before ERROR", async () => {
  const executor = createAntigravityCliExecutor({
    cliPath: "agy-test",
    streamCommandRunner: async function* () {
      yield JSON.stringify({ event: "result", result: { status: "ERROR", response: "", error: "upstream EOF" } });
    },
  });
  const stream = await executor({
    request: { messages: [{ role: "user", content: [{ type: "text", text: "写方案" }] }] },
  });
  await assert.rejects(
    async () => { for await (const _c of stream) { /* drain */ } },
    (error) => error.code === "ANTIGRAVITY_CLI_FAILED",
  );
});

test("Antigravity mirrors write_file so implementation turns are not auto-denied", () => {
  // Denial observed in the wild: "user denied permission for write_file(...)"
  // while the agent was implementing a plan.
  assert.ok(ANTIGRAVITY_DEFAULT_ALLOW_RULES.includes("write_file(/)"));
});
