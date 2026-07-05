import { describe, it, expect, vi } from "vitest"
import type { AgentTool, ToolResult, LoopEvent } from "../src/interface.js"
import type { PermissionEngine, HookManager } from "@covalo/security"

describe("StreamingToolExecutor", () => {
  function makeHandler(name: string, opts?: { concurrency?: string; result?: string; delay?: number; approval?: string; throwOn?: string }): AgentTool {
    return {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      concurrency: opts?.concurrency ?? "shared",
      approval: opts?.approval ?? "read",
      async execute(args: any) {
        if (opts?.throwOn && args?.trigger === opts.throwOn) throw new Error(opts.throwOn)
        if (opts?.delay) await new Promise(r => setTimeout(r, opts.delay))
        return { content: opts?.result ?? name, isError: false }
      },
    }
  }

  it("should handle unknown tools returning error", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const tools = new Map<string, AgentTool>()
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [{
      id: "1", type: "function" as const,
      function: { name: "unknown_tool", arguments: "{}" },
    }]
    const results: Array<{ tc: unknown; result: ToolResult }> = []
    const events: unknown[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, (tc, r) => results.push({ tc, result: r }))) {
      events.push(e)
    }
    const errorEvents = events.filter((e: any) => e.role === "error")
    expect(errorEvents.length).toBeGreaterThan(0)
  })

  it("should handle tool argument parse failure with repair", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const tools = new Map<string, AgentTool>([["ok_tool", makeHandler("ok_tool")]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [{
      id: "1", type: "function" as const,
      function: { name: "ok_tool", arguments: "{'x': 1}" },
    }]
    const results: Array<{ tc: unknown; result: ToolResult }> = []
    const events: unknown[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, (tc, r) => results.push({ tc, result: r }))) {
      events.push(e)
    }
    const toolEvents = events.filter((e: any) => e.role === "tool")
    expect(toolEvents.length).toBeGreaterThan(0)
  })

  it("should fail fast on unsafe invalid JSON arguments instead of executing with empty args", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    let executed = false
    const tool: AgentTool = {
      ...makeHandler("write_tool", { concurrency: "exclusive", approval: "write" }),
      async execute() { executed = true; return { content: "bad", isError: false } },
    }
    const tools = new Map<string, AgentTool>([["write_tool", tool]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [{
      id: "1", type: "function" as const,
      function: { name: "write_tool", arguments: "[1,2,3]" },
    }]
    const results: ToolResult[] = []
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, (_tc, r) => results.push(r))) {
      events.push(e)
    }
    expect(executed).toBe(false)
    expect(results).toHaveLength(1)
    expect(results[0].isError).toBe(true)
    expect(JSON.parse(results[0].content).error).toContain("Invalid JSON arguments")
    expect(events.some((event) => event.role === "error")).toBe(true)
  })

  it("should execute shared tools concurrently", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const tools = new Map<string, AgentTool>([
      ["slow", makeHandler("slow", { delay: 10 })],
      ["fast", makeHandler("fast")],
    ])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "slow", arguments: "{}" } },
      { id: "2", type: "function" as const, function: { name: "fast", arguments: "{}" } },
    ]
    const events: unknown[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    const toolResults = events.filter((e: any) => e.role === "tool")
    expect(toolResults).toHaveLength(2)
  })

  it("should handle shared+exclusive cross execution", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const order: string[] = []
    const shared1 = makeHandler("read1", {
      concurrency: "shared",
      result: "a",
      delay: 5,
    })
    // Override execute to track order
    const orig1 = shared1.execute.bind(shared1)
    shared1.execute = async (a) => { order.push("read1"); return orig1(a) }

    const exclusive1 = makeHandler("write1", { concurrency: "exclusive", result: "b" })
    const origEx = exclusive1.execute.bind(exclusive1)
    exclusive1.execute = async (a) => { order.push("write1"); return origEx(a) }

    const shared2 = makeHandler("read2", { concurrency: "shared", result: "c" })
    const orig2 = shared2.execute.bind(shared2)
    shared2.execute = async (a) => { order.push("read2"); return orig2(a) }

    const tools = new Map<string, AgentTool>([["read1", shared1], ["write1", exclusive1], ["read2", shared2]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "read1", arguments: "{}" } },
      { id: "2", type: "function" as const, function: { name: "write1", arguments: "{}" } },
      { id: "3", type: "function" as const, function: { name: "read2", arguments: "{}" } },
    ]
    const events: unknown[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    const toolNames = events.filter((e: any) => e.role === "tool").map((e: any) => e.toolName)
    expect(toolNames).toEqual(["read1", "write1", "read2"])
  })

  it("should continue other tools when one in shared batch throws", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const badTool = makeHandler("bad", { throwOn: "fail" })
    const goodTool = makeHandler("good")
    const tools = new Map<string, AgentTool>([["bad", badTool], ["good", goodTool]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "bad", arguments: '{"trigger":"fail"}' } },
      { id: "2", type: "function" as const, function: { name: "good", arguments: "{}" } },
    ]
    const events: unknown[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    const errors = events.filter((e: any) => e.role === "error")
    const tools_ = events.filter((e: any) => e.role === "tool")
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(tools_.length).toBeGreaterThanOrEqual(1)
  })

  it("should emit exclusive event order: start→running→tool→done", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const tools = new Map<string, AgentTool>([["ex", makeHandler("ex", { concurrency: "exclusive" })]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "ex", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    expect(events[0]).toMatchObject({ role: "tool_start", toolName: "ex" })
    expect(events[1]).toMatchObject({ role: "tool_progress", content: "running" })
    expect(events[2]).toMatchObject({ role: "tool", toolName: "ex" })
    expect(events[3]).toMatchObject({ role: "tool_progress", content: "done" })
  })

  it("should emit shared event order: start→running→tool→done (sorted by index)", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const tools = new Map<string, AgentTool>([
      ["a", makeHandler("a", { delay: 20 })],
      ["b", makeHandler("b")],
    ])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "a", arguments: "{}" } },
      { id: "2", type: "function" as const, function: { name: "b", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    // start events first
    const starts = events.filter((e: any) => e.role === "tool_start")
    expect(starts).toHaveLength(2)
    // tool events in order: a, b (sorted by index, not completion time)
    const tools_ = events.filter((e: any) => e.role === "tool")
    expect(tools_[0].toolName).toBe("a")
    expect(tools_[1].toolName).toBe("b")
  })

  it("should invoke permission deny before execution", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const denyEngine: PermissionEngine = {
      decide: () => ({ decision: "deny" as const, reason: "blocked" }),
      addRule: () => {},
    }
    const tools = new Map<string, AgentTool>([["blocked", makeHandler("blocked")]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd(), denyEngine)
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "blocked", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    const errors = events.filter((e: any) => e.role === "error")
    expect(errors.length).toBeGreaterThan(0)
    expect(JSON.parse(errors[0].content as string).error).toContain("blocked")
  })

  it("should call hook beforeToolCall for ask decisions", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const askEngine: PermissionEngine = {
      decide: () => ({ decision: "ask" as const }),
      addRule: () => {},
    }
    let hookCalled = false
    const hook: HookManager = {
      runBeforeToolCall: async () => { hookCalled = true; return "deny" },
      runAfterToolCall: async () => {},
      addHooks: () => {},
      removeHooks: () => {},
      clear: () => {},
    }
    const tools = new Map<string, AgentTool>([["t", makeHandler("t", { approval: "exec" })]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd(), askEngine, hook)
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "t", arguments: "{}" } },
    ]
    for await (const _ of executor.run(toolCalls, new AbortController().signal, () => {})) {}
    expect(hookCalled).toBe(true)
  })

  it("should call runAfterToolCall after execution", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    let afterCalled = false
    const hook: HookManager = {
      runBeforeToolCall: async () => "allow",
      runAfterToolCall: async () => { afterCalled = true },
      addHooks: () => {},
      removeHooks: () => {},
      clear: () => {},
    }
    const tools = new Map<string, AgentTool>([["t", makeHandler("t")]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd(), undefined, hook)
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "t", arguments: "{}" } },
    ]
    for await (const _ of executor.run(toolCalls, new AbortController().signal, () => {})) {}
    expect(afterCalled).toBe(true)
  })

  it("should allow execution when hook returns allow", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const askEngine: PermissionEngine = {
      decide: () => ({ decision: "ask" as const }),
      addRule: () => {},
    }
    const hook: HookManager = {
      runBeforeToolCall: async () => "allow",
      runAfterToolCall: async () => {},
      addHooks: () => {},
      removeHooks: () => {},
      clear: () => {},
    }
    const tools = new Map<string, AgentTool>([["t", makeHandler("t", { result: "ok" })]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd(), askEngine, hook)
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "t", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    const toolEvents = events.filter((e: any) => e.role === "tool")
    expect(toolEvents).toHaveLength(1)
    expect(toolEvents[0].toolName).toBe("t")
  })

  it("should fail-safe to deny when beforeToolCall throws", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const askEngine: PermissionEngine = {
      decide: () => ({ decision: "ask" as const }),
      addRule: () => {},
    }
    const hook: HookManager = {
      runBeforeToolCall: async () => { throw new Error("hook crash") },
      runAfterToolCall: async () => {},
      addHooks: () => {},
      removeHooks: () => {},
      clear: () => {},
    }
    const tools = new Map<string, AgentTool>([["t", makeHandler("t")]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd(), askEngine, hook)
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "t", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    const errors = events.filter((e: any) => e.role === "error")
    expect(errors.length).toBeGreaterThan(0)
  })

  it("should stop at first deny in multi-hook chain and not call subsequent hooks", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const askEngine: PermissionEngine = {
      decide: () => ({ decision: "ask" as const }),
      addRule: () => {},
    }
    let secondCalled = false
    const hook1: HookManager = {
      runBeforeToolCall: async () => "deny",
      runAfterToolCall: async () => {},
      addHooks: () => {},
      removeHooks: () => {},
      clear: () => {},
    }
    const hook2: HookManager = {
      runBeforeToolCall: async () => { secondCalled = true; return "allow" },
      runAfterToolCall: async () => {},
      addHooks: () => {},
      removeHooks: () => {},
      clear: () => {},
    }
    // HookManager accepts multiple hooks via addHooks, not multiple HookManager instances
    // So we need to use real HookManager with multiple hooks
    const { HookManager } = await import("@covalo/security")
    const realHook = new HookManager()
    realHook.addHooks({ beforeToolCall: async () => "deny" })
    realHook.addHooks({ beforeToolCall: async () => { secondCalled = true; return "allow" } })
    const tools = new Map<string, AgentTool>([["t", makeHandler("t")]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd(), askEngine, realHook)
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "t", arguments: "{}" } },
    ]
    for await (const _ of executor.run(toolCalls, new AbortController().signal, () => {})) {}
    expect(secondCalled).toBe(false)
  })

  it("should emit error event when repair pipeline fails on all strategies", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const tools = new Map<string, AgentTool>([["t", makeHandler("t")]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "t", arguments: "!@#$%" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    const errors = events.filter((e: any) => e.role === "error")
    expect(errors.length).toBeGreaterThan(0)
  })

  it("should pass AbortSignal to tool context without crashing", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const tools = new Map<string, AgentTool>([
      ["a", makeHandler("a", { concurrency: "exclusive" })],
    ])
    const controller = new AbortController()
    controller.abort()
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "a", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, controller.signal, () => {})) { events.push(e) }
    expect(events.length).toBeGreaterThan(0)
    // P1: Pre-aborted signal causes tool execution to return error immediately
    const err = events.find((e: any) => e.role === "error")
    expect(err).toBeDefined()
  })

  it("should allow a tool to invoke another read tool through context", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const nested = makeHandler("nested", { result: "nested-ok" })
    const parent: AgentTool = {
      ...makeHandler("parent", { concurrency: "exclusive" }),
      async execute(_args, ctx) {
        return ctx.invokeTool!("nested", {})
      },
    }
    const executor = new StreamingToolExecutor(new Map([["parent", parent], ["nested", nested]]), "test-session", process.cwd())
    const events: LoopEvent[] = []
    for await (const event of executor.run([{ id: "1", type: "function", function: { name: "parent", arguments: "{}" } }], new AbortController().signal, () => {})) events.push(event)
    expect(events.find(event => event.role === "tool")?.content).toBe("nested-ok")
  })

  it("should reject recursive nested tool calls", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const recursive: AgentTool = {
      ...makeHandler("recursive", { concurrency: "exclusive" }),
      async execute(_args, ctx) {
        return ctx.invokeTool!("recursive", {})
      },
    }
    const executor = new StreamingToolExecutor(new Map([["recursive", recursive]]), "test-session", process.cwd())
    const events: LoopEvent[] = []
    for await (const event of executor.run([{ id: "1", type: "function", function: { name: "recursive", arguments: "{}" } }], new AbortController().signal, () => {})) events.push(event)
    expect(events.find(event => event.role === "error")?.content).toContain("Recursive tool invocation")
  })

  it("should deny a Workflow attempting to invoke ask-tier exec steps", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const permissions: PermissionEngine = {
      decide: (name: string) => ({ decision: name === "Workflow" ? "allow" as const : "ask" as const }),
      addRule: () => {},
    }
    const execStep = makeHandler("exec-step", { approval: "exec", result: "ran" })
    const workflow: AgentTool = {
      ...makeHandler("Workflow", { concurrency: "exclusive", approval: "exec" }),
      async execute(_args, ctx) {
        return ctx.invokeTool!("exec-step", {})
      },
    }
    const executor = new StreamingToolExecutor(new Map([["Workflow", workflow], ["exec-step", execStep]]), "test-session", process.cwd(), permissions)
    const events: LoopEvent[] = []
    for await (const event of executor.run([{ id: "1", type: "function", function: { name: "Workflow", arguments: "{}" } }], new AbortController().signal, () => {})) events.push(event)
    expect(events.find(event => event.role === "error")?.content).toContain("requires direct confirmation")
  })

  // ─── P0 Contract Tests ────────────────────────────────────────────
  // These tests lock down the contracts from Deepreef-Full-Implementation-Plan.md §4.3.
  // P0-3 is EXPECTED TO FAIL — it exposes a defect that P1 will not fix (permission deny path writes no result).
  // P0-4 now PASSES after P1: settled tracking prevents duplicate results from abort handling.

  it("P0-1: shared batch one success one failure — each call gets exactly one result, in declaration order", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const good = makeHandler("good", { result: "ok" })
    const bad = makeHandler("bad", { throwOn: "boom" })
    const tools = new Map<string, AgentTool>([["good", good], ["bad", bad]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "good", arguments: "{}" } },
      { id: "2", type: "function" as const, function: { name: "bad", arguments: '{"trigger":"boom"}' } },
    ]
    const results: Array<{ tc: unknown; result: ToolResult }> = []
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, (tc, r) => results.push({ tc, result: r }))) {
      events.push(e)
    }
    // Each tool call gets exactly one result
    expect(results).toHaveLength(2)
    // Results are in declaration order (good=success, bad=error)
    expect(results[0].result.isError).toBe(false)
    expect(results[1].result.isError).toBe(true)
    // Tool events are also in declaration order
    const toolEvents = events.filter(e => e.role === "tool" || e.role === "error")
    expect(toolEvents[0].toolName).toBe("good")
    expect(toolEvents[1].toolName).toBe("bad")
  })

  it("P0-2: exclusive tool permission denied — context receives one error ToolResult", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const denyEngine: PermissionEngine = {
      decide: () => ({ decision: "deny" as const, reason: "blocked by policy" }),
      addRule: () => {},
    }
    const tools = new Map<string, AgentTool>([["ex", makeHandler("ex", { concurrency: "exclusive" })]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd(), denyEngine)
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "ex", arguments: "{}" } },
    ]
    const results: Array<{ tc: unknown; result: ToolResult }> = []
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, (tc, r) => results.push({ tc, result: r }))) {
      events.push(e)
    }
    // Denied exclusive tool gets exactly one error result in context
    expect(results).toHaveLength(1)
    expect(results[0].result.isError).toBe(true)
    expect(results[0].result.content).toContain("blocked by policy")
  })

  it("P0-3: shared tool permission denied — context receives one error ToolResult (DEFECT: currently no result written)", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const denyEngine: PermissionEngine = {
      decide: () => ({ decision: "deny" as const, reason: "blocked shared" }),
      addRule: () => {},
    }
    const tools = new Map<string, AgentTool>([["sh", makeHandler("sh")]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd(), denyEngine)
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "sh", arguments: "{}" } },
    ]
    const results: Array<{ tc: unknown; result: ToolResult }> = []
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, (tc, r) => results.push({ tc, result: r }))) {
      events.push(e)
    }
    // CONTRACT: denied shared tool MUST write an error result to context
    // DEFECT: current implementation only yields error event, never calls appendToolResult
    expect(results).toHaveLength(1)
    expect(results[0].result.isError).toBe(true)
  })

  it("P0-4: interrupt during tool execution — completed tools not duplicated, no extra results written", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    let resolveFast!: () => void
    const fastDone = new Promise<void>(r => { resolveFast = r })
    const fast = makeHandler("fast", { result: "done" })
    // Slow tool that blocks until we abort
    const slow: AgentTool = {
      name: "slow", description: "slow", parameters: { type: "object", properties: {} },
      concurrency: "shared", approval: "read",
      async execute() {
        await fastDone
        return { content: "slow-done", isError: false }
      },
    }
    const tools = new Map<string, AgentTool>([["fast", fast], ["slow", slow]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const controller = new AbortController()
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "fast", arguments: "{}" } },
      { id: "2", type: "function" as const, function: { name: "slow", arguments: "{}" } },
    ]
    const results: Array<{ tc: unknown; result: ToolResult }> = []
    const events: LoopEvent[] = []
    // Start consuming the generator
    const gen = executor.run(toolCalls, controller.signal, (tc, r) => results.push({ tc, result: r }))
    // Pull first event (should be tool_start for fast)
    const first = await gen.next()
    events.push(first.value!)
    // Now abort — slow tool is still running
    controller.abort()
    resolveFast() // release slow so it can finish
    // Drain remaining events
    for await (const e of gen) { events.push(e) }
    // CONTRACT: fast tool should have exactly ONE result (not duplicated)
    const fastResults = results.filter(r => (r.tc as any).function.name === "fast")
    expect(fastResults).toHaveLength(1)
    expect(fastResults[0].result.isError).toBe(false)
    // CONTRACT: slow tool should have exactly ONE result (not duplicated)
    // Note: slow.execute() doesn't check the signal, so it completes successfully.
    // The P1 contract is about no duplicates, not about forcing tool failure.
    const slowResults = results.filter(r => (r.tc as any).function.name === "slow")
    expect(slowResults).toHaveLength(1)
    // Total: exactly 2 results, not 3+ (the old blind-catch defect wrote duplicates)
    expect(results).toHaveLength(2)
  })
})

