/**
 * free/forced 执行模式决策
 *
 * DRF-70: 从 iceCoder mode-decision-engine.ts 适配
 * Source: iceCoder/src/harness/supervisor/mode-decision-engine.ts (MIT)
 *
 * 与 HarnessProfile.mode 集成：free/adaptive/forced/strict
 */

import type { HarnessMode } from "../model-profile/types.js"

/** 运行时执行边界（非 HarnessProfile.mode 配置档） */
export type ExecutionMode = "free" | "forced"

/** 进入 forced 的触发信号 */
export type ModeSignal =
  | "task_graph_active"
  | "pending_steps"
  | "multi_write"
  | "branch_switched"
  | "checkpoint_resumed"
  | "tool_failure"
  | "verification_failure"
  | "recovery_pending"
  | "verification_pending"
  | "large_diff"
  | "explicit_impl"
  | "engine_fail_safe"

/** 进入 forced 的信号优先级（index 越小优先级越高） */
export const MODE_SIGNAL_PRECEDENCE: readonly ModeSignal[] = [
  "checkpoint_resumed",
  "task_graph_active",
  "branch_switched",
  "pending_steps",
  "tool_failure",
  "verification_failure",
  "multi_write",
  "large_diff",
  "explicit_impl",
] as const

/** 外部信号来源 */
export type ModeSignalSource =
  | "graph_executor"
  | "recovery_supervisor"
  | "checkpoint_engine"
  | "step_gate"
  | "branch_budget"
  | "tool_gate"
  | "verification_gate"
  | "stop_hook"

/** 任务风险等级（L0 短路用） */
export type TaskRiskLevel = "L0_observation" | "L1_minor_edit" | "L2_structural"

/** 执行模式阈值配置 */
export interface ExecutionModeConfig {
  /** pending 步骤数达到此值进入 forced */
  pendingStepsEnterThreshold: number
  /** 单轮写入目标数达到此值进入 forced */
  writeTargetsEnterThreshold: number
  /** 累计 diff 行数达到此值进入 forced */
  diffLinesEnterThreshold: number
  /** 稳定轮次达到此值可退出 forced */
  stableRoundsExitThreshold: number
  /** 进入 forced 后的锁定轮数 */
  modeLockRounds: number
  /** forced 最少驻留轮数 */
  forcedMinDwellRounds: number
  /** 只读工具名（不参与 multi_write 计数） */
  readonlyToolNames: string[]
}

/** 运行时执行状态快照 */
export interface RuntimeExecutionState {
  round: number
  taskGraphActive: boolean
  pendingStepCount: number
  writeTargetsThisRound: number
  plannedWriteTargets: number
  accumulatedDiffLines: number
  branchSwitchedThisRound: boolean
  checkpointResumedThisSession: boolean
  lastToolSuccess: boolean
  recoveryPending: boolean
  verificationPending: boolean
  branchDebt: number
  stableRounds: number
  activeGraphHasImplementNode: boolean
  readonlyToolNames: string[]
  plannedToolNames: string[]
  forcedEntryRound: number | null
  forcedTaskBearingRoundsSinceEntry: number
}

/** 模式决策上下文 */
export interface ModeDecisionContext {
  round: number
  executionMode: ExecutionMode
  executionModeLockRemaining: number
  /** 映射自 HarnessProfile.mode */
  harnessMode: HarnessMode
  riskLevel: TaskRiskLevel
  state: RuntimeExecutionState
  signals: ModeSignal[]
}

/** 模式决策结果 */
export type ModeDecision =
  | { action: "keep"; mode: ExecutionMode }
  | {
      action: "enter_forced"
      reason: ModeSignal[]
      lockRounds: number
      enteredBy: ModeSignal[]
      primaryReason: ModeSignal
      failSafe?: boolean
    }
  | { action: "exit_forced"; reason: string }

/** 默认执行模式阈值 */
export const DEFAULT_EXECUTION_MODE_CONFIG: ExecutionModeConfig = {
  pendingStepsEnterThreshold: 2,
  writeTargetsEnterThreshold: 1,
  diffLinesEnterThreshold: 200,
  stableRoundsExitThreshold: 2,
  modeLockRounds: 2,
  forcedMinDwellRounds: 1,
  readonlyToolNames: ["read_file", "glob", "grep", "list_dir", "lsp"],
}

