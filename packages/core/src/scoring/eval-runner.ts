/**
 * Eval runner for executing benchmark cases through the agent system.
 * Orchestrates multi-model benchmark execution with proper scoring, persistence,
 * and progress reporting.
 */

import type {
  AgentBenchmarkCase,
  AgentBenchmarkRunScore,
  AgentBenchmarkLeaderboardEntry,
  AgentBenchmarkRunInput,
  AgentBenchmarkSuiteSummary,
  SupervisorRunAssessment,
} from "./types.js"
import { scoreBenchmarkRun, buildBenchmarkLeaderboard, summarizeBenchmarkSuite } from "./benchmark-runner.js"
import { buildWorkerEvalPrompt, buildSupervisorEvalPrompt } from "./eval-prompts.js"
import { EvalReportStore } from "./store.js"

export interface EvalRunOptions {
  /** Models to evaluate */
  models: string[]
  /** Benchmark cases to run */
  cases: AgentBenchmarkCase[]
  /** Maximum number of cases per model */
  limit?: number
  /** Whether to run in dry-run mode */
  dryRun?: boolean
  /** Supervisor model target (defaults to first model) */
  supervisorModelTarget?: string
}

export interface EvalRunProgress {
  /** Current status */
  status: "setup" | "running" | "passed" | "failed" | "skipped" | "complete"
  /** Current case ID */
  caseId?: string
  /** Current case index (1-based) */
  index?: number
  /** Total cases */
  total?: number
  /** Worker model being evaluated */
  workerModelTarget?: string
  /** Skip reason if status is 'skipped' */
  reason?: string
  /** Score if status is 'passed' or 'failed' */
  score?: {
    overallScore: number
    grade: string
  }
}

export interface EvalRunResult {
  /** Unique eval run ID */
  evalRunId: string
  /** Directory where the report is saved */
  reportDir: string
  /** Leaderboard entries */
  leaderboard: AgentBenchmarkLeaderboardEntry[]
  /** All run scores */
  runs: AgentBenchmarkRunScore[]
}

export type WorkerExecutor = (params: {
  prompt: string
  signal?: AbortSignal
}) => Promise<{ text: string; toolCalls: number; toolFailures: number; durationMs: number }>

export type SupervisorExecutor = (params: {
  prompt: string
  signal?: AbortSignal
}) => Promise<{ text: string; durationMs: number }>

export type ModelSwitchFn = (modelTarget: string) => Promise<void>
export type ModelRestoreFn = () => Promise<void>

/** Check if a model target has the required API key configured. Return skip reason or null if ok. */
export type ApiKeyCheckFn = (modelTarget: string) => string | null

/**
 * Extract a balanced JSON object starting at openBraceIndex.
 */
function extractBalancedJson(text: string, openBraceIndex: number): { json: string; end: number } | null {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = openBraceIndex; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === "\\") { escaped = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === "{") depth++
    else if (ch === "}") {
      depth--
      if (depth === 0) return { json: text.slice(openBraceIndex, i + 1), end: i + 1 }
    }
  }
  return null
}

/**
 * Coerce a value to boolean, accepting common LLM string variants.
 * Returns undefined when the value cannot be coered (absent or unrecognized).
 */
function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "string") {
    const lower = value.toLowerCase().trim()
    if (lower === "true" || lower === "yes" || lower === "pass" || lower === "passed" || lower === "ok") return true
    if (lower === "false" || lower === "no" || lower === "fail" || lower === "failed") return false
  }
  return undefined
}

/**
 * Try to parse a JSON object from a text response.
 * Tries all fenced blocks first, then all balanced JSON objects, then full trim.
 */
function tryParseJson(text: string): Record<string, unknown> | null {
  // 1. Try all fenced JSON blocks
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fenceRe.exec(text)) !== null) {
    const candidate = match[1]!.trim()
    if (!candidate) continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // try next candidate
    }
  }

  // 2. Try all balanced JSON objects
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue
    const extracted = extractBalancedJson(text, i)
    if (!extracted) continue
    try {
      const parsed = JSON.parse(extracted.json)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // try next candidate
    }
  }

  // 3. Try full trim
  const trimmed = text.trim()
  try {
    const parsed = JSON.parse(trimmed)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // noop
  }

  return null
}

/**
 * Try to parse a SupervisorRunAssessment from supervisor text output.
 */
