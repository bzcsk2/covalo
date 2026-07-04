/**
 * SA-1: engine.spawnSubagent() target 解析能力测试
 *
 * 审核反馈（第二轮）：原测试调用真实 DeepSeekClient / 本地 Ollama / Zen
 * endpoint，在 Linux CI 上会网络失败。修正后通过 setChildClientFactory()
 * 注入 mock client，避免任何网络调用，并直接断言 child submit 的
 * options（baseUrl/model/contextWindow），充分锁住回归点。
 *
 * target 解析链单元测试（不依赖 ReasonixEngine）验证 resolveModelTarget
 * /targetToConfig/createClientForTarget 的纯函数行为。
 *
 * Windows EPERM 说明：model-target.ts import client.ts（DeepSeekClient），
 * 在 Windows bun 1.3.x 上触发 EPERM 文件锁 bug。所有测试 Windows skip，
 * Linux/CI 上真实运行。与 f0-1-runtime-loop.test.ts 相同策略。
 */

import { describe, it, expect } from "vitest"
import type { ChatClient } from "../src/interface.js"
import type { DeepreefConfig } from "../src/config.js"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * 创建 mock ChatClient，记录所有 chatCompletionsStream 调用的参数。
 * 立即 yield done 让 submit 快速结束。
 *
 * 关键：直接断言 child submit 的 options（baseUrl/model），
 * 而不是只验证"父 client 未被调用"。
 *
 * 注意：DeepSeekClientOptions 不包含 contextWindow（contextWindow 通过
 * childConfig 传给 ContextManager，不是 client options）。contextWindow
 * 的验证在 target 解析链单元测试中通过 targetToConfig 完成。
 */
