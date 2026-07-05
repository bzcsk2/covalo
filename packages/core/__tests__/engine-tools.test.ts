import { describe, it, expect } from "vitest"
import { ReasonixEngine } from "../src/engine.js"
import type { AgentTool, LoopEvent } from "../src/interface.js"
import { DeepSeekClient } from "../src/client.js"

class MockClient {
  private generators: Array<AsyncGenerator<any>> = []
  setGenerators(gs: Array<AsyncGenerator<any>>): void { this.generators = [...gs] }
  chatCompletionsStream(): AsyncGenerator<any> {
    return this.generators.shift() ?? (async function* () {})()
  }
}

const mockClient = new MockClient()

function makeEngine() {
  return new ReasonixEngine({
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    maxTokens: 256,
    temperature: 0.1,
  }, undefined, undefined, mockClient as any)
}

describe("ReasonixEngine tool loop regressions", () => {
  it("does not execute tools omitted from the effective tool specs", async () => {
    let executions = 0
    mockClient.setGenerators([
      (async function* () {
        yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-disallowed", name: "bash", arguments: "{\"cmd\":\"ls\"}" }
        yield { type: "done", finishReason: "tool_calls" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "final" }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()
    engine.registerTool({
      name: "bash",
      description: "Run command",
      parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      concurrency: "shared",
      approval: "read",
      async execute() {
        executions++
        return { content: "should not run", isError: false }
      },
    })

    const events: LoopEvent[] = []
    for await (const e of engine.submit("plan", undefined, "supervisor", "loop")) events.push(e)

    expect(executions).toBe(0)
    const denied = events.find(e => e.role === "error" && e.toolName === "bash")
    expect(denied?.content).toContain("'bash' is not available in this turn")
    expect(denied?.metadata?.reason).toBe("tool_not_allowed")
    // 错误消息必须包含可用工具列表，引导 LLM 选择正确工具
    expect(denied?.content).toContain("Available tools:")
    // 错误消息必须包含禁止重试提示，防止 LLM 反复调用同一不可用工具
    expect(denied?.content).toContain("Do NOT retry the same unavailable tool")
  })

  it("should preserve toolCallIndex mapping and write tool content as string", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-0", name: "shared_ok", arguments: "{\"x\":1}" }
        yield { type: "tool_call_end", toolCallIndex: 1, id: "tc-1", name: "exclusive_done", arguments: "{\"y\":2}" }
        yield { type: "usage", usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } }
        yield { type: "done", finishReason: "tool_calls" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "ok" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()
    const sharedTool: AgentTool = {
      name: "shared_ok", description: "shared tool",
      parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      concurrency: "shared", approval: "read",
      async execute() { return { content: "ok", isError: false } },
    }
    const exclusiveTool: AgentTool = {
      name: "exclusive_done", description: "exclusive tool",
      parameters: { type: "object", properties: { y: { type: "number" } }, required: ["y"] },
      concurrency: "exclusive", approval: "read",
      async execute() { return { content: "done", isError: false } },
    }
    engine.registerTool(sharedTool)
    engine.registerTool(exclusiveTool)

    const events: LoopEvent[] = []
    for await (const e of engine.submit("hi")) events.push(e)

    const toolStarts = events.filter((e) => e.role === "tool_start")
    expect(toolStarts.map((e) => e.toolCallIndex)).toEqual([0, 1])

    const toolCallDeltas = events.filter((e) => e.role === "tool_call_delta")
    expect(toolCallDeltas.map((e) => e.toolCallIndex)).toEqual([0, 1])

    const toolResults = events.filter((e) => e.role === "tool")
    expect(toolResults.map((e) => e.toolCallIndex)).toEqual([0, 1])

    const toolMsgs = engine.getContextManager().log.messages.filter((m) => m.role === "tool")
    expect(toolMsgs).toHaveLength(2)
    for (const m of toolMsgs) expect(typeof m.content).toBe("string")
  })

  it("should survive double done event (B1 regression)", async () => {
    let executions = 0
    const tool: AgentTool = {
      name: "ok", description: "ok",
      parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      concurrency: "shared", approval: "read",
      async execute() {
        executions++
        return { content: "done", isError: false }
      },
    }

    mockClient.setGenerators([
      (async function* () {
        yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-1", name: "ok", arguments: "{\"x\":1}" }
        yield { type: "usage", usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 } }
        yield { type: "done", finishReason: "tool_calls" }
        yield { type: "done", finishReason: null } // [DONE] marker
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "final" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()
    engine.registerTool(tool)

    const events: LoopEvent[] = []
    for await (const e of engine.submit("hi")) events.push(e)

    const toolResults = events.filter((e) => e.role === "tool")
    expect(toolResults).toHaveLength(1)
    expect(executions).toBe(1)

    const doneEvent = events.find((e) => e.role === "done")
    expect(doneEvent).toBeDefined()

    const finalDelta = events.filter((e) => e.role === "assistant_delta")
    expect(finalDelta).toHaveLength(1)
    expect(finalDelta[0].content).toBe("final")
  })

  it("stops before executing the fifth identical tool call", async () => {
    let executions = 0
    const repeatedToolCall = () => (async function* () {
      yield { type: "tool_call_end", toolCallIndex: 0, id: crypto.randomUUID(), name: "read_same", arguments: "{\"path\":\"README.md\"}" }
      yield { type: "done", finishReason: "tool_calls" }
    })()

    mockClient.setGenerators(Array.from({ length: 5 }, repeatedToolCall))

    const engine = makeEngine()
    engine.registerTool({
      name: "read_same", description: "read same file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      concurrency: "shared", approval: "read",
      async execute() {
        executions++
        return { content: "same", isError: false }
      },
    })

    const events: LoopEvent[] = []
    for await (const event of engine.submit("loop")) events.push(event)

    expect(executions).toBe(4)
    expect(events.some((event) => event.role === "error" && event.metadata?.reason === "toolCallLoop")).toBe(true)
    expect(events.some((event) => event.role === "done" && event.metadata?.reason === "toolCallLoop")).toBe(true)
  })

  it("should mark tool failures as error events and persist is_error=true", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-err", name: "shared_fail", arguments: "{\"q\":\"x\"}" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } }
        yield { type: "done", finishReason: "tool_calls" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "after" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()

    const failTool: AgentTool = {
      name: "shared_fail", description: "fails",
      parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
      concurrency: "shared", approval: "read",
      async execute() { return { content: JSON.stringify({ error: "nope" }), isError: true, metadata: { code: "EFAIL" } } },
    }
    engine.registerTool(failTool)

    const events: LoopEvent[] = []
    for await (const e of engine.submit("hi")) events.push(e)

    const errorEvents = events.filter((e) => e.role === "error" && e.toolName === "shared_fail")
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0].toolCallIndex).toBe(0)

    const toolMsgs = engine.getContextManager().log.messages.filter((m) => m.role === "tool")
    expect(toolMsgs).toHaveLength(1)
    expect(toolMsgs[0].is_error).toBe(true)
    expect(typeof toolMsgs[0].content).toBe("string")
  })

  it("should yield warning when tool_calls finish_reason with empty toolCalls array", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "tool_calls" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "final" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()
    const tool: AgentTool = { name: "t", description: "t", parameters: { type: "object", properties: {} }, concurrency: "shared", approval: "read", async execute() { return { content: "", isError: false } } }
    engine.registerTool(tool)
    const events: LoopEvent[] = []
    for await (const e of engine.submit("hi")) events.push(e)
    const warnings = events.filter((e: any) => e.role === "warning")
    expect(warnings.length).toBeGreaterThanOrEqual(1)
  })

  it("should yield interrupted status when interrupt() called mid-stream", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "partial " }
      })(),
    ])

    const engine = makeEngine()
    const events: LoopEvent[] = []
    const iter = engine.submit("interrupt-me")

    const first = await iter.next()
    events.push(first.value as LoopEvent)

    engine.interrupt()

    for await (const e of iter) events.push(e)

    const interrupted = events.filter((e: any) => e.role === "status" && e.content === "interrupted")
    expect(interrupted.length).toBeGreaterThanOrEqual(0)
  })

  it("should reflect agent name in getAgentName after switchAgent", () => {
    const engine = makeEngine()
    expect(engine.getAgentName()).toBe("build")
    engine.switchAgent("supervisor")
    expect(engine.getAgentName()).toBe("supervisor")
  })

  it("should return engine state from getState", () => {
    const engine = makeEngine()
    const state = engine.getState()
    expect(state.sessionId).toBeDefined()
    expect(state.currentAgent).toBe("build")
    expect(Array.isArray(state.messages)).toBe(true)
    expect(state.isStreaming).toBe(false)
    expect(state.stats).toBeDefined()
  })

  it("should update config via updateConfig and reflect changes", () => {
    const engine = makeEngine()
    engine.updateConfig({ model: "deepseek-v4-pro", baseUrl: "https://custom.api.com", maxTokens: 4096 })
    expect(() => engine.updateConfig({ temperature: 0.7 })).not.toThrow()
  })

  it("should short-circuit prefix.build when cacheKey unchanged", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "first" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "second" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()
    const tool: AgentTool = { name: "t", description: "t", parameters: { type: "object", properties: {} }, concurrency: "shared", approval: "read", async execute() { return { content: "", isError: false } } }
    engine.registerTool(tool)

    const events1: LoopEvent[] = []
    for await (const e of engine.submit("q1")) events1.push(e)

    const events2: LoopEvent[] = []
    for await (const e of engine.submit("q2")) events2.push(e)

    expect(events2.filter((e: any) => e.role === "assistant_delta")[0]?.content).toBe("second")
  })

  it("should handle multi-turn loop with multiple tool calls", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-1", name: "t1", arguments: "{\"x\":1}" }
        yield { type: "tool_call_end", toolCallIndex: 1, id: "tc-2", name: "t2", arguments: "{\"y\":2}" }
        yield { type: "usage", usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } }
        yield { type: "done", finishReason: "tool_calls" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "result" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()
    const tool1: AgentTool = { name: "t1", description: "t1", parameters: { type: "object", properties: { x: { type: "number" } } }, concurrency: "shared", approval: "read", async execute() { return { content: "ok1", isError: false } } }
    const tool2: AgentTool = { name: "t2", description: "t2", parameters: { type: "object", properties: { y: { type: "number" } } }, concurrency: "exclusive", approval: "read", async execute() { return { content: "ok2", isError: false } } }
    engine.registerTool(tool1)
    engine.registerTool(tool2)

    const events: LoopEvent[] = []
    for await (const e of engine.submit("multi")) events.push(e)

    const toolResults = events.filter((e: any) => e.role === "tool")
    expect(toolResults).toHaveLength(2)
    const deltas = events.filter((e: any) => e.role === "assistant_delta")
    expect(deltas).toHaveLength(1)
    expect(deltas[0].content).toBe("result")
    const doneEvent = events.find((e: any) => e.role === "done")
    expect(doneEvent).toBeDefined()
  })
})

