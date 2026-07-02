import {
  loadConfig,
  loadEmbeddingConfig,
  loadFallbackConfig,
  loadClaudeBridgeConfig,
  loadTeamConfig,
  loadSnapshotConfig,
  isGraphExtractionEnabled,
  isAutoCompressEnabled,
  isConsolidationEnabled,
  isContextInjectionEnabled,
  isDropStaleIndexEnabled,
} from "./config.js"
import type { MemoryProvider, EmbeddingProvider } from "./types.js"
import {
  createProvider,
  createFallbackProvider,
  createEmbeddingProvider,
  createImageEmbeddingProvider,
} from "./providers/index.js"
import { MemoryRuntimeSdk } from "./runtime/memory-runtime-sdk.js"
import { MemoryStore } from "./runtime/memory-store.js"
import { StateKV } from "./state/kv.js"
import { KV } from "./state/schema.js"
import { VectorIndex } from "./state/vector-index.js"
import { HybridSearch } from "./state/hybrid-search.js"
import { IndexPersistence } from "./state/index-persistence.js"
import { registerPrivacyFunction } from "./functions/privacy.js"
import { registerObserveFunction } from "./functions/observe.js"
import { registerImageQuotaCleanup } from "./functions/image-quota-cleanup.js"
import { registerVisionSearchFunctions } from "./functions/vision-search.js"
import { registerSlotsFunctions, isSlotsEnabled, isReflectEnabled } from "./functions/slots.js"
import { registerDiskSizeManager } from "./functions/disk-size-manager.js"
import { registerCompressFunction } from "./functions/compress.js"
import {
  registerSearchFunction,
  rebuildIndex,
  getSearchIndex,
  setVectorIndex,
  setEmbeddingProvider,
  setIndexPersistence,
} from "./functions/search.js"
import { registerContextFunction } from "./functions/context.js"
import { registerSummarizeFunction } from "./functions/summarize.js"
import { registerMigrateFunction } from "./functions/migrate.js"
import { registerFileIndexFunction } from "./functions/file-index.js"
import { registerConsolidateFunction } from "./functions/consolidate.js"
import { registerPatternsFunction } from "./functions/patterns.js"
import { registerRememberFunction } from "./functions/remember.js"
import { registerEvictFunction } from "./functions/evict.js"
import { registerRelationsFunction } from "./functions/relations.js"
import { registerTimelineFunction } from "./functions/timeline.js"
import { registerSmartSearchFunction } from "./functions/smart-search.js"
import { registerRecentSearchesSweepFunction } from "./functions/recent-searches-sweep.js"
import { registerProfileFunction } from "./functions/profile.js"
import { registerAutoForgetFunction } from "./functions/auto-forget.js"
import { registerExportImportFunction } from "./functions/export-import.js"
import { registerEnrichFunction } from "./functions/enrich.js"
import { registerClaudeBridgeFunction } from "./functions/claude-bridge.js"
import { registerGraphFunction } from "./functions/graph.js"
import { registerConsolidationPipelineFunction } from "./functions/consolidation-pipeline.js"
import { registerTeamFunction } from "./functions/team.js"
import { registerGovernanceFunction } from "./functions/governance.js"
import { registerSnapshotFunction } from "./functions/snapshot.js"
import { registerActionsFunction } from "./functions/actions.js"
import { registerFrontierFunction } from "./functions/frontier.js"
import { registerLeasesFunction } from "./functions/leases.js"
import { registerRoutinesFunction } from "./functions/routines.js"
import { registerSignalsFunction } from "./functions/signals.js"
import { registerCheckpointsFunction } from "./functions/checkpoints.js"
import { registerFlowCompressFunction } from "./functions/flow-compress.js"
import { registerMeshFunction } from "./functions/mesh.js"
import { registerBranchAwareFunction } from "./functions/branch-aware.js"
import { registerSentinelsFunction } from "./functions/sentinels.js"
import { registerSketchesFunction } from "./functions/sketches.js"
import { registerCrystallizeFunction } from "./functions/crystallize.js"
import { registerDiagnosticsFunction } from "./functions/diagnostics.js"
import { registerFacetsFunction } from "./functions/facets.js"
import { registerVerifyFunction } from "./functions/verify.js"
import { registerCascadeFunction } from "./functions/cascade.js"
import { registerLessonsFunctions } from "./functions/lessons.js"
import { registerObsidianExportFunction } from "./functions/obsidian-export.js"
import { registerReflectFunctions } from "./functions/reflect.js"
import { registerWorkingMemoryFunctions } from "./functions/working-memory.js"
import { registerSkillExtractFunctions } from "./functions/skill-extract.js"
import { registerSlidingWindowFunction } from "./functions/sliding-window.js"
import { registerQueryExpansionFunction } from "./functions/query-expansion.js"
import { registerTemporalGraphFunctions } from "./functions/temporal-graph.js"
import { registerRetentionFunctions } from "./functions/retention.js"
import { registerCompressFileFunction } from "./functions/compress-file.js"
import { registerReplayFunctions } from "./functions/replay.js"
import { MetricsStore } from "./eval/metrics-store.js"
import { DedupMap } from "./functions/dedup.js"
import { registerHealthMonitor } from "./health/monitor.js"
import { VERSION } from "./version.js"
import { bootLog as rawBootLog } from "./logger.js"

