/**
 * CheckpointEngine — Runtime Resilience v2 增强 checkpoint 引擎。
 *
 * v2 附加字段写入与 v1 信封同一 JSON 文件；原子写入（tmp + rename）。
 * DRF-30 裁剪版：不含 TaskGraph、Supervisor phase、escalation bypass 字段。
 */

import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"

import { BranchBudgetTracker } from "../governance/branch-budget.js"
import type { VerificationGateState } from "../governance/verification-gate.js"
import { TaskLedger } from "../task-ledger.js"
import {
  buildMinimalCheckpointEnvelope,
  type SessionCheckpointEnvelope,
} from "./checkpoint-envelope.js"
import {
  RUNTIME_CHECKPOINT_VERSION,
  isRuntimeCheckpointV2,
  emptyRuntimeCheckpointV2,
  type RuntimeCheckpointV2,
  type CheckpointSaveTrigger,
  type ToolHistoryEntry,
  type FailureHistoryEntry,
  type RecoverySignal,
  type StopReason,
} from "./runtime-checkpoint.js"

/** 磁盘上的组合 checkpoint 文件 */
export interface CombinedCheckpointFile extends SessionCheckpointEnvelope {
  runtimeV2?: RuntimeCheckpointV2
}

/** Save 时调用方传入的最新运行时状态 */
export interface CheckpointSaveInput {
  trigger: CheckpointSaveTrigger
  currentStepId?: string
  currentStepTitle?: string
  branchBudget?: BranchBudgetTracker
  appendTool?: ToolHistoryEntry
  appendFailure?: FailureHistoryEntry
  verificationPending?: boolean
  appendRecoverySignal?: RecoverySignal
  lastStopReason?: StopReason
  taskLedger?: TaskLedger
  verificationGate?: VerificationGateState
}

const MAX_RECENT_TOOLS = 20
const MAX_RECENT_FAILURES = 10
const MAX_RECOVERY_SIGNALS = 8

const FREE_PERSIST_TRIGGERS: ReadonlySet<CheckpointSaveTrigger> = new Set([
  "tool_failed",
  "verification_failed",
  "compaction",
  "final_draft",
])

const FORCED_EXTRA_TRIGGERS: ReadonlySet<CheckpointSaveTrigger> = new Set([
  "step_completed",
  "verification_started",
])

/** Runtime Resilience v2 始终开启 */
export function isResilienceV2Enabled(): boolean {
  return true
}

/**
 * 增强 checkpoint 引擎。
 */
export class CheckpointEngine {
  readonly checkpointPath: string
  private v2State: RuntimeCheckpointV2 = emptyRuntimeCheckpointV2()
  private forcedPolicyActive = false
  private readonly sessionId: string

  constructor(sessionDir: string, sessionId = "default") {
    this.sessionId = sessionId
    this.checkpointPath = path.join(sessionDir, `${sessionId}.checkpoint.json`)
  }

  /** 暴露内存中的 v2 状态（测试 / 调试用） */
  getV2State(): RuntimeCheckpointV2 {
    return cloneV2(this.v2State)
  }

  /** 启停 forced 段强制落盘策略 */
  setForcedPolicy(active: boolean): void {
    this.forcedPolicyActive = active
  }

  isForcedPolicyActive(): boolean {
    return this.forcedPolicyActive
  }

  /** 给定保存触发器，返回是否应在当前 policy 下真实落盘 */
  shouldPersistOnTrigger(trigger: CheckpointSaveTrigger): boolean {
    if (FREE_PERSIST_TRIGGERS.has(trigger)) return true
    return this.forcedPolicyActive && FORCED_EXTRA_TRIGGERS.has(trigger)
  }

  /** 加载现有 checkpoint 并解析 v2 字段；无 v2 时返回 null */
  async loadV2(): Promise<RuntimeCheckpointV2 | null> {
    try {
      const raw = await fs.readFile(this.checkpointPath, "utf-8")
      const parsed = JSON.parse(raw) as CombinedCheckpointFile
      if (parsed && isRuntimeCheckpointV2(parsed.runtimeV2)) {
        this.v2State = cloneV2(parsed.runtimeV2)
        return cloneV2(parsed.runtimeV2)
      }
      return null
    } catch {
      return null
    }
  }

