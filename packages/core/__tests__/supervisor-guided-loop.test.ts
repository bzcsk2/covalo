import { describe, expect, it, vi, beforeEach } from "vitest"
import { setPromptLocale } from "../src/prompt-locale"

import { ContextManager } from "../src/context/manager.js"
import type { ChatClient } from "../src/interface.js"
import type { ModelTarget } from "../src/model-target.js"
import { SupervisorBudgetTracker } from "../src/supervisor/budget.js"
import {
  buildSupervisorDegradedMessage,
  buildSupervisorRequestMessages,
  buildSupervisorTriggerContext,
  createSupervisorGuidanceState,
  evaluateAndRequestSupervisorAdvice,
  formatSupervisorAdviceForScratch,
  injectAdviceToContext,
  requestSupervisorAdvice,
  runSupervisorGuidanceAtSafePoint,
} from "../src/supervisor/guided-loop.js"
import { DEFAULT_SUPERVISOR_POOL } from "../src/supervisor/pool.js"
import type { SupervisorAdvice } from "../src/supervisor/types.js"
import { SUPERVISOR_ADVICE_VERSION } from "../src/supervisor/types.js"
import type { TaskLedger } from "../src/task-ledger.js"

function validAdvice(): SupervisorAdvice {
  return {
    version: SUPERVISOR_ADVICE_VERSION,
    diagnosis: "工具参数格式反复错误",
    failureClass: "tool_format",
    nextActions: ["检查 JSON 参数格式", "改用 read_file 确认路径"],
    constraints: ["不要重复相同失败调用"],
    verification: ["运行 typecheck"],
    confidence: 0.8,
    shouldContinue: true,
  }
}

function mockLedger(): TaskLedger {
  return {
    goal: "修复 failing test",
    plan: [{ id: "step-1", text: "定位失败", status: "active" }],
    changedFiles: ["src/foo.ts"],
    commandsRun: [],
    verificationPending: true,
    blockers: ["[verification] npm test failed"],
    lastVerification: { command: "npm test", exitCode: 1, summary: "1 failed" },
  }
}

function mockTarget(id = "supervisor.zen-free"): ModelTarget {
  return {
    id,
    role: "supervisor",
    provider: "zen",
    model: "deepseek-v4-flash-free",
    baseUrl: "https://opencode.ai/zen/v1",
    apiKeyPolicy: "keyless",
    keyless: true,
    maxTokens: 800,
    temperature: 0.3,
  }
}

const ENABLED_POOL = {
  candidates: DEFAULT_SUPERVISOR_POOL.candidates.map((c) => ({
    ...c,
    enabled: true,
  })),
}

function mockClient(responseText: string, error?: string): ChatClient {
  return {
    chatCompletionsStream: vi.fn(async function* () {
      if (error) {
        yield { type: "error", message: error }
        return
      }
      yield { type: "text_delta", delta: responseText }
      yield { type: "done", finishReason: "stop" }
    }),
  }
}

describe("formatSupervisorAdviceForScratch", () => {
  it("包含来源、时间戳与 evidence hash", () => {
    setPromptLocale("en")
    const text = formatSupervisorAdviceForScratch(validAdvice(), {
      source: "zen-deepseek",
      timestamp: 1_700_000_000_000,
      evidenceHash: "abc123hash",
      failureClass: "tool_format",
    })
    expect(text).toContain("[SUPERVISOR ADVICE]")
    expect(text).toContain("source: zen-deepseek")
    expect(text).toContain("timestamp: 1700000000000")
    expect(text).toContain("evidence_hash: abc123hash")
    expect(text).toContain("Before executing, briefly state which next action you choose")
  })
})

describe("injectAdviceToContext", () => {
  it("注入到 ctx.scratch", () => {
    setPromptLocale("en")
    const ctx = new ContextManager(32_768)
    injectAdviceToContext({
      ctx,
      advice: validAdvice(),
      evidenceHash: "hash1",
      source: "zen-deepseek",
      timestamp: 123,
    })
    expect(ctx.scratch.messages.length).toBe(1)
    expect(ctx.scratch.messages[0].content).toContain("evidence_hash: hash1")
  })
})

