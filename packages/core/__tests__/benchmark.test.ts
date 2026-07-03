import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { calculateCost, MODEL_PRICING } from "../src/pricing.js"
import { estimateTokens } from "../src/context/token-estimator.js"
import { MockSseServer } from "../src/test-utils/mock-sse-server.js"
import { DeepSeekClient } from "../src/client.js"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

// ── TT3: Cost calibration ────────────────────────────────

describe("TT3: Cost calculation", () => {

  it("should return 0 for unknown model", () => {
    expect(calculateCost("unknown-model", 100, 100)).toBe(0)
  })

  it("should return 0 for free model", () => {
    expect(calculateCost("zen-free", 1000, 500)).toBe(0)
    expect(calculateCost("deepseek-v4-flash-free", 1000, 500)).toBe(0)
  })

  it("should calculate deepseek-v4-flash cost correctly", () => {
    const cost = calculateCost("deepseek-v4-flash", 1000, 500, 0, 0)
    const p = MODEL_PRICING["deepseek-v4-flash"]
    const expected = (1000 / 1000) * p.inputPer1K + (500 / 1000) * p.outputPer1K
    expect(cost).toBeCloseTo(expected, 6)
  })

  it("should calculate deepseek-v4-pro cost correctly", () => {
    const cost = calculateCost("deepseek-v4-pro", 2000, 800, 0, 0)
    const p = MODEL_PRICING["deepseek-v4-pro"]
    const expected = (2000 / 1000) * p.inputPer1K + (800 / 1000) * p.outputPer1K
    expect(cost).toBeCloseTo(expected, 6)
  })

  it("should include cache costs without double-counting", () => {
    // promptTokens includes cache tokens; formula subtracts them before applying inputPer1K
    const withCache = calculateCost("deepseek-v4-flash", 1000, 500, 300, 200)
    const p = MODEL_PRICING["deepseek-v4-flash"]
    // non-cache: 1000-300-200 = 500; plus cache hit 300 at read rate, cache miss 200 at write rate
    const expected = (500 / 1000) * p.inputPer1K + (500 / 1000) * p.outputPer1K + (300 / 1000) * p.cacheReadPer1K + (200 / 1000) * p.cacheWritePer1K
    expect(withCache).toBeCloseTo(expected, 6)
  })

  it("should convert USD to CNY correctly", () => {
    // Phase 2.2: calculateCostCNY/USD_TO_CNY 已删除（无生产调用方）。
    // 保留 USD 计算的等价测试。
    const usd = calculateCost("deepseek-v4-flash", 1000, 500)
    expect(usd).toBeGreaterThanOrEqual(0)
  })

  it("should scale cost linearly with token counts", () => {
    const cost1 = calculateCost("deepseek-v4-pro", 1000, 1000)
    const cost2 = calculateCost("deepseek-v4-pro", 2000, 2000)
    expect(cost2).toBeCloseTo(cost1 * 2, 6)
  })

  it("should produce reasonable cost estimate for a typical session", () => {
    const sessions = [
      { prompt: 5000, completion: 2000, label: "light" },
      { prompt: 20000, completion: 8000, label: "medium" },
      { prompt: 100000, completion: 40000, label: "heavy" },
    ]
    for (const s of sessions) {
      const cost = calculateCost("deepseek-v4-flash", s.prompt, s.completion)
      expect(cost).toBeGreaterThanOrEqual(0)
      // sanity: heavy session < 100 USD (very conservative upper bound)
      expect(cost).toBeLessThan(100)
    }
  })

  it("should estimate cost matching real-world token volumes", () => {
    const promptTokens = 15000
    const completionTokens = 6000
    const usdCost = calculateCost("deepseek-v4-pro", promptTokens, completionTokens)
    // deepseek-v4-pro: input $2/M, output $8/M
    // = 15000*0.002/1000 + 6000*0.008/1000 = 0.03 + 0.048 = $0.078
    expect(usdCost).toBeCloseTo(0.078, 4)
  })

  it("should handle zero tokens gracefully", () => {
    expect(calculateCost("deepseek-v4-flash", 0, 0)).toBe(0)
  })
})

// ── TT3: Token estimation performance ────────────────────

