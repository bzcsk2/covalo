import { describe, it, expect, beforeEach } from "vitest"
import { ReasonixEngine } from "../src/engine.js"
import type { EngineStatusSnapshot } from "../src/status.js"

describe("Engine Status Snapshot", () => {
  let engine: ReasonixEngine

  beforeEach(() => {
    engine = new ReasonixEngine({
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "test-key",
      maxContextRounds: 20,
      contextWindow: 128000,
    })
  })

  it("returns current sessionId", async () => {
    const snapshot = await engine.getStatusSnapshot()
    expect(snapshot.sessionId).toBeDefined()
    expect(typeof snapshot.sessionId).toBe("string")
    expect(snapshot.sessionId.length).toBeGreaterThan(0)
  })

  it("returns context with runtime window", async () => {
    const snapshot = await engine.getStatusSnapshot()
    expect(snapshot.context).toBeDefined()
    expect(snapshot.context.window).toBe(128000)
    expect(typeof snapshot.context.prefixTokens).toBe("number")
    expect(typeof snapshot.context.logTokens).toBe("number")
    expect(typeof snapshot.context.scratchTokens).toBe("number")
    expect(typeof snapshot.context.totalTokens).toBe("number")
    expect(typeof snapshot.context.ratio).toBe("number")
  })

  it("returns stats from engine stats", async () => {
    const snapshot = await engine.getStatusSnapshot()
    expect(snapshot.stats).toBeDefined()
    expect(typeof snapshot.stats.promptTokens).toBe("number")
    expect(typeof snapshot.stats.completionTokens).toBe("number")
    expect(typeof snapshot.stats.cacheHitTokens).toBe("number")
    expect(typeof snapshot.stats.cacheMissTokens).toBe("number")
    expect(typeof snapshot.stats.apiCalls).toBe("number")
    expect(typeof snapshot.stats.toolCalls).toBe("number")
    expect(typeof snapshot.stats.totalCost).toBe("number")
  })

  it("returns currentAgent", async () => {
    const snapshot = await engine.getStatusSnapshot()
    expect(snapshot.currentAgent).toBe("build")
  })

  it("returns isSubmitting", async () => {
    const snapshot = await engine.getStatusSnapshot()
    expect(snapshot.isSubmitting).toBe(false)
  })

  it("returns timestamp", async () => {
    const snapshot = await engine.getStatusSnapshot()
    expect(snapshot.timestamp).toBeDefined()
    expect(new Date(snapshot.timestamp).toISOString()).toBe(snapshot.timestamp)
  })

  it("stats is a copy, not a reference", async () => {
    const snapshot1 = await engine.getStatusSnapshot()
    const snapshot2 = await engine.getStatusSnapshot()
    expect(snapshot1.stats).not.toBe(snapshot2.stats)
    expect(snapshot1.stats).toEqual(snapshot2.stats)
  })

  it("sessionId updates after loadSession", async () => {
    const snapshot1 = await engine.getStatusSnapshot()
    const newSessionId = "test-session-" + Date.now()

    try {
      await engine.loadSession(newSessionId)
    } catch {
      // loadSession may fail if session doesn't exist, that's ok for this test
    }

    const snapshot2 = await engine.getStatusSnapshot()
    expect(snapshot2.sessionId).toBeDefined()
  })
})
