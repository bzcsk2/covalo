export {
  CapabilityCatalog,
  RoleCapabilityView,
} from "./capability-catalog/index.js"
export type {
  Capability,
  CapabilitySource,
  CapabilityCatalogSnapshot,
  RoleCapabilityViewOptions,
} from "./capability-catalog/index.js"

export {
  AgentRuntime,
  DualAgentRuntime,
} from "./dual-agent-runtime/index.js"
export type {
  AgentRuntimeStatus,
  AgentRuntimeState,
  AgentRuntimeOptions,
  DualAgentRuntimeConfig,
  DualAgentRuntimeOptions,
  SendToOptions,
  InterruptRoleOptions,
} from "./dual-agent-runtime/index.js"

export {
  WorkflowCoordinator,
} from "./workflow-coordinator/index.js"
export type {
  WorkflowPhase as WorkflowCoordinatorPhase,
  WorkflowDecision,
  WorkflowConfig,
  WorkflowLoopState,
  SupervisorPlan,
  WorkerCommand,
  WorkerReport,
  SupervisorDecision,
  WorkflowEvidence,
  WorkflowEvidenceToolEntry,
  WorkflowEvidenceFailureEntry,
  WorkflowEvidenceVerification,
  WorkflowSupervisorAdvice,
  WorkflowCheckpoint,
  StartWorkflowOptions,
  WorkflowEvent,
  WorkflowCoordinatorOptions,
} from "./workflow-coordinator/index.js"
export { DEFAULT_WORKFLOW_CONFIG, SUPERVISOR_WORKFLOW_PROMPT } from "./workflow-coordinator/index.js"

export {
  DualSession,
  DualSessionStore,
} from "./dual-session/index.js"
export type {
  DualSessionConfig,
  RoleSessionState,
  DualSessionSnapshot,
  AdviceHistoryEntry,
  SessionCheckpoint,
  DualSessionOptions,
  DualSessionOptionsExtended,
  SessionStoreOptions,
} from "./dual-session/index.js"
export { SESSION_VERSION } from "./dual-session/index.js"

