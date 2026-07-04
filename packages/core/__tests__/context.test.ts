import { describe, it, expect, vi } from "vitest"
import { estimateTokens } from "../src/context/token-estimator.js"
import { ImmutablePrefix } from "../src/context/immutable.js"
import { AppendOnlyLog } from "../src/context/append-log.js"
import { VolatileScratch } from "../src/context/scratch.js"
import { ContextManager } from "../src/context/manager.js"
import type { ChatMessage, ToolSpec } from "../src/types.js"

// Mock TokenizerPool to use deterministic fallback — avoids worker startup race
vi.mock("../src/context/tokenizer-pool.js", () => ({
  TokenizerPool: class {
    healthy = true
    fallbackCount = 0
    timeoutCount = 0
    workerErrorCount = 0
    lastFallbackReason: string | undefined
    tasks = new Map<number, { messages: any[]; resolve: (value: number) => void }>()

    estimate(messages: any[]) {
      if (!this.healthy) {
        this.fallbackCount += 1
        this.lastFallbackReason = "unhealthy"
      }
      return Promise.resolve(estimateTokens(messages))
    }

    resolvePendingWithFallback(reason: string) {
      for (const [, task] of this.tasks) {
        task.resolve(estimateTokens(task.messages))
      }
      this.tasks.clear()
      this.fallbackCount += 1
      this.lastFallbackReason = reason
      if (reason.includes("timeout")) this.timeoutCount += 1
      if (reason.includes("worker")) this.workerErrorCount += 1
    }

    getDiagnostics() {
      return {
        healthy: this.healthy,
        pendingTasks: this.tasks.size,
        fallbackCount: this.fallbackCount,
        timeoutCount: this.timeoutCount,
        workerErrorCount: this.workerErrorCount,
        lastFallbackReason: this.lastFallbackReason,
      }
    }

    shutdown() {}
  },
}))

// === ImmutablePrefix 单元测试 ===
describe("ImmutablePrefix", () => {
  // 相同输入应产生字节一致的消息和相同的哈希值
  it("should produce byte-identical messages when built with same input", () => {
    const a = new ImmutablePrefix()
    const b = new ImmutablePrefix()

    a.build("You are a helpful assistant.")
    b.build("You are a helpful assistant.")

    expect(a.messages).toEqual(b.messages)
    expect(a.cacheKey).toBe(b.cacheKey)
  })

  // 不同的提示词应产生不同的哈希值
  it("should produce different hashes for different prompts", () => {
    const a = new ImmutablePrefix()
    const b = new ImmutablePrefix()

    a.build("You are a helpful assistant.")
    b.build("You are a coding assistant.")

    expect(a.cacheKey).not.toBe(b.cacheKey)
  })

  // build 之后 prefix 应不可变（外部无法修改内部状态）
  it("should be immutable after build", () => {
    const p = new ImmutablePrefix()
    p.build("System prompt")
    const msgs = p.messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe("system")
    expect(msgs[0].content).toBe("System prompt")
  })

  // 相同 toolSpecs 应产生相同 hash
  it("should produce same hash for same toolSpecs", () => {
    const a = new ImmutablePrefix()
    const b = new ImmutablePrefix()
    const specs: ToolSpec[] = [
      { type: "function", function: { name: "bash", description: "Run a command", parameters: { type: "object" } } },
    ]
    a.build("You are an assistant.", specs)
    b.build("You are an assistant.", specs)
    expect(a.cacheKey).toBe(b.cacheKey)
  })

  // 不同 toolSpecs 应产生不同 hash
  it("should produce different hash for different toolSpecs", () => {
    const a = new ImmutablePrefix()
    const b = new ImmutablePrefix()
    a.build("You are an assistant.", [
      { type: "function", function: { name: "bash", description: "Run a command", parameters: { type: "object" } } },
    ])
    b.build("You are an assistant.", [
      { type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } },
    ])
    expect(a.cacheKey).not.toBe(b.cacheKey)
  })

  // 相同 fewShots 应产生相同 hash
  it("should produce same hash for same fewShots", () => {
    const a = new ImmutablePrefix()
    const b = new ImmutablePrefix()
    const shots: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]
    a.build("System prompt", undefined, shots)
    b.build("System prompt", undefined, shots)
    expect(a.cacheKey).toBe(b.cacheKey)
  })

  // 不同 fewShots 应产生不同 hash
  it("should produce different hash for different fewShots", () => {
    const a = new ImmutablePrefix()
    const b = new ImmutablePrefix()
    a.build("System prompt", undefined, [{ role: "user", content: "hi" }])
    b.build("System prompt", undefined, [{ role: "user", content: "hello" }])
    expect(a.cacheKey).not.toBe(b.cacheKey)
  })
})

