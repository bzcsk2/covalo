// Derived from agentmemory, modified for Deepreef's native runtime.
// Upstream: https://github.com/rohitg00/agentmemory
// License: Apache-2.0

export { MemoryService } from "./memory-service.js"
export type { MemoryServiceConfig } from "./memory-service.js"
export { DeepreefMemoryBridge } from "./bridge/deepreef-memory-bridge.js"
export type { DeepreefMemoryBridgeConfig } from "./bridge/deepreef-memory-bridge.js"
export { MemoryRuntimeSdk } from "./runtime/memory-runtime-sdk.js"
export { MemoryStore } from "./runtime/memory-store.js"
export type { ISdk } from "./runtime/types.js"
export { TriggerAction } from "./runtime/types.js"

// Re-export key types
export type {
  Session, Memory, RawObservation, CompressedObservation,
  TimelineEntry, AuditEntry,
} from "./types.js"

// Re-export key function registrations for selective use
export { registerRememberFunction } from "./functions/remember.js"
export { registerSearchFunction, setVectorIndex, setEmbeddingProvider, setIndexPersistence } from "./functions/search.js"
export { registerContextFunction } from "./functions/context.js"
export { registerObserveFunction } from "./functions/observe.js"
export { registerSummarizeFunction } from "./functions/summarize.js"
export { registerTimelineFunction } from "./functions/timeline.js"

// Re-export state
export { StateKV } from "./state/kv.js"
export { KV } from "./state/schema.js"
export { VectorIndex } from "./state/vector-index.js"
export { HybridSearch } from "./state/hybrid-search.js"
export { IndexPersistence } from "./state/index-persistence.js"
export { getSearchIndex, rebuildIndex } from "./functions/search.js"

// Re-export providers
export { createProvider, createFallbackProvider, createEmbeddingProvider } from "./providers/index.js"

// Phase E: Migration
export { migrateFromAgentMemory, createMemoryMigrateTool } from "./migrate.js"

// Phase D: Native AgentTool creators
export {
  createMemoryRecallTool,
  createMemorySaveTool,
  createMemorySmartSearchTool,
  createMemoryForgetTool,
  createMemoryTimelineTool,
  createMemoryStatusTool,
} from "./tools.js"