export {
  ReasonixEngine,
} from "./engine.js"
export type { ContextPolicyStatus } from "./engine.js"
export type { ContextReductionMode, ContextReductionResult } from "./context/manager.js"
export type { ContextPolicy, ContextPolicyMode } from "./context/policy.js"
export { DEFAULT_CONTEXT_POLICY, validateContextPolicy, mergeContextPolicy } from "./context/policy.js"
export { ContextPolicyStore } from "./context/policy-store.js"
export { ContextSummary, isSummaryMessage, SUMMARY_MARKER, SUMMARY_END_MARKER } from "./context/summary.js"
export type { ContextSummarizer, SummarizeInput, SummarizeOutput, LLMSummarizerOptions } from "./context/summarizer.js"
export { FakeSummarizer, MechanicalSummarizer, LLMSummarizer } from "./context/summarizer.js"
export { RuntimeLogger, createRuntimeLoggerFromEnv } from "./runtime-logger.js"
export type { RuntimeLoggerOptions } from "./runtime-logger.js"
export type { EngineStatusSnapshot } from "./status.js"
export { ContextManager } from "./context/manager.js"
export { ImmutablePrefix } from "./context/immutable.js"
export { AppendOnlyLog } from "./context/append-log.js"
export { VolatileScratch } from "./context/scratch.js"
export { loadConfig, PROVIDERS, FREE_MODEL_TARGETS, getApiKeyEnvVar, getModelContextWindow, saveLastConfig, saveRoleConfig, loadRoleConfig, resolveApiKey, listConfiguredApiKeys, saveProjectApiKey, deleteProjectApiKey, isValidProviderId } from "./config.js"
export {
  resolveModelTarget,
  targetFromConfig,
  targetToConfig,
  createClientForTarget,
  DEFAULT_TARGETS,
} from "./model-target.js"
export type { ModelTarget, ModelRole, ApiKeyPolicy, ModelTargetConfig } from "./model-target.js"
export {
  matchModelProfile,
  resolveModelProfile,
  resolveHarnessProfile,
  resolveDefaultHarness,
  BUILTIN_MODEL_PROFILES,
  BUILTIN_HARNESS_PROFILES,
} from "./model-profile/index.js"
export type {
  ModelProfile,
  HarnessProfile,
  ModelProfileConfig,
  ModelSizeClass,
  ToolFormat,
  ReliabilityLevel,
  HarnessMode,
  ToolsetSize,
  SupervisorPolicy,
  ShellPolicy,
} from "./model-profile/index.js"
export {
  resolveHarnessStrictness,
  readProjectHarnessConfig,
  writeProjectHarnessConfig,
  resolveEffectiveHarnessPolicy,
  getBasePolicy,
} from "./harness/index.js"
export type {
  HarnessStrictness,
  StrictnessSource,
  EffectiveHarnessPolicy,
  ProjectHarnessConfig,
  ResolveStrictnessOptions,
  ResolvedStrictness,
} from "./harness/index.js"
export {
  normalizeToolArguments,
  isUnexpandedStringWrapper,
  buildWrappedArgumentFormatHint,
  isSalvagedTruncatedArguments,
  buildSalvageTruncatedError,
  salvageTruncatedToolJson,
  SALVAGE_TRUNCATED_KEY,
  SALVAGED_TRUNCATED_WRITE_TOOLS,
  TOOL_SIDE_EFFECTS,
  getToolSideEffect,
  shouldBlockSalvagedTruncatedWrite,
  buildSalvagedTruncatedWriteBlockMessage,
} from "./tool-arguments/index.js"
export type { ToolSideEffect } from "./tool-arguments/index.js"
export {
  parseEmbeddedToolCallsFromText,
  containsEmbeddedToolCalls,
  stripEmbeddedToolCalls,
  prepareAssistantContentForHistory,
  salvageTextToolCallsInResponse,
  resolveSalvagedLlmResponse,
  sanitizeAssistantContentForUser,
  TextToolCallStreamFilter,
  stripEmbeddedThinking,
} from "./tool-calls/index.js"
export type { TextSpan, ParsedEmbeddedToolCalls, SalvableAssistantResponse } from "./tool-calls/index.js"
export { ReadTracker, extractFilePath, isWriteTool, isReadTool } from "./read-before-write.js"
export type { WriteGuardResult } from "./read-before-write.js"
export { EarlyStopDetector } from "./early-stop.js"
export type { StopSignal } from "./early-stop.js"
export {
  BranchBudgetTracker,
  DEFAULT_BRANCH_BUDGET,
} from "./governance/branch-budget.js"
export type {
  BranchBudgetLimits,
  BranchRecoverDecision,
  BranchToolBlockDecision,
} from "./governance/branch-budget.js"
export {
  canonicalBudgetPath,
  mergeBudgetPathMap,
  mergeBudgetPathSet,
} from "./governance/branch-budget-path.js"
export {
  extractToolTargetPath,
  extractRunCommand,
  isFileWriteTool,
} from "./governance/branch-budget-tool-path.js"
export { isHarnessVerificationCommand } from "./governance/verification-command.js"
export {
  inferTaskIntent,
  hasExecutableSideSignal,
  shouldCreateLedgerByIntent,
} from "./governance/task-state.js"
export type { TaskIntent } from "./governance/task-state.js"
export {
  buildVerificationDigest,
  buildVerificationSuccessSummary,
  isBuildVerificationCommand,
  isTestVerificationCommand,
  parseVitestFailureDigest,
  parseBuildFailureDigest,
  parseVitestSuccessSummary,
} from "./governance/verification-digest.js"
export {
  isVerificationBlockingFinal,
  buildVerificationGatePrompt,
  evaluateVerificationGate,
  shouldResetVerificationGateCounter,
  maybeResetVerificationGateCounter,
  processVerificationCommandResult,
  DEFAULT_MAX_GATE_CONTINUATIONS,
} from "./governance/verification-gate.js"
export type { VerificationGateState, VerificationGateDecision } from "./governance/verification-gate.js"
export {
  ModeDecisionEngine,
  DEFAULT_EXECUTION_MODE_CONFIG,
  MODE_SIGNAL_PRECEDENCE,
  sortSignalsByPrecedence,
  formatForcedReasonHuman,
  resolveInitialExecutionMode,
  isAutoModeDecisionEnabled,
  shouldEnterForcedMode,
  shouldExitForcedMode,
  createEmptyRuntimeExecutionState,
} from "./governance/mode-decision.js"
export type {
  ExecutionMode,
  ModeSignal,
  ModeSignalSource,
  TaskRiskLevel,
  ExecutionModeConfig,
  RuntimeExecutionState,
  ModeDecisionContext,
  ModeDecision,
} from "./governance/mode-decision.js"
export {
  TOOL_CATEGORIES,
  TWO_STAGE_CONTEXT_THRESHOLD,
  DEFAULT_SCHEMA_BUDGET_RATIO,
  MIN_SCHEMA_TOKEN_BUDGET,
  getRoutingMode,
  estimateToolSchemaTokens,
  resolveSchemaTokenBudget,
  shouldUseTwoStageRouting,
  inferToolCategory,
  applyDeterministicCategoryFilter,
  getCategorySelectorTool,
  getToolsForCategory,
  estimateRoutingSavings,
  parseSelectedCategory,
  resolveToolRouting,
  categoriesForToolset,
} from "./tool-routing/index.js"
export type {
  ToolCategory,
  ToolRoutingMode,
  ToolRoutingStage,
  ToolRoutingDecision,
  ToolRoutingContext,
  ToolCategoryDef,
} from "./tool-routing/index.js"
export {
  TaskLedgerTracker,
  shouldCreateLedger,
  parsePlanSteps,
  serializePlan,
  formatPlanForContext,
  formatLedgerForContext,
  planRequestInstruction,
  hashCommand,
  isLedgerWriteTool,
  isLedgerShellTool,
  extractToolPath,
  DEFAULT_MIN_STEPS,
  DEFAULT_MAX_STEPS,
} from "./task-ledger.js"
export type {
  TaskLedger,
  PlanStep,
  PlanStepStatus,
  LastVerification,
  CommandRunEntry,
  PlanTrackerOptions,
} from "./task-ledger.js"
export { isUnderRoot, resolveAgainstWorkspace, workspaceFileExists } from "./governance/path-scope.js"
export {
  CheckpointEngine,
  isResilienceV2Enabled,
} from "./checkpoint/checkpoint-engine.js"
export type {
  CombinedCheckpointFile,
  CheckpointSaveInput,
} from "./checkpoint/checkpoint-engine.js"
export {
  RUNTIME_CHECKPOINT_VERSION,
  emptyBranchBudgetSnapshot,
  emptyRuntimeCheckpointV2,
  isRuntimeCheckpointV2,
} from "./checkpoint/runtime-checkpoint.js"
export type {
  BranchBudgetSnapshot,
  RecoverySignal,
  RuntimeCheckpointV2,
  CheckpointSaveTrigger,
  ToolHistoryEntry,
  FailureHistoryEntry,
  StopReason as RuntimeStopReason,
} from "./checkpoint/runtime-checkpoint.js"
export {
  buildMinimalCheckpointEnvelope,
} from "./checkpoint/checkpoint-envelope.js"
export type { SessionCheckpointEnvelope } from "./checkpoint/checkpoint-envelope.js"
export { buildSystemPrompt } from "./system-prompt.js"
export { AGENTS, getAgent, agentConfigFor, AgentRegistry, defaultAgentRegistry } from "./agent.js"
export { loadAgentProfiles, saveAgentProfiles, getAgentProfile, updateAgentProfile } from "./agent-profile/store.js"
export type { AgentRoleProfile, AgentProfilesConfig, AgentRole } from "./agent-profile/types.js"
export { getMainMode, MAIN_MODES } from "./main-mode.js"
export type { MainMode, MainModeDefinition } from "./main-mode.js"
export { QueryEngine } from "./query-engine.js"
export type { AgentDefinition } from "./agent.js"
export type { DeepreefConfig, ProviderInfo, ProviderModel, RoleConfig, ApiKeySource } from "./config.js"

