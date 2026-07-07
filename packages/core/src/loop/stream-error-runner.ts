import type { LoopEvent, ToolResult } from "../interface.js"
import type { ToolCall } from "../types.js"
import type { ContextManager } from "../context/manager.js"
import type { AsyncSessionWriter } from "../session.js"
import type { RuntimeLogger } from "../runtime-logger.js"
import { runPolicyHook, type LoopPolicy, type LoopPolicyContext } from "./policy.js"

export type StreamErrorRecoveryAction = "interrupted" | "retry" | "error_limit"

export interface RecoverStreamErrorInput {
  streamError: LoopEvent
  toolCalls: ToolCall[]
  fullContent: string
  consecutiveErrors: number
  turnCount: number
  diagnosticsEnabled: boolean
  isInterrupted: () => boolean
  appendToolResult: (tc: ToolCall, result: ToolResult) => void
  ctx: ContextManager
  sessionWriter?: AsyncSessionWriter
  policies: LoopPolicy[]
  policyCtx: LoopPolicyContext
  logger: RuntimeLogger
}

export interface StreamErrorRecoveryResult {
  action: StreamErrorRecoveryAction
  consecutiveErrors: number
}

export async function* recoverFromStreamError(input: RecoverStreamErrorInput): AsyncGenerator<LoopEvent, StreamErrorRecoveryResult> {
  const {
    streamError,
    toolCalls,
    fullContent,
    consecutiveErrors,
    turnCount,
    diagnosticsEnabled,
    isInterrupted,
    appendToolResult,
    ctx,
    sessionWriter,
    policies,
    policyCtx,
    logger,
  } = input

  if (isInterrupted()) {
    yield { role: "status", content: "interrupted" }
    return { action: "interrupted", consecutiveErrors }
  }

  await runPolicyHook(policies, "afterStreamError", policyCtx, streamError)
  if (toolCalls.length > 0) {
    ctx.log.append({ role: "assistant", content: fullContent || null, tool_calls: toolCalls })
    for (const tc of toolCalls) {
      appendToolResult(tc, {
        content: "Stream error: tool call result not available",
        isError: true,
        metadata: { error: "stream_error" },
      })
    }
    sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
  } else if (fullContent) {
    ctx.log.append({ role: "assistant", content: fullContent })
  }

  const nextConsecutiveErrors = consecutiveErrors + 1
  if (diagnosticsEnabled) logger.warn("loop.stream.retry", { consecutiveErrors: nextConsecutiveErrors, turnCount })
  if (nextConsecutiveErrors >= 3) {
    yield { role: "error", content: `Stream failed after ${nextConsecutiveErrors} consecutive attempts`, severity: "error" as const }
    return { action: "error_limit", consecutiveErrors: nextConsecutiveErrors }
  }

  return { action: "retry", consecutiveErrors: nextConsecutiveErrors }
}
