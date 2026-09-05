import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { validateNativeEndpoint } from "../../providers/src/native-transport.mjs";

const builtinBaseUrls = new Map();
for (const provider of builtinProviders()) {
  if (typeof provider?.id === "string" && typeof provider?.baseUrl === "string") {
    builtinBaseUrls.set(provider.id, provider.baseUrl);
  }
}

function baseUrlFor(providerId, profile) {
  const configured = typeof profile?.baseURL === "string" ? profile.baseURL.trim() : "";
  const baseUrl = configured || builtinBaseUrls.get(providerId) || null;
  return baseUrl ? validateNativeEndpoint(baseUrl, { providerId }) : null;
}

function endpoint(baseUrl, path) {
  if (!baseUrl) throw new Error("provider 没有返回可用的 base URL");
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\//, ""), base).toString();
}

async function readJson(response) {
  const raw = await response.text();
  let body;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const detail = typeof body?.error === "string"
      ? body.error
      : body?.error?.message ?? body?.message ?? response.statusText;
    throw new Error(`${response.status} ${detail || "provider usage 请求失败"}`);
  }
  if (!body || typeof body !== "object") throw new Error("provider usage 返回了无效 JSON");
  return body;
}

function bearerHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json" };
}

function updatedAt() {
  return new Date().toISOString();
}

/** Recognize the z.ai / BigModel coding-plan quota payload; null for other API families. */
function zaiQuotaFrom(body) {
  if (body?.code !== 200 || body?.success !== true || !Array.isArray(body?.data?.limits)) return null;
  const refreshedAt = updatedAt();
  const unitLabels = { 1: "天", 3: "小时", 5: "分钟", 6: "个月" };
  const windows = body.data.limits
    .filter((limit) => limit && typeof limit === "object")
    .map((limit) => {
      const unitLabel = unitLabels[limit.unit] ?? "个周期";
      const isCredit = limit.type === "CREDIT_LIMIT";
      return {
        id: `zai-${limit.type ?? "window"}-${limit.number ?? "?"}${unitLabel}`,
        name: `${limit.number ?? "?"} ${unitLabel}${isCredit ? "额度窗口" : "窗口"}`,
        kind: "subscription",
        remaining: typeof limit.remaining === "number"
          ? limit.remaining
          : (typeof limit.percentage === "number" ? 100 - limit.percentage : null),
        usedPercent: typeof limit.percentage === "number" ? limit.percentage : null,
        limit: typeof limit.usage === "number" ? limit.usage : 100,
        unit: isCredit ? "credits" : "%",
        resetAt: Number.isFinite(Number(limit.nextResetTime)) && Number(limit.nextResetTime) > 0
          ? new Date(Number(limit.nextResetTime)).toISOString()
          : null,
        updatedAt: refreshedAt,
      };
    });
  if (windows.length === 0) return null;
  const plan = body.data.level ?? body.data.planName ?? body.data.plan ?? null;
  return {
    status: "ok",
    source: "z.ai /api/monitor/usage/quota/limit",
    updatedAt: refreshedAt,
    available: true,
    plan,
    quota: { windows },
    details: { plan, limits: body.data.limits.length },
  };
}

function zaiQuotaModule() {
  return {
    id: "zai-quota",
    supports: ["zai", "zai-coding-cn", "zhipu", "glm"],
    async fetch({ providerId, profile, apiKey, signal }) {
      const baseUrl = baseUrlFor(providerId, profile);
      if (!baseUrl) throw new Error("provider 没有返回可用的 base URL");
      // The quota endpoint hangs off the host origin, not the /v4 API prefix.
      const origin = new URL(baseUrl).origin;
      const body = await readJson(await fetch(endpoint(origin, "api/monitor/usage/quota/limit"), {
        method: "GET",
        headers: bearerHeaders(apiKey),
        signal,
      }));
      const mapped = zaiQuotaFrom(body);
      if (!mapped) throw new Error("z.ai 余额接口返回了无法识别的响应形状");
      return mapped;
    },
  };
}

/** Recognize the official DeepSeek balance payload; null when it is a different API family. */
function deepseekBalanceFrom(body) {
  const balances = Array.isArray(body?.balance_infos) ? body.balance_infos : null;
  if (!balances) return null;
  const refreshedAt = updatedAt();
  return {
    status: "ok",
    source: "DeepSeek /user/balance",
    updatedAt: refreshedAt,
    available: body.is_available === true,
    quota: {
      windows: balances.map((balance) => ({
        id: `balance-${balance.currency ?? "unknown"}`,
        name: "账户余额",
        kind: "balance",
        remaining: typeof balance.total_balance === "string" || typeof balance.total_balance === "number"
          ? balance.total_balance
          : null,
        limit: null,
        unit: balance.currency ?? null,
        resetAt: null,
        updatedAt: refreshedAt,
      })),
    },
    details: balances.map((balance) => ({
      currency: balance.currency ?? null,
      totalBalance: balance.total_balance ?? null,
      grantedBalance: balance.granted_balance ?? null,
      toppedUpBalance: balance.topped_up_balance ?? null,
    })),
  };
}

