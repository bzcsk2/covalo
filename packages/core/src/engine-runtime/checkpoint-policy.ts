import type { CheckpointEngine } from "../checkpoint/checkpoint-engine.js"
import type { BranchBudgetTracker } from "../governance/branch-budget.js"
import type { ModeDecisionEngine } from "../governance/mode-decision.js"
import type { VerificationGateState } from "../governance/verification-gate.js"
import type { TaskLedger } from "../task-ledger.js"
import type { RuntimeLogger } from "../runtime-logger.js"

export type { CheckpointEngine, BranchBudgetTracker, ModeDecisionEngine }

/**
 * F0-1: shutdown 时最后落盘一次 checkpoint。
 */
export async function saveFinalCheckpoint(
  checkpointEngine: CheckpointEngine | undefined,
  branchBudgetTracker: BranchBudgetTracker,
  taskLedgerSnapshot: TaskLedger | undefined,
  verificationGateState: VerificationGateState | undefined,
  logger: RuntimeLogger,
): Promise<void> {
  try {
    if (checkpointEngine) {
      await checkpointEngine.save({
        trigger: "final_draft",
        branchBudget: branchBudgetTracker,
        lastStopReason: "aborted",
        taskLedger: taskLedgerSnapshot,
        verificationGate: verificationGateState,
      })
    }
  } catch (e) {
    if (logger.isEnabled("warn")) {
      logger.warn("engine.shutdown.checkpoint_save_error", { error: e instanceof Error ? e.message : String(e) })
    }
  }
}

/**
 * F0-1/B4: 每次 submit 开始时尝试恢复 checkpoint。
 * 恢复的三维计数和 recoverTriggers 从快照延续，跨 submit 持久化真正生效。
 *
 * B6-2: 仅在 adaptive 模式下向 ModeDecisionEngine 提交 checkpoint_resumed signal。
 * free/forced 模式下 signal 不会被消费，标记为已消费避免残留。
 */
export async function recoverCheckpoint(
  checkpointEngine: CheckpointEngine,
  branchBudgetTracker: BranchBudgetTracker,
  modeDecisionEngine: ModeDecisionEngine,
  logger: RuntimeLogger,
  sessionId: string,
  executionMode: string,
): Promise<void> {
  const isAdaptiveMode = executionMode === "adaptive"
  try {
    const v2 = await checkpointEngine.loadV2()
    if (v2) {
      branchBudgetTracker.applySnapshot(v2.branchBudget)
      if (isAdaptiveMode) {
        modeDecisionEngine.submitSignal("checkpoint_engine", "checkpoint_resumed")
      } else {
        // 非 adaptive 模式下，pending recovery signals 直接标记为已消费，
        // 避免 engine 层恢复 checkpoint 后 signal 残留。
        checkpointEngine.markRecoverySignalsConsumed(() => true)
      }
      if (logger.isEnabled("info")) {
        logger.info("engine.checkpoint.resumed", { sessionId, executionMode })
      }
    }
  } catch (e) {
    if (logger.isEnabled("warn")) {
      logger.warn("engine.checkpoint.resume_error", { error: e instanceof Error ? e.message : String(e) })
    }
  }
}