// 新配置系统导出
export {
  ConfigManager,
  getGlobalConfigManager,
  setGlobalConfigManager,
  initGlobalConfigManager,
} from "./config/manager.js"
export type { ConfigChangeListener } from "./config/manager.js"

export {
  DeepReefConfigSchema,
  ProviderConfigSchema,
  AgentConfigSchema,
  AgentsConfigSchema,
  WorkflowConfigSchema,
  GoalConfigSchema,
  MailboxConfigSchema,
  ToolsConfigSchema,
  ContextConfigSchema,
  TuiConfigSchema,
  LoggingConfigSchema,
  TraceConfigSchema,
  parseConfig,
} from "./config/schema.js"
export type {
  ProviderConfig,
  AgentsConfig,
  GoalConfig,
  MailboxConfig,
  ToolRoleModePolicy,
  ToolsConfig,
  ContextConfig,
  TuiConfig,
  LoggingConfig,
  TraceConfig,
  ConfigSource,
  ConfigWarning,
  ConfigLoadOptions,
  DeepReefConfig,
} from "./config/schema.js"

export {
  DEFAULT_CONFIG,
  CONFIG_TEMPLATES,
  LOCAL_FIRST_CONFIG,
  SAFE_READONLY_CONFIG,
  AUTONOMOUS_CODING_CONFIG,
} from "./config/defaults.js"