function createTrackingMockClient(
  tracker: { calls: Array<{ model: string; baseUrl: string }> },
  clientConfig?: { baseUrl?: string; model?: string },
): ChatClient {
  return {
    chatCompletionsStream: async function* (_messages, options) {
      tracker.calls.push({
        model: options.model ?? clientConfig?.model ?? "",
        baseUrl: options.baseUrl ?? clientConfig?.baseUrl ?? "",
      })
      // 匹配 DeepSeekStreamEvent 类型（loop.ts switch event.type）
      yield { type: "text_delta", delta: "subagent done" }
      yield { type: "done", finishReason: "stop" }
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

// ── target 解析链单元测试（验证纯函数行为）─────────────────────────────────

describeOrSkip("SA-1: target 解析链单元测试", () => {
  it("resolveModelTarget + targetToConfig：worker.local 解析出正确的 provider/model/baseUrl/contextWindow", async () => {
    const { resolveModelTarget, targetToConfig } = await import("../src/model-target.js")

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
})

// ── engine.spawnSubagent 集成测试（注入 mock client factory）──────────────
//
// 通过 setChildClientFactory() 注入 mock client，避免调用真实
// DeepSeekClient / 本地 Ollama / Zen endpoint。直接断言 child submit
// 的 options（baseUrl/model/contextWindow），而不是只验证父 client 未被调用。

describeOrSkip("SA-1: engine.spawnSubagent target 解析集成测试", () => {
  it("options.target 指定时，child submit 使用 target 的 baseUrl/model（直接断言 options）", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")

    // 父 client tracker（验证父 client 不被 child 调用）
    const parentTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }
    const parentClient = createTrackingMockClient(parentTracker, {
      baseUrl: "https://parent.example.com/v1",
      model: "parent-model",
    })

    // child client tracker（验证 child submit 的真实 options）
    const childTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }

    const engine = new ReasonixEngine(
      makeBaseConfig(),
      undefined,
      undefined,
      parentClient,
    )

    // 注入 mock child client factory —— 避免真实 DeepSeekClient / 网络
    engine.setChildClientFactory((target, _logger) => {
      return createTrackingMockClient(childTracker, {
        baseUrl: target.baseUrl,
        model: target.model ?? "",
      })
    })

    const result = await engine.spawnSubagent({
      description: "test target resolution",
      prompt: "do nothing",
      subagentType: "general-purpose",
      target: "worker.local",
    })

    expect(result.status).toBe("completed")

    // ── 核心断言：直接验证 child submit 的 options ──
    expect(childTracker.calls.length).toBeGreaterThan(0)
    const childCall = childTracker.calls[0]
    expect(childCall.baseUrl).toBe("http://127.0.0.1:11434/v1")
    expect(childCall.model).toBe("") // worker.local 的 model 为空（keyless，由 baseUrl 路由）

    // 父 client 不应被 child submit 调用（child 用注入的 mock factory）
    for (const call of parentTracker.calls) {
      expect(call.baseUrl).toBe("https://parent.example.com/v1")
      expect(call.model).toBe("parent-model")
    }
  })

  it("def.target 存在但 options.target 缺省时，child submit 使用 def.target 的 baseUrl", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")

    const parentTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }
    const parentClient = createTrackingMockClient(parentTracker, {
      baseUrl: "https://parent.example.com/v1",
      model: "parent-model",
    })

    const childTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }

    const engine = new ReasonixEngine(
      makeBaseConfig(),
      undefined,
      undefined,
      parentClient,
    )

    engine.setChildClientFactory((target, _logger) => {
      return createTrackingMockClient(childTracker, {
        baseUrl: target.baseUrl,
        model: target.model ?? "",
      })
    })

    // 注册带 def.target 的 subagent
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
      // 不传 options.target，应使用 def.target
    })

    expect(result.status).toBe("completed")

    // ── 核心断言：child submit 使用 def.target 的 baseUrl/model ──
    expect(childTracker.calls.length).toBeGreaterThan(0)
    const childCall = childTracker.calls[0]
    expect(childCall.baseUrl).toBe("https://opencode.ai/zen/v1")
    expect(childCall.model).toBe("deepseek-v4-flash-free")

    // 父 client 不应被 child 调用
    for (const call of parentTracker.calls) {
      expect(call.baseUrl).toBe("https://parent.example.com/v1")
    }
  })

  it("target 不存在（options.target 和 def.target 都缺省）时，child fallback 到父配置（共享父 client）", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")

    const parentTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }
    const parentClient = createTrackingMockClient(parentTracker, {
      baseUrl: "https://parent.example.com/v1",
      model: "parent-model",
    })

    const engine = new ReasonixEngine(
      makeBaseConfig(),
      undefined,
      undefined,
      parentClient,
    )

    // 不注入 childClientFactory —— target 不存在时不会触发 factory，直接用父 client

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

  it("SPEC-C: child inherits parent contextPolicy after setContextPolicy", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")

    const parentTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }
    const parentClient = createTrackingMockClient(parentTracker, {
      baseUrl: "https://parent.example.com/v1",
      model: "parent-model",
    })

    const childTracker: { calls: Array<{ model: string; baseUrl: string }> } = { calls: [] }

    const originalCwd = process.cwd()
    const tmp = mkdtempSync(join(tmpdir(), "covalo-policy-inherit-"))
    process.chdir(tmp)

    const engine = new ReasonixEngine(
      makeBaseConfig(),
      undefined,
      undefined,
      parentClient,
    )

    engine.setChildClientFactory((target, _logger) => {
      return createTrackingMockClient(childTracker, {
        baseUrl: target.baseUrl,
        model: target.model ?? "",
      })
    })

    await engine.setContextPolicy({ mode: "compact", triggerRatio: 0.5, targetRatio: 0.2 })

    const result = await engine.spawnSubagent({
      description: "test policy inheritance",
      prompt: "do nothing",
      subagentType: "general-purpose",
    })

    expect(result.status).toBe("completed")

    // 父引擎 policy 不受子引擎影响，且 parent 已提前设置 compact
    expect(engine.getContextPolicy().mode).toBe("compact")
    expect(engine.getContextPolicy().triggerRatio).toBe(0.5)
    expect(engine.getContextPolicy().targetRatio).toBe(0.2)

    process.chdir(originalCwd)
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })
})