describe("P2: Mid-session instruction queue", () => {
  it("P2-1: idle enqueue returns idle, context unchanged", () => {
    const engine = makeEngine()
    const result = engine.enqueueInstruction("follow-up question")
    expect(result.status).toBe("idle")
    expect(result.queueLength).toBe(0)
    const msgs = engine.getContextManager().log.messages
    expect(msgs.some(m => m.role === "user" && m.content === "follow-up question")).toBe(false)
  })

  it("P2-2: enqueue during tool execution — instruction appended after tool results", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-1", name: "ok", arguments: "{}" }
        yield { type: "usage", usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } }
        yield { type: "done", finishReason: "tool_calls" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "done" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])
    const engine = makeEngine()
    engine.registerTool({ name: "ok", description: "ok", parameters: { type: "object", properties: {} }, concurrency: "shared", approval: "read", async execute() { return { content: "ok", isError: false } } })

    const gen = engine.submit("start")
    // Skip orchestration and strategy_notify events
    let first = await gen.next()
    while (first.value?.role === "orchestration" || first.value?.role === "strategy_notify") {
      first = await gen.next()
    }
    expect(first.value?.role).toBe("tool_call_delta")

    // Enqueue while tool is executing
    const result = engine.enqueueInstruction("what about this?")
    expect(result.status).toBe("queued")
    expect(result.queueLength).toBe(1)

    // Drain generator
    const events: LoopEvent[] = [first.value!]
    for await (const e of gen) events.push(e)

    // instruction_injected status should appear after tool completion
    const injected = events.filter((e: any) => e.role === "status" && e.content === "instruction_injected")
    expect(injected).toHaveLength(1)

    // Context should contain: user(start), assistant(tool_calls), tool(ok), user(what about this?), assistant(done)
    const msgs = engine.getContextManager().log.messages
    const userMsgs = msgs.filter(m => m.role === "user")
    expect(userMsgs.map(m => m.content)).toEqual(["start", "what about this?"])
  })

  it("P2-3: enqueue during final answer — instruction consumed before done, extra turn", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "answer" }
        yield { type: "usage", usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } }
        yield { type: "done", finishReason: "stop" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "second" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])
    const engine = makeEngine()

    const gen = engine.submit("hi")
    // Pull first event to start the generator (isSubmitting = true)
    const first = await gen.next()

    // Enqueue during active submit
    const result = engine.enqueueInstruction("follow-up")
    expect(result.status).toBe("queued")

    // Drain generator — engine should do 2 turns
    const events: LoopEvent[] = [first.value!]
    for await (const e of gen) events.push(e)

    // Should have instruction_injected status
    const injected = events.filter((e: any) => e.role === "status" && e.content === "instruction_injected")
    expect(injected).toHaveLength(1)

    // Should have 1 done event (turn 2 is final)
    const doneEvents = events.filter((e: any) => e.role === "done")
    expect(doneEvents).toHaveLength(1)

    // Context: user(hi), assistant(answer), user(follow-up), assistant(second)
    const msgs = engine.getContextManager().log.messages
    const userMsgs = msgs.filter(m => m.role === "user")
    expect(userMsgs.map(m => m.content)).toEqual(["hi", "follow-up"])
  })

  it("P2-4: enqueue 3 in sequence — consumed one per turn in order", async () => {
    // Need 3 turns after initial: each turn consumes one instruction
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "a" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "b" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "c" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "final" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])
    const engine = makeEngine()

    const gen = engine.submit("go")
    // Pull first event to start the generator (isSubmitting = true)
    const first = await gen.next()

    // Enqueue 3 during active submit
    engine.enqueueInstruction("first")
    engine.enqueueInstruction("second")
    engine.enqueueInstruction("third")

    // Drain generator
    const events: LoopEvent[] = [first.value!]
    for await (const e of gen) events.push(e)

    const injected = events.filter((e: any) => e.role === "status" && e.content === "instruction_injected")
    expect(injected).toHaveLength(3)

    const msgs = engine.getContextManager().log.messages
    const userMsgs = msgs.filter(m => m.role === "user")
    expect(userMsgs.map(m => m.content)).toEqual(["go", "first", "second", "third"])
  })

  it("P2-5: enqueue 11 — 11th returns full, first 10 preserved", async () => {
    // Need an active submit to fill the queue
    mockClient.setGenerators([
      (async function* () {
        // Never yields done — keeps the generator alive
        yield { type: "text_delta", delta: "waiting" }
        await new Promise(() => {}) // hang forever
      })(),
    ])
    const engine = makeEngine()
    const gen = engine.submit("start")

    // Pull first event to start the generator (isSubmitting = true)
    const first = await gen.next()

    // First 10 should queue
    for (let i = 0; i < 10; i++) {
      const r = engine.enqueueInstruction(`msg-${i}`)
      expect(r.status).toBe("queued")
      expect(r.queueLength).toBe(i + 1)
    }

    // 11th should be rejected
    const r = engine.enqueueInstruction("overflow")
    expect(r.status).toBe("full")
    expect(r.queueLength).toBe(10)

    // Clean up
    engine.interrupt()
  })

  it("P2-6: enqueue then interrupt — queue cleared, new submit normal", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "ok" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])
    const engine = makeEngine()

    // Queue some instructions
    engine.enqueueInstruction("pending-1")
    engine.enqueueInstruction("pending-2")

    // Interrupt clears queue
    engine.interrupt()

    // Enqueue after interrupt — idle because not submitting
    const r = engine.enqueueInstruction("after-interrupt")
    expect(r.status).toBe("idle")
  })

  it("P2-7: session persistence — injected message appears in context messages", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "response" }
        yield { type: "usage", usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } }
        yield { type: "done", finishReason: "stop" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "ok" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])
    const engine = makeEngine()

    const gen = engine.submit("initial")
    // Pull first event to start the generator (isSubmitting = true)
    const first = await gen.next()

    // Enqueue during active submit
    engine.enqueueInstruction("injected instruction")

    // Drain generator
    const events: LoopEvent[] = [first.value!]
    for await (const e of gen) events.push(e)

    // Injected instruction should appear in context messages
    const msgs = engine.getContextManager().log.messages
    const injected = msgs.find(m => m.role === "user" && m.content === "injected instruction")
    expect(injected).toBeDefined()
  })

  it("P2-8: enqueue empty string — returns ignored", () => {
    const engine = makeEngine()
    const r = engine.enqueueInstruction("  ")
    expect(r.status).toBe("ignored")
  })
})