export {
  getConfigPath,
  getConfigDir,
} from "./config/loader.js"
export type { ConfigLoadResult } from "./config/loader.js"

export {
  migrateConfig,
  getLatestVersion,
  needsMigration,
  getMigrationPath,
} from "./config/migrations.js"

export {
  ConfigError,
  ConfigValidationError,
  ConfigLoadError,
  ConfigMigrationError,
  ConfigAccessError,
} from "./config/errors.js"

export {
  toWorkflowCoordinatorConfig,
  toGoalRuntimeConfig,
  getSupervisorToolPolicy,
  getWorkerToolPolicy,
  isToolAllowed,
  isHardDeniedForSupervisorLoop,
  isHardDeniedForWorkerLoop,
  getMailboxConfig,
  getContextConfig,
} from "./config/adapter.js"

export type { ChatMessage, ToolCall, ToolSpec, Usage, Role } from "./types.js"
export type { CoreEngine, AgentConfig, AgentTool, LoopEvent, AgentState, SessionStats, ToolContext, ToolResult, LoopEventRole, ToolTier, ToolConcurrency, ToolProgressUpdate, ChatClient } from "./interface.js"
// TUI-OT-60: 多 Agent 编排事件类型（供 TUI 消费）
export type {
  OrchestrationKind,
  OrchestrationEventPayload,
  WorkerSnapshot,
  SupervisorSnapshot,
  LoopTransition,
  RuntimeSignal,
  AgentTreeNode,
  CheckpointSnapshot,
} from "./interface.js"
export { SessionLoader } from "./session.js"
export type { SessionSummary } from "./session.js"

export {
  SubagentRegistry,
  defaultSubagentRegistry,
  BUILTIN_SUBAGENTS,
  checkSubagentPermission,
  SubagentRunner,
} from "./subagent/index.js"
export type {
  SubagentPermissionMode,
  SubagentDefinition,
  SubagentRun,
  SubagentRunStatus,
  SubagentRunUsage,
  SubagentRunOptions,
  SubagentRunResult,
  SubagentPermissionCheck,
} from "./subagent/index.js"