describe("buildSupervisorRequestMessages", () => {
  it("包含 EvidenceBundle JSON", () => {
    const messages = buildSupervisorRequestMessages({
      goal: "fix test",
      failureClass: "tool_format",
      recentFailures: [{ signature: "a", summary: "err" }],
      recentTools: [],
      changedFiles: [],
      attemptedStrategies: [],
    })
    expect(messages.length).toBe(2)
    expect(messages[1].content).toContain("EvidenceBundle:")
    expect(messages[1].content).toContain("fix test")
  })
})

describe("requestSupervisorAdvice", () => {
  it("成功解析 mock SupervisorAdvice", async () => {
    const state = createSupervisorGuidanceState()
    const budget = new SupervisorBudgetTracker()
    const adviceJson = JSON.stringify(validAdvice())

    const result = await requestSupervisorAdvice({
      trigger: { shouldRequest: true, failureClass: "tool_format", reason: "error_signature_threshold" },
      ledger: mockLedger(),
      pool: ENABLED_POOL,
      budget,
      state,
      resolveTarget: (id) => mockTarget(id),
      createClient: () => mockClient(adviceJson),
    })

    expect(result.success).toBe(true)
    expect(result.advice?.diagnosis).toContain("工具参数")
    expect(result.evidenceHash).toBeTruthy()
    expect(result.candidateId).toBe("zen-deepseek")
    expect(state.requestedEvidenceHashes).toContain(result.evidenceHash)
  })

  it("Supervisor API 失败时降级不抛错", async () => {
    const state = createSupervisorGuidanceState()
    const budget = new SupervisorBudgetTracker()

    const result = await requestSupervisorAdvice({
      trigger: { shouldRequest: true, failureClass: "unknown" },
      ledger: mockLedger(),
      pool: ENABLED_POOL,
      budget,
      state,
      resolveTarget: (id) => mockTarget(id),
      createClient: () => mockClient("", "network error"),
    })

    expect(result.success).toBe(false)
    expect(result.degraded).toBe(true)
    expect(result.checkpointHint).toBe(true)
    expect(result.error).toContain("network error")
  })

  it("同 evidence hash 不重复请求", async () => {
    const first = await requestSupervisorAdvice({
      trigger: { shouldRequest: true, failureClass: "tool_format" },
      ledger: mockLedger(),
      pool: ENABLED_POOL,
      budget: new SupervisorBudgetTracker(),
      state: createSupervisorGuidanceState(),
      resolveTarget: (id) => mockTarget(id),
      createClient: () => mockClient(JSON.stringify(validAdvice())),
    })
    expect(first.success).toBe(true)

    const dupState = createSupervisorGuidanceState()
    dupState.requestedEvidenceHashes.push(first.evidenceHash!)
    const dup = await requestSupervisorAdvice({
      trigger: { shouldRequest: true, failureClass: "tool_format" },
      ledger: mockLedger(),
      pool: DEFAULT_SUPERVISOR_POOL,
      budget: new SupervisorBudgetTracker(),
      state: dupState,
      resolveTarget: (id) => mockTarget(id),
      createClient: () => mockClient(JSON.stringify(validAdvice())),
    })
    expect(dup.success).toBe(false)
    expect(dup.error).toContain("已请求过")
  })

  it("无可用候选时 checkpoint hint", async () => {
    const result = await requestSupervisorAdvice({
      trigger: { shouldRequest: true, failureClass: "unknown" },
      ledger: mockLedger(),
      pool: DEFAULT_SUPERVISOR_POOL,
      budget: new SupervisorBudgetTracker(),
      state: createSupervisorGuidanceState(),
      resolveTarget: () => null,
      createClient: () => mockClient(JSON.stringify(validAdvice())),
    })
    expect(result.success).toBe(false)
    expect(result.checkpointHint).toBe(true)
  })
})

