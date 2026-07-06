import type { CheckpointEngine } from "../../checkpoint/checkpoint-engine.js"
import type { CheckpointSaveTrigger, ToolHistoryEntry, FailureHistoryEntry, RecoverySignal } from "../../checkpoint/runtime-checkpoint.js"
import type { BranchBudgetTracker } from "../../governance/branch-budget.js"
import type { TaskLedgerTracker } from "../../task-ledger.js"
import type { VerificationGateState } from "../../governance/verification-gate.js"
import type { RuntimeLogger } from "../../runtime-logger.js"
import type { LoopPolicy, LoopPolicyContext, ToolBatchInfo } from "../policy.js"
import type { ToolCall } from "../../types.js"
import type { LoopEvent } from "../../interface.js"

export interface SaveCheckpointInput {
  checkpointEngine?: CheckpointEngine
  trigger: CheckpointSaveTrigger
  branchBudget?: BranchBudgetTracker
  taskLedger?: TaskLedgerTracker
  verificationGateState?: VerificationGateState
  extras?: {
    appendTool?: ToolHistoryEntry
    appendFailure?: FailureHistoryEntry
    appendRecoverySignal?: RecoverySignal
  }
  logger?: RuntimeLogger
}

export async function saveCheckpoint(input: SaveCheckpointInput): Promise<void> {
  const { checkpointEngine, trigger, branchBudget, taskLedger, verificationGateState, extras, logger } = input
  if (!checkpointEngine) return
  if (!checkpointEngine.shouldPersistOnTrigger(trigger)) return
  try {
    await checkpointEngine.save({
      trigger,
      branchBudget,
      taskLedger: taskLedger?.snapshot(),
      verificationGate: verificationGateState ? { ...verificationGateState } : undefined,
      ...extras,
    })
  } catch (e) {
    if (logger?.isEnabled("error")) {
      logger.warn("loop.checkpoint.save_error", {
        trigger,
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
}

export interface CreateCheckpointLoopPolicyInput {
  checkpointEngine?: CheckpointEngine
  branchBudget?: BranchBudgetTracker
  taskLedger?: TaskLedgerTracker
  verificationGateState?: VerificationGateState
  logger?: RuntimeLogger
}

export function createCheckpointLoopPolicy(input: CreateCheckpointLoopPolicyInput): LoopPolicy {
  const { checkpointEngine, branchBudget, taskLedger, verificationGateState, logger } = input
  return {
    name: "checkpoint",
    async afterToolBatch(_ctx: LoopPolicyContext, _toolCalls: readonly ToolCall[], info: ToolBatchInfo) {
      if (info.source !== "native") return
      await saveCheckpoint({
        checkpointEngine,
        trigger: "step_completed",
        branchBudget,
        taskLedger,
        verificationGateState,
        logger,
      })
    },
    async beforeFinalDraft() {
      await saveCheckpoint({
        checkpointEngine,
        trigger: "final_draft",
        branchBudget,
        taskLedger,
        verificationGateState,
        logger,
      })
    },
    async afterStreamError() {
      await saveCheckpoint({
        checkpointEngine,
        trigger: "tool_failed",
        branchBudget,
        taskLedger,
        verificationGateState,
        logger,
      })
    },
  }
}
