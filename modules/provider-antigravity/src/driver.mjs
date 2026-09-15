import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { createBrowserOAuthAuthorizer } from "../../../packages/oauth/src/browser-oauth-authorizer.mjs";
import { createCredentialRef } from "../../../packages/vault/src/index.mjs";
import {
  contentHasImageInCurrentTurn,
  unsupportedContentError,
} from "../../../packages/providers/src/cli-agent-transport.mjs";
import {
  addSecondsIso,
  assertSecureEndpointUrl,
  finiteNumber,
  isoFromEpoch,
  recursiveQuotaWindows,
  redactError,
  registryCatalogModels,
  selectPrimaryQuotaWindow,
  stringValue,
} from "../../../packages/providers/src/provider-utils.mjs";
import {
  OFFICIAL_SESSION_AUTH_KIND,
  OFFICIAL_SESSION_SOURCE_KINDS,
  isOfficialSessionAuthKind,
  officialSessionResources,
} from "../../../packages/providers/src/session-source.mjs";
import {
  createAntigravityNativeQuotaReader,
  invalidateAntigravityKeychainCache,
  readAntigravityTokenFile,
  resolveAntigravityAccessToken,
} from "./native-transport.mjs";

const PROVIDER_ID = "antigravity";
const DEFAULT_CLI = "agy";
const DEFAULT_CATALOG_TTL_MS = 60_000;
const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const CREDENTIAL_SLOT = Symbol("dockyard-antigravity-session");
const ANTIGRAVITY_CREDENTIAL_REFRESH_MODES = Object.freeze({
  DSH_BROWSER_OAUTH: "dockyard_browser_oauth",
  AGY_SESSION: "agy_session",
});
// Antigravity's CLI keeps OAuth in the OS keyring by default. That is a poor
// boundary for a host process that also needs the rotated bearer token: the
// keyring can refresh successfully while the legacy token file stays stale.
// The official CLI supports this switch for a file-backed session, allowing
// DSH to mirror the same rotation into its own secure credential store.
const AGY_FILE_STORAGE_ENV = "GEMINI_FORCE_FILE_STORAGE";
const ANTIGRAVITY_BROWSER_CLIENT_ID = process.env.DOCKYARD_ANTIGRAVITY_CLIENT_ID || "";
const ANTIGRAVITY_BROWSER_CLIENT_SECRET = process.env.DOCKYARD_ANTIGRAVITY_CLIENT_SECRET || "";
const ANTIGRAVITY_BROWSER_AUTHORIZATION_URL = process.env.DOCKYARD_ANTIGRAVITY_AUTHORIZATION_URL
  || "https://accounts.google.com/o/oauth2/v2/auth";
const ANTIGRAVITY_BROWSER_TOKEN_URL = process.env.DOCKYARD_ANTIGRAVITY_TOKEN_URL
  || "https://oauth2.googleapis.com/token";
const ANTIGRAVITY_BROWSER_USERINFO_URL = process.env.DOCKYARD_ANTIGRAVITY_USERINFO_URL
  || "https://www.googleapis.com/oauth2/v1/userinfo?alt=json";
const ANTIGRAVITY_BROWSER_REDIRECT_URI = process.env.DOCKYARD_ANTIGRAVITY_REDIRECT_URI
  || "http://localhost:51121/oauth-callback";
const ANTIGRAVITY_BROWSER_SCOPES = process.env.DOCKYARD_ANTIGRAVITY_OAUTH_SCOPE
  || [
    // The same OAuth token is used both for userinfo and Google's Code Assist
    // endpoints. Keep the upstream API scope instead of authorizing a token
    // that can identify the user but cannot call streamGenerateContent.
    "https://www.googleapis.com/auth/cloud-platform",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
  ].join(" ");

// agy models currently returns only id/name rows. These pinned capacities
// mirror Google's published model card and act purely as a capacity overlay:
// mergedAntigravityRegistry attaches them only when the live directory itself
// references the id, so the fallback can never invent a callable model.
// Source: https://deepmind.google/models/model-cards/gemini-3-7-flash/
const OFFICIAL_ANTIGRAVITY_MODEL_METADATA = Object.freeze([
  Object.freeze({
    id: "gemini-3.7-flash",
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  }),
]);

// agy checks for a real TTY before it starts its first-party OAuth bootstrap.
// This tiny hidden helper gives agy a PTY and keeps DSH's pipe on the outside;
// it does not open Terminal or expose a command window to the user.
const ANTIGRAVITY_PTY_SCRIPT = String.raw`
import os
import pty
import select
import signal
import sys

command = sys.argv[1]
command_args = sys.argv[1:]
child_pid, pty_fd = pty.fork()
if child_pid == 0:
    os.execvpe(command, command_args, os.environ)

def terminate(_signum, _frame):
    try:
        os.kill(child_pid, signal.SIGTERM)
    except OSError:
        pass
    os._exit(143)

signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
stdin_open = True
exit_code = 1
try:
    while True:
        inputs = [pty_fd]
        if stdin_open:
            inputs.append(0)
        ready, _, _ = select.select(inputs, [], [], 0.25)
        if pty_fd in ready:
            try:
                data = os.read(pty_fd, 8192)
            except OSError:
                data = b""
            if not data:
                break
            os.write(1, data)
        if stdin_open and 0 in ready:
            data = os.read(0, 8192)
            if data:
                os.write(pty_fd, data)
            else:
                stdin_open = False
        waited_pid, status = os.waitpid(child_pid, os.WNOHANG)
        if waited_pid:
            exit_code = os.waitstatus_to_exitcode(status)
            break
finally:
    try:
        os.close(pty_fd)
    except OSError:
        pass
    try:
        os.kill(child_pid, signal.SIGTERM)
    except OSError:
        pass
sys.exit(exit_code)
`;

function hash(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function normalizeEmail(value) {
  const email = String(value ?? "").trim();
  return email.match(EMAIL_PATTERN)?.[0] ?? null;
}

function findEmailField(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (/email/i.test(key)) {
      const direct = normalizeEmail(nested);
      if (direct) return direct;
    }
    const child = findEmailField(nested, depth + 1, seen);
    if (child) return child;
  }
  return null;
}

/**
 * Antigravity's local token file has no account profile. The official CLI may
 * still return the authenticated email in its structured/status output or
 * stderr. Read only that identity field; never scrape or expose token text.
 */
export function extractAntigravityAccountEmail(...values) {
  for (const value of values) {
    const direct = normalizeEmail(
      value?.email
        ?? value?.account?.email
        ?? value?.user?.email
        ?? value?.identity?.email
        ?? value?.accountEmail
        ?? value?.userEmail
        ?? value?.email_address
        ?? value?.command?.data?.email
        ?? value?.command?.data?.email_address,
    );
    if (direct) return direct;
    const nested = findEmailField(value);
    if (nested) return nested;
    const text = typeof value === "string" ? value : "";
    const explicit = text.match(
      /(?:applyAuthResult:\s*)?email\s*=\s*([^\s,;]+)|authenticated\s+successfully\s+as\s+([^\s,;]+)/i,
    );
    const matched = normalizeEmail(explicit?.[1] ?? explicit?.[2]);
    if (matched) return matched;
  }
  return null;
}

function sessionFingerprint(session) {
  // Prefer a stable identity (email) when the local session exposes one so a
  // token rotation by the official client does not invalidate the fingerprint.
  // The raw token hash remains the fallback for sessions without identity.
  const email = typeof session?.email === "string" && session.email.length > 0
    ? session.email
    : null;
  const token = typeof session?.token === "string" && session.token.length > 0
    ? session.token
    : null;
  if (email) return hash(`antigravity-session:email:${email.toLowerCase()}`).slice(0, 10).toUpperCase();
  return token ? hash(`antigravity-session:${token}`).slice(0, 10).toUpperCase() : null;
}

function activeSessionError(message, { mismatch = false } = {}) {
  const error = new Error(message);
  error.authExpired = true;
  if (mismatch) error.accountMismatch = true;
  return error;
}

function sameEmail(left, right) {
  const a = normalizeEmail(left)?.toLowerCase();
  const b = normalizeEmail(right)?.toLowerCase();
  return Boolean(a && b && a === b);
}

function tokenExpiresAt(tokens, now = new Date()) {
  return isoFromEpoch(tokens?.expiresAt ?? tokens?.expires_at)
    ?? addSecondsIso(tokens?.expires_in ?? tokens?.expiresIn, now);
}

function tokenNeedsRefresh(credential, now, leewayMs = 60_000) {
  if (!credential?.refresh) return false;
  if (!credential.expiresAt) return true;
  const expiresAt = Date.parse(credential.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime() + leewayMs;
}

function officialAntigravityTokenPath(environment) {
  const home = environment?.HOME || homedir();
  return environment?.DOCKYARD_ANTIGRAVITY_TOKEN_FILE
    || join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function agyRefreshEnvironment(environment, tokenPath) {
  return {
    ...environment,
    DOCKYARD_ANTIGRAVITY_TOKEN_FILE: tokenPath,
    [AGY_FILE_STORAGE_ENV]: "true",
    AGY_CLI_HIDE_ACCOUNT_INFO: "1",
  };
}

function credentialRefreshMode(account) {
  const explicit = account?.resources?.credentialRefreshMode;
  if (explicit) return explicit;
  // Accounts imported before credentialRefreshMode was persisted still carry
  // the captured marker from agy's isolated browser profile. Treat those
  // legacy records as agy sessions instead of attempting a DSH OAuth refresh
  // with the wrong client credentials.
  return account?.resources?.sessionPersistence === "captured"
    ? ANTIGRAVITY_CREDENTIAL_REFRESH_MODES.AGY_SESSION
    : null;
}

function cliFailure(code, signal, output, errorOutput) {
  const error = new Error(`Antigravity CLI failed (${signal ?? code ?? "no exit status"})`);
  error.code = code ?? "ANTIGRAVITY_CLI_EXIT";
  const structured = parseJsonOutput(output);
  const structuredDetail = structured?.error
    ?? structured?.response
    ?? structured?.result?.error
    ?? structured?.result?.response;
  error.detail = trimDetail(errorOutput || structuredDetail);
  return error;
}

function runCommand(command, args, {
  env = process.env,
  timeoutMs = 30_000,
  signal,
  includeAccountInfo = false,
} = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...env };
    if (includeAccountInfo) delete childEnv.AGY_CLI_HIDE_ACCOUNT_INFO;
    else childEnv.AGY_CLI_HIDE_ACCOUNT_INFO ??= "1";
    const child = spawn(command, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    let killTimer = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* process is already gone */ }
      // A CLI that ignores SIGTERM must not leave this promise pending forever;
      // escalate to SIGKILL after a short grace period.
      killTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* process is already gone */ }
      }, 2_000);
      killTimer.unref?.();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      reject(error);
    });
    child.on("close", (code, closeSignal) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8");
      if (!timedOut && code === 0) {
        resolve({ output, errorOutput });
        return;
      }
      const failure = cliFailure(code, closeSignal, output, errorOutput);
      if (timedOut) failure.message = `Antigravity CLI timed out after ${timeoutMs}ms`;
      reject(failure);
    });
  });
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    // The official CLI normally emits one JSON document. If a launcher adds
    // an informational line, accept the last complete JSON line without
    // weakening the structured response contract.
    for (const line of String(output).split(/\r?\n/).reverse()) {
      if (!line.trim()) continue;
      try {
        return JSON.parse(line);
      } catch {
        // Keep looking for the structured document.
      }
    }
    return null;
  }
}

function runStreamingCommand(command, args, { env = process.env, timeoutMs = 300_000, signal, stdin, onStderr } = {}) {
  return (async function* lines() {
    // A long prompt must not ride in argv (`spawn E2BIG`); it arrives as NDJSON
    // on stdin instead, so the pipe only exists for that transport.
    const input = typeof stdin === "string" ? stdin : null;
    const child = spawn(command, args, {
      env: { ...env, AGY_CLI_HIDE_ACCOUNT_INFO: "1" },
      stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
    // A CLI that refuses the turn (unknown model, denied permission) exits
    // before draining stdin; that surfaces as EPIPE, which is expected here and
    // must never escape as an unhandled stream error.
    child.stdin?.on("error", () => { /* the CLI stopped reading */ });
    if (input !== null) child.stdin.end(input);
    const stdout = [];
    const stderr = [];
    let spawnError = null;
    let timedOut = false;
    let closedResult = null;
    let forceTimer = null;
    let timer = null;
    let terminationRequested = false;
    const terminate = () => {
      if (closedResult || terminationRequested) return;
      terminationRequested = true;
      try { child.kill("SIGTERM"); } catch { /* process is already gone */ }
      forceTimer = setTimeout(() => {
        if (!closedResult) {
          try { child.kill("SIGKILL"); } catch { /* process is already gone */ }
        }
      }, 1_000);
      forceTimer.unref?.();
    };
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      // Diagnostics only: a CLI that exits 0 without output explains itself on
      // stderr (auto-denied permission), and the caller needs that text.
      if (typeof onStderr === "function") {
        try {
          onStderr(chunk);
        } catch {
          // Never let a diagnostic sink break the run.
        }
      }
    });
    child.once("error", (error) => {
      spawnError = error;
    });
    const closed = new Promise((resolve) => {
      child.once("close", (code, closeSignal) => {
        closedResult = { code, signal: closeSignal };
        clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
        resolve(closedResult);
      });
    });
    const reader = createInterface({ input: child.stdout });
    try {
      for await (const line of reader) {
        stdout.push(line);
        yield line;
      }
    } finally {
      reader.close();
      terminate();
      clearTimeout(timer);
      // Do not let the caller start the next turn while this CLI is still
      // dying: a forwarded tool call ends the process with SIGTERM, and a fast
      // tool (echo, a cached read) would otherwise race the shutdown — the CLI
      // then answers the next turn with status "interrupted". Bounded by the
      // SIGKILL escalation, and never longer than the grace period.
      await Promise.race([closed, delay(2_000)]);
    }
    const result = await closed;
    const output = stdout.join("\n");
    const errorOutput = Buffer.concat(stderr).toString("utf8");
    if (spawnError) throw spawnError;
    // A killed CLI can still report exit code 0 (`agy` exits cleanly on
    // SIGTERM), so the timeout must be checked before the exit code or a
    // half-finished turn is silently treated as a complete empty response.
    if (timedOut) {
      const timeoutError = new Error(`Antigravity CLI timed out after ${timeoutMs}ms`);
      timeoutError.code = "TIMEOUT";
      timeoutError.detail = trimDetail(errorOutput);
      throw timeoutError;
    }
    if (result.code !== 0) {
      throw cliFailure(result.code, result.signal, output, errorOutput);
    }
  })();
}

/** Bound one diagnostic string for error.detail without losing its head. */
function trimDetail(value, limit = 300) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
}

/** Unref'd delay used to bound a best-effort wait. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function normalizeToken(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function modelTier(model) {
  const labelMatch = /\(([^()]+)\)\s*$/.exec(model.name ?? "");
  if (!labelMatch) return null;
  const idParts = model.id.split("-");
  const id = idParts.at(-1);
  const label = labelMatch[1].trim();
  if (!id || !label || normalizeToken(id) !== normalizeToken(label)) return null;
  return { id, name: label };
}

/**
 * Convert the provider's exact model rows into DSH model metadata. A reasoning
 * selector is added only when the provider actually returned multiple rows in
 * one dynamically discovered family; no model names or tier vocabulary are
 * embedded in Dockyard.
 */
