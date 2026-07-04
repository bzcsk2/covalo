import { describe, it, expect, beforeEach } from "vitest"
import { buildContinuationPrompt, buildBudgetLimitPrompt, buildUsageLimitPrompt } from "../src/goal/steering.js"
import type { ThreadGoal } from "../src/goal/types.js"
import { setPromptLocale } from "../src/prompt-locale.js"

describe("GoalRuntime steering", () => {
  // steering.ts 用 getPromptLocale() 判断 locale，未传 locale 参数时默认 zh-CN，
  // 走中文分支。这些测试的断言期望英文字符串（"requirement-by-requirement audit"
  // / "Budget Limit Reached" / "Usage Limit Reached"），所以测试前必须显式切到 en。
  // 用 beforeEach 而非 beforeAll 是为了未来若新增"locale 切换"测试可隔离副作用。
  beforeEach(() => {
    setPromptLocale("en")
  })

  const mockGoal: ThreadGoal = {
    threadId: "t1",
    goalId: "g1",
    objective: "Fix all bugs",
    status: "active",
    tokenBudget: 50000,
    tokensUsed: 10000,
    timeUsedSeconds: 120,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }

  it("buildContinuationPrompt includes goal objective and budget info", () => {
    const prompt = buildContinuationPrompt(mockGoal, 3)
    expect(prompt).toContain("Fix all bugs")
    expect(prompt).toContain("active")
    expect(prompt).toContain("10000")
    expect(prompt).toContain("50000")
    expect(prompt).toContain("requirement-by-requirement audit")
    expect(prompt).toContain("same blocker for 3 consecutive turns")
  })

  it("buildContinuationPrompt without tokenBudget", () => {
    const goal = { ...mockGoal, tokenBudget: undefined }
    const prompt = buildContinuationPrompt(goal, 1)
    expect(prompt).not.toContain("Budget:")
  })

  it("buildBudgetLimitPrompt mentions wrapping up", () => {
    const prompt = buildBudgetLimitPrompt(mockGoal)
    expect(prompt).toContain("Budget Limit Reached")
    expect(prompt).toContain("50000")
    expect(prompt).toContain("10000")
    expect(prompt).toContain("wrap up")
    expect(prompt).toContain("Do NOT start new substantial work")
  })

  it("buildUsageLimitPrompt mentions stopping", () => {
    const prompt = buildUsageLimitPrompt()
    expect(prompt).toContain("Usage Limit Reached")
    expect(prompt).toContain("Wrap up")
  })
})

