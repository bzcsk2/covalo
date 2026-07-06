import { BranchBudgetTracker } from "../governance/branch-budget.js"
import { ModeDecisionEngine } from "../governance/mode-decision.js"
import { TaskLedgerTracker } from "../task-ledger.js"
import type { VerificationGateState } from "../governance/verification-gate.js"
import type { HarnessStrictness, EffectiveHarnessPolicy } from "../harness/index.js"

export class EngineGovernanceRuntime {
  sessionStrictness?: HarnessStrictness
  effectivePolicy: EffectiveHarnessPolicy | null = null
  branchBudgetTracker = new BranchBudgetTracker()
  modeDecisionEngine = new ModeDecisionEngine()
  verificationGateState: VerificationGateState = { continuationCount: 0 }

  setHarnessStrictness(strictness: HarnessStrictness): void {
    this.sessionStrictness = strictness
  }

  getHarnessStrictness(): HarnessStrictness {
    return this.effectivePolicy?.strictness ?? this.sessionStrictness ?? "normal"
  }

  getEffectivePolicy(): EffectiveHarnessPolicy | null {
    return this.effectivePolicy
  }

  resetForLoadSession(): void {
    this.sessionStrictness = undefined
    this.effectivePolicy = null
    this.branchBudgetTracker.reset()
    this.modeDecisionEngine.resetSubmittedSignals()
    this.verificationGateState = { continuationCount: 0 }
  }

}
