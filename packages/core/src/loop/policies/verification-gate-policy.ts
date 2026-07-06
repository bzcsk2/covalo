import type { ContextManager } from "../../context/manager.js"
import type { AsyncSessionWriter } from "../../session.js"
import type { TaskLedgerTracker } from "../../task-ledger.js"
import type { LoopEvent } from "../../interface.js"
import {
  evaluateVerificationGate,
  type VerificationGateState,
} from "../../governance/verification-gate.js"

export interface RunVerificationGateInput {
  taskLedger?: TaskLedgerTracker
  requireVerificationBeforeFinal: boolean
  verificationMode?: "block" | "require-or-waive" | "warn"
  verificationGateState?: VerificationGateState
  ctx: ContextManager
  sessionWriter?: AsyncSessionWriter
}

export function* runVerificationGate(input: RunVerificationGateInput): Generator<LoopEvent, boolean> {
  const { taskLedger, requireVerificationBeforeFinal, verificationMode, verificationGateState, ctx, sessionWriter } = input

  if (!taskLedger) return false
  if (!requireVerificationBeforeFinal && verificationMode !== "warn") return false

  const gateState = verificationGateState ?? { continuationCount: 0 }
  const decision = evaluateVerificationGate(
    taskLedger.snapshot(),
    requireVerificationBeforeFinal,
    gateState,
  )
  if (!decision.blocking) return false

  const mode = verificationMode ?? "block"

  if (mode === "warn") {
    const warnEvt: LoopEvent = {
      role: "status",
      content: "verification_gate_warning",
      severity: "warning",
      metadata: {
        verificationPending: taskLedger.verificationPending,
        changedFiles: taskLedger.changedFiles.length,
        message: "Verification pending but not blocking (loose mode)",
      },
    }
    yield warnEvt
    sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: warnEvt })
    return false
  }

  if (mode === "require-or-waive") {
    gateState.continuationCount++
    const isFirstWaive = gateState.continuationCount <= 2
    const evt: LoopEvent = {
      role: "status",
      content: isFirstWaive ? "verification_gate_waivable" : "verification_gate",
      severity: "warning",
      metadata: {
        verificationPending: taskLedger.verificationPending,
        changedFiles: taskLedger.changedFiles.length,
        continuationCount: gateState.continuationCount,
        verificationMode: mode,
        waivable: isFirstWaive,
        message: isFirstWaive
          ? "Verification recommended — continue to waive verification"
          : `Verification required after ${gateState.continuationCount} continuations`,
      },
    }
    yield evt
    sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })
    if (isFirstWaive) {
      ctx.log.append({ role: "user", content: decision.prompt })
      sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
    }
    return true
  }

  gateState.continuationCount++
  ctx.log.append({ role: "user", content: decision.prompt })
  sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })

  const evt: LoopEvent = {
    role: "status",
    content: "verification_gate",
    severity: "warning",
    metadata: {
      verificationPending: taskLedger.verificationPending,
      changedFiles: taskLedger.changedFiles.length,
      continuationCount: gateState.continuationCount,
      requiresUser: decision.requiresUser,
      verificationMode: mode,
    },
  }
  yield evt
  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })
  return true
}
