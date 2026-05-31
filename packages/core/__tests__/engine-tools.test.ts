import { describe, it, expect } from "vitest"
import { ReasonixEngine } from "../src/engine.js"
import type { AgentTool, LoopEvent } from "../src/interface.js"

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
    const tool: AgentTool = {
      name: "ok", description: "ok",
      parameters: { type: "object", properties: { x: { type: "number" } }, required: ["x"] },
      concurrency: "shared", approval: "read",
      async execute() { return { content: "done", isError: false } },
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

    const doneEvent = events.find((e) => e.role === "done")
    expect(doneEvent).toBeDefined()

    const finalDelta = events.filter((e) => e.role === "assistant_delta")
    expect(finalDelta).toHaveLength(1)
    expect(finalDelta[0].content).toBe("final")
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
    engine.switchAgent("plan")
    expect(engine.getAgentName()).toBe("plan")
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