describe("GoalRuntime", () => {
  it("onEngineIdle returns false for non-existent goal", async () => {
    const { GoalRuntime } = await import("../src/goal/runtime.js")
    const { GoalStore } = await import("../src/goal/store.js")
    const { WorkflowCoordinator } = await import("../src/workflow-coordinator/coordinator.js")

    const store = new GoalStore("/tmp/nonexistent")
    const coordinator = new WorkflowCoordinator()
    const runtime = new GoalRuntime(store, coordinator)

    expect(runtime.onEngineIdle("nonexistent")).toBe(false)
  })

  it("onEngineIdle returns false for non-active goal", async () => {
    const { GoalRuntime } = await import("../src/goal/runtime.js")
    const { GoalStore } = await import("../src/goal/store.js")
    const { WorkflowCoordinator } = await import("../src/workflow-coordinator/coordinator.js")
    const { rmSync, mkdirSync, existsSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const testDir = resolve(process.cwd(), ".covalo-test-rt-idle")
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })

    const store = new GoalStore(testDir)
    const coordinator = new WorkflowCoordinator()
    const runtime = new GoalRuntime(store, coordinator)

    const goal = store.createGoal("t1", "Test")
    store.updateGoal("t1", { status: "complete" })

    expect(runtime.onEngineIdle("t1")).toBe(false)

    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it("onEngineIdle returns true for active goal within limits", async () => {
    const { GoalRuntime } = await import("../src/goal/runtime.js")
    const { GoalStore } = await import("../src/goal/store.js")
    const { WorkflowCoordinator } = await import("../src/workflow-coordinator/coordinator.js")
    const { rmSync, mkdirSync, existsSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const testDir = resolve(process.cwd(), ".covalo-test-rt-active")
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })

    const store = new GoalStore(testDir)
    const coordinator = new WorkflowCoordinator()
    const runtime = new GoalRuntime(store, coordinator)

    store.createGoal("t1", "Test", 50000)

    expect(runtime.onEngineIdle("t1")).toBe(true)

    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it("onEngineIdle returns false when maxAutoContinuations reached", async () => {
    const { GoalRuntime } = await import("../src/goal/runtime.js")
    const { GoalStore } = await import("../src/goal/store.js")
    const { WorkflowCoordinator } = await import("../src/workflow-coordinator/coordinator.js")
    const { rmSync, mkdirSync, existsSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const testDir = resolve(process.cwd(), ".covalo-test-rt-max")
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })

    const store = new GoalStore(testDir)
    const coordinator = new WorkflowCoordinator()
    const runtime = new GoalRuntime(store, coordinator, { maxAutoContinuations: 2 })

    store.createGoal("t1", "Test", 50000)

    // First two should return true
    expect(runtime.onEngineIdle("t1")).toBe(true)
    runtime.autoContinuationCount = 2
    expect(runtime.onEngineIdle("t1")).toBe(false)

    const goal = store.getGoal("t1")
    expect(goal?.status).toBe("usage_limited")

    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it("onEngineIdle returns false when tokenBudget exceeded", async () => {
    const { GoalRuntime } = await import("../src/goal/runtime.js")
    const { GoalStore } = await import("../src/goal/store.js")
    const { WorkflowCoordinator } = await import("../src/workflow-coordinator/coordinator.js")
    const { rmSync, mkdirSync, existsSync } = await import("node:fs")
    const { resolve } = await import("node:path")
    const testDir = resolve(process.cwd(), ".covalo-test-rt-budget")
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    mkdirSync(testDir, { recursive: true })

    const store = new GoalStore(testDir)
    const coordinator = new WorkflowCoordinator()
    const runtime = new GoalRuntime(store, coordinator)

    store.createGoal("t1", "Test", 1000)
    store.accountProgress("t1", 1500, 10)

    expect(runtime.onEngineIdle("t1")).toBe(false)

    const goal = store.getGoal("t1")
    expect(goal?.status).toBe("budget_limited")

    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
  })

  it("onTurnError increments error count and stops at max", async () => {
    const { GoalRuntime } = await import("../src/goal/runtime.js")
    const { GoalStore } = await import("../src/goal/store.js")
    const { WorkflowCoordinator } = await import("../src/workflow-coordinator/coordinator.js")

    const store = new GoalStore("/tmp/nonexistent")
    const coordinator = new WorkflowCoordinator()
    const runtime = new GoalRuntime(store, coordinator, { maxConsecutiveTurnErrors: 2 })

    expect(runtime.getStatus().consecutiveTurnErrors).toBe(0)

    runtime.onTurnError()
    expect(runtime.getStatus().consecutiveTurnErrors).toBe(1)

    runtime.onTurnError()
    // After reaching max errors, autoContinuationCount should be maxed
    expect(runtime.getStatus().autoContinuationCount).toBe(10) // DEFAULT_MAX
  })

  it("reset clears counters", async () => {
    const { GoalRuntime } = await import("../src/goal/runtime.js")
    const { GoalStore } = await import("../src/goal/store.js")
    const { WorkflowCoordinator } = await import("../src/workflow-coordinator/coordinator.js")

    const store = new GoalStore("/tmp/nonexistent")
    const coordinator = new WorkflowCoordinator()
    const runtime = new GoalRuntime(store, coordinator)

    runtime.autoContinuationCount = 5
    runtime.consecutiveTurnErrors = 2
    runtime.reset()

    expect(runtime.getStatus().autoContinuationCount).toBe(0)
    expect(runtime.getStatus().consecutiveTurnErrors).toBe(0)
  })
})