interface SubmittedModeSignal {
  source: ModeSignalSource
  signal: ModeSignal
  payload?: Record<string, unknown>
}

const ENTER_SIGNAL_SET = new Set<ModeSignal>(MODE_SIGNAL_PRECEDENCE)

/**
 * 按优先级排序进入 forced 的信号；排除 recovery_pending / verification_pending
 */
export function sortSignalsByPrecedence(signals: ModeSignal[]): ModeSignal[] {
  const seen = new Set<ModeSignal>()
  const enterSignals = signals.filter((signal) => {
    if (!ENTER_SIGNAL_SET.has(signal) || seen.has(signal)) return false
    seen.add(signal)
    return true
  })

  return enterSignals.sort(
    (a, b) => MODE_SIGNAL_PRECEDENCE.indexOf(a) - MODE_SIGNAL_PRECEDENCE.indexOf(b),
  )
}

/**
 * 格式化 forced 原因的人类可读字符串
 */
export function formatForcedReasonHuman(enteredBy: ModeSignal[]): string {
  if (enteredBy.length === 0) return "free"
  return `forced because ${enteredBy.join(" + ")}`
}

/**
 * L0 短路：仅保留外部硬信号，不读取 state 派生
 */
function sortExternalEnterSignals(signals: ModeSignal[]): ModeSignal[] {
  return sortSignalsByPrecedence(signals)
}

/**
 * 根据 HarnessProfile.mode 解析初始 executionMode
 */
export function resolveInitialExecutionMode(harnessMode: HarnessMode): ExecutionMode {
  if (harnessMode === "forced" || harnessMode === "strict") return "forced"
  return "free"
}

/**
 * HarnessProfile.mode 是否启用自动模式决策
 */
export function isAutoModeDecisionEnabled(harnessMode: HarnessMode): boolean {
  return harnessMode === "adaptive" || harnessMode === "strict"
}

/**
 * 从 state 派生是否应进入 forced
 */
export function shouldEnterForcedMode(
  state: RuntimeExecutionState,
  config: ExecutionModeConfig,
  signals: ModeSignal[] = [],
): ModeSignal[] {
  const reasons: ModeSignal[] = [...signals]
  if (state.taskGraphActive) reasons.push("task_graph_active")
  if (state.pendingStepCount >= config.pendingStepsEnterThreshold) reasons.push("pending_steps")
  if (
    state.writeTargetsThisRound > config.writeTargetsEnterThreshold
    || state.plannedWriteTargets > config.writeTargetsEnterThreshold
  ) {
    reasons.push("multi_write")
  }
  if (state.branchSwitchedThisRound) reasons.push("branch_switched")
  if (state.checkpointResumedThisSession) reasons.push("checkpoint_resumed")
  if (!state.lastToolSuccess) reasons.push("tool_failure")
  if (state.verificationPending) reasons.push("verification_failure")
  if (state.accumulatedDiffLines > config.diffLinesEnterThreshold) reasons.push("large_diff")
  if (state.activeGraphHasImplementNode) reasons.push("explicit_impl")
  return sortSignalsByPrecedence(reasons)
}

/**
 * 是否满足退出 forced 的条件
 */
export function shouldExitForcedMode(
  state: RuntimeExecutionState,
  config: ExecutionModeConfig,
  executionModeLockRemaining: number,
  signals: ModeSignal[] = [],
): boolean {
  if (executionModeLockRemaining > 0) return false
  if (state.forcedTaskBearingRoundsSinceEntry < config.forcedMinDwellRounds) return false
  if (!state.lastToolSuccess || signals.includes("tool_failure")) return false
  if (state.recoveryPending || signals.includes("recovery_pending")) return false
  if (state.verificationPending || signals.includes("verification_pending")) return false
  return state.pendingStepCount === 0
    && state.plannedWriteTargets === 0
    && state.stableRounds >= config.stableRoundsExitThreshold
    && state.branchDebt === 0
}

/**
 * free/forced 模式决策引擎
 */
export class ModeDecisionEngine {
  private readonly submittedSignals: SubmittedModeSignal[] = []

  constructor(private readonly config: ExecutionModeConfig = DEFAULT_EXECUTION_MODE_CONFIG) {}

