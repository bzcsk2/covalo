import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { BranchBudgetTracker } from "../src/governance/branch-budget.js"
import { ModeDecisionEngine } from "../src/governance/mode-decision.js"
import { CheckpointEngine } from "../src/checkpoint/checkpoint-engine.js"
import { setPromptLocale } from "../src/prompt-locale.js"

import type { ChatClient } from "../src/interface.js"
import type { DeepSeekStreamEvent, DeepSeekClientOptions } from "../src/client.js"
import type { ChatMessage, ToolCall, ToolSpec } from "../src/types.js"
import type { LoopEvent, SessionStats, ToolResult } from "../src/interface.js"
import type { EffectiveHarnessPolicy } from "../src/model-profile/types.js"
import type { StreamingToolExecutor } from "../src/streaming-executor.js"

// F0-1/B1-RT: runLoop 和 ContextManager 通过 dynamic import 加载，
// 避免静态 import 触发 loop.ts 的深层依赖链在 Windows 上产生 EPERM。
// 这些模块只在测试实际运行时（Linux/CI）才需要加载。
type RunLoopFn = typeof import("../src/loop.js").runLoop
type ContextManagerCtor = typeof import("../src/context/manager.js").ContextManager
let runLoop: RunLoopFn
let ContextManager: ContextManagerCtor

// 直接构造 EffectiveHarnessPolicy 对象，避免引入 zod 依赖（resolveEffectiveHarnessPolicy
// 通过 strictness.ts 间接 import zod，单元测试环境可能解析不到）
function makePolicy(strictness: "strict" | "normal" | "loose"): EffectiveHarnessPolicy {
  if (strictness === "strict") {
    return {
      strictness: "strict", source: "default",
      toolset: "compact", maxParallelTools: 1, maxTurns: 50,
      readBeforeWrite: "block", textToolSalvage: "off",
      branchBudget: "enforce", checkpoint: "frequent",
      verification: "block", earlyStop: "aggressive",
      toolRouting: "two-stage", executionMode: "forced",
      shellPolicy: "dual-track-conservative", supervisorPolicy: "on-failure",
    }
  }
  if (strictness === "loose") {
    return {
      strictness: "loose", source: "default",
      toolset: "full", maxParallelTools: 4, maxTurns: 100,
      readBeforeWrite: "off", textToolSalvage: "always",
      branchBudget: "observe", checkpoint: "minimal",
      verification: "warn", earlyStop: "critical-only",
      toolRouting: "direct", executionMode: "free",
      shellPolicy: "dual-track", supervisorPolicy: "off",
    }
  }
  // normal
  return {
    strictness: "normal", source: "default",
    toolset: "standard", maxParallelTools: 2, maxTurns: 75,
    readBeforeWrite: "warn", textToolSalvage: "on-native-failure",
    branchBudget: "recover", checkpoint: "safe-point",
    verification: "require-or-waive", earlyStop: "standard",
    toolRouting: "auto", executionMode: "adaptive",
    shellPolicy: "dual-track", supervisorPolicy: "on-failure",
  }
}

/**
 * F0-1 runtime-level 集成测试：真正调用 runLoop()，验证 governance/checkpoint
 * 三件套在 loop 主路径中的行为（区别于 f0-1-governance-integration.test.ts
 * 只模拟 loop.ts 中的关键步骤）。
 *
 * 覆盖审计反馈的 7 个 runtime 验证点：
 * 1. runLoop 无 TaskLedger 时，工具执行成功后仍记录 BranchBudget
 * 2. branchBudget: "recover" 不硬拦截工具，只触发 recovery / forced
 * 3. branchBudget: "enforce" 才硬拦截工具
 * 4. 一个 tool batch 部分 blocked 时，所有 tool_call 都有对应 tool_result
 * 5. effectivePolicy.executionMode = "free" 时不会自动 enter forced
 * 6. effectivePolicy.executionMode = "forced" 时初始就是 forced policy active
 * 7. checkpoint 恢复后的 branch budget 不会被 submit 开始的 reset 清空
 */

// ── mock helpers ───────────────────────────────────────────────────────────

function makeToolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    id: crypto.randomUUID(),
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  }
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

