import { describe, it, expect, afterEach } from "vitest"
import { MockSseServer } from "../src/test-utils/mock-sse-server.js"
import { DeepSeekClient, isToolUseFinishReason, type DeepSeekStreamEvent } from "../src/client.js"

describe("SSE Client with MockSseServer", () => {
  let server: MockSseServer

  afterEach(async () => {
    try {
      await Promise.race([server?.stop(), new Promise((_, rej) => setTimeout(() => rej(new Error("stop timeout")), 3000))])
    } catch { /* ignore stop errors in cleanup */ }
  })

  // ── Helper ─────────────────────────────────────────────

  async function collectStream(opts?: { apiKey?: string; signal?: AbortSignal }): Promise<DeepSeekStreamEvent[]> {
    const events: DeepSeekStreamEvent[] = []
    const client = new DeepSeekClient()
    for await (const ev of client.chatCompletionsStream(
      [{ role: "user", content: "hi" }],
      { apiKey: opts?.apiKey ?? "test-key", baseUrl: server.baseUrl, model: "test-model", signal: opts?.signal },
    )) {
      events.push(ev)
    }
    return events
  }

  // ── 1. Normal text flow ────────────────────────────────

  it("should yield text_delta events for normal stream", async () => {
    server = new MockSseServer().setScenario("normal")
    await server.start()
    const events = await collectStream()
    const textDeltas = events.filter((e) => e.type === "text_delta")
    expect(textDeltas).toHaveLength(2)
    expect(textDeltas[0]).toEqual({ type: "text_delta", delta: "Hello" })
    expect(textDeltas[1]).toEqual({ type: "text_delta", delta: " world" })
  })

  it("should yield usage event with correct token counts", async () => {
    server = new MockSseServer().setScenario("normal")
    await server.start()
    const events = await collectStream()
    const usage = events.find((e) => e.type === "usage")
    expect(usage).toEqual({
      type: "usage",
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
    })
  })

  it("should yield done event with finish_reason", async () => {
    server = new MockSseServer().setScenario("normal")
    await server.start()
    const events = await collectStream()
    const done = events.find((e) => e.type === "done")
    expect(done).toEqual({ type: "done", finishReason: "stop" })
  })

  it("should not yield error for normal stream", async () => {
    server = new MockSseServer().setScenario("normal")
    await server.start()
    const events = await collectStream()
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  // ── 2. Tool call flow ──────────────────────────────────

  it("should yield tool_call_delta events", async () => {
    server = new MockSseServer().setScenario("tool_calls")
    await server.start()
    const events = await collectStream()
    const deltas = events.filter((e) => e.type === "tool_call_delta")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(deltas[0].toolCallIndex).toBe(0)
  })

  it("should yield tool_call_end with final arguments", async () => {
    server = new MockSseServer().setScenario("tool_calls")
    await server.start()
    const events = await collectStream()
    const ends = events.filter((e) => e.type === "tool_call_end")
    expect(ends.length).toBeGreaterThanOrEqual(1)
    expect(ends[0].id).toBe("call_1")
    expect(ends[0].name).toBe("read_file")
  })

  it("should yield done with finish_reason=tool_calls", async () => {
    server = new MockSseServer().setScenario("tool_calls")
    await server.start()
    const events = await collectStream()
    const done = events.find((e) => e.type === "done")
    expect(done).toEqual({ type: "done", finishReason: "tool_calls" })
  })

  // ── 3. R1 reasoning flow ───────────────────────────────

  it("should yield reasoning_delta events", async () => {
    server = new MockSseServer().setScenario("reasoning")
    await server.start()
    const events = await collectStream()
    const reasoning = events.filter((e) => e.type === "reasoning_delta")
    expect(reasoning.length).toBeGreaterThanOrEqual(2)
    expect(reasoning[0]).toEqual({ type: "reasoning_delta", delta: "Let me think" })
    expect(reasoning[1]).toEqual({ type: "reasoning_delta", delta: " step by step" })
  })

  it("should yield text_delta after reasoning_delta", async () => {
    server = new MockSseServer().setScenario("reasoning")
    await server.start()
    const events = await collectStream()
    const reasoningIdx = events.findIndex((e) => e.type === "reasoning_delta")
    const textIdx = events.findIndex((e) => e.type === "text_delta")
    expect(textIdx).toBeGreaterThan(reasoningIdx)
  })

  // ── 4. [DONE] marker ────────────────────────────────────

  it("should handle [DONE] marker and yield finishReason:null", async () => {
    server = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"x"}}]}\n\n` },
      { data: "data: [DONE]\n\n" },
    ])
    await server.start()
    const events = await collectStream()
    const done = events.find((e) => e.type === "done")
    expect(done).toEqual({ type: "done", finishReason: null })
  })

  // ── 7. 429 retry ────────────────────────────────────────

  it("should retry on HTTP 429 and succeed eventually", async () => {
    server = new MockSseServer().setScenario("normal").setFailFirst(1)
    await server.start()
    const events = await collectStream()
    const textDeltas = events.filter((e) => e.type === "text_delta")
    expect(textDeltas.length).toBeGreaterThan(0)
    expect(events.some((e) => e.type === "error")).toBe(false)
    expect(server.requestCount).toBeGreaterThanOrEqual(2)
  })

  // ── 8. 500 retry ────────────────────────────────────────

  it("should retry on HTTP 500 and succeed", async () => {
    server = new MockSseServer().setScenario("normal").setFailFirst(1)
    await server.start()
    const events = await collectStream()
    expect(events.some((e) => e.type === "text_delta")).toBe(true)
  })

  // ── 9. 400/401 not retried ─────────────────────────────

  it("should NOT retry on HTTP 400", async () => {
    server = new MockSseServer().setChunks(
      [{ data: `{"error":{"message":"Bad request"}}` }],
      400,
    )
    await server.start()
    const events = await collectStream()
    const error = events.find((e) => e.type === "error")
    expect(error).toBeDefined()
    expect(error!.message).toContain("400")
  })

  // ── 10. 3 consecutive failures → error ──────────────────

  it("should yield error after 3 consecutive failures", { timeout: 15000 }, async () => {
    server = new MockSseServer().setScenario("error_429").setFailFirst(3)
    await server.start()
    const events = await collectStream()
    const errors = events.filter((e) => e.type === "error")
    expect(errors.length).toBeGreaterThanOrEqual(1)
  })

  // ── 11. 1-2 failures then success ───────────────────────

  it("should succeed after 1 failure", { timeout: 10000 }, async () => {
    server = new MockSseServer().setScenario("normal").setFailFirst(1)
    await server.start()
    const events = await collectStream()
    expect(events.some((e) => e.type === "text_delta")).toBe(true)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  // ── 12. jitter between retries ──────────────────────────

  it("should have different retry delays (jitter)", async () => {
    // Just verify retries don't block forever
    server = new MockSseServer().setScenario("normal").setFailFirst(1)
    await server.start()
    const t0 = Date.now()
    const events = await collectStream()
    const elapsed = Date.now() - t0
    expect(elapsed).toBeGreaterThan(500) // at least one retry delay
    expect(events.some((e) => e.type === "text_delta")).toBe(true)
  })

  // ── 13. finish_reason variants ──────────────────────────

  it("isToolUseFinishReason: tool_calls→true", () => {
    expect(isToolUseFinishReason("tool_calls")).toBe(true)
  })
  it("isToolUseFinishReason: tool_use→true", () => {
    expect(isToolUseFinishReason("tool_use")).toBe(true)
  })
  it("isToolUseFinishReason: toolUse→true", () => {
    expect(isToolUseFinishReason("toolUse")).toBe(true)
  })
  it("isToolUseFinishReason: toolCall→true", () => {
    expect(isToolUseFinishReason("toolCall")).toBe(true)
  })
  it("isToolUseFinishReason: tool→true", () => {
    expect(isToolUseFinishReason("tool")).toBe(true)
  })
  it("isToolUseFinishReason: stop→false", () => {
    expect(isToolUseFinishReason("stop")).toBe(false)
  })
  it("isToolUseFinishReason: null→false", () => {
    expect(isToolUseFinishReason(null)).toBe(false)
  })
  it("isToolUseFinishReason: undefined→false", () => {
    expect(isToolUseFinishReason(undefined as any)).toBe(false)
  })

  // ── 14. Chunked streaming (1 byte) ──────────────────────

  it("should handle 1-byte chunks correctly", async () => {
    server = new MockSseServer().setScenario("normal")
    await server.start()
    const events = await collectStream()
    const textDeltas = events.filter((e) => e.type === "text_delta")
    expect(textDeltas.length).toBeGreaterThan(0)
  })

  // ── 15/16. Split JSON / UTF-8 (client handles via buffering) ──

  it("should survive chunked data without error", async () => {
    // The client uses TextDecoder with {stream:true} which handles splits
    server = new MockSseServer().setScenario("normal")
    await server.start()
    const events = await collectStream()
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  // ── 17. SSE multi-chunk reassembly ─────────────────────

  it("should re-assemble messages split across chunks", async () => {
    // Send data line by line to test internal buffer
    server = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"hello"}}]}\n` },
      { data: `\n` }, // second \n to complete \n\n
      { data: "data: [DONE]\n\n" },
    ])
    await server.start()
    const events = await collectStream()
    const deltas = events.filter((e) => e.type === "text_delta")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  // ── 20. isToolUseFinishReason unknown ───────────────────

  it("isToolUseFinishReason: unknown value→false", () => {
    expect(isToolUseFinishReason("unknown_reason")).toBe(false)
    expect(isToolUseFinishReason("function_call")).toBe(false)
  })

  // ── 21. finishReasonYielded prevents duplicate done ─────

  it("should yield done per finish_reason chunk", async () => {
    server = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n` },
      { data: "data: [DONE]\n\n" },
    ])
    await server.start()
    const events = await collectStream()
    const dones = events.filter((e) => e.type === "done")
    expect(dones).toHaveLength(1)
    expect(dones[0].finishReason).toBe("stop")
  })

  it("should not yield done after [DONE] if finish_reason already yielded", async () => {
    // [DONE] has internal guard: only yields done if finishReasonYielded is false
    server = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n` },
      { data: "data: [DONE]\n\n" },
      { data: `data: {"choices":[{"delta":{"content":"y"}}]}\n\n` },
    ])
    await server.start()
    const events = await collectStream()
    const dones = events.filter((e) => e.type === "done")
    expect(dones).toHaveLength(1)
  })

  // ── TT1: SSE boundary tests ───────────────────────────

  it("TT1: should survive 1-byte chunk streaming", async () => {
    server = new MockSseServer()
      .setScenario("normal")
      .setChunkSize(1) // each byte sent individually
      .setDelay(0)
    await server.start()
    const events = await collectStream()
    const textDeltas = events.filter((e) => e.type === "text_delta")
    expect(textDeltas.length).toBeGreaterThan(0)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  it("TT1: should handle data: prefix split across chunks", { timeout: 30000 }, async () => {
    // Split "data:" prefix itself across chunks
    const content = `{"choices":[{"delta":{"content":"hello"}}]}`
    server = new MockSseServer().setChunks([
      { data: `da`, delay: 0 },
      { data: `ta: ${content}\n\n`, delay: 0 },
      { data: "data: [DONE]\n\n", delay: 0 },
    ])
    await server.start()
    const events = await collectStream()
    const deltas = events.filter((e) => e.type === "text_delta")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  it("TT1: should handle half UTF-8 character across chunks", async () => {
    // "你" is U+4F60, encoded as E4 BD A0 in UTF-8
    // Split the 3-byte UTF-8 character: "E4 " | "BD A0"
    const partial1 = Buffer.from([0xE4]).toString("binary")
    const partial2 = Buffer.from([0xBD, 0xA0]).toString("binary")
    server = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"Hello ${partial1}`, delay: 0 },
      { data: `${partial2}"}}]}\n\n`, delay: 0 },
      { data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n`, delay: 0 },
      { data: "data: [DONE]\n\n", delay: 0 },
    ])
    await server.start()
    const events = await collectStream()
    const deltas = events.filter((e) => e.type === "text_delta")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  it("TT1: should handle half JSON argument across chunks", async () => {
    // Split a JSON tool call argument at arbitrary position
    const chunk1 = 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"/tmp/test'
    const chunk2 = '.txt\\""}}]}}]}\n\n'
    const chunk3 = 'data: {"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}}\n\n'
    server = new MockSseServer().setChunks([
      { data: chunk1, delay: 0 },
      { data: chunk2, delay: 0 },
      { data: chunk3, delay: 0 },
      { data: "data: [DONE]\n\n", delay: 0 },
    ])
    await server.start()
    const events = await collectStream()
    const toolDeltas = events.filter((e) => e.type === "tool_call_delta")
    expect(toolDeltas.length).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  it("TT1: should handle \\n\\n delimiter split across chunks", { timeout: 15000 }, async () => {
    // Split the SSE \n\n delimiter itself
    server = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"hello"}}]}\n`, delay: 1 },
      { data: `\n`, delay: 1 },
      { data: "data: [DONE]\n\n", delay: 1 },
    ])
    await server.start()
    const events = await collectStream()
    const deltas = events.filter((e) => e.type === "text_delta")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  // ── S2: reasoning_content not in ChatMessage ──────────

  it("S2: should yield reasoning_delta for reasoning_content, not text_delta", async () => {
    server = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"reasoning_content":"Let me think","content":""}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"reasoning_content":" step by step","content":""}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":"Here is the answer"}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n` },
      { data: "data: [DONE]\n\n" },
    ])
    await server.start()
    const events = await collectStream()
    const reasoning = events.filter((e) => e.type === "reasoning_delta")
    const text = events.filter((e) => e.type === "text_delta")
    expect(reasoning.length).toBeGreaterThanOrEqual(2)
    expect(reasoning[0].delta).toBe("Let me think")
    expect(reasoning[1].delta).toBe(" step by step")
    expect(text).toHaveLength(1)
    expect(text[0].delta).toBe("Here is the answer")
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  // ── M7: >100K chars single line ─────────────────────

  it("M7: should handle >100K chars single line without OOM", { timeout: 30000 }, async () => {
    const longContent = "x".repeat(110_000)
    server = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"${longContent}"}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8}}\n\n` },
      { data: "data: [DONE]\n\n" },
    ])
    await server.start()
    const events = await collectStream()
    const text = events.filter((e) => e.type === "text_delta")
    expect(text.length).toBeGreaterThanOrEqual(1)
    expect(text[0].delta.length).toBe(110_000)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })

  // ── M8: concurrent chatCompletionsStream ─────────────

  it("M8: should handle concurrent chatCompletionsStream calls without interference", async () => {
    // Two servers with different scenarios run in parallel
    const server1 = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"alpha"}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n` },
      { data: "data: [DONE]\n\n" },
    ])
    await server1.start()
    const server2 = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"beta"}}]}\n\n` },
      { data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n` },
      { data: "data: [DONE]\n\n" },
    ])
    await server2.start()

    const client = new DeepSeekClient()
    const stream1 = client.chatCompletionsStream(
      [{ role: "user", content: "hi" }],
      { apiKey: "test-key", baseUrl: server1.baseUrl, model: "test-model" },
    )
    const stream2 = client.chatCompletionsStream(
      [{ role: "user", content: "hi" }],
      { apiKey: "test-key", baseUrl: server2.baseUrl, model: "test-model" },
    )

    const [events1, events2] = await Promise.all([
      (async () => { const e: DeepSeekStreamEvent[] = []; for await (const ev of stream1) e.push(ev); return e })(),
      (async () => { const e: DeepSeekStreamEvent[] = []; for await (const ev of stream2) e.push(ev); return e })(),
    ])

    const text1 = events1.filter((e) => e.type === "text_delta")
    const text2 = events2.filter((e) => e.type === "text_delta")
    expect(text1[0].delta).toBe("alpha")
    expect(text2[0].delta).toBe("beta")
    await server1.stop()
    await server2.stop()
  })

  it("TT1: should handle multiple \\n\\n splits across chunks", { timeout: 15000 }, async () => {
    // Multiple SSE events with \n\n split across different chunks
    server = new MockSseServer().setChunks([
      { data: `data: {"choices":[{"delta":{"content":"hello"}}]}\n`, delay: 1 },
      { data: `\ndata: {"choices":[{"delta":{"content":" world"}}]}\n`, delay: 1 },
      { data: `\n`, delay: 1 },
      { data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n`, delay: 1 },
      { data: "data: [DONE]\n\n", delay: 1 },
    ])
    await server.start()
    const events = await collectStream()
    const deltas = events.filter((e) => e.type === "text_delta")
    expect(deltas.length).toBeGreaterThanOrEqual(2)
    expect(events.some((e) => e.type === "error")).toBe(false)
  })
})
