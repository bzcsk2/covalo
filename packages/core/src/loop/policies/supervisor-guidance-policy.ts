import type { ContextManager } from "../../context/manager.js"
import type { AsyncSessionWriter } from "../../session.js"
import type { LoopEvent } from "../../interface.js"
import type { TaskLedgerTracker } from "../../task-ledger.js"
import type { SupervisorGuidanceConfig } from "../../supervisor/guided-loop.js"
import type { SupervisorTriggerContext } from "../../supervisor/types.js"
import {
  buildSupervisorTriggerContext,
  runSupervisorGuidanceAtSafePoint,
} from "../../supervisor/guided-loop.js"

export interface RunSupervisorGuidanceSafePointInput {
  supervisorGuidance?: SupervisorGuidanceConfig
  taskLedger?: TaskLedgerTracker
  buildSupervisorExtras?: () => Partial<SupervisorTriggerContext>
  ctx: ContextManager
  sessionWriter?: AsyncSessionWriter
}

export async function* runSupervisorGuidanceSafePoint(
  input: RunSupervisorGuidanceSafePointInput,
): AsyncGenerator<LoopEvent, boolean> {
  const { supervisorGuidance, taskLedger, buildSupervisorExtras, ctx, sessionWriter } = input
  if (!supervisorGuidance || !taskLedger) return false

  const extras = buildSupervisorExtras?.() ?? {}
  const triggerCtx = buildSupervisorTriggerContext(supervisorGuidance.state, {
    supervisorConfigured: supervisorGuidance.supervisorConfigured ?? true,
    ...extras,
  })

  const outcome = await runSupervisorGuidanceAtSafePoint(
    supervisorGuidance,
    triggerCtx,
    taskLedger.snapshot(),
    ctx,
  )

  if (!outcome.statusContent) return false

  if (outcome.injected && outcome.result?.candidateId) {
    yield {
      role: "orchestration",
      orchestration: {
        kind: "supervisor_upsert",
        supervisor: {
          id: outcome.result.candidateId,
          modelTarget: outcome.result.candidateId,
          status: "idle",
        },
      },
    }
    if (outcome.result.advice) {
      yield {
        role: "orchestration",
        orchestration: {
          kind: "supervisor_advice",
          supervisorId: outcome.result.candidateId,
          workerId: "main",
          advice: outcome.result.advice.diagnosis,
          adopted: true,
        },
      }
    }
  } else if (!outcome.injected) {
    yield {
      role: "orchestration",
      orchestration: {
        kind: "supervisor_upsert",
        supervisor: {
          id: "supervisor",
          modelTarget: "supervisor",
          status: "unavailable",
        },
      },
    }
  }

  const evt: LoopEvent = {
    role: "status",
    content: outcome.statusContent,
    severity: outcome.injected ? "info" : "warning",
    metadata: outcome.statusMetadata,
  }
  yield evt
  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })

  if (outcome.injected) {
    sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
    return true
  }

  if (outcome.degradedMessage) {
    const degradeEvt: LoopEvent = {
      role: "status",
      content: outcome.degradedMessage,
      severity: "warning",
      metadata: { supervisorDegraded: true },
    }
    yield degradeEvt
    sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: degradeEvt })
  }
  return false
}
