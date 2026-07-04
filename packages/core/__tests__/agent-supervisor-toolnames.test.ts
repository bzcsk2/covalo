import { describe, it, expect } from "vitest"
import { agentConfigFor, getAgent } from "../src/agent.js"

describe("S1-5: supervisor toolNames 显式防御边界", () => {
  it("supervisor 的 toolNames 不为 undefined", () => {
    const config = agentConfigFor("supervisor")
    expect(config.toolNames).toBeDefined()
    expect(Array.isArray(config.toolNames)).toBe(true)
    expect(config.toolNames!.length).toBeGreaterThan(0)
  })

  it("supervisor toolNames 不包含危险工具", () => {
    const config = agentConfigFor("supervisor")
    const dangerous = ["bash", "edit_file", "write_file", "apply_patch"]
    for (const tool of dangerous) {
      expect(config.toolNames).not.toContain(tool)
    }
  })

  it("supervisor toolNames 包含必要的协调工具", () => {
    const config = agentConfigFor("supervisor")
    const expected = ["read_file", "list_dir", "grep", "todowrite", "AskUserQuestion", "AgentTool"]
    for (const tool of expected) {
      expect(config.toolNames).toContain(tool)
    }
  })

  it("supervisor toolNames 包含 goal/mailbox 编排工具", () => {
    const config = agentConfigFor("supervisor")
    expect(config.toolNames).toContain("get_goal")
    expect(config.toolNames).toContain("update_goal")
    expect(config.toolNames).toContain("send_message")
    expect(config.toolNames).toContain("read_mailbox")
  })

  it("getAgent('supervisor') 返回的 toolNames 也非空", () => {
    const agent = getAgent("supervisor")
    expect(agent.toolNames).toBeDefined()
    expect(agent.toolNames!.length).toBeGreaterThan(0)
  })
})