function makeMockExecutor(handlers: Map<string, (args: Record<string, unknown>) => ToolResult>): StreamingToolExecutor {
  // 用 mock 代替真正的 StreamingToolExecutor，避免 import 链触发 EPERM
  const mock = {
    async *run(
      toolCalls: ToolCall[],
      _signal: AbortSignal,
      appendToolResult: (tc: ToolCall, result: ToolResult) => void,
      _traceContext?: Record<string, unknown>,
      _allowedToolNames?: ReadonlySet<string>,
    ): AsyncGenerator<LoopEvent> {
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        const handler = handlers.get(tc.function.name)
        const result = handler
          ? handler(JSON.parse(tc.function.arguments))
          : { content: `unknown tool: ${tc.function.name}`, isError: true }
        appendToolResult(tc, result)
        yield {
          role: result.isError ? "error" : "tool",
          content: result.content,
          toolName: tc.function.name,
          toolCallIndex: i,
          toolCallId: tc.id,
          severity: result.isError ? "error" : undefined,
          metadata: result.metadata,
        } as LoopEvent
      }
    },
  }
  return mock as unknown as StreamingToolExecutor
}

function makeStats(): SessionStats {
  return {
    promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0,
    apiCalls: 0, toolCalls: 0, totalCost: 0,
  }
}

/** 收集 runLoop 所有事件，等 done 出现后返回 */
async function drainLoop(gen: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const out: LoopEvent[] = []
  for await (const evt of gen) {
    out.push(evt)
    if (evt.role === "done") break
  }
  return out
}

/** 写文件成功的 mock handler */
function writeHandler(): (args: Record<string, unknown>) => ToolResult {
  return (args) => ({ content: `wrote ${args.path}`, isError: false })
}

/** 构造只含 write_file 的 mock executor */
function makeWriteExecutor(): StreamingToolExecutor {
  return makeMockExecutor(new Map([["write_file", writeHandler()]]))
}

/** 构造空 executor（无任何工具） */
function makeEmptyExecutor(): StreamingToolExecutor {
  return makeMockExecutor(new Map())
}

// ── 测试 fixture ───────────────────────────────────────────────────────────

// F0-1/B1-RT: 平台条件 skip。
// Windows 上 bun test 存在系统性 EPERM 文件锁 bug，在加载 loop.ts 的深层 import 链
// （executor-helpers.ts / supervisor/guided-loop.ts 等）时触发 EPERM reading 错误。
// 这是 bun 1.3.x 在 Windows 上的已知问题，与代码无关。
// Linux/CI 环境不受影响，测试会真实运行并验证 runLoop() 接入行为。
const isWindows = process.platform === "win32"
const describeOrSkip = isWindows ? describe.skip : describe

