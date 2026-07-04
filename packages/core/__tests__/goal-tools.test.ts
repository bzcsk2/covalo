import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { existsSync, rmSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { GoalStore } from "../src/goal/store.js"
import { createGetGoalTool, createUpdateGoalTool, createGoalTools } from "../src/goal/tools.js"
import type { GoalToolProvider } from "../src/goal/tools.js"

const TEST_DIR = resolve(process.cwd(), ".covalo-test-goal-tools")

function makeStore(): GoalStore {
  return new GoalStore(TEST_DIR)
}

function makeProvider(store: GoalStore, threadId: string): GoalToolProvider {
  return {
    getGoalStore: () => store,
    getThreadId: () => threadId,
  }
}

describe("Goal tools", () => {
  let store: GoalStore
  let threadId: string
  let provider: GoalToolProvider

  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
    mkdirSync(TEST_DIR, { recursive: true })
    store = makeStore()
    threadId = randomUUID()
    provider = makeProvider(store, threadId)
  })

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true })
  })

  describe("get_goal", () => {
    it("returns JSON with goal:null when no goal exists", async () => {
      const tool = createGetGoalTool(provider)
      const result = await tool.execute({}, {} as any)
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.content)
      expect(parsed.ok).toBe(true)
      expect(parsed.action).toBe("status")
      expect(parsed.goal).toBeNull()
      expect(parsed.message).toContain("No goal")
    })

    it("returns goal when one exists", async () => {
      const created = store.createGoal(threadId, "Test goal")
      const tool = createGetGoalTool(provider)
      const result = await tool.execute({}, {} as any)
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.content)
      expect(parsed.ok).toBe(true)
      expect(parsed.action).toBe("status")
      expect(parsed.goal.objective).toBe("Test goal")
      expect(parsed.goal.goalId).toBe(created.goalId)
      expect(parsed.goal.status).toBe("active")
    })
  })

  describe("update_goal", () => {
    it("returns error for no action or status", async () => {
      const tool = createUpdateGoalTool(provider)
      const result = await tool.execute({ status: "active" }, {} as any)
      expect(result.isError).toBe(true)
      const parsed = JSON.parse(result.content)
      expect(parsed.ok).toBe(false)
      expect(parsed.action).toBe("unknown")
      expect(parsed.error).toContain("Must provide action")
    })

    it("marks goal as complete via status param", async () => {
      store.createGoal(threadId, "Test")
      const tool = createUpdateGoalTool(provider)
      const result = await tool.execute({ status: "complete" }, {} as any)
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.content)
      expect(parsed.ok).toBe(true)
      expect(parsed.action).toBe("complete")
      expect(parsed.goal.status).toBe("complete")
    })

    it("marks goal as blocked via status param", async () => {
      store.createGoal(threadId, "Test")
      const tool = createUpdateGoalTool(provider)
      const result = await tool.execute({ status: "blocked" }, {} as any)
      expect(result.isError).toBe(false)
      const parsed = JSON.parse(result.content)
      expect(parsed.ok).toBe(true)
      expect(parsed.action).toBe("block")
      expect(parsed.goal.status).toBe("blocked")
    })

    it("returns error when no goal exists", async () => {
      const tool = createUpdateGoalTool(provider)
      const result = await tool.execute({ status: "complete" }, {} as any)
      expect(result.isError).toBe(true)
      const parsed = JSON.parse(result.content)
      expect(parsed.ok).toBe(false)
      expect(parsed.action).toBe("complete")
      expect(parsed.error).toContain("No active goal")
    })

    it("supports action param: set, update, pause, resume, clear", async () => {
      const tool = createUpdateGoalTool(provider)

      // set
      let res = await tool.execute({ action: "set", objective: "New goal" }, {} as any)
      let parsed = JSON.parse(res.content)
      expect(parsed.ok).toBe(true)
      expect(parsed.action).toBe("set")
      expect(parsed.goal.objective).toBe("New goal")

      // update
      res = await tool.execute({ action: "update", objective: "Updated goal" }, {} as any)
      parsed = JSON.parse(res.content)
      expect(parsed.ok).toBe(true)
      expect(parsed.action).toBe("update")
      expect(parsed.goal.objective).toBe("Updated goal")

      // pause
      res = await tool.execute({ action: "pause" }, {} as any)
      parsed = JSON.parse(res.content)
      expect(parsed.ok).toBe(true)
      expect(parsed.action).toBe("pause")
      expect(parsed.goal.status).toBe("paused")

      // resume
      res = await tool.execute({ action: "resume" }, {} as any)
      parsed = JSON.parse(res.content)
      expect(parsed.ok).toBe(true)
      expect(parsed.action).toBe("resume")
      expect(parsed.goal.status).toBe("active")

      // clear
      res = await tool.execute({ action: "clear" }, {} as any)
      parsed = JSON.parse(res.content)
      expect(parsed.ok).toBe(true)
      expect(parsed.action).toBe("clear")
      expect(parsed.message).toContain("Goal cleared")
    })

    it("returns error for set without objective", async () => {
      const tool = createUpdateGoalTool(provider)
      const res = await tool.execute({ action: "set" }, {} as any)
      const parsed = JSON.parse(res.content)
      expect(parsed.ok).toBe(false)
      expect(parsed.action).toBe("set")
      expect(parsed.error).toContain("objective required")
    })
  })

  describe("createGoalTools", () => {
    it("returns get_goal and update_goal", () => {
      const tools = createGoalTools(provider)
      expect(tools).toHaveLength(2)
      expect(tools[0].name).toBe("get_goal")
      expect(tools[1].name).toBe("update_goal")
    })
  })
})
