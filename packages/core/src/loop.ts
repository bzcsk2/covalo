import type { ToolCall, ToolSpec } from "./types.js"
import type { LoopEvent, SessionStats, ToolResult, ChatClient } from "./interface.js"
import { isToolUseFinishReason } from "./client.js"
import type { ContextManager } from "./context/manager.js"
import type { StreamingToolExecutor } from "./streaming-executor.js"
import type { AsyncSessionWriter } from "./session.js"
import type { FoldDecision } from "./context/token-estimator.js"
import type { ModeSelectorState } from "./mode-selector.js"
import type { ThinkingMode } from "./provider-thinking.js"
import { createDeepSeekCapabilities } from "./provider-thinking.js"
import type { StrategyTier } from "./strategy/tiers.js"
import type { ModeStats } from "./mode-stats.js"
import { logModeSwitch } from "./mode-stats.js"
import { calculateCost } from "./pricing.js"
import { recommendTier } from "./strategy/recommender.js"
import { noopRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js"
import {
  normalizeToolCallId, resetToolCallSeq,
  createDuplicateDetector,
  evaluateModeSwitchForTurn,
  injectPendingInstruction,
} from "./loop-helpers.js"

export interface PendingInstruction {
  content: string
  remaining: number
}

export interface LoopOptions {
  ctx: ContextManager
  client: ChatClient
  toolExecutor: StreamingToolExecutor
  toolSpecs: ToolSpec[]
  config: {
    apiKey: string
    baseUrl: string
    model: string
    maxTokens: number
    temperature: number
    provider?: string
  }
  signal: AbortSignal
  sessionWriter?: AsyncSessionWriter
  stats: SessionStats
  isInterrupted: () => boolean
  appendToolResult: (tc: ToolCall, result: ToolResult) => void
  takePendingInstruction?: () => PendingInstruction | null
  maxTurns?: number
  thinkingMode?: ThinkingMode
  modeSelectorState?: ModeSelectorState
  modeStats?: ModeStats
  logger?: RuntimeLogger
  submitId?: string
  tier?: StrategyTier
}

const DEFAULT_MAX_TURNS = 100

export async function* runLoop(opts: LoopOptions): AsyncGenerator<LoopEvent> {
  const { ctx, client, toolExecutor, toolSpecs, config, signal, sessionWriter, stats, isInterrupted, appendToolResult, takePendingInstruction, maxTurns: maxTurnsOverride, thinkingMode: thinkingModeOverride = "off", modeSelectorState, modeStats, logger = noopRuntimeLogger, submitId, tier } = opts
  const diagnosticsEnabled = logger.isEnabled("error")

  // ST2: Derive maxTurns and thinkingMode from tier if not explicitly overridden
  const maxTurns = maxTurnsOverride ?? tier?.maxChainLength ?? DEFAULT_MAX_TURNS
  const thinkingMode = (thinkingModeOverride !== "off")
    ? thinkingModeOverride
    : (tier && !tier.enableReasoning ? "off" as const : thinkingModeOverride)

  // ST2: Apply tier overrides to config
  // IMPORTANT: model override is only safe for DeepSeek's native API.
  // Third-party providers (Zen, Mimo) have their own model inventories.
  if (tier) {
    if (tier.recommendedModel && (!config.provider || config.provider === "deepseek")) config.model = tier.recommendedModel
    if (tier.temperature !== null) config.temperature = tier.temperature
  }

  // CL-51: Safe-point helper — consume one pending instruction from the queue.
  const appendPendingInstruction = (): LoopEvent | null => {
    return injectPendingInstruction(takePendingInstruction, ctx, sessionWriter, turnCount)
  }

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
  const recentToolCalls = createDuplicateDetector()
  let currentMode: ThinkingMode = thinkingMode === "auto" ? "off" : thinkingMode
  let totalToolCalls = 0

  while (turnCount < maxTurns) {
    turnCount++
    if (diagnosticsEnabled) logger.debug("loop.turn.start", { turnCount, thinkingMode: currentMode })
    resetToolCallSeq()  // Reset per-turn sequence for ID normalization
    if (isInterrupted()) {
      yield { role: "status", content: "interrupted" }
      return
    }

    let fullContent = ""
    let fullReasoning = ""
    const toolCalls: ToolCall[] = []
    let streamError: LoopEvent | null = null
    let finishedWithToolUse = false

    const provider = config.provider ?? ""
    const isKeyless = provider === "kilo" || provider === "free-auto" || provider === "openai-compatible"
    const useMaxTokens = provider === "kilo" || provider === "free-auto" || provider === "openai-compatible"
    const supportsThinking = provider === "deepseek" || provider === "zen" || provider === "mimo"
    for await (const event of client.chatCompletionsStream(ctx.buildMessages(), {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal,
      keyless: isKeyless,
      useMaxCompletionTokens: !useMaxTokens,
      tools: toolSpecs.length > 0 ? toolSpecs : undefined,
      ...(supportsThinking ? createDeepSeekCapabilities(provider).mapMode(currentMode) : {}),
      traceContext: diagnosticsEnabled ? { submitId, turnCount } : undefined,
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

        case "status":
          yield { role: "status", content: event.content, metadata: event.metadata }
          break

        case "reasoning_delta":
          fullReasoning += event.delta
          yield { role: "reasoning_delta", content: event.delta }
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "reasoning_delta", content: event.delta } })
          break

        case "tool_call_end": {
          const normalizedId = normalizeToolCallId(event.id, event.name)
          const tc: ToolCall = {
            id: normalizedId,
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
          // ST2: Budget check — warn when tier budget is exceeded
          if (tier && stats.totalCost > tier.budgetCNY) {
            yield { role: "warning", content: `Budget exceeded: ${stats.totalCost.toFixed(4)} CNY > ${tier.budgetCNY} CNY (tier: ${tier.id})`, severity: "warning" as const, metadata: { tier: tier.id, budget: tier.budgetCNY, cost: stats.totalCost } }
          }
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
            // CL-51: duplicate tool call detection
            for (const tc of toolCalls) {
              const { warning } = recentToolCalls.check(tc)
              if (warning) {
                yield { role: "warning", content: warning, severity: "warning" as const }
              }
            }

            finishedWithToolUse = true
            ctx.log.append({ role: "assistant", content: fullContent || null, reasoning_content: fullReasoning || undefined, tool_calls: toolCalls })
            sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            totalToolCalls += toolCalls.length

            try {
              for await (const toolEvent of toolExecutor.run(toolCalls, signal, appendToolResult, diagnosticsEnabled ? { submitId, turnCount } : undefined)) {
                yield toolEvent
                // P5.5: tool_progress is transient — don't persist to session
                if (toolEvent.role !== 'tool_progress') {
                  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: toolEvent })
                }
              }
              // persist messages with tool results for crash recovery
              sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            } catch {
              // P1: StreamingToolExecutor handles settling remaining tools internally.
              // No blind batch补写 here — it would duplicate results for already-completed tools.
            }
            yield { role: "status", content: "tools_completed" }
            sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "status", content: "tools_completed" } })
            // ST3: Emit refined estimate after tool batch
            if (tier) {
              yield { role: "strategy_estimate_refined", metadata: { tier: tier.id, budget: tier.budgetCNY, cost: stats.totalCost, toolCalls: totalToolCalls, turnCount } }
            }

            // ST4: Tier recommendation after tool batch
            if (tier && turnCount >= 2) {
              const estimatedTokens = await ctx.estimateTokens()
              const contextUsagePercent = estimatedTokens / ctx.getContextWindow()
              const rec = recommendTier({
                currentTierId: tier.id,
                stats,
                turnCount,
                toolCallsThisSubmit: totalToolCalls,
                contextUsagePercent,
                tier,
              })
              if (rec.action !== "stay") {
                yield { role: "tier_recommendation", metadata: { recommendation: rec, currentTier: tier.id, stats: { totalCost: stats.totalCost, promptTokens: stats.promptTokens, completionTokens: stats.completionTokens }, turnCount, toolCallsThisSubmit: totalToolCalls, contextUsagePercent } }
              }
            }

            // P2: Safe point 1 — consume one pending instruction after tool batch
            const injectedAfterTools = appendPendingInstruction()
            if (injectedAfterTools) {
              yield injectedAfterTools
            }
          } else if (finishedWithToolUse) {
            // defensive: second done after tool use
          } else {
            ctx.log.append({ role: "assistant", content: fullContent })

            // P2: Safe point 2 — check for pending instructions before ending turn
            const injectedBeforeDone = appendPendingInstruction()
            if (injectedBeforeDone) {
              yield injectedBeforeDone
              // Don't yield done — continue the loop to process the injected instruction
              break
            }

            yield { role: "done", metadata: { reason } as Record<string, unknown> }
            sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "done", metadata: { reason } } })

            // CL-51: Evaluate thinking mode switch before returning
            if (modeSelectorState && !signal.aborted && thinkingMode === "auto") {
              const switchResult = evaluateModeSwitchForTurn(modeSelectorState, currentMode, totalToolCalls, fullContent.length, turnCount, consecutiveErrors, !!streamError)
              if (switchResult.switched) {
                currentMode = switchResult.to!
                modeSelectorState.lastSwitchTime = Date.now()
                if (diagnosticsEnabled) logger.info("reasoning.mode.switch", { from: switchResult.from, to: currentMode, reason: switchResult.reason })
                yield { role: "status", content: "thinking_mode_switch", metadata: { from: switchResult.from, to: currentMode, reason: switchResult.reason } }
              }
            }
            return
          }
          break
        }

        case "error":
          streamError = { role: "error", content: event.message, severity: "error" as const, metadata: { ...(event.status ? { status: event.status } : {}), responseBody: event.body } }
          yield streamError
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: streamError })
          break
      }
    }

    // CL-51: Evaluate thinking mode switch after each turn
    if (modeSelectorState && !signal.aborted && thinkingMode === "auto") {
      const switchResult = evaluateModeSwitchForTurn(modeSelectorState, currentMode, totalToolCalls, fullContent.length, turnCount, consecutiveErrors, !!streamError)
      if (switchResult.switched) {
        currentMode = switchResult.to!
        modeSelectorState.lastSwitchTime = Date.now()
        if (modeStats && switchResult.from && switchResult.reason) logModeSwitch(modeStats, switchResult.from, currentMode, switchResult.reason)
        if (diagnosticsEnabled) logger.info("reasoning.mode.switch", { from: switchResult.from, to: currentMode, reason: switchResult.reason })
        yield { role: "status", content: "thinking_mode_switch", metadata: { from: switchResult.from, to: currentMode, reason: switchResult.reason } }
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
      if (diagnosticsEnabled) logger.warn("loop.stream.retry", { consecutiveErrors, turnCount })
      if (consecutiveErrors >= 3) {
        yield { role: "error", content: `Stream failed after ${consecutiveErrors} consecutive attempts`, severity: "error" as const }
        return
      }
      continue
    }
    consecutiveErrors = 0
  }

  if (diagnosticsEnabled) logger.warn("loop.max_turns", { maxTurns })
  yield { role: "warning", content: `Reached maximum tool loop count (${maxTurns}).`, severity: "warning" as const }
  yield { role: "done", metadata: { reason: "maxTurns" } }
}
