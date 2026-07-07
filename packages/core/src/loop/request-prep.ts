import type { DeepSeekClientOptions } from "../client.js"
import type { FoldDecision } from "../context/token-estimator.js"
import type { LoopEvent } from "../interface.js"
import type { ThinkingMode } from "../provider-thinking.js"
import { createDeepSeekCapabilities } from "../provider-thinking.js"
import type { ToolSpec } from "../types.js"
import type { LoopOptions } from "../loop.js"

export function createFoldStatusEvent(fold: FoldDecision): LoopEvent | null {
  if (fold.action === "force") {
    return {
      role: "status",
      content: "Context budget exceeded — forcing fold on next turn",
      severity: "warning" as const,
      metadata: { fold },
    }
  }
  if (fold.action !== "none") {
    return {
      role: "status",
      content: `Context at ${(fold.ratio * 100).toFixed(0)}% — fold recommended`,
      metadata: { fold },
    }
  }
  return null
}

export interface BuildChatStreamOptionsInput {
  config: LoopOptions["config"]
  signal: AbortSignal
  tools?: ToolSpec[]
  thinkingMode: ThinkingMode
  diagnosticsEnabled: boolean
  submitId?: string
  turnCount: number
}

export function buildChatStreamOptions(input: BuildChatStreamOptionsInput): DeepSeekClientOptions {
  const { config, signal, tools, thinkingMode, diagnosticsEnabled, submitId, turnCount } = input
  const provider = config.provider ?? ""
  const isKeyless = provider === "kilo" || provider === "openai-compatible"
  const useMaxTokens = provider === "kilo" || provider === "openai-compatible"
  const supportsThinking = provider === "deepseek" || provider === "zen" || provider === "mimo"

  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    signal,
    keyless: isKeyless,
    useMaxCompletionTokens: !useMaxTokens,
    tools,
    ...(supportsThinking ? createDeepSeekCapabilities(provider).mapMode(thinkingMode) : {}),
    traceContext: diagnosticsEnabled ? { submitId, turnCount } : undefined,
    firstEventTimeoutMs: provider === "zen" ? 15_000 : undefined,
    fallbackModel: provider === "zen" && config.model !== "deepseek-v4-flash-free"
      ? "deepseek-v4-flash-free"
      : undefined,
  }
}
