/**
 * Supervisor 模块 — DRF-50 协议、证据包与触发器；DRF-51 池、路由与预算。
 */

export {
  SUPERVISOR_ADVICE_VERSION,
  DEFAULT_SUPERVISOR_TRIGGER_CONFIG,
} from "./types.js"

export {
  SUPERVISOR_POOL_FILE,
  DEFAULT_SUPERVISOR_POOL,
  parseSupervisorPoolConfig,
  mergeSupervisorPool,
  loadSupervisorPool,
} from "./pool.js"

export type {
  SupervisorCostClass,
  SupervisorCapabilities,
  SupervisorCandidate,
  SupervisorPoolConfig,
} from "./pool.js"

export {
  DEFAULT_SUPERVISOR_BUDGET,
  SupervisorBudgetTracker,
} from "./budget.js"

export type {
  SupervisorBudgetConfig,
  SupervisorBudgetCheck,
  SupervisorRequestRecord,
} from "./budget.js"

export {
  scoreSupervisorCandidate,
  selectSupervisorCandidate,
} from "./router.js"

export type {
  SupervisorCandidateMetrics,
  SelectSupervisorInput,
  ScoredSupervisorCandidate,
  SupervisorSelectionResult,
} from "./router.js"

export {
  COVALO_SUPERVISOR_SMOKE_ENV,
  isSupervisorSmokeEnabled,
  runSupervisorSmokeTest,
  runSupervisorPoolSmokeTests,
} from "./smoke.js"

export type { SupervisorSmokeResult } from "./smoke.js"

export {
  MAX_EVIDENCE_FAILURES,
  MAX_EVIDENCE_TOOLS,
  MAX_VERIFICATION_TAIL,
  MAX_EVIDENCE_SUMMARY,
  MAX_ATTEMPTED_STRATEGIES,
  MAX_CHANGED_FILES,
} from "./evidence.js"

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
} from "./types.js"

export {
  truncateEvidenceText,
  extractActiveStep,
  normalizeEvidenceForHash,
  hashEvidenceBundle,
  trimEvidenceFailures,
  trimEvidenceTools,
  deriveAttemptedStrategies,
  defaultFailureSummary,
  buildEvidenceBundle,
} from "./evidence.js"

export {
  parseAskSupervisorRequest,
  isLedgerStagnant,
  isSignatureBudgetExhausted,
  peakErrorSignature,
  shouldRequestSupervisor,
} from "./triggers.js"

export {
  MAX_NEXT_ACTIONS,
  MAX_ADVICE_ITEM_LENGTH,
  MAX_DIAGNOSIS_LENGTH,
  supervisorAdviceSchema,
  findUnsafeAdviceContent,
  parseSupervisorAdvice,
  validateSupervisorAdvice,
  coerceFailureClass,
} from "./advice-schema.js"

export type {
  ParsedSupervisorAdvice,
  SupervisorAdviceValidation,
} from "./advice-schema.js"

export {
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
} from "./guided-loop.js"

export type {
  SupervisorGuidanceState,
  SupervisorGuidanceConfig,
  RequestSupervisorAdviceInput,
  SupervisorAdviceResult,
  InjectAdviceInput,
  SupervisorAdviceScratchMeta,
} from "./guided-loop.js"
