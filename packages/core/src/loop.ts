/**
 * Loop module — public API surface.
 *
 * Types and interfaces are defined here; the core loop implementation
 * lives in loop/core-loop.ts, and the policy pipeline in loop/policy.ts.
 */

import type { ToolCall, ToolSpec } from "./types.js"
import type { LoopEvent, SessionStats, ToolResult, ChatClient } from "./interface.js"
import type { ContextManager } from "./context/manager.js"
import type { StreamingToolExecutor } from "./streaming-executor.js"
import type { AsyncSessionWriter } from "./session.js"
import type { ThinkingMode } from "./provider-thinking.js"
import type { RuntimeLogger } from "./runtime-logger.js"
import type { EarlyStopDetector } from "./early-stop.js"
import type { TaskLedgerTracker } from "./task-ledger.js"
import type { VerificationGateState } from "./governance/verification-gate.js"
import type { SupervisorGuidanceConfig } from "./supervisor/guided-loop.js"
import type { SupervisorTriggerContext } from "./supervisor/types.js"
import type { EffectiveHarnessPolicy } from "./harness/index.js"
import type { BranchBudgetTracker } from "./governance/branch-budget.js"
import type { CheckpointEngine } from "./checkpoint/checkpoint-engine.js"
import type { ModeDecisionEngine } from "./governance/mode-decision.js"
import type { AgentRole } from "./agent-profile/types.js"
import { runCoreLoop } from "./loop/core-loop.js"
import { createPoliciesFromLoopOptions } from "./loop/policy.js"
import { createCheckpointLoopPolicy } from "./loop/policies/checkpoint-policy.js"

export interface PendingInstruction {
  content: string
  remaining: number
}

export interface LoopOptions {
  ctx: ContextManager
  client: ChatClient
  toolExecutor: StreamingToolExecutor
  toolSpecs: ToolSpec[]
  config: {
    apiKey: string
    baseUrl: string
    model: string
    maxTokens: number
    temperature: number
    provider?: string
  }
  signal: AbortSignal
  sessionWriter?: AsyncSessionWriter
  stats: SessionStats
  isInterrupted: () => boolean
  appendToolResult: (tc: ToolCall, result: ToolResult) => void
  takePendingInstruction?: () => PendingInstruction | null
  maxTurns?: number
  thinkingMode?: ThinkingMode
  logger?: RuntimeLogger
  submitId?: string
  effectivePolicy?: EffectiveHarnessPolicy
  earlyStop?: EarlyStopDetector
  taskLedger?: TaskLedgerTracker
  requireVerificationBeforeFinal?: boolean
  verificationGateState?: VerificationGateState
  refreshLedgerContext?: () => void
  supervisorGuidance?: SupervisorGuidanceConfig
  buildSupervisorExtras?: () => Partial<SupervisorTriggerContext>
  toolRouting?: "two-stage" | "auto" | "direct"
  verificationPolicy?: "block" | "require-or-waive" | "warn"
  allowedToolNames?: ReadonlySet<string>
  customToolNames?: Set<string>
  branchBudgetTracker?: BranchBudgetTracker
  checkpointEngine?: CheckpointEngine
  modeDecisionEngine?: ModeDecisionEngine
  workspaceRoot?: string
  role?: AgentRole
}

export async function* runLoop(opts: LoopOptions): AsyncGenerator<LoopEvent> {
  const policies = [
    ...createPoliciesFromLoopOptions(opts),
    createCheckpointLoopPolicy({
      checkpointEngine: opts.checkpointEngine,
      branchBudget: opts.branchBudgetTracker,
      taskLedger: opts.taskLedger,
      verificationGateState: opts.verificationGateState,
      logger: opts.logger,
    }),
  ]
  return yield* runCoreLoop({ ...opts, policies })
}
