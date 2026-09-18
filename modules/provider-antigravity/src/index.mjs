import { defineProviderModule } from "../../../packages/core/src/provider-module.mjs";

export function createAntigravityModule({ driver = {} } = {}) {
  return defineProviderModule({
    id: "antigravity",
    displayName: "Antigravity",
    capabilities: [
      "oauth_discovery",
      "oauth_import",
      "oauth_authorization",
      "oauth_refresh",
      "quota",
      "catalog",
      "invoke",
      "stream",
    ],
    driver,
  });
}

export {
  AGY_PROMPT_STDIN_THRESHOLD_BYTES,
  ANTIGRAVITY_DEFAULT_ALLOW_RULES,
  AntigravityOfficialCliDriver,
  AntigravityOfficialSessionDriver,
  antigravityAnchorInvocation,
  antigravityConversationsFile,
  antigravityHistoryImport,
  antigravityMessagesFingerprint,
  antigravityPromptInvocation,
  antigravityRepeatRatio,
  antigravityToolProgressLine,
  isAntigravitySidebandRequest,
  antigravityRequestPrompt,
  createAntigravityConversationStore,
  ensureAntigravityPermissionMirror,
  mirrorAntigravityPermissions,
  antigravitySettingsFile,
  createAntigravityCliExecutor,
  createAntigravityCatalogLoader,
  createAntigravityDriver,
  createAntigravityOAuthAuthorizer,
  detectFakeIpEnvironment,
  enrichAntigravityModelCatalog,
  extractAntigravityAccountEmail,
  parseAntigravityModelCatalog,
  parseAntigravityNativeQuota,
  resolveAntigravityInvocationModel,
  resolveAntigravityNativeInvocationModel,
  summarizeAntigravityCandidate,
} from "./driver.mjs";

export {
  antigravityNativeTransportConstants,
  buildAntigravityRequest,
  createAntigravityNativeExecutor,
  createAntigravityNativeQuotaReader,
  createAntigravityProjectResolver,
  invalidateAntigravityKeychainCache,
  parseAntigravityKeychainValue,
  readAntigravityKeychainToken,
  readAntigravityTokenFile,
  resolveAntigravityAccessToken,
} from "./native-transport.mjs";