export interface MemoryServiceConfig {
  dataDir?: string
  autoObserve?: boolean
  injectContext?: boolean
  advancedTools?: boolean
  enableGraph?: boolean
  enableConsolidation?: boolean
  enableReflect?: boolean
  enableSlots?: boolean
}

export class MemoryService {
  private sdk = new MemoryRuntimeSdk()
  private store: MemoryStore
  private kv!: StateKV
  private config = loadConfig()
  private userConfig: MemoryServiceConfig
  private metricsStore!: MetricsStore
  private dedupMap = new DedupMap()
  private healthMonitor?: { stop: () => void }
  private indexPersistence?: IndexPersistence
  private timers: ReturnType<typeof setInterval>[] = []
  private viewerServer?: { close: (cb: () => void) => void }
  private _ready = false
  private logLines: string[] = []
  /** C9: Idempotent start tracking */
  private _started = false
  private _startPromise?: Promise<void>
  private _intervalFailCount = 0

  constructor(userConfig: MemoryServiceConfig = {}) {
    this.userConfig = userConfig
    this.store = new MemoryStore(userConfig.dataDir)
  }

  get ready(): boolean { return this._ready }

  /**
   * Initialize the full AgentMemory pipeline: providers, functions,
   * search indices, timers.
   */
  async start(): Promise<void> {
    // C9: Idempotent start — skip if already started or start is in flight
    if (this._started) return
    if (this._startPromise) return this._startPromise

    this._startPromise = this._doStart()
    try {
      await this._startPromise
      this._started = true
    } finally {
      this._startPromise = undefined
    }
  }

  private async _doStart(): Promise<void> {
    const config = this.config
    const embeddingConfig = loadEmbeddingConfig()
    const fallbackConfig = loadFallbackConfig()

    const provider = fallbackConfig.providers.length > 0
      ? createFallbackProvider(config.provider, fallbackConfig)
      : createProvider(config.provider)

    const embeddingProvider = createEmbeddingProvider()
    const imageEmbeddingProvider = createImageEmbeddingProvider()

    this.bootLog(`Memory v${VERSION}`)
    this.bootLog(`Provider: ${config.provider.provider} (${config.provider.model})`)
    this.bootLog(`Embedding: ${embeddingProvider ? embeddingProvider.name : "BM25-only"}`)

    this.kv = new StateKV(this.store)

    // Wire into the runtime SDK so functions can trigger each other
    this.metricsStore = new MetricsStore(this.kv)

    const vectorIndex = embeddingProvider ? new VectorIndex() : null
    setVectorIndex(vectorIndex)
    setEmbeddingProvider(embeddingProvider)

    this.registerAllFunctions(this.sdk, this.kv, provider, embeddingProvider, imageEmbeddingProvider)

    const bm25Index = getSearchIndex()
    const graphWeight = parseFloat(process.env.AGENTMEMORY_GRAPH_WEIGHT || "0.3")
    const hybridSearch = new HybridSearch(
      bm25Index, vectorIndex, embeddingProvider, this.kv,
      embeddingConfig.bm25Weight, embeddingConfig.vectorWeight, graphWeight,
    )
    registerSmartSearchFunction(this.sdk, this.kv, (query, limit) => hybridSearch.search(query, limit))
    registerRecentSearchesSweepFunction(this.sdk, this.kv)

    // Index persistence
    if (this.indexPersistence) this.indexPersistence.stop()
    this.indexPersistence = new IndexPersistence(this.kv, bm25Index, vectorIndex)
    setIndexPersistence(this.indexPersistence)

    // Load persisted index
    const loaded = await this.indexPersistence.load().catch(() => null)
    if (loaded?.bm25 && loaded.bm25.size > 0) {
      bm25Index.restoreFrom(loaded.bm25)
      this.bootLog(`Loaded BM25 index (${bm25Index.size} docs)`)
    }
    if (loaded?.vector && vectorIndex) {
      loaded.vector.validateDimensions = loaded.vector.validateDimensions ?? ((_dim: number) => ({ mismatches: [] as Array<{ obsId: string; dim: number }>, seenDimensions: new Set<number>() }))
      vectorIndex.restoreFrom(loaded.vector)
      this.bootLog(`Loaded vector index (${vectorIndex.size} vectors)`)
    }

    // Index rebuild
    if (bm25Index.size === 0) {
      void rebuildIndex(this.kv).then(c => { if (c > 0) { this.bootLog(`Index rebuilt: ${c}`); this.indexPersistence?.scheduleSave() } }).catch(() => {})
    }

    // Timers
    this.startTimers()

    this.healthMonitor = registerHealthMonitor(this.sdk, this.kv)
    this._ready = true
  }