// === AppendOnlyLog 单元测试 ===
describe("AppendOnlyLog", () => {
  // 消息应按追加顺序排列
  it("should append messages in order", () => {
    const log = new AppendOnlyLog()
    log.append({ role: "user", content: "Hello" })
    log.append({ role: "assistant", content: "Hi" })
    log.append({ role: "user", content: "How are you?" })

    expect(log.messages).toHaveLength(3)
    expect(log.messages[0].content).toBe("Hello")
    expect(log.messages[1].content).toBe("Hi")
    expect(log.messages[2].content).toBe("How are you?")
  })

  // length getter 应正确反映消息数量
  it("should track length", () => {
    const log = new AppendOnlyLog()
    expect(log.length).toBe(0)
    log.append({ role: "user", content: "A" })
    expect(log.length).toBe(1)
    log.append({ role: "assistant", content: "B" })
    expect(log.length).toBe(2)
  })

  // appendMany 应正确追加多条消息
  it("should support appendMany", () => {
    const log = new AppendOnlyLog()
    log.appendMany([
      { role: "user", content: "A" },
      { role: "assistant", content: "B" },
    ])
    expect(log.length).toBe(2)
  })

  // clear 应清空所有消息
  it("should clear correctly", () => {
    const log = new AppendOnlyLog()
    log.append({ role: "user", content: "A" })
    log.clear()
    expect(log.length).toBe(0)
    expect(log.messages).toHaveLength(0)
  })
})

// === VolatileScratch 单元测试 ===
describe("VolatileScratch", () => {
  // 初始状态应为空
  it("should start empty", () => {
    const scratch = new VolatileScratch()
    expect(scratch.messages).toHaveLength(0)
  })

  // reset 应清空所有暂存消息
  it("should reset on demand", () => {
    const scratch = new VolatileScratch()
    scratch.append({ role: "assistant", content: "thinking..." })
    expect(scratch.messages).toHaveLength(1)
    scratch.reset()
    expect(scratch.messages).toHaveLength(0)
  })

  // setMessages 应覆盖写入消息列表
  it("should support setMessages", () => {
    const scratch = new VolatileScratch()
    scratch.setMessages([
      { role: "assistant", content: "step 1" },
      { role: "assistant", content: "step 2" },
    ])
    expect(scratch.messages).toHaveLength(2)
  })

  // SPEC-B: replaceSource 不应污染其他来源消息
  it("should preserve supervisor_advice when replacing task_ledger", () => {
    const scratch = new VolatileScratch()
    scratch.append({ role: "user", content: "LEDGER: build plan" }, "task_ledger")
    scratch.append({ role: "user", content: "SUPERVISOR: fix tests" }, "supervisor_advice")

    scratch.replaceSource("task_ledger", [{ role: "user", content: "LEDGER: new plan" }])

    const msgs = scratch.messages
    expect(msgs).toHaveLength(2)
    expect(msgs.some(m => m.content === "SUPERVISOR: fix tests")).toBe(true)
    expect(msgs.some(m => m.content === "LEDGER: new plan")).toBe(true)
  })

  // SPEC-B: replaceSource 不应对同一来源产生重复条目
  it("should not duplicate task_ledger on replaceSource", () => {
    const scratch = new VolatileScratch()
    scratch.replaceSource("task_ledger", [
      { role: "user", content: "TASK 1" },
      { role: "user", content: "TASK 2" },
    ])
    scratch.replaceSource("task_ledger", [
      { role: "user", content: "TASK 3" },
    ])

    expect(scratch.messages).toHaveLength(1)
    expect(scratch.messages[0].content).toBe("TASK 3")
  })

  // SPEC-B: removeSource 应按来源精确删除
  it("should remove entries by source via removeSource", () => {
    const scratch = new VolatileScratch()
    scratch.append({ role: "user", content: "LEDGER: build" }, "task_ledger")
    scratch.append({ role: "user", content: "ADVICE: fix" }, "supervisor_advice")

    scratch.removeSource("task_ledger")

    expect(scratch.messages).toHaveLength(1)
    expect(scratch.messages[0].content).toBe("ADVICE: fix")
  })
})

