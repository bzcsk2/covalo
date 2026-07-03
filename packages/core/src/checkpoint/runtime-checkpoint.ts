/**
 * Runtime Resilience v2 — 增强 checkpoint schema（DRF-30 裁剪版）。
 *
 * v2 是 v1 信封的可选扩展；老 checkpoint 按 v1 解析即可。
 */

/** v2 schema 版本号 */
export const RUNTIME_CHECKPOINT_VERSION = 2 as const

/** Harness 循环停止原因 */
export type StopReason =
  | "completed"
  | "failed"
  | "aborted"
  | "user_cancelled"
  | "max_rounds"
  | "early_stop"
  | "error"

/** 最近一次工具调用的精简记录 */
export interface ToolHistoryEntry {
  toolName: string
  success: boolean
  signature: string
  at: number
}

/** 最近一次失败的精简记录 */
export interface FailureHistoryEntry {
  signature: string
  count: number
  lastError?: string
  at: number
}

/** 分支预算追踪器持久化快照 */
export interface BranchBudgetSnapshot {
  fileEdits: Record<string, number>
  commandRetries: Record<string, number>
  errorRepeats: Record<string, number>
  recoverTriggers: number
}

/**
 * 运行时恢复信号 — 由 BranchBudgetTracker 等子系统抛出，
 * 在持久化里保留，重启后立即重新注入。
 */
export interface RecoverySignal {
  source: "branch_budget" | "step_review" | "verification" | "other"
  message: string
  at: number
  consumed: boolean
}

import type { TaskLedger } from "../task-ledger.js"
import type { VerificationGateState } from "../governance/verification-gate.js"

/** v2 增强 checkpoint 的运行时状态部分 */
export interface RuntimeCheckpointV2 {
  runtimeVersion: typeof RUNTIME_CHECKPOINT_VERSION
  currentStepId?: string
  currentStepTitle?: string
  branchBudget: BranchBudgetSnapshot
  recentTools: ToolHistoryEntry[]
  recentFailures: FailureHistoryEntry[]
  verificationPending: boolean
  verificationGate?: VerificationGateState
  taskLedger?: TaskLedger
  recoverySignals: RecoverySignal[]
  lastTrigger: CheckpointSaveTrigger
  lastStopReason?: StopReason
  v2UpdatedAt: string
}

/** Checkpoint 触发器类型 */
export type CheckpointSaveTrigger =
  | "step_completed"
  | "tool_failed"
  | "verification_started"
  | "verification_failed"
  | "compaction"
  | "final_draft"
  | "manual"

/** 默认空 budget 快照 */
export function emptyBranchBudgetSnapshot(): BranchBudgetSnapshot {
  return {
    fileEdits: {},
    commandRetries: {},
    errorRepeats: {},
    recoverTriggers: 0,
  }
}

/** 默认空 v2 checkpoint */
export function emptyRuntimeCheckpointV2(
  trigger: CheckpointSaveTrigger = "manual",
): RuntimeCheckpointV2 {
  return {
    runtimeVersion: RUNTIME_CHECKPOINT_VERSION,
    branchBudget: emptyBranchBudgetSnapshot(),
    recentTools: [],
    recentFailures: [],
    verificationPending: false,
    recoverySignals: [],
    lastTrigger: trigger,
    v2UpdatedAt: new Date(0).toISOString(),
  }
}

/** 类型守卫：判断 JSON 对象是否包含完整 v2 字段 */
export function isRuntimeCheckpointV2(value: unknown): value is RuntimeCheckpointV2 {
  if (!value || typeof value !== "object") return false
  const v = value as Partial<RuntimeCheckpointV2>
  return (
    v.runtimeVersion === RUNTIME_CHECKPOINT_VERSION
    && !!v.branchBudget
    && Array.isArray(v.recentTools)
    && Array.isArray(v.recentFailures)
    && Array.isArray(v.recoverySignals)
    && typeof v.verificationPending === "boolean"
  )
}