export function parseAntigravityModelCatalog(output) {
  const rows = String(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^fetching available models/i.test(line))
    .map((line) => {
      const [id, ...nameParts] = line.split("\t");
      return { id, name: nameParts.join("\t") || id };
    })
    .filter((model) => model.id);

  const families = new Map();
  for (const model of rows) {
    const tier = modelTier(model);
    if (!tier) continue;
    const familyId = model.id.slice(0, -(tier.id.length + 1));
    const family = families.get(familyId) ?? new Map();
    family.set(tier.id, tier);
    families.set(familyId, family);
  }

  return rows.map((model) => {
    const tier = modelTier(model);
    if (!tier) return model;
    const familyId = model.id.slice(0, -(tier.id.length + 1));
    const family = families.get(familyId);
    if (!family || family.size < 2) return model;
    const efforts = [...family.values()];
    return {
      ...model,
      reasoning: {
        efforts: efforts.map((effort) => ({ id: effort.id, name: effort.name })),
        defaultEffort: tier.id,
      },
    };
  });
}

function registryModels(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.models)) return value.models;
  return [];
}

function mergedAntigravityRegistry(registry, liveModelIds = []) {
  const byId = new Map();
  for (const candidate of registryModels(registry)) {
    if (!candidate || typeof candidate.id !== "string" || candidate.id.length === 0) continue;
    const defined = Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined && value !== null));
    byId.set(candidate.id, { ...(byId.get(candidate.id) ?? {}), ...defined });
  }
  // The pinned model card is supplemental metadata, never a source of model
  // ids: attach a pinned row only when the live directory lists the id itself
  // or returns a reasoning tier of that family. Otherwise a retired upstream
  // model would stay callable on paper while the provider no longer serves it.
  for (const official of OFFICIAL_ANTIGRAVITY_MODEL_METADATA) {
    const referenced = byId.has(official.id)
      || liveModelIds.some((id) => id === official.id || id.startsWith(`${official.id}-`));
    if (!referenced) continue;
    byId.set(official.id, { ...official, ...(byId.get(official.id) ?? {}) });
  }
  return [...byId.values()];
}

function catalogScopeKey(accounts) {
  const accountIds = (Array.isArray(accounts) ? accounts : [])
    .map((account) => typeof account?.accountId === "string" ? account.accountId : "")
    .filter(Boolean)
    .sort();
  return accountIds.length > 0
    ? `accounts:${hash(accountIds.join("\n")).slice(0, 32)}`
    : "unscoped";
}

function defaultAntigravityCatalogCachePath({ env = process.env, home = homedir() } = {}) {
  const dockyardHome = env.DOCKYARD_DSH_HOME || join(home, ".dockyard-dsh");
  return join(dockyardHome, "antigravity-catalog.json");
}

function persistableCatalog(value) {
  return {
    models: Array.isArray(value?.models) ? value.models : [],
    source: typeof value?.source === "string" ? value.source : "official_antigravity_cli",
  };
}

async function readAntigravityCatalogCache(filePath) {
  if (!filePath) return { schema: 1, entries: {} };
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return {
      schema: 1,
      entries: parsed?.entries && typeof parsed.entries === "object" ? parsed.entries : {},
    };
  } catch {
    return { schema: 1, entries: {} };
  }
}

