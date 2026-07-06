import { describe, it, expect, beforeAll, vi } from "vitest"
import type { RuntimeLogger } from "../src/runtime-logger.js"
import type { LoopPolicy, LoopPolicyContext, ToolBatchInfo, ToolResultInfo } from "../src/loop/policy.js"
import type { ChatMessage, ToolCall, ToolSpec } from "../src/types.js"
import type { DeepSeekStreamEvent, DeepSeekClientOptions } from "../src/client.js"
import type { LoopEvent, SessionStats, ToolResult, ChatClient, StreamingToolExecutor } from "../src/interface.js"
import type { EffectiveHarnessPolicy } from "../src/model-profile/types.js"
import type { ContextManager } from "../src/context/manager.js"
import type { BranchBudgetTracker } from "../src/governance/branch-budget.js"
import type { ModeDecisionEngine } from "../src/governance/mode-decision.js"
import { TaskLedgerTracker } from "../src/task-ledger.js"
import { EarlyStopDetector } from "../src/early-stop.js"
import { createCheckpointLoopPolicy } from "../src/loop/policies/checkpoint-policy.js"
import { createTaskLedgerLoopPolicy } from "../src/loop/policies/task-ledger-policy.js"
import { createEarlyStopToolLoopPolicy, emitEarlyStopSignal } from "../src/loop/policies/early-stop-policy.js"
import { SupervisorBudgetTracker } from "../src/supervisor/budget.js"
import { createSupervisorGuidanceState } from "../src/supervisor/guided-loop.js"
import type { SupervisorGuidanceConfig } from "../src/supervisor/guided-loop.js"

type RunCoreLoopFn = typeof import("../src/loop/core-loop.js").runCoreLoop
let runCoreLoop: RunCoreLoopFn

const noopLogger: RuntimeLogger = {
  isEnabled: () => false,
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
}

const noopSignal = new AbortController().signal

function emptyStats(): SessionStats {
  return { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, apiCalls: 0, toolCalls: 0, totalCost: 0 }
}

function makeSupervisorGuidance(): SupervisorGuidanceConfig {
  return {
    pool: { candidates: [] },
    budget: new SupervisorBudgetTracker(),
    state: createSupervisorGuidanceState(),
    resolveTarget: () => null,
    supervisorConfigured: false,
  }
}

function mockContextManager(overrides?: Partial<ContextManager>): ContextManager {
  return {
    maxTurns: 100,
    maxTokens: 32_768,
    getContextWindow: () => 32_768,
    getFoldDecision: () => ({ action: "none" as const, ratio: 0 }),
    buildMessages: () => [],
    log: { append: () => {}, get: () => [], clear: () => {} },
    getRemainingHint: () => ({ remainingTokens: 32_768, totalTokens: 32_768 }),
    ...overrides,
  } as unknown as ContextManager
}

function makeClient(events: DeepSeekStreamEvent[][]): ChatClient {
  let callIdx = 0
  return {
    chatCompletionsStream: async function* (_msgs: ChatMessage[], _opts: DeepSeekClientOptions): AsyncGenerator<DeepSeekStreamEvent> {
      const batch = events[callIdx++] ?? [{ type: "done", finishReason: "stop" }]
      for (const e of batch) yield e
    },
  }
}

function makeThrowingClient(error: Error): ChatClient {
  return {
    chatCompletionsStream: async function* (_msgs: ChatMessage[], _opts: DeepSeekClientOptions): AsyncGenerator<DeepSeekStreamEvent> {
      throw error
    },
  }
}

