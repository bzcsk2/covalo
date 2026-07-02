import type { EvalEnvironmentId, SandboxProviderId, PreflightResult, ScoreKind, ToolchainFingerprint, EvalSandboxProfile } from "../sandbox/types";

export type EvalCategoryId =
  | "coding-basics"
  | "tool-use"
  | "safety"
  | "supervisor-recovery"
  | "long-run"
  | "weak-model";

export type EvalSuiteId = "smoke" | "standard" | "stress";
export type { EvalEnvironmentId, SandboxProviderId, PreflightResult, PreflightCheck } from "../sandbox/types";

export type FailureClass =
  | "none"
  | "registry_failure"
  | "suite_selection_failure"
  | "sandbox_failure"
  | "preflight_failure"
  | "setup_failure"
  | "worker_failure"
  | "worker_empty_output"
  | "model_failure"
  | "tool_failure"
  | "permission_failure"
  | "verifier_failure"
  | "verifier_contract_failure"
  | "policy_gate_failure"
  | "supervisor_failure"
  | "user_cancel"
  | "system_error";

export interface FailureEvidence {
  event?: string;
  command?: string;
  exitCode?: number | null;
  stdoutSnippet?: string;
  stderrSnippet?: string;
  missing?: string[];
}

export interface EvalCaseRef {
  id: string;
  title: string;
  difficulty: EvalSuiteId;
  manifestId: string;
}

export interface EvalSuite {
  id: EvalSuiteId;
  title: string;
  description: string;
  estimatedMinutes: string;
  environmentId: EvalEnvironmentId;
  cases: EvalCaseRef[];
}

export interface EvalCategory {
  id: EvalCategoryId;
  title: string;
  description: string;
  suites: EvalSuite[];
}

export type VerifierType = "command" | "script" | "file-assert";

export interface FileAssertion {
  path: string;
  mustExist?: boolean;
  mustContain?: string[];
  mustNotContain?: string[];
}

export interface RealCaseSourceMeta {
  sourceKind: "terminal-bench" | "swe-bench";
  sourceId: string;
  sourceRepoPath: string;
  sourceCommit?: string;
  sourceDataset?: string;
  sourceSplit?: string;
  sourceTaskPath?: string;
  sourceInstanceId?: string;
}

export interface EvalCaseManifest {
  id: string;
  category: EvalCategoryId;
  suite: EvalSuiteId;
  title: string;
  description: string;
  fixtureSource: string;
  sourceMeta?: RealCaseSourceMeta;
  setup?: string[];
  taskPrompt: string;
  /** Optional bilingual alternative task prompts. Resolved by locale in prompt builders. */
  taskPromptByLocale?: Partial<Record<"zh-CN" | "en", string>>;
  expectedVerification: string[];
  verifier: {
    type: VerifierType;
    command?: string;
    scriptPath?: string;
    fileAssertions?: FileAssertion[];
    timeoutMs?: number;
  };
  protectedFiles?: string[];
  outOfBoundsCheckPaths?: string[];
  requiredBinaries?: string[];
  requiredPythonModules?: string[];
  network?: boolean;
  requires?: {
    toolchainProfile?: string;
    tools?: {
      required?: string[];
      recommended?: string[];
      optional?: string[];
    };
    network?: {
      setup?: boolean;
      agent?: boolean;
      verifier?: boolean;
    };
  };
  scoring?: {
    requireCleanGitDiff?: boolean;
    maxChangedFiles?: number;
  };
}

export interface VerifierResult {
  passed: boolean;
  verdict: "pass" | "fail" | "error";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  details: string[];
}

export interface SetupCommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
}

