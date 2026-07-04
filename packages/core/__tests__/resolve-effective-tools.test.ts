import { describe, it, expect } from "bun:test"
import { resolveEffectiveTools } from "../src/resolve-effective-tools.js"

const ALL_TOOLS = [
  "get_goal",
  "update_goal",
  "list_dir",
  "read_file",
  "grep",
  "bash",
  "edit",
  "write_file",
  "apply_patch",
  "AgentTool",
  "send_message",
  "followup_task",
  "read_mailbox",
  "todowrite",
]

function toolMap(names: string[] = ALL_TOOLS): Map<string, any> {
  const m = new Map()
  for (const name of names) {
    m.set(name, {
      name, description: "", parameters: {},
      concurrency: "shared", approval: "read",
      execute: async () => ({ content: "", isError: false }),
    })
  }
  return m
}

function toolNames(result: ReturnType<typeof resolveEffectiveTools>): string[] {
  return result.tools.map(t => t.function.name)
}

describe("resolveEffectiveTools — phase-scoped supervisor loop", () => {
  it("supervisor_analyse: only shallow planning tools (get_goal + list_dir)", () => {
    const result = resolveEffectiveTools({
      registeredTools: toolMap(),
      role: "supervisor",
      mode: "loop",
      workflowPhase: "supervisor_analyse",
    })
    const names = toolNames(result)
    expect(names).toContain("get_goal")
    expect(names).toContain("list_dir")
    expect(names).toContain("update_goal")
    expect(names).not.toContain("read_file")
    expect(names).not.toContain("grep")
    expect(names).not.toContain("bash")
    expect(names).not.toContain("edit")
    expect(names).not.toContain("write_file")
    expect(names).not.toContain("apply_patch")
    expect(names).not.toContain("AgentTool")
    expect(names).not.toContain("send_message")
    expect(names).not.toContain("followup_task")
    expect(names).not.toContain("read_mailbox")
  })

  it("supervisor_check: verification tools (get_goal + list_dir + read_file + grep)", () => {
    const result = resolveEffectiveTools({
      registeredTools: toolMap(),
      role: "supervisor",
      mode: "loop",
      workflowPhase: "supervisor_check",
    })
    const names = toolNames(result)
    expect(names).toContain("get_goal")
    expect(names).toContain("list_dir")
    expect(names).toContain("read_file")
    expect(names).toContain("grep")
    expect(names).not.toContain("bash")
    expect(names).not.toContain("edit")
    expect(names).not.toContain("write_file")
    expect(names).not.toContain("apply_patch")
    expect(names).not.toContain("AgentTool")
    expect(names).not.toContain("send_message")
    expect(names).not.toContain("followup_task")
    expect(names).not.toContain("read_mailbox")
  })

  it("supervisor_intervene: minimal tools (get_goal + update_goal)", () => {
    const result = resolveEffectiveTools({
      registeredTools: toolMap(),
      role: "supervisor",
      mode: "loop",
      workflowPhase: "supervisor_intervene",
    })
    const names = toolNames(result)
    expect(names).toContain("get_goal")
    expect(names).toContain("update_goal")
    expect(names).not.toContain("list_dir")
    expect(names).not.toContain("read_file")
    expect(names).not.toContain("grep")
    expect(names).not.toContain("bash")
    expect(names).not.toContain("edit")
  })

  it("no workflowPhase defaults to conservative (get_goal + update_goal)", () => {
    const result = resolveEffectiveTools({
      registeredTools: toolMap(),
      role: "supervisor",
      mode: "loop",
    })
    const names = toolNames(result)
    expect(names).toContain("get_goal")
    expect(names).toContain("update_goal")
    expect(names).not.toContain("list_dir")
    expect(names).not.toContain("read_file")
    expect(names).not.toContain("grep")
  })

  it("Worker loop with workflowPhase: unaffected by supervisor phase rules", () => {
    const workerTools = ["read_file", "grep", "bash", "edit", "write_file", "get_goal", "update_goal", "send_message", "followup_task", "read_mailbox"]
    const result = resolveEffectiveTools({
      registeredTools: toolMap(workerTools),
      role: "worker",
      mode: "loop",
      workflowPhase: "worker_do",
      agentToolNames: ["read_file", "grep", "bash", "edit", "write_file"],
    })
    const names = toolNames(result)
    expect(names).toContain("read_file")
    expect(names).toContain("grep")
    expect(names).toContain("bash")
    expect(names).toContain("edit")
    expect(names).toContain("write_file")
    expect(names).not.toContain("get_goal")
    expect(names).not.toContain("update_goal")
    expect(names).not.toContain("send_message")
    expect(names).not.toContain("followup_task")
    expect(names).not.toContain("read_mailbox")
  })
})
