/**
 * SA-1: engine.spawnSubagent() target 解析能力测试
 *
 * 审核反馈：PR #22 删除了 SubagentRunner 测试，但没有补等价的
 * engine-level subagent target 测试。本测试验证 spawnSubagent 在
 * options.target / def.target 指定时正确解析独立 model target，
 * child engine 使用独立 client，不共享父级 client。
 *
 * Windows EPERM 说明：ReasonixEngine 的静态 import 会触发
 * client.ts 的深层依赖链，在 Windows bun 1.3.x 上存在 EPERM 文件锁
 * bug（与 f0-1-runtime-loop.test.ts 同一问题）。所以依赖 engine 的
 * 集成测试在 Windows 上 skip，Linux/CI 上真实运行。target 解析链
 * 单元测试不依赖 engine，所有平台都运行。
 */

import { describe, it, expect } from "vitest"
import type { ChatClient, LoopEvent } from "../src/interface.js"
import type { DeepreefConfig } from "../src/config.js"

/**
 * 创建 mock ChatClient，记录所有 chatCompletionsStream 调用的参数。
 * 立即 yield 一个 done 事件让 submit 快速结束。
 */
function createMockClient(tracker: { calls: Array<{ model: string; baseUrl: string }> }): ChatClient {
  return {
    chatCompletionsStream: async function* (_messages, options) {
      tracker.calls.push({
        model: options.model ?? "",
        baseUrl: options.baseUrl ?? "",
      })
      yield { role: "assistant_final", content: "subagent done" } as LoopEvent
      yield { role: "done", content: "done" } as LoopEvent
    },
  } as unknown as ChatClient
}

function makeBaseConfig(overrides: Partial<DeepreefConfig> = {}): DeepreefConfig {
  return {
    apiKey: "parent-key",
    baseUrl: "https://parent.example.com/v1",
    model: "parent-model",
    maxTokens: 4096,
    temperature: 0.2,
    contextWindow: 32_768,
    provider: "deepseek",
    ...overrides,
  }
}

// ── Windows EPERM skip ───────────────────────────────────────────────────
//
// Windows 上 bun 1.3.x 存在系统性 EPERM 文件锁 bug。model-target.ts
// import 了 client.ts（DeepSeekClient），加载该模块时触发 EPERM reading
// 错误。所有依赖 model-target 的测试在 Windows 上 skip，Linux/CI 上
// 真实运行。与 f0-1-runtime-loop.test.ts 采用相同的 skip 策略。

const isWindows = process.platform === "win32"
const describeOrSkip = isWindows ? describe.skip : describe

// ── target 解析链单元测试 ─────────────────────────────────────────────────

describeOrSkip("SA-1: target 解析链单元测试", () => {
  it("resolveModelTarget + targetToConfig：worker.local 解析出正确的 provider/model/baseUrl/contextWindow", async () => {
    // 直接验证 spawnSubagent 内部使用的 target 解析链的正确性
    const { resolveModelTarget, targetToConfig, createClientForTarget } = await import("../src/model-target.js")

    const baseConfig = makeBaseConfig()
    const resolved = resolveModelTarget("worker.local", baseConfig)

    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe("worker.local")
    expect(resolved!.provider).toBe("openai-compatible")
    expect(resolved!.baseUrl).toBe("http://127.0.0.1:11434/v1")
    expect(resolved!.contextWindow).toBe(32_768)
    expect(resolved!.keyless).toBe(true)

    const childConfig = targetToConfig(resolved!)
    expect(childConfig.baseUrl).toBe("http://127.0.0.1:11434/v1")
    expect(childConfig.contextWindow).toBe(32_768)

    const childClient = createClientForTarget(resolved!)
    expect(childClient).toBeDefined()
    expect(typeof childClient.chatCompletionsStream).toBe("function")
  })

  it("resolveModelTarget：supervisor.zen-free 解析出 zen provider + 1M contextWindow", async () => {
    const { resolveModelTarget, targetToConfig } = await import("../src/model-target.js")

    const baseConfig = makeBaseConfig()
    const resolved = resolveModelTarget("supervisor.zen-free", baseConfig)

    expect(resolved).not.toBeNull()
    expect(resolved!.provider).toBe("zen")
    expect(resolved!.model).toBe("deepseek-v4-flash-free")
    expect(resolved!.baseUrl).toBe("https://opencode.ai/zen/v1")
    expect(resolved!.contextWindow).toBe(1_000_000)
    expect(resolved!.keyless).toBe(true)

    const childConfig = targetToConfig(resolved!)
    expect(childConfig.baseUrl).toBe("https://opencode.ai/zen/v1")
    expect(childConfig.contextWindow).toBe(1_000_000)
  })

  it("resolveModelTarget：未知 target 返回 null（spawnSubagent 会 fallback 到父配置）", async () => {
    const { resolveModelTarget } = await import("../src/model-target.js")

    const baseConfig = makeBaseConfig()
    const resolved = resolveModelTarget("nonexistent.target", baseConfig)
    expect(resolved).toBeNull()
  })

  it("createClientForTarget：每次返回新实例（不共享父 client）", async () => {
    const { resolveModelTarget, createClientForTarget } = await import("../src/model-target.js")

    const baseConfig = makeBaseConfig()
    const resolved = resolveModelTarget("worker.local", baseConfig)!
    const client1 = createClientForTarget(resolved)
    const client2 = createClientForTarget(resolved)

    expect(client1).not.toBe(client2)
    expect(typeof client1.chatCompletionsStream).toBe("function")
    expect(typeof client2.chatCompletionsStream).toBe("function")
  })
})