  /** 加载完整 CombinedCheckpointFile */
  async loadCombined(): Promise<CombinedCheckpointFile | null> {
    try {
      const raw = await fs.readFile(this.checkpointPath, "utf-8")
      const parsed = JSON.parse(raw) as CombinedCheckpointFile
      return parsed ?? null
    } catch {
      return null
    }
  }

  /**
   * SPEC-07: 实例级 promise chain 串行化所有 save 调用。
   * shutdown / safe-point / loop 等并发路径可能在同一实例上交错调用 save，
   * promise chain 保证按调用顺序串行执行，避免读-改-写竞态。
   * 不使用全局 static lock，避免无关 session 相互阻塞。
   */
  private saveChain: Promise<RuntimeCheckpointV2> = Promise.resolve(this.getV2State())

  async save(input: CheckpointSaveInput): Promise<RuntimeCheckpointV2> {
    const run = this.saveChain
      .catch(() => this.getV2State())
      .then(() => this.saveUnlocked(input))

    this.saveChain = run.catch(() => this.getV2State())
    return run
  }

  /**
   * 实际执行合并保存的函数（无锁版本，由 saveChain 串行调用）。
   * 合并保存：把 v2 附加字段写回到现有 checkpoint 文件。
   * 使用临时文件 + rename 保证原子性。
   */
  private async saveUnlocked(input: CheckpointSaveInput): Promise<RuntimeCheckpointV2> {
    this.applyInput(input)

    await fs.mkdir(path.dirname(this.checkpointPath), { recursive: true })
    const tmpPath = `${this.checkpointPath}.${randomUUID()}.tmp`

    let base: CombinedCheckpointFile | null = null
    try {
      const raw = await fs.readFile(this.checkpointPath, "utf-8")
      const parsed = JSON.parse(raw) as CombinedCheckpointFile
      if (parsed && this.isV1CombinedCheckpoint(parsed)) {
        base = parsed
      }
    } catch (err: unknown) {
      if (this.isENOENT(err)) {
        base = buildMinimalCheckpointEnvelope(this.sessionId)
      } else {
        try {
          await fs.access(this.checkpointPath)
          for (let i = 0; i < 3; i++) {
            await new Promise((r) => setTimeout(r, 20 * (i + 1)))
            try {
              const retryRaw = await fs.readFile(this.checkpointPath, "utf-8")
              const retryParsed = JSON.parse(retryRaw) as CombinedCheckpointFile
              if (retryParsed && this.isV1CombinedCheckpoint(retryParsed)) {
                base = retryParsed
                break
              }
            } catch {}
          }
        } catch {}
      }
    }

    if (!base) {
      base = buildMinimalCheckpointEnvelope(this.sessionId)
    }

    const merged: CombinedCheckpointFile = {
      ...base,
      runtimeV2: cloneV2(this.v2State),
    }

    await fs.writeFile(tmpPath, JSON.stringify(merged, null, 2), "utf-8")
    await fs.rename(tmpPath, this.checkpointPath)

    return cloneV2(this.v2State)
  }

