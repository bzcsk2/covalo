import { randomUUID } from "node:crypto"
import type { ChatMessage, ToolSpec } from "./types.js"
import type { ChatClient } from "./interface.js"
import { noopRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js"

export type DeepSeekStreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_call_delta"; toolCallIndex: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "tool_call_end"; toolCallIndex: number; id: string; name: string; arguments: string }
  | {
      type: "usage"
      usage: {
        promptTokens: number
        completionTokens: number
        totalTokens: number
        cacheHitTokens?: number
        cacheMissTokens?: number
      }
    }
  | { type: "done"; finishReason: string | null }
  | { type: "error"; status?: number; message: string; body?: unknown }
  | { type: "status"; content: string; metadata?: Record<string, unknown> }

export interface DeepSeekClientOptions {
  apiKey: string
  baseUrl: string
  model: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  tools?: ToolSpec[]
  thinking?: { type: "enabled" | "disabled" }
  reasoningEffort?: "low" | "medium" | "high" | "max"
  traceContext?: Record<string, unknown>
  /** Keyless providers (Kilo anonymous free tier) send NO Authorization header */
  keyless?: boolean
  /** Per-request HTTP timeout in ms. Overrides the default for slow providers. */
  timeoutMs?: number
  /** Maximum wait after response headers for the first model event. */
  firstEventTimeoutMs?: number
  /** Optional model retried once when the primary stream only emits keepalives. */
  fallbackModel?: string
  /** Called when the max_completion_tokens field should be used instead of max_tokens */
  useMaxCompletionTokens?: boolean
}

type ToolCallDelta = {
  index: number
  id?: string
  type?: "function"
  function?: { name?: string; arguments?: string }
}

type SSEChunk = {
  choices?: Array<{
    delta?: {
      content?: string
      reasoning_content?: string
      reasoning?: string
      tool_calls?: ToolCallDelta[]
    }
    message?: {
      content?: string | null
      reasoning_content?: string
      reasoning?: string
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
  error?: { message?: string; code?: number | string }
}

export class DeepSeekClient implements ChatClient {
  constructor(private readonly logger: RuntimeLogger = noopRuntimeLogger) {}

  async *chatCompletionsStream(messages: ChatMessage[], opts: DeepSeekClientOptions): AsyncGenerator<DeepSeekStreamEvent> {
    const diagnosticsEnabled = this.logger.isEnabled("error")
    const startedAt = diagnosticsEnabled ? Date.now() : 0
    const requestLogger = diagnosticsEnabled
      ? this.logger.child({ ...opts.traceContext, requestId: randomUUID() })
      : this.logger
    const url = `${ensureBaseUrl(opts.baseUrl)}chat/completions`

    // Keyless providers (Kilo anonymous free tier) send NO Authorization header
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    }
    if (!opts.keyless) {
      headers.Authorization = `Bearer ${opts.apiKey}`
    }

    const requestMessages = repairToolCallSequence(messages)
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: requestMessages.map((m) => {
        if (m.role === "tool") {
          let content = m.content ?? ""
          if (m.is_error && !content.startsWith("[Error]")) {
            content = `[Error] ${content}`
          }
          return {
            role: "tool",
            tool_call_id: m.tool_call_id,
            content,
          }
        }
        if (m.role === "assistant") {
          // AS0: reasoning_content 回传用于 Thinking Mode 工具链连续性
          // 只在有 tool_calls 时保留，普通文本回复不携带历史推理内容
          const msg: { role: "assistant"; content: string | null; reasoning_content?: string; tool_calls?: typeof m.tool_calls } = { role: "assistant", content: m.content }
          if (m.tool_calls) {
            msg.tool_calls = m.tool_calls
            if (m.reasoning_content) msg.reasoning_content = m.reasoning_content
          }
          return msg
        }
        return { role: m.role, content: m.content ?? "" }
      }),
      stream: true,
      temperature: opts.temperature,
    }

    // Kilo/LLM7 free-tier use max_tokens; DeepSeek uses max_completion_tokens
    if (opts.useMaxCompletionTokens) {
      body.max_completion_tokens = opts.maxTokens
    } else {
      body.max_tokens = opts.maxTokens
    }

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools
    }
    if (opts.thinking) body.thinking = opts.thinking
    if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort
    if (diagnosticsEnabled) {
      requestLogger.info("api.request.start", {
        url,
        model: opts.model,
        messageCount: messages.length,
        toolSpecCount: opts.tools?.length ?? 0,
        thinking: opts.thinking?.type,
        reasoningEffort: opts.reasoningEffort,
      })
    }

    const maxRetries = 3
    const retryableStatuses = new Set([429, 500, 502, 503])

    const timeoutMs = opts.timeoutMs ?? 15000
    let resp: Response
    let responseController: AbortController | undefined
    let attempt = 0
    while (true) {
      attempt++
      let timeoutTriggered = false
      try {
        // Per-request timeout via AbortController (freellmapi fetchWithTimeout pattern)
        // Combined with the user-provided signal so we don't override user abort
        const timeoutController = new AbortController()
        const requestController = new AbortController()
        const timeout = setTimeout(() => {
          timeoutTriggered = true
          timeoutController.abort()
        }, timeoutMs)
        const combinedSignal = opts.signal
          ? combineAbortSignals(opts.signal, timeoutController.signal, requestController.signal)
          : combineAbortSignals(timeoutController.signal, requestController.signal)
        try {
          resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: combinedSignal, keepalive: false })
          responseController = requestController
        } finally {
          clearTimeout(timeout)
        }
        if (resp.ok) break
        const status = resp.status
        if (opts.fallbackModel && opts.fallbackModel !== opts.model && retryableStatuses.has(status)) {
          responseController?.abort()
          if (diagnosticsEnabled) requestLogger.warn("api.request.fallback", { status, fromModel: opts.model, toModel: opts.fallbackModel })
          yield { type: "status", content: `${opts.model} returned HTTP ${status}; falling back to ${opts.fallbackModel}`, metadata: { kind: "model_fallback", status, fromModel: opts.model, toModel: opts.fallbackModel } }
          yield* this.chatCompletionsStream(messages, { ...opts, model: opts.fallbackModel, fallbackModel: undefined })
          return
        }
        if (!retryableStatuses.has(status) || attempt > maxRetries) {
          const text = await safeReadText(resp)
          if (diagnosticsEnabled) {
            requestLogger.warn("api.request.http_error", {
              status, attempt, durationMs: Date.now() - startedAt,
              requestBody: JSON.stringify(body).slice(0, 5000),
              responseBody: text.slice(0, 2000),
            })
          }
          yield { type: "error", status, message: `HTTP ${status}`, body: text }
          return
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1) + Math.random() * 500, 10_000)
        if (diagnosticsEnabled) requestLogger.warn("api.request.retry", { status, attempt, delayMs: Math.round(delay) })
        await sleep(delay, opts.signal)
        continue
      } catch (e) {
        const userAborted = opts.signal?.aborted === true
        const requestTimedOut = timeoutTriggered && isAbortError(e)
        if (userAborted || attempt > maxRetries || (isAbortError(e) && !requestTimedOut)) {
          if (diagnosticsEnabled) requestLogger.error("api.request.fetch_error", e, { attempt, durationMs: Date.now() - startedAt })
          yield { type: "error", message: requestTimedOut ? `Request timed out after ${timeoutMs}ms` : errorMessage(e) }
          return
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1) + Math.random() * 500, 10_000)
        if (diagnosticsEnabled) requestLogger.warn("api.request.retry", { attempt, delayMs: Math.round(delay), reason: requestTimedOut ? "request_timeout" : errorMessage(e) })
        await sleep(delay, opts.signal)
        continue
      }
    }

    if (!resp.body) {
      if (diagnosticsEnabled) requestLogger.error("api.response.body_missing", undefined, { status: resp.status, durationMs: Date.now() - startedAt })
      yield { type: "error", message: "Response body missing" }
      return
    }
    if (diagnosticsEnabled) requestLogger.info("api.response.open", { status: resp.status, attempt, durationMs: Date.now() - startedAt })

    const reader = resp.body.getReader()
    let fallbackRequested = false
    let onAbortReject: (() => void) | undefined
    const onAbort = () => { void reader.cancel(opts.signal?.reason).catch(() => {}) }
    opts.signal?.addEventListener("abort", onAbort, { once: true })
    const abortPromise = new Promise<never>((_, reject) => {
      if (!opts.signal) return
      if (opts.signal.aborted) {
        reject(opts.signal.reason ?? new DOMException("The operation was aborted.", "AbortError"))
        return
      }
      onAbortReject = () => reject(opts.signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"))
      opts.signal.addEventListener("abort", onAbortReject, { once: true })
    })
    try {
      const decoder = new TextDecoder("utf-8")
      let buf = ""
      let firstChunk = true

      const toolState = new Map<number, { id?: string; name?: string; args: string }>()
      const finalized = new Set<number>()
      let finishReasonYielded = false
      let ttftMs: number | undefined
      let firstEventYielded = false
      let processingStatusYielded = false
      let sawFinishReason = false
      // Per-read inactivity timeout (freellmapi readSseStream pattern #231 audit)
      const INACTIVITY_TIMEOUT_MS = opts.timeoutMs ?? 90000
      const firstEventDeadline = Date.now() + (opts.firstEventTimeoutMs ?? 15_000)

      const yieldFirstEvent = (type: string) => {
        if (!firstEventYielded) {
          firstEventYielded = true
          ttftMs = Date.now() - startedAt
          if (diagnosticsEnabled) requestLogger.debug("api.stream.first_event", { ttftMs, eventType: type })
        }
      }

      while (true) {
        let timer: ReturnType<typeof setTimeout> | undefined
        let result: { done: boolean; value?: Uint8Array }
        try {
          result = await Promise.race([
            reader.read(),
            abortPromise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Stream stalled: no data for ${INACTIVITY_TIMEOUT_MS}ms (timeout)`)),
                firstEventYielded
                  ? INACTIVITY_TIMEOUT_MS
                  : Math.min(INACTIVITY_TIMEOUT_MS, Math.max(0, firstEventDeadline - Date.now())),
              )
            }),
          ]).finally(() => clearTimeout(timer))
        } catch (e) {
          if (!firstEventYielded && Date.now() >= firstEventDeadline && opts.fallbackModel && opts.fallbackModel !== opts.model) {
            fallbackRequested = true
            break
          }
          // SSE stall timeout — yield as error if we haven't started; if we
          // have already yielded events, we'll handle it through normal channel
          if (!firstEventYielded) {
            yield { type: "error", message: errorMessage(e) }
          }
          return
        }

        const { done, value } = result
        if (done) break
        let chunk = decoder.decode(value, { stream: true })
        // Strip BOM (U+FEFF) from first chunk
        if (firstChunk) {
          firstChunk = false
          if (chunk.charCodeAt(0) === 0xFEFF) {
            chunk = chunk.slice(1)
          }
        }
        buf += chunk

        while (true) {
          const sep = buf.indexOf("\n\n")
          if (sep < 0) break
          const raw = buf.slice(0, sep)
          buf = buf.slice(sep + 2)

          // accumulate multi-line data: (OpenAI-compatible SSE may split one event across lines)
          let dataPayloads: string[] = []
          let sawComment = false
          for (const line of raw.split("\n")) {
            const trimmed = line.trimEnd()
            if (trimmed.startsWith(":")) {
              sawComment = true
              continue
            }
            if (!trimmed.startsWith("data:")) continue
            dataPayloads.push(trimmed.slice("data:".length).trimStart())
          }
          if (sawComment && !processingStatusYielded && !firstEventYielded) {
            processingStatusYielded = true
            yield { type: "status", content: `Waiting for ${opts.model} to start responding`, metadata: { kind: "provider_processing", model: opts.model } }
          }
          const payload = dataPayloads.join("")

          if (payload === "[DONE]") {
            // finalize any pending tool calls before done
            if (toolState.size > 0) {
              for (const [index, tc] of toolState.entries()) {
                if (!finalized.has(index) && tc.id && tc.name) {
                  finalized.add(index)
                  yield { type: "tool_call_end", toolCallIndex: index, id: tc.id, name: tc.name, arguments: tc.args }
                }
              }
            }
            if (!finishReasonYielded) {
              yield { type: "done", finishReason: null }
            }
            if (diagnosticsEnabled) requestLogger.info("api.stream.done", { finishReason: null, durationMs: Date.now() - startedAt })
            return
          }

          if (!payload) continue

          let json: SSEChunk
          try {
            json = JSON.parse(payload) as SSEChunk
          } catch {
            if (process.env.COVALO_DEBUG) {
              console.debug("[SSE] JSON parse failed:", payload.slice(0, 200))
            }
            if (diagnosticsEnabled) requestLogger.debug("api.sse.parse_error", { payloadLength: payload.length })
            continue
          }

          if (json.error) {
            const err = json.error
            const msg = err.message ?? `API error ${err.code ?? 'unknown'}`
            if (diagnosticsEnabled) requestLogger.warn("api.stream.provider_error", { code: err.code, message: msg, durationMs: Date.now() - startedAt })
            yield { type: "error", message: msg }
            return
          }

          const choice = json.choices?.[0]
          const delta = choice?.delta

          // Check for finish_reason on choice (including in the initial message for non-streaming-like SSE)
          if (choice?.finish_reason != null) sawFinishReason = true

          // DEBUG: Log raw SSE delta when thinking is enabled
          if (opts.thinking?.type === "enabled" && delta) {
            const keys = Object.keys(delta)
            if (keys.length > 0 && !firstEventYielded) {
              requestLogger.info("api.sse.delta_keys", { keys, hasReasoning: !!(delta.reasoning_content || delta.reasoning), hasContent: !!delta.content })
            }
          }

          // Support both "reasoning_content" (DeepSeek) and "reasoning" (Zen/Mimo)
          const reasoningText = delta?.reasoning_content || delta?.reasoning
          if (reasoningText) {
            yieldFirstEvent("reasoning_delta")
            yield { type: "reasoning_delta", delta: reasoningText }
          }
          if (delta?.content) {
            yieldFirstEvent("text_delta")
            yield { type: "text_delta", delta: delta.content }
          }

          if (delta?.tool_calls && delta.tool_calls.length > 0) {
            for (const tc of delta.tool_calls) {
              const index = tc.index
              const state = toolState.get(index) ?? { args: "" }
              if (tc.id) state.id = tc.id
              const fn = tc.function
              if (fn?.name) state.name = fn.name
              if (fn?.arguments) state.args += fn.arguments
              toolState.set(index, state)

              yieldFirstEvent("tool_call_delta")
              yield {
                type: "tool_call_delta",
                toolCallIndex: index,
                id: tc.id,
                name: fn?.name,
                argumentsDelta: fn?.arguments,
              }
            }
          }

          // finalize tool calls when finish_reason triggers or message.tool_calls present
          if (isToolUseFinishReason(choice?.finish_reason ?? null)) {
            for (const [index, state] of toolState.entries()) {
              if (finalized.has(index)) continue
              if (!state.id || !state.name) continue
              finalized.add(index)
              yield { type: "tool_call_end", toolCallIndex: index, id: state.id, name: state.name, arguments: state.args }
            }
          }

          if (json.usage) {
            if (diagnosticsEnabled) {
              requestLogger.info("api.usage", {
                promptTokens: json.usage.prompt_tokens,
                completionTokens: json.usage.completion_tokens,
                cacheHitTokens: json.usage.prompt_cache_hit_tokens,
                cacheMissTokens: json.usage.prompt_cache_miss_tokens,
              })
            }
            yield {
              type: "usage",
              usage: {
                promptTokens: json.usage.prompt_tokens,
                completionTokens: json.usage.completion_tokens,
                totalTokens: json.usage.total_tokens,
                cacheHitTokens: json.usage.prompt_cache_hit_tokens,
                cacheMissTokens: json.usage.prompt_cache_miss_tokens,
              },
            }
          }

          if (choice?.finish_reason && !finishReasonYielded) {
            finishReasonYielded = true
            yield { type: "done", finishReason: choice.finish_reason }
          }
        }
      }

      // freellmapi abnormal EOF detection: stream ended without [DONE] AND
      // without any finish_reason is a truncated generation, not a completion.
      if (!fallbackRequested && !sawFinishReason && !finishReasonYielded) {
        yield { type: "error", message: "Stream ended unexpectedly (no [DONE], no finish_reason) — connection reset or truncated upstream" }
        return
      }

      if (!fallbackRequested && !finishReasonYielded) {
        yield { type: "done", finishReason: null }
      }
      if (!fallbackRequested && diagnosticsEnabled) requestLogger.info("api.stream.done", { finishReason: null, durationMs: Date.now() - startedAt, ttftMs })
    } finally {
      opts.signal?.removeEventListener("abort", onAbort)
      if (onAbortReject) opts.signal?.removeEventListener("abort", onAbortReject)
      await reader.cancel().catch(() => {})
      responseController?.abort()
      reader.releaseLock()
    }

    if (fallbackRequested && opts.fallbackModel) {
      if (diagnosticsEnabled) requestLogger.warn("api.stream.fallback", { fromModel: opts.model, toModel: opts.fallbackModel, durationMs: Date.now() - startedAt })
      yield { type: "status", content: `${opts.model} did not start responding; falling back to ${opts.fallbackModel}`, metadata: { kind: "model_fallback", fromModel: opts.model, toModel: opts.fallbackModel } }
      yield* this.chatCompletionsStream(messages, { ...opts, model: opts.fallbackModel, fallbackModel: undefined })
    }
  }
}

/**
 * Providers reject assistant tool calls without immediately following results.
 * Interrupts can leave persisted sessions in that state, so repair only the
 * outbound request copy and keep the transcript unchanged.
 */
function repairToolCallSequence(messages: ChatMessage[]): ChatMessage[] {
  const repaired: ChatMessage[] = []
  let pending = new Map<string, string>()

  const settlePending = () => {
    for (const [id, name] of pending) {
      repaired.push({
        role: "tool",
        tool_call_id: id,
        content: `[Error] ${name} was cancelled before producing a result`,
        is_error: true,
      })
    }
    pending = new Map()
  }

  for (const message of messages) {
    if (message.role === "tool") {
      if (message.tool_call_id && pending.has(message.tool_call_id)) {
        repaired.push(message)
        pending.delete(message.tool_call_id)
      }
      continue
    }

    if (pending.size > 0) settlePending()
    repaired.push(message)
    if (message.role === "assistant" && message.tool_calls) {
      pending = new Map(message.tool_calls.map(call => [call.id, call.function.name]))
    }
  }

  if (pending.size > 0) settlePending()
  return repaired
}

export function isToolUseFinishReason(reason: string | null): boolean {
  return reason === "tool_calls" || reason === "tool_use" || reason === "toolUse" || reason === "toolCall" || reason === "tool"
}

function ensureBaseUrl(baseUrl: string): string {
  // Normalize to exactly one trailing slash, preserving path segments like /zen/v1/
  let url = baseUrl
  if (!url.endsWith("/")) url += "/"
  return url
}

async function safeReadText(resp: Response): Promise<string> {
  try {
    return await resp.text()
  } catch {
    return ""
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      return controller.signal
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  }
  return controller.signal
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true
  if (error instanceof Error && error.name === "AbortError") return true
  // Node.js SystemError has a `code` property (e.g., "ABORT_ERR")
  if (error instanceof Error && "code" in error && (error as { code: unknown }).code === "ABORT_ERR") return true
  return false
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