export {
  QuestionService,
  RejectedError,
  QuestionNotFoundError,
  createQuestionId,
} from "./question/index.js"
export type {
  QuestionOption,
  QuestionInfo,
  QuestionRequest,
  QuestionAnswer,
  QuestionReply,
  QuestionReject,
  QuestionServiceInterface,
} from "./question/index.js"

export {
  PermissionService,
  PermissionRejectedError,
  PermissionNotFoundError,
  evaluateRules,
  mergeRulesets,
  fromConfig,
  getDisabledTools,
  createSessionRule,
} from "./permission/index.js"
export type {
  PermissionAction,
  PermissionMode,
  PermissionRule,
  PermissionRequest,
  PermissionReply,
  PermissionDecision,
  PermissionCheck,
  PermissionConfig,
  ShellScan,
  PermissionServiceInterface,
  PermissionEngineInterface,
} from "./permission/index.js"

export {
  SUPERVISOR_ADVICE_VERSION,
  DEFAULT_SUPERVISOR_TRIGGER_CONFIG,
  MAX_EVIDENCE_FAILURES,
  MAX_EVIDENCE_TOOLS,
  MAX_VERIFICATION_TAIL,
  MAX_EVIDENCE_SUMMARY,
  MAX_ATTEMPTED_STRATEGIES,
  MAX_CHANGED_FILES,
  MAX_NEXT_ACTIONS,
  MAX_ADVICE_ITEM_LENGTH,
  MAX_DIAGNOSIS_LENGTH,
  supervisorAdviceSchema,
  truncateEvidenceText,
  extractActiveStep,
  normalizeEvidenceForHash,
  hashEvidenceBundle,
  trimEvidenceFailures,
  trimEvidenceTools,
  deriveAttemptedStrategies,
  defaultFailureSummary,
  buildEvidenceBundle,
  parseAskSupervisorRequest,
  isLedgerStagnant,
  isSignatureBudgetExhausted,
  peakErrorSignature,
  shouldRequestSupervisor,
  findUnsafeAdviceContent,
  parseSupervisorAdvice,
  validateSupervisorAdvice,
  coerceFailureClass,
  SUPERVISOR_POOL_FILE,
  DEFAULT_SUPERVISOR_POOL,
  parseSupervisorPoolConfig,
  mergeSupervisorPool,
  loadSupervisorPool,
  getEnabledSupervisorCandidates,
  DEFAULT_SUPERVISOR_BUDGET,
  SupervisorBudgetTracker,
  scoreSupervisorCandidate,
  selectSupervisorCandidate,
  DEEPREEF_SUPERVISOR_SMOKE_ENV,
  isSupervisorSmokeEnabled,
  runSupervisorSmokeTest,
  runSupervisorPoolSmokeTests,
  createSupervisorGuidanceState,
  buildSupervisorRequestMessages,
  formatSupervisorAdviceForScratch,
  injectAdviceToContext,
  recordSupervisorToolEvidence,
  recordSupervisorFailureEvidence,
  recordSupervisorRequestHistory,
  requestSupervisorAdvice,
  buildSupervisorTriggerContext,
  buildSupervisorDegradedMessage,
  evaluateAndRequestSupervisorAdvice,
  runSupervisorGuidanceAtSafePoint,
} from "./supervisor/index.js"
export type {
  FailureClass,
  SupervisorAdvice,
  EvidenceBundle,
  EvidenceFailureEntry,
  EvidenceToolEntry,
  EvidenceVerification,
  SupervisorTriggerReason,
  AskSupervisorRequest,
  FailureSignatureRecord,
  SupervisorTriggerDecision,
  BuildEvidenceBundleInput,
  SupervisorTriggerContext,
  SupervisorTriggerConfig,
  ParsedSupervisorAdvice,
  SupervisorAdviceValidation,
  SupervisorCostClass,
  SupervisorCapabilities,
  SupervisorCandidate,
  SupervisorPoolConfig,
  SupervisorBudgetConfig,
  SupervisorBudgetCheck,
  SupervisorRequestRecord,
  SupervisorCandidateMetrics,
  SelectSupervisorInput,
  ScoredSupervisorCandidate,
  SupervisorSelectionResult,
  SupervisorSmokeResult,
  SupervisorGuidanceState,
  SupervisorGuidanceConfig,
  RequestSupervisorAdviceInput,
  SupervisorAdviceResult,
  InjectAdviceInput,
  SupervisorAdviceScratchMeta,
} from "./supervisor/index.js"