  private applyInput(input: CheckpointSaveInput): void {
    const state = this.v2State

    state.lastTrigger = input.trigger
    state.v2UpdatedAt = new Date().toISOString()

    if (input.currentStepId !== undefined) state.currentStepId = input.currentStepId
    if (input.currentStepTitle !== undefined) state.currentStepTitle = input.currentStepTitle
    if (input.verificationPending !== undefined) state.verificationPending = input.verificationPending
    if (input.lastStopReason !== undefined) state.lastStopReason = input.lastStopReason

    if (input.branchBudget) {
      state.branchBudget = input.branchBudget.snapshot()
    }

    if (input.appendTool) {
      state.recentTools.push(input.appendTool)
      if (state.recentTools.length > MAX_RECENT_TOOLS) {
        state.recentTools = state.recentTools.slice(-MAX_RECENT_TOOLS)
      }
    }

    if (input.appendFailure) {
      const idx = state.recentFailures.findIndex(f => f.signature === input.appendFailure!.signature)
      if (idx >= 0) {
        state.recentFailures[idx] = {
          ...state.recentFailures[idx],
          count: Math.max(state.recentFailures[idx].count, input.appendFailure.count),
          lastError: input.appendFailure.lastError ?? state.recentFailures[idx].lastError,
          at: input.appendFailure.at,
        }
      } else {
        state.recentFailures.push(input.appendFailure)
      }
      if (state.recentFailures.length > MAX_RECENT_FAILURES) {
        state.recentFailures = state.recentFailures.slice(-MAX_RECENT_FAILURES)
      }
    }

    if (input.appendRecoverySignal) {
      state.recoverySignals.push(input.appendRecoverySignal)
      if (state.recoverySignals.length > MAX_RECOVERY_SIGNALS) {
        state.recoverySignals = state.recoverySignals.slice(-MAX_RECOVERY_SIGNALS)
      }
    }

    if (input.verificationGate !== undefined) {
      state.verificationGate = { ...input.verificationGate }
    }

    if (input.taskLedger !== undefined) {
      state.taskLedger = { ...input.taskLedger }
    }
  }

  markRecoverySignalsConsumed(predicate: (s: RecoverySignal) => boolean): void {
    for (const sig of this.v2State.recoverySignals) {
      if (predicate(sig)) sig.consumed = true
    }
  }

  pendingRecoverySignals(): RecoverySignal[] {
    return this.v2State.recoverySignals.filter(s => !s.consumed)
  }

  discardPendingRecoverySignals(): void {
    for (const sig of this.v2State.recoverySignals) {
      if (!sig.consumed) sig.consumed = true
    }
  }

  resetMemory(): void {
    this.v2State = emptyRuntimeCheckpointV2()
  }

  private isENOENT(err: unknown): boolean {
    return typeof err === "object"
      && err !== null
      && "code" in err
      && (err as { code?: unknown }).code === "ENOENT"
  }

  private isV1CombinedCheckpoint(parsed: unknown): parsed is CombinedCheckpointFile {
    if (!parsed || typeof parsed !== "object") return false
    const ver = (parsed as { version?: unknown }).version
    return typeof ver === "number" && ver === 1
  }
}

function cloneTaskLedger(ledger: TaskLedger): TaskLedger {
  return {
    ...ledger,
    plan: ledger.plan?.map(step => ({ ...step })) ?? [],
    changedFiles: ledger.changedFiles ? [...ledger.changedFiles] : [],
    commandsRun: ledger.commandsRun?.map(cmd => ({ ...cmd })) ?? [],
    lastVerification: ledger.lastVerification ? { ...ledger.lastVerification } : undefined,
    blockers: ledger.blockers ? [...ledger.blockers] : [],
  }
}

function cloneV2(v: RuntimeCheckpointV2): RuntimeCheckpointV2 {
  return {
    runtimeVersion: RUNTIME_CHECKPOINT_VERSION,
    currentStepId: v.currentStepId,
    currentStepTitle: v.currentStepTitle,
    branchBudget: {
      fileEdits: { ...v.branchBudget.fileEdits },
      commandRetries: { ...v.branchBudget.commandRetries },
      errorRepeats: { ...v.branchBudget.errorRepeats },
      recoverTriggers: v.branchBudget.recoverTriggers,
    },
    recentTools: v.recentTools.map(t => ({ ...t })),
    recentFailures: v.recentFailures.map(f => ({ ...f })),
    verificationPending: v.verificationPending,
    verificationGate: v.verificationGate ? { ...v.verificationGate } : undefined,
    taskLedger: v.taskLedger ? cloneTaskLedger(v.taskLedger) : undefined,
    recoverySignals: v.recoverySignals.map(s => ({ ...s })),
    lastTrigger: v.lastTrigger,
    lastStopReason: v.lastStopReason,
    v2UpdatedAt: v.v2UpdatedAt,
  }
}