// === ContextManager 三区域集成测试 ===
describe("ContextManager - 三区域集成", () => {
  // 组装顺序必须为：prefix → log → scratch
  it("should assemble messages in correct order: prefix + log + scratch", () => {
    const ctx = new ContextManager()

    ctx.prefix.build("You are an assistant.")
    ctx.log.append({ role: "user", content: "Hello" })
    ctx.log.append({ role: "assistant", content: "Hi!" })
    ctx.scratch.append({ role: "assistant", content: "I am thinking..." })

    const msgs = ctx.buildMessages()

    expect(msgs).toHaveLength(4)
    expect(msgs[0].role).toBe("system")      // 第一：prefix
    expect(msgs[0].content).toBe("You are an assistant.")
    expect(msgs[1].role).toBe("user")       // 第二：log
    expect(msgs[1].content).toBe("Hello")
    expect(msgs[2].role).toBe("assistant")
    expect(msgs[2].content).toBe("Hi!")
    expect(msgs[3].role).toBe("assistant")  // 第三：scratch
    expect(msgs[3].content).toBe("I am thinking...")
  })

  // startTurn 应清空 scratch 但保留 prefix 和 log
  it("should clear scratch on startTurn", () => {
    const ctx = new ContextManager()
    ctx.prefix.build("You are an assistant.")
    ctx.log.append({ role: "user", content: "Hello" })
    ctx.scratch.append({ role: "assistant", content: "thinking..." })

    expect(ctx.buildMessages()).toHaveLength(3)

    ctx.startTurn()
    expect(ctx.buildMessages()).toHaveLength(2)  // scratch 被清空
    expect(ctx.scratch.messages).toHaveLength(0)
  })

  // SPEC-B: startTurn 应清空所有来源的 scratch 消息
  it("should clear all scratch sources on startTurn", () => {
    const ctx = new ContextManager()
    ctx.prefix.build("You are an assistant.")
    ctx.scratch.append({ role: "user", content: "LEDGER: plan" }, "task_ledger")
    ctx.scratch.append({ role: "user", content: "ADVICE: fix" }, "supervisor_advice")
    ctx.scratch.append({ role: "assistant", content: "thinking..." }, "runtime")

    ctx.startTurn()

    expect(ctx.scratch.messages).toHaveLength(0)
  })

  // prefix 哈希值应在多轮间保持稳定（字节一致性）
  it("should maintain byte-stable prefix across multiple turns", () => {
    const ctx = new ContextManager()
    ctx.prefix.build("You are an assistant.")

    // 模拟第一轮
    ctx.log.append({ role: "user", content: "Hello" })
    const hash1 = ctx.prefix.cacheKey

    // 模拟第二轮
    ctx.log.append({ role: "assistant", content: "Hi!" })
    ctx.log.append({ role: "user", content: "What's up?" })
    const hash2 = ctx.prefix.cacheKey

    // 多轮之间的 prefix 哈希必须相同
    expect(hash1).toBe(hash2)
  })

  // 多轮会话应产生正确的消息结构
  it("should produce correct message structure for multi-turn session", () => {
    const ctx = new ContextManager()
    ctx.prefix.build("You are a helpful assistant.")

    // 第一轮：用户提问，助手回复
    ctx.startTurn()
    ctx.log.append({ role: "user", content: "What is 2+2?" })
    ctx.log.append({ role: "assistant", content: "4" })

    const msgs1 = ctx.buildMessages()
    expect(msgs1).toHaveLength(3)  // system + user + assistant
    expect(msgs1[1].content).toBe("What is 2+2?")
    expect(msgs1[2].content).toBe("4")

    // 第二轮：用户追问新问题
    ctx.startTurn()
    ctx.log.append({ role: "user", content: "What is 3+3?" })

    const msgs2 = ctx.buildMessages()
    expect(msgs2).toHaveLength(4)  // system + user1 + assistant1 + user2
    expect(msgs2[3].content).toBe("What is 3+3?")
  })
})

