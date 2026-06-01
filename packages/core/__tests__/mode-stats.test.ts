import { describe, it, expect } from "vitest"
import { createModeStats, logModeSwitch, getModeSummary } from "../src/mode-stats.js"

describe("AS6: Mode statistics and calibration", () => {
  it("createModeStats initializes with zero values", () => {
    const stats = createModeStats()
    expect(stats.totalSwitches).toBe(0)
    expect(stats.switchesByReason).toEqual({})
    expect(stats.timeInMode).toEqual({ off: 0, low: 0, medium: 0, high: 0, max: 0 })
    expect(stats.lastSwitch).toBeNull()
  })

  it("logModeSwitch increments total and tracks reason", () => {
    const stats = createModeStats()
    logModeSwitch(stats, "off", "high", "simple_query_enable_thinking", 1000)
    expect(stats.totalSwitches).toBe(1)
    expect(stats.switchesByReason["simple_query_enable_thinking"]).toBe(1)
    expect(stats.lastSwitch).toMatchObject({ from: "off", to: "high", reason: "simple_query_enable_thinking" })
  })

  it("logModeSwitch tracks time in mode", () => {
    const stats = createModeStats()
    logModeSwitch(stats, "off", "high", "switch_1", 1000)
    logModeSwitch(stats, "high", "off", "switch_2", 5000)
    expect(stats.timeInMode["high"]).toBe(4000)
  })

  it("logModeSwitch accumulates multiple switches", () => {
    const stats = createModeStats()
    logModeSwitch(stats, "off", "high", "reason_a", 1000)
    logModeSwitch(stats, "high", "off", "reason_b", 2000)
    logModeSwitch(stats, "off", "high", "reason_a", 3000)
    expect(stats.totalSwitches).toBe(3)
    expect(stats.switchesByReason["reason_a"]).toBe(2)
    expect(stats.switchesByReason["reason_b"]).toBe(1)
  })

  it("getModeSummary returns formatted string", () => {
    const stats = createModeStats()
    logModeSwitch(stats, "off", "high", "simple_query", 1000)
    logModeSwitch(stats, "high", "off", "complex_tool_chain", 10000)
    const summary = getModeSummary(stats)
    expect(summary).toContain("Total switches: 2")
    expect(summary).toContain("high:")
    expect(summary).toContain("simple_query: 1")
    expect(summary).toContain("complex_tool_chain: 1")
  })

  it("getModeSummary with no switches", () => {
    const stats = createModeStats()
    const summary = getModeSummary(stats)
    expect(summary).toContain("Total switches: 0")
  })
})