describe("P5.5: tool progress via reportProgress", () => {
  it("should flush buffered progress events before tool result", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    let progressCb: ((u: { content: string }) => void) | undefined
    const progressTool: AgentTool = {
      name: "prog", description: "", parameters: {},
      concurrency: "exclusive", approval: "read",
      async execute(_args, ctx) {
        progressCb = ctx.reportProgress as typeof progressCb
        ctx.reportProgress?.({ content: "step 1" })
        ctx.reportProgress?.({ content: "step 2" })
        return { content: "done", isError: false }
      },
    }
    const tools = new Map<string, AgentTool>([["prog", progressTool]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "prog", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }

    // Order: start → running → step1 → step2 → tool → done
    expect(events[0]).toMatchObject({ role: "tool_start" })
    expect(events[1]).toMatchObject({ role: "tool_progress", content: "running" })
    expect(events[2]).toMatchObject({ role: "tool_progress", content: "step 1" })
    expect(events[3]).toMatchObject({ role: "tool_progress", content: "step 2" })
    expect(events[4]).toMatchObject({ role: "tool" })
    expect(events[5]).toMatchObject({ role: "tool_progress", content: "done" })
  })

  it("should not crash when tool does not use reportProgress", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const simpleTool: AgentTool = {
      name: "simple", description: "", parameters: {},
      concurrency: "exclusive", approval: "read",
      async execute() { return { content: "ok", isError: false } },
    }
    const tools = new Map<string, AgentTool>([["simple", simpleTool]])
    const executor = new StreamingToolExecutor(tools, "test-session", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "simple", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    expect(events).toHaveLength(4) // start, running, tool, done
  })
})