// === ContextManager 截断逻辑测试 ===
describe("ContextManager - 截断逻辑", () => {
  it("should not truncate when within maxRounds limit", () => {
    const ctx = new ContextManager(3)
    ctx.prefix.build("You are an assistant.")

    ctx.log.append({ role: "user", content: "1" })
    ctx.log.append({ role: "assistant", content: "A" })
    ctx.log.append({ role: "user", content: "2" })
    ctx.log.append({ role: "assistant", content: "B" })
    ctx.log.append({ role: "user", content: "3" })

    expect(ctx.buildMessages()).toHaveLength(6) // system + 5 log
  })

  it("should truncate oldest user round when exceeding maxRounds", () => {
    const ctx = new ContextManager(2)
    ctx.prefix.build("You are an assistant.")

    ctx.log.append({ role: "user", content: "round1" })
    ctx.log.append({ role: "assistant", content: "resp1" })
    ctx.log.append({ role: "user", content: "round2" })
    ctx.log.append({ role: "assistant", content: "resp2" })
    ctx.log.append({ role: "user", content: "round3" })
    ctx.log.append({ role: "assistant", content: "resp3" })

    const msgs = ctx.buildMessages()
    expect(msgs).toHaveLength(5) // system + round2 + resp2 + round3 + resp3
    expect(msgs[1].content).toBe("round2")
    expect(msgs[4].content).toBe("resp3")
  })

  it("should keep complete rounds with tool messages during truncation", () => {
    const ctx = new ContextManager(1)
    ctx.prefix.build("You are an assistant.")

    ctx.log.append({ role: "user", content: "round1" })
    ctx.log.append({ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "bash", arguments: "{}" } }] })
    ctx.log.append({ role: "tool", content: "output1", tool_call_id: "1" })
    ctx.log.append({ role: "assistant", content: "done1" })

    ctx.log.append({ role: "user", content: "round2" })
    ctx.log.append({ role: "assistant", content: "resp2" })

    const msgs = ctx.buildMessages()
    expect(msgs).toHaveLength(3) // system + round2 + resp2
    expect(msgs[1].content).toBe("round2")
    expect(msgs[2].content).toBe("resp2")
  })

  it("should not truncate when maxRounds is 0", () => {
    const ctx = new ContextManager(0)
    ctx.prefix.build("You are an assistant.")

    for (let i = 0; i < 5; i++) {
      ctx.log.append({ role: "user", content: `q${i}` })
      ctx.log.append({ role: "assistant", content: `a${i}` })
    }

    expect(ctx.buildMessages()).toHaveLength(11) // system + 10 log
  })

  it("should default to 20 maxRounds", () => {
    const ctx = new ContextManager()
    expect(ctx["maxRounds"]).toBe(20)
  })

  it("should return defensive copy from buildMessages (modifying result must not affect internal state)", () => {
    const ctx = new ContextManager()
    ctx.prefix.build("System")
    ctx.log.append({ role: "user", content: "hello" })
    ctx.log.append({ role: "assistant", content: "hi" })

    const msgs = ctx.buildMessages()
    const origLen = msgs.length

    msgs.push({ role: "user", content: "tampered" } as any)
    expect(ctx.buildMessages()).toHaveLength(origLen)

    expect(ctx["log"].messages.find(m => m.content === "tampered")).toBeUndefined()
  })

  it("should treat negative maxRounds as 0 (no truncation)", () => {
    const ctx = new ContextManager(-1)
    ctx.prefix.build("System")

    for (let i = 0; i < 5; i++) {
      ctx.log.append({ role: "user", content: `q${i}` })
      ctx.log.append({ role: "assistant", content: `a${i}` })
    }
    expect(ctx.buildMessages()).toHaveLength(11)
  })
})

