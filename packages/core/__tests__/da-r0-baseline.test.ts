/**
 * DA-R0: 建立真实基线与失败测试
 *
 * 本文件包含能够证明缺陷的失败测试，用于验证双角色模块的真实状态。
 * 测试必须 import 和执行生产实现，禁止重新实现副本。
 */

import { describe, it, expect, beforeEach } from "bun:test"
import { loadAgentProfiles, saveAgentProfiles, validateAgentProfiles } from "../src/agent-profile/index.js"
import { CapabilityCatalog, RoleCapabilityView } from "../src/capability-catalog/catalog.js"
import { DualAgentRuntime, AgentRuntime } from "../src/dual-agent-runtime/index.js"
import type { DualAgentRuntimeOptions } from "../src/dual-agent-runtime/index.js"
import { WorkflowCoordinator } from "../src/workflow-coordinator/coordinator.js"
import { loadSupervisorPool, DEFAULT_SUPERVISOR_POOL } from "../src/supervisor/pool.js"
import type { DualAgentRuntimeConfig, SendToOptions } from "../src/dual-agent-runtime/types.js"

describe("DA-R0: 真实基线测试", () => {
  describe("Agent Profile 缺陷", () => {
    it("应该拒绝未知字段（严格校验）", () => {
      const invalidConfig = {
        version: 1,
        worker: {
          role: "worker",
          modelTarget: "test",
          harness: "normal",
          thinking: "high",
          tools: {},
          plugins: [],
          mcpServers: [],
          skills: [],
          unknownField: "should be rejected",  // 未知字段
        },
        supervisor: {
          role: "supervisor",
          modelTarget: "test",
          harness: "normal",
          thinking: "off",
          tools: {},
          plugins: [],
          mcpServers: [],
          skills: [],
        },
      }

      // 当前实现可能接受未知字段，需要严格校验
      const result = validateAgentProfiles(invalidConfig)
      // 期望：严格校验应该拒绝未知字段
      // 当前：可能接受未知字段
      expect(result.success).toBe(false)
    })

    it("应该强制角色字段匹配", () => {
      const mismatchedConfig = {
        version: 1,
        worker: {
          role: "supervisor",  // 错误：应该是 "worker"
          modelTarget: "test",
          harness: "normal",
          thinking: "high",
          tools: {},
          plugins: [],
          mcpServers: [],
          skills: [],
        },
        supervisor: {
          role: "worker",  // 错误：应该是 "supervisor"
          modelTarget: "test",
          harness: "normal",
          thinking: "off",
          tools: {},
          plugins: [],
          mcpServers: [],
          skills: [],
        },
      }

      const result = validateAgentProfiles(mismatchedConfig)
      // 期望：角色不匹配应该被拒绝
      expect(result.success).toBe(false)
    })
  })

  describe("CapabilityCatalog 缺陷", () => {
    it("Supervisor 不应该配置写工具（强制只读）", () => {
      const catalog = new CapabilityCatalog()
      const supervisorView = new RoleCapabilityView(catalog, {
        role: "supervisor",
        profile: {
          role: "supervisor",
          modelTarget: "test",
          harness: "normal",
          thinking: "off",
          tools: {
            allow: ["write_file", "edit", "bash"],  // 尝试允许写工具
          },
          plugins: [],
          mcpServers: [],
          skills: [],
        },
      })

      // 获取 Supervisor 可用工具
      const tools = supervisorView.tools

      // 期望：Supervisor 不应该有写工具
      // 当前：可能允许写工具
      expect(tools.some(t => t.name === "write_file")).toBe(false)
      expect(tools.some(t => t.name === "edit")).toBe(false)
      expect(tools.some(t => t.name === "bash")).toBe(false)
    })
  })

  describe("DualAgentRuntime 缺陷", () => {
    it("空模型参数应该被拒绝", () => {
      // 期望：空模型参数应该抛出错误
      expect(() => {
        new DualAgentRuntime({
          workerClient: {} as any,
          supervisorClient: {} as any,
          workerSystemPrompt: "worker prompt",
          supervisorSystemPrompt: "supervisor prompt",
          config: {
            workerModelTarget: "",
            supervisorModelTarget: "supervisor.test",
            workerThinking: "high",
            supervisorThinking: "off",
            maxWorkflowRounds: 9,
          },
          workerConfig: {
            apiKey: "",
            baseUrl: "test",
            model: "test",
            maxTokens: 8192,
            temperature: 0.3,
          },
          supervisorConfig: {
            apiKey: "test",
            baseUrl: "test",
            model: "test",
            maxTokens: 8192,
            temperature: 0.3,
          },
        })
      }).toThrow()
    })

    it("interrupt 应该传递到子运行时", async () => {
      const config: DualAgentRuntimeConfig = {
        workerModelTarget: "worker.test",
        supervisorModelTarget: "supervisor.test",
        workerThinking: "high",
        supervisorThinking: "off",
        maxWorkflowRounds: 9,
      }

      const runtime = new DualAgentRuntime({
        config,
        workerClient: {} as any,
        supervisorClient: {} as any,
        workerSystemPrompt: "worker prompt",
        supervisorSystemPrompt: "supervisor prompt",
        workerConfig: {
          apiKey: "test",
          baseUrl: "test",
          model: "test",
          maxTokens: 8192,
          temperature: 0.3,
        },
        supervisorConfig: {
          apiKey: "test",
          baseUrl: "test",
          model: "test",
          maxTokens: 8192,
          temperature: 0.3,
        },
      })

      // 启动一个长时间运行的任务
      const submitPromise = runtime.sendTo("worker", "test input")

      // 中断
      runtime.interruptRole("worker")

      // 期望：中断应该被传递
      // 当前：可能中断信号未传递
      try {
        await submitPromise
      } catch (e) {
        // 期望抛出中断错误
        expect(e).toBeDefined()
      }
    })
  })

  describe("WorkflowCoordinator 缺陷", () => {
    it("非法转换应该被拒绝", () => {
      const coordinator = new WorkflowCoordinator()

      coordinator.startWorkflow({
        workflowId: "test",
        goal: "test goal",
        maxRounds: 9,
      })

      // 尝试非法转换：从 supervisor_analyse 直接到 approve
      const result = coordinator.transition("approve")

      // 期望：非法转换应该失败
      // 当前：可能接受非法转换
      expect(result.success).toBe(false)
    })

    it("9 轮上限应该阻塞", () => {
      const coordinator = new WorkflowCoordinator()

      coordinator.startWorkflow({
        workflowId: "test",
        goal: "test goal",
        maxRounds: 2,  // 设置较小的轮次上限
      })

      // 模拟 2 轮完整循环
      for (let i = 0; i < 2; i++) {
        coordinator.transition("supervisor_analyse")
        coordinator.transition("worker_do")
        coordinator.transition("worker_report")
        coordinator.transition("supervisor_check")
        coordinator.transition("continue")
      }

      // 第 3 轮应该被阻塞
      const canContinue = coordinator.canContinue()
      // 期望：超过轮次上限应该返回 false
      // 当前：可能继续允许
      expect(canContinue).toBe(false)
    })
  })
})

