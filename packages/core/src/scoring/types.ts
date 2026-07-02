import type { HarnessStrictness, ThinkingMode } from "../agent-profile/types.js"

export type AgentScoringMode = "benchmark" | "live"

export type AgentScoreGrade = "S" | "A" | "B" | "C" | "D" | "F"

export type AgentScoringDimension =
  | "taskCompletion"
  | "verification"
  | "toolUse"
  | "efficiency"
  | "autonomy"
  | "instructionFollowing"
  | "recovery"
  | "communication"
  | "safety"

export interface AgentScoreEvidence {
  summary: string
  passedVerification?: boolean
  completedSteps?: string[]
  missingSteps?: string[]
  changedFiles?: string[]
  commands?: string[]
  failures?: string[]
  notes?: string[]
}

export interface AgentScoreDimensionResult {
  dimension: AgentScoringDimension
  score: number
  weight: number
  rationale: string
}

export interface AgentPromptStrategyAdjustment {
  kind:
    | "decompose_task"
    | "require_verification"
    | "tighten_tool_policy"
    | "expand_context"
    | "reduce_scope"
    | "increase_reporting"
    | "preserve_current"
  rationale: string
}

export interface AgentRuntimeAdjustment {
  recommendedHarness?: HarnessStrictness
  recommendedThinking?: ThinkingMode
  recommendedMaxTokens?: number
  promptStrategies: AgentPromptStrategyAdjustment[]
}

export interface AgentRunScore {
  version: 1
  id: string
  mode: AgentScoringMode
  workflowId?: string
  iteration?: number
  benchmarkCaseId?: string
  workerModelTarget: string
  supervisorModelTarget?: string
  task: string
  dimensions: AgentScoreDimensionResult[]
  overallScore: number
  grade: AgentScoreGrade
  evidence: AgentScoreEvidence
  adjustment: AgentRuntimeAdjustment
  createdAt: number
}

export interface AgentScoreRubric {
  version: 1
  id: string
  dimensions: Record<AgentScoringDimension, {
    weight: number
    description: string
  }>
}

export interface SupervisorRunAssessment {
  summary: string
  dimensions?: Partial<Record<AgentScoringDimension, number>>
  completed?: boolean
  /** Whether `completed` was explicitly present in the LLM output (vs absent = undefined) */
  completedKnown?: boolean
  verificationPassed?: boolean
  safetyIssue?: boolean
  promptStrategies?: AgentPromptStrategyAdjustment[]
}

export interface AgentRunScoreInput {
  mode: AgentScoringMode
  workflowId?: string
  iteration?: number
  benchmarkCaseId?: string
  workerModelTarget: string
  supervisorModelTarget?: string
  task: string
  workerReport?: string
  completedSteps?: string[]
  plannedSteps?: string[]
  changedFiles?: string[]
  verificationPassed?: boolean
  verificationCommands?: string[]
  blockers?: string[]
  toolCalls?: number
  toolFailures?: number
  loopCount?: number
  supervisorAssessment?: SupervisorRunAssessment
  createdAt?: number
}

export type AgentBenchmarkSource =
  | "swe-bench"
  | "human-eval"
  | "mbpp"
  | "repo-bench"
  | "codejoust"
  | "litebench"
  | "agentprobe"
  | "issuebenchkit"
  | "live-repo-fixture"
  | "covalo-regression"

export type AgentBenchmarkEvaluationSignal =
  | "test-pass-rate"
  | "before-after-verdict"
  | "tool-trace"
  | "snapshot-regression"
  | "semantic-regression"
  | "schema-validity"
  | "cost"
  | "diff-size"
  | "wall-time"
  | "supervisor-judge"

export type AgentBenchmarkDifficulty = "smoke" | "easy" | "medium" | "hard"

export interface AgentBenchmarkCase {
  id: string
  source: AgentBenchmarkSource
  title: string
  difficulty: AgentBenchmarkDifficulty
  repository?: string
  language?: string
  taskType:
    | "single-file-fix"
    | "multi-file-refactor"
    | "failing-test-diagnosis"
    | "test-generation"
    | "tool-recovery"
    | "long-horizon"
  prompt: string
  verification: string[]
  evaluationSignals: AgentBenchmarkEvaluationSignal[]
  tags: string[]
}

export interface AgentBenchmarkSuite {
  id: string
  title: string
  description: string
  cases: AgentBenchmarkCase[]
}

export interface AgentBenchmarkRunInput {
  case: AgentBenchmarkCase
  workerModelTarget: string
  supervisorModelTarget?: string
  completed: boolean
  verificationPassed: boolean
  workerReport?: string
  completedSteps?: string[]
  changedFiles?: string[]
  verificationCommands?: string[]
  blockers?: string[]
  toolCalls?: number
  toolFailures?: number
  loopCount?: number
  durationMs?: number
  costUsd?: number
  diffLinesChanged?: number
  supervisorAssessment?: SupervisorRunAssessment
  createdAt?: number
}

export interface AgentBenchmarkRunScore {
  caseId: string
  source: AgentBenchmarkSource
  workerModelTarget: string
  score: AgentRunScore
  completed: boolean
  verificationPassed: boolean
  durationMs?: number
  costUsd?: number
  diffLinesChanged?: number
}

export interface AgentBenchmarkSuiteSummary {
  suiteId: string
  runs: AgentBenchmarkRunScore[]
  averageScore: number
  completionRate: number
  verificationPassRate: number
  averageDurationMs?: number
  totalCostUsd?: number
  averageDiffLinesChanged?: number
}

export interface AgentBenchmarkLeaderboardEntry {
  workerModelTarget: string
  runs: number
  averageScore: number
  completionRate: number
  verificationPassRate: number
  averageDurationMs?: number
  totalCostUsd?: number
}

export interface AgentBenchmarkExecutionContext {
  case: AgentBenchmarkCase
  workerModelTarget: string
  supervisorModelTarget?: string
}

export type AgentBenchmarkExecutor = (
  context: AgentBenchmarkExecutionContext,
) => AgentBenchmarkRunInput | Promise<AgentBenchmarkRunInput>

export interface AgentBenchmarkSuiteRunOptions {
  suite: AgentBenchmarkSuite
  workerModelTargets: string[]
  supervisorModelTarget?: string
  executeCase: AgentBenchmarkExecutor
}

export interface AgentBenchmarkSuiteRunResult {
  summary: AgentBenchmarkSuiteSummary
  leaderboard: AgentBenchmarkLeaderboardEntry[]
}