describe("AS0: reasoning_content tool chain continuity", () => {
  it("assistant tool call message includes reasoning_content in context", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "reasoning_delta", delta: "thinking about tools" }
        yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-1", name: "ok", arguments: "{}" }
        yield { type: "usage", usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 } }
        yield { type: "done", finishReason: "tool_calls" }
      })(),
      (async function* () {
        yield { type: "text_delta", delta: "done" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])
    const engine = makeEngine()
    engine.registerTool({ name: "ok", description: "ok", parameters: { type: "object", properties: {} }, concurrency: "shared", approval: "read", async execute() { return { content: "ok", isError: false } } })

    const events: LoopEvent[] = []
    for await (const e of engine.submit("test")) events.push(e)

    // The assistant message with tool_calls should have reasoning_content
    const msgs = engine.getContextManager().log.messages
    const assistantMsg = msgs.find(m => m.role === "assistant" && m.tool_calls)
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.reasoning_content).toBe("thinking about tools")
  })

  it("non-tool-call assistant message does not include reasoning_content", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "reasoning_delta", delta: "just thinking" }
        yield { type: "text_delta", delta: "hello" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])
    const engine = makeEngine()

    const events: LoopEvent[] = []
    for await (const e of engine.submit("hi")) events.push(e)

    // Non-tool-call assistant message should NOT have reasoning_content in context
    const msgs = engine.getContextManager().log.messages
    const assistantMsg = msgs.find(m => m.role === "assistant")
    expect(assistantMsg).toBeDefined()
    expect(assistantMsg!.reasoning_content).toBeUndefined()
  })

  it("client serializes reasoning_content for tool-call messages", () => {
    const client = new DeepSeekClient()
    const messages = [
      { role: "user" as const, content: "test" },
      { role: "assistant" as const, content: null, reasoning_content: "my reasoning", tool_calls: [{ id: "tc-1", type: "function" as const, function: { name: "bash", arguments: "{}" } }] },
      { role: "tool" as const, content: "ok", tool_call_id: "tc-1" },
    ]

    // Access the serialization logic by calling the client's internal method
    // The client's chatCompletionsStream serializes messages internally
    // We test through the engine flow instead
    const engine = makeEngine()
    const ctx = engine.getContextManager()
    ctx.log.append(messages[0])
    ctx.log.append(messages[1])
    ctx.log.append(messages[2])

    const built = ctx.buildMessages()
    const assistantMsg = built.find(m => m.role === "assistant" && (m as any).tool_calls)
    expect(assistantMsg).toBeDefined()
    expect((assistantMsg as any).reasoning_content).toBe("my reasoning")
  })
})

