import type { ChatMessage, ToolSpec } from "../types.js"
import type { ChatClient } from "../interface.js"
import type { DeepSeekStreamEvent, DeepSeekClientOptions } from "../client.js"
import { DeepSeekClient } from "../client.js"
import type { FreeAutoCandidate } from "./catalog.js"
import { FREE_AUTO_CANDIDATES } from "./catalog.js"
import {
  getPenalty,
  isRetryableError,
  isProviderOnCooldown,
  isOnCooldown,
  applyCooldown,
  recordRouteSuccess,
  recordRouteFailure,
  classifyTask,
  type RoutingInput,
} from "./router.js"

export interface FreeAutoRouteEvent {
  type: "free_auto_route"
  provider: string
  model: string
  reason: string
  attempt: number
}

export class FreeAutoClient implements ChatClient {
  private underlying: DeepSeekClient
  /** Stick to the same candidate across submits (with time-based expiry) */
  private stickyKey: string | null = null
  private stickySetAt = 0
  private submitMessageCount = 0
  /** Re-score routing after this many ms of sticky hold */
  private readonly STICKY_EXPIRY_MS = 5 * 60 * 1000

  constructor(underlying: DeepSeekClient) {
    this.underlying = underlying
  }

  /**
   * Select the best candidate for this submit.
   * Within the same submit, prefers the sticky candidate.
   */
  private selectCandidate(input: RoutingInput): { candidate: FreeAutoCandidate; reason: string } {
    // If we have a sticky candidate that's not on cooldown and not expired, reuse it
    if (this.stickyKey && Date.now() - this.stickySetAt < this.STICKY_EXPIRY_MS) {
      const parts = this.stickyKey.split(":", 2)
      const stickyProvider = parts[0]!
      const stickyModel = parts[1]
      if (!isProviderOnCooldown(stickyProvider) && !isOnCooldown(this.stickyKey)) {
        const candidate = FREE_AUTO_CANDIDATES.find(
          c => c.provider === stickyProvider && c.model === stickyModel
        )
        if (candidate) {
          return { candidate, reason: "sticky" }
        }
      }
    }

    const taskType = classifyTask(input)
    const sorted = [...FREE_AUTO_CANDIDATES]
      .filter(c => !isProviderOnCooldown(c.provider) && !isOnCooldown(`${c.provider}:${c.model}`))
      .sort((a, b) => {
        const penaltyA = getPenalty(`${a.provider}:${a.model}`)
        const penaltyB = getPenalty(`${b.provider}:${b.model}`)
        return (a.priority + penaltyA) - (b.priority + penaltyB)
      })

    let candidate: FreeAutoCandidate | undefined
    let reason = "default"

    if (taskType === "coding") {
      // Prefer codestral-latest for coding tasks
      candidate = sorted.find(c => c.model === "codestral-latest")
      if (candidate) {
        reason = "coding_task_prefer_codestral"
      }
    } else if (taskType === "complex") {
      // Prefer qwen3-235b for complex tasks
      candidate = sorted.find(c => c.model === "qwen3-235b")
      if (candidate) {
        reason = "complex_task_prefer_qwen"
      }
    }

    if (!candidate) {
      // Fall back to best available by priority + penalty
      candidate = sorted[0]
      reason = taskType === "simple" ? "simple_task_smallest_penalty" : "best_available"
    }

    if (!candidate) {
      candidate = FREE_AUTO_CANDIDATES[0]
      reason = "fallback_default"
    }

    this.stickyKey = `${candidate.provider}:${candidate.model}`
    this.stickySetAt = Date.now()
    return { candidate, reason }
  }

  async *chatCompletionsStream(
    messages: ChatMessage[],
    opts: DeepSeekClientOptions,
  ): AsyncGenerator<DeepSeekStreamEvent> {
    // Track message count for routing decisions
    this.submitMessageCount++
    const estimatedInputLength = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0)

    const candidate = this.selectCandidate({
      hasTools: (opts.tools?.length ?? 0) > 0,
      messageCount: this.submitMessageCount,
      estimatedInputLength,
      toolCallRounds: 0,
    })

    const routeKey = `${candidate.candidate.provider}:${candidate.candidate.model}`

    // Emit routing status event
    yield {
      type: "status",
      content: "free_auto_route",
      metadata: {
        provider: candidate.candidate.provider,
        model: candidate.candidate.model,
        reason: candidate.reason,
        attempt: 1,
      },
    }

    // Try candidates in priority order with serial failover
    const candidateQueue = this.buildCandidateQueue(candidate.candidate)
    let lastError: Error | null = null

    for (let i = 0; i < candidateQueue.length; i++) {
      const c = candidateQueue[i]!
      const key = `${c.provider}:${c.model}`

      if (isProviderOnCooldown(c.provider) || isOnCooldown(key)) {
        yield {
          type: "status",
          content: "free_auto_route",
          metadata: {
            provider: c.provider,
            model: c.model,
            reason: `skipped_cooldown: ${lastError?.message ?? "cooldown active"}`,
            attempt: i + 1,
          },
        }
        continue
      }

      const startedAt = Date.now()

      try {
        for await (const event of this.underlying.chatCompletionsStream(messages, {
          ...opts,
          apiKey: "",
          baseUrl: c.baseUrl,
          model: c.model,
          keyless: true,
          useMaxCompletionTokens: false,
        })) {
          if (event.type === "error") {
            throw new Error(event.message)
          }
          yield event
        }

        // Success — record it and keep sticky for next submit
        recordRouteSuccess(key, Date.now() - startedAt)
        this.stickyKey = key
        this.stickySetAt = Date.now()
        return
      } catch (err: any) {
        lastError = err
        const latencyMs = Date.now() - startedAt
        recordRouteFailure(key)
        applyCooldown(key, c.provider, extractStatus(err))

        // Check if we've already yielded any meaningful content
        // (tracked by the caller — we just yield the status event)
        if (i < candidateQueue.length - 1) {
          yield {
            type: "status",
            content: "free_auto_route",
            metadata: {
              provider: c.provider,
              model: c.model,
              reason: `failover: ${err.message?.slice(0, 100)}`,
              attempt: i + 1,
            },
          }
        }
      }
    }

    // All candidates exhausted
    yield {
      type: "error",
      message: `Free Auto: all candidates failed. Last error: ${lastError?.message ?? "unknown"}`,
    }
  }

  /** Build failover queue with sticky candidate first, then remaining candidates */
  private buildCandidateQueue(preferred: FreeAutoCandidate): FreeAutoCandidate[] {
    const queue = [preferred]
    for (const c of FREE_AUTO_CANDIDATES) {
      if (c.provider !== preferred.provider || c.model !== preferred.model) {
        queue.push(c)
      }
    }
    return queue
  }

  /** Reset sticky state for a new submit */
  resetSticky(): void {
    this.stickyKey = null
    this.stickySetAt = 0
    this.submitMessageCount = 0
  }
}

function extractStatus(err: any): number {
  if (err.status) return err.status
  const msg = (err.message ?? "").toLowerCase()
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests")) return 429
  if (msg.includes("402") || msg.includes("payment required")) return 402
  if (msg.includes("401")) return 401
  if (msg.includes("403")) return 403
  if (msg.includes("408") || msg.includes("timeout")) return 408
  if (msg.includes("500")) return 500
  if (msg.includes("502")) return 502
  if (msg.includes("503")) return 503
  if (msg.includes("504")) return 504
  return 0
}