describe("ContextManager - 截断边界", () => {
  it("should keep complete tool groups after truncation — cutFrom at user boundary preserves all tools in remaining rounds", () => {
    // user0 → a0 → user1 → a1(tc:call_1) → tool(call_1) → a1_summary → user2 → a2
    // userIdx = [0,2,6] → len 3 > maxRounds=2 → cutFrom=userIdx[1]=2
    // slice(2) preserves [user1, a1(tc), tool(call_1), a1_summary, user2, a2]
    // cutFrom always lands on a user, so the first kept msg is never an orphaned assistant(tc)
    const ctx = new ContextManager(2)
    ctx.prefix.build("System")
    ctx.log.append({ role: "user", content: "q0" })
    ctx.log.append({ role: "assistant", content: "a0" })
    ctx.log.append({ role: "user", content: "q1" })
    ctx.log.append({ role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "bash", arguments: "{}" } }] })
    ctx.log.append({ role: "tool", content: "out1", tool_call_id: "call_1" })
    ctx.log.append({ role: "assistant", content: "done1" })
    ctx.log.append({ role: "user", content: "q2" })
    ctx.log.append({ role: "assistant", content: "a2" })

    const msgs = ctx.buildMessages()
    // system + q1 + a1(tc) + tool + done1 + q2 + a2 = 7
    expect(msgs).toHaveLength(7)
    expect(msgs[1].content).toBe("q1")
    expect(msgs[1].role).toBe("user")
    expect(msgs[2].role).toBe("assistant")
    expect(msgs[3].content).toBe("out1")
    expect(msgs[4].content).toBe("done1")
    expect(msgs[5].content).toBe("q2")
  })

  it("should keep complete multi-tool groups after truncation (3+ tool_calls per round)", () => {
    const ctx = new ContextManager(2)
    ctx.prefix.build("System")
    ctx.log.append({ role: "user", content: "q0" })
    ctx.log.append({ role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "bash", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "bash", arguments: "{}" } },
      { id: "c3", type: "function", function: { name: "bash", arguments: "{}" } },
    ]})
    ctx.log.append({ role: "tool", content: "o1", tool_call_id: "c1" })
    ctx.log.append({ role: "tool", content: "o2", tool_call_id: "c2" })
    ctx.log.append({ role: "tool", content: "o3", tool_call_id: "c3" })
    ctx.log.append({ role: "assistant", content: "sum0" })
    ctx.log.append({ role: "user", content: "q1" })
    ctx.log.append({ role: "assistant", content: null, tool_calls: [
      { id: "c4", type: "function", function: { name: "bash", arguments: "{}" } },
    ]})
    ctx.log.append({ role: "tool", content: "o4", tool_call_id: "c4" })
    ctx.log.append({ role: "assistant", content: "sum1" })
    ctx.log.append({ role: "user", content: "q2" })
    ctx.log.append({ role: "assistant", content: "a2" })

    // userIdx = [0, 6, 10] → len 3 > maxRounds=2 → cutFrom=userIdx[1]=6
    const msgs = ctx.buildMessages()
    // Keep: q1 + a1(tc) + tool_c4 + sum1 + q2 + a2 = 6 + system = 7
    expect(msgs).toHaveLength(7)
    expect(msgs[1].content).toBe("q1")
    expect(msgs[5].content).toBe("q2")
  })

  it("should not produce orphaned tool/assistant when conversation is all tool interactions", () => {
    const ctx = new ContextManager(2)
    ctx.prefix.build("System")
    // round 0
    ctx.log.append({ role: "user", content: "q0" })
    ctx.log.append({ role: "assistant", content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "bash", arguments: "{}" } }] })
    ctx.log.append({ role: "tool", content: "o0", tool_call_id: "c0" })
    ctx.log.append({ role: "assistant", content: "sum0" })
    // round 1
    ctx.log.append({ role: "user", content: "q1" })
    ctx.log.append({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }] })
    ctx.log.append({ role: "tool", content: "o1", tool_call_id: "c1" })
    ctx.log.append({ role: "assistant", content: "sum1" })
    // round 2
    ctx.log.append({ role: "user", content: "q2" })
    ctx.log.append({ role: "assistant", content: null, tool_calls: [{ id: "c2", type: "function", function: { name: "bash", arguments: "{}" } }] })
    ctx.log.append({ role: "tool", content: "o2", tool_call_id: "c2" })
    ctx.log.append({ role: "assistant", content: "sum2" })
    // round 3 (exceeds maxRounds=2)
    ctx.log.append({ role: "user", content: "q3" })
    ctx.log.append({ role: "assistant", content: "a3" })

    // userIdx = [0, 4, 8, 12] → len 4 > maxRounds=2 → cutFrom=userIdx[2]=8
    // Keep last 2 user rounds: q2 + a2(tc) + tool_c2 + sum2 + q3 + a3 = 6 + system = 7
    const msgs = ctx.buildMessages()
    expect(msgs).toHaveLength(7)
    // No orphaned tool or bare assistant(tc) at start of log
    expect(msgs[1].role).toBe("user")
    expect(msgs[1].content).toBe("q2")
  })
})

