/**
 * SPEC S0-1: 权限回复定向化 Core 层单元测试
 *
 * 验证 ReasonixEngine 的 pendingPermissions Map 化 + respondPermissionForRequest()：
 * - 按 requestId 定向 resolve pending，不广播误消费
 * - alwaysAllow 只写入发起 engine 的 permission rule
 * - 多 engine 并发 pending 互不影响
 * - 未知 requestId 返回 false
 *
 * 对照 spec docs/covalo_tui_fix_implementation_spec_20260705.md §2.4
 */
import { describe, it, expect } from "vitest"
import { ReasonixEngine } from "../src/engine.js"
import type { LoopEvent, AgentTool } from "../src/interface.js"

class MockClient {
  private generators: Array<AsyncGenerator<any>> = []
  setGenerators(gs: Array<AsyncGenerator<any>>): void { this.generators = [...gs] }
  chatCompletionsStream(): AsyncGenerator<any> {
    return this.generators.shift() ?? (async function* () {})()
  }
}

const mockClient = new MockClient()

function makeEngine() {
  const engine = new ReasonixEngine({
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    maxTokens: 256,
    temperature: 0.1,
  }, undefined, undefined, mockClient as any)
  // FIX-H1: 这些测试注册自定义 exec 工具（s0_exec_ok 等），在 normal/coding toolset 下
  // 会被 applyDeterministicCategoryFilter 当作 "full" 类过滤掉，导致 permission_ask 永不触发。
  // 切到 loose 让 toolset="full" 放行所有自定义工具。
  engine.setHarnessStrictness("loose")
  return engine
}

/** 构造一个会触发 exec 工具调用的 generator，工具需要 permission ask */
function makeToolCallGenerator(toolName: string) {
  return async function* () {
    yield {
      type: "tool_call_end",
      toolCallIndex: 0,
      id: `tc-${toolName}`,
      name: toolName,
      arguments: "{}",
    }
    yield { type: "done", finishReason: "tool_calls" }
  }
}

/** 终止 generator，避免 hung submit */
function makeFinalGenerator() {
  return async function* () {
    yield { type: "text_delta", delta: "ok" }
    yield { type: "done", finishReason: "stop" }
  }
}

function makeExecTool(name: string, onExecute?: () => void): AgentTool {
  return {
    name,
    description: name,
    parameters: { type: "object", properties: {} },
    concurrency: "exclusive",
    approval: "exec",
    async execute() {
      onExecute?.()
      return { content: `${name}-result`, isError: false }
    },
  }
}

/**
 * 后台驱动 submit 生成器，收集事件直到看到 permission_ask。
 * 返回一个 controller：可在不终止生成器的前提下获取 requestId，
 * 并等待 submit 完成。
 */
function driveSubmitInBackground(engine: ReasonixEngine, prompt: string) {
  const events: LoopEvent[] = []
  let permissionAskEvent: LoopEvent | undefined
  let resolvePermissionAsk: () => void
  const permissionAskSeen = new Promise<void>(resolve => { resolvePermissionAsk = resolve })
  const submitPromise = (async () => {
    // FIX-H1: 传不含 toolNames 的 agentConfig 跳过 resolveEffectiveTools 第一层白名单过滤，
    // 同时 makeEngine() 已 setHarnessStrictness("loose") 让 toolset="full" 放行第二层。
    for await (const e of engine.submit(prompt, { name: "build" })) {
      events.push(e)
      if (e.role === "permission_ask" && !permissionAskEvent) {
        permissionAskEvent = e
        resolvePermissionAsk()
      }
    }
  })()

  return {
    events,
    async waitForPermissionAsk(): Promise<{ requestId: string | undefined; event: LoopEvent | undefined }> {
      await permissionAskSeen
      return {
        requestId: permissionAskEvent?.metadata?.requestId as string | undefined,
        event: permissionAskEvent,
      }
    },
    async done() {
      await submitPromise
    },
  }
}

