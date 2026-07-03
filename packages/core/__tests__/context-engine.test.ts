import { describe, it, expect, vi } from "vitest"
import { ContextManager } from "../src/context/manager.js"
import { VolatileScratch } from "../src/context/scratch.js"

vi.mock("../src/context/tokenizer-pool.js", () => ({
  TokenizerPool: class {
    healthy = true
    fallbackCount = 0
    timeoutCount = 0
    workerErrorCount = 0
    lastFallbackReason: string | undefined
    tasks = new Map()
    estimate(messages: any[]) { return Promise.resolve(100) }
    resolvePendingWithFallback() {}
  },
}))

describe("SPEC-A: clearTransientState", () => {
  it("clears scratch messages", () => {
    const ctx = new ContextManager(16000, 0)
    ctx.scratch.append({ role: "user", content: "temp data" })
    expect(ctx.scratch.messages.length).toBe(1)
    ctx.clearTransientState()
    expect(ctx.scratch.messages.length).toBe(0)
  })
  it("clears summary after clearTransientState", () => {
    const ctx = new ContextManager(16000, 0)
    ctx.getSummary().replace("stale summary")
    expect(ctx.getSummary().getRawContent()).toBe("stale summary")
    ctx.clearTransientState()
    expect(ctx.getSummary().getRawContent()).toBe("")
  })
})

describe("SPEC-B: VolatileScratch source-aware operations", () => {
  it("replaceSource replaces only matching source, preserves others", () => {
    const scratch = new VolatileScratch()
    scratch.append({ role: "user", content: "ledger" }, "task_ledger")
    scratch.append({ role: "user", content: "advice" }, "supervisor_advice")
    scratch.append({ role: "user", content: "runtime" })
    scratch.replaceSource("task_ledger", [{ role: "user", content: "new ledger" }])
    const msgs = scratch.messages
    expect(msgs.some(m => m.content === "new ledger")).toBe(true)
    expect(msgs.some(m => m.content === "advice")).toBe(true)
    expect(msgs.some(m => m.content === "runtime")).toBe(true)
    expect(msgs.some(m => m.content === "ledger")).toBe(false)
  })
  it("removeSource removes only matching source", () => {
    const scratch = new VolatileScratch()
    scratch.append({ role: "user", content: "x" }, "task_ledger")
    scratch.append({ role: "user", content: "y" }, "supervisor_advice")
    scratch.removeSource("task_ledger")
    const msgs = scratch.messages
    expect(msgs.some(m => m.content === "x")).toBe(false)
    expect(msgs.some(m => m.content === "y")).toBe(true)
  })
  it("reset clears all entries", () => {
    const scratch = new VolatileScratch()
    scratch.append({ role: "user", content: "a" }, "task_ledger")
    scratch.append({ role: "user", content: "b" }, "supervisor_advice")
    scratch.reset()
    expect(scratch.messages.length).toBe(0)
  })
  it("default source is runtime", () => {
    const scratch = new VolatileScratch()
    scratch.append({ role: "user", content: "default" })
    expect(scratch.messages.length).toBe(1)
    expect(scratch.messages[0].content).toBe("default")
  })
})