describe("evaluateAndRequestSupervisorAdvice", () => {
  it("未触发时不请求", async () => {
    const state = createSupervisorGuidanceState()
    const out = await evaluateAndRequestSupervisorAdvice(
      {
        pool: DEFAULT_SUPERVISOR_POOL,
        budget: new SupervisorBudgetTracker(),
        state,
        resolveTarget: (id) => mockTarget(id),
        supervisorConfigured: false,
      },
      buildSupervisorTriggerContext(state, { supervisorConfigured: false }),
      mockLedger(),
    )
    expect(out.triggered).toBe(false)
    expect(out.injected).toBe(false)
  })

  it("触发且成功时 injected", async () => {
    const state = createSupervisorGuidanceState()
    state.recentFailures = [{ signature: "sig1", count: 5, lastError: "boom" }]
    const out = await evaluateAndRequestSupervisorAdvice(
      {
        pool: ENABLED_POOL,
        budget: new SupervisorBudgetTracker(),
        state,
        resolveTarget: (id) => mockTarget(id),
        createClient: () => mockClient(JSON.stringify(validAdvice())),
      },
      buildSupervisorTriggerContext(state, {
        recentFailures: state.recentFailures,
        supervisorConfigured: true,
      }),
      mockLedger(),
    )
    expect(out.triggered).toBe(true)
    expect(out.injected).toBe(true)
    expect(out.result?.advice).toBeDefined()
  })
})

describe("runSupervisorGuidanceAtSafePoint", () => {
  it("注入 scratch 并返回 status", async () => {
    const ctx = new ContextManager(32_768)
    const state = createSupervisorGuidanceState()
    state.recentFailures = [{ signature: "sig1", count: 5 }]

    const outcome = await runSupervisorGuidanceAtSafePoint(
      {
        pool: ENABLED_POOL,
        budget: new SupervisorBudgetTracker(),
        state,
        resolveTarget: (id) => mockTarget(id),
        createClient: () => mockClient(JSON.stringify(validAdvice())),
      },
      buildSupervisorTriggerContext(state, {
        recentFailures: state.recentFailures,
        supervisorConfigured: true,
      }),
      mockLedger(),
      ctx,
    )

    expect(outcome.injected).toBe(true)
    expect(outcome.statusContent).toBe("supervisor_advice_injected")
    expect(ctx.scratch.messages.length).toBe(1)
  })

  it("Supervisor 不可用时返回降级消息", async () => {
    const ctx = new ContextManager(32_768)
    const state = createSupervisorGuidanceState()
    state.recentFailures = [{ signature: "sig1", count: 5 }]
    let hintCalled = false

    const outcome = await runSupervisorGuidanceAtSafePoint(
      {
        pool: DEFAULT_SUPERVISOR_POOL,
        budget: new SupervisorBudgetTracker(),
        state,
        resolveTarget: () => null,
        onCheckpointHint: () => { hintCalled = true },
      },
      buildSupervisorTriggerContext(state, {
        recentFailures: state.recentFailures,
        supervisorConfigured: true,
      }),
      mockLedger(),
      ctx,
    )

    expect(outcome.injected).toBe(false)
    expect(outcome.statusContent).toBe("supervisor_degraded")
    expect(outcome.degradedMessage).toBeTruthy()
    expect(hintCalled).toBe(true)
    expect(ctx.scratch.messages.length).toBe(0)
  })
})

describe("buildSupervisorDegradedMessage", () => {
  it("截断过长错误", () => {
    setPromptLocale("en")
    const msg = buildSupervisorDegradedMessage({
      success: false,
      error: "x".repeat(300),
    })
    expect(msg.length).toBeLessThan(250)
    expect(msg).toContain("Supervisor degraded")
  })
})
