export { readLspConfig, normalizeConfig, getLanguageConfig, getRequestTimeout, getIdleTimeout, getInstallHint, DEFAULT_LSP_CONFIG, mergeConfig } from "./config.js"
export type { LspLanguageConfig, LspConfig, LspConfigResult } from "./config.js"

export { resolveServer } from "./server-resolver.js"
export type { ServerResolverResult } from "./server-resolver.js"

export { LspClientPool } from "./client-pool.js"
export type { PoolEntryStatus } from "./client-pool.js"

export { inferLanguage, getFileExtensions, LANGUAGE_EXTENSIONS } from "./language.js"

export {
  normalizeLocation,
  normalizeLocationArray,
  normalizeHover,
  normalizeDiagnostics,
  normalizeCompletion,
  normalizeDocumentSymbols,
  normalizeWorkspaceSymbols,
  normalizeRenameEdit,
  normalizeSignatureHelp,
  formatNormalizedItems,
} from "./normalize.js"
export type {
  NormalizedLocation,
  NormalizedHover,
  NormalizedDiagnostic,
  NormalizedCompletion,
  NormalizedSymbol,
  NormalizedItem,
  NormalizedSignature,
  NormalizedRenameEdit,
} from "./normalize.js"

export { LspClient } from "./lsp-client.js"
export type { LspClientOptions, LspClientHealth, LspServerState } from "./lsp-client.js"

// Phase 2.2: LspManager / LspManagerStatus 已删除（仅测试使用，生产无消费者）。
// createLspTool() 直接 import LspClient；server_status 返回 "LSP manager not yet implemented"。
// 详见 docs/unintegrated_code_audit_20260703.md §3.10c。
