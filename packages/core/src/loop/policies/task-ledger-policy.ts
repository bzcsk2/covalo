import type { TaskLedgerTracker } from "../../task-ledger.js"
import type { VerificationGateState } from "../../governance/verification-gate.js"
import { maybeResetVerificationGateCounter } from "../../governance/verification-gate.js"
import type { LoopPolicy, LoopPolicyContext, ToolResultInfo } from "../policy.js"
import type { LoopEvent } from "../../interface.js"

export interface CreateTaskLedgerLoopPolicyInput {
  taskLedger?: TaskLedgerTracker
  refreshLedgerContext?: () => void
  verificationGateState?: VerificationGateState
  requireVerificationBeforeFinal?: boolean
}

export function createTaskLedgerLoopPolicy(input: CreateTaskLedgerLoopPolicyInput): LoopPolicy {
  const { taskLedger, refreshLedgerContext, verificationGateState, requireVerificationBeforeFinal } = input
  return {
    name: "task-ledger",
    afterToolResult(_ctx: LoopPolicyContext, event: LoopEvent, info: ToolResultInfo): void {
      if (event.role !== "tool" && event.role !== "error") return
      if (!event.toolName) return
      if (!info.parsedArgs) return
      if (!taskLedger) return
      const pendingBefore = taskLedger.verificationPending
      taskLedger.recordToolResult(event.toolName, info.parsedArgs, {
        isError: event.role === "error" || !!event.metadata?.error,
        content: event.content ?? "",
        metadata: event.metadata,
      })
      refreshLedgerContext?.()
      if (verificationGateState) {
        const blockingAfter = taskLedger.verificationPending && taskLedger.changedFiles.length > 0
        maybeResetVerificationGateCounter(
          verificationGateState,
          pendingBefore,
          taskLedger.verificationPending,
          blockingAfter && !!requireVerificationBeforeFinal,
        )
      }
    },
  }
}
