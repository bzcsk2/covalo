import type { LoopEvent, ToolResult } from "../interface.js"
import type { ToolCall } from "../types.js"
import type { StreamingToolExecutor } from "../streaming-executor.js"
import type { ContextManager } from "../context/manager.js"
import type { AsyncSessionWriter } from "../session.js"
import type { RuntimeLogger } from "../runtime-logger.js"
import type { EffectiveHarnessPolicy } from "../harness/index.js"
import type { LoopPolicy, LoopPolicyContext } from "./policy.js"
import { salvageTextToolCallsInResponse } from "../tool-calls/text-salvage.js"
import { runToolBatch } from "./tool-batch-runner.js"

export interface RunTextToolSalvageInput {
  fullContent: string
  fullReasoning: string
  finishReason: string
  nativeToolCalls: ToolCall[]
  effectivePolicy?: EffectiveHarnessPolicy
  toolExecutor: StreamingToolExecutor
  signal: AbortSignal
  appendToolResult: (tc: ToolCall, result: ToolResult) => void
  diagnosticsEnabled: boolean
  submitId?: string
  turnCount: number
  effectiveAllowedToolNames?: ReadonlySet<string>
  ctx: ContextManager
  sessionWriter?: AsyncSessionWriter
  policies: LoopPolicy[]
  policyCtx: LoopPolicyContext
  logger: RuntimeLogger
}

export interface TextToolSalvageResult {
  handled: boolean
  toolCallCount: number
  done?: {
    reason: string
    metadata?: Record<string, unknown>
  }
}

export async function* runTextToolSalvage(input: RunTextToolSalvageInput): AsyncGenerator<LoopEvent, TextToolSalvageResult> {
  const {
    fullContent,
    fullReasoning,
    finishReason,
    nativeToolCalls,
    effectivePolicy,
    toolExecutor,
    signal,
    appendToolResult,
    diagnosticsEnabled,
    submitId,
    turnCount,
    effectiveAllowedToolNames,
    ctx,
    sessionWriter,
    policies,
    policyCtx,
    logger,
  } = input

  const salvageMode = effectivePolicy?.textToolSalvage ?? "on-native-failure"
  const allowTextToolSalvage = salvageMode === "always" || salvageMode === "on-native-failure"
  if (!allowTextToolSalvage || finishReason !== "stop" || nativeToolCalls.length > 0 || !fullContent.trim()) {
    return { handled: false, toolCallCount: 0 }
  }

  const salvaged = salvageTextToolCallsInResponse({
    content: fullContent,
    finishReason,
    toolCalls: [],
  })
  if (!salvaged.toolCalls?.length) {
    return { handled: false, toolCallCount: 0 }
  }

  const salvagedCalls = salvaged.toolCalls
  const cleanContent = salvaged.content || ""
  ctx.log.append({
    role: "assistant",
    content: cleanContent || null,
    reasoning_content: fullReasoning || undefined,
    tool_calls: salvagedCalls,
  })
  sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })

  const batchResult = yield* runToolBatch({
    source: "salvage",
    toolCalls: salvagedCalls,
    toolExecutor,
    signal,
    appendToolResult,
    diagnosticsEnabled,
    submitId,
    turnCount,
    effectiveAllowedToolNames,
    maxParallelTools: effectivePolicy?.maxParallelTools,
    ctx,
    sessionWriter,
    policies,
    policyCtx,
    logger,
    errorLogName: "loop.tool_batch_error_secondary",
  })

  return {
    handled: true,
    toolCallCount: salvagedCalls.length,
    done: batchResult.done,
  }
}
