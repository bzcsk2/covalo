import { describe, it, expect } from "vitest"
import { createAskUserQuestionTool } from "../src/ask-user.js"
import { createPlanModeTool } from "../src/plan-mode.js"

const ctx = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  switchAgent: (name: string) => `${name} agent`,
} as any

describe("AskUserQuestion", () => {
  it("should return a structured question", async () => {
    const tool = createAskUserQuestionTool()
    const r = await tool.execute({ question: "What is your name?" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.type).toBe("question")
    expect(p.question).toBe("What is your name?")
  })

  it("should include options when provided", async () => {
    const tool = createAskUserQuestionTool()
    const r = await tool.execute({ question: "Pick one", options: ["A", "B", "C"] }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.options).toEqual(["A", "B", "C"])
  })

  it("should filter non-string options", async () => {
    const tool = createAskUserQuestionTool()
    const r = await tool.execute({ question: "Pick", options: ["A", 123 as any, "C"] }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.options).toEqual(["A", "C"])
  })

  it("should reject empty question", async () => {
    const tool = createAskUserQuestionTool()
    const r = await tool.execute({ question: "" }, ctx)
    expect(r.isError).toBe(true)
  })
})

describe("PlanMode", () => {
  it("should return plan mode on enter", async () => {
    const tool = createPlanModeTool()
    const r = await tool.execute({ action: "enter" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.mode).toBe("plan")
  })

  it("should return build mode on exit", async () => {
    const tool = createPlanModeTool()
    const r = await tool.execute({ action: "exit" }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.mode).toBe("build")
  })

  it("should reject invalid action", async () => {
    const tool = createPlanModeTool()
    const r = await tool.execute({ action: "invalid" as any }, ctx)
    expect(r.isError).toBe(true)
  })
})
