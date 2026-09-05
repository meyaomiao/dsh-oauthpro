import { AsyncLocalStorage } from "node:async_hooks";
import { isAgentLoopRequest, markAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { JsonStateStore, defaultDockyardHome } from "../../runtime/src/state-store.mjs";
import { join } from "node:path";
import { usageModuleFor } from "./native-usage.mjs";
import { TokenUsageLedger } from "./token-usage-ledger.mjs";

const POLICIES = new Set(["manual", "round_robin", "failover"]);
const PATCH_MARK = Symbol("dockyard-native-key-pool");
const VISIBLE_STREAM_CHUNKS = new Set(["text-delta", "reasoning-delta", "tool-call-delta"]);

function isSharedUpstreamRateLimit(error) {
  const details = [
    error?.message,
    error?.metadata?.limit_source,
    error?.metadata?.raw,
  ].filter((value) => typeof value === "string").join(" ");
  return details.includes("upstream_provider_shared_pool")
    || details.includes("temporarily rate-limited upstream");
}

function retryableStreamError(error) {
  // Accepts thrown errors as well as bare stream-failure envelopes
  // (finish chunks): both expose the same classification fields.
  if (!error || typeof error !== "object") return false;
  // A shared upstream pool being throttled is not this key's fault; rotating
  // keys cannot help, so it must not trigger a pool-wide retry.
  if (isSharedUpstreamRateLimit(error)) return false;
  const statuses = [error.status, error.upstreamStatus, error.upstreamCode]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  return Boolean(
    error.rateLimited
      || error.quotaExhausted
      || error.authExpired
      || error.authForbidden
      || statuses.some((status) => [401, 403, 429].includes(status)),
  );
}

const NON_RETRYABLE_FAILURE_STATUSES = new Set([400, 404, 405, 413, 422]);
const NON_RETRYABLE_FAILURE_CODES = /INVALID_ARGUMENT|BAD_REQUEST|UNSUPPORTED|NOT_FOUND|CONTEXT_LENGTH|PAYLOAD/i;

/**
 * Terminal stream failures (finish chunks) are retryable by default while
 * nothing visible was emitted — an unclassified early failure is far more
 * likely transient than key-specific. Known request-shape problems are the
 * exception: they will fail identically on every other configured key, so
 * rotating would only burn through the pool and pollute key health.
 */
function nonRetryableStreamFailure(failure) {
  if (!failure || typeof failure !== "object") return false;
  const statuses = [failure.status, failure.upstreamStatus]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
  if (statuses.some((status) => NON_RETRYABLE_FAILURE_STATUSES.has(status))) return true;
  const codes = [failure.code, failure.upstreamCode]
    .filter((value) => typeof value === "string");
  return codes.some((code) => NON_RETRYABLE_FAILURE_CODES.test(code));
}

function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function applyContextWindowOverride(request, contextWindow) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) return request;
  const next = {
    ...request,
    modelContext: {
      ...(request?.modelContext ?? {}),
      contextWindow,
    },
  };
  // DSH marks the original agent-loop request by object identity. Preserve
  // that identity classification when the immutable request is copied.
  if (isAgentLoopRequest(request)) markAgentLoopRequest(next);
  return next;
}

function applyModelContextWindow(model, contextWindow) {
  if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0
    || !model || typeof model !== "object") return model;
  return {
    ...model,
    context: {
      ...(model.context ?? {}),
      contextWindow,
    },
    // dsh-llm-pi-ai keeps its internal resolved model in this flat shape.
    // Preserve it as well so its stream-side overflow classification uses the
    // same effective capacity as the durable DSH request/context event.
    ...(Number.isInteger(model.contextWindow) ? { contextWindow } : {}),
  };
}

