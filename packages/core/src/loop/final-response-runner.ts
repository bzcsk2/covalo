import type { LoopEvent } from "../interface.js"
import type { ContextManager } from "../context/manager.js"
import type { AsyncSessionWriter } from "../session.js"
import type { TaskLedgerTracker } from "../task-ledger.js"
import type { VerificationGateState } from "../governance/verification-gate.js"
import {
  runPolicyHook,
  runPolicyHookEvents,
  type LoopPolicy,
  type LoopPolicyContext,
  type LoopPolicyEventEmission,
} from "./policy.js"
import { runVerificationGate } from "./policies/verification-gate-policy.js"

export interface RunFinalResponseInput {
  content: string
  finishReason: string
  totalToolCalls: number
  ctx: ContextManager
  sessionWriter?: AsyncSessionWriter
  policies: LoopPolicy[]
  policyCtx: LoopPolicyContext
  appendPendingInstruction: () => LoopEvent | null
  taskLedger?: TaskLedgerTracker
  requireVerificationBeforeFinal: boolean
  verificationMode?: "block" | "require-or-waive" | "warn"
  verificationGateState?: VerificationGateState
}

export interface FinalResponseResult {
  done: boolean
}

export async function* runFinalResponse(input: RunFinalResponseInput): AsyncGenerator<LoopEvent, FinalResponseResult> {
  const {
    content,
    finishReason,
    totalToolCalls,
    ctx,
    sessionWriter,
    policies,
    policyCtx,
    appendPendingInstruction,
    taskLedger,
    requireVerificationBeforeFinal,
    verificationMode,
    verificationGateState,
  } = input

  yield* emitPolicyEvents(await runPolicyHookEvents(
    policies,
    "beforeAssistantFinal",
    policyCtx,
    { content, totalToolCalls, finishReason },
  ), sessionWriter)

  ctx.log.append({ role: "assistant", content })

  const injectedBeforeDone = appendPendingInstruction()
  if (injectedBeforeDone) {
    yield injectedBeforeDone
    return { done: false }
  }

  await runPolicyHook(policies, "beforeFinal", policyCtx)
  const gated = yield* runVerificationGate({
    taskLedger,
    requireVerificationBeforeFinal,
    verificationMode,
    verificationGateState,
    ctx,
    sessionWriter,
  })
  if (gated) {
    return { done: false }
  }

  await runPolicyHook(policies, "beforeFinalDraft", policyCtx)
  sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
  return { done: true }
}

function* emitPolicyEvents(
  emissions: LoopPolicyEventEmission[],
  sessionWriter?: AsyncSessionWriter,
): Generator<LoopEvent> {
  for (const emission of emissions) {
    yield emission.event
  }
  for (const emission of emissions) {
    if (emission.persist === false) continue
    sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: emission.sessionEvent ?? emission.event })
  }
}