/** Recognize the official OpenRouter credits payload; null when it is a different API family. */
function openRouterCreditsFrom(body) {
  const data = body?.data ?? body;
  if (!data || typeof data !== "object" || typeof data.total_credits !== "number") return null;
  const total = data.total_credits;
  const used = typeof data.total_usage === "number" ? data.total_usage : null;
  const refreshedAt = updatedAt();
  return {
    status: "ok",
    source: "OpenRouter /api/v1/credits",
    updatedAt: refreshedAt,
    quota: {
      windows: [{
        id: "credits",
        name: "剩余 credits",
        kind: "balance",
        remaining: total !== null && used !== null ? total - used : null,
        limit: total,
        unit: "USD",
        resetAt: null,
        updatedAt: refreshedAt,
      }],
    },
    details: { totalCredits: total, totalUsage: used },
  };
}

function deepseekBalanceModule() {
  return {
    id: "deepseek-balance",
    supports: ["deepseek", "deepseek-official"],
    async fetch({ providerId, profile, apiKey, signal }) {
      const body = await readJson(await fetch(endpoint(baseUrlFor(providerId, profile), "user/balance"), {
        method: "GET",
        headers: bearerHeaders(apiKey),
        signal,
      }));
      return deepseekBalanceFrom(body);
    },
  };
}

function openRouterCreditsModule() {
  return {
    id: "openrouter-credits",
    supports: ["openrouter"],
    async fetch({ providerId, profile, apiKey, signal }) {
      const body = await readJson(await fetch(endpoint(baseUrlFor(providerId, profile), "credits"), {
        method: "GET",
        headers: bearerHeaders(apiKey),
        signal,
      }));
      return openRouterCreditsFrom(body);
    },
  };
}

/**
 * Custom providers configured in DSH settings (llm-pi-ai.providers) often point
 * at gateways that speak a known protocol family (DeepSeek-compatible
 * aggregators, OpenRouter-compatible proxies) under a custom provider id.
 * Probe the known balance endpoints against the configured baseURL and surface
 * real diagnostics instead of a blanket "unsupported".
 */
function customEndpointProbeModule() {
  const probes = [
    { family: "deepseek", path: "user/balance", map: deepseekBalanceFrom },
    { family: "openrouter", path: "credits", map: openRouterCreditsFrom },
    {
      family: "zai",
      // The z.ai quota endpoint hangs off the host origin, not the API prefix.
      url: (baseUrl) => endpoint(new URL(baseUrl).origin, "api/monitor/usage/quota/limit"),
      map: zaiQuotaFrom,
    },
  ];
  return {
    id: "custom-endpoint-probe",
    supports: [],
    async fetch({ providerId, profile, apiKey, signal }) {
      const baseUrl = baseUrlFor(providerId, profile);
      if (!baseUrl) {
        return unsupportedModule([providerId], "该 provider 没有配置 baseURL，无法探测余额接口。", null)
          .fetch({ providerId });
      }
      const diagnostics = [];
      for (const probe of probes) {
        try {
          const url = probe.url ? probe.url(baseUrl) : endpoint(baseUrl, probe.path);
          const response = await fetch(url, {
            method: "GET",
            headers: bearerHeaders(apiKey),
            signal,
          });
          const body = await readJson(response);
          const mapped = probe.map(body);
          if (mapped) {
            return {
              ...mapped,
              source: `${mapped.source} (probe)`,
              details: { ...mapped.details, probedFamily: probe.family },
            };
          }
          diagnostics.push(`${url}: 响应不是 ${probe.family} 余额格式`);
        } catch (error) {
          diagnostics.push(`${probe.family}: ${error?.message ?? String(error)}`);
        }
      }
      return {
        status: "unsupported",
        source: "provider official API",
        providerId,
        message: "该 provider 的 baseURL 没有响应已知的余额接口（DeepSeek /user/balance、OpenRouter /credits、z.ai /api/monitor/usage/quota/limit）。",
        diagnostics,
        updatedAt: updatedAt(),
      };
    },
  };
}

function unsupportedModule(providerIds, message, helpUrl = null) {
  return {
    id: `unsupported-${providerIds.join("-")}`,
    supports: providerIds,
    async fetch({ providerId }) {
      return {
        status: "unsupported",
        source: "provider official API",
        providerId,
        message,
        ...(helpUrl ? { helpUrl } : {}),
        updatedAt: updatedAt(),
      };
    },
  };
}

const MODULES = [
  deepseekBalanceModule(),
  openRouterCreditsModule(),
  zaiQuotaModule(),
  unsupportedModule(
    ["opencode", "opencode-go"],
    "OpenCode 官方目前公开模型目录和控制台用量，没有公开给 API Key 调用的实时余额/额度接口。",
    "https://opencode.ai/zen",
  ),
];

const modulesByProvider = new Map();
for (const module of MODULES) {
  for (const providerId of module.supports) modulesByProvider.set(providerId, module);
}

const genericUnsupported = unsupportedModule([], "该 provider 当前没有可验证的官方余额/额度接口；不会用请求次数或固定百分比替代。", null);

const customProbe = customEndpointProbeModule();

export function usageModuleFor(providerId, profile = null) {
  const known = modulesByProvider.get(providerId);
  if (known) return known;
  // Custom DSH-settings providers with a configured baseURL get a real probe
  // of the known protocol families instead of a blanket "unsupported".
  if (profile && typeof profile === "object" && typeof profile.baseURL === "string" && profile.baseURL.trim()) {
    return customProbe;
  }
  return genericUnsupported;
}

export function usageModuleIds() {
  return MODULES.map((module) => module.id);
}
