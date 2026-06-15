import { describe, it, expect } from "vitest"
import { getAgent, agentConfigFor, AGENTS, getMainMode, MAIN_MODES } from "../src/agent.js"

describe("getAgent", () => {
  it("should return Worker agent definition as default for 'build'", () => {
    const agent = getAgent("build")
    expect(agent.name).toBe("worker")
    expect(agent.label).toBe("Worker")
  })

  it("should return Worker agent definition as default for 'plan'", () => {
    const agent = getAgent("plan")
    expect(agent.name).toBe("worker")
    expect(agent.label).toBe("Worker")
  })

  it("should fallback to worker for unknown agent", () => {
    const agent = getAgent("nonexistent")
    expect(agent.name).toBe("worker")
  })

  it("should have tools for worker agent", () => {
    const agent = getAgent("worker")
    expect(agent.toolNames!.length).toBeGreaterThan(0)
  })

  it("should return Supervisor agent definition for 'supervisor'", () => {
    const agent = getAgent("supervisor")
    expect(agent.name).toBe("supervisor")
    expect(agent.label).toBe("Supervisor")
  })
})

describe("getMainMode", () => {
  it("should return build mode by default", () => {
    const mode = getMainMode("unknown")
    expect(mode.name).toBe("build")
    expect(mode.permissionProfile).toBe("build")
  })

  it("should return plan mode with readonly profile", () => {
    const mode = getMainMode("plan")
    expect(mode.name).toBe("plan")
    expect(mode.permissionProfile).toBe("readonly")
  })
})

describe("agentConfigFor", () => {
  it("should return default config for worker agent", () => {
    const cfg = agentConfigFor("worker")
    expect(cfg.name).toBe("worker")
    expect(cfg.toolNames).toBeDefined()
  })

  it("should return default config for supervisor", () => {
    const cfg = agentConfigFor("supervisor")
    expect(cfg.name).toBe("supervisor")
  })

  it("should apply overrides", () => {
    const cfg = agentConfigFor("worker", { toolNames: ["bash"], systemPrompt: "custom" })
    expect(cfg.toolNames).toEqual(["bash"])
    expect(cfg.systemPrompt).toBe("custom")
  })
})