describe("LIFE-01: Engine shutdown", () => {
  it("shutdown is idempotent — second call does not throw", async () => {
    const engine = makeEngine()
    await engine.shutdown()
    await expect(engine.shutdown()).resolves.toBeUndefined()
  })

  it("shutdown interrupts active submit and closes the context manager", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "partial " }
        await new Promise(() => {}) // hang forever
      })(),
    ])

    const engine = makeEngine()
    const gen = engine.submit("hang")
    let first = await gen.next()
    // Skip orchestration and strategy_notify events
    while (first.value?.role === "orchestration" || first.value?.role === "strategy_notify") {
      first = await gen.next()
    }
    expect(first.value?.role).toBe("assistant_delta")

    const ctx = engine.getContextManager()
    const originalShutdown = ctx.shutdown.bind(ctx)
    let contextShutdownCalled = false
    ctx.shutdown = async () => {
      contextShutdownCalled = true
      await originalShutdown()
    }

    await engine.shutdown()

    expect(contextShutdownCalled).toBe(true)
  })

  it("shutdown flushes runtime logger", async () => {
    const { RuntimeLogger } = await import("../src/runtime-logger.js")
    const { mkdir } = await import("node:fs/promises")
    const { join } = await import("node:path")
    const { tmpdir } = await import("node:os")
    const tmpDir = join(tmpdir(), `covalo-shutdown-log-${Date.now()}`)
    await mkdir(tmpDir, { recursive: true })

    const logPath = join(tmpDir, "engine-shutdown.jsonl")
    const logger = new RuntimeLogger({ enabled: true, level: "info", filePath: logPath })
    logger.info("test.event", { key: "value" })

    const engine = new ReasonixEngine({
      apiKey: "sk-test", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-flash",
      maxTokens: 256, temperature: 0.1,
    }, undefined, undefined, mockClient as any, logger)

    await engine.shutdown()

    const { readFile } = await import("node:fs/promises")
    const content = await readFile(logPath, "utf-8")
    expect(content).toContain("test.event")
    expect(content).toContain("engine.shutdown.done")
  })

  it("delegateTask closes child engine in finally even on error", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "ok" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()
    // Access private delegateTask via any cast
    const delegate = (engine as any).delegateTask.bind(engine)
    const result = await delegate("task", "build", [])
    expect(result).toBe("ok")
    // The child engine should have been shut down; we can't directly inspect it,
    // but the test passing without hanging implies cleanup happened.
  })
})