  /**
   * 评估当前轮是否进入/保持/退出 forced
   */
  evaluate(ctx: ModeDecisionContext): ModeDecision {
    try {
      return this.evaluateOrThrow(ctx)
    } catch {
      return {
        action: "enter_forced",
        reason: ["engine_fail_safe"],
        lockRounds: this.config.modeLockRounds,
        enteredBy: ["engine_fail_safe"],
        primaryReason: "engine_fail_safe",
        failSafe: true,
      }
    } finally {
      this.submittedSignals.length = 0
    }
  }

  /**
   * 提交外部硬信号（checkpoint、verification gate 等）
   */
  submitSignal(
    source: ModeSignalSource,
    signal: ModeSignal,
    payload?: Record<string, unknown>,
  ): void {
    this.submittedSignals.push({ source, signal, payload })
  }

  /** 获取尚未被 evaluate 消费的 submitted 信号 */
  getSubmittedSignals(): readonly SubmittedModeSignal[] {
    return this.submittedSignals
  }

  /**
   * 跨 run 复用时清空残留信号，避免污染下一轮 evaluate
   */
  resetSubmittedSignals(): void {
    this.submittedSignals.length = 0
  }

  protected evaluateOrThrow(ctx: ModeDecisionContext): ModeDecision {
    const signals = [
      ...ctx.signals,
      ...this.submittedSignals.map((entry) => entry.signal),
    ]

    if (ctx.harnessMode === "free") {
      return { action: "keep", mode: "free" }
    }

    if (ctx.harnessMode === "forced" || ctx.harnessMode === "strict") {
      if (ctx.executionMode === "forced") {
        return { action: "keep", mode: "forced" }
      }

      const strictFloor: ModeSignal[] = ctx.harnessMode === "strict" ? ["explicit_impl"] : []
      const enteredBy = sortExternalEnterSignals([...signals, ...strictFloor])
      const reasons = enteredBy.length > 0 ? enteredBy : (["explicit_impl"] as ModeSignal[])
      return {
        action: "enter_forced",
        reason: reasons,
        lockRounds: this.config.modeLockRounds,
        enteredBy: reasons,
        primaryReason: reasons[0],
      }
    }

    if (ctx.executionMode !== "forced") {
      const skipStateDerivedEnter = ctx.harnessMode === "adaptive"
        && ctx.riskLevel === "L0_observation"
      const enteredBy = skipStateDerivedEnter
        ? sortExternalEnterSignals(signals)
        : shouldEnterForcedMode(ctx.state, this.config, signals)

      if (enteredBy.length > 0) {
        return {
          action: "enter_forced",
          reason: enteredBy,
          lockRounds: this.config.modeLockRounds,
          enteredBy,
          primaryReason: enteredBy[0],
        }
      }
      return { action: "keep", mode: ctx.executionMode }
    }

    if (shouldExitForcedMode(ctx.state, this.config, ctx.executionModeLockRemaining, signals)) {
      return { action: "exit_forced", reason: "stable" }
    }
    return { action: "keep", mode: "forced" }
  }
}

/**
 * 创建空运行时状态（测试与初始化用）
 */
export function createEmptyRuntimeExecutionState(
  overrides: Partial<RuntimeExecutionState> = {},
): RuntimeExecutionState {
  return {
    round: 1,
    taskGraphActive: false,
    pendingStepCount: 0,
    writeTargetsThisRound: 0,
    plannedWriteTargets: 0,
    accumulatedDiffLines: 0,
    branchSwitchedThisRound: false,
    checkpointResumedThisSession: false,
    lastToolSuccess: true,
    recoveryPending: false,
    verificationPending: false,
    branchDebt: 0,
    stableRounds: DEFAULT_EXECUTION_MODE_CONFIG.stableRoundsExitThreshold,
    activeGraphHasImplementNode: false,
    readonlyToolNames: DEFAULT_EXECUTION_MODE_CONFIG.readonlyToolNames,
    plannedToolNames: [],
    forcedEntryRound: null,
    forcedTaskBearingRoundsSinceEntry: DEFAULT_EXECUTION_MODE_CONFIG.forcedMinDwellRounds,
    ...overrides,
  }
}
