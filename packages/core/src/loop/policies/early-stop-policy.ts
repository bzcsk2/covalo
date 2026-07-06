import type { AsyncSessionWriter } from "../../session.js"
import type { ContextManager } from "../../context/manager.js"
import type { LoopEvent } from "../../interface.js"
import type { StopSignal } from "../../early-stop.js"
import type { SupervisorGuidanceConfig } from "../../supervisor/guided-loop.js"

export function* emitEarlyStopSignal(
  signal: StopSignal,
  ctx: ContextManager,
  sessionWriter?: AsyncSessionWriter,
  supervisorState?: SupervisorGuidanceConfig["state"],
): Generator<LoopEvent> {
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
  yield evt
  yield orchEvent
  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })
  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: orchEvent })
}