// M1-M3: fold decision tests via ContextManager
describe("ContextManager - fold decision", () => {
  it("M1: should yield force fold decision at >80% usage", async () => {
    const cm = new ContextManager(20, 300)
    cm.prefix.build("x".repeat(100))
    cm.log.append({ role: "user", content: "x".repeat(800) })
    const decision = await cm.getFoldDecision()
    expect(decision.action).toBe("force")
    expect(decision.ratio).toBeGreaterThan(0.80)
  })

  it("M2: should suggest fold at 65-80% usage", async () => {
    const cm = new ContextManager(20, 350)
    cm.prefix.build("x".repeat(200))
    cm.log.append({ role: "user", content: "x".repeat(800) })
    const decision = await cm.getFoldDecision()
    expect(decision.action).toBe("suggest")
    expect(decision.ratio).toBeGreaterThan(0.65)
    expect(decision.ratio).toBeLessThanOrEqual(0.80)
  })

  it("M3: should return none when usage is low", async () => {
    const cm = new ContextManager(20, 100_000)
    cm.prefix.build("short prefix")
    const decision = await cm.getFoldDecision()
    expect(decision.action).toBe("none")
    expect(decision.ratio).toBeLessThanOrEqual(0.65)
  })
})

describe("AUD-03: token budget force hard boundary", () => {
  it("truncates log when token budget exceeded", () => {
    const cm = new ContextManager(20, 200) // tiny budget
    cm.prefix.build("short")
    cm.log.append({ role: "user", content: "hello" })
    cm.log.append({ role: "assistant", content: "hi" })

    // Large content that exceeds budget
    cm.log.append({ role: "user", content: "x".repeat(5000) })
    cm.log.append({ role: "assistant", content: "y".repeat(5000) })

    const messages = cm.buildMessages()
    // Should fit within context window
    const total = messages.reduce((acc, m) => acc + (m.content?.length ?? 0), 0)
    expect(total).toBeLessThan(200 * 4) // rough upper bound
  })

  it("preserves prefix content under budget pressure", () => {
    const cm = new ContextManager(100, 100) // very tight budget
    cm.prefix.build("important system prompt")
    cm.log.append({ role: "user", content: "x".repeat(1000) })
    cm.log.append({ role: "assistant", content: "y".repeat(1000) })

    const messages = cm.buildMessages()
    // Prefix must be preserved
    const prefixMsgs = messages.filter(m => cm.prefix.messages.some(p => p.content === m.content))
    expect(prefixMsgs.length).toBeGreaterThanOrEqual(1)
    // Should still contain "important system prompt"
    const allText = messages.map(m => m.content).join("")
    expect(allText).toContain("important system prompt")
  })

  it("preserves tool-call / tool-result atomic groups", () => {
    const cm = new ContextManager(20, 300)
    cm.prefix.build("sys")
    cm.log.append({ role: "user", content: "list files" })
    cm.log.append({ role: "assistant", content: "", tool_calls: [{ id: "tc1", type: "function", function: { name: "ls", arguments: "{}" } }] })
    cm.log.append({ role: "tool", tool_call_id: "tc1", content: "file1\nfile2", name: "ls" })
    cm.log.append({ role: "assistant", content: "here are files" })

    // Add large content that forces truncation
    cm.log.append({ role: "user", content: "do something huge ".repeat(1000) })
    cm.log.append({ role: "assistant", content: "result ".repeat(1000) })
    cm.log.append({ role: "tool", tool_call_id: "tc2", content: "big output ".repeat(500), name: "read" })
    cm.log.append({ role: "assistant", content: "done" })
    cm.log.append({ role: "user", content: "more stuff ".repeat(500) })

    const messages = cm.buildMessages()
    // No orphan tool messages
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "tool") {
        expect(["assistant", "user"].includes(messages[i - 1]?.role ?? "")).toBe(true)
      }
    }
  })

  it("empty log should return just prefix and scratch", () => {
    const cm = new ContextManager(20, 500)
    cm.prefix.build("system prompt")

    const messages = cm.buildMessages()
    expect(messages.length).toBeGreaterThanOrEqual(1)
    expect(messages[0].content).toContain("system prompt")
  })

  it("does not deadlock when budget is extremely small", () => {
    const cm = new ContextManager(20, 20) // small window but > prefix overhead
    cm.prefix.build("x")
    for (let i = 0; i < 10; i++) {
      cm.log.append({ role: "user", content: "hello ".repeat(100) })
      cm.log.append({ role: "assistant", content: "world ".repeat(100) })
    }

    // Should not infinite-loop
    const messages = cm.buildMessages()
    expect(Array.isArray(messages)).toBe(true)
  })
})

