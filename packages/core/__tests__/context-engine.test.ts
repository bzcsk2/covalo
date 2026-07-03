import { describe, it, expect, vi } from "vitest"
import { ContextManager } from "../src/context/manager.js"
import { VolatileScratch } from "../src/context/scratch.js"

vi.mock("../src/context/tokenizer-pool.js", () => ({
  TokenizerPool: class {
    healthy = true; fallbackCount = 0; timeoutCount = 0; workerErrorCount = 0
    lastFallbackReason: string | undefined
    tasks = new Map()
    estimate(m: any[]) { return Promise.resolve(100) }
    resolvePendingWithFallback() {}
  },
}))

describe("SPEC-A: clearTransientState", () => {
  it("clears scratch", () => { const c = new ContextManager(16000, 0); c.scratch.append({ role: "user", content: "t" }); expect(c.scratch.messages.length).toBe(1); c.clearTransientState(); expect(c.scratch.messages.length).toBe(0) })
  it("clears summary", () => { const c = new ContextManager(16000, 0); c.getSummary().replace("s"); expect(c.getSummary().getRawContent()).toBe("s"); c.clearTransientState(); expect(c.getSummary().getRawContent()).toBe("") })
})

describe("SPEC-B: VolatileScratch source-aware", () => {
  it("replaceSource preserves other sources", () => { const s = new VolatileScratch(); s.append({ role: "user", content: "l" }, "task_ledger"); s.append({ role: "user", content: "a" }, "supervisor_advice"); s.append({ role: "user", content: "r" }); s.replaceSource("task_ledger", [{ role: "user", content: "n" }]); const m = s.messages; expect(m.some(x => x.content === "n")).toBe(true); expect(m.some(x => x.content === "a")).toBe(true); expect(m.some(x => x.content === "r")).toBe(true); expect(m.some(x => x.content === "l")).toBe(false) })
  it("removeSource removes only matching", () => { const s = new VolatileScratch(); s.append({ role: "user", content: "x" }, "task_ledger"); s.append({ role: "user", content: "y" }, "supervisor_advice"); s.removeSource("task_ledger"); const m = s.messages; expect(m.some(x => x.content === "x")).toBe(false); expect(m.some(x => x.content === "y")).toBe(true) })
  it("reset clears all", () => { const s = new VolatileScratch(); s.append({ role: "user", content: "a" }, "task_ledger"); s.append({ role: "user", content: "b" }, "supervisor_advice"); s.reset(); expect(s.messages.length).toBe(0) })
  it("append defaults to runtime", () => { const s = new VolatileScratch(); s.append({ role: "user", content: "d" }); expect(s.messages.length).toBe(1); expect(s.messages[0].content).toBe("d") })
})
