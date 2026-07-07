import type { DuplicateDetector } from "../../loop-helpers.js"
import type { LoopEvent, ToolResult } from "../../interface.js"
import type { ToolCall } from "../../types.js"
import type { LoopPolicy, LoopPolicyEventEmission, ToolBatchInfo, ToolBatchInterception } from "../policy.js"

export interface CreateToolCallLoopPolicyInput {
  recentToolCalls: DuplicateDetector
  appendToolResult: (tc: ToolCall, result: ToolResult) => void
}

export function createToolCallLoopPolicy(input: CreateToolCallLoopPolicyInput): LoopPolicy {
  const { recentToolCalls, appendToolResult } = input
  return {
    name: "tool-call-loop",
    beforeToolBatch(_ctx, toolCalls: readonly ToolCall[], info: ToolBatchInfo): ToolBatchInterception | readonly LoopPolicyEventEmission[] | void {
      if (info.source !== "native") return

      const events: LoopEvent[] = []
      let blockedToolCall: { name: string; count: number } | null = null
      for (const tc of toolCalls) {
        const { warning, blocked, count } = recentToolCalls.check(tc)
        if (warning) {
          events.push({ role: "warning", content: warning, severity: "warning" as const })
        }
        if (blocked && !blockedToolCall) {
          blockedToolCall = { name: tc.function.name, count }
        }
      }

      if (!blockedToolCall) return events.map(event => ({ event, persist: false }))

      const content = `Stopped repeated tool-call loop: ${blockedToolCall.name} was requested ${blockedToolCall.count} times with identical arguments.`
      for (const tc of toolCalls) {
        appendToolResult(tc, { content, isError: true, metadata: { reason: "toolCallLoop" } })
      }
      events.push({
        role: "error",
        content,
        severity: "error" as const,
        metadata: { reason: "toolCallLoop", toolName: blockedToolCall.name, count: blockedToolCall.count },
      })

      return {
        handled: true,
        events: events.map(event => ({ event, persist: false })),
        done: {
          reason: "toolCallLoop",
          metadata: { toolName: blockedToolCall.name, count: blockedToolCall.count },
        },
      }
    },
  }
}