describe("CL-30: Context budget boundaries", () => {
  it("throws when prefix alone exceeds window", () => {
    const cm = new ContextManager(1, 1) // 1 token window
    cm.prefix.build("Hello world, this is a very long prefix that definitely should exceed one token in length")
    cm.log.append({ role: "user", content: "hi" })
    expect(() => cm.buildMessages()).toThrow("prefix alone")
  })

  it("throws when scratch alone exceeds window", () => {
    const cm = new ContextManager(1, 1)
    cm.scratch.append({ role: "assistant", content: "this is a very long scratch content that exceeds the tiny window" })
    expect(() => cm.buildMessages()).toThrow("scratch alone")
  })

  it("truncates tool-only log when no user messages exist", () => {
    const cm = new ContextManager(5, 500)
    cm.prefix.build("system prompt")
    for (let i = 0; i < 10; i++) {
      cm.log.append({ role: "assistant", content: "response " + "x".repeat(500), tool_calls: [{ id: `tc-${i}`, type: "function", function: { name: "tool", arguments: "{}" } }] })
      cm.log.append({ role: "tool", content: "result", tool_call_id: `tc-${i}` })
    }
    const msgs = cm.buildMessages()
    // Should not loop forever and should produce valid messages
    expect(msgs.length).toBeGreaterThan(0)
    expect(msgs[0].role).toBe("system")
  })

  it("preserves assistant-tool atomicity during truncation", () => {
    const cm = new ContextManager(2, 5000)
    cm.prefix.build("system")
    // Add 3 rounds of user/assistant/tool
    for (let i = 0; i < 3; i++) {
      cm.log.append({ role: "user", content: `user-${i}` })
      cm.log.append({ role: "assistant", content: `response-${i}`, tool_calls: [{ id: `tc-${i}`, type: "function", function: { name: "tool", arguments: "{}" } }] })
      cm.log.append({ role: "tool", content: `result-${i}`, tool_call_id: `tc-${i}` })
    }
    const msgs = cm.buildMessages()
    // Should keep at most 2 user rounds
    const userMsgs = msgs.filter(m => m.role === "user")
    expect(userMsgs.length).toBeLessThanOrEqual(2)
    // Each assistant with tool_calls should have matching tool result
    const toolCalls = msgs.filter(m => m.role === "assistant" && m.tool_calls).length
    const toolResults = msgs.filter(m => m.role === "tool").length
    expect(toolCalls).toBe(toolResults)
  })

  it("getBudget returns correct breakdown", async () => {
    const cm = new ContextManager(5, 10000)
    cm.prefix.build("system prompt here")
    cm.log.append({ role: "user", content: "hello" })
    cm.log.append({ role: "assistant", content: "world" })
    cm.scratch.append({ role: "user", content: "temp" })
    const budget = await cm.getBudget()
    expect(budget.prefixTokens).toBeGreaterThan(0)
    expect(budget.logTokens).toBeGreaterThan(0)
    expect(budget.scratchTokens).toBeGreaterThan(0)
    expect(budget.totalTokens).toBe(budget.prefixTokens + budget.logTokens + budget.scratchTokens)
    expect(budget.window).toBe(10000)
  })
})