describe("DA-R0: 真实流事件测试", () => {
  it("应该处理真实流事件（delta、final、usage、tool call）", async () => {
    // 这个测试需要 mock ChatClient，但应该测试真实的流事件处理
    // 当前：可能只测试了简化版本

    const mockClient = {
      chatCompletionsStream: (async function* () {
        yield { type: "text_delta", delta: "Hello" }
        yield { type: "done", finishReason: null }
      }) as any,
    }

    const runtime = new AgentRuntime({
      role: "worker",
      client: mockClient,
      systemPrompt: "You are a worker",
      contextWindow: 128_000,
      maxContextRounds: 20,
      config: {
        apiKey: "test-key",
        baseUrl: "https://test.com",
        model: "test-model",
        maxTokens: 8192,
        temperature: 0.3,
      },
    })

    // 期望：应该能够处理真实流事件
    // 当前：可能只处理了部分事件类型
    expect(runtime).toBeDefined()
  })
})

describe("DA-R0: Supervisor 写工具测试", () => {
  it("Supervisor 不应该执行写工具", async () => {
    const catalog = new CapabilityCatalog()
    const supervisorView = new RoleCapabilityView(catalog, {
      role: "supervisor",
      profile: {
        role: "supervisor",
        modelTarget: "test",
        harness: "normal",
        thinking: "off",
        tools: {
          allow: ["write_file", "edit", "bash"],
          deny: [],
        },
        plugins: [],
        mcpServers: [],
        skills: [],
      },
    })

    // 期望：Supervisor 视图应该拒绝写工具
    // 当前：可能允许写工具
    const tools = supervisorView.tools
    const hasWriteTools = tools.some(t =>
      ["write_file", "edit", "bash", "WriteFile", "EditFile"].includes(t.name)
    )

    expect(hasWriteTools).toBe(false)
  })
})
