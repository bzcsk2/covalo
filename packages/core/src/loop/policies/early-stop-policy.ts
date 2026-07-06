import type { AsyncSessionWriter } from "../../session.js"
import type { ContextManager } from "../../context/manager.js"
import type { LoopEvent } from "../../interface.js"
import type { EarlyStopDetector, StopSignal } from "../../early-stop.js"
import type { SupervisorGuidanceConfig } from "../../supervisor/guided-loop.js"
import type { LoopPolicy, LoopPolicyContext, ModelEventInfo, LoopPolicyEventEmission } from "../policy.js"

export function buildEarlyStopSignalEvents(
  signal: StopSignal,
  ctx: ContextManager,
  sessionWriter?: AsyncSessionWriter,
  supervisorState?: SupervisorGuidanceConfig["state"],
): LoopEvent[] {
  if (supervisorState) {
    supervisorState.lastStopSignalReason = signal.reason
  }
  const evt: LoopEvent = {
    role: "status",
    content: "early_stop",
    severity: "warning",
    metadata: { reason: signal.reason, message: signal.message, action: signal.action },
  }
  const signalKind = signal.reason === "repetition" ? "no-progress"
    : signal.reason === "read-loop" ? "no-progress"
    : signal.reason === "patch-spiral" ? "repeated-error"
    : "verification-failed"
  const orchEvent: LoopEvent = {
    role: "orchestration",
    orchestration: {
      kind: "runtime_signal",
      signal: { kind: signalKind, message: signal.message },
    },
  }
  ctx.log.append({ role: "user", content: signal.injection })
  sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
  return [evt, orchEvent]
}

export function* emitEarlyStopSignal(
  signal: StopSignal,
  ctx: ContextManager,
  sessionWriter?: AsyncSessionWriter,
  supervisorState?: SupervisorGuidanceConfig["state"],
): Generator<LoopEvent> {
  const [evt, orchEvent] = buildEarlyStopSignalEvents(signal, ctx, sessionWriter, supervisorState)
  yield evt
  yield orchEvent
  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })
  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: orchEvent })
}

export interface CreateEarlyStopRepetitionLoopPolicyInput {
  earlyStop?: EarlyStopDetector
  sessionWriter?: AsyncSessionWriter
  supervisorState?: SupervisorGuidanceConfig["state"]
}

function isTextDeltaEvent(event: unknown): event is { type: "text_delta" } {
  return typeof event === "object"
    && event !== null
    && "type" in event
    && (event as { type?: unknown }).type === "text_delta"
}

export function createEarlyStopRepetitionLoopPolicy(input: CreateEarlyStopRepetitionLoopPolicyInput): LoopPolicy {
  const { earlyStop, sessionWriter, supervisorState } = input
  return {
    name: "early-stop-repetition",
    afterModelEvent(ctx: LoopPolicyContext, event: unknown, info: ModelEventInfo): LoopPolicyEventEmission[] | void {
      if (!earlyStop) return
      if (!isTextDeltaEvent(event)) return
      const signal = earlyStop.checkRepetition(info.fullContent)
      if (!signal) return
      const events = buildEarlyStopSignalEvents(signal, ctx.ctx, sessionWriter, supervisorState)
      return events.map(event => ({ event, sessionEvent: event }))
    },
  }
}
