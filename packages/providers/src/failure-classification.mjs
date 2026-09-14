/**
 * Map provider-native transport failures onto the harness LLM failure codes.
 *
 * Dockyard's native transports run on the platform `fetch`, so network-level
 * breakage (undici's `TypeError: fetch failed`, DNS/TLS/socket errors, mid-SSE
 * connection resets) used to escape as bare `Error` values. The DSH retry
 * layer (`dsh-llm-retry`) only retries failures whose classification it
 * recognizes — a raw, unclassified error surfaced in the UI as an immediate
 * "本轮运行失败 fetch failed" with no recovery.
 *
 * `attachHarnessFailure` stamps such an error with its own `failure` snapshot
 * (`{ message, code }`, optionally `status`), which is exactly the shape
 * `normalizeLlmFailure` reads at the terminal adapter boundary. Once stamped,
 * transient transport faults classify as `TRANSPORT`/`TIMEOUT` and receive
 * backoff retries instead of failing the turn; quota, auth, and context
 * overflow keep their distinct, non-retried semantics.
 */

const CONTEXT_WINDOW_EXCEEDED_CODE = "CONTEXT_WINDOW_EXCEEDED";
const QUOTA_EXCEEDED_CODE = "QUOTA";
const INVALID_CREDENTIAL_CODE = "INVALID_CREDENTIAL";

function errorText(error) {
  const parts = [
    error?.message,
    error?.upstreamMessage,
    typeof error?.body === "string" ? error.body : null,
  ].filter((value) => typeof value === "string" && value.length > 0);
  return parts.join(" ");
}

/**
 * Classify one thrown transport/provider error into a harness failure code.
 *
 * @returns {string|null} the harness code, or `null` when the error is not a
 *   recognized provider-transport shape (callers then leave it untouched).
 */
export function harnessFailureCode(error) {
  if (!error || typeof error !== "object") return null;
  // Account-pool / policy flags set by nativeProviderError are authoritative.
  if (error.rateLimited) return "RATE_LIMIT";
  if (error.quotaExhausted || /\b(?:quota|credits?|额度)\b.{0,80}\b(?:exhaust|deplet|exceed)|resource.?exhausted\b/i.test(errorText(error))) {
    return QUOTA_EXCEEDED_CODE;
  }
  if (error.authExpired || error.authForbidden) return INVALID_CREDENTIAL_CODE;

  const text = errorText(error).toLowerCase();
  const numericStatus = Number(error.upstreamStatus ?? error.status);

  if (/\btime'?d?\s*-?\s*out\b|\betimedout\b|\betimeout\b/.test(text)) return "TIMEOUT";
  // Cursor native transport idle watchdog: "Cursor connection idle for 63s"
  if (/\bconnection idle\b|\bidle timeout\b|\bidle for\b/.test(text)) return "TIMEOUT";

  if (numericStatus === 429 || numericStatus === "429" || /\b429\b|rate.?limit/.test(text)) return "RATE_LIMIT";

  if (/maximum prompt length|prompt(?: is)? too long|context (?:window )?(?:length|size)(?:\s+\w+){0,6}?(?:exceed|over|max)|too many tokens?\b|reduce the (?:length|number of)/.test(text)) {
    return CONTEXT_WINDOW_EXCEEDED_CODE;
  }

  if ((Number.isInteger(numericStatus) && numericStatus >= 500)
    || /internal server error|bad gateway|service unavailable|upstream|cloudflare/.test(text)) {
    return "SERVER";
  }

  if (/stream ended (?:before|without)/.test(text)) return "TRANSPORT";

  if (/\bnetwork\b|\bconnection\b|\bsocket\b|\bfetch\b|\bdns\b|\btls\b|\bssl\b|certificate|\beconn[a-z]+\b|\bepipe\b|\behostunreach\b|\benetunreach\b|\benotfound\b|\beai_again\b|premature close|other side closed|http2 request did not get a response|websock|terminated|connection closed before/i.test(text)) {
    return "TRANSPORT";
  }

  return null;
}

/**
 * Stamp a recognized provider-transport error with the harness `failure`
 * snapshot, preserving the human-readable message. Returns the same error.
 */
export function attachHarnessFailure(error) {
  if (!error || typeof error !== "object") return error;
  const code = harnessFailureCode(error);
  if (!code) return error;
  if (error.code === undefined || error.code === null) {
    try {
      error.code = code;
    } catch {
      // Some frozen error objects reject property assignment.
    }
  }
  if (error.failure !== undefined) return error;
  let message = typeof error.message === "string" && error.message.length > 0
    ? error.message
    : "provider request failed";
  message = message.replace(/\s+/g, " ").trim().slice(0, 500);
  const numericStatus = Number(error.upstreamStatus ?? error.status);
  const snapshot = {
    message,
    code,
    ...(Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
      ? { status: numericStatus }
      : {}),
  };
  Object.defineProperty(error, "failure", {
    value: Object.freeze(snapshot),
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return error;
}