function tryParseSupervisorAssessment(text: string): SupervisorRunAssessment | null {
  const parsed = tryParseJson(text)
  if (!parsed) return null
  const rawCompleted = parsed.completed
  const completed = coerceBoolean(rawCompleted) ?? false
  const completedKnown = coerceBoolean(rawCompleted) !== undefined
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    completed,
    completedKnown,
    verificationPassed: coerceBoolean(parsed.verificationPassed) ?? false,
    safetyIssue: coerceBoolean(parsed.safetyIssue) ?? false,
    dimensions: parsed.dimensions && typeof parsed.dimensions === "object"
      ? parsed.dimensions as Partial<Record<string, number>>
      : undefined,
    promptStrategies: Array.isArray(parsed.promptStrategies) ? parsed.promptStrategies : undefined,
  }
}

/**
 * Try to extract structured fields from a worker output text.
 */
function parseWorkerReport(text: string): {
  summary: string
  completedSteps: string[]
  changedFiles: string[]
  verificationPassed: boolean
  verificationCommands: string[]
  blockers: string[]
} {
  const parsed = tryParseJson(text)
  if (parsed && typeof parsed.summary === "string") {
    return {
      summary: parsed.summary,
      completedSteps: Array.isArray(parsed.completedSteps) ? parsed.completedSteps as string[] : [],
      changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles as string[] : [],
      verificationPassed: parsed.verification && typeof parsed.verification === "object"
        ? coerceBoolean((parsed.verification as Record<string, unknown>).passed) ?? false
        : false,
      verificationCommands: parsed.verification && typeof parsed.verification === "object"
        ? Array.isArray((parsed.verification as Record<string, unknown>).commands)
          ? (parsed.verification as Record<string, unknown>).commands as string[]
          : []
        : [],
      blockers: Array.isArray(parsed.blockers) ? parsed.blockers as string[] : [],
    }
  }
  return {
    summary: text.slice(0, 500),
    completedSteps: [],
    changedFiles: [],
    verificationPassed: false,
    verificationCommands: [],
    blockers: [],
  }
}

/**
 * Run eval cases through the agent system with proper scoring and persistence.
 */