  async stop(): Promise<void> {
    await this._startPromise // Wait for any in-flight start
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.healthMonitor?.stop()
    this.dedupMap.stop()
    this.indexPersistence?.stop()
    await this.indexPersistence?.save().catch(() => {})
    this._ready = false
    this._started = false
  }

  getSdk(): MemoryRuntimeSdk { return this.sdk }
  getStore(): MemoryStore { return this.store }
  getKv(): StateKV { return this.kv }
  getLogs(): string[] { return [...this.logLines] }

  async trigger(functionId: string, payload: unknown): Promise<unknown> {
    return this.sdk.trigger({ function_id: functionId, payload })
  }

  private registerAllFunctions(sdk: MemoryRuntimeSdk, kv: StateKV, provider: unknown, embeddingProvider: unknown, imageEmbeddingProvider: unknown): void {
    const mp = provider as MemoryProvider
    const ep = embeddingProvider as EmbeddingProvider | null
    const iep = imageEmbeddingProvider as EmbeddingProvider | null

    // P1-2: Config priority — explicit constructor args > env vars
    // advancedTools acts as master switch: when false, all advanced features are disabled
    const uc = this.userConfig
    const advancedEnabled = uc.advancedTools ?? false
    const shouldEnableGraph = advancedEnabled && (uc.enableGraph ?? isGraphExtractionEnabled())
    const shouldEnableSlots = advancedEnabled && (uc.enableSlots ?? isSlotsEnabled())
    const shouldEnableReflect = advancedEnabled && (uc.enableReflect ?? isReflectEnabled())
    const shouldEnableConsolidation = advancedEnabled && (uc.enableConsolidation ?? isConsolidationEnabled())

    registerPrivacyFunction(sdk)
    registerObserveFunction(sdk, kv, this.dedupMap, this.config.maxObservationsPerSession)
    registerImageQuotaCleanup(sdk, kv)
    registerVisionSearchFunctions(sdk, kv, iep)
    if (shouldEnableSlots) registerSlotsFunctions(sdk, kv)
    registerDiskSizeManager(sdk, kv)
    registerCompressFunction(sdk, kv, mp, this.metricsStore)
    registerSearchFunction(sdk, kv)
    registerContextFunction(sdk, kv, this.config.tokenBudget)
    registerSummarizeFunction(sdk, kv, mp, this.metricsStore)
    registerMigrateFunction(sdk, kv)
    registerFileIndexFunction(sdk, kv)
    registerConsolidateFunction(sdk, kv, mp)
    registerPatternsFunction(sdk, kv)
    registerRememberFunction(sdk, kv)
    registerEvictFunction(sdk, kv)
    registerRelationsFunction(sdk, kv)
    registerTimelineFunction(sdk, kv)
    registerProfileFunction(sdk, kv)
    registerAutoForgetFunction(sdk, kv)
    registerExportImportFunction(sdk, kv)
    registerEnrichFunction(sdk, kv)

    const claudeBridgeConfig = loadClaudeBridgeConfig()
    if (claudeBridgeConfig.enabled) {
      registerClaudeBridgeFunction(sdk, kv, claudeBridgeConfig)
    }

    if (shouldEnableGraph) registerGraphFunction(sdk, kv, mp)
    if (shouldEnableConsolidation) registerConsolidationPipelineFunction(sdk, kv, mp)

    const teamConfig = loadTeamConfig()
    if (teamConfig) registerTeamFunction(sdk, kv, teamConfig)

    registerGovernanceFunction(sdk, kv)
    registerActionsFunction(sdk, kv)
    registerFrontierFunction(sdk, kv)
    registerLeasesFunction(sdk, kv)
    registerRoutinesFunction(sdk, kv)
    registerSignalsFunction(sdk, kv)
    registerCheckpointsFunction(sdk, kv)
    registerMeshFunction(sdk, kv, "")
    registerBranchAwareFunction(sdk, kv)
    registerFlowCompressFunction(sdk, kv, mp)
    registerSentinelsFunction(sdk, kv)
    registerSketchesFunction(sdk, kv)
    registerCrystallizeFunction(sdk, kv, mp)
    registerDiagnosticsFunction(sdk, kv)
    registerFacetsFunction(sdk, kv)
    registerVerifyFunction(sdk, kv)
    registerLessonsFunctions(sdk, kv)
    registerObsidianExportFunction(sdk, kv)
    if (shouldEnableReflect) registerReflectFunctions(sdk, kv, mp)
    registerWorkingMemoryFunctions(sdk, kv, this.config.tokenBudget)
    registerSkillExtractFunctions(sdk, kv, mp)
    registerCascadeFunction(sdk, kv)
    registerSlidingWindowFunction(sdk, kv, mp)
    registerQueryExpansionFunction(sdk, mp)
    registerTemporalGraphFunctions(sdk, kv, mp)
    registerRetentionFunctions(sdk, kv)
    registerCompressFileFunction(sdk, kv, mp)
    registerReplayFunctions(sdk, kv)

    const snapshotConfig = loadSnapshotConfig()
    if (snapshotConfig.enabled) {
      registerSnapshotFunction(sdk, kv, snapshotConfig.dir)
    }
  }