export {
  BENCHMARK_WORKER_PROFILES,
  BENCHMARK_HARNESS_MODES,
  BENCHMARK_TASK_TYPES,
  buildBenchmarkCellId,
  createBenchmarkCell,
  buildBenchmarkMatrix,
  buildReleaseGateMatrix,
  filterCellsByHarness,
  filterCellsByWorker,
  collectBenchmarkMetrics,
  collectMetricsByHarness,
  metricsFromSingleRun,
  formatBenchmarkMetrics,
  simulateBenchmarkRun,
  simulateBenchmarkMatrix,
  assertSupervisorImprovesCompletion,
  assertSupervisorAdvisoryOnly,
  assertNoPaidModelByDefault,
  assertFreePoolDegradedPreservesState,
  evaluateReleaseGate,
  detectInfiniteLoop,
  loopHistoryFromResult,
  simulateOvernightStability,
  assertOvernightStability,
} from "./benchmark/index.js"
export type {
  WorkerProfileId,
  BenchmarkHarnessId,
  BenchmarkTaskType,
  BenchmarkCell,
  BenchmarkRunResult,
  BenchmarkMetrics,
  ReleaseGateResult,
  ReleaseGateCheck,
  OvernightStabilityResult,
  SimulateRunOptions,
  ReleaseGateConfig,
  LoopHistoryEntry,
  InfiniteLoopDetectionConfig,
  OvernightSimulationConfig,
} from "./benchmark/index.js"

export {
  AGENT_SCORING_DIMENSIONS,
  DEFAULT_AGENT_SCORE_RUBRIC,
  clampScore,
  normalizeRubric,
  scoreToGrade,
  evaluateAgentRunScore,
  buildRuntimeAdjustment,
  AgentScoreStore,
  AGENT_BENCHMARK_CASES,
  DEFAULT_AGENT_BENCHMARK_SUITE,
  selectBenchmarkCases,
  buildBenchmarkLeaderboard,
  runAgentBenchmarkSuite,
  scoreBenchmarkRun,
  summarizeBenchmarkSuite,
} from "./scoring/index.js"
export type {
  AgentBenchmarkCase,
  AgentBenchmarkDifficulty,
  AgentBenchmarkEvaluationSignal,
  AgentBenchmarkExecutionContext,
  AgentBenchmarkExecutor,
  AgentBenchmarkLeaderboardEntry,
  AgentBenchmarkRunInput,
  AgentBenchmarkRunScore,
  AgentBenchmarkSource,
  AgentBenchmarkSuite,
  AgentBenchmarkSuiteRunOptions,
  AgentBenchmarkSuiteRunResult,
  AgentBenchmarkSuiteSummary,
  AgentPromptStrategyAdjustment,
  AgentRunScore,
  AgentRunScoreInput,
  AgentRuntimeAdjustment,
  AgentScoreDimensionResult,
  AgentScoreEvidence,
  AgentScoreGrade,
  AgentScoreRubric,
  AgentScoringDimension,
  AgentScoringMode,
  SupervisorRunAssessment,
  AgentScoreStoreOptions,
} from "./scoring/index.js"