export async function runEval(
  options: EvalRunOptions,
  executors: {
    switchModel: ModelSwitchFn
    restoreModel: ModelRestoreFn
    executeWorker: WorkerExecutor
    executeSupervisor: SupervisorExecutor
    checkApiKey?: ApiKeyCheckFn
    abortSignal?: AbortSignal
  },
  onProgress?: (progress: EvalRunProgress) => void,
): Promise<EvalRunResult> {
  const { models, cases, limit, dryRun = false, supervisorModelTarget } = options
  const { switchModel, restoreModel, executeWorker, executeSupervisor, checkApiKey, abortSignal } = executors

  const evalRunId = `eval-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`
  const reportDir = `.covalo/evals/${evalRunId}`

  const allRuns: AgentBenchmarkRunScore[] = []
  const skippedModels: string[] = []

  const reportProgress = (progress: EvalRunProgress) => {
    if (abortSignal?.aborted) return
    onProgress?.(progress)
  }

  reportProgress({ status: "setup" })

  // Pre-scan models for API key availability
  const casesToRun = limit ? cases.slice(0, limit) : cases
  const availableModels: string[] = []
  const skippedModelReasons = new Map<string, string>()

  for (const model of models) {
    if (checkApiKey) {
      const reason = checkApiKey(model)
      if (reason) {
        skippedModels.push(model)
        skippedModelReasons.set(model, reason)
        continue
      }
    }
    availableModels.push(model)
  }

  const totalCaseCount = availableModels.length * casesToRun.length + skippedModels.length * casesToRun.length
  let currentIndex = 0

  // Emit progress events for skipped models (each case)
  for (const model of skippedModels) {
    for (const benchmarkCase of casesToRun) {
      currentIndex++
      reportProgress({
        status: "skipped",
        index: currentIndex,
        total: totalCaseCount,
        workerModelTarget: model,
        caseId: benchmarkCase.id,
        reason: skippedModelReasons.get(model) ?? "unknown",
      })
    }
  }

  if (dryRun) {
    for (const model of availableModels) {
      for (const benchmarkCase of casesToRun) {
        currentIndex++
        reportProgress({
          status: "skipped",
          index: currentIndex,
          total: totalCaseCount,
          workerModelTarget: model,
          caseId: benchmarkCase.id,
          reason: "dry-run",
        })
      }
    }
    reportProgress({ status: "complete" })
    return {
      evalRunId,
      reportDir,
      leaderboard: [],
      runs: [],
    }
  }

  for (const model of availableModels) {
    if (abortSignal?.aborted) break

    // Switch model once per model batch
    try {
      await switchModel(model)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      for (const benchmarkCase of casesToRun) {
        currentIndex++
        reportProgress({
          status: "skipped",
          index: currentIndex,
          total: totalCaseCount,
          workerModelTarget: model,
          caseId: benchmarkCase.id,
          reason,
        })
      }
      continue
    }

    for (const benchmarkCase of casesToRun) {
      if (abortSignal?.aborted) break

      currentIndex++

      reportProgress({
        status: "running",
        index: currentIndex,
        total: totalCaseCount,
        workerModelTarget: model,
        caseId: benchmarkCase.id,
      })

      try {
        const workerPrompt = buildWorkerEvalPrompt(benchmarkCase)
        const workerResult = await executeWorker({ prompt: workerPrompt, signal: abortSignal })

        const supervisorPrompt = buildSupervisorEvalPrompt(benchmarkCase, workerResult.text)
        const supervisorResult = await executeSupervisor({ prompt: supervisorPrompt, signal: abortSignal })

        // Parse supervisor assessment and worker report
        const supervisorAssessment = tryParseSupervisorAssessment(supervisorResult.text)
        const workerReport = parseWorkerReport(workerResult.text)

        const runInput: AgentBenchmarkRunInput = {
          case: benchmarkCase,
          workerModelTarget: model,
          supervisorModelTarget: supervisorModelTarget ?? model,
          completed: supervisorAssessment?.completed ?? false,
          verificationPassed: supervisorAssessment?.verificationPassed ?? workerReport.verificationPassed,
          workerReport: workerReport.summary || workerResult.text.slice(0, 1000),
          completedSteps: workerReport.completedSteps,
          changedFiles: workerReport.changedFiles,
          verificationCommands: workerReport.verificationCommands,
          blockers: workerReport.blockers,
          toolCalls: workerResult.toolCalls,
          toolFailures: workerResult.toolFailures,
          loopCount: 1,
          durationMs: workerResult.durationMs + supervisorResult.durationMs,
          supervisorAssessment: supervisorAssessment ?? {
            summary: supervisorResult.text.slice(0, 500),
            completed: false,
            verificationPassed: false,
          },
        }

        const runScore = scoreBenchmarkRun(runInput)
        allRuns.push(runScore)

        reportProgress({
          status: runScore.completed ? "passed" : "failed",
          index: currentIndex,
          total: totalCaseCount,
          workerModelTarget: model,
          caseId: benchmarkCase.id,
          score: {
            overallScore: runScore.score.overallScore,
            grade: runScore.score.grade,
          },
        })
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)

        const runInput: AgentBenchmarkRunInput = {
          case: benchmarkCase,
          workerModelTarget: model,
          supervisorModelTarget: supervisorModelTarget ?? model,
          completed: false,
          verificationPassed: false,
          workerReport: `Execution error: ${errorMsg}`,
          blockers: [errorMsg],
          durationMs: 0,
          supervisorAssessment: {
            summary: `Error during eval execution: ${errorMsg}`,
            completed: false,
            verificationPassed: false,
          },
        }

        const runScore = scoreBenchmarkRun(runInput)
        allRuns.push(runScore)

        reportProgress({
          status: "failed",
          index: currentIndex,
          total: totalCaseCount,
          workerModelTarget: model,
          caseId: benchmarkCase.id,
          score: {
            overallScore: runScore.score.overallScore,
            grade: runScore.score.grade,
          },
        })
      }
    }

    // Restore model after each model's batch completes (or fails)
    try {
      await restoreModel()
    } catch {
      // best-effort; original config will be restored on subsequent calls
    }
  }

  // Final restore guard
  try {
    await restoreModel()
  } catch {
    // best-effort
  }

  // Build leaderboard from all runs (excluding skipped)
  const leaderboard = buildBenchmarkLeaderboard(allRuns)

  // Build summary and persist eval report
  const store = new EvalReportStore()
  const meta = {
    evalRunId,
    createdAt: Date.now(),
    models: availableModels,
    cases: casesToRun.map(c => c.id),
    supervisorModelTarget: supervisorModelTarget ?? models[0],
    skippedModels: skippedModels.length > 0 ? skippedModels : undefined,
    totalRuns: totalCaseCount,
    completedRuns: allRuns.length,
  }
  const summary: AgentBenchmarkSuiteSummary = summarizeBenchmarkSuite(evalRunId, allRuns)

  store.saveMeta(evalRunId, meta)
  store.saveSummary(evalRunId, summary)
  store.saveScores(evalRunId, allRuns)
  store.saveLeaderboard(evalRunId, leaderboard)

  reportProgress({ status: "complete" })

  return {
    evalRunId,
    reportDir,
    leaderboard,
    runs: allRuns,
  }
}
