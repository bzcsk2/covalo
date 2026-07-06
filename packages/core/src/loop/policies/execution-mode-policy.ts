import type { CheckpointEngine } from "../../checkpoint/checkpoint-engine.js"
import type { BranchBudgetTracker } from "../../governance/branch-budget.js"
import type { TaskLedgerTracker } from "../../task-ledger.js"
import type { HarnessMode } from "../../model-profile/types.js"
import {
  type ModeDecisionEngine,
  type ModeDecision,
  type ExecutionMode,
  type RuntimeExecutionState,
} from "../../governance/mode-decision.js"

export interface EvaluateLoopExecutionModeInput {
  modeDecisionEngine?: ModeDecisionEngine
  checkpointEngine?: CheckpointEngine
  branchBudgetTracker?: BranchBudgetTracker
  runtimeState: RuntimeExecutionState
  turnCount: number
  currentExecutionMode: ExecutionMode
  executionModeLockRemaining: number
  harnessMode: HarnessMode
  autoModeDecisionEnabled: boolean
  taskLedger?: TaskLedgerTracker
}

export interface EvaluateLoopExecutionModeOutput {
  decision: ModeDecision | null
  currentExecutionMode: ExecutionMode
  executionModeLockRemaining: number
}

export function evaluateLoopExecutionMode(input: EvaluateLoopExecutionModeInput): EvaluateLoopExecutionModeOutput {
  const {
    modeDecisionEngine, checkpointEngine, branchBudgetTracker, runtimeState,
    turnCount, currentExecutionMode, executionModeLockRemaining,
    harnessMode, autoModeDecisionEnabled, taskLedger,
  } = input

  let mode = currentExecutionMode
  let lockRemaining = executionModeLockRemaining

  if (!modeDecisionEngine) return { decision: null, currentExecutionMode: mode, executionModeLockRemaining: lockRemaining }

  if (!autoModeDecisionEnabled) {
    modeDecisionEngine.resetSubmittedSignals()
    if (checkpointEngine) {
      checkpointEngine.markRecoverySignalsConsumed(() => true)
    }
    return { decision: null, currentExecutionMode: mode, executionModeLockRemaining: lockRemaining }
  }

  if (branchBudgetTracker) {
    const branchDecision = branchBudgetTracker.shouldBranchRecover()
    if (branchDecision.triggered) {
      modeDecisionEngine.submitSignal("branch_budget", "recovery_pending", {
        dimension: branchDecision.dimension,
        key: branchDecision.key,
        count: branchDecision.currentCount,
      })
    }
  }

  if (checkpointEngine) {
    const pending = checkpointEngine.pendingRecoverySignals()
    if (pending.length > 0) {
      modeDecisionEngine.submitSignal("checkpoint_engine", "checkpoint_resumed")
      checkpointEngine.markRecoverySignalsConsumed(() => true)
    }
  }

  runtimeState.round = turnCount
  runtimeState.recoveryPending = branchBudgetTracker?.shouldBranchRecover().triggered ?? false
  runtimeState.verificationPending = taskLedger?.verificationPending ?? false

  const modeDecision = modeDecisionEngine.evaluate({
    round: turnCount,
    executionMode: mode,
    executionModeLockRemaining: lockRemaining,
    harnessMode,
    riskLevel: "L1_minor_edit",
    state: runtimeState,
    signals: [],
  })

  if (modeDecision.action === "enter_forced") {
    mode = "forced"
    lockRemaining = modeDecision.lockRounds
    checkpointEngine?.setForcedPolicy(true)
    branchBudgetTracker?.setEnabled(true)
  } else if (modeDecision.action === "exit_forced") {
    mode = "free"
    checkpointEngine?.setForcedPolicy(false)
  }

  return {
    decision: modeDecision,
    currentExecutionMode: mode,
    executionModeLockRemaining: lockRemaining,
  }
}