describe("CL-20: Shared tool progress", () => {
  it("yields intermediate progress for shared tools", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const sharedTool: AgentTool = {
      name: "slow", description: "", parameters: { type: "object", properties: {} },
      concurrency: "shared", approval: "read",
      async execute(_args, ctx) {
        ctx.reportProgress?.({ content: "step1" })
        await new Promise(r => setTimeout(r, 10))
        ctx.reportProgress?.({ content: "step2" })
        return { content: "done", isError: false }
      },
    }
    const tools = new Map<string, AgentTool>([["slow", sharedTool]])
    const executor = new StreamingToolExecutor(tools, "test", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "slow", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    const progress = events.filter(e => e.role === "tool_progress" && e.content !== "running" && e.content !== "done")
    expect(progress.length).toBeGreaterThanOrEqual(2)
    expect(progress[0].content).toBe("step1")
    expect(progress[1].content).toBe("step2")
  })

  it("shared tool without reportProgress still works", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    const simpleTool: AgentTool = {
      name: "simple", description: "", parameters: { type: "object", properties: {} },
      concurrency: "shared", approval: "read",
      async execute() { return { content: "ok", isError: false } },
    }
    const tools = new Map<string, AgentTool>([["simple", simpleTool]])
    const executor = new StreamingToolExecutor(tools, "test", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "simple", arguments: "{}" } },
    ]
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, () => {})) { events.push(e) }
    const done = events.filter(e => e.role === "tool_progress" && e.content === "done")
    expect(done).toHaveLength(1)
  })

  it("FIX-H4: maxParallelTools=1 时 3 个 shared 工具串行执行，并发上限为 1", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    let activeCount = 0
    let maxConcurrency = 0
    const makeTrackingHandler = (name: string): AgentTool => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      concurrency: "shared",
      approval: "read",
      async execute() {
        activeCount++
        if (activeCount > maxConcurrency) maxConcurrency = activeCount
        await new Promise(r => setTimeout(r, 30))
        activeCount--
        return { content: name, isError: false }
      },
    })
    const tools = new Map<string, AgentTool>([
      ["a", makeTrackingHandler("a")],
      ["b", makeTrackingHandler("b")],
      ["c", makeTrackingHandler("c")],
    ])
    const executor = new StreamingToolExecutor(tools, "test-h4", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "a", arguments: "{}" } },
      { id: "2", type: "function" as const, function: { name: "b", arguments: "{}" } },
      { id: "3", type: "function" as const, function: { name: "c", arguments: "{}" } },
    ]
    const results: Array<{ tc: unknown; result: ToolResult }> = []
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, (tc, r) => results.push({ tc, result: r }), undefined, undefined, 1)) {
      events.push(e as LoopEvent)
    }
    expect(results).toHaveLength(3)
    expect(maxConcurrency).toBe(1)
  })

  it("FIX-H4: maxParallelTools=2 时 3 个 shared 工具并发上限为 2", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    let activeCount = 0
    let maxConcurrency = 0
    const makeTrackingHandler = (name: string): AgentTool => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      concurrency: "shared",
      approval: "read",
      async execute() {
        activeCount++
        if (activeCount > maxConcurrency) maxConcurrency = activeCount
        await new Promise(r => setTimeout(r, 30))
        activeCount--
        return { content: name, isError: false }
      },
    })
    const tools = new Map<string, AgentTool>([
      ["a", makeTrackingHandler("a")],
      ["b", makeTrackingHandler("b")],
      ["c", makeTrackingHandler("c")],
    ])
    const executor = new StreamingToolExecutor(tools, "test-h4-2", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "a", arguments: "{}" } },
      { id: "2", type: "function" as const, function: { name: "b", arguments: "{}" } },
      { id: "3", type: "function" as const, function: { name: "c", arguments: "{}" } },
    ]
    const results: Array<{ tc: unknown; result: ToolResult }> = []
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, (tc, r) => results.push({ tc, result: r }), undefined, undefined, 2)) {
      events.push(e as LoopEvent)
    }
    expect(results).toHaveLength(3)
    expect(maxConcurrency).toBeLessThanOrEqual(2)
    expect(maxConcurrency).toBeGreaterThanOrEqual(2)
  })

  it("FIX-H4: maxParallelTools undefined 时 3 个 shared 工具全并发", async () => {
    const { StreamingToolExecutor } = await import("../src/streaming-executor.js")
    let activeCount = 0
    let maxConcurrency = 0
    const makeTrackingHandler = (name: string): AgentTool => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      concurrency: "shared",
      approval: "read",
      async execute() {
        activeCount++
        if (activeCount > maxConcurrency) maxConcurrency = activeCount
        await new Promise(r => setTimeout(r, 30))
        activeCount--
        return { content: name, isError: false }
      },
    })
    const tools = new Map<string, AgentTool>([
      ["a", makeTrackingHandler("a")],
      ["b", makeTrackingHandler("b")],
      ["c", makeTrackingHandler("c")],
    ])
    const executor = new StreamingToolExecutor(tools, "test-h4-3", process.cwd())
    const toolCalls = [
      { id: "1", type: "function" as const, function: { name: "a", arguments: "{}" } },
      { id: "2", type: "function" as const, function: { name: "b", arguments: "{}" } },
      { id: "3", type: "function" as const, function: { name: "c", arguments: "{}" } },
    ]
    const results: Array<{ tc: unknown; result: ToolResult }> = []
    const events: LoopEvent[] = []
    for await (const e of executor.run(toolCalls, new AbortController().signal, (tc, r) => results.push({ tc, result: r }))) {
      events.push(e as LoopEvent)
    }
    expect(results).toHaveLength(3)
    expect(maxConcurrency).toBe(3)
  })
})