async function* iterateWithContext(storage, state, next) {
  const output = await storage.run(state, () => next());
  const iterator = await storage.run(state, () => {
    if (output?.[Symbol.asyncIterator]) return output[Symbol.asyncIterator]();
    if (output?.[Symbol.iterator]) return output[Symbol.iterator]();
    return null;
  });
  if (!iterator) return;
  try {
    while (true) {
      const result = await storage.run(state, () => iterator.next());
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await storage.run(state, () => iterator.return?.());
  }
}

function pathValue(source, path = []) {
  let current = source;
  for (const segment of path) {
    if (!current || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function cleanRecord(raw) {
  const keys = Array.isArray(raw?.keys) ? raw.keys.filter((entry) => text(entry?.ref)).map((entry) => ({
    ref: text(entry.ref),
    label: text(entry.label) ?? text(entry.ref),
    createdAt: text(entry.createdAt),
  })) : [];
  return {
    policy: POLICIES.has(raw?.policy) ? raw.policy : "manual",
    keys,
  };
}

function publicCredential(info) {
  if (!info || typeof info !== "object") return { configured: false };
  return {
    configured: info.configured === true,
    ...(typeof info.source === "string" ? { source: info.source } : {}),
    ...(typeof info.writable === "boolean" ? { writable: info.writable } : {}),
  };
}

function failureMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "未知错误");
}

function nativeProfile(ctx, providerId) {
  const hasGetter = typeof ctx?.get === "function";
  const llm = hasGetter ? ctx.get("llm") : ctx.llm;
  const settings = hasGetter ? ctx.get("settings") : ctx.settings;
  const entry = llm?.listConfigurableProviders?.().find((candidate) => candidate.provider === providerId) ?? null;
  const profile = entry && settings?.get ? pathValue(settings.get(entry.settingsNs), entry.settingsPath) : null;
  if (!entry || !profile || typeof profile !== "object") return { entry, profile: null };
  const native = entry.settingsNs === "llm-pi-ai" || text(profile.apiKeyEnv) !== null;
  return { entry, profile: native ? profile : null };
}

export class NativeKeyPoolHost {
  ctx;
  credentials;
  settings;
  llm;
  logger;
  stateStore;
  contextWindowOverrides;
  records = new Map();
  cursors = new Map();
  #lastResolvedKey = new Map();
  #requestKeys;
  #requestContext = new AsyncLocalStorage();
  #contextOverrideRequests = new WeakSet();
  patches = [];
  offAdapters = null;
  offStreams = null;
  readyPromise;

  constructor(ctx, { logger = null, stateStore = null, usageLedger = null, contextWindowOverrides = null } = {}) {
    this.ctx = ctx;
    // The plugin constructor can run while Cordis is still composing the
    // profile. Resolve services in start(), after the fiber is active; reading
    // a missing service here aborts the whole DSH boot before the web server
    // can even mount.
    this.credentials = null;
    this.settings = null;
    this.llm = null;
    // `ctx` is a Cordis proxy. Optional chaining does not make a missing
    // injected property safe, so never read ctx.logger during composition.
    this.logger = logger ?? console;
    this.contextWindowOverrides = contextWindowOverrides;
    this.stateStore = stateStore ?? new JsonStateStore({
      filePath: join(defaultDockyardHome(), "native-key-pools.json"),
    });
    // Token usage lives in its own state file so pool metadata writes can
    // never truncate usage history (and vice versa). A shared ledger can be
    // injected so OAuth accounts and API keys report into one store.
    this.usageLedger = usageLedger ?? new TokenUsageLedger({
      filePath: join(defaultDockyardHome(), "token-usage.json"),
      logger: this.logger,
    });
    void this.usageLedger.load?.()?.catch((error) => {
      this.logger.warn?.(`token 用量记录初始化失败：${error instanceof Error ? error.message : error}`);
    });
    // Request-scoped attribution: resolveApiKey stamps the chosen ref into the
    // running stream's context so concurrent streams each record their own key
    // even under round-robin rotation.
    this.#requestKeys = new AsyncLocalStorage();
    this.readyPromise = this.loadState();
  }

  resolveServices() {
    const get = (name) => {
      try {
        if (typeof this.ctx?.get === "function") return this.ctx.get(name);
        return this.ctx?.[name];
      } catch {
        return null;
      }
    };
    this.credentials = get("credentials");
    this.settings = get("settings");
    this.llm = get("llm");
  }

  async loadState() {
    try {
      const state = await this.stateStore.load();
      const providers = state?.nativeKeyPools;
      if (providers && typeof providers === "object") {
        for (const [providerId, record] of Object.entries(providers)) {
          this.records.set(providerId, cleanRecord(record));
        }
      }
    } catch (error) {
      this.logger.warn?.(`native Key 池状态读取失败：${failureMessage(error)}`);
    }
    return this;
  }

  async saveState() {
    const nativeKeyPools = Object.fromEntries([...this.records].map(([providerId, record]) => [
      providerId,
      cleanRecord(record),
    ]));
    await this.stateStore.save({ nativeKeyPools });
  }

  async start() {
    await this.readyPromise;
    await this.contextWindowOverrides?.ready?.();
    this.resolveServices();
    this.patchAdapters();
    if (typeof this.ctx.on === "function") {
      this.offAdapters = this.ctx.on("llm/adapters-updated", () => this.patchAdapters());
      this.offStreams = this.ctx.on("llm/stream", (options, next) => this.stream(options, next));
    }
    this.patchAdapters();
    return this;
  }

  dispose() {
    this.offAdapters?.();
    this.offStreams?.();
    this.offAdapters = null;
    this.offStreams = null;
    for (const patch of this.patches.splice(0)) {
      if (patch.config?.resolveApiKey?.[PATCH_MARK] === patch.wrapper) {
        patch.config.resolveApiKey = patch.original;
      }
      if (patch.target?.[patch.method]?.[PATCH_MARK] === patch.wrapper) {
        patch.target[patch.method] = patch.original;
      }
    }
    // Flush pending usage writes; never let teardown fail the host.
    void this.usageLedger?.dispose?.().catch?.(() => {});
  }

  contextWindowForModel(providerId, modelId) {
    if (!text(providerId) || !text(modelId)
      || !this.contextWindowOverrides?.hasAny?.(providerId, modelId)) return null;
    const profile = nativeProfile(this.ctx, providerId).profile;
    const keyRef = text(profile?.apiKeyEnv);
    return this.contextWindowOverrides.resolve(providerId, modelId, {
      ...(keyRef ? { keyRef } : {}),
    });
  }

  patchAdapterMethod(adapter, method, transform) {
    const original = adapter?.[method];
    if (typeof original !== "function" || original?.[PATCH_MARK]) return;
    const wrapper = transform(original);
    Object.defineProperty(wrapper, PATCH_MARK, { value: wrapper });
    adapter[method] = wrapper;
    this.patches.push({ target: adapter, method, original, wrapper });
  }

  patchAdapters() {
    const adapters = this.llm?.adapters;
    if (!adapters || typeof adapters.values !== "function") return;
    const thisHost = this;
    for (const registration of adapters.values()) {
      const adapter = registration?.adapter;
      const config = adapter?.config;
      const original = config?.resolveApiKey;
      if (!config || typeof original !== "function" || original?.[PATCH_MARK]) continue;
      // llm-pi-ai resolves `(provider, profile)`, while the optional native
      // DeepSeek adapter resolves `(connection)`. Keep both wire contracts
      // intact; the request-level pool only replaces the bearer value.
      const directConnectionResolver = typeof config.options === "function"
        && typeof config.resolveUserId === "function";
      const wrapper = directConnectionResolver
        ? async (connection) => this.resolveDirectApiKey(connection, original)
        : async (providerId, profile) => this.resolveApiKey(providerId, profile, original);
      Object.defineProperty(wrapper, PATCH_MARK, { value: wrapper });
      config.resolveApiKey = wrapper;
      this.patches.push({ config, original, wrapper });

      // DSH records request/context from the model metadata resolved by the
      // adapter, before the later llm/stream waterfall runs. Patch the
      // adapter's model seams too, otherwise a request override can be real
      // at the provider boundary while the session meter still shows the
      // catalog's stale 262K/272K capacity.
      this.patchAdapterMethod(adapter, "modelOf", (modelOf) => function (...args) {
        const model = modelOf.apply(this, args);
        const contextWindow = thisHost.contextWindowForModel(args[1], args[2]);
        return applyModelContextWindow(model, contextWindow);
      });
      this.patchAdapterMethod(adapter, "resolveModel", (resolveModel) => async function (...args) {
        const model = await resolveModel.apply(this, args);
        const contextWindow = thisHost.contextWindowForModel(args[0], args[1]);
        return applyModelContextWindow(model, contextWindow);
      });
      this.patchAdapterMethod(adapter, "prepareCall", (prepareCall) => async function (...args) {
        const prepared = await prepareCall.apply(this, args);
        const contextWindow = thisHost.contextWindowForModel(args[0], args[1]);
        if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0
          || !prepared || typeof prepared !== "object") return prepared;
        return {
          ...prepared,
          model: applyModelContextWindow(prepared.model, contextWindow),
        };
      });
    }
  }

  record(providerId) {
    let record = this.records.get(providerId);
    if (!record) {
      record = cleanRecord({});
      this.records.set(providerId, record);
    }
    return record;
  }

  async syncProvider(providerId, profileHint = null) {
    await this.readyPromise;
    const profile = profileHint ?? nativeProfile(this.ctx, providerId).profile;
    const activeRef = text(profile?.apiKeyEnv);
    if (!activeRef) return { profile, activeRef: null, record: this.record(providerId) };
    const record = this.record(providerId);
    if (!record.keys.some((entry) => entry.ref === activeRef)) {
      record.keys.push({ ref: activeRef, label: "当前 DSH Key", createdAt: new Date().toISOString() });
      await this.saveState();
    }
    return { profile, activeRef, record };
  }

  async register(providerId, ref, label = "") {
    const keyRef = text(ref);
    if (!text(providerId) || !keyRef) throw new Error("provider 和 Key 引用不能为空");
    const { record } = await this.syncProvider(providerId);
    const current = record.keys.find((entry) => entry.ref === keyRef);
    if (current) {
      current.label = text(label) ?? current.label;
    } else {
      record.keys.push({ ref: keyRef, label: text(label) ?? `Key ${record.keys.length + 1}`, createdAt: new Date().toISOString() });
    }
    await this.saveState();
    return this.status(providerId);
  }

  async unregister(providerId, ref) {
    const record = this.record(providerId);
    record.keys = record.keys.filter((entry) => entry.ref !== ref);
    await this.saveState();
    return this.status(providerId);
  }

  async setPolicy(providerId, policy) {
    if (!POLICIES.has(policy)) throw new Error(`不支持的 Key 策略：${policy}`);
    const record = this.record(providerId);
    record.policy = policy;
    this.cursors.delete(providerId);
    await this.saveState();
    return this.status(providerId);
  }

  async credentialInfo(ref) {
    try {
      if (typeof this.credentials?.describe !== "function") return { configured: false };
      return publicCredential(await this.credentials.describe(ref));
    } catch (error) {
      return { configured: false, error: failureMessage(error) };
    }
  }

  async configuredKeys(record) {
    const rows = [];
    for (const entry of record.keys) {
      const credential = await this.credentialInfo(entry.ref);
      rows.push({ ...entry, configured: credential.configured, credential });
    }
    return rows;
  }

  usageSnapshot(providerId) {
    try {
      return this.usageLedger?.snapshot(providerId) ?? null;
    } catch {
      return null;
    }
  }

  async status(providerId) {
    const synced = await this.syncProvider(providerId);
    const rows = await this.configuredKeys(synced.record);
    const tokenUsage = this.usageSnapshot(providerId);
    return {
      providerId,
      policy: synced.record.policy,
      activeRef: synced.activeRef,
      runtimeMode: this.patches.length > 0 ? "request-key-pool" : "native-single-key",
      keys: rows.map((entry) => ({
        ...entry,
        active: entry.ref === synced.activeRef,
        tokenUsage: tokenUsage?.subjects?.[entry.ref] ?? null,
      })),
      tokenTotals: tokenUsage?.totals ?? null,
      tokenUpdatedAt: tokenUsage?.updatedAt ?? null,
      quota: null,
      usage: null,
    };
  }

  /** Clear recorded token usage for one key ref or the whole provider. */
  async resetUsage(providerId, ref = null) {
    await this.readyPromise;
    let cleared = { providers: 0, subjects: 0 };
    if (this.usageLedger && text(providerId)) {
      cleared = this.usageLedger.reset(providerId, text(ref));
      try {
        await this.usageLedger.flush();
      } catch (error) {
        this.logger.warn?.(`token 用量重置写入失败：${error instanceof Error ? error.message : error}`);
      }
    }
    return { ...(await this.status(providerId)), cleared };
  }

  async pickKey(providerId, record, activeRef, { excluded = [] } = {}) {
    const candidates = [];
    for (const entry of record.keys) {
      const credential = await this.credentialInfo(entry.ref);
      if (credential.configured) candidates.push(entry);
    }
    if (candidates.length === 0) return null;
    const excludedSet = new Set(excluded);
    const available = candidates.filter((entry) => !excludedSet.has(entry.ref));
    const pool = available.length > 0 ? available : candidates;
    const policy = record.policy;
    if (policy === "manual") {
      return pool.find((entry) => entry.ref === activeRef) ?? pool[0];
    }
    if (policy === "failover") {
      // Failover keeps one primary key for every healthy request and only
      // advances to the next configured key when a retry excludes the failed
      // one. This preserves prompt-cache locality instead of rotating keys.
      return pool.find((entry) => entry.ref === activeRef) ?? pool[0];
    }
    const cursor = this.cursors.get(providerId) ?? 0;
    const chosen = pool[cursor % pool.length];
    this.cursors.set(providerId, (cursor + 1) % pool.length);
    return chosen;
  }

  /**
   * Remember which key ref backs the current request so token usage can be
   * attributed per credential. The AsyncLocalStorage store is authoritative
   * for streams pulled inside this host's middleware; the provider-keyed map
   * stays as a fallback for resolvers invoked outside that chain.
   */
  #trackResolvedKey(providerId, ref) {
    if (!providerId || !ref) return;
    const store = this.#requestKeys.getStore();
    if (store?.provider === providerId) store.ref = ref;
    this.#lastResolvedKey.set(providerId, ref);
  }

  async prepareContextWindow(options, requestState) {
    const providerId = text(options?.provider);
    const modelId = text(options?.model);
    if (!providerId || !modelId || !this.contextWindowOverrides?.hasAny?.(providerId, modelId)) return options;

    const profile = nativeProfile(this.ctx, providerId).profile;
    const synced = await this.syncProvider(providerId, profile);
    let chosen = null;
    if (synced.profile && synced.activeRef && typeof this.credentials?.resolve === "function") {
      chosen = await this.pickKey(providerId, synced.record, synced.activeRef, {
        excluded: [...(requestState?.excluded ?? [])],
      });
      if (chosen) requestState.preselectedKeyRef = chosen.ref;
    }
    const contextWindow = this.contextWindowOverrides.resolve(providerId, modelId, {
      ...(chosen?.ref ? { keyRef: chosen.ref } : {}),
    });
    return applyContextWindowOverride(options, contextWindow);
  }

  async *streamWithContextWindow(options, next, requestState) {
    requestState.preselectedKeyRef = null;
    const prepared = await this.prepareContextWindow(options, requestState);
    if (prepared === options || typeof this.llm?.stream !== "function") {
      // The direct host seam used by older integrations has no LLM runtime to
      // re-enter. Keep its original behavior; the DSH runtime always has one.
      yield* next();
      return;
    }

    // `llm/stream`'s next() closes over the original immutable request, so a
    // returned copy cannot be passed downstream through next(). Re-enter the
    // runtime with the copy and let this listener pass its marked request on
    // to the rest of the waterfall exactly once.
    this.#contextOverrideRequests.add(prepared);
    try {
      yield* iterateWithContext(this.#requestContext, requestState, () => this.llm.stream(prepared));
    } finally {
      this.#contextOverrideRequests.delete(prepared);
    }
  }

  async resolveApiKey(providerId, profile, original) {
    const synced = await this.syncProvider(providerId, profile);
    if (!synced.profile || !synced.activeRef || synced.record.policy === "manual" || typeof this.credentials?.resolve !== "function") {
      // Manual policy keeps DSH's own active key; attribution falls back to
      // the active ref, which is exactly the credential being used.
      if (synced.profile && synced.record.policy === "manual") {
        this.#trackResolvedKey(providerId, synced.activeRef);
      }
      return original(providerId, profile);
    }
    const requestState = this.#requestContext.getStore();
    const excluded = [...(requestState?.excluded ?? [])];
    const forced = text(requestState?.preselectedKeyRef);
    const chosen = forced
      ? synced.record.keys.find((entry) => entry.ref === forced) ?? await this.pickKey(providerId, synced.record, synced.activeRef, { excluded })
      : await this.pickKey(providerId, synced.record, synced.activeRef, { excluded });
    if (!chosen) return original(providerId, profile);
    if (synced.record.policy === "failover") this.#lastResolvedKey.set(providerId, chosen.ref);
    if (requestState) requestState.lastResolvedKey = chosen.ref;
    this.#trackResolvedKey(providerId, chosen.ref);
    const resolved = await this.credentials.resolve(chosen.ref);
    const value = text(resolved?.value);
    if (value) return value;
    return original(providerId, profile);
  }

  async resolveDirectApiKey(connection, original) {
    const providerId = "deepseek-official";
    const synced = await this.syncProvider(providerId, connection);
    if (!synced.profile || !synced.activeRef || synced.record.policy === "manual" || typeof this.credentials?.resolve !== "function") {
      if (synced.profile && synced.record.policy === "manual") {
        this.#trackResolvedKey(providerId, synced.activeRef);
      }
      return original(connection);
    }
    const requestState = this.#requestContext.getStore();
    const excluded = [...(requestState?.excluded ?? [])];
    const forced = text(requestState?.preselectedKeyRef);
    const chosen = forced
      ? synced.record.keys.find((entry) => entry.ref === forced) ?? await this.pickKey(providerId, synced.record, synced.activeRef, { excluded })
      : await this.pickKey(providerId, synced.record, synced.activeRef, { excluded });
    if (!chosen) return original(connection);
    if (synced.record.policy === "failover") this.#lastResolvedKey.set(providerId, chosen.ref);
    if (requestState) requestState.lastResolvedKey = chosen.ref;
    this.#trackResolvedKey(providerId, chosen.ref);
    const resolved = await this.credentials.resolve(chosen.ref);
    const value = text(resolved?.value);
    if (value) return value;
    return original(connection);
  }

  /**
   * 多 Key 策略（failover 与 round_robin）都允许在单次请求内换键：
   * - failover：主键优先，失败后顺延；
   * - round_robin：起点照常轮转，失败后在本次请求内顺延下一把，
   *   避免瞬时单 key 失败直接抛给外层重试造成可见报错。
   * manual 永不换键。共享池限流不参与换键（isSharedUpstreamRateLimit）。
   */
  shouldRetry(providerId) {
    const record = this.records.get(providerId);
    return Boolean(record && record.policy !== "manual" && record.keys.length > 1);
  }

  /**
   * Request-scoped attribution context for one llm/stream invocation. The
   * adapter resolves its API key inside the very first pull of each request —
   * auth must precede any chunk — so only those leading pulls run inside the
   * request-scoped AsyncLocalStorage frame. As soon as a real chunk surfaces,
   * the stream delegates directly and steady-state pass-through keeps the
   * previous zero-per-chunk overhead. Failover retries that resolve after
   * delegation attribute via the provider-keyed map, which tracks their
   * sequential attempts exactly.
   */
  async *stream(options, next) {
    if (typeof next !== "function") return;
    if (this.#contextOverrideRequests.delete(options)) {
      yield* next();
      return;
    }
    const providerId = text(options?.provider);
    if (!providerId || typeof this.#requestKeys?.run !== "function") {
      yield* this.#pooledStream(options, next);
      return;
    }
    const store = { provider: providerId, ref: null };
    const iterator = this.#pooledStream(options, next, store);
    try {
      while (true) {
        const result = await this.#requestKeys.run(store, () => iterator.next());
        if (result.done) return;
        yield result.value;
        if (result.value?.type !== undefined) {
          yield* iterator;
          return;
        }
      }
    } finally {
      await Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }

  #currentAttributionRef(store, providerId) {
    return store?.ref ?? this.#lastResolvedKey.get(providerId) ?? null;
  }

  #recordTokenUsage(providerId, ref, info) {
    if (!providerId || !ref) return;
    try {
      this.usageLedger?.record(providerId, ref, info);
    } catch {
      // Usage bookkeeping must never break or alter the streamed response.
    }
  }

  async *#consumeOnce(options, next, store) {
    const providerId = store.provider;
    const model = text(options?.model);
    let usage = null;
    let failedFinish = false;
    try {
      for await (const chunk of next()) {
        if (chunk?.type === "usage" && chunk.usage) usage = chunk.usage;
        if (chunk?.type === "finish") failedFinish = chunk.reason?.kind === "error";
        yield chunk;
      }
    } catch (error) {
      // Inside the pooled retry loop the outer attempt bookkeeping owns the
      // failure record (it knows the exact attempt usage); recording here too
      // would double-count. Standalone (non-retry) calls record here.
      if (!store?.suppressThrowRecord) {
        this.#recordTokenUsage(providerId, this.#currentAttributionRef(store, providerId), {
          status: "failure",
          usage,
          model,
        });
      }
      throw error;
    }
    this.#recordTokenUsage(providerId, this.#currentAttributionRef(store, providerId), {
      status: failedFinish ? "failure" : "success",
      usage,
      model,
    });
  }

  async *#pooledStream(options, next, store = null) {
    const providerId = store?.provider ?? text(options?.provider);
    const attributionStore = store ?? { provider: providerId, ref: null };
    if (this.#contextOverrideRequests.delete(options)) {
      yield* next();
      return;
    }
    const requestState = { excluded: new Set(), lastResolvedKey: null };
    if (!this.shouldRetry(providerId)) {
      yield* iterateWithContext(this.#requestContext, requestState, async () => {
        return this.streamWithContextWindow(options, () => this.#consumeOnce(options, next, attributionStore), requestState);
      });
      return;
    }
    const configured = await this.configuredKeys(this.records.get(providerId));
    const attempts = Math.max(1, configured.filter((entry) => entry.configured).length);
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      // Failover semantics: the first attempt uses the primary key; each
      // retry excludes the key that just failed so the next attempt advances
      // to the next configured key. The exclusion set is cleared when the
      // stream settles so healthy requests return to the primary key.
      if (attempt > 0 && requestState.lastResolvedKey) {
        requestState.excluded.add(requestState.lastResolvedKey);
      }
      // Each attempt resolves its own key; reset attribution before pulling.
      attributionStore.ref = null;
      attributionStore.suppressThrowRecord = true;
      const buffered = [];
      let emitted = false;
      let retryable = false;
      let attemptUsage = null;
      try {
        const output = iterateWithContext(this.#requestContext, requestState, async () => {
          return this.streamWithContextWindow(options, () => this.#consumeOnce(options, next, attributionStore), requestState);
        });
        for await (const chunk of output) {
          if (chunk?.type === "usage" && chunk.usage) attemptUsage = chunk.usage;
          if (VISIBLE_STREAM_CHUNKS.has(chunk?.type)) emitted = true;
          if (!emitted) buffered.push(chunk);
          else if (buffered.length > 0) {
            yield* buffered.splice(0);
            yield chunk;
          } else yield chunk;
          if (chunk?.type === "finish" && chunk.reason?.kind === "error") {
            // Retry unclassified terminal failures, but skip known
            // non-retryable request errors (invalid argument, unsupported
            // model, context length) and shared upstream-pool throttling:
            // they fail identically on every other key and would only burn
            // the pool and pollute key health.
            retryable = !emitted && !nonRetryableStreamFailure(chunk.reason.failure)
              && !isSharedUpstreamRateLimit(chunk.reason.failure);
            if (retryable && attempt + 1 < attempts) break;
          }
        }
      } catch (error) {
        retryable = !emitted && retryableStreamError(error);
        if (!retryable || attempt + 1 >= attempts) {
          this.#recordTokenUsage(providerId, this.#currentAttributionRef(attributionStore, providerId), {
            status: "failure",
            usage: null,
            model: text(options?.model),
          });
          throw error;
        }
      }
      if (retryable && !emitted && attempt + 1 < attempts) {
        // The broken-out attempt never settled its #consumeOnce wrapper, so
        // record its usage here before advancing to the next key.
        this.#recordTokenUsage(providerId, this.#currentAttributionRef(attributionStore, providerId), {
          status: "failure",
          usage: attemptUsage,
          model: text(options?.model),
        });
        continue;
      }
      if (buffered.length > 0) yield* buffered;
      return;
    }
  }

  async refreshUsage(providerId, signal) {
    const synced = await this.syncProvider(providerId);
    const rows = await this.configuredKeys(synced.record);
    const module = usageModuleFor(providerId, synced.profile);
    const nextRows = [];
    for (const row of rows) {
      let usage;
      if (!row.configured || typeof this.credentials?.resolve !== "function") {
        usage = { status: "unconfigured", message: "该 Key 尚未配置" };
      } else {
        try {
          const resolved = await this.credentials.resolve(row.ref);
          const apiKey = text(resolved?.value);
          usage = apiKey
            ? await module.fetch({ providerId, profile: synced.profile, apiKey, signal })
            : { status: "unconfigured", message: "该 Key 尚未配置" };
        } catch (error) {
          usage = { status: "error", message: failureMessage(error), updatedAt: new Date().toISOString() };
        }
      }
      nextRows.push({ ...row, active: row.ref === synced.activeRef, usage, quota: usage?.quota ?? null });
    }
    const active = nextRows.find((entry) => entry.active) ?? nextRows[0] ?? null;
    const tokenUsage = this.usageSnapshot(providerId);
    return {
      providerId,
      policy: synced.record.policy,
      activeRef: synced.activeRef,
      runtimeMode: this.patches.length > 0 ? "request-key-pool" : "native-single-key",
      keys: nextRows.map((entry) => ({ ...entry, tokenUsage: tokenUsage?.subjects?.[entry.ref] ?? null })),
      usage: active?.usage ?? { status: "unsupported", message: "provider 尚未返回额度数据" },
      quota: active?.quota ?? null,
      tokenTotals: tokenUsage?.totals ?? null,
      tokenUpdatedAt: tokenUsage?.updatedAt ?? null,
      updatedAt: new Date().toISOString(),
    };
  }
}