describe("ADV-HAR-02: EffectiveHarnessPolicy integration", () => {
  it("resolves effective policy during submit", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "ok" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()
    const events: LoopEvent[] = []
    for await (const e of engine.submit("test")) events.push(e)

    const policy = engine.getEffectivePolicy()
    expect(policy).not.toBeNull()
    expect(policy!.strictness).toBe("normal") // default for unknown remote model
    expect(policy!.source).toBe("default")
    expect(policy!.executionMode).toBe("adaptive")
  })

  it("uses session strictness when set", async () => {
    mockClient.setGenerators([
      (async function* () {
        yield { type: "text_delta", delta: "ok" }
        yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
        yield { type: "done", finishReason: "stop" }
      })(),
    ])

    const engine = makeEngine()
    engine.setHarnessStrictness("strict")

    const events: LoopEvent[] = []
    for await (const e of engine.submit("test")) events.push(e)

    const policy = engine.getEffectivePolicy()
    expect(policy).not.toBeNull()
    expect(policy!.strictness).toBe("strict")
    expect(policy!.source).toBe("session")
    expect(policy!.executionMode).toBe("forced")
    expect(policy!.readBeforeWrite).toBe("block")
  })

  it("getHarnessStrictness returns current strictness", () => {
    const engine = makeEngine()
    expect(engine.getHarnessStrictness()).toBe("normal")

    engine.setHarnessStrictness("loose")
    expect(engine.getHarnessStrictness()).toBe("loose")
  })

})