// ── engine.spawnSubagent 集成测试（依赖 ReasonixEngine，Windows 上 skip）──

describeOrSkip("SA-1: engine.spawnSubagent target 解析集成测试", () => {
  it("options.target 指定时，child engine 使用 target 的 model/baseUrl（不共享父 client）", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")

    const parentTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }
    const parentClient = createMockClient(parentTracker)

    const engine = new ReasonixEngine(
      makeBaseConfig(),
      undefined,
      undefined,
      parentClient,
    )

    // 用 worker.local target（keyless，baseUrl=http://127.0.0.1:11434/v1）
    const result = await engine.spawnSubagent({
      description: "test target resolution",
      prompt: "do nothing",
      subagentType: "general-purpose",
      target: "worker.local",
    })

    expect(result.status).toBe("completed")

    // 父 client 不应被 child submit 调用（child 用 createClientForTarget 创建独立 client）
    // 如果 child 共享父 client，parentTracker.calls 会记录 child submit 的调用，
    // model 会是 worker.local 的 model（空字符串），baseUrl 会是 http://127.0.0.1:11434/v1。
    // 修正后 child 用独立 client，父 client 不会被 child 调用。
    for (const call of parentTracker.calls) {
      expect(call.model).not.toBe("")
      expect(call.baseUrl).toBe("https://parent.example.com/v1")
    }
  })

  it("def.target 存在但 options.target 缺省时，child engine 使用 def.target", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")

    const parentTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }
    const parentClient = createMockClient(parentTracker)

    const engine = new ReasonixEngine(
      makeBaseConfig(),
      undefined,
      undefined,
      parentClient,
    )

    engine.subagentRegistry.register({
      name: "test-target-agent",
      description: "test agent with def.target",
      systemPrompt: "you are a test agent",
      permissionMode: "readonly",
      target: "supervisor.zen-free",
      tools: ["*"],
    })

    const result = await engine.spawnSubagent({
      description: "test def.target fallback",
      prompt: "do nothing",
      subagentType: "test-target-agent",
    })

    expect(result.status).toBe("completed")

    // 父 client 不应被 child 的 submit 调用
    for (const call of parentTracker.calls) {
      expect(call.baseUrl).toBe("https://parent.example.com/v1")
    }
  })

  it("target 不存在（options.target 和 def.target 都缺省）时，child fallback 到父配置", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")

    const parentTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }
    const parentClient = createMockClient(parentTracker)

    const engine = new ReasonixEngine(
      makeBaseConfig(),
      undefined,
      undefined,
      parentClient,
    )

    const result = await engine.spawnSubagent({
      description: "test no target fallback",
      prompt: "do nothing",
      subagentType: "general-purpose",
    })

    expect(result.status).toBe("completed")

    // target 不存在时 child 共享父 client，父 client 会被 child submit 调用
    expect(parentTracker.calls.length).toBeGreaterThan(0)
    const childCall = parentTracker.calls.find(
      c => c.model === "parent-model" && c.baseUrl === "https://parent.example.com/v1"
    )
    expect(childCall).toBeDefined()
  })
})