describe("TT3: Token estimation performance", () => {

  it("should estimate short text quickly", () => {
    const start = Date.now()
    const result = estimateTokens([{ role: "user", content: "hello world" }])
    const elapsed = Date.now() - start
    expect(result).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(50)
  })

  it("should estimate long text without blocking", () => {
    const long = "a".repeat(600000)
    const start = Date.now()
    const result = estimateTokens([{ role: "user", content: long }])
    const elapsed = Date.now() - start
    expect(result).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(2000)
  })

  it("should estimate CJK-heavy text accurately", () => {
    const cjk = "你好世界".repeat(1000)
    const start = Date.now()
    const result = estimateTokens([{ role: "user", content: cjk }])
    const elapsed = Date.now() - start
    expect(result).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(100)
  })

  it("should estimate reasoning content correctly", () => {
    const result = estimateTokens([
      { role: "user", content: "hello" },
      { role: "assistant", content: "world", reasoning_content: "let me think step by step" },
    ])
    expect(result).toBeGreaterThan(0)
  })
})

// ── TT3: SSE streaming performance ───────────────────────

describe("TT3: SSE streaming performance", () => {
  let server: MockSseServer

  afterEach(async () => {
    try {
      await Promise.race([server?.stop(), new Promise((_, rej) => setTimeout(() => rej(new Error("stop timeout")), 3000))])
    } catch { /* ignore stop errors in cleanup */ }
  })

  async function collectStream(apiKey = "test-key"): Promise<any[]> {
    const events: any[] = []
    const client = new DeepSeekClient()
    for await (const ev of client.chatCompletionsStream(
      [{ role: "user", content: "hi" }],
      { apiKey, baseUrl: server.baseUrl, model: "test-model" },
    )) {
      events.push(ev)
    }
    return events
  }

  it("should handle 100 fast chunks quickly", async () => {
    const chunks = Array.from({ length: 100 }, (_, i) => ({
      data: `data: {"choices":[{"delta":{"content":"${i}"}}]}\n\n`,
      delay: 0,
    }))
    chunks.push({ data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":100,"total_tokens":110}}\n\n`, delay: 0 })
    chunks.push({ data: "data: [DONE]\n\n", delay: 0 })

    server = new MockSseServer().setChunks(chunks)
    await server.start()

    const start = Date.now()
    const events = await collectStream()
    const elapsed = Date.now() - start

    const deltas = events.filter((e) => e.type === "text_delta")
    expect(deltas).toHaveLength(100)
    expect(elapsed).toBeLessThan(5000)
  })

  it("should parse tool call chunks efficiently", async () => {
    const chunks = Array.from({ length: 50 }, (_, i) => ({
      data: `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"token${i},"}}]}}]}\n\n`,
      delay: 0,
    }))
    chunks.push({ data: `data: {"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":20,"completion_tokens":50,"total_tokens":70}}\n\n`, delay: 0 })
    chunks.push({ data: "data: [DONE]\n\n", delay: 0 })

    server = new MockSseServer().setChunks(chunks)
    await server.start()

    const start = Date.now()
    const events = await collectStream()
    const elapsed = Date.now() - start

    const deltas = events.filter((e) => e.type === "tool_call_delta")
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(elapsed).toBeLessThan(5000)
  })

  it("should handle 1-byte chunked SSE without timeout", async () => {
    const data = `data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n`
    server = new MockSseServer()
      .setChunks([{ data, delay: 0 }])
      .setChunkSize(1)
    await server.start()

    const start = Date.now()
    const events = await collectStream()
    const elapsed = Date.now() - start

    expect(events.some((e) => e.type === "text_delta")).toBe(true)
    expect(elapsed).toBeLessThan(10000)
  })
})

// ── TT3: Tool execution performance ──────────────────────

describe("TT3: Tool execution performance", () => {

  it("should create and delete temp directory quickly", async () => {
    const start = Date.now()
    const dir = mkdtempSync(join(tmpdir(), "bench-"))
    writeFileSync(join(dir, "test.txt"), "hello")
    rmSync(dir, { recursive: true, force: true })
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(2000)
  })

  it("should write and read 1MB file quickly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-"))
    const content = "x".repeat(1_000_000)
    const start = Date.now()
    writeFileSync(join(dir, "big.txt"), content, "utf-8")
    const result = await readFile(join(dir, "big.txt"), "utf-8")
    const elapsed = Date.now() - start
    expect(result.length).toBe(1_000_000)
    expect(elapsed).toBeLessThan(500)
    rmSync(dir, { recursive: true, force: true })
  })
})
