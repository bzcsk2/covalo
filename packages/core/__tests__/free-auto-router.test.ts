import { describe, expect, it, beforeEach } from "vitest"
import {
  recordRateLimitHit,
  recordSuccess,
  getPenalty,
  setCooldown,
  isOnCooldown,
  isProviderOnCooldown,
  isRetryableError,
  classifyTask,
  applyCooldown,
  recordRouteSuccess,
  recordRouteFailure,
  getRouteHealth,
} from "../src/free-auto/router.js"

describe("Free Auto Router", () => {
  describe("429 penalty", () => {
    beforeEach(() => {
      // Reset penalty state by hitting a unique key each test
    })

    it("records a 429 hit and increases penalty", () => {
      recordRateLimitHit("kilo:test-429")
      expect(getPenalty("kilo:test-429")).toBe(3)
    })

    it("accumulates penalty on multiple hits", () => {
      recordRateLimitHit("kilo:test-accum")
      recordRateLimitHit("kilo:test-accum")
      expect(getPenalty("kilo:test-accum")).toBe(6)
    })

    it("caps penalty at MAX_PENALTY (10)", () => {
      for (let i = 0; i < 10; i++) {
        recordRateLimitHit("kilo:nemotron")
      }
      expect(getPenalty("kilo:nemotron")).toBeLessThanOrEqual(10)
    })

    it("decreases penalty on success", () => {
      recordRateLimitHit("kilo:test-success")
      recordRateLimitHit("kilo:test-success")
      expect(getPenalty("kilo:test-success")).toBe(6)
      recordSuccess("kilo:test-success")
      expect(getPenalty("kilo:test-success")).toBe(5)
    })
  })

  describe("cooldown", () => {
    it("sets and checks cooldown for a route key", () => {
      setCooldown("kilo:test-cooldown", 10000)
      expect(isOnCooldown("kilo:test-cooldown")).toBe(true)
    })

    it("expired cooldown returns false", () => {
      setCooldown("kilo:test-expired", -1)
      expect(isOnCooldown("kilo:test-expired")).toBe(false)
    })

    it("provider-level cooldown is separate from model-level", () => {
      const providerKey = "test-provider-" + Date.now()
      setCooldown(providerKey, 10000, true)
      expect(isOnCooldown(providerKey, true)).toBe(true)
      expect(isOnCooldown(`${providerKey}:some-model`)).toBe(false)
    })
  })

  describe("applyCooldown", () => {
    it("429 applies provider-level short cooldown", () => {
      applyCooldown("kilo:test-429", "kilo", 429)
      expect(isProviderOnCooldown("kilo")).toBe(true)
      expect(getPenalty("kilo:test-429")).toBeGreaterThan(0)
    })

    it("402 applies route-level long cooldown", () => {
      applyCooldown("kilo:test-402", "kilo", 402)
      expect(isOnCooldown("kilo:test-402")).toBe(true)
    })
  })

  describe("health tracking", () => {
    it("records success and clears failures", () => {
      const healthKey = "health-" + Date.now()
      recordRouteFailure(healthKey)
      recordRouteFailure(healthKey)
      const before = getRouteHealth(healthKey)
      expect(before?.consecutiveFailures).toBe(2)

      recordRouteSuccess(healthKey, 1500)
      const after = getRouteHealth(healthKey)
      expect(after?.consecutiveFailures).toBe(0)
      expect(after?.lastLatencyMs).toBe(1500)
    })
  })

  describe("retryable error classification", () => {
    it("classifies 429 as retryable", () => {
      expect(isRetryableError({ status: 429, message: "Rate limit" })).toBe(true)
    })

    it("classifies 5xx as retryable", () => {
      expect(isRetryableError({ status: 502, message: "Bad gateway" })).toBe(true)
      expect(isRetryableError({ status: 503, message: "Service unavailable" })).toBe(true)
    })

    it("classifies 400 as non-retryable", () => {
      expect(isRetryableError({ status: 400, message: "Bad request" })).toBe(false)
    })

    it("classifies timeout as retryable", () => {
      expect(isRetryableError({ message: "timeout of 15000ms exceeded" })).toBe(true)
      expect(isRetryableError({ message: "etimedout connect" })).toBe(true)
    })

    it("stream stall/unexpected end is retryable", () => {
      expect(isRetryableError({ message: "stream ended unexpectedly" })).toBe(true)
      expect(isRetryableError({ message: "stream stalled" })).toBe(true)
    })
  })

  describe("task classification", () => {
    it("classifies coding task when tools present", () => {
      expect(classifyTask({ hasTools: true, messageCount: 1, estimatedInputLength: 100, toolCallRounds: 0 })).toBe("coding")
    })

    it("classifies complex task for long input", () => {
      expect(classifyTask({ hasTools: false, messageCount: 5, estimatedInputLength: 5000, toolCallRounds: 0 })).toBe("complex")
    })

    it("classifies simple task for short input without tools", () => {
      expect(classifyTask({ hasTools: false, messageCount: 1, estimatedInputLength: 100, toolCallRounds: 0 })).toBe("simple")
    })
  })
})