  private startTimers(): void {
    const autoForgetMs = parseInt(process.env.AUTO_FORGET_INTERVAL_MS || "3600000", 10)
    if (process.env.AUTO_FORGET_ENABLED !== "false") {
      const t = setInterval(() => { void this.sdk.trigger({ function_id: "mem::auto-forget", payload: { dryRun: false } }).catch(() => {}) }, autoForgetMs)
      t.unref(); this.timers.push(t)
    }
    if (process.env.LESSON_DECAY_ENABLED !== "false") {
      const t = setInterval(() => { void this.sdk.trigger({ function_id: "mem::lesson-decay-sweep", payload: {} }).catch(() => {}) }, 86400000)
      t.unref(); this.timers.push(t)
    }
    if (process.env.INSIGHT_DECAY_ENABLED !== "false") {
      const t = setInterval(() => { void this.sdk.trigger({ function_id: "mem::insight-decay-sweep", payload: {} }).catch(() => {}) }, 86400000)
      t.unref(); this.timers.push(t)
    }
    // P1-2: Use userConfig.enableConsolidation with env var fallback
    // Also gate on advancedTools — consolidation pipeline is an advanced feature
    const shouldConsolidate = (this.userConfig.advancedTools ?? false)
      && (this.userConfig.enableConsolidation ?? isConsolidationEnabled())
    if (shouldConsolidate) {
      const consolidationMs = parseInt(process.env.CONSOLIDATION_INTERVAL_MS || "7200000", 10)
      const t = setInterval(() => { void this.sdk.trigger({ function_id: "mem::consolidate-pipeline", payload: {} }).catch(() => {}) }, consolidationMs)
      t.unref(); this.timers.push(t)
    }
  }

  private bootLog(msg: string): void {
    this.logLines.push(msg)
  }
}