function makeEmptyExecutor(): StreamingToolExecutor {
  return {
    async *run(_toolCalls: ToolCall[], _signal: AbortSignal, _appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {},
  } as unknown as StreamingToolExecutor
}

function makePolicy(strictness: "strict" | "normal" | "loose"): EffectiveHarnessPolicy {
  if (strictness === "strict") {
    return {
      strictness: "strict", source: "default",
      toolset: "minimal", maxParallelTools: 2, maxTurns: 30,
      readBeforeWrite: "block", textToolSalvage: "always",
      branchBudget: "enforce", checkpoint: "frequent",
      verification: "block", earlyStop: "aggressive",
      toolRouting: "two-stage", executionMode: "forced",
      shellPolicy: "dual-track-conservative", supervisorPolicy: "on-failure",
    }
  }
  return {
    strictness: "normal", source: "default",
    toolset: "coding", maxParallelTools: 3, maxTurns: 50,
    readBeforeWrite: "warn", textToolSalvage: "on-native-failure",
    branchBudget: "recover", checkpoint: "safe-point",
    verification: "require-or-waive", earlyStop: "standard",
    toolRouting: "auto", executionMode: "adaptive",
    shellPolicy: "dual-track", supervisorPolicy: "critical-only",
  }
}

function collectEvents(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []
  return (async () => {
    for await (const evt of gen) {
      out.push(evt)
      if (evt.role === "done") break
    }
    return out
  })()
}

const isWindows = process.platform === "win32"
const describeOrSkip = isWindows ? describe.skip : describe

describeOrSkip("loop policy lifecycle", () => {
  beforeAll(async () => {
    const m = await import("../src/loop/core-loop.js")
    runCoreLoop = m.runCoreLoop
  })

  it("beforeTurn is called each turn, afterDone on normal completion", async () => {
    const beforeTurnCalls: number[] = []
    const afterDoneCalls: number[] = []
    const onErrorCalls: unknown[] = []

    const policy: LoopPolicy = {
      name: "tracker",
      beforeTurn(ctx: LoopPolicyContext) {
        beforeTurnCalls.push(ctx.turnCount)
      },
      afterDone(ctx: LoopPolicyContext) {
        afterDoneCalls.push(ctx.turnCount)
      },
      onError(_ctx: LoopPolicyContext, error: unknown) {
        onErrorCalls.push(error)
      },
    }

    const client = makeClient([[{ type: "text_delta", delta: "hello" }, { type: "done", finishReason: "stop" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(beforeTurnCalls).toEqual([1])
    expect(afterDoneCalls).toEqual([1])
    expect(onErrorCalls).toEqual([])
  })

  it("beforeTurn fires per turn on multi-turn loop", async () => {
    const beforeTurnCalls: number[] = []

    const policy: LoopPolicy = {
      name: "counter",
      beforeTurn(ctx: LoopPolicyContext) {
        beforeTurnCalls.push(ctx.turnCount)
      },
    }

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: "{}" }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolResults: ToolResult[] = []
    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "write_file", description: "w", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: (_tc: ToolCall, result: ToolResult) => { toolResults.push(result) },
      logger: noopLogger,
      policies: [policy],
    }))

    expect(beforeTurnCalls).toEqual([1, 2])
  })

  it("onError is called when stream throws", async () => {
    const onErrorCalls: unknown[] = []

    const policy: LoopPolicy = {
      name: "error-catcher",
      onError(_ctx: LoopPolicyContext, error: unknown) {
        onErrorCalls.push(error)
      },
    }

    const thrown = new Error("network failure")
    const client = makeThrowingClient(thrown)

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      maxTurns: 3,
      logger: noopLogger,
      policies: [policy],
    }))

    expect(onErrorCalls.length).toBeGreaterThanOrEqual(1)
    expect(onErrorCalls[0]).toBe(thrown)
  })

  it("onError is called on provider error event", async () => {
    const onErrorCalls: unknown[] = []

    const policy: LoopPolicy = {
      name: "error-catcher",
      onError(_ctx: LoopPolicyContext, error: unknown) {
        onErrorCalls.push(error)
      },
    }

    const client = makeClient([[{ type: "error", message: "rate limited", status: 429, body: "{}" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      maxTurns: 3,
      logger: noopLogger,
      policies: [policy],
    }))

    expect(onErrorCalls.length).toBeGreaterThanOrEqual(1)
  })

  it("hook throw does not break the loop or other policies", async () => {
    const calls: string[] = []

    const throwingPolicy: LoopPolicy = {
      name: "thrower",
      beforeTurn() {
        calls.push("thrower-before")
        throw new Error("hook boom")
      },
      afterDone() {
        calls.push("thrower-after")
        throw new Error("after boom")
      },
      onError() {
        calls.push("thrower-onError")
        throw new Error("error boom")
      },
    }

    const secondPolicy: LoopPolicy = {
      name: "follower",
      beforeTurn() {
        calls.push("follower-before")
      },
      afterDone() {
        calls.push("follower-after")
      },
      onError() {
        calls.push("follower-onError")
      },
    }

    const client = makeClient([[{ type: "text_delta", delta: "hi" }, { type: "done", finishReason: "stop" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [throwingPolicy, secondPolicy],
    }))

    // Both policies' beforeTurn should be called (thrower throws but follower still runs)
    expect(calls).toContain("thrower-before")
    expect(calls).toContain("follower-before")
    // afterDone hooks should both be called
    expect(calls).toContain("thrower-after")
    expect(calls).toContain("follower-after")
  })

  it("beforeModelCall fires before model stream", async () => {
    const calls: string[] = []
    const policy: LoopPolicy = {
      name: "order",
      beforeTurn() { calls.push("beforeTurn") },
      beforeModelCall() { calls.push("beforeModelCall") },
      afterDone() { calls.push("afterDone") },
    }

    const client = makeClient([[{ type: "text_delta", delta: "a" }, { type: "done", finishReason: "stop" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(calls).toEqual(["beforeTurn", "beforeModelCall", "afterDone"])
  })

  it("afterModelEvent fires per stream event", async () => {
    const afterModelCalls: unknown[] = []

    const policy: LoopPolicy = {
      name: "counter",
      afterModelEvent(_ctx: LoopPolicyContext, event: unknown) {
        afterModelCalls.push(event)
      },
    }

    const event1 = { type: "text_delta", delta: "hello" }
    const event2 = { type: "done", finishReason: "stop" }
    const client = makeClient([[event1, event2]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(afterModelCalls.length).toBe(2)
    expect(afterModelCalls[0]).toEqual(event1)
    expect(afterModelCalls[1]).toEqual(event2)
  })

  it("beforeToolBatch and afterToolResult fire around tool execution", async () => {
    const calls: { hook: string; toolName?: string }[] = []
    const policy: LoopPolicy = {
      name: "tool-observer",
      beforeToolBatch(_ctx: LoopPolicyContext, toolCalls: readonly ToolCall[], _info: ToolBatchInfo) {
        calls.push({ hook: "beforeToolBatch", toolName: toolCalls[0]?.function.name })
      },
      afterToolResult(_ctx: LoopPolicyContext, event: LoopEvent, _info: ToolResultInfo) {
        calls.push({ hook: "afterToolResult", toolName: (event as any).toolName })
      },
    }

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "read_file", arguments: '{"path":"x"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolResults: ToolResult[] = []
    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: (_tc: ToolCall, _r: ToolResult) => { toolResults.push(_r) },
      logger: noopLogger,
      policies: [policy],
    }))

    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0].hook).toBe("beforeToolBatch")
    expect(calls[0].toolName).toBe("read_file")
    // at least one afterToolResult with read_file
    expect(calls.filter(c => c.hook === "afterToolResult" && c.toolName === "read_file").length).toBeGreaterThanOrEqual(1)
  })

  it("beforeFinal fires before final done on text-only completion", async () => {
    const calls: string[] = []
    const policy: LoopPolicy = {
      name: "order",
      beforeTurn() { calls.push("beforeTurn") },
      beforeModelCall() { calls.push("beforeModelCall") },
      beforeFinal() { calls.push("beforeFinal") },
      afterDone() { calls.push("afterDone") },
    }

    const client = makeClient([[{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(calls).toEqual(["beforeTurn", "beforeModelCall", "beforeFinal", "afterDone"])
  })

  it("beforeFinalDraft fires after verification gate passes, forming beforeFinal -> beforeFinalDraft -> afterDone order", async () => {
    const calls: string[] = []
    const policy: LoopPolicy = {
      name: "order",
      beforeTurn() { calls.push("beforeTurn") },
      beforeModelCall() { calls.push("beforeModelCall") },
      beforeFinal() { calls.push("beforeFinal") },
      beforeFinalDraft() { calls.push("beforeFinalDraft") },
      afterDone() { calls.push("afterDone") },
    }

    const client = makeClient([[{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(calls).toEqual(["beforeTurn", "beforeModelCall", "beforeFinal", "beforeFinalDraft", "afterDone"])
  })

  it("afterToolBatch fires after tool batch completes, maintaining beforeToolBatch -> afterToolResult -> afterToolBatch order", async () => {
    const order: { hook: string; toolName?: string; source?: string; matchedToolName?: string }[] = []
    const policy: LoopPolicy = {
      name: "order-checker",
      beforeToolBatch(_ctx: LoopPolicyContext, toolCalls: readonly ToolCall[], info: ToolBatchInfo) {
        order.push({ hook: "beforeToolBatch", toolName: toolCalls[0]?.function.name, source: info.source })
      },
      afterToolResult(_ctx: LoopPolicyContext, event: LoopEvent, info: ToolResultInfo) {
        order.push({ hook: "afterToolResult", toolName: (event as any).toolName, source: info.source, matchedToolName: info.toolCall?.function.name })
      },
      afterToolBatch(_ctx: LoopPolicyContext, toolCalls: readonly ToolCall[], info: ToolBatchInfo) {
        order.push({ hook: "afterToolBatch", toolName: toolCalls[0]?.function.name, source: info.source })
      },
    }

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "read_file", arguments: '{"path":"x"}' }, { type: "tool_call_end", toolCallIndex: 1, id: "tc2", name: "grep", arguments: '{"pattern":"x"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [
        { type: "function", function: { name: "read_file", description: "r", parameters: {} } },
        { type: "function", function: { name: "grep", description: "g", parameters: {} } },
      ],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(order[0].hook).toBe("beforeToolBatch")
    expect(order[0].toolName).toBe("read_file")
    expect(order[1].hook).toBe("afterToolResult")
    expect(order[1].source).toBe("native")
    expect(order[1].matchedToolName).toBe("read_file")
    expect(order[2].hook).toBe("afterToolResult")
    expect(order[2].source).toBe("native")
    expect(order[2].matchedToolName).toBe("grep")
    expect(order[3].hook).toBe("afterToolBatch")
    expect(order[3].toolName).toBe("read_file")
    const resultCount = order.filter(o => o.hook === "afterToolResult").length
    expect(resultCount).toBe(2)
    // source should be "native" for the main tool path
    expect(order[0].source).toBe("native")
    expect(order[3].source).toBe("native")
  })

  it("afterToolBatch fires with source='salvage' when text-savaged tool batch completes", async () => {
    const calls: { hook: string; source?: string; matchedToolName?: string }[] = []
    const policy: LoopPolicy = {
      name: "salvage-observer",
      beforeToolBatch(_ctx: LoopPolicyContext, _tc: readonly ToolCall[], info: ToolBatchInfo) {
        calls.push({ hook: "beforeToolBatch", source: info.source })
      },
      afterToolResult(_ctx: LoopPolicyContext, _event: LoopEvent, info: ToolResultInfo) {
        calls.push({ hook: "afterToolResult", source: info.source, matchedToolName: info.toolCall?.function.name })
      },
      afterToolBatch(_ctx: LoopPolicyContext, _tc: readonly ToolCall[], info: ToolBatchInfo) {
        calls.push({ hook: "afterToolBatch", source: info.source })
      },
    }

    // Return "stop" with embedded tool call text, no native tool_calls
    const client = makeClient([[
      { type: "text_delta", delta: '<tool_call><function=read_file><parameter=path>/tmp/x</parameter></function></tool_call>' },
      { type: "done", finishReason: "stop" },
    ]])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "file content", isError: false })
          yield { role: "tool", content: "file content", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      effectivePolicy: makePolicy("strict"),
      policies: [policy],
    }))

    expect(calls.length).toBe(3)
    expect(calls[0].hook).toBe("beforeToolBatch")
    expect(calls[0].source).toBe("salvage")
    expect(calls[1].hook).toBe("afterToolResult")
    expect(calls[1].source).toBe("salvage")
    expect(calls[1].matchedToolName).toBe("read_file")
    expect(calls[2].hook).toBe("afterToolBatch")
    expect(calls[2].source).toBe("salvage")
  })

  it("context build error triggers onError", async () => {
    const onErrorCalls: unknown[] = []
    const policy: LoopPolicy = {
      name: "error-catcher",
      onError(_ctx: LoopPolicyContext, error: unknown) {
        onErrorCalls.push(error)
      },
    }

    const ctx = mockContextManager({
      buildMessages: () => { throw new Error("context overflow") },
    })

    const client = makeClient([[{ type: "text_delta", delta: "hi" }, { type: "done", finishReason: "stop" }]])

    await collectEvents(runCoreLoop({
      ctx,
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(onErrorCalls.length).toBeGreaterThanOrEqual(1)
    expect((onErrorCalls[0] as Error).message).toBe("context overflow")
  })

  it("checkpoint policy saves final_draft on text completion", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined)
    const policy = createCheckpointLoopPolicy({
      checkpointEngine: { shouldPersistOnTrigger: () => true, save: saveSpy, setForcedPolicy: () => {} } as any,
    })

    const client = makeClient([[{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(saveSpy).toHaveBeenCalledTimes(1)
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: "final_draft" }))
  })

  it("checkpoint policy does NOT save final_draft when verification gate blocks", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined)
    const policy = createCheckpointLoopPolicy({
      checkpointEngine: { shouldPersistOnTrigger: () => true, save: saveSpy, setForcedPolicy: () => {} } as any,
      taskLedger: {
        snapshot: () => ({ goal: "", plan: [], changedFiles: ["test.ts"], commandsRun: [], verificationPending: true, blockers: [] }),
        verificationPending: true,
        changedFiles: ["test.ts"],
      } as unknown as TaskLedgerTracker,
    })

    const client = makeClient([[{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      requireVerificationBeforeFinal: true,
      verificationGateState: { continuationCount: 0 },
      taskLedger: {
        snapshot: () => ({ goal: "", plan: [], changedFiles: ["test.ts"], commandsRun: [], verificationPending: true, blockers: [] }),
        verificationPending: true,
        changedFiles: ["test.ts"],
      } as unknown as TaskLedgerTracker,
      policies: [policy],
    }))

    // verification gate blocked before beforeFinalDraft, so final_draft never saved
    // (afterStreamError may still fire if the blocking path triggers an error event)
    expect(saveSpy).not.toHaveBeenCalledWith(expect.objectContaining({ trigger: "final_draft" }))
    expect(saveSpy).not.toHaveBeenCalledWith(expect.objectContaining({ trigger: "step_completed" }))
  })

  it("checkpoint policy saves step_completed on native tool batch", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined)
    const policy = createCheckpointLoopPolicy({
      checkpointEngine: { shouldPersistOnTrigger: () => true, save: saveSpy, setForcedPolicy: () => {} } as any,
    })

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "read_file", arguments: '{"path":"x"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    // step_completed checkpoint saved after native tool batch
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: "step_completed" }))
    // final_draft also saved on completion
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: "final_draft" }))
    expect(saveSpy).toHaveBeenCalledTimes(2)
  })

  it("checkpoint policy does NOT save step_completed on salvage tool batch", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined)
    const policy = createCheckpointLoopPolicy({
      checkpointEngine: { shouldPersistOnTrigger: () => true, save: saveSpy, setForcedPolicy: () => {} } as any,
    })

    const client = makeClient([[
      { type: "text_delta", delta: '<tool_call><function=read_file><parameter=path>/tmp/x</parameter></function></tool_call>' },
      { type: "done", finishReason: "stop" },
    ]])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "file content", isError: false })
          yield { role: "tool", content: "file content", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      effectivePolicy: makePolicy("strict"),
      policies: [policy],
    }))

    // step_completed should NOT be saved for salvage path
    const stepCompletedCalls = saveSpy.mock.calls.filter(
      (c: any[]) => c[0]?.trigger === "step_completed",
    )
    expect(stepCompletedCalls.length).toBe(0)
    // final_draft still saved on final completion
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: "final_draft" }))
  })

  it("checkpoint policy saves tool_failed on provider error event", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined)
    const policy = createCheckpointLoopPolicy({
      checkpointEngine: { shouldPersistOnTrigger: () => true, save: saveSpy, setForcedPolicy: () => {} } as any,
    })

    const client = makeClient([[{ type: "error", message: "rate limited", status: 429, body: "{}" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      maxTurns: 3,
      logger: noopLogger,
      policies: [policy],
    }))

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: "tool_failed" }))
  })

  it("checkpoint policy saves tool_failed on stream throw", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined)
    const policy = createCheckpointLoopPolicy({
      checkpointEngine: { shouldPersistOnTrigger: () => true, save: saveSpy, setForcedPolicy: () => {} } as any,
    })

    const thrown = new Error("network failure")
    const client = makeThrowingClient(thrown)

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      maxTurns: 3,
      logger: noopLogger,
      policies: [policy],
    }))

    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ trigger: "tool_failed" }))
  })

  it("checkpoint policy does NOT save tool_failed on interrupt", async () => {
    const saveSpy = vi.fn().mockResolvedValue(undefined)
    const policy = createCheckpointLoopPolicy({
      checkpointEngine: { shouldPersistOnTrigger: () => true, save: saveSpy, setForcedPolicy: () => {} } as any,
    })

    const client = makeClient([[{ type: "text_delta", delta: "hello" }, { type: "done", finishReason: "stop" }]])

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => true,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(saveSpy).not.toHaveBeenCalledWith(expect.objectContaining({ trigger: "tool_failed" }))
  })

  it("native afterToolResult info.parsedArgs contains parsed tool arguments", async () => {
    const parsedArgsList: (Record<string, unknown> | undefined)[] = []
    const policy: LoopPolicy = {
      name: "parsed-args-native",
      afterToolResult(_ctx: LoopPolicyContext, _event: LoopEvent, info: ToolResultInfo) {
        parsedArgsList.push(info.parsedArgs)
      },
    }

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "read_file", arguments: '{"path":"/tmp/x"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(parsedArgsList.length).toBeGreaterThan(0)
    expect(parsedArgsList[0]).toEqual({ path: "/tmp/x" })
  })

  it("salvage afterToolResult info.parsedArgs contains parsed tool arguments", async () => {
    const parsedArgsList: (Record<string, unknown> | undefined)[] = []
    const policy: LoopPolicy = {
      name: "parsed-args-salvage",
      afterToolResult(_ctx: LoopPolicyContext, _event: LoopEvent, info: ToolResultInfo) {
        parsedArgsList.push(info.parsedArgs)
      },
    }

    const client = makeClient([[
      { type: "text_delta", delta: '<tool_call><function=read_file><parameter=path>/tmp/y</parameter></function></tool_call>' },
      { type: "done", finishReason: "stop" },
    ]])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      effectivePolicy: makePolicy("strict"),
      policies: [policy],
    }))

    expect(parsedArgsList.length).toBeGreaterThan(0)
    expect(parsedArgsList[0]).toEqual({ path: "/tmp/y" })
  })

  it("afterToolResult info.parsedArgs is undefined when arguments cannot be parsed", async () => {
    const parsedArgsList: (Record<string, unknown> | undefined)[] = []
    const policy: LoopPolicy = {
      name: "parsed-args-parse-fail",
      afterToolResult(_ctx: LoopPolicyContext, _event: LoopEvent, info: ToolResultInfo) {
        parsedArgsList.push(info.parsedArgs)
      },
    }

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "read_file", arguments: '{invalid}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      policies: [policy],
    }))

    expect(parsedArgsList.length).toBeGreaterThan(0)
    expect(parsedArgsList[0]).toBeUndefined()
  })

  it("native write tool result makes taskLedger.verificationPending true", async () => {
    const tracker = new TaskLedgerTracker("fix bug")

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: '{"path":"src/a.ts"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "write_file", description: "w", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      taskLedger: tracker,
      requireVerificationBeforeFinal: true,
      verificationGateState: { continuationCount: 0 },
    }))

    expect(tracker.verificationPending).toBe(true)
    expect(tracker.changedFiles).toContain("src/a.ts")
  })

  it("native bash verification command clears taskLedger.verificationPending", async () => {
    const tracker = new TaskLedgerTracker("fix bug")

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: '{"path":"src/a.ts"}' }, { type: "tool_call_end", toolCallIndex: 1, id: "tc2", name: "bash", arguments: '{"command":"npm test"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [
        { type: "function", function: { name: "write_file", description: "w", parameters: {} } },
        { type: "function", function: { name: "bash", description: "sh", parameters: {} } },
      ],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      taskLedger: tracker,
      requireVerificationBeforeFinal: true,
      verificationGateState: { continuationCount: 0 },
    }))

    expect(tracker.verificationPending).toBe(false)
  })

  it("salvage write tool result still records to TaskLedger", async () => {
    const tracker = new TaskLedgerTracker("fix bug")

    const client = makeClient([[
      { type: "text_delta", delta: '<tool_call><function=write_file><parameter=path>/tmp/x</parameter></function></tool_call>' },
      { type: "done", finishReason: "stop" },
    ]])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "write_file", description: "w", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      effectivePolicy: makePolicy("strict"),
      taskLedger: tracker,
      requireVerificationBeforeFinal: true,
      verificationGateState: { continuationCount: 0 },
    }))

    expect(tracker.verificationPending).toBe(true)
    expect(tracker.changedFiles.some(f => f.includes("/tmp/x"))).toBe(true)
  })

  it("parse failure does not record to TaskLedger", async () => {
    const tracker = new TaskLedgerTracker("fix bug")

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: '{invalid}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "write_file", description: "w", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      taskLedger: tracker,
      requireVerificationBeforeFinal: true,
      verificationGateState: { continuationCount: 0 },
    }))

    expect(tracker.verificationPending).toBe(false)
    expect(tracker.changedFiles).toEqual([])
  })

  it("verificationGateState.continuationCount resets when verification resolves", async () => {
    const tracker = new TaskLedgerTracker("fix bug")
    const gateState = { continuationCount: 5 }

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: '{"path":"src/a.ts"}' }, { type: "tool_call_end", toolCallIndex: 1, id: "tc2", name: "bash", arguments: '{"command":"npm test"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [
        { type: "function", function: { name: "write_file", description: "w", parameters: {} } },
        { type: "function", function: { name: "bash", description: "sh", parameters: {} } },
      ],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      taskLedger: tracker,
      requireVerificationBeforeFinal: true,
      verificationGateState: gateState,
    }))

    // After write_file → pending=true, still blocking → continuationCount stays 5
    // After bash success → pending=false, unblocked → continuationCount resets to 0
    expect(gateState.continuationCount).toBe(0)
  })

  it("task-ledger policy refreshes context and keeps gate counter while still blocking", async () => {
    const tracker = new TaskLedgerTracker("fix bug")
    const gateState = { continuationCount: 5 }
    const refreshLedgerContext = vi.fn()
    const policy = createTaskLedgerLoopPolicy({
      taskLedger: tracker,
      refreshLedgerContext,
      verificationGateState: gateState,
      requireVerificationBeforeFinal: true,
    })

    policy.afterToolResult?.({} as LoopPolicyContext, {
      role: "tool",
      content: "ok",
      toolName: "write_file",
    } as LoopEvent, {
      source: "native",
      toolCalls: [],
      parsedArgs: { path: "src/a.ts" },
    })

    expect(tracker.verificationPending).toBe(true)
    expect(tracker.changedFiles).toContain("src/a.ts")
    expect(refreshLedgerContext).toHaveBeenCalledTimes(1)
    expect(gateState.continuationCount).toBe(5)
  })

  it("native tool result records supervisor tool evidence", async () => {
    const supervisorGuidance = makeSupervisorGuidance()

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "read_file", arguments: '{"path":"src/a.ts"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "file content", isError: false })
          yield { role: "tool", content: "file content", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      supervisorGuidance,
    }))

    expect(supervisorGuidance.state.recentTools).toEqual([
      { name: "read_file", success: true, summary: "file content" },
    ])
    expect(supervisorGuidance.state.recentFailures).toEqual([])
  })

  it("native tool error records supervisor failure evidence", async () => {
    const supervisorGuidance = makeSupervisorGuidance()

    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: '{"path":"src/a.ts"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "write failed", isError: true, metadata: { error: "EACCES" } })
          yield { role: "error", content: "write failed", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id, metadata: { error: "EACCES" } } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "write_file", description: "w", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      supervisorGuidance,
    }))

    expect(supervisorGuidance.state.recentTools).toEqual([
      { name: "write_file", success: false, summary: "write failed" },
    ])
    expect(supervisorGuidance.state.recentFailures).toEqual([
      { signature: "write_file:src/a.ts", count: 1, lastError: "write failed" },
    ])
  })

  it("salvage tool result does not record supervisor evidence", async () => {
    const supervisorGuidance = makeSupervisorGuidance()

    const client = makeClient([[
      { type: "text_delta", delta: '<tool_call><function=read_file><parameter=path>/tmp/x</parameter></function></tool_call>' },
      { type: "done", finishReason: "stop" },
    ]])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "file content", isError: false })
          yield { role: "tool", content: "file content", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      effectivePolicy: makePolicy("strict"),
      supervisorGuidance,
    }))

    expect(supervisorGuidance.state.recentTools).toEqual([])
    expect(supervisorGuidance.state.recentFailures).toEqual([])
  })

  it("native repeated tool failures yield warning and persist compact session event", async () => {
    const client = makeClient([
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "bash", arguments: '{"command":"npm test"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc2", name: "bash", arguments: '{"command":"npm test"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "tool_call_end", toolCallIndex: 0, id: "tc3", name: "bash", arguments: '{"command":"npm test"}' }, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "same failure", isError: true, metadata: { error: "failed" } })
          yield { role: "error", content: "same failure", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id, metadata: { error: "failed" } } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor
    const sessionEvents: any[] = []
    const sessionWriter = {
      enqueue(entry: unknown) {
        sessionEvents.push(entry)
      },
    }

    const events = await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "bash", description: "sh", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      sessionWriter: sessionWriter as any,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      maxTurns: 5,
    }))

    const warnings = events.filter(e => e.role === "warning" && e.content?.startsWith("Repeated tool failure"))
    expect(warnings).toHaveLength(1)
    expect(warnings[0].content).toContain('"bash" failed 3 times')
    expect(sessionEvents.some(e => (e as any).payload?.content === "repeated_failure_blocked: bash")).toBe(true)
  })

  it("salvage repeated tool failures do not yield repeated-failure warning", async () => {
    const client = makeClient([
      [
        { type: "text_delta", delta: '<tool_call><function=read_file><parameter=path>/tmp/x</parameter></function></tool_call>' },
        { type: "done", finishReason: "stop" },
      ],
      [
        { type: "text_delta", delta: '<tool_call><function=read_file><parameter=path>/tmp/x</parameter></function></tool_call>' },
        { type: "done", finishReason: "stop" },
      ],
      [
        { type: "text_delta", delta: '<tool_call><function=read_file><parameter=path>/tmp/x</parameter></function></tool_call>' },
        { type: "done", finishReason: "stop" },
      ],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])

    const toolExecutor: StreamingToolExecutor = {
      async *run(_tc: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of _tc) {
          appendResult(tc, { content: "same failure", isError: true, metadata: { error: "failed" } })
          yield { role: "error", content: "same failure", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id, metadata: { error: "failed" } } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    const events = await collectEvents(runCoreLoop({
      ctx: mockContextManager(),
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      effectivePolicy: makePolicy("strict"),
      maxTurns: 5,
    }))

    expect(events.some(e => e.role === "warning" && e.content?.startsWith("Repeated tool failure"))).toBe(false)
  })

  it("emitEarlyStopSignal injects correction, yields status/runtime signal, and persists events", () => {
    const appended: Array<{ role: string; content: string }> = []
    const ctx = mockContextManager({
      buildMessages: () => [{ role: "user", content: "correction" }],
      log: { append: (msg: any) => appended.push(msg), get: () => [], clear: () => {} } as any,
    })
    const sessionEvents: any[] = []
    const sessionWriter = {
      enqueue(entry: unknown) {
        sessionEvents.push(entry)
      },
    }
    const supervisorState = createSupervisorGuidanceState()

    const events = [...emitEarlyStopSignal({
      reason: "read_loop",
      message: "too many reads",
      action: "inject_correction",
      injection: "[SYSTEM] stop reading",
    }, ctx, sessionWriter as any, supervisorState)]

    expect(appended).toEqual([{ role: "user", content: "[SYSTEM] stop reading" }])
    expect(supervisorState.lastStopSignalReason).toBe("read_loop")
    expect(events[0]).toMatchObject({
      role: "status",
      content: "early_stop",
      severity: "warning",
      metadata: { reason: "read_loop", message: "too many reads", action: "inject_correction" },
    })
    expect(events[1]).toMatchObject({
      role: "orchestration",
      orchestration: {
        kind: "runtime_signal",
        signal: { kind: "verification-failed", message: "too many reads" },
      },
    })
    expect(sessionEvents[0]).toMatchObject({ type: "messages", payload: [{ role: "user", content: "correction" }] })
    expect(sessionEvents[1]).toMatchObject({ type: "event", payload: events[0] })
    expect(sessionEvents[2]).toMatchObject({ type: "event", payload: events[1] })
  })

  it("early-stop repetition policy emits correction after text delta updates full content", async () => {
    const appended: Array<{ role: string; content: string }> = []
    const ctx = mockContextManager({
      buildMessages: () => [{ role: "user", content: "correction" }],
      log: { append: (msg: any) => appended.push(msg), get: () => [], clear: () => {} } as any,
    })
    const sessionEvents: any[] = []
    const sessionWriter = {
      enqueue(entry: unknown) {
        sessionEvents.push(entry)
      },
    }
    const earlyStop = new EarlyStopDetector({ repetitionThreshold: 3, repetitionWindowChars: 200 })
    const repeated = "THE QUICK BROWN FOX ".repeat(50)
    const client = makeClient([[{ type: "text_delta", delta: repeated }, { type: "done", finishReason: "stop" }]])

    const events = await collectEvents(runCoreLoop({
      ctx,
      client,
      toolExecutor: makeEmptyExecutor(),
      toolSpecs: [],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      sessionWriter: sessionWriter as any,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      earlyStop,
    }))

    expect(events.filter(e => e.role === "status" && e.content === "early_stop" && e.metadata?.reason === "repetition_loop")).toHaveLength(1)
    expect(events.filter(e => e.role === "orchestration" && e.orchestration?.kind === "runtime_signal")).toHaveLength(1)
    expect(appended.some(msg => msg.content.includes("repeating"))).toBe(true)
    expect(sessionEvents.some(e => (e as any).type === "messages")).toBe(true)
    expect(sessionEvents.some(e => (e as any).payload?.content === "early_stop")).toBe(true)
  })

  it("early-stop tool policy emits read-loop signal from native tool results", async () => {
    const appended: Array<{ role: string; content: string }> = []
    const ctx = mockContextManager({
      buildMessages: () => [{ role: "user", content: "read-loop correction" }],
      log: { append: (msg: any) => appended.push(msg), get: () => [], clear: () => {} } as any,
    })
    const sessionEvents: any[] = []
    const sessionWriter = {
      enqueue(entry: unknown) {
        sessionEvents.push(entry)
      },
    }
    const earlyStop = new EarlyStopDetector()
    const toolCallEvents = Array.from({ length: 5 }, (_, idx) => ({
      type: "tool_call_end" as const,
      toolCallIndex: idx,
      id: `tc${idx}`,
      name: "read_file",
      arguments: `{"path":"src/${idx}.ts"}`,
    }))
    const client = makeClient([
      [...toolCallEvents, { type: "done", finishReason: "tool_calls" }],
      [{ type: "text_delta", delta: "done" }, { type: "done", finishReason: "stop" }],
    ])
    const toolExecutor: StreamingToolExecutor = {
      async *run(toolCalls: ToolCall[], _signal: AbortSignal, appendResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
        for (const tc of toolCalls) {
          appendResult(tc, { content: "ok", isError: false })
          yield { role: "tool", content: "ok", toolName: tc.function.name, toolCallIndex: 0, toolCallId: tc.id } as LoopEvent
        }
      },
    } as unknown as StreamingToolExecutor

    const events = await collectEvents(runCoreLoop({
      ctx,
      client,
      toolExecutor,
      toolSpecs: [{ type: "function", function: { name: "read_file", description: "r", parameters: {} } }],
      config: { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" },
      signal: noopSignal,
      sessionWriter: sessionWriter as any,
      stats: emptyStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      logger: noopLogger,
      earlyStop,
    }))

    expect(events.filter(e => e.role === "status" && e.content === "early_stop" && e.metadata?.reason === "read_loop_warning")).toHaveLength(1)
    expect(events.filter(e => e.role === "orchestration" && e.orchestration?.kind === "runtime_signal")).toHaveLength(1)
    expect(appended.some(msg => typeof msg.content === "string" && msg.content.includes("read 5 files"))).toBe(true)
    expect(sessionEvents.some(e => (e as any).type === "messages")).toBe(true)
    expect(sessionEvents.some(e => (e as any).payload?.metadata?.reason === "read_loop_warning")).toBe(true)
  })

  it("early-stop tool policy tracks salvage tool results", async () => {
    const appended: Array<{ role: string; content: string }> = []
    const ctx = mockContextManager({
      buildMessages: () => [{ role: "user", content: "salvage read-loop correction" }],
      log: { append: (msg: any) => appended.push(msg), get: () => [], clear: () => {} } as any,
    })
    const sessionEvents: any[] = []
    const policy = createEarlyStopToolLoopPolicy({
      earlyStop: new EarlyStopDetector(),
      sessionWriter: { enqueue: entry => sessionEvents.push(entry) } as any,
    })
    const policyCtx: LoopPolicyContext = {
      turnCount: 1,
      logger: noopLogger,
      signal: noopSignal,
      ctx,
    }

    let result: unknown
    for (let idx = 0; idx < 5; idx++) {
      result = await policy.afterToolResult?.(
        policyCtx,
        { role: "tool", content: "ok", toolName: "read_file", toolCallId: `tc${idx}`, toolCallIndex: idx } as LoopEvent,
        { source: "salvage", toolCalls: [] },
      )
    }

    const emissions = Array.isArray(result) ? result : []
    expect(emissions.map(emission => emission.event.role)).toEqual(["status", "orchestration"])
    expect(emissions[0]?.event.metadata?.reason).toBe("read_loop_warning")
    expect(appended.some(msg => msg.content.includes("read 5 files"))).toBe(true)
    expect(sessionEvents.some(e => (e as any).type === "messages")).toBe(true)
  })
})
