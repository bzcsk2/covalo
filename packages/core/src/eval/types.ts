import type { EvalEnvironmentId, SandboxProviderId } from "../sandbox/types";

export type EvalCategoryId =
  | "coding-basics"
  | "tool-use"
  | "safety"
  | "supervisor-recovery"
  | "long-run"
  | "weak-model";

export type EvalSuiteId = "smoke" | "standard" | "stress";
export type { EvalEnvironmentId, SandboxProviderId };

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
  sourceKind: "terminal-bench" | "swe-bench" | "looprig-real";
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
  expectedVerification: string[];
  verifier: {
    type: VerifierType;
    command?: string;
    scriptPath?: string;
    fileAssertions?: FileAssertion[];
    timeoutMs?: number;
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

export interface ObjectiveSignals {
  changedFiles: number;
  diffSize: number;
  toolFailureCount: number;
  verificationCommandsRun: number;
  cleanGitDiff: boolean;
}

export interface CaseScore {
  verifierWeight: number;
  objectiveWeight: number;
  supervisorWeight: number;
  verifierScore: number;
  objectiveScore: number;
  supervisorScore: number;
  finalScore: number;
}

export interface CaseResult {
  caseId: string;
  title: string;
  category: EvalCategoryId;
  suite: EvalSuiteId;
  manifest: EvalCaseManifest;
  verdict: "pass" | "fail" | "error" | "skipped";
  verifierResult: VerifierResult | null;
  objectiveSignals: ObjectiveSignals | null;
  supervisorAssessment: Record<string, number> | null;
  score: CaseScore | null;
  workerOutput: string;
  supervisorOutput: string;
  patchDiff: string;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export interface SuiteSummary {
  suiteId: EvalSuiteId;
  categoryId: EvalCategoryId;
  totalCases: number;
  passed: number;
  failed: number;
  errored: number;
  skipped: number;
  averageScore: number;
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
  status: "running" | "completed" | "cancelled" | "failed";
  providerId: SandboxProviderId;
  officialScore: boolean;
  fallbackReason?: string;
}

export interface EvalRunReport {
  meta: EvalRunMeta;
  suiteSummary: SuiteSummary;
  overallScore: number;
}

export interface EvalProgressEvent {
  type: "case-start" | "case-end" | "suite-end" | "error";
  caseId?: string;
  title?: string;
  result?: CaseResult;
  error?: string;
  totalCases?: number;
  completedCases?: number;
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
  executeWorker?: (prompt: string) => Promise<string>;
  executeSupervisor?: (prompt: string) => Promise<string>;
  sandboxProvider?: import("../sandbox/types").SandboxProvider;
}