export interface SetupResult {
  commands: SetupCommandResult[];
  allPassed: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface ObjectiveSignals {
  changedFiles: number;
  diffSize: number;
  toolFailureCount: number;
  verificationCommandsRun: number;
  cleanGitDiff: boolean;
  outOfBoundsWrites: string[];
  toolTrackingValid: boolean;
  gitSignalError?: string;
}

export interface CaseScore {
  verifierWeight: number;
  objectiveWeight: number;
  supervisorWeight: number;
  verifierScore: number;
  objectiveScore: number;
  supervisorScore: number;
  finalScore: number;
  scoreIneligible: boolean;
  verifierSkipped?: boolean;
}

export interface PolicyGateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface CaseContract {
  environment: EvalEnvironmentId;
  provider: string;
  requiredBinaries: string[];
  requiredPythonModules: string[];
  network: boolean;
  allowedWriteRoots: string[];
  protectedFiles: string[];
  verifier: string;
  toolchainProfile: string;
  scoring: {
    requireCleanGitDiff: boolean;
    maxChangedFiles: number | undefined;
  };
}

export interface CaseResult {
  caseId: string;
  title: string;
  category: EvalCategoryId;
  suite: EvalSuiteId;
  manifest: EvalCaseManifest;
  verdict: "pass" | "fail" | "error" | "skipped" | "infra_error";
  verifierResult: VerifierResult | null;
  objectiveSignals: ObjectiveSignals | null;
  setupResult: SetupResult | null;
  policyGates: PolicyGateResult[];
  supervisorAssessment: Record<string, number> | null;
  score: CaseScore | null;
  workerOutput: string;
  supervisorOutput: string;
  patchDiff: string;
  caseContract: CaseContract | null;
  startedAt: string;
  finishedAt: string;
  error?: string;
  failureClass: FailureClass;
  failureReason?: string;
  failureEvidence?: FailureEvidence;
  scoreEligible: boolean;
  officialScoreEligible: boolean;
}

export interface SuiteSummary {
  suiteId: EvalSuiteId;
  categoryId: EvalCategoryId;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  infraErrorCount: number;
  skipped: number;
  averageScore: number;
  failureBreakdown: Record<string, number>;
  results: CaseResult[];
}

export interface EvalRunMeta {
  runId: string;
  startedAt: string;
  finishedAt: string;
  categoryId: EvalCategoryId;
  suiteId: EvalSuiteId;
  environmentId: EvalEnvironmentId;
  testSetId: string;
  model: string;
  status: "running" | "completed" | "cancelled" | "failed" | "infra_error";
  providerId: SandboxProviderId;
  officialScore: boolean;
  scoreKind: ScoreKind;
  fallbackReason?: string;
  preflight?: PreflightResult;
}

export interface EvalRunReport {
  meta: EvalRunMeta;
  suiteSummary: SuiteSummary;
  overallScore: number;
}

export type ProgressEventType = "case-start" | "case-end" | "suite-end" | "error" | "infra-error" | "preflight";

export interface EvalProgressEvent {
  type: ProgressEventType;
  caseId?: string;
  title?: string;
  result?: CaseResult;
  error?: string;
  totalCases?: number;
  completedCases?: number;
  preflight?: PreflightResult;
}

export type EvalProgressCallback = (event: EvalProgressEvent) => void;

export interface FixedEvalOptions {
  categoryId: EvalCategoryId;
  suiteId: EvalSuiteId;
  environmentId?: EvalEnvironmentId;
  testSetId?: string;
  models?: string[];
  abortSignal?: AbortSignal;
  onProgress?: EvalProgressCallback;
  workerEngine?: unknown;
  supervisorEngine?: unknown;
  checkApiKey?: (model: string) => Promise<boolean>;
  switchModel?: (model: string) => Promise<void>;
  restoreModel?: () => Promise<void>;
  executeWorker?: (prompt: string, context?: { cwd: string; caseId: string; evalRunId?: string }) => Promise<string>;
  executeSupervisor?: (prompt: string) => Promise<string>;
  sandboxProvider?: import("../sandbox/types").SandboxProvider;
  writeObservability?: (event: string, level: string, overrides?: Record<string, unknown>) => void;
  logger?: import("../runtime-logger").RuntimeLogger;
}

export class MissingEvalAssetError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "MissingEvalAssetError";
  }
}

export class CorruptEvalAssetError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "CorruptEvalAssetError";
  }
}

export class UnsafeEvalAssetPathError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "UnsafeEvalAssetPathError";
  }
}

export class EvalAssetExtractionError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "EvalAssetExtractionError";
  }
}