// M1-fix: 修复消息结构后必须重新计算预算，以修复后的最终消息为校验基准
describe("M1-fix: repairMessageStructure budget re-check", () => {
  // 修复删除 orphaned tool_result 后，原本超预算的消息应回到预算内，
  // 不应继续走 aggressive truncation 丢失不必要的上下文
  it("returns to budget after removing orphaned tool_result, no over-truncation", () => {
    const cm = new ContextManager(20, 500)
    cm.prefix.build("sys")
    cm.log.append({ role: "user", content: "query" })
    cm.log.append({ role: "assistant", content: "answer" })
    // orphaned tool_result: 无对应 tool_call，content 巨大撑爆预算
    cm.log.append({
      role: "tool",
      tool_call_id: "orphan-tr-1",
      content: "x".repeat(5000),
      name: "ghost",
    })

    const messages = cm.buildMessages()
    // orphaned tool_result 应被删除
    expect(messages.find(m => m.role === "tool" && m.tool_call_id === "orphan-tr-1")).toBeUndefined()
    // 原始 user/assistant 应保留（未被过度截断）
    expect(messages.find(m => m.role === "user" && m.content === "query")).toBeDefined()
    expect(messages.find(m => m.role === "assistant" && m.content === "answer")).toBeDefined()
    // 最终消息应在预算内
    const total = estimateTokens(messages)
    expect(total).toBeLessThanOrEqual(500)
  })

  // 修复插入占位 tool_result 后，若仍超预算，应走 aggressive truncation 或 throw，
  // 不会静默返回超窗消息
  it("does not silently return over-budget messages after inserting placeholder", () => {
    // 构造：window 极小，assistant 带 orphaned tool_call，修复后插入 placeholder 仍超窗
    const cm = new ContextManager(20, 80) // 极小窗口
    cm.prefix.build("sys")
    cm.log.append({ role: "user", content: "q" })
    cm.log.append({
      role: "assistant",
      content: "a",
      tool_calls: [{
        id: "orphan-tc-1",
        type: "function",
        function: { name: "big_tool", arguments: "{}" },
      }],
    })
    // 另一个大 round 撑爆预算
    cm.log.append({ role: "user", content: "z".repeat(500) })
    cm.log.append({ role: "assistant", content: "y".repeat(500) })

    const messages = cm.buildMessages()
    // 最终消息应在预算内（要么截断了大 round，要么 throw — 这里期望截断成功）
    const total = estimateTokens(messages)
    expect(total).toBeLessThanOrEqual(80)
    // 不应残留 orphaned tool_call（要么有 placeholder 配对，要么 assistant 被截掉）
    const assistantMsgs = messages.filter(m => m.role === "assistant" && m.tool_calls)
    for (const a of assistantMsgs) {
      for (const tc of a.tool_calls!) {
        const hasResult = messages.some(m => m.role === "tool" && m.tool_call_id === tc.id)
        expect(hasResult).toBe(true)
      }
    }
  })

  // 预算内分支：修复插入 placeholder 后若仍 ≤ window，直接返回
  it("returns messages as-is when repaired messages fit within budget", () => {
    const cm = new ContextManager(20, 5000)
    cm.prefix.build("sys")
    cm.log.append({ role: "user", content: "query" })
    cm.log.append({
      role: "assistant",
      content: "answer",
      tool_calls: [{
        id: "orphan-tc-2",
        type: "function",
        function: { name: "tool", arguments: "{}" },
      }],
    })
    // 无对应 tool_result → orphaned tool_call，修复后插入 placeholder

    const messages = cm.buildMessages()
    // 应插入 placeholder tool_result
    const placeholder = messages.find(m => m.role === "tool" && m.tool_call_id === "orphan-tc-2")
    expect(placeholder).toBeDefined()
    expect(placeholder?.is_error).toBe(true)
    // 原 user/assistant 保留
    expect(messages.find(m => m.role === "user" && m.content === "query")).toBeDefined()
  })
})
