/**
 * Simplified Perfetto Tracing for Deepreef
 *
 * Outputs Chrome Trace Event JSON format viewable in ui.perfetto.dev
 *
 * Enable via COVALO_TRACE=1 or --trace CLI flag
 * Output: .covalo/traces/trace-<session-id>.json
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join, dirname } from "node:path"

export type TraceEventPhase = "B" | "E" | "i" | "C"

export interface TraceEvent {
  name: string
  cat: string
  ph: TraceEventPhase
  ts: number // microseconds
  pid: number
  tid: number
  dur?: number
  args?: Record<string, unknown>
}

interface PendingSpan {
  name: string
  category: string
  startTime: number
  args: Record<string, unknown>
}

let isEnabled = false
let tracePath: string | null = null
let sessionId: string = ""
let startTimeMs = 0
let spanIdCounter = 0
const events: TraceEvent[] = []
const pendingSpans = new Map<string, PendingSpan>()
const MAX_EVENTS = 50_000
let startIndex = 0
let totalDropped = 0

function getTimestamp(): number {
  return (Date.now() - startTimeMs) * 1000
}

function generateSpanId(): string {
  return `span_${++spanIdCounter}`
}

function evictOldestEvents(): void {
  const currentCount = events.length - startIndex
  if (currentCount < MAX_EVENTS) return
  const dropCount = Math.floor(MAX_EVENTS / 2)
  startIndex += dropCount
  totalDropped += dropCount
  // Periodically compact array to prevent unbounded growth
  if (startIndex > MAX_EVENTS) {
    const validLength = events.length - startIndex
    for (let i = 0; i < validLength; i++) {
      events[i] = events[startIndex + i]!
    }
    events.length = validLength
    startIndex = 0
  }
}

function buildTraceDocument(): string {
  const validEvents = startIndex > 0 ? events.slice(startIndex) : events
  const traceEvents = totalDropped > 0
    ? [
        {
          name: "trace_truncated",
          cat: "__metadata",
          ph: "i" as const,
          ts: validEvents[0]?.ts ?? 0,
          pid: 1,
          tid: 0,
          args: { dropped_events: totalDropped },
        },
        ...validEvents,
      ]
    : validEvents
  return JSON.stringify({
    traceEvents,
    metadata: {
      session_id: sessionId,
      trace_start_time: new Date(startTimeMs).toISOString(),
      total_event_count: validEvents.length,
    },
  })
}

export function initializePerfettoTracing(sid: string): void {
  const envValue = process.env.COVALO_TRACE

  if (!envValue || envValue === "0" || envValue === "false") {
    return
  }

  isEnabled = true
  sessionId = sid
  startTimeMs = Date.now()
  tracePath = join(process.cwd(), ".covalo", "traces", `trace-${sid}.json`)

  process.on("beforeExit", () => {
    void writePerfettoTrace()
  })

  process.on("exit", () => {
    if (tracePath) {
      try {
        const { mkdirSync, writeFileSync } = require("node:fs")
        mkdirSync(dirname(tracePath), { recursive: true })
        writeFileSync(tracePath, buildTraceDocument())
      } catch {}
    }
  })
}

export function isPerfettoTracingEnabled(): boolean {
  return isEnabled
}

export function startInteractionSpan(userPromptLength?: number): string {
  if (!isEnabled) return ""
  const spanId = generateSpanId()
  const startTime = getTimestamp()
  pendingSpans.set(spanId, {
    name: "Interaction",
    category: "interaction",
    startTime,
    args: { user_prompt_length: userPromptLength },
  })
  events.push({
    name: "Interaction",
    cat: "interaction",
    ph: "B",
    ts: startTime,
    pid: 1,
    tid: 1,
    args: { user_prompt_length: userPromptLength },
  })
  if (events.length > MAX_EVENTS) evictOldestEvents()
  return spanId
}

export function endInteractionSpan(spanId: string): void {
  if (!isEnabled || !spanId) return
  const pending = pendingSpans.get(spanId)
  if (!pending) return
  const endTime = getTimestamp()
  events.push({
    name: pending.name,
    cat: pending.category,
    ph: "E",
    ts: endTime,
    pid: 1,
    tid: 1,
    args: { ...pending.args, duration_ms: (endTime - pending.startTime) / 1000 },
  })
  pendingSpans.delete(spanId)
}

export function startLLMRequestSpan(model: string, messageCount?: number): string {
  if (!isEnabled) return ""
  const spanId = generateSpanId()
  const startTime = getTimestamp()
  pendingSpans.set(spanId, {
    name: "LLM Request",
    category: "llm_request",
    startTime,
    args: { model, message_count: messageCount },
  })
  events.push({
    name: "LLM Request",
    cat: "llm_request",
    ph: "B",
    ts: startTime,
    pid: 1,
    tid: 1,
    args: { model, message_count: messageCount },
  })
  return spanId
}

export function endLLMRequestSpan(
  spanId: string,
  metadata?: {
    ttftMs?: number
    promptTokens?: number
    completionTokens?: number
    success?: boolean
    error?: string
  },
): void {
  if (!isEnabled || !spanId) return
  const pending = pendingSpans.get(spanId)
  if (!pending) return
  const endTime = getTimestamp()
  events.push({
    name: pending.name,
    cat: pending.category,
    ph: "E",
    ts: endTime,
    pid: 1,
    tid: 1,
    args: {
      ...pending.args,
      ttft_ms: metadata?.ttftMs,
      prompt_tokens: metadata?.promptTokens,
      completion_tokens: metadata?.completionTokens,
      success: metadata?.success ?? true,
      error: metadata?.error,
      duration_ms: (endTime - pending.startTime) / 1000,
    },
  })
  pendingSpans.delete(spanId)
}

export function startToolBatchSpan(toolCount: number): string {
  if (!isEnabled) return ""
  const spanId = generateSpanId()
  const startTime = getTimestamp()
  pendingSpans.set(spanId, {
    name: "Tool Batch",
    category: "tool_batch",
    startTime,
    args: { tool_count: toolCount },
  })
  events.push({
    name: "Tool Batch",
    cat: "tool_batch",
    ph: "B",
    ts: startTime,
    pid: 1,
    tid: 1,
    args: { tool_count: toolCount },
  })
  return spanId
}

export function endToolBatchSpan(spanId: string, errorCount?: number): void {
  if (!isEnabled || !spanId) return
  const pending = pendingSpans.get(spanId)
  if (!pending) return
  const endTime = getTimestamp()
  events.push({
    name: pending.name,
    cat: pending.category,
    ph: "E",
    ts: endTime,
    pid: 1,
    tid: 1,
    args: {
      ...pending.args,
      error_count: errorCount,
      duration_ms: (endTime - pending.startTime) / 1000,
    },
  })
  pendingSpans.delete(spanId)
}

export function startToolSpan(toolName: string, toolCallId?: string): string {
  if (!isEnabled) return ""
  const spanId = generateSpanId()
  const startTime = getTimestamp()
  pendingSpans.set(spanId, {
    name: `Tool: ${toolName}`,
    category: "tool",
    startTime,
    args: { tool_name: toolName, tool_call_id: toolCallId },
  })
  events.push({
    name: `Tool: ${toolName}`,
    cat: "tool",
    ph: "B",
    ts: startTime,
    pid: 1,
    tid: 1,
    args: { tool_name: toolName, tool_call_id: toolCallId },
  })
  return spanId
}

export function endToolSpan(
  spanId: string,
  metadata?: {
    success?: boolean
    error?: string
    durationMs?: number
  },
): void {
  if (!isEnabled || !spanId) return
  const pending = pendingSpans.get(spanId)
  if (!pending) return
  const endTime = getTimestamp()
  events.push({
    name: pending.name,
    cat: pending.category,
    ph: "E",
    ts: endTime,
    pid: 1,
    tid: 1,
    args: {
      ...pending.args,
      success: metadata?.success ?? true,
      error: metadata?.error,
      duration_ms: metadata?.durationMs ?? (endTime - pending.startTime) / 1000,
    },
  })
  pendingSpans.delete(spanId)
}

export function emitInstant(name: string, category: string, args?: Record<string, unknown>): void {
  if (!isEnabled) return
  events.push({
    name,
    cat: category,
    ph: "i",
    ts: getTimestamp(),
    pid: 1,
    tid: 1,
    args,
  })
}

async function writePerfettoTrace(): Promise<void> {
  if (!isEnabled || !tracePath) return
  try {
    for (const [spanId, pending] of pendingSpans) {
      const endTime = getTimestamp()
      events.push({
        name: pending.name,
        cat: pending.category,
        ph: "E",
        ts: endTime,
        pid: 1,
        tid: 1,
        args: { ...pending.args, incomplete: true, duration_ms: (endTime - pending.startTime) / 1000 },
      })
      pendingSpans.delete(spanId)
    }
    await mkdir(dirname(tracePath), { recursive: true })
    await writeFile(tracePath, buildTraceDocument())
  } catch {}
}

export function getPerfettoEvents(): TraceEvent[] {
  return [...events]
}

export function resetPerfettoTracer(): void {
  events.length = 0
  pendingSpans.clear()
  spanIdCounter = 0
  isEnabled = false
  tracePath = null
  startTimeMs = 0
}