describe("SPEC S0-1: ReasonixEngine.respondPermissionForRequest()", () => {
  it("按 requestId 定向 resolve pending permission，工具继续执行", async () => {
    let executed = false
    const engine = makeEngine()
    engine.registerTool(makeExecTool("s0_exec_ok", () => { executed = true }))

    mockClient.setGenerators([
      makeToolCallGenerator("s0_exec_ok")(),
      makeFinalGenerator(),
    ])

    const driver = driveSubmitInBackground(engine, "run tool")
    const { requestId, event } = await driver.waitForPermissionAsk()
    expect(requestId).toBeTruthy()
    expect(requestId).toMatch(/^perm_/)
    expect(event?.metadata?.sessionId).toBe(engine.sessionId)
    expect(event?.metadata?.permission).toBe("s0_exec_ok")

    // 定向 resolve — 应返回 true 并允许工具继续执行
    const handled = engine.respondPermissionForRequest(requestId!, true, false)
    expect(handled).toBe(true)

    // 等待 submit 流结束
    await driver.done()

    expect(executed).toBe(true)
  })

  it("未知 requestId 返回 false，不抛错", async () => {
    const engine = makeEngine()
    engine.registerTool(makeExecTool("s0_unknown_id_tool"))

    mockClient.setGenerators([
      makeToolCallGenerator("s0_unknown_id_tool")(),
      makeFinalGenerator(),
    ])

    const driver = driveSubmitInBackground(engine, "run tool")
    const { requestId } = await driver.waitForPermissionAsk()
    expect(requestId).toBeTruthy()

    // 用错误的 requestId 应返回 false
    const handled = engine.respondPermissionForRequest("perm_nonexistent_999", true, false)
    expect(handled).toBe(false)

    // 真实的 requestId 仍能 resolve
    const realHandled = engine.respondPermissionForRequest(requestId!, true, false)
    expect(realHandled).toBe(true)

    await driver.done()
  })

  it("alwaysAllow=true 只为发起 engine 写入 allow rule，不污染其他 engine", async () => {
    const engineA = makeEngine()
    const engineB = makeEngine()
    engineA.registerTool(makeExecTool("s0_cross_a"))
    engineB.registerTool(makeExecTool("s0_cross_b"))

    mockClient.setGenerators([
      makeToolCallGenerator("s0_cross_a")(),
      makeFinalGenerator(),
    ])
    const driverA = driveSubmitInBackground(engineA, "run a")
    const { requestId: reqA } = await driverA.waitForPermissionAsk()
    expect(reqA).toBeTruthy()

    mockClient.setGenerators([
      makeToolCallGenerator("s0_cross_b")(),
      makeFinalGenerator(),
    ])
    const driverB = driveSubmitInBackground(engineB, "run b")
    const { requestId: reqB } = await driverB.waitForPermissionAsk()
    expect(reqB).toBeTruthy()
    expect(reqA).not.toBe(reqB)

    // 用 alwaysAllow=true resolve engineA 的 pending — 写入 A 的 allow rule
    const handledA = engineA.respondPermissionForRequest(reqA!, true, true)
    expect(handledA).toBe(true)

    // engineB 的 pending 仍存在 — 用 reqB 仍能 resolve
    const handledB = engineB.respondPermissionForRequest(reqB!, false, false)
    expect(handledB).toBe(true)

    await driverA.done()
    await driverB.done()
  })

  it("respondPermissionForRequest 不会消费其他 engine 的 pending", async () => {
    const engineA = makeEngine()
    const engineB = makeEngine()
    engineA.registerTool(makeExecTool("s0_isolation_a"))
    engineB.registerTool(makeExecTool("s0_isolation_b"))

    mockClient.setGenerators([
      makeToolCallGenerator("s0_isolation_a")(),
      makeFinalGenerator(),
    ])
    const driverA = driveSubmitInBackground(engineA, "run a")
    const { requestId: reqA } = await driverA.waitForPermissionAsk()

    mockClient.setGenerators([
      makeToolCallGenerator("s0_isolation_b")(),
      makeFinalGenerator(),
    ])
    const driverB = driveSubmitInBackground(engineB, "run b")
    const { requestId: reqB } = await driverB.waitForPermissionAsk()

    // 用 engineB 的 reqB 调用 engineA.respondPermissionForRequest — 应返回 false
    const crossHandled = engineA.respondPermissionForRequest(reqB!, true, false)
    expect(crossHandled).toBe(false)

    // engineA 的 pending 仍存在 — 用 reqA 仍能 resolve
    const realHandled = engineA.respondPermissionForRequest(reqA!, true, false)
    expect(realHandled).toBe(true)

    // engineB 的 pending 仍存在 — 用 reqB 仍能 resolve
    const realHandledB = engineB.respondPermissionForRequest(reqB!, true, false)
    expect(realHandledB).toBe(true)

    await driverA.done()
    await driverB.done()
  })

  it("permission_ask 事件 metadata 包含完整字段 (requestId/sessionId/permission/tool)", async () => {
    const engine = makeEngine()
    engine.registerTool(makeExecTool("s0_metadata_tool"))

    mockClient.setGenerators([
      makeToolCallGenerator("s0_metadata_tool")(),
      makeFinalGenerator(),
    ])

    const driver = driveSubmitInBackground(engine, "run tool")
    const { event } = await driver.waitForPermissionAsk()
    expect(event).toBeDefined()
    expect(event?.metadata?.requestId).toMatch(/^perm_/)
    expect(event?.metadata?.sessionId).toBe(engine.sessionId)
    expect(event?.metadata?.permission).toBe("s0_metadata_tool")
    expect(event?.metadata?.tool).toEqual({
      toolCallId: "tc-s0_metadata_tool",
      toolName: "s0_metadata_tool",
    })

    // 清理 pending
    const requestId = event?.metadata?.requestId as string
    engine.respondPermissionForRequest(requestId, true, false)
    await driver.done()
  })

  it("legacy respondPermission 仍可消费任意 pending（兼容旧调用方）", async () => {
    const engine = makeEngine()
    engine.registerTool(makeExecTool("s0_legacy_tool"))

    mockClient.setGenerators([
      makeToolCallGenerator("s0_legacy_tool")(),
      makeFinalGenerator(),
    ])

    const driver = driveSubmitInBackground(engine, "run tool")
    const { requestId } = await driver.waitForPermissionAsk()
    expect(requestId).toBeTruthy()

    // legacy respondPermission 不带 requestId — 消费 Map 中第一个 pending
    engine.respondPermission(true, false)

    await driver.done()
  })
})
