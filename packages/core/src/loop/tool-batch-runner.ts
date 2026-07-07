import type { ToolCall } from "../types.js"
import type { LoopEvent, ToolResult } from "../interface.js"
import type { StreamingToolExecutor } from "../streaming-executor.js"
import type { ContextManager } from "../context/manager.js"
import type { AsyncSessionWriter } from "../session.js"
import type { RuntimeLogger } from "../runtime-logger.js"
import { parseToolCallArgs } from "../executor-helpers.js"
import {
  runPolicyHook,
  runPolicyHookEvents,
  runPolicyToolBatchHooks,
  type LoopPolicy,
  type LoopPolicyContext,
  type LoopPolicyEventEmission,
  type ToolBatchSource,
} from "./policy.js"

export interface RunToolBatchInput {
  source: ToolBatchSource
  toolCalls: ToolCall[]
  toolExecutor: StreamingToolExecutor
  signal: AbortSignal
  appendToolResult: (tc: ToolCall, result: ToolResult) => void
  diagnosticsEnabled: boolean
  submitId?: string
  turnCount: number
  effectiveAllowedToolNames?: ReadonlySet<string>
  maxParallelTools?: number
  ctx: ContextManager
  sessionWriter?: AsyncSessionWriter
  policies: LoopPolicy[]
  policyCtx: LoopPolicyContext
  logger: RuntimeLogger
  errorLogName: string
}

export interface ToolBatchRunResult {
  intercepted: boolean
  done?: {
    reason: string
    metadata?: Record<string, unknown>
  }
}

export async function* runToolBatch(input: RunToolBatchInput): AsyncGenerator<LoopEvent, ToolBatchRunResult> {
  const {
    source,
    toolCalls,
    toolExecutor,
    signal,
    appendToolResult,
    diagnosticsEnabled,
    submitId,
    turnCount,
    effectiveAllowedToolNames,
    maxParallelTools,
    ctx,
    sessionWriter,
    policies,
    policyCtx,
    logger,
    errorLogName,
  } = input

  const toolBatchPolicy = await runPolicyToolBatchHooks(policies, policyCtx, toolCalls, { source })
  yield* emitPolicyEvents(toolBatchPolicy.events, sessionWriter)
  if (toolBatchPolicy.interception) {
    if (toolBatchPolicy.interception.persistMessages !== false) {
      sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
    }
    return {
      intercepted: true,
      done: toolBatchPolicy.interception.done,
    }
  }

  try {
    for await (const toolEvent of toolExecutor.run(
      toolCalls,
      signal,
      appendToolResult,
      diagnosticsEnabled ? { submitId, turnCount } : undefined,
      effectiveAllowedToolNames,
      maxParallelTools,
    )) {
      yield toolEvent
      if (toolEvent.role !== "tool_progress") {
        sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: toolEvent })
      }
      const matchedTc = (toolEvent.role === "tool" || toolEvent.role === "error") && toolEvent.toolName
        ? findToolCallByIdOrName(toolCalls, toolEvent.toolCallId, toolEvent.toolName, toolEvent.toolCallIndex) ?? undefined
        : undefined
      const parsedArgs = matchedTc ? parseToolCallArgs(matchedTc.function.arguments, matchedTc.function.name) : undefined
      const policyEvents = await runPolicyHookEvents(policies, "afterToolResult", policyCtx, toolEvent, {
        source,
        toolCalls,
        toolCall: matchedTc,
        parsedArgs: parsedArgs?.ok ? parsedArgs.args : undefined,
      })
      yield* emitPolicyEvents(policyEvents, sessionWriter)
    }
    sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
  } catch (err) {
    logger.warn(errorLogName, {
      error: err instanceof Error ? err.message : String(err),
      turnCount,
    })
  }

  yield { role: "status", content: "tools_completed" }
  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "status", content: "tools_completed" } })
  await runPolicyHook(policies, "afterToolBatch", policyCtx, toolCalls, { source })
  return { intercepted: false }
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

/** Find tool call by id (preferred), then index, then name (fallback). */
function findToolCallByIdOrName(
  toolCalls: ToolCall[],
  toolCallId?: string,
  toolName?: string,
  toolCallIndex?: number,
): ToolCall | undefined {
  if (toolCallId) {
    const byId = toolCalls.find(t => t.id === toolCallId)
    if (byId) return byId
  }
  if (toolCallIndex !== undefined && toolCallIndex >= 0 && toolCallIndex < toolCalls.length) {
    return toolCalls[toolCallIndex]
  }
  if (toolName) {
    return toolCalls.find(t => t.function.name === toolName)
  }
  return undefined
}
