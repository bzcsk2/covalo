import type { ChatMessage, ToolSpec } from "./types.js"

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
      tool_calls?: ToolCallDelta[]
    }
    message?: {
      content?: string | null
      reasoning_content?: string
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
  error?: { message?: string }
}

export class DeepSeekClient {
  async *chatCompletionsStream(messages: ChatMessage[], opts: DeepSeekClientOptions): AsyncGenerator<DeepSeekStreamEvent> {
    const url = new URL("/chat/completions", ensureBaseUrl(opts.baseUrl)).toString()
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    }

    const body: Record<string, unknown> = {
      model: opts.model,
      messages: messages.map((m) => {
        if (m.role === "tool") {
          return {
            role: "tool",
            tool_call_id: m.tool_call_id,
            content: m.content ?? "",
          }
        }
        if (m.role === "assistant") {
          const msg: any = { role: "assistant", content: m.content }
          if (m.reasoning_content !== undefined && m.reasoning_content !== null) {
            msg.reasoning_content = m.reasoning_content
          }
          if (m.tool_calls) msg.tool_calls = m.tool_calls
          return msg
        }
        return { role: m.role, content: m.content ?? "" }
      }),
      stream: true,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    }

    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools
    }
    if (opts.thinking) body.thinking = opts.thinking
    if (opts.reasoningEffort) body.reasoning_effort = opts.reasoningEffort

    const maxRetries = 3
    const retryableStatuses = new Set([429, 502, 503])

    let resp: Response
    let attempt = 0
    while (true) {
      attempt++
      try {
        resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal })
        if (resp.ok) break
        const status = resp.status
        if (!retryableStatuses.has(status) || attempt > maxRetries) {
          const text = await safeReadText(resp)
          yield { type: "error", status, message: `HTTP ${status}`, body: text }
          return
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1) + Math.random() * 500, 10_000)
        await sleep(delay, opts.signal)
        continue
      } catch (e) {
        if (attempt > maxRetries || isAbortError(e)) {
          yield { type: "error", message: errorMessage(e) }
          return
        }
        const delay = Math.min(1000 * 2 ** (attempt - 1) + Math.random() * 500, 10_000)
        await sleep(delay, opts.signal)
        continue
      }
    }

    if (!resp.body) {
      yield { type: "error", message: "Response body missing" }
      return
    }

    const reader = resp.body.getReader()
    const decoder = new TextDecoder("utf-8")
    let buf = ""

    const toolState = new Map<number, { id?: string; name?: string; args: string }>()
    const finalized = new Set<number>()

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })

      while (true) {
        const sep = buf.indexOf("\n\n")
        if (sep < 0) break
        const raw = buf.slice(0, sep)
        buf = buf.slice(sep + 2)

        for (const line of raw.split("\n")) {
          const trimmed = line.trimEnd()
          if (!trimmed.startsWith("data:")) continue
          const payload = trimmed.slice("data:".length).trimStart()
          if (payload === "[DONE]") {
            yield { type: "done", finishReason: null }
            return
          }

          let json: SSEChunk
          try {
            json = JSON.parse(payload) as SSEChunk
          } catch {
            continue
          }

          if (json.error?.message) {
            yield { type: "error", message: json.error.message }
            return
          }

          const choice = json.choices?.[0]
          const delta = choice?.delta
          if (delta?.reasoning_content) {
            yield { type: "reasoning_delta", delta: delta.reasoning_content }
          }
          if (delta?.content) {
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
          if (choice?.finish_reason === "tool_calls" || choice?.finish_reason === "tool_use" || choice?.finish_reason === "toolUse") {
            for (const [index, state] of toolState.entries()) {
              if (finalized.has(index)) continue
              if (!state.id || !state.name) continue
              finalized.add(index)
              yield { type: "tool_call_end", toolCallIndex: index, id: state.id, name: state.name, arguments: state.args }
            }
          }

          if (json.usage) {
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

          if (choice?.finish_reason) {
            yield { type: "done", finishReason: choice.finish_reason }
          }
        }
      }
    }

    yield { type: "done", finishReason: null }
  }
}

function ensureBaseUrl(baseUrl: string): string {
  // accept https://api.deepseek.com or https://api.deepseek.com/v1
  const u = new URL(baseUrl)
  if (!u.pathname || u.pathname === "/") u.pathname = "/"
  if (u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1)
  // DeepSeek official is base host without /v1 in our python test; but also accept /v1.
  // We'll normalize to include /v1 if not present? Official works without /v1 in examples.
  return u.toString()
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

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