async function writeAntigravityCatalogCache(filePath, cache) {
  if (!filePath) return;
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const entries = Object.entries(cache.entries ?? {}).slice(-8);
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify({ schema: 1, entries: Object.fromEntries(entries) }), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, filePath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

function registryMatch(model, registry) {
  const candidates = registryModels(registry)
    .filter((candidate) => candidate && typeof candidate.id === "string" && candidate.id.length > 0)
    .filter((candidate) => model.id === candidate.id || model.id.startsWith(`${candidate.id}-`))
    .sort((left, right) => right.id.length - left.id.length);
  const exact = candidates.find((candidate) => candidate.id === model.id);
  if (exact) return exact;

  // A live provider row may encode a returned reasoning tier in its model id
  // (for example, a family row ending in the provider-returned effort id).
  // Only use a registry family match when that suffix is itself present in
  // the live catalog's effort set; this avoids guessing across unrelated ids.
  const family = candidates[0];
  if (!family || !model.reasoning?.efforts?.length) return null;
  const suffix = model.id.slice(family.id.length + 1);
  return model.reasoning.efforts.some((effort) => normalizeToken(effort.id) === normalizeToken(suffix))
    ? family
    : null;
}

/**
 * Fill only metadata absent from the provider's live model rows. The live
 * Antigravity catalog remains authoritative for ids, names, and reasoning
 * tiers; a registry is used solely as a second, inspectable source for
 * capacities/modalities when the CLI omits them.
 */
export function enrichAntigravityModelCatalog(models, registry) {
  return (Array.isArray(models) ? models : []).map((model) => {
    const match = registryMatch(model, registry);
    if (!match) return model;
    const contextWindow = finiteNumber(model.contextWindow ?? match.contextWindow ?? match.context_window ?? match.context_length);
    const maxTokens = finiteNumber(model.maxTokens ?? match.maxTokens ?? match.max_tokens ?? match.max_output_tokens);
    const inputModalities = Array.isArray(model.inputModalities)
      ? model.inputModalities
      : Array.isArray(match.input) ? match.input : undefined;
    return {
      ...model,
      ...(Number.isInteger(contextWindow) ? { contextWindow } : {}),
      ...(Number.isInteger(maxTokens) ? { maxTokens } : {}),
      ...(inputModalities?.length ? { inputModalities: [...inputModalities] } : {}),
    };
  });
}

/** Cache live provider output, persist account-scoped metadata, and collapse concurrent reads. */
export function createAntigravityCatalogLoader({
  cliPath = process.env.DOCKYARD_ANTIGRAVITY_CLI || DEFAULT_CLI,
  env = process.env,
  home = homedir(),
  cacheFilePath = env.DOCKYARD_ANTIGRAVITY_CATALOG_CACHE
    ?? defaultAntigravityCatalogCachePath({ env, home }),
  timeoutMs = 30_000,
  cacheTtlMs = Number(process.env.DOCKYARD_ANTIGRAVITY_CATALOG_TTL_MS) || DEFAULT_CATALOG_TTL_MS,
  commandRunner = runCommand,
  registryLoader = null,
} = {}) {
  const cached = new Map();
  const pending = new Map();
  const pendingRefreshes = new Set();
  let persistentPromise = null;
  let persistentCache = null;
  let persistWrite = Promise.resolve();

  const loadPersistent = () => {
    persistentPromise ??= readAntigravityCatalogCache(cacheFilePath).then((value) => {
      persistentCache = value;
      return value;
    });
    return persistentPromise;
  };

  const persist = (scope, value) => {
    if (!cacheFilePath || !Array.isArray(value?.models) || value.models.length === 0) return Promise.resolve();
    persistWrite = persistWrite.then(async () => {
      const cache = await loadPersistent();
      cache.entries[scope] = {
        fetchedAt: new Date().toISOString(),
        value: persistableCatalog(value),
      };
      const scopes = Object.keys(cache.entries);
      if (scopes.length > 8) {
        for (const staleScope of scopes.slice(0, scopes.length - 8)) delete cache.entries[staleScope];
      }
      await writeAntigravityCatalogCache(cacheFilePath, cache);
    }).catch(() => {});
    return persistWrite;
  };

  async function registryFallbackModels() {
    if (typeof registryLoader !== "function") return [];
    let registry;
    try {
      registry = await registryLoader();
    } catch {
      // The registry is an optional fallback source; a broken registry must
      // never fail the provider catalog it is meant to back up.
      return [];
    }
    return registryCatalogModels(
      registry,
      (model) => model.provider === "google" || model.provider === "google-vertex",
    );
  }

  const refresh = (scope) => {
    if (pending.has(scope)) return pending.get(scope);
    const promise = Promise.resolve(commandRunner(cliPath, ["models"], {
      env,
      timeoutMs,
    })).then(async (result) => {
      let registry = [];
      if (typeof registryLoader === "function") {
        try {
          registry = await registryLoader();
        } catch {
          // The optional registry must never prevent the official CLI catalog
          // from loading. The provider's own rows remain usable without it.
        }
      }
      const liveModels = parseAntigravityModelCatalog(result.output);
      const models = enrichAntigravityModelCatalog(
        liveModels,
        mergedAntigravityRegistry(registry, liveModels.map((model) => model.id)),
      );
      if (models.length > 0) {
        const enriched = models.some((model, index) => {
          const original = liveModels[index];
          return model.contextWindow !== original?.contextWindow || model.maxTokens !== original?.maxTokens;
        });
        const value = {
          models,
          source: enriched ? "official_antigravity_cli+model_registry" : "official_antigravity_cli",
        };
        cached.set(scope, { value, cachedAt: Date.now() });
        await persist(scope, value);
        return value;
      }
      const fallback = await registryFallbackModels();
      if (fallback.length > 0) {
        const value = { models: fallback, source: "dsh_live_provider_registry" };
        cached.set(scope, { value, cachedAt: Date.now() });
        return value;
      }
      const empty = {
        models: [],
        source: "official_antigravity_cli",
        diagnostics: ["Antigravity 官方 CLI 没有返回可用模型"],
      };
      cached.set(scope, { value: empty, cachedAt: Date.now() });
      return empty;
    }).catch(async (error) => {
      const previous = cached.get(scope)?.value;
      if (previous?.models?.length) {
        // A previously published catalog stays selectable when the optional
        // CLI is missing. Do not attach diagnostics: the toast treats any
        // diagnostic as a failed vendor read.
        return previous;
      }
      const fallback = await registryFallbackModels();
      if (fallback.length > 0) {
        const value = { models: fallback, source: "dsh_live_provider_registry" };
        cached.set(scope, { value, cachedAt: Date.now() });
        return value;
      }
      const unavailable = {
        models: [],
        source: error?.code === "ENOENT"
          ? "antigravity_cli_not_found"
          : "antigravity_cli_unavailable",
        diagnostics: [redactError(error)],
      };
      cached.set(scope, { value: unavailable, cachedAt: Date.now() });
      return unavailable;
    }).finally(() => {
      pending.delete(scope);
    });
    pendingRefreshes.add(promise);
    promise.finally(() => pendingRefreshes.delete(promise)).catch(() => {});
    pending.set(scope, promise);
    return promise;
  };

  const loadCatalog = async function loadCatalog({ force = false, accounts = [] } = {}) {
    const scope = catalogScopeKey(accounts);
    let entry = cached.get(scope);
    if (!entry) {
      const persisted = await loadPersistent();
      const stored = persistentCache?.entries?.[scope] ?? persisted.entries?.[scope];
      if (stored?.value && Array.isArray(stored.value.models)) {
        entry = {
          value: {
            ...stored.value,
            source: `${stored.value.source ?? "official_antigravity_cli"}_persistent_cache`,
          },
          cachedAt: 0,
        };
        cached.set(scope, entry);
      }
    }

    const fresh = entry && entry.cachedAt > 0 && Date.now() - entry.cachedAt < cacheTtlMs;
    if (!force && fresh) return entry.value;
    if (!force && entry) {
      void refresh(scope).catch(() => {});
      return entry.value;
    }
    return refresh(scope);
  };
  // Background refreshes are intentionally fire-and-forget for the runtime.
  // Callers that need determinism (tests, shutdown) can await whenIdle() to
  // settle every in-flight refresh and its persisted catalog write.
  loadCatalog.whenIdle = async () => {
    await Promise.allSettled([...pendingRefreshes]);
    await persistWrite.catch(() => {});
  };
  return loadCatalog;
}

function familyPrefixForModel(model) {
  const defaultEffort = model?.reasoning?.defaultEffort;
  if (typeof defaultEffort !== "string" || defaultEffort.length === 0) return null;
  const suffix = `-${defaultEffort}`;
  return model.id.endsWith(suffix) ? model.id.slice(0, -suffix.length) : null;
}

/**
 * Antigravity exposes tiered Gemini rows as exact model IDs. Resolve a DSH
 * model+effort pair to the exact returned row and omit --effort; the CLI
 * rejects passing an encoded tier together with a different effort flag.
 */
export async function resolveAntigravityInvocationModel({ catalogLoader, model, reasoningEffort } = {}) {
  if (typeof model !== "string" || typeof reasoningEffort !== "string" || !catalogLoader) {
    return { model, reasoningEffort };
  }
  try {
    const catalog = await catalogLoader();
    const selected = catalog?.models?.find((candidate) => candidate?.id === model);
    const prefix = familyPrefixForModel(selected);
    if (!selected || !prefix) return { model, reasoningEffort };
    const target = catalog.models.find((candidate) => {
      return candidate?.id?.startsWith(`${prefix}-`)
        && candidate.reasoning?.defaultEffort === reasoningEffort;
    });
    if (!target) return { model, reasoningEffort };
    return { model: target.id, reasoningEffort: undefined };
  } catch {
    // Catalog discovery is advisory for invocation. Keep the exact caller
    // values if the live model directory is temporarily unavailable.
    return { model, reasoningEffort };
  }
}

/**
 * Keep the native invocation model exactly as discovered. CodexSplit sends
 * Antigravity's tier-suffixed model id unchanged to streamGenerateContent;
 * the transport must not invent a family-id/thinkingLevel translation.
 *
 * The helper remains exported for compatibility with callers that used the
 * earlier experimental mapping, but it is intentionally a no-op now.
 */
export async function resolveAntigravityNativeInvocationModel({ catalogLoader, model, reasoningEffort } = {}) {
  return { model, reasoningEffort };
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  // Tool blocks must be recognized before the generic `content` unwrap below:
  // a tool-result also owns a `content` array, which otherwise swallows the
  // block and drops the call-id label that pairs output with its command.
  if (value.type === "tool-call") {
    // `arguments` is usually an object; string interpolation would render it as
    // "[object Object]", hiding WHICH command the assistant already ran. The
    // model then re-issues the identical call every turn and burns quota.
    const args = typeof value.arguments === "string"
      ? value.arguments
      : JSON.stringify(value.arguments ?? {});
    return `[tool call: ${value.name ?? "unknown"}${value.id ? ` id=${value.id}` : ""}] ${args}`;
  }
  if (value.type === "tool-result") {
    const text = contentText(value.content);
    // Label every result with its call id so the model can pair each output
    // with the exact call above instead of guessing (and re-running it).
    return value.toolCallId
      ? `[tool result for id=${value.toolCallId}]\n${text}`
      : text;
  }
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string" || Array.isArray(value.content)) return contentText(value.content);
  if (value.type === "image") return "[previous image attachment omitted by Antigravity CLI]";
  return "";
}

function estimatedTokens(value) {
  const text = String(value ?? "");
  if (!text) return 0;
  // This is a safety estimate used only to avoid sending an obviously
  // oversized transcript. The actual capacity always comes from provider or
  // registry metadata; this is not a model-specific context constant.
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function messageText(message) {
  return contentText(message?.content ?? message?.text);
}

function messagesWithinContext(request) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const contextWindow = finiteNumber(request.modelContext?.contextWindow);
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return messages;
  const outputBudget = finiteNumber(request.maxTokens ?? request.modelContext?.maxTokens);
  const inputBudget = contextWindow - (Number.isInteger(outputBudget) ? outputBudget : 0);
  if (inputBudget <= 0) return messages.slice(-1);

  const systemMessages = messages.filter((message) => message?.role === "system");
  const otherMessages = messages.filter((message) => message?.role !== "system");
  let used = estimatedTokens(request.system);
  for (const message of systemMessages) used += estimatedTokens(messageText(message));
  if (used + otherMessages.reduce((sum, message) => sum + estimatedTokens(messageText(message)), 0) <= inputBudget) {
    return messages;
  }

  const selected = [];
  for (let index = otherMessages.length - 1; index >= 0; index -= 1) {
    const message = otherMessages[index];
    const cost = estimatedTokens(messageText(message));
    if (selected.length === 0 || used + cost <= inputBudget) {
      selected.unshift(message);
      used += cost;
    }
  }
  return [...systemMessages, ...selected];
}

// The CLI is spawned statelessly once per turn with the whole transcript
// flattened into a single prompt. Without these rules the model treats its own
// past "[tool call]" lines as reference material instead of completed work:
// it re-runs similar commands every turn, never narrates, and never converges
// on a final answer (the "endless silent Bash turns" incident).
const ANTIGRAVITY_TRANSCRIPT_RULES = [
  "rules:",
  "- 历史记录里你已经执行过的命令及其输出仅供参考：不要重复执行相同或相似的命令。",
  "- 拿到最近的命令输出后，如果信息已经足以回答用户，必须直接输出最终结论，禁止再发起任何工具调用。",
  "- 需要执行命令时，必须通过原生工具调用发起；绝对不要在回复文本里书写工具调用或命令的执行请求。",
  "- 每次发起工具调用前，先用一句话向用户说明你要做什么、为什么。",
  "- 最终结论必须直接回应最初的用户问题，使用用户的语言，而不是复述调查过程。",
].join("\n");

// Mid-conversation turns replay the whole flattened history in one prompt, and
// agy's per-turn latency scales roughly linearly with that input (measured:
// 113 KiB ≈ 46k tokens ≈ 27 s generation, before tool work). A day-long
// session therefore blows past the executor's 300 s kill and looks like a
// silent hang, while fresh (short) conversations work fine. Capping the
// message history keeps every turn in the regime that is verified to work;
// the system section and the newest turns always survive.
export const AGY_PROMPT_HISTORY_BYTE_CAP = 60_000;

export function antigravityRequestPrompt(request = {}) {
  const header = [];
  if (typeof request.system === "string" && request.system.length > 0) {
    header.push(`system:\n${request.system}`);
  }
  header.push(ANTIGRAVITY_TRANSCRIPT_RULES);
  const messageSections = [];
  for (const message of messagesWithinContext(request)) {
    const text = messageText(message);
    if (!text) continue;
    messageSections.push(`${message?.role ?? "message"}:\n${text}`);
  }
  // Drop the OLDEST message sections until the flattened prompt fits the cap.
  let sections = [...header, ...messageSections];
  let drop = 0;
  while (
    messageSections.length > 0
    && Buffer.byteLength(sections.join("\n\n"), "utf8") > AGY_PROMPT_HISTORY_BYTE_CAP
    && drop < messageSections.length
  ) {
    drop += 1;
    sections = [...header, ...messageSections.slice(drop)];
  }
  return sections.join("\n\n") || "Continue the conversation.";
}

/**
 * Sideband requests are harness bookkeeping that happens to travel through the
 * same provider+session: session titles (`purpose: "session-title"`) and
 * compaction summaries (`purpose: "compaction"`). They must never touch the
 * anchored agy conversation — a title prompt inside the user's memory is
 * pollution — and they do not need the replay machinery beyond a plain
 * one-shot run.
 */
const ANTIGRAVITY_SIDEBAND_PURPOSES = new Set(["session-title", "compaction", "session-summary"]);
const ANTIGRAVITY_TITLE_SYSTEM_MARKER = /^Create a concise title for an AI coding-assistant session/m;

export function isAntigravitySidebandRequest(request = {}) {
  const purpose = typeof request?.purpose === "string" ? request.purpose.trim().toLowerCase() : "";
  if (purpose.length > 0 && purpose !== "assistant") return true;
  const system = typeof request?.system === "string" ? request.system.trim() : "";
  return ANTIGRAVITY_TITLE_SYSTEM_MARKER.test(system);
}

/**
 * Session-anchor mode (final architecture, docs/antigravity-persistent-bridge-design.md §8).
 *
 * agy's `--conversation <id>` restores full in-process memory across processes
 * (verified against agy 1.2.3), so each DSH conversation maps to one agy
 * conversation id: the first turn creates it, later turns reattach. Memory
 * lives in agy's local conversation store, so web restarts, model switches and
 * process crashes no longer lose context. The legacy flattened-replay path
 * below remains as the fallback for calls without a session id and for
 * failures of the anchored path.
 */
export function antigravityConversationsFile(env = process.env, home = homedir()) {
  return process.env.DOCKYARD_ANTIGRAVITY_CONVERSATIONS_FILE
    || env?.DOCKYARD_ANTIGRAVITY_CONVERSATIONS_FILE
    || join(home, ".dockyard-dsh", "antigravity-conversations.json");
}

export function createAntigravityConversationStore({ file, fsModule = null } = {}) {
  const syncFs = fsModule ?? { readFileSync, writeFileSync, mkdirSync, renameSync };
  let cache = null;
  const load = () => {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(syncFs.readFileSync(file, "utf8"));
      cache = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      cache = {};
    }
    return cache;
  };
  return {
    get(key) {
      if (!key) return null;
      const value = load()[key];
      return value && typeof value === "object" ? value : null;
    },
    set(key, value) {
      if (!key || !value) return;
      const data = load();
      data[key] = value;
      cache = data;
      try {
        syncFs.mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.${randomUUID()}.tmp`;
        syncFs.writeFileSync(tmp, JSON.stringify(data), "utf8");
        syncFs.renameSync(tmp, file);
      } catch {
        // Persistence is best-effort: losing the mapping only costs memory
        // continuity, the next turn simply starts a fresh agy conversation.
      }
    },
  };
}

/**
 * Bounded per-turn diagnostics for the anchored path.
 *
 * The anchored turn degrades silently by design, so without this a failed turn
 * looks exactly like "the model never answered" — the incident that motivated
 * the whole session-anchor work. Each run appends one JSON line with the CLI's
 * own evidence (events, result status, denied actions, stderr head, fallback
 * reason); the file is truncated once it exceeds the cap.
 */
export const AGY_ANCHOR_LOG_MAX_BYTES = 512 * 1024;

export function appendAntigravityAnchorLog(file, entry) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    let size = 0;
    try { size = statSync(file).size; } catch { size = 0; }
    if (size > AGY_ANCHOR_LOG_MAX_BYTES) writeFileSync(file, "", "utf8");
    writeFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { encoding: "utf8", flag: "a" });
  } catch {
    // Diagnostics must never break a turn.
  }
}

export function antigravityMessagesFingerprint(messages) {
  const list = Array.isArray(messages) ? messages : [];
  return {
    msgsLen: list.length,
    msgsHash: createHash("sha256").update(JSON.stringify(list)).digest("hex").slice(0, 32),
  };
}

/**
 * Flatten the messages newer than the anchored prefix into one user text.
 * Leading assistant messages are skipped: they are agy's own replies, which
 * its conversation memory already holds — replaying them would duplicate the
 * model's own turns inside the anchored conversation.
 */
function antigravityTailText(messages, fromLen) {
  const list = (Array.isArray(messages) ? messages : []).slice(fromLen);
  while (list.length > 0 && String(list[0]?.role ?? "").toLowerCase() === "assistant") {
    list.shift();
  }
  const parts = [];
  for (const message of list) {
    const text = contentText(message?.content ?? message?.text);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

export function antigravityAnchorInvocation({ conversationId = null, text }) {
  return {
    args: [
      ...(conversationId ? ["--conversation", conversationId] : []),
      "--input-format", "stream-json",
    ],
    stdin: `${JSON.stringify({
      event: "user",
      message: { role: "user", content: typeof text === "string" ? text : String(text ?? "") },
    })}\n`,
  };
}

/**
 * Prompt budget that still travels as `argv`.
 *
 * `execve` caps argv+env at `kern.argmax` (1 MiB on macOS) and, on Linux, caps
 * a single argv string at `MAX_ARG_STRLEN` (128 KiB). Handing agy the whole
 * conversation as `-p <prompt>` therefore dies with `spawn E2BIG` as soon as a
 * session grows past the cap — the failure is raised by the kernel before the
 * CLI even starts, so it can never be retried away. 64 KiB leaves six times
 * the headroom for the environment and stays far below the Linux per-string
 * limit; larger prompts use the CLI's NDJSON stream input on stdin instead.
 */
export const AGY_PROMPT_STDIN_THRESHOLD_BYTES = 64 * 1024;

/**
 * Resolve how one print-mode turn carries its prompt.
 *
 * Short turns keep the exact `-p <prompt>` invocation that has always been
 * verified against the official CLI. Long turns switch to
 * `--input-format stream-json` and put the prompt in a single NDJSON `user`
 * event on stdin, which removes the prompt from argv entirely.
 */
export function antigravityPromptInvocation(prompt, {
  thresholdBytes = AGY_PROMPT_STDIN_THRESHOLD_BYTES,
} = {}) {
  const text = typeof prompt === "string" ? prompt : String(prompt ?? "");
  if (Buffer.byteLength(text, "utf8") < thresholdBytes) {
    return { args: ["-p", text], stdin: null };
  }
  return {
    args: ["--input-format", "stream-json"],
    // agy's stream decoder expects `message.content` as a PLAIN STRING.
    // A content-parts array (as used by the native protocol) decodes to an
    // empty prompt and the CLI then waits forever for a usable user turn —
    // the hung `agy --input-format stream-json` processes observed in the
    // wild. Verified against agy 1.2.3 on 2026-09-15.
    stdin: `${JSON.stringify({
      event: "user",
      message: { role: "user", content: text },
    })}\n`,
  };
}

function usageFromResponse(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = Number(usage.input_tokens ?? usage.inputTokens);
  const outputTokens = Number(usage.output_tokens ?? usage.outputTokens);
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null;
  // agy reports thinking separately as `thinking_tokens` and cached input as
  // `cache_read_tokens`; DSH's TokenUsage keeps uncached input, cached input and
  // reasoning disjoint, so dropping them made every turn look like it burned
  // the whole prompt as fresh input.
  const reasoning = Number(usage.thinking_tokens ?? usage.reasoning_tokens ?? usage.reasoningTokens);
  const cacheRead = Number(usage.cache_read_tokens ?? usage.cacheReadTokens);
  const cacheWrite = Number(usage.cache_write_tokens ?? usage.cacheWriteTokens);
  return {
    inputTokens,
    outputTokens,
    ...(Number.isFinite(reasoning) ? { reasoningTokens: reasoning } : {}),
    ...(Number.isFinite(cacheRead) ? { cacheReadTokens: cacheRead } : {}),
    ...(Number.isFinite(cacheWrite) ? { cacheWriteTokens: cacheWrite } : {}),
  };
}

/** Sum two TokenUsage snapshots; agy reports per-step increments. */
function addUsage(left, right) {
  if (!right) return left ?? null;
  if (!left) return { ...right };
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (Number.isFinite(value)) merged[key] = (Number.isFinite(merged[key]) ? merged[key] : 0) + value;
  }
  return merged;
}

function streamEventTexts(payload) {
  if (!payload || typeof payload !== "object") return [];
  const eventName = String(payload.event ?? payload.type ?? "").toLowerCase();
  const allowText = /delta|message|text|content/.test(eventName)
    && !/command_result|result/.test(eventName);
  const texts = [];

  function visit(value, allowNestedText = false, key = "") {
    if (typeof value === "string") {
      if (allowNestedText && key !== "event" && key !== "type") texts.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, allowNestedText, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) {
      const normalizedKey = childKey.toLowerCase().replace(/[-_]/g, "");
      if (normalizedKey === "textdelta" || normalizedKey === "contentdelta") {
        if (typeof child === "string") texts.push(child);
        else visit(child, true, childKey);
        continue;
      }
      if (normalizedKey === "delta") {
        if (typeof child === "string") texts.push(child);
        else visit(child, true, childKey);
        continue;
      }
      if (normalizedKey === "response" || normalizedKey === "error" || normalizedKey === "usage") continue;
      if (normalizedKey === "text" && (allowNestedText || allowText)) {
        if (typeof child === "string") texts.push(child);
        continue;
      }
      if (child && typeof child === "object") {
        visit(child, allowNestedText || normalizedKey.includes("content") || normalizedKey.includes("message"), childKey);
      }
    }
  }

  visit(payload, allowText);
  return texts;
}

function streamEventResult(payload) {
  if (!payload || typeof payload !== "object") return null;
  const result = payload.result ?? payload.response;
  if (typeof result === "string") return { text: result, usage: payload.usage };
  if (!result || typeof result !== "object") return null;
  return {
    text: typeof result.response === "string" ? result.response : contentText(result.response),
    usage: result.usage ?? payload.usage,
    status: result.status,
    error: result.error,
    ...(Array.isArray(result.denied_actions)
      ? {
          deniedActions: result.denied_actions
            .map((entry) => String(entry?.action ?? entry?.name ?? entry?.tool ?? "").trim())
            .filter((action) => action.length > 0),
        }
      : {}),
  };
}

/**
 * Explain a run that ended with no text at all.
 *
 * Antigravity print mode auto-denies any tool that needs a permission prompt it
 * cannot show, then exits 0 with an empty response. Without this the harness
 * only sees "provider stream ended without substantive output" and retries a
 * deterministic failure. Codes here are deliberately outside the retryable set
 * so the turn fails once, with the reason.
 */
function antigravityEmptyOutputError({ stderr = "", deniedActions = [] } = {}) {
  const denied = [...new Set(deniedActions)];
  const hint = typeof stderr === "string" ? stderr.replace(/\s+/g, " ").trim().slice(0, 600) : "";
  if (denied.length === 0 && hint.length === 0) return null;
  const message = denied.length > 0
    ? `Antigravity CLI 未产生任何输出：需要授权的工具被自动拒绝（${denied.join(", ")}）。print/headless 模式无法弹出授权提示，请改用 DSH 已注册的同类工具重试，或在 agy 的 settings.json 中通过 permissions.allow 放行。`
    : `Antigravity CLI 未产生任何输出：${hint}`;
  const error = new Error(message);
  error.code = "ANTIGRAVITY_CLI_NO_OUTPUT";
  error.detail = hint || null;
  return error;
}

/**
 * Explain a run that produced neither text nor a forwarded tool call and left
 * no other trace.
 *
 * Returning such a turn as a plain empty message makes the harness classify it
 * as EMPTY_RESPONSE and replay the whole ~85k-token prompt up to five times
 * through five fresh CLI processes — the most expensive failure mode observed
 * in production. Every empty turn therefore fails once, non-retryably, with the
 * evidence this run actually collected.
 */
function antigravitySilentRunError({ stderr = "", events = 0, steps = 0, toolErrors = [], resultStatus = null } = {}) {
  const errorMessages = [...new Set(toolErrors)].slice(0, 3).join("；");
  const hint = typeof stderr === "string" ? stderr.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  const observed = [
    `解析到 ${events} 个事件、${steps} 个步骤`,
    resultStatus ? `result.status=${resultStatus}` : "没有 result 事件",
  ].join("，");
  const detail = errorMessages || hint || null;
  const message = detail
    ? `Antigravity CLI 本轮没有产生任何可见文本（${observed}）：${detail}。为避免重复消耗额度，本轮不会自动重试；请重发一次，或换用其它模型。`
    : `Antigravity CLI 本轮没有产生任何可见文本，也没有工具调用（${observed}）。这通常是上游偶发空回合；为避免重复消耗额度，本轮不会自动重试，请重发一次。`;
  const error = new Error(message);
  error.code = "ANTIGRAVITY_CLI_NO_OUTPUT";
  error.detail = detail;
  return error;
}

/**
 * Antigravity CLI tool name → the DSH tool exposing the same capability.
 *
 * Print mode cannot open an interactive permission prompt, so a CLI tool the
 * user has not allow-listed is auto-denied and the run ends with an empty
 * response. Forwarding the intent to a DSH tool the request already declares
 * keeps the DSH tool loop in charge of execution and permissions, which is the
 * whole point of running the CLI behind the harness. Only tools DSH already
 * registered are ever returned, so this map grants no new authority.
 */
const ANTIGRAVITY_TOOL_TRANSLATIONS = Object.freeze({
  run_command: "bash",
  read_url_content: "web_fetch",
  search_web: "web_search",
});

/**
 * Detect a TUN proxy that answers every DNS query with a reserved address
 * (Clash / Surge / TomatoCloud "fake-IP" or enhanced mode).
 *
 * Such proxies still route those addresses correctly — the connection is
 * intercepted and tunnelled to the real host — but DSH's `web_fetch` resolves
 * the hostname first and refuses any non-public answer as an SSRF risk, so with
 * fake-IP DNS *every* fetch fails before a socket is opened. The probe asks for
 * a hostname that is public by definition and treats an all-reserved answer set
 * as "this resolver is virtualized"; a failure to resolve is not evidence.
 */
const FAKE_IP_PROBE_HOST = "example.com";
const FAKE_IP_CACHE_TTL_MS = 5 * 60 * 1000;
const fakeIpCache = new Map();

function ipv4ToInt(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) + octet) >>> 0;
  }
  return value;
}

/** Reserved/private IPv4 blocks, including the 198.18.0.0/15 fake-IP range. */
const RESERVED_V4_BLOCKS = Object.freeze([
  [0x00000000, 0xff000000], // 0.0.0.0/8
  [0x0a000000, 0xff000000], // 10.0.0.0/8
  [0x64400000, 0xffc00000], // 100.64.0.0/10 (CGNAT, Tailscale)
  [0x7f000000, 0xff000000], // 127.0.0.0/8
  [0xa9fe0000, 0xffff0000], // 169.254.0.0/16
  [0xac100000, 0xfff00000], // 172.16.0.0/12
  [0xc0a80000, 0xffff0000], // 192.168.0.0/16
  [0xc6120000, 0xfffe0000], // 198.18.0.0/15 (benchmarking / fake-IP)
]);

function isReservedAddress(address) {
  const value = ipv4ToInt(address);
  // Bitwise AND yields a signed 32-bit result; normalize before comparing.
  if (value !== null) return RESERVED_V4_BLOCKS.some(([base, mask]) => ((value & mask) >>> 0) === base);
  const normalized = String(address).trim().toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  return normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd");
}

/**
 * Report whether the local resolver is virtualized by a fake-IP proxy.
 *
 * @param {object} [options] - test seams and cache control.
 * @returns {Promise<boolean>} true when a known-public host resolved to reserved addresses only.
 */
export async function detectFakeIpEnvironment({ host = FAKE_IP_PROBE_HOST, resolver = lookup, now = () => Date.now(), useCache = true } = {}) {
  const cached = fakeIpCache.get(host);
  if (useCache && cached !== undefined && now() - cached.at < FAKE_IP_CACHE_TTL_MS) return cached.value;
  let value = false;
  try {
    const answers = await resolver(host, { all: true, order: "verbatim" });
    value = Array.isArray(answers) && answers.length > 0 && answers.every((entry) => isReservedAddress(entry?.address));
  } catch {
    // Resolution failure is not evidence of a virtualized resolver.
    value = false;
  }
  fakeIpCache.set(host, { at: now(), value });
  return value;
}

/** Quote one shell argument with single quotes, escaping embedded quotes. */
function shellQuote(value) {
  return `'${String(value).split("'").join("'\\''")}'`;
}

/** Marker that identifies this adapter's own local-fetch calls in the history. */
const LOCAL_FETCH_DESCRIPTION = "through the local network stack";

/**
 * Readable-text extractor for the local fetch: drops non-JSON-LD scripts,
 * styles and comments before stripping tags, so the model receives page copy
 * instead of minified JavaScript (which made it re-fetch the same URL).
 */
const LOCAL_FETCH_EXTRACTOR = [
  "let s=\"\";process.stdin.setEncoding(\"utf8\");",
  "process.stdin.on(\"data\",d=>s+=d);",
  "process.stdin.on(\"end\",()=>{",
  "const ent={\"&nbsp;\":\" \",\"&amp;\":\"&\",\"&lt;\":\"<\",\"&gt;\":\">\",\"&quot;\":String.fromCharCode(34),\"&#39;\":String.fromCharCode(39)};",
  "s=s.replace(/<script\\b(?![^>]*application\\/ld\\+json)[^>]*>[\\s\\S]*?<\\/script>/gi,\" \")",
  ".replace(/<style\\b[^>]*>[\\s\\S]*?<\\/style>/gi,\" \")",
  ".replace(/<!--[\\s\\S]*?-->/g,\" \")",
  ".replace(/<[^>]*>/g,\" \")",
  ".replace(/&(nbsp|amp|lt|gt|quot|#39);/g,m=>ent[m]||\" \")",
  ".replace(/[ \\t\\r\\f\\v]+/g,\" \")",
  ".replace(/\\n[ \\t]*/g,\"\\n\")",
  ".replace(/\\n{3,}/g,\"\\n\\n\");",
  "process.stdout.write(s.trim().slice(0,40000)+\"\\n\")});",
].join("");

/**
 * Read a URL through the machine's own network stack.
 *
 * The fake-IP environment described above only breaks DSH's hostname check —
 * `curl` reaches the same page fine, because the TUN proxy intercepts the
 * reserved address and tunnels the connection. This keeps the read auditable
 * (it is an ordinary `bash` tool call in the session) and grants no capability
 * the request's own tool list did not already carry.
 *
 * `--retry` covers the transient TLS/socket resets a TUN proxy produces; the
 * Node extractor is expected on any machine running this plugin, with a plain
 * tag-stripping `sed` fallback when `node` is not on PATH.
 */
function antigravityLocalFetchCommand(url) {
  return [
    `curl -sSL --retry 2 --retry-connrefused --retry-delay 1 --max-time 30 --max-filesize 5000000 -- ${shellQuote(url)}`,
    `| { if command -v node >/dev/null 2>&1; then node -e ${shellQuote(LOCAL_FETCH_EXTRACTOR)}; else sed -e 's/<[^>]*>/ /g' | tr -s '[:space:]' ' '; fi; }`,
  ].join(" ");
}

function antigravityToolCallId(update, request) {
  return String(update.tool_info?.call_id ?? update.call_id ?? `agy-${hash(JSON.stringify({ update, requestId: request.requestId ?? "" })).slice(0, 20)}`);
}

function antigravityLocalFetchToolCall(url, update, request) {
  return {
    name: "bash",
    arguments: {
      command: antigravityLocalFetchCommand(url),
      description: `Fetch ${url} ${LOCAL_FETCH_DESCRIPTION}`,
    },
    id: antigravityToolCallId(update, request),
  };
}

/** Join the text of one tool-result block. */
function toolResultText(block) {
  const content = Array.isArray(block?.content) ? block.content : [];
  return content.map((entry) => (typeof entry?.text === "string" ? entry.text : "")).join("");
}

/**
 * Whether this conversation already holds a *successful* local fetch of `url`.
 *
 * Matching the tool result by call id keeps a failed attempt (transient TLS
 * reset, HTTP error, empty body) from suppressing the retry the model needs.
 */
function urlAlreadyFetchedLocally(request, url) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const commands = new Map();
  const outputs = new Map();
  for (const message of messages) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type === "tool-call" && typeof block.id === "string") {
        commands.set(block.id, typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? ""));
      } else if (block?.type === "tool-result" && typeof block.toolCallId === "string") {
        outputs.set(block.toolCallId, toolResultText(block));
      }
    }
  }
  for (const [id, args] of commands) {
    if (!args.includes(url) || !args.includes(LOCAL_FETCH_DESCRIPTION)) continue;
    const output = outputs.get(id);
    if (typeof output !== "string") continue;
    const text = output.trim();
    if (text.length < 200) continue;
    if (/^\[stderr\]/.test(text) || /\bcurl: \(\d+\)/.test(text)) continue;
    return true;
  }
  return false;
}

/**
 * Cheap stand-in for a fetch whose content is already in the conversation.
 * Re-running the request costs a network round trip and returns byte-identical
 * text, so the model is told to work from what it already has.
 */
function antigravityRepeatFetchToolCall(url, update, request) {
  return {
    name: "bash",
    arguments: {
      command: `echo ${shellQuote(`URL ${url} was already fetched in this conversation; its text is in the matching tool result above. Use it instead of fetching again.`)}`,
      description: `Reuse the fetched content of ${url} instead of re-fetching it`,
    },
    id: antigravityToolCallId(update, request),
  };
}

function requestTool(request, providerToolName) {
  const tools = Array.isArray(request?.tools) ? request.tools : [];
  const exact = tools.find((tool) => tool?.name === providerToolName);
  if (exact) return { name: exact.name, definition: exact };
  const translated = ANTIGRAVITY_TOOL_TRANSLATIONS[providerToolName];
  if (translated) {
    const target = tools.find((tool) => tool?.name === translated);
    if (target) return { name: target.name, definition: target };
  }
  return null;
}

function toolCallFromEvent(payload, request, options = {}) {
  const update = payload?.step_update;
  if (!update || String(update.state ?? "").toUpperCase() !== "ACTIVE" || update.step_type !== "tool") return null;
  const providerName = String(update.tool_name ?? update.tool_info?.name ?? "");
  if (!providerName) return null;
  const target = requestTool(request, providerName);
  if (!target) return null;
  const raw = update.tool_info?.parameters;
  const parameters = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : {};
  if (providerName === "run_command" && target.name === "bash") {
    const command = parameters.command ?? parameters.CommandLine;
    if (typeof command === "string" && command.length > 0) {
      return {
        name: target.name,
        arguments: {
          command,
          // agy's run_command never carries a description; show a command
          // snippet instead of the opaque "Run the requested command" so the
          // UI reflects what each forwarded call actually does.
          description: parameters.description ?? parameters.Description
            ?? `运行：${command.replace(/\s+/g, " ").trim().slice(0, 80)}`,
          ...(parameters.workdir ?? parameters.Cwd ? { workdir: parameters.workdir ?? parameters.Cwd } : {}),
          ...(parameters.timeoutMs ?? parameters.TimeoutMs ? { timeoutMs: parameters.timeoutMs ?? parameters.TimeoutMs } : {}),
        },
        id: String(update.tool_info?.call_id ?? update.call_id ?? `agy-${hash(JSON.stringify({ update, requestId: request.requestId ?? "" })).slice(0, 20)}`),
      };
    }
  }
  // The CLI reads a URL under `read_url_content` with a capitalized `Url`
  // parameter; DSH's `web_fetch` takes `url`.
  if (providerName === "read_url_content" && target.name === "web_fetch") {
    const url = parameters.url ?? parameters.Url ?? parameters.URL ?? parameters.uri;
    if (typeof url === "string" && url.length > 0) {
      if (options.preferLocalUrlFetch && requestTool(request, "bash") !== null) {
        if (urlAlreadyFetchedLocally(request, url)) {
          return antigravityRepeatFetchToolCall(url, update, request);
        }
        return antigravityLocalFetchToolCall(url, update, request);
      }
      return {
        name: target.name,
        arguments: { url },
        id: String(update.tool_info?.call_id ?? update.call_id ?? `agy-${hash(JSON.stringify({ update, requestId: request.requestId ?? "" })).slice(0, 20)}`),
      };
    }
  }
  // The CLI searches with a single `query` string; DSH's `web_search` takes a
  // required `queries` array (1–4 entries).
  if (providerName === "search_web" && target.name === "web_search") {
    const query = parameters.query ?? parameters.Query ?? parameters.q;
    const queries = Array.isArray(parameters.queries)
      ? parameters.queries
      : typeof query === "string" && query.trim().length > 0
        ? [query.trim()]
        : [];
    if (queries.length > 0) {
      return {
        name: target.name,
        arguments: { queries },
        id: String(update.tool_info?.call_id ?? update.call_id ?? `agy-${hash(JSON.stringify({ update, requestId: request.requestId ?? "" })).slice(0, 20)}`),
      };
    }
  }
  return {
    name: target.name,
    arguments: parameters,
    id: String(update.tool_info?.call_id ?? update.call_id ?? `agy-${hash(JSON.stringify({ update, requestId: request.requestId ?? "" })).slice(0, 20)}`),
  };
}

function appendDelta(current, next) {
  if (!next) return "";
  if (!current) return next;
  if (next.startsWith(current)) return next.slice(current.length);
  if (current.endsWith(next)) return "";
  return next;
}

/** Execute text turns through the installed official Antigravity CLI. */
export function createAntigravityCliExecutor({
  cliPath = process.env.DOCKYARD_ANTIGRAVITY_CLI || DEFAULT_CLI,
  env = process.env,
  // One print-mode turn carries the whole conversation and can legitimately run
  // for minutes on a large context (measured: a trivial prompt already costs
  // ~35s on gemini-3.8-flash-high). The CLI's own --print-timeout defaults to
  // 5m, which killed healthy turns mid-flight and forced a full replay retry —
  // doubling the cost of every slow turn. Widen both boundaries: agy aborts
  // first with its own error, DSH kills a minute later as the outer guard.
  printTimeoutSeconds = Number(process.env.DOCKYARD_ANTIGRAVITY_PRINT_TIMEOUT_SECONDS) || 900,
  timeoutMs = Number(process.env.DOCKYARD_ANTIGRAVITY_CHAT_TIMEOUT_MS) || 960_000,
  // Sideband turns (titles/summaries) are short and must not occupy the fast
  // path with a full-length budget; a short ceiling fails them cheaply.
  sidebandTimeoutMs = Number(process.env.DOCKYARD_ANTIGRAVITY_SIDEBAND_TIMEOUT_MS) || 120_000,
  commandRunner = runCommand,
  catalogLoader = null,
  streamCommandRunner = runStreamingCommand,
  detectFakeIp = detectFakeIpEnvironment,
  promptStdinThresholdBytes = AGY_PROMPT_STDIN_THRESHOLD_BYTES,
  conversationStore = null,
  anchorLogPath = null,
  // Session-anchor mode (docs §8): off only via explicit opt-out; it degrades
  // to the legacy replay path on any anchored failure, so default-on is safe.
  sessionAnchor = process.env.DOCKYARD_ANTIGRAVITY_SESSION_ANCHOR !== "0",
} = {}) {
  return async function executeAntigravity({ request = {}, context = {} } = {}) {
    if (contentHasImageInCurrentTurn(request)) {
      throw unsupportedContentError(
        PROVIDER_ID,
        "Antigravity CLI 当前没有暴露可接收 DSH 图片附件的原生输入通道",
      );
    }
    const resolved = await resolveAntigravityInvocationModel({
      catalogLoader,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
    });
    // A virtualized (fake-IP) resolver makes DSH's guarded web_fetch unusable
    // for every hostname; read URLs through the local network stack instead.
    const preferLocalUrlFetch = await Promise.resolve()
      .then(() => detectFakeIp())
      .then((value) => value === true)
      .catch(() => false);
    const sideband = isAntigravitySidebandRequest(request);
    const effectiveTimeoutMs = sideband ? sidebandTimeoutMs : timeoutMs;
    const legacyStream = async function* () {
      const invocation = antigravityPromptInvocation(antigravityRequestPrompt(request), {
        thresholdBytes: promptStdinThresholdBytes,
      });
      const args = [...invocation.args];
      if (typeof resolved.model === "string" && resolved.model.length > 0) {
        args.push("--model", resolved.model);
      }
      if (typeof resolved.reasoningEffort === "string" && resolved.reasoningEffort.length > 0) {
        args.push("--effort", resolved.reasoningEffort);
      }
      // Print mode cannot open an interactive permission prompt. The sandbox
      // makes a native tool request deterministic; we translate its intent
      // into DSH's own tool loop before the CLI reaches its denial boundary.
      args.push("--sandbox", "--print-timeout", `${printTimeoutSeconds}s`, "--output-format", "stream-json");
      yield { type: "block-start", index: 0, blockType: "text" };
      let text = "";
      let usage = null;
      // Per-step usage is incremental while the final `result.usage` is
      // cumulative; keep a running sum so a turn that ends on a forwarded tool
      // call still reports what it actually consumed.
      let stepUsage = null;
      const handledTools = new Set();
      // Print mode explains itself on stderr (e.g. an auto-denied tool) and then
      // exits 0 with an empty response; keep a bounded copy for the diagnosis.
      const diagnostics = { stderr: "", deniedActions: [], events: 0, steps: 0, toolErrors: [], resultStatus: null };
      for await (const line of streamCommandRunner(cliPath, args, {
        env,
        timeoutMs: effectiveTimeoutMs,
        signal: request.signal,
        stdin: invocation.stdin,
        onStderr: (chunk) => {
          if (diagnostics.stderr.length < 2_000) diagnostics.stderr += String(chunk);
        },
      })) {
        const parsed = parseJsonOutput(line);
        if (!parsed) continue;
        diagnostics.events += 1;
        // Newer CLI builds report an auto-denied tool as a step_update ERROR
        // (result still comes back SUCCESS with an empty response and no
        // denied_actions), so harvest the denial here or the run looks like a
        // bare empty response and the harness retries a deterministic failure.
        const deniedUpdate = parsed?.step_update;
        if (deniedUpdate && deniedUpdate.step_type === "tool" && String(deniedUpdate.state ?? "").toUpperCase() === "ERROR") {
          const failureText = String(deniedUpdate.tool_info?.error?.message ?? "").trim();
          if (failureText) diagnostics.toolErrors.push(failureText);
          if (/permission/i.test(failureText)) {
            // The CLI's message names the missing grant itself, e.g.
            // `user denied permission for read_file(/private/tmp/x.txt)`. Keep
            // that path: "read_file" alone does not tell the user which
            // allow-rule to add, and /tmp resolves under /private on macOS.
            const grant = /denied permission for (.+?)\)\s*$/.exec(failureText)?.[1];
            const deniedName = String(deniedUpdate.tool_name ?? deniedUpdate.tool_info?.name ?? "").trim();
            const label = grant ? `${grant})` : deniedName;
            if (label) diagnostics.deniedActions.push(label);
          }
        }
        // Any state transition away from ACTIVE means the CLI reached a real
        // step boundary, which is the cheapest signal that the run was alive.
        if (deniedUpdate && String(deniedUpdate.state ?? "").toUpperCase() !== "ACTIVE") {
          diagnostics.steps += 1;
          stepUsage = addUsage(stepUsage, usageFromResponse(deniedUpdate.usage));
        }
        const tool = toolCallFromEvent(parsed, request, { preferLocalUrlFetch });
        if (tool) {
          const key = `${tool.id}:${tool.name}:${JSON.stringify(tool.arguments)}`;
          if (handledTools.has(key)) continue;
          handledTools.add(key);
          yield { type: "block-end", index: 0, block: { type: "text", text } };
          yield { type: "block-start", index: 1, blockType: "tool-call" };
          yield {
            type: "block-end",
            index: 1,
            block: {
              type: "tool-call",
              id: tool.id,
              name: tool.name,
              arguments: JSON.stringify(tool.arguments),
            },
          };
          // Token accounting must not depend on how the turn ended: a tool
          // round trip still consumed the prompt, and dropping its usage made
          // the ledger under-report every tool-heavy conversation.
          const reported = usage ?? stepUsage;
          if (reported) yield { type: "usage", usage: reported };
          yield { type: "finish", reason: { kind: "tool-calls" } };
          return;
        }
        for (const delta of streamEventTexts(parsed)) {
          const next = appendDelta(text, delta);
          if (!next) continue;
          text += next;
          yield { type: "text-delta", index: 0, text: next };
        }
        const final = streamEventResult(parsed);
        if (final) {
          diagnostics.resultStatus = final.status ?? diagnostics.resultStatus;
          if (final.status && final.status !== "SUCCESS") {
            const error = new Error("Antigravity CLI request did not complete");
            error.code = "ANTIGRAVITY_CLI_FAILED";
            error.detail = final.error ?? final.text ?? null;
            throw error;
          }
          const next = appendDelta(text, final.text);
          if (next) {
            text += next;
            yield { type: "text-delta", index: 0, text: next };
          }
          if (Array.isArray(final.deniedActions) && final.deniedActions.length > 0) {
            diagnostics.deniedActions = final.deniedActions;
          }
          usage = usageFromResponse(final.usage) ?? usage;
        }
        usage = usageFromResponse(parsed.usage) ?? usage;
      }
      // Whitespace-only text is not visible content downstream either, so it
      // must take the same single-failure path as a fully empty run.
      if (text.trim().length === 0) {
        // A cancelled turn is not a provider failure: report the abort instead
        // of an empty response, which the harness would otherwise replay.
        if (request.signal?.aborted) {
          const aborted = new Error("Antigravity CLI run was cancelled");
          aborted.name = "AbortError";
          throw aborted;
        }
        // Nothing visible was produced: surface the CLI's own explanation
        // instead of letting the harness report a bare empty response (and
        // retry a deterministic failure).
        const emptyOutput = antigravityEmptyOutputError(diagnostics);
        if (emptyOutput) throw emptyOutput;
        throw antigravitySilentRunError(diagnostics);
      }
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      const finalUsage = usage ?? stepUsage;
      if (finalUsage) yield { type: "usage", usage: finalUsage };
      yield { type: "finish", reason: { kind: "stop" } };
    };

    // --- Session-anchor path ---------------------------------------------
    // The harness passes the conversation handle in the invoke CONTEXT
    // (runtime.stream(provider, request, { sessionId })); some callers also
    // spread it onto the request. Accept both or the anchor never engages.
    const rawSessionId = request.sessionId ?? context.sessionId;
    const sessionKey = typeof rawSessionId === "string" && rawSessionId.length > 0
      ? rawSessionId
      : null;
    if (!sessionAnchor || !sessionKey || sideband) {
      if (sideband && (typeof request.purpose === "string" || isAntigravitySidebandRequest(request))) {
        appendAntigravityAnchorLog(
          anchorLogPath ?? join(dirname(antigravityConversationsFile(env)), "antigravity-anchor.log"),
          { kind: "sideband_bypass", sessionKey, purpose: typeof request.purpose === "string" ? request.purpose : "(system-marker)" },
        );
      }
      return legacyStream();
    }

    const store = conversationStore ?? createAntigravityConversationStore({ file: antigravityConversationsFile(env) });
    const messages = Array.isArray(request.messages) ? request.messages : [];
    const record = store.get(sessionKey);
    const continuation = Boolean(
      record
      && Number.isInteger(record.msgsLen)
      && record.msgsLen <= messages.length
      && antigravityMessagesFingerprint(messages.slice(0, record.msgsLen)).msgsHash === record.msgsHash,
    );
    // The tail since the anchored prefix is the only new content; replaying
    // older messages would duplicate them inside the agy conversation.
    const tail = antigravityTailText(messages, continuation ? record.msgsLen : 0);
    const conversationIntro = !continuation && typeof request.system === "string" && request.system.length > 0
      ? `会话约定（长期有效）：\n${request.system}\n\n`
      : "";
    const anchorText = `${conversationIntro}${tail}`;
    if (!anchorText.trim()) return legacyStream();

    const anchorLogFile = anchorLogPath ?? join(dirname(antigravityConversationsFile(env)), "antigravity-anchor.log");
    const anchoredStream = async function* () {
      const cid = continuation ? record.cid : null;
      const diagnostics = { events: 0, steps: 0, resultStatus: null, deniedActions: [], stderr: "" };
      const startedAt = Date.now();
      const invocation = antigravityAnchorInvocation({ conversationId: cid, text: anchorText });
      const args = [...invocation.args];
      if (typeof resolved.model === "string" && resolved.model.length > 0) {
        args.push("--model", resolved.model);
      }
      if (typeof resolved.reasoningEffort === "string" && resolved.reasoningEffort.length > 0) {
        args.push("--effort", resolved.reasoningEffort);
      }
      // agy owns tool execution in this mode (design §4.2/§8): the sandbox and
      // its own permission settings govern commands, so tool step_updates are
      // never forwarded into the DSH tool loop.
      args.push("--sandbox", "--print-timeout", `${printTimeoutSeconds}s`, "--output-format", "stream-json");
      yield { type: "block-start", index: 0, blockType: "text" };
      let text = "";
      let usage = null;
      let seenConversationId = null;
      for await (const line of streamCommandRunner(cliPath, args, {
        env,
        timeoutMs,
        signal: request.signal,
        stdin: invocation.stdin,
        onStderr: (chunk) => {
          if (diagnostics.stderr.length < 1_000) diagnostics.stderr += String(chunk);
        },
      })) {
        const parsed = parseJsonOutput(line);
        if (!parsed) continue;
        diagnostics.events += 1;
        const stepUpdate = parsed?.step_update;
        if (stepUpdate) {
          diagnostics.steps += 1;
          if (stepUpdate.step_type === "tool" && String(stepUpdate.state ?? "").toUpperCase() === "ERROR") {
            diagnostics.steps += 0;
            diagnostics.deniedActions.push(String(stepUpdate.tool_info?.error?.message ?? stepUpdate.tool_name ?? "").slice(0, 200));
          }
        }
        seenConversationId = seenConversationId
          ?? parsed.conversation_id
          ?? parsed.result?.conversation_id
          ?? parsed.step_update?.conversation_id
          ?? null;
        for (const delta of streamEventTexts(parsed)) {
          const next = appendDelta(text, delta);
          if (!next) continue;
          text += next;
          yield { type: "text-delta", index: 0, text: next };
        }
        const final = streamEventResult(parsed);
        if (final) {
          diagnostics.resultStatus = final.status ?? diagnostics.resultStatus;
          if (Array.isArray(final.deniedActions) && final.deniedActions.length > 0) {
            diagnostics.deniedActions = [...diagnostics.deniedActions, ...final.deniedActions.map((a) => String(a?.action ?? a?.display_name ?? a).slice(0, 120))];
          }
          if (final.status && final.status !== "SUCCESS") {
            const error = new Error("Antigravity CLI request did not complete");
            error.code = "ANTIGRAVITY_CLI_FAILED";
            error.detail = `${final.error ?? final.text ?? ""} | ${JSON.stringify(diagnostics.deniedActions).slice(0, 300)}`;
            appendAntigravityAnchorLog(anchorLogFile, { kind: "anchored_failed", sessionKey, cid, diagnostics, textLen: text.length });
            throw error;
          }
          const next = appendDelta(text, final.text);
          if (next) {
            text += next;
            yield { type: "text-delta", index: 0, text: next };
          }
          usage = usageFromResponse(final.usage) ?? usage;
        }
        usage = usageFromResponse(parsed.usage) ?? usage;
      }
      if (text.trim().length === 0 || request.signal?.aborted) {
        appendAntigravityAnchorLog(anchorLogFile, {
          kind: "anchored_empty", sessionKey, cid, diagnostics, textLen: text.length,
          aborted: Boolean(request.signal?.aborted), elapsedMs: Date.now() - startedAt,
        });
        // Degrade: without visible output the replay path either succeeds with
        // its richer diagnostics or surfaces the proper Chinese error.
        const error = new Error(request.signal?.aborted ? "Antigravity CLI run was cancelled" : "anchored turn produced no output");
        if (request.signal?.aborted) error.name = "AbortError";
        throw error;
      }
      appendAntigravityAnchorLog(anchorLogFile, { kind: "anchored_ok", sessionKey, cid, diagnostics, textLen: text.length, elapsedMs: Date.now() - startedAt });
      if (seenConversationId) {
        store.set(sessionKey, {
          cid: seenConversationId,
          msgsLen: messages.length,
          msgsHash: antigravityMessagesFingerprint(messages).msgsHash,
          model: resolved.model ?? null,
        });
      }
      yield { type: "block-end", index: 0, block: { type: "text", text } };
      if (usage) yield { type: "usage", usage };
      yield { type: "finish", reason: { kind: "stop" } };
    };

    return (async function* () {
      let yielded = false;
      let lastError = null;
      // An empty anchored run is usually an upstream hiccup (observed in the
      // wild: a 10-event SUCCESS with empty text, ~14s). Retrying the anchor
      // costs one cheap extra spawn and keeps the fast path; only a second
      // failure pays for a full replay.
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          for await (const chunk of anchoredStream()) {
            // A bare block-start carries no user-visible content: losing it to a
            // replay retry is free, losing real text would duplicate it.
            if (chunk.type !== "block-start") yielded = true;
            yield chunk;
          }
          return;
        } catch (error) {
          lastError = error;
          // A turn that already streamed content cannot be replayed without
          // duplicating it; aborts and partial turns propagate as-is.
          if (yielded || error?.name === "AbortError") throw error;
          appendAntigravityAnchorLog(anchorLogFile, {
            kind: "anchor_attempt_failed", sessionKey, attempt,
            reason: String(error?.code ?? error?.message ?? error).slice(0, 200),
          });
        }
      }
      appendAntigravityAnchorLog(anchorLogFile, {
        kind: "anchor_degraded", sessionKey, yielded, reason: String(lastError?.code ?? lastError?.message ?? lastError).slice(0, 200),
      });
      yield* legacyStream();
    })();
  };
}

function quotaGroups(data) {
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.groups)) return data.groups;
  if (Array.isArray(data.quota_groups)) return data.quota_groups;
  if (Array.isArray(data.quotaGroups)) return data.quotaGroups;
  return [];
}

function findQuotaData(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
  seen.add(value);
  if (quotaGroups(value).length > 0) return value;
  for (const key of ["command", "data", "response", "quota_summary", "quotaSummary", "result"]) {
    const found = findQuotaData(value[key], depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function findCreditsData(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
  seen.add(value);
  if (Object.hasOwn(value, "remaining_credits") || Object.hasOwn(value, "remainingCredits")) return value;
  for (const child of Object.values(value)) {
    const found = findCreditsData(child, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

/** Normalize the credits block; the CLI and native payloads use either naming. */
function creditsFromData(data) {
  if (!data || typeof data !== "object") return null;
  const remaining = finiteNumber(data.remaining_credits ?? data.remainingCredits);
  const upgradeUri = stringValue(data.upgrade_uri ?? data.upgradeUri);
  if (remaining === null && upgradeUri === null) return null;
  return { remaining, upgradeUri };
}

function parseQuotaData(data, now = new Date(), source = "antigravity_cli") {
  const windows = [];
  for (const group of quotaGroups(data)) {
    for (const bucket of group?.buckets ?? []) {
      const fraction = finiteNumber(bucket.remaining_fraction ?? bucket.remainingFraction);
      const percent = finiteNumber(bucket.remaining_percent ?? bucket.remainingPercent);
      const remaining = fraction ?? (percent === null ? null : percent / 100);
      windows.push({
        id: stringValue(bucket.id) ?? `${group.name ?? "group"}:${bucket.name ?? "window"}`,
        name: [group.name, bucket.name].filter(Boolean).join(" / ") || null,
        remaining,
        limit: remaining === null ? null : 1,
        unit: remaining === null ? null : "fraction",
        resetAt: isoFromEpoch(bucket.reset_time ?? bucket.resetTime),
        updatedAt: now.toISOString(),
        source,
      });
    }
  }
  return windows;
}

function parseQuotaText(text, now = new Date(), source = "antigravity_cli") {
  const windows = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3 || !/%$/.test(parts[2])) continue;
    const remaining = finiteNumber(parts[2].replace(/%$/, ""));
    if (remaining === null) continue;
    windows.push({
      id: `${parts[0]}:${parts[1]}`,
      name: `${parts[0]} / ${parts[1]}`,
      remaining,
      limit: 100,
      unit: "percent",
      resetAt: isoFromEpoch(parts[3]),
      updatedAt: now.toISOString(),
      source,
    });
  }
  return windows;
}

/** Normalize the live first-party quota summary without embedding its rows. */
export function parseAntigravityNativeQuota(value, now = new Date()) {
  const data = findQuotaData(value);
  let windows = parseQuotaData(data, now, "antigravity_native");
  if (windows.length === 0) {
    windows = recursiveQuotaWindows(value, { source: "antigravity_native", now, prefix: "antigravity" });
  }
  const credits = findCreditsData(value);
  return {
    windows,
    credits: credits
      ? {
        remaining: finiteNumber(credits.remaining_credits ?? credits.remainingCredits),
        upgradeUri: stringValue(credits.upgrade_uri ?? credits.upgradeUri),
      }
      : null,
  };
}

function candidate(now, {
  email = null,
  session = null,
  existingAccounts = [],
  source = "official_antigravity_cli",
  sourceKind = OFFICIAL_SESSION_SOURCE_KINDS.CLI,
  credentialRefreshMode = null,
} = {}) {
  const normalizedEmail = normalizeEmail(email);
  const capturedSession = normalizedEmail && session && !session.email
    ? { ...session, email: normalizedEmail }
    : session;
  const fingerprint = sessionFingerprint(capturedSession);
  const stableAccountId = normalizedEmail
    ? `antigravity:google:${hash(`email:${normalizedEmail.toLowerCase()}`).slice(0, 20)}`
    : fingerprint
      ? `antigravity:session:${hash(`fingerprint:${fingerprint}`).slice(0, 20)}`
      : "antigravity:active";
  const known = existingAccounts.find((account) => (
    (fingerprint && account?.resources?.sessionFingerprint === fingerprint)
      || sameEmail(account?.email, normalizedEmail)
  ));
  const legacy = existingAccounts.find((account) => account?.accountId === "antigravity:active");
  // Migrate the account record created by the old single-session driver in
  // place. Once its fingerprint is recorded, the next switched session gets
  // a separate accountId and can be added to the pool independently.
  const accountId = known?.accountId
    ?? (legacy && !legacy.resources?.sessionFingerprint && stableAccountId !== "antigravity:active"
      ? legacy.accountId
      : stableAccountId);
  const identityLabel = normalizedEmail
    ?? (fingerprint ? `Antigravity 官方会话 · ${fingerprint}` : "Antigravity 官方当前会话");
  const identitySource = normalizedEmail
    ? "official_cli_auth_status"
    : fingerprint
      ? "local_oauth_session_fingerprint"
      : "official_active_session";
  const credentialRef = createCredentialRef(PROVIDER_ID, accountId);
  const value = {
    candidateId: `antigravity:${hash(accountId).slice(0, 20)}`,
    providerId: PROVIDER_ID,
    source,
    accountId,
    displayName: identityLabel,
    email: normalizedEmail,
    subscription: { plan: null, status: null, expiresAt: null },
    refresh: {
      accessTokenExpiresAt: capturedSession?.expiresAt ?? null,
      nextRefreshAt: null,
      lastRefreshedAt: capturedSession?.lastRefreshedAt ?? null,
      refreshable: capturedSession?.refreshToken ? true : null,
    },
    imported: false,
    status: "available",
    diagnostic: null,
    credentialRef,
    resources: {
      ...officialSessionResources({ sourceKind, authSource: source }),
      ...(credentialRefreshMode ? { credentialRefreshMode } : {}),
      identitySource,
      identityLabel,
      ...(fingerprint ? { sessionFingerprint: fingerprint } : {}),
      identityNote: normalizedEmail
        ? "账号邮箱来自官方 Antigravity 登录态"
        : fingerprint
          ? "官方登录态未返回邮箱；使用会话指纹区分账号"
          : "官方只返回当前会话；切换账号后请重新扫描",
      sessionPersistence: capturedSession?.token ? "captured" : "active",
    },
  };
  Object.defineProperty(value, CREDENTIAL_SLOT, {
    value: {
      type: OFFICIAL_SESSION_AUTH_KIND,
      providerId: PROVIDER_ID,
      ...(capturedSession?.token ? { access: capturedSession.token } : {}),
      ...(capturedSession?.refreshToken ? { refresh: capturedSession.refreshToken } : {}),
      ...(normalizedEmail ? { email: normalizedEmail } : {}),
      ...(capturedSession?.expiresAt ? { expiresAt: capturedSession.expiresAt } : {}),
      ...(capturedSession?.lastRefreshedAt ? { lastRefreshedAt: capturedSession.lastRefreshedAt } : {}),
    },
    enumerable: false,
  });
  return value;
}

export function summarizeAntigravityCandidate(value) {
  return {
    providerId: PROVIDER_ID,
    candidateId: value.candidateId,
    source: value.source,
    accountId: value.accountId,
    displayName: value.displayName,
    email: value.email,
    subscription: { ...value.subscription },
    refresh: { ...value.refresh },
    resources: { ...value.resources },
    imported: Boolean(value.imported),
    status: value.status ?? "available",
    diagnostic: value.diagnostic ?? null,
  };
}

const ANTIGRAVITY_AUTH_URL_PATTERN = /https:\/\/accounts\.google\.com\/o\/oauth2\/(?:v2\/)?auth\?[^\s"'<>]+/i;

function cleanAntigravityAuthUrl(value) {
  return String(value ?? "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[),.;]+$/, "");
}

function publicAntigravityAuthSession(session) {
  return {
    sessionId: session.sessionId,
    providerId: PROVIDER_ID,
    status: session.status ?? (session.exitCode === null ? "pending" : "processing"),
    authorizationUrl: session.authorizationUrl,
    instructions: session.instructions,
    startedAt: session.startedAt,
    ...(session.browserOpened ? { browserOpened: true } : {}),
    ...(session.inputRequired ? { inputRequired: true } : {}),
    diagnostic: session.diagnostic ?? null,
  };
}

/**
 * Start agy's own Google OAuth flow in a temporary profile.
 *
 * agy has no separate login subcommand: its normal `agy -p` command starts
 * the official OAuth flow when that profile is unauthenticated. Running it
 * with an isolated HOME lets DSH add another Google account without touching
 * the user's active CLI session. The child is never attached to a terminal;
 * only the authorization URL and the resulting token are used.
 */
export function createAntigravityOAuthAuthorizer({
  cliPath = process.env.DOCKYARD_ANTIGRAVITY_CLI || DEFAULT_CLI,
  environment = process.env,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  prompt = "Reply with OK",
  spawnImpl = spawn,
  tokenReader = readAntigravityTokenFile,
  usePty = process.platform === "darwin",
  ptyPythonPath = process.env.DOCKYARD_ANTIGRAVITY_PTY_PYTHON || "python3",
  instructions = "已打开 Google 官方验证页；选择账号并完成验证后，DSH 会自动接入。",
} = {}) {
  if (!cliPath) throw new Error("Antigravity OAuth authorizer requires an agy CLI path");
  if (typeof spawnImpl !== "function") throw new Error("Antigravity OAuth authorizer requires a process spawner");
  if (typeof tokenReader !== "function") throw new Error("Antigravity OAuth authorizer requires a token reader");

  const sessions = new Map();

  async function cleanup(session) {
    if (!session.profileDir) return;
    await rm(session.profileDir, { recursive: true, force: true }).catch(() => {});
    session.profileDir = null;
  }

  function capture(session, chunk) {
    session.output = `${session.output}${String(chunk ?? "")}`.slice(-32_000);
    if (!session.authorizationUrl) {
      const match = session.output.match(ANTIGRAVITY_AUTH_URL_PATTERN);
      if (match?.[0]) session.authorizationUrl = cleanAntigravityAuthUrl(match[0]);
    }
    if (/authorization code|redirect URL/i.test(session.output)) session.inputRequired = true;
  }

  function readToken(session) {
    try {
      return tokenReader({ env: session.childEnv, home: session.profileDir });
    } catch {
      return null;
    }
  }

  async function finalize(session, context, credential = null) {
    if (session.result) return session.result;
    if (session.finalizing) return session.finalizing;
    session.finalizing = (async () => {
      try {
        const auth = credential ?? readToken(session);
        if (!auth?.token) {
          if (session.exitCode === null) return publicAntigravityAuthSession(session);
          session.status = "failed";
          session.diagnostic = session.timedOut
            ? "Google 验证超时，请重新点击登录添加账号。"
            : session.launchError
              ? `无法启动 agy 官方验证：${session.launchError}`
              : `agy 官方验证未完成（退出码 ${session.exitCode ?? "unknown"}）。`;
          return publicAntigravityAuthSession(session);
        }

        // The prompt only bootstraps agy's official auth flow. Stop it as soon
        // as the OAuth token is persisted so DSH never spends a model request.
        if (session.child && session.exitCode === null) session.child.kill("SIGTERM");
        const account = candidate(context?.now instanceof Date ? context.now : new Date(), {
          email: extractAntigravityAccountEmail(session.output),
          session: auth,
          existingAccounts: context?.accounts ?? [],
          // agy's isolated temporary profile is a browser OAuth session, not
          // the user's active local CLI session. Mark it accordingly so quota
          // refresh and request execution use the captured credential instead
          // of rejecting it as a session mismatch. Its refresh token belongs
          // to agy's own OAuth client, so DSH must not exchange it with an
          // unrelated/empty browser client.
          source: "official_antigravity_browser_oauth",
          sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.BROWSER,
          credentialRefreshMode: ANTIGRAVITY_CREDENTIAL_REFRESH_MODES.AGY_SESSION,
        });
        session.status = "completed";
        session.result = {
          ...publicAntigravityAuthSession(session),
          status: "completed",
          accounts: [account],
          diagnostic: null,
        };
        return session.result;
      } catch (error) {
        session.status = "failed";
        session.diagnostic = redactError(error);
        return publicAntigravityAuthSession(session);
      } finally {
        if (session.status === "completed" || session.status === "failed") {
          if (session.timer) clearTimeout(session.timer);
          await cleanup(session);
        }
      }
    })();
    return session.finalizing;
  }

  async function begin() {
    const profileDir = await mkdtemp(join(tmpdir(), "dockyard-antigravity-oauth-"));
    const tokenPath = join(profileDir, ".gemini", "antigravity-cli", "antigravity-oauth-token");
    const childEnv = {
      ...environment,
      HOME: profileDir,
      XDG_CONFIG_HOME: join(profileDir, ".config"),
      DOCKYARD_ANTIGRAVITY_TOKEN_FILE: tokenPath,
    };
    // Do not force AGY_CLI_HIDE_ACCOUNT_INFO here. In agy, the presence of
    // the variable is itself treated as enabled even when its value is "0";
    // that mode skips the browser OAuth bootstrap and only asks the user to
    // run agy manually. The official default is the desired browser flow.
    delete childEnv.AGY_CLI_HIDE_ACCOUNT_INFO;
    const session = {
      sessionId: `${PROVIDER_ID}:${randomUUID()}`,
      providerId: PROVIDER_ID,
      profileDir,
      childEnv,
      status: "pending",
      authorizationUrl: null,
      instructions,
      startedAt: new Date().toISOString(),
      // agy owns the official browser OAuth flow and opens this URL itself.
      // The DSH host must not open the captured URL a second time.
      browserOpened: true,
      exitCode: null,
      launchError: null,
      output: "",
      inputRequired: false,
      timedOut: false,
      child: null,
      timer: null,
      finalizing: null,
      result: null,
      diagnostic: null,
    };
    sessions.set(session.sessionId, session);

    try {
      // agy refuses to bootstrap OAuth when stdin is a plain pipe. macOS's
      // built-in `script` gives it a hidden pseudo-terminal while DSH still
      // owns the pipe, so the user only sees the browser verification page.
      const command = usePty ? ptyPythonPath : cliPath;
      const args = usePty
        ? ["-u", "-c", ANTIGRAVITY_PTY_SCRIPT, cliPath, "-p", prompt, "--output-format", "json"]
        : ["-p", prompt, "--output-format", "json"];
      const child = spawnImpl(command, args, {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      session.child = child;
      child.stdout?.on("data", (chunk) => capture(session, chunk));
      child.stderr?.on("data", (chunk) => capture(session, chunk));
      child.once("error", (error) => {
        session.launchError = redactError(error);
        session.exitCode = -1;
      });
      child.once("close", (code) => {
        session.exitCode = typeof code === "number" ? code : -1;
      });
      session.timer = setTimeout(() => {
        if (session.exitCode !== null) return;
        session.timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);
      session.timer.unref?.();
    } catch (error) {
      session.launchError = redactError(error);
      session.exitCode = -1;
    }
    return publicAntigravityAuthSession(session);
  }

  async function poll(sessionId, context = {}) {
    const session = sessions.get(sessionId);
    if (!session) {
      return {
        sessionId,
        providerId: PROVIDER_ID,
        status: "missing",
        instructions,
        diagnostic: "验证会话不存在或已结束，请重新点击登录添加账号。",
      };
    }
    if (session.result) return session.result;
    const credential = readToken(session);
    if (!credential?.token && session.exitCode === null) return publicAntigravityAuthSession(session);
    const result = await finalize(session, context, credential);
    if (!["pending", "processing"].includes(result.status)) sessions.delete(sessionId);
    return result;
  }

  async function submitAuthorizationCode(sessionId, value) {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("验证会话不存在或已结束，请重新点击登录添加账号");
    const code = String(value ?? "").trim();
    if (!code) throw new Error("请输入 Google 验证码或回调地址");
    if (code.length > 4096 || /[\u0000-\u001f\u007f]/.test(code)) {
      throw new Error("Google 验证码或回调地址格式无效");
    }
    if (!session.child || session.exitCode !== null || !session.child.stdin?.writable) {
      throw new Error("agy 验证进程已结束，请重新点击登录添加账号");
    }
    session.child.stdin.write(`${code}\n`);
    session.inputRequired = false;
    session.status = "processing";
    session.instructions = "授权码已提交，正在等待官方登录完成。";
    return publicAntigravityAuthSession(session);
  }

  async function cancel(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return { sessionId, providerId: PROVIDER_ID, status: "missing" };
    if (session.timer) clearTimeout(session.timer);
    if (session.child && session.exitCode === null) session.child.kill("SIGTERM");
    await cleanup(session);
    sessions.delete(sessionId);
    return { sessionId, providerId: PROVIDER_ID, status: "cancelled" };
  }

  return Object.freeze({ begin, poll, cancel, submitAuthorizationCode });
}

export class AntigravityOfficialSessionDriver {
  constructor({
    cliPath = process.env.DOCKYARD_ANTIGRAVITY_CLI || DEFAULT_CLI,
    env = process.env,
    timeoutMs = 30_000,
    commandRunner = runCommand,
    ptyPythonPath = process.env.DOCKYARD_ANTIGRAVITY_PTY_PYTHON || "python3",
    // Background refresh is a non-interactive `agy models` call. The PTY is
    // only needed for the browser bootstrap authorizer; wrapping this refresh
    // in a PTY makes agy report a false exit-code failure on macOS.
    usePtyForSessionRefresh = false,
    requestExecutor = null,
    catalogLoader = null,
    registryLoader = null,
    quotaReader = null,
    tokenResolver = resolveAntigravityAccessToken,
    identityFromOfficialCli = true,
    identityFromOfficialSession = identityFromOfficialCli,
    oauthAuthorizer = null,
    browserAuthorizer = null,
    browserOAuth = env.DOCKYARD_ANTIGRAVITY_BROWSER_OAUTH !== "0",
    authorizationUrl = env.DOCKYARD_ANTIGRAVITY_AUTHORIZATION_URL || ANTIGRAVITY_BROWSER_AUTHORIZATION_URL,
    tokenUrl = env.DOCKYARD_ANTIGRAVITY_TOKEN_URL || ANTIGRAVITY_BROWSER_TOKEN_URL,
    userInfoUrl = env.DOCKYARD_ANTIGRAVITY_USERINFO_URL || ANTIGRAVITY_BROWSER_USERINFO_URL,
    clientId = env.DOCKYARD_ANTIGRAVITY_CLIENT_ID || ANTIGRAVITY_BROWSER_CLIENT_ID,
    clientSecret = env.DOCKYARD_ANTIGRAVITY_CLIENT_SECRET || ANTIGRAVITY_BROWSER_CLIENT_SECRET,
    oauthScope = env.DOCKYARD_ANTIGRAVITY_OAUTH_SCOPE || ANTIGRAVITY_BROWSER_SCOPES,
    redirectUri = env.DOCKYARD_ANTIGRAVITY_REDIRECT_URI || ANTIGRAVITY_BROWSER_REDIRECT_URI,
    fetchImpl = fetch,
    authorizationTimeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
  } = {}) {
    // SECURITY.md: remote OAuth endpoints must be https (or loopback http)
    // even when they come from the environment.
    assertSecureEndpointUrl(authorizationUrl, "DOCKYARD_ANTIGRAVITY_AUTHORIZATION_URL");
    this.cliPath = cliPath;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.commandRunner = commandRunner;
    this.ptyPythonPath = ptyPythonPath;
    this.usePtyForSessionRefresh = usePtyForSessionRefresh;
    this.fetchImpl = fetchImpl;
    this.browserTokenUrl = assertSecureEndpointUrl(tokenUrl, "DOCKYARD_ANTIGRAVITY_TOKEN_URL");
    this.browserUserInfoUrl = userInfoUrl
      ? assertSecureEndpointUrl(userInfoUrl, "DOCKYARD_ANTIGRAVITY_USERINFO_URL")
      : userInfoUrl;
    this.browserClientId = clientId;
    this.browserClientSecret = clientSecret;
    this.requestExecutor = requestExecutor;
    this.quotaReader = quotaReader;
    this.tokenResolver = tokenResolver;
    this.identityFromOfficialSession = identityFromOfficialSession;
    this.cliOAuthAuthorizer = createAntigravityOAuthAuthorizer({
      cliPath,
      environment: env,
      timeoutMs: authorizationTimeoutMs,
    });
    const browserOAuthConfigured = Boolean(clientId && clientSecret);
    this.browserAuthorizer = browserAuthorizer ?? (browserOAuth && browserOAuthConfigured
      ? createBrowserOAuthAuthorizer({
        providerId: PROVIDER_ID,
        redirectUri,
        callbackPath: new URL(redirectUri).pathname,
        callbackHost: new URL(redirectUri).hostname,
        callbackPort: Number(new URL(redirectUri).port || 51121),
        instructions: "请在 Google 官方授权页面选择账号并完成授权；完成后会自动返回 oauthpro。",
        authorizationUrlBuilder: ({ state, codeChallenge, redirectUri: callback }) => `${authorizationUrl}?${new URLSearchParams({
          access_type: "offline",
          client_id: clientId,
          code_challenge: codeChallenge,
          code_challenge_method: "S256",
          prompt: "consent",
          redirect_uri: callback,
          response_type: "code",
          scope: oauthScope,
          state,
        })}`,
        exchangeCode: async ({ code, codeVerifier, redirectUri, context }) => {
          const response = await this.fetchImpl(tokenUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              code_verifier: codeVerifier,
              grant_type: "authorization_code",
              redirect_uri: redirectUri,
            }),
            ...(context.signal ? { signal: context.signal } : {}),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || !body.access_token) {
            throw new Error(`Antigravity Google token exchange failed (${response.status})`);
          }
          return body;
        },
        importCredentials: async (tokens, context) => {
          const access = tokens?.access_token ?? tokens?.accessToken;
          const refresh = tokens?.refresh_token ?? tokens?.refreshToken;
          if (!access) throw new Error("Antigravity Google OAuth did not return an access token");
          let profile = null;
          try {
            const response = await this.fetchImpl(userInfoUrl, {
              headers: { authorization: `Bearer ${access}` },
              ...(context.signal ? { signal: context.signal } : {}),
            });
            if (response.ok) profile = await response.json().catch(() => null);
          } catch {
            // Account import can still use the token fingerprint if profile lookup is unavailable.
          }
          const now = context.now instanceof Date ? context.now : new Date();
          const candidateValue = candidate(now, {
            email: profile?.email,
            session: {
               token: access,
               refreshToken: refresh,
               expiresAt: tokenExpiresAt(tokens, now),
               lastRefreshedAt: now.toISOString(),
             },
            existingAccounts: context.accounts ?? [],
            source: "official_antigravity_browser_oauth",
            sourceKind: OFFICIAL_SESSION_SOURCE_KINDS.BROWSER,
            credentialRefreshMode: ANTIGRAVITY_CREDENTIAL_REFRESH_MODES.DSH_BROWSER_OAUTH,
          });
          return [await this.importAccount(candidateValue, context)];
        },
      })
      : null);
    this.oauthAuthorizer = oauthAuthorizer ?? this.browserAuthorizer ?? this.cliOAuthAuthorizer;
    this.catalogLoader = catalogLoader ?? createAntigravityCatalogLoader({
      cliPath,
      env,
      timeoutMs,
      commandRunner,
      registryLoader,
    });
  }

  async #slash(command, signal) {
    const result = await this.commandRunner(this.cliPath, ["-p", command, "--output-format", "json"], {
      env: this.env,
      timeoutMs: this.timeoutMs,
      includeAccountInfo: true,
      ...(signal ? { signal } : {}),
    });
    const parsed = parseJsonOutput(result.output);
    return { ...result, parsed };
  }

  async #resolveSessionEmail(session, context = {}) {
    const direct = extractAntigravityAccountEmail(session);
    if (direct) return direct;
    if (!session?.token || typeof this.fetchImpl !== "function" || !this.browserUserInfoUrl) return null;
    try {
      const response = await this.fetchImpl(this.browserUserInfoUrl, {
        headers: { authorization: `Bearer ${session.token}` },
        ...(context.signal ? { signal: context.signal } : {}),
      });
      if (!response?.ok) return null;
      return extractAntigravityAccountEmail(await response.json().catch(() => null));
    } catch {
      return null;
    }
  }

  async #assertActiveSession(account, context = {}) {
    if (!isOfficialSessionAuthKind(account?.auth?.kind)) return;
    if (account.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER) return;
    const expectedFingerprint = account.resources?.sessionFingerprint;
    if (expectedFingerprint) {
      let current;
      try {
        current = await this.tokenResolver({ env: this.env });
      } catch {
        throw activeSessionError("Antigravity OAuth session is unavailable; authorize again");
      }
      if (!current?.token || sessionFingerprint(current) !== expectedFingerprint) {
        if (current?.token && context.allowSessionTokenRotation === true) return;
        // A rotated access token legitimately changes the token-based
        // fingerprint even though the local session belongs to the same
        // account. When the current session exposes a stable identity, verify
        // it against the pooled account before rejecting the request.
        const currentEmail = await this.#resolveSessionEmail(current, context);
        if (currentEmail && account.email && sameEmail(currentEmail, account.email)) return;
        throw activeSessionError(
          "Antigravity selected account is not the active local session; authorize it again",
          { mismatch: true },
        );
      }
      return;
    }
    if (account.accountId === "antigravity:active" && !account.email) return;

    let result;
    try {
      result = await this.#slash("/quota", context.signal);
    } catch {
      throw activeSessionError("Antigravity active session could not be verified; authorize again");
    }
    const email = extractAntigravityAccountEmail(result.parsed, result.output, result.errorOutput);
    if (account.email && email && sameEmail(account.email, email)) return;
    throw activeSessionError(
      "Antigravity selected account is not the active local session; authorize it again",
      { mismatch: true },
    );
  }

  async #refreshOfficialCredential(account, context = {}) {
    if (account?.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER) return null;
    if (typeof this.tokenResolver !== "function") return null;

    let current;
    try {
      current = await this.tokenResolver({ env: this.env });
    } catch (error) {
      const wrapped = activeSessionError(`Antigravity official session could not be read: ${redactError(error)}`);
      wrapped.cause = error;
      throw wrapped;
    }
    if (!current?.token) return null;

    const now = context.now instanceof Date ? context.now : new Date();
    const credential = {
      type: OFFICIAL_SESSION_AUTH_KIND,
      providerId: PROVIDER_ID,
      access: current.token,
      ...(current.refreshToken ? { refresh: current.refreshToken } : {}),
      ...(current.expiresAt ? { expiresAt: current.expiresAt } : {}),
    };
    if (!tokenNeedsRefresh(credential, now)) {
      // When agy's Keychain has already rotated the session, keep DSH's own
      // secure copy aligned even though no second CLI refresh is necessary.
      const credentialRef = account?.auth?.credentialRef ?? account?.credentialRef;
      if (current.source === "antigravity_keychain"
        && credentialRef
        && typeof context.secretStore?.write === "function") {
        await context.secretStore.write(credentialRef, credential);
      }
      return { session: current, credential, rotated: false };
    }
    if (!current.refreshToken) {
      throw activeSessionError("Antigravity official session has expired; authorize again");
    }

    // Refresh the real agy profile in place. agy's macOS keyring is global to
    // the user and does not provide a per-HOME profile boundary; putting the
    // child in a temporary HOME therefore caused the keychain lookup shown by
    // the user and left DSH with the old file token. Keep HOME/XDG untouched,
    // ask agy to use its supported file-backed session, then mirror the
    // rotated credential into DSH's own secure store below.
    const officialTokenPath = officialAntigravityTokenPath(this.env);
    const officialHome = this.env.HOME || homedir();
    const childEnv = agyRefreshEnvironment(this.env, officialTokenPath);
    try {
      await mkdir(dirname(officialTokenPath), { recursive: true, mode: 0o700 });
      const refreshCommand = this.usePtyForSessionRefresh ? this.ptyPythonPath : this.cliPath;
      const refreshArgs = this.usePtyForSessionRefresh
        ? ["-u", "-c", ANTIGRAVITY_PTY_SCRIPT, this.cliPath, "models"]
        : ["models"];
      await this.commandRunner(refreshCommand, refreshArgs, {
        env: childEnv,
        timeoutMs: this.timeoutMs,
        signal: context.signal,
      });
      let refreshed = null;
      try {
        // agy may refresh the keyring without rewriting its legacy file. Read
        // the provider-owned keyring again before accepting the file copy.
        refreshed = await this.tokenResolver({ env: this.env });
      } catch {
        // The file fallback below remains useful for older/headless agy builds.
      }
      refreshed = refreshed?.token
        ? refreshed
        : readAntigravityTokenFile({ env: childEnv, home: officialHome });
      if (!refreshed?.token) throw new Error("agy did not persist a refreshed OAuth token");
      const nextCredential = {
        ...credential,
        access: refreshed.token,
        ...(refreshed.refreshToken ? { refresh: refreshed.refreshToken } : {}),
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
        lastRefreshedAt: now.toISOString(),
      };
      const expiry = nextCredential.expiresAt ? Date.parse(nextCredential.expiresAt) : Number.NaN;
      const expiryAdvanced = Number.isFinite(expiry) && expiry > now.getTime() + 60_000;
      if (nextCredential.access === credential.access && !expiryAdvanced) {
        throw new Error("agy did not advance the Antigravity OAuth token expiry");
      }
      await mkdir(dirname(officialTokenPath), { recursive: true, mode: 0o700 });
      const persistedPath = `${officialTokenPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(persistedPath, JSON.stringify({
          auth_method: "consumer",
          token: {
            access_token: nextCredential.access,
            refresh_token: nextCredential.refresh,
            token_type: "Bearer",
            ...(nextCredential.expiresAt ? { expiry: nextCredential.expiresAt } : {}),
          },
        }), { encoding: "utf8", mode: 0o600 });
        await rename(persistedPath, officialTokenPath);
      } finally {
        await rm(persistedPath, { force: true }).catch(() => {});
      }
      const credentialRef = account?.auth?.credentialRef ?? account?.credentialRef;
      if (credentialRef && typeof context.secretStore?.write === "function") {
        await context.secretStore.write(credentialRef, nextCredential);
      }
      // The Keychain now holds the rotated session, so the cached copy must go:
      // a stale read would fail the fingerprint check on the very next turn.
      invalidateAntigravityKeychainCache();
      return { session: refreshed, credential: nextCredential, rotated: true };
    } catch (error) {
      if (error?.authExpired) throw error;
      const wrapped = activeSessionError(`Antigravity official session refresh failed: ${redactError(error)}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async #refreshAgyCredential(credential, context = {}) {
    if (!credential?.refresh) {
      throw activeSessionError("Antigravity agy session has no refresh token; authorize again");
    }

    const tokenPath = officialAntigravityTokenPath(this.env);
    const officialHome = this.env.HOME || homedir();
    const childEnv = agyRefreshEnvironment(this.env, tokenPath);
    const now = context.now instanceof Date ? context.now : new Date();

    try {
      await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
      // A captured browser session may be the first DSH record and therefore
      // have no file in the official profile yet. Seed only that missing file;
      // an existing file remains authoritative for the active agy profile.
      if (!readAntigravityTokenFile({ env: childEnv, home: officialHome })?.token) {
        await writeFile(tokenPath, JSON.stringify({
          auth_method: "consumer",
          token: {
            access_token: credential.access,
            refresh_token: credential.refresh,
            token_type: "Bearer",
            ...(credential.expiresAt ? { expiry: credential.expiresAt } : {}),
          },
        }), { encoding: "utf8", mode: 0o600 });
      }

      // `agy models` is a provider-owned authenticated command. It refreshes
      // the token file when the access token is stale without spending a
      // generation request, and keeps Google's client id/secret inside agy.
      await this.commandRunner(this.cliPath, ["models"], {
        env: childEnv,
        timeoutMs: this.timeoutMs,
        signal: context.signal,
      });

      let refreshed = null;
      try {
        refreshed = await this.tokenResolver({ env: this.env });
      } catch {
        // Fall back to the stable file for older/headless agy builds.
      }
      refreshed = refreshed?.token
        ? refreshed
        : readAntigravityTokenFile({ env: childEnv, home: officialHome });
      if (!refreshed?.token) {
        throw new Error("agy did not persist a refreshed OAuth token");
      }
      const next = {
        ...credential,
        access: refreshed.token,
        ...(refreshed.refreshToken ? { refresh: refreshed.refreshToken } : {}),
        ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}),
        lastRefreshedAt: now.toISOString(),
      };
      const accessChanged = next.access !== credential.access;
      const expiry = next.expiresAt ? Date.parse(next.expiresAt) : Number.NaN;
      const expiryAdvanced = Number.isFinite(expiry) && expiry > now.getTime() + 60_000;
      if (!accessChanged && !expiryAdvanced) {
        throw new Error("agy did not advance the Antigravity OAuth token expiry");
      }
      invalidateAntigravityKeychainCache();
      return next;
    } catch (error) {
      if (error?.authExpired) throw error;
      const wrapped = activeSessionError(`Antigravity agy session refresh failed: ${redactError(error)}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  async #refreshBrowserCredential(account, context = {}) {
    if (account?.resources?.sessionSource !== OFFICIAL_SESSION_SOURCE_KINDS.BROWSER) return null;
    const credentialRef = account?.auth?.credentialRef ?? account?.credentialRef;
    if (!credentialRef || typeof context.secretStore?.read !== "function") {
      throw activeSessionError("Antigravity browser OAuth credential is unavailable; authorize again");
    }
    const credential = await context.secretStore.read(credentialRef);
    if (!credential?.access) {
      throw activeSessionError("Antigravity browser OAuth credential is missing; authorize again");
    }
    const refreshMode = credentialRefreshMode(account);
    const dshManagedRefresh = refreshMode !== ANTIGRAVITY_CREDENTIAL_REFRESH_MODES.AGY_SESSION;
    const now = context.now instanceof Date ? context.now : new Date();
    if (refreshMode === ANTIGRAVITY_CREDENTIAL_REFRESH_MODES.AGY_SESSION) {
      if (!tokenNeedsRefresh(credential, now)) return credential;
      const updated = await this.#refreshAgyCredential(credential, context);
      await context.secretStore.write(credentialRef, updated);
      return updated;
    }
    // Accounts captured from agy's temporary browser profile carry agy's
    // refresh token, not a token issued for DSH's optional browser OAuth
    // client. The standard DSH launch agent also has no browser client
    // credentials. In either case the captured access token must be used as-is
    // for native quota/invocation instead of turning a successful login into
    // the misleading "订阅未返回" state with a blank client refresh call.
    if (!dshManagedRefresh || !this.browserClientId || !this.browserClientSecret) return credential;
    if (!tokenNeedsRefresh(credential, now)) return credential;
    if (!credential.refresh) {
      throw activeSessionError("Antigravity browser OAuth token expired; authorize again");
    }
    let response;
    try {
      response = await this.fetchImpl(this.browserTokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: this.browserClientId,
          client_secret: this.browserClientSecret,
          grant_type: "refresh_token",
          refresh_token: credential.refresh,
        }),
        ...(context.signal ? { signal: context.signal } : {}),
      });
    } catch (error) {
      const wrapped = activeSessionError(`Antigravity Google OAuth refresh failed: ${redactError(error)}`);
      wrapped.cause = error;
      throw wrapped;
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      const error = activeSessionError("Antigravity Google OAuth refresh failed; authorize again");
      error.status = response.status;
      throw error;
    }
    const updated = {
      ...credential,
      access: body.access_token,
      refresh: body.refresh_token ?? credential.refresh,
      expiresAt: tokenExpiresAt(body, now) ?? credential.expiresAt ?? null,
      lastRefreshedAt: now.toISOString(),
    };
    await context.secretStore.write(credentialRef, updated);
    return updated;
  }

  async #nativeQuota(account, context, now) {
    if (typeof this.quotaReader !== "function") return null;
    let credential = null;
    const credentialRef = account?.auth?.credentialRef;
    if (account?.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER) {
      credential = await this.#refreshBrowserCredential(account, context);
    } else if (context.officialCredential) {
      credential = context.officialCredential;
    } else if (credentialRef && context.secretStore && typeof context.secretStore.read === "function") {
      credential = await context.secretStore.read(credentialRef);
    }
    const value = await this.quotaReader({ account, credential, context });
    const parsed = parseAntigravityNativeQuota(value, now);
    if (parsed.windows.length === 0 && !parsed.credits) return null;
    return parsed;
  }

  async discover(context = {}) {
    const now = context.now instanceof Date ? context.now : new Date();
    try {
      let session = null;
      try {
        session = typeof this.tokenResolver === "function"
          ? await this.tokenResolver({ env: this.env })
          : null;
      } catch {
        // The official CLI can still be authenticated through a daemon or
        // another local source even when the token file is unavailable.
      }
      let windows = [];
      let source = "official_antigravity_cli";
      try {
        const native = await this.#nativeQuota(null, context, now);
        windows = native?.windows ?? [];
        if (windows.length > 0) source = "antigravity_native";
      } catch {
        // Discovery still falls back to the official CLI when the native
        // endpoint is unavailable or the local token needs reauthorization.
      }
      let result = null;
      let cliIdentityError = null;
      if (windows.length === 0 || this.identityFromOfficialSession) {
        try {
          result = await this.#slash("/quota", context.signal);
          const data = result.parsed?.command?.data;
          if (windows.length === 0) {
            windows = parseQuotaData(data, now);
            if (windows.length === 0) windows = parseQuotaText(result.parsed?.response ?? "", now);
          }
        } catch (error) {
          cliIdentityError = error;
          if (windows.length === 0) throw error;
        }
      }
      const email = extractAntigravityAccountEmail(
        result?.parsed,
        result?.output,
        result?.errorOutput,
      ) ?? await this.#resolveSessionEmail(session, context);
      const found = candidate(now, {
        email,
        session,
        existingAccounts: context.accounts ?? [],
        source,
        sourceKind: source === "antigravity_native"
          ? (session?.sourceKind ?? OFFICIAL_SESSION_SOURCE_KINDS.OAUTH_FILE)
          : OFFICIAL_SESSION_SOURCE_KINDS.CLI,
      });
      found.status = windows.length ? "available" : "degraded";
      found.diagnostic = windows.length
        ? null
        : source === "antigravity_native"
          ? "官方会话已读取，但没有返回结构化 quota 窗口"
          : "官方 CLI 已启动，但没有返回结构化 quota 窗口";
      return {
        candidates: [found],
        source,
        diagnostics: [
          ...(result?.parsed?.status === "SUCCESS" || !result ? [] : ["Antigravity CLI 返回了非成功状态"]),
          ...(cliIdentityError && windows.length ? ["官方 CLI 账号身份暂未返回；已使用本地会话标识"] : []),
        ],
      };
    } catch (error) {
      return {
        candidates: [],
        source: "official_antigravity_cli",
        diagnostics: [`无法读取 Antigravity 官方会话：${redactError(error)}`],
      };
    }
  }

  async importAccount(value, context = {}) {
    const session = value?.[CREDENTIAL_SLOT];
    if (!session) throw new Error("Antigravity candidate is no longer available; scan again");
    if (!context.secretStore) throw new Error("A secure credential store is required");
    await context.secretStore.write(value.credentialRef, session);
    // A newly imported account makes any cached Keychain read ambiguous.
    invalidateAntigravityKeychainCache();
    return {
      providerId: PROVIDER_ID,
      accountId: value.accountId,
      credentialRef: value.credentialRef,
      displayName: value.displayName,
      email: value.email ?? null,
      auth: { kind: OFFICIAL_SESSION_AUTH_KIND, scopes: [] },
      subscription: { plan: null, status: null, expiresAt: null },
      refresh: {
        accessTokenExpiresAt: session.expiresAt ?? null,
        nextRefreshAt: null,
        lastRefreshedAt: session.lastRefreshedAt ?? null,
        refreshable: session.refresh ? true : null,
      },
      resources: {
        ...officialSessionResources({
          sourceKind: value.resources?.sessionSource ?? OFFICIAL_SESSION_SOURCE_KINDS.CLI,
          authSource: value.source ?? "official_antigravity_cli_session",
        }),
        transport: "gemini_stream_generate_content_sse",
        quotaSource: value.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.DESKTOP_APP
          ? "official_client_status"
          : value.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER
            ? "antigravity_browser_oauth"
            : "antigravity_cli_status",
        ...(value.resources ?? {}),
      },
    };
  }

  async getActiveSession(context = {}) {
    try {
      const discovered = await this.discover(context);
      const candidateValue = discovered?.candidates?.[0];
      if (!candidateValue) return null;
      const account = await this.importAccount(candidateValue, context);
      return {
        status: "completed",
        providerId: PROVIDER_ID,
        instructions: "已检测到 Antigravity 官方会话，当前账号已接入 oauthpro。",
        accounts: [account],
        diagnostic: null,
      };
    } catch (error) {
      // Keep the no-session contract, but never swallow the cause silently:
      // the redacted failure rides along so callers can surface why the
      // official session could not be imported.
      return {
        status: "failed",
        providerId: PROVIDER_ID,
        instructions: "未能读取 Antigravity 官方会话，请重新扫描或登录。",
        accounts: [],
        diagnostic: redactError(error),
      };
    }
  }

  async startAuthorization(context = {}) {
    if (this.oauthAuthorizer !== this.browserAuthorizer || !this.browserAuthorizer) {
      return this.oauthAuthorizer.begin(context);
    }
    const started = await this.browserAuthorizer.begin(context);
    if (started.status === "failed") return this.cliOAuthAuthorizer.begin(context);
    return started;
  }

  #authorizationAuthorizer(sessionId) {
    if (sessionId?.includes(":browser:")) return this.browserAuthorizer;
    return this.oauthAuthorizer === this.browserAuthorizer ? this.cliOAuthAuthorizer : this.oauthAuthorizer;
  }

  async pollAuthorization(sessionId, context = {}) {
    return this.#authorizationAuthorizer(sessionId).poll(sessionId, context);
  }

  async submitAuthorizationCode(sessionId, code, context = {}) {
    return this.#authorizationAuthorizer(sessionId).submitAuthorizationCode(sessionId, code, context);
  }

  async cancelAuthorization(sessionId, context = {}) {
    return this.#authorizationAuthorizer(sessionId).cancel(sessionId, context);
  }

  async refreshAccount(account, context = {}) {
    const browserCredential = await this.#refreshBrowserCredential(account, context);
    const officialCredential = await this.#refreshOfficialCredential(account, context);
    await this.#assertActiveSession(account, {
      ...context,
      ...(officialCredential?.rotated ? { allowSessionTokenRotation: true } : {}),
    });
    const now = context.now instanceof Date ? context.now : new Date();
    let session = officialCredential?.session ?? null;
    try {
      session = session ?? await this.tokenResolver({ env: this.env });
    } catch {
      // The fingerprint below stays absent when the local session cannot be
      // read; the account keeps its existing fingerprint.
    }
    const sessionEmail = await this.#resolveSessionEmail(session, context);
    const fingerprint = sessionFingerprint(sessionEmail && session && !session.email
      ? { ...session, email: sessionEmail }
      : session);
    const fingerprintResources = fingerprint ? { sessionFingerprint: fingerprint } : {};
    const persistedRefreshMode = account?.resources?.sessionSource === OFFICIAL_SESSION_SOURCE_KINDS.BROWSER
      ? credentialRefreshMode(account)
        ?? (!this.browserClientId || !this.browserClientSecret
          ? ANTIGRAVITY_CREDENTIAL_REFRESH_MODES.AGY_SESSION
          : null)
      : null;
    const identityPatch = sessionEmail ? { email: sessionEmail } : {};
    let nativeError = null;
    try {
      const native = await this.#nativeQuota(account, {
        ...context,
        ...(officialCredential?.credential ? { officialCredential: officialCredential.credential } : {}),
      }, now);
      if (native) {
        const primary = selectPrimaryQuotaWindow(native.windows);
        return {
          ...identityPatch,
          quota: {
            ...primary,
            windows: native.windows,
            updatedAt: now.toISOString(),
            source: "antigravity_native",
          },
          credits: native.credits,
          resources: {
            quotaSource: "antigravity_native",
            ...(persistedRefreshMode ? { credentialRefreshMode: persistedRefreshMode } : {}),
            ...fingerprintResources,
          },
          refresh: {
            accessTokenExpiresAt: browserCredential?.expiresAt
              ?? officialCredential?.credential?.expiresAt
              ?? account.refresh?.accessTokenExpiresAt
              ?? null,
            nextRefreshAt: null,
            lastRefreshedAt: browserCredential?.lastRefreshedAt ?? account.refresh?.lastRefreshedAt ?? now.toISOString(),
            refreshable: browserCredential
              ? Boolean(browserCredential.refresh)
              : officialCredential?.credential
                ? Boolean(officialCredential.credential.refresh)
                : account.refresh?.refreshable ?? null,
          },
        };
      }
    } catch (error) {
      nativeError = error;
    }
    // Never use the process-wide `agy` session to refresh an imported
    // account. That makes separate Google accounts look identical.
    if (typeof this.quotaReader === "function" && account?.auth?.credentialRef) {
      throw nativeError ?? new Error("Antigravity native quota did not return data for the selected account");
    }
    const [result, creditsResult] = await Promise.all([
      this.#slash("/quota", context.signal),
      this.#slash("/credits", context.signal).catch(() => null),
    ]);
    if (result.parsed?.status && result.parsed.status !== "SUCCESS") {
      throw new Error("Antigravity official quota command did not complete");
    }
    const windows = parseQuotaData(result.parsed?.command?.data, now);
    const fallbackWindows = windows.length ? windows : parseQuotaText(result.parsed?.response ?? "", now);
    const primary = selectPrimaryQuotaWindow(fallbackWindows);
    return {
      ...identityPatch,
      quota: {
        ...primary,
        windows: fallbackWindows,
        updatedAt: now.toISOString(),
        source: "antigravity_cli",
      },
      credits: creditsFromData(creditsResult?.parsed?.command?.data),
      resources: fingerprintResources,
      refresh: {
        accessTokenExpiresAt: null,
        nextRefreshAt: null,
        lastRefreshedAt: now.toISOString(),
        refreshable: null,
      },
    };
  }

  async getQuota(account, context = {}) {
    const browserCredential = await this.#refreshBrowserCredential(account, context);
    const officialCredential = await this.#refreshOfficialCredential(account, context);
    await this.#assertActiveSession(account, {
      ...context,
      ...(officialCredential?.rotated ? { allowSessionTokenRotation: true } : {}),
    });
    const now = context.now instanceof Date ? context.now : new Date();
    let nativeError = null;
    try {
      const native = await this.#nativeQuota(account, {
        ...context,
        ...(browserCredential ? { browserCredential } : {}),
        ...(officialCredential?.credential ? { officialCredential: officialCredential.credential } : {}),
      }, now);
      if (native) {
        const primary = selectPrimaryQuotaWindow(native.windows);
        return {
          quota: {
            ...primary,
            windows: native.windows,
            updatedAt: now.toISOString(),
            source: "antigravity_native",
          },
          credits: native.credits,
          resources: { quotaSource: "antigravity_native" },
          refresh: {
            accessTokenExpiresAt: null,
            nextRefreshAt: null,
            lastRefreshedAt: now.toISOString(),
            refreshable: null,
          },
        };
      }
    } catch (error) {
      nativeError = error;
    }
    if (typeof this.quotaReader === "function" && account?.auth?.credentialRef) {
      throw nativeError ?? new Error("Antigravity native quota did not return data for the selected account");
    }
    const [quotaResult, creditsResult] = await Promise.all([
      this.#slash("/quota", context.signal),
      this.#slash("/credits", context.signal).catch(() => null),
    ]);
    const data = quotaResult.parsed?.command?.data;
    const windows = parseQuotaData(data, now);
    const fallbackWindows = windows.length ? windows : parseQuotaText(quotaResult.parsed?.response ?? "", now);
    const credits = creditsFromData(creditsResult?.parsed?.command?.data);
    const primary = selectPrimaryQuotaWindow(fallbackWindows);
    return {
      quota: {
        ...primary,
        windows: fallbackWindows,
        updatedAt: now.toISOString(),
        source: "antigravity_cli",
      },
      credits,
      refresh: {
        accessTokenExpiresAt: null,
        nextRefreshAt: null,
        lastRefreshedAt: now.toISOString(),
        refreshable: null,
      },
    };
  }

  async getCatalog(context = {}) {
    return this.catalogLoader({
      force: Boolean(context.force),
      accounts: context.accounts,
    });
  }

  async invoke(request, invocation, context = {}) {
    await this.#refreshBrowserCredential(invocation?.account, context);
    const officialCredential = await this.#refreshOfficialCredential(invocation?.account, context);
    await this.#assertActiveSession(invocation?.account, {
      ...context,
      ...(officialCredential?.rotated ? { allowSessionTokenRotation: true } : {}),
    });
    const executor = context.requestExecutor ?? this.requestExecutor;
    if (typeof executor !== "function") {
      throw new Error("Antigravity native invocation transport is not mounted");
    }
    return executor({ request, invocation, context });
  }

  async stream(request, invocation, context = {}) {
    return this.invoke(request, invocation, context);
  }
}

// Backward-compatible export for integrations that used the old CLI-specific
// class name before official desktop/session sources were supported.
export const AntigravityOfficialCliDriver = AntigravityOfficialSessionDriver;

export function createAntigravityDriver(options = {}) {
  return new AntigravityOfficialSessionDriver(options);
}

export const antigravityDriverConstants = Object.freeze({ providerId: PROVIDER_ID });
