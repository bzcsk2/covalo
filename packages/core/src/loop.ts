import type { ToolCall, ToolSpec } from "./types.js"
import type { LoopEvent, SessionStats, ToolResult } from "./interface.js"
import type { DeepSeekClient } from "./client.js"
import { isToolUseFinishReason } from "./client.js"
import type { ContextManager } from "./context/manager.js"
import type { StreamingToolExecutor } from "./streaming-executor.js"
import type { AsyncSessionWriter } from "./session.js"
import type { FoldDecision } from "./context/token-estimator.js"
import { calculateCost } from "./pricing.js"

export interface LoopOptions {
  ctx: ContextManager
  client: DeepSeekClient
  toolExecutor: StreamingToolExecutor
  toolSpecs: ToolSpec[]
  config: {
    apiKey: string
    baseUrl: string
    model: string
    maxTokens: number
    temperature: number
  }
  signal: AbortSignal
  sessionWriter?: AsyncSessionWriter
  stats: SessionStats
  isInterrupted: () => boolean
  appendToolResult: (tc: ToolCall, result: ToolResult) => void
  maxTurns?: number
}

const DEFAULT_MAX_TURNS = 100

export async function* runLoop(opts: LoopOptions): AsyncGenerator<LoopEvent> {
  const { ctx, client, toolExecutor, toolSpecs, config, signal, sessionWriter, stats, isInterrupted, appendToolResult, maxTurns = DEFAULT_MAX_TURNS } = opts

  const contextWindow = ctx.getContextWindow()

  // fold check before first turn (non-blocking: kicks off async but uses sync fallback immediately)
  const foldP = ctx.getFoldDecision()
  const fold = await Promise.race([
    foldP,
    new Promise<FoldDecision>(resolve => setTimeout(() => {
      resolve({ action: "none" as const, ratio: 0, used: 0, total: contextWindow })
    }, 100)),
  ])
  if (fold.action === "force") {
    yield { role: "status", content: "Context budget exceeded — forcing fold on next turn", severity: "warning" as const, metadata: { fold } }
  } else if (fold.action !== "none") {
    yield { role: "status", content: `Context at ${(fold.ratio * 100).toFixed(0)}% — fold recommended`, metadata: { fold } }
  }

  let turnCount = 0
  let consecutiveErrors = 0
  const recentToolCalls = new Map<string, number>()

  while (turnCount < maxTurns) {
    turnCount++
    if (isInterrupted()) {
      yield { role: "status", content: "interrupted" }
      return
    }

    let fullContent = ""
    let fullReasoning = ""
    const toolCalls: ToolCall[] = []
    let streamError: LoopEvent | null = null
    let finishedWithToolUse = false

    for await (const event of client.chatCompletionsStream(ctx.buildMessages(), {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal,
      tools: toolSpecs.length > 0 ? toolSpecs : undefined,
    })) {
      if (isInterrupted()) {
        yield { role: "status", content: "interrupted" }
        return
      }

      switch (event.type) {
        case "text_delta":
          fullContent += event.delta
          yield { role: "assistant_delta", content: event.delta }
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "assistant_delta", content: event.delta } })
          break

        case "reasoning_delta":
          fullReasoning += event.delta
          yield { role: "reasoning_delta", content: event.delta }
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "reasoning_delta", content: event.delta } })
          break

        case "tool_call_end": {
          const tc: ToolCall = {
            id: event.id,
            type: "function",
            function: { name: event.name, arguments: event.arguments },
          }
          toolCalls.push(tc)
          yield { role: "tool_call_delta", toolName: event.name, toolCallIndex: event.toolCallIndex, content: event.arguments }
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "tool_call_delta", toolName: event.name, toolCallIndex: event.toolCallIndex, content: event.arguments } })
          break
        }

        case "usage":
          stats.promptTokens += event.usage.promptTokens
          stats.completionTokens += event.usage.completionTokens
          stats.cacheHitTokens += event.usage.cacheHitTokens ?? 0
          stats.cacheMissTokens += event.usage.cacheMissTokens ?? 0
          stats.totalCost = calculateCost(config.model, stats.promptTokens, stats.completionTokens, stats.cacheHitTokens, stats.cacheMissTokens)
          yield { role: "usage", metadata: { input: event.usage.promptTokens, output: event.usage.completionTokens, cacheHit: event.usage.cacheHitTokens ?? 0, cacheMiss: event.usage.cacheMissTokens ?? 0 } as Record<string, unknown> }
          sessionWriter?.enqueue({ ts: Date.now(), type: "stats", payload: { ...stats } })
          break

        case "done": {
          stats.apiCalls++  // 每轮只计数一次，避免 usage 重复事件导致偏高
          const reason = event.finishReason ?? "stop"
          const isToolUse = isToolUseFinishReason(reason)

          yield { role: "assistant_final", content: fullContent, metadata: { reasoning: fullReasoning || undefined } }

          if (isToolUse) {
            if (toolCalls.length === 0) {
              yield { role: "warning", content: "API returned tool_calls finish_reason but no tool calls found", severity: "warning" as const }
              break
            }
            // duplicate tool call detection: reject if same tool+args called 3+ times
            for (const tc of toolCalls) {
              const key = `${tc.function.name}:${tc.function.arguments}`
              const count = (recentToolCalls.get(key) ?? 0) + 1
              recentToolCalls.set(key, count)
              if (count >= 3) {
                yield { role: "warning", content: `Tool call loop detected: ${tc.function.name} called ${count} times with identical arguments`, severity: "warning" as const }
              }
            }

            finishedWithToolUse = true
            ctx.log.append({ role: "assistant", content: fullContent || null, tool_calls: toolCalls })
            sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })

            try {
              for await (const toolEvent of toolExecutor.run(toolCalls, signal, appendToolResult)) {
                yield toolEvent
                sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: toolEvent })
              }
              // persist messages with tool results for crash recovery
              sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            } catch {
              // append error results for all tool calls if execution is interrupted
              for (const tc of toolCalls) {
                appendToolResult(tc, { content: JSON.stringify({ error: "tool execution interrupted" }), isError: true })
              }
            }
            yield { role: "status", content: "tools_completed" }
            sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "status", content: "tools_completed" } })
          } else if (finishedWithToolUse) {
            // defensive: second done after tool use
          } else {
            ctx.log.append({ role: "assistant", content: fullContent })
            yield { role: "done", metadata: { reason } as Record<string, unknown> }
            sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "done", metadata: { reason } } })
            return
          }
          break
        }

        case "error":
          streamError = { role: "error", content: event.message, severity: "error" as const, metadata: event.status ? { status: event.status } : undefined }
          yield streamError
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: streamError })
          break
      }
    }

    if (streamError) {
      if (isInterrupted()) {
        yield { role: "status", content: "interrupted" }
        return
      }
      if (fullContent) {
        ctx.log.append({ role: "assistant", content: fullContent })
      }
      consecutiveErrors++
      if (consecutiveErrors >= 3) {
        yield { role: "error", content: `Stream failed after ${consecutiveErrors} consecutive attempts`, severity: "error" as const }
        return
      }
      continue
    }
    consecutiveErrors = 0
  }

  yield { role: "warning", content: `Reached maximum tool loop count (${maxTurns}).`, severity: "warning" as const }
  yield { role: "done", metadata: { reason: "maxTurns" } }
}