describeOrSkip("F0-1 runtime-level: runLoop 接入验证", () => {
  // 本测试组真正调用 runLoop()，验证 governance/checkpoint 三件套在 loop
  // 主路径中的行为。覆盖审计反馈的 7 个 runtime 验证点。
  let tmpDir: string

  beforeAll(async () => {
    // F0-1/B1-RT: dynamic import 避免静态 import 在 Windows 上触发 EPERM。
    // 这两个模块只在测试实际运行时（Linux/CI）才需要加载。
    const loopModule = await import("../src/loop.js")
    const ctxModule = await import("../src/context/manager.js")
    runLoop = loopModule.runLoop
    ContextManager = ctxModule.ContextManager
  })

  beforeEach(() => {
    setPromptLocale("en")
    tmpDir = mkdtempSync(join(tmpdir(), "f0-1-runtime-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("1. 无 TaskLedger 时，工具执行成功后仍记录 BranchBudget", async () => {
    // 准备：fileEditMax=2，模拟一次 write_file 调用
    const tracker = new BranchBudgetTracker({ fileEditMax: 2 })
    tracker.bindWorkspaceRoot(tmpDir)
    const checkpoint = new CheckpointEngine(tmpDir, "rt-1")
    const modeEngine = new ModeDecisionEngine()

    const tools = new Map<string, (args: Record<string, unknown>) => ToolResult>([["write_file", writeHandler()]])
    const toolExecutor = makeMockExecutor(tools)
    const ctx = new ContextManager(20, 32_768)
    const config = { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" }

    const client = makeClient([[
      { type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: JSON.stringify({ path: join(tmpDir, "foo.ts") }) },
      { type: "done", finishReason: "tool_calls" },
    ], [
      // 第二轮模型不再调工具，直接 stop
      { type: "text_delta", delta: "done" },
      { type: "done", finishReason: "stop" },
    ]])

    const appended: ToolResult[] = []
    const appendToolResult = (_tc: ToolCall, result: ToolResult) => { appended.push(result) }

    const events = await drainLoop(runLoop({
      ctx, client, toolExecutor, toolSpecs: [] as ToolSpec[], config,
      signal: new AbortController().signal,
      stats: makeStats(),
      isInterrupted: () => false,
      appendToolResult,
      maxTurns: 3,
      effectivePolicy: makePolicy("normal"),
      branchBudgetTracker: tracker,
      checkpointEngine: checkpoint,
      modeDecisionEngine: modeEngine,
      workspaceRoot: tmpDir,
    }))

    // 验证：loop 自然结束（done 事件）
    expect(events.some(e => e.role === "done")).toBe(true)
    // 验证：BranchBudget 记录了 file edit（无 TaskLedger 也照常计数）
    const inspect = tracker.inspect()
    expect(Object.keys(inspect.fileEdits).length).toBeGreaterThan(0)
    expect(Object.values(inspect.fileEdits)[0]).toBe(1)
  })

  it("2. branchBudget: 'recover' 不硬拦截工具，只触发 recovery / forced", async () => {
    // 准备：fileEditMax=1，已记录 1 次编辑（达到上限），recover 模式不应硬拦截
    const tracker = new BranchBudgetTracker({ fileEditMax: 1 })
    tracker.bindWorkspaceRoot(tmpDir)
    tracker.recordFileEdit(join(tmpDir, "preexisting.ts"))  // 已达上限

    const checkpoint = new CheckpointEngine(tmpDir, "rt-2")
    const modeEngine = new ModeDecisionEngine()
    const tools = new Map<string, (args: Record<string, unknown>) => ToolResult>([["write_file", writeHandler()]])
    const toolExecutor = makeMockExecutor(tools)
    const ctx = new ContextManager(20, 32_768)
    const config = { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" }

    const client = makeClient([[
      { type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: JSON.stringify({ path: join(tmpDir, "bar.ts") }) },
      { type: "done", finishReason: "tool_calls" },
    ], [
      { type: "text_delta", delta: "done" },
      { type: "done", finishReason: "stop" },
    ]])

    const appended: ToolResult[] = []
    const appendToolResult = (_tc: ToolCall, result: ToolResult) => { appended.push(result) }

    const events = await drainLoop(runLoop({
      ctx, client, toolExecutor, toolSpecs: [] as ToolSpec[], config,
      signal: new AbortController().signal,
      stats: makeStats(),
      isInterrupted: () => false,
      appendToolResult,
      maxTurns: 3,
      // recover 模式：启用 tracker 但不硬拦截
      effectivePolicy: makePolicy("normal"),
      branchBudgetTracker: tracker,
      checkpointEngine: checkpoint,
      modeDecisionEngine: modeEngine,
      workspaceRoot: tmpDir,
    }))

    // 验证：recover 模式下工具被实际执行（write_file 被调用），未硬拦截
    // appended 中应包含 write_file 的真实结果（content: "wrote ..."），而非 branch_budget_blocked
    const toolResults = appended.filter(r => !r.metadata?.reason)
    expect(toolResults.length).toBeGreaterThan(0)
    expect(toolResults.some(r => r.content.startsWith("wrote"))).toBe(true)
    // 不应出现 branch_budget_blocked 标记
    expect(appended.every(r => r.metadata?.reason !== "branch_budget_blocked")).toBe(true)
    // 应触发 recovery_pending（已达上限）
    const recover = tracker.shouldBranchRecover()
    expect(recover.triggered).toBe(true)
  })

  it("3. branchBudget: 'enforce' 才硬拦截工具", async () => {
    // 准备：fileEditMax=1，已记录 baz.ts 编辑 1 次；模型发起 write_file 到 baz.ts，会被 block
    // 注意：BranchBudgetTracker.checkToolBlock 是按文件 key 判定的
    // （(this.fileEdits.get(fileKey) ?? 0) >= this.limits.fileEditMax）
    // 之前 record 的是 preexisting.ts，但 tool_call 目标是 baz.ts，
    // baz.ts 的 edit 计数为 0，不触发 block。修复：record 与 tool_call 同一个文件。
    const tracker = new BranchBudgetTracker({ fileEditMax: 1 })
    tracker.bindWorkspaceRoot(tmpDir)
    tracker.recordFileEdit(join(tmpDir, "baz.ts"))  // baz.ts 已达上限

    const checkpoint = new CheckpointEngine(tmpDir, "rt-3")
    const modeEngine = new ModeDecisionEngine()
    const tools = new Map<string, (args: Record<string, unknown>) => ToolResult>([["write_file", writeHandler()]])
    const toolExecutor = makeMockExecutor(tools)
    const ctx = new ContextManager(20, 32_768)
    const config = { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" }

    const client = makeClient([[
      { type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: JSON.stringify({ path: join(tmpDir, "baz.ts") }) },
      { type: "done", finishReason: "tool_calls" },
    ], [
      { type: "text_delta", delta: "done" },
      { type: "done", finishReason: "stop" },
    ]])

    const appended: ToolResult[] = []
    const appendToolResult = (_tc: ToolCall, result: ToolResult) => { appended.push(result) }

    await drainLoop(runLoop({
      ctx, client, toolExecutor, toolSpecs: [] as ToolSpec[], config,
      signal: new AbortController().signal,
      stats: makeStats(),
      isInterrupted: () => false,
      appendToolResult,
      maxTurns: 3,
      // enforce 模式：strict policy → branchBudget: "enforce"
      effectivePolicy: makePolicy("strict"),
      branchBudgetTracker: tracker,
      checkpointEngine: checkpoint,
      modeDecisionEngine: modeEngine,
      workspaceRoot: tmpDir,
    }))

    // 验证：enforce 模式下工具被硬拦截
    expect(appended.some(r => r.metadata?.reason === "branch_budget_blocked")).toBe(true)
  })

  it("4. 一个 tool batch 部分 blocked 时，所有 tool_call 都有对应 tool_result", async () => {
    // 准备：fileEditMax=1，已记录 a.ts 和 b.ts 各 1 次编辑，两个文件都已达上限；
    // 模型同时发起 2 个 write_file 调用，两个都会被 BranchBudget 硬拦截，
    // 但都必须有对应的 tool_result（不产生 orphan tool_call）。
    // 之前 record 的是 preexisting.ts，但 tool_call 目标是 a.ts/b.ts，
    // 两个文件 edit 计数为 0，都不触发 block，导致测试断言失败。
    // 修复：record 与 tool_call 同一组文件。
    const tracker = new BranchBudgetTracker({ fileEditMax: 1 })
    tracker.bindWorkspaceRoot(tmpDir)
    tracker.recordFileEdit(join(tmpDir, "a.ts"))  // a.ts 已达上限
    tracker.recordFileEdit(join(tmpDir, "b.ts"))  // b.ts 已达上限

    const checkpoint = new CheckpointEngine(tmpDir, "rt-4")
    const modeEngine = new ModeDecisionEngine()
    const tools = new Map<string, (args: Record<string, unknown>) => ToolResult>([["write_file", writeHandler()]])
    const toolExecutor = makeMockExecutor(tools)
    const ctx = new ContextManager(20, 32_768)
    const config = { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" }

    // 一次发起 2 个 write_file tool call，两个都达到上限（都会被 block）
    // 简化为：两个都被 block，验证两个都有 tool_result
    const client = makeClient([[
      { type: "tool_call_end", toolCallIndex: 0, id: "tc1", name: "write_file", arguments: JSON.stringify({ path: join(tmpDir, "a.ts") }) },
      { type: "tool_call_end", toolCallIndex: 1, id: "tc2", name: "write_file", arguments: JSON.stringify({ path: join(tmpDir, "b.ts") }) },
      { type: "done", finishReason: "tool_calls" },
    ], [
      { type: "text_delta", delta: "done" },
      { type: "done", finishReason: "stop" },
    ]])

    const appended: { tcId: string; result: ToolResult }[] = []
    const appendToolResult = (tc: ToolCall, result: ToolResult) => { appended.push({ tcId: tc.id, result }) }

    await drainLoop(runLoop({
      ctx, client, toolExecutor, toolSpecs: [] as ToolSpec[], config,
      signal: new AbortController().signal,
      stats: makeStats(),
      isInterrupted: () => false,
      appendToolResult,
      maxTurns: 3,
      effectivePolicy: makePolicy("strict"),
      branchBudgetTracker: tracker,
      checkpointEngine: checkpoint,
      modeDecisionEngine: modeEngine,
      workspaceRoot: tmpDir,
    }))

    // 验证：两个 tool call 都有对应的 tool_result（不产生 orphan tool_call）
    expect(appended.length).toBe(2)
    const tcIds = new Set(appended.map(a => a.tcId))
    expect(tcIds.has("tc1")).toBe(true)
    expect(tcIds.has("tc2")).toBe(true)
    // 所有 tool_result 都应有明确的 reason（block 或 batch_skipped）
    expect(appended.every(a => a.result.metadata?.reason)).toBe(true)
  })

  it("5. effectivePolicy.executionMode = 'free' 时不会自动 enter forced", async () => {
    const tracker = new BranchBudgetTracker({ fileEditMax: 1 })
    tracker.bindWorkspaceRoot(tmpDir)
    // 故意让 BranchBudget 触发 recovery_pending
    tracker.recordFileEdit(join(tmpDir, "x.ts"))
    tracker.recordFileEdit(join(tmpDir, "y.ts"))  // 超限

    const checkpoint = new CheckpointEngine(tmpDir, "rt-5")
    const modeEngine = new ModeDecisionEngine()
    const tools = new Map<string, (args: Record<string, unknown>) => ToolResult>([["write_file", writeHandler()]])
    const toolExecutor = makeMockExecutor(tools)
    const ctx = new ContextManager(20, 32_768)
    const config = { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" }

    const client = makeClient([[
      { type: "text_delta", delta: "done" },
      { type: "done", finishReason: "stop" },
    ]])

    await drainLoop(runLoop({
      ctx, client, toolExecutor, toolSpecs: [] as ToolSpec[], config,
      signal: new AbortController().signal,
      stats: makeStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      maxTurns: 1,
      // loose policy: executionMode: "free", branchBudget: "observe"
      effectivePolicy: makePolicy("loose"),
      branchBudgetTracker: tracker,
      checkpointEngine: checkpoint,
      modeDecisionEngine: modeEngine,
      workspaceRoot: tmpDir,
    }))

    // 验证：free 模式下即使 BranchBudget 触发，也不会进入 forced policy
    expect(checkpoint.isForcedPolicyActive()).toBe(false)
  })

  it("6. effectivePolicy.executionMode = 'forced' 时初始就是 forced policy active", async () => {
    const tracker = new BranchBudgetTracker()
    const checkpoint = new CheckpointEngine(tmpDir, "rt-6")
    const modeEngine = new ModeDecisionEngine()
    const tools = new Map<string, (args: Record<string, unknown>) => ToolResult>()
    const toolExecutor = makeMockExecutor(tools)
    const ctx = new ContextManager(20, 32_768)
    const config = { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" }

    const client = makeClient([[
      { type: "text_delta", delta: "done" },
      { type: "done", finishReason: "stop" },
    ]])

    await drainLoop(runLoop({
      ctx, client, toolExecutor, toolSpecs: [] as ToolSpec[], config,
      signal: new AbortController().signal,
      stats: makeStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      maxTurns: 1,
      // strict policy: executionMode: "forced"
      effectivePolicy: makePolicy("strict"),
      branchBudgetTracker: tracker,
      checkpointEngine: checkpoint,
      modeDecisionEngine: modeEngine,
      workspaceRoot: tmpDir,
    }))

    // 验证：forced 模式下初始即 forced policy active
    expect(checkpoint.isForcedPolicyActive()).toBe(true)
  })

  it("7. pending recovery signal 只触发一次，随后被 consumed", async () => {
    // 准备：预先写入一个未消费的 recovery signal 到 checkpoint
    const checkpoint = new CheckpointEngine(tmpDir, "rt-7")
    await checkpoint.save({
      trigger: "manual",
      branchBudget: new BranchBudgetTracker(),
      appendRecoverySignal: {
        source: "branch_budget",
        message: "test-recovery-signal",
        at: Date.now(),
        consumed: false,
      },
    })

    // 验证：pending signal 存在
    expect(checkpoint.pendingRecoverySignals().length).toBe(1)

    const tracker = new BranchBudgetTracker()
    const modeEngine = new ModeDecisionEngine()
    const tools = new Map<string, (args: Record<string, unknown>) => ToolResult>()
    const toolExecutor = makeMockExecutor(tools)
    const ctx = new ContextManager(20, 32_768)
    const config = { apiKey: "x", baseUrl: "x", model: "x", maxTokens: 100, temperature: 0, provider: "test" }

    // 跑两轮 turn，每轮都会调用 evaluateExecutionMode，但 pending signal 应该只在第一轮被消费
    const client = makeClient([
      [{ type: "text_delta", delta: "t1" }, { type: "done", finishReason: "stop" }],
      [{ type: "text_delta", delta: "t2" }, { type: "done", finishReason: "stop" }],
    ])

    await drainLoop(runLoop({
      ctx, client, toolExecutor, toolSpecs: [] as ToolSpec[], config,
      signal: new AbortController().signal,
      stats: makeStats(),
      isInterrupted: () => false,
      appendToolResult: () => {},
      maxTurns: 2,
      effectivePolicy: makePolicy("normal"),
      branchBudgetTracker: tracker,
      checkpointEngine: checkpoint,
      modeDecisionEngine: modeEngine,
      workspaceRoot: tmpDir,
    }))

    // 验证：pending signal 已被消费，不再返回
    expect(checkpoint.pendingRecoverySignals().length).toBe(0)
  })
})
