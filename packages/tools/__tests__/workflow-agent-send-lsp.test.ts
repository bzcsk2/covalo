import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createWorkflowTool } from "../src/workflow.js"
import { createAgentToolTool } from "../src/agent-tool.js"
import { createSendMessageTool } from "../src/send-message.js"
import { createLspTool } from "../src/lsp.js"
import { createWebSearchTool } from "../src/web-search.js"
import { createWebFetchTool } from "../src/web-fetch.js"

const ctx = {
  cwd: mkdtempSync(join(tmpdir(), "covalo-tools-")),
  sessionId: "test-session",
  signal: new AbortController().signal,
  invokeTool: async (name: string, args: Record<string, unknown>) => ({ content: JSON.stringify({ name, args }), isError: false }),
  delegateTask: async (task: string, agent: string, files: string[]) => JSON.stringify({ task, agent, files }),
} as any

describe("Workflow", () => {
  it("should execute multiple steps", async () => {
    const tool = createWorkflowTool()
    const r = await tool.execute({
      steps: [
        { tool: "bash", args: { command: "echo 1" }, description: "Step 1" },
        { tool: "bash", args: { command: "echo 2" }, description: "Step 2" },
      ],
    }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.totalSteps).toBe(2)
    expect(p.results).toHaveLength(2)
  })

  it("should handle missing tool name", async () => {
    const tool = createWorkflowTool()
    const r = await tool.execute({
      steps: [{ tool: "", args: {} }],
    }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.results[0].status).toBe("error")
  })

  it("should reject empty steps", async () => {
    const tool = createWorkflowTool()
    const r = await tool.execute({ steps: [] }, ctx)
    expect(r.isError).toBe(true)
  })
})

describe("AgentTool", () => {
  it("should not require user approval", () => {
    expect(createAgentToolTool().approval).toBe("read")
  })

  it("should delegate to build agent by default", async () => {
    const tool = createAgentToolTool()
    const r = await tool.execute({ task: "refactor this code" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.subagent_type).toBe("general-purpose")
  })

  it("should accept plan agent type (legacy compat)", async () => {
    const tool = createAgentToolTool()
    const r = await tool.execute({ task: "analyze", agent_type: "plan" }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.subagent_type).toBe("Plan")
  })

  it("should accept new subagent_type parameter", async () => {
    const localCtx = {
      ...ctx,
      spawnSubagent: async (opts: any) => ({
        status: "completed",
        id: "subagent_test",
        subagent_type: opts.subagentType ?? "general-purpose",
        description: opts.description,
        result: "done",
        files: opts.files ?? [],
        usage: { promptTokens: 0, completionTokens: 0 },
        warnings: [],
      }),
    }
    const tool = createAgentToolTool()
    const r = await tool.execute({ prompt: "explore code", description: "explore", subagent_type: "Explore" }, localCtx)
    const p = JSON.parse(r.content as string)
    expect(p.subagent_type).toBe("Explore")
  })

  it("should reject empty prompt", async () => {
    const tool = createAgentToolTool()
    const r = await tool.execute({ prompt: "" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should reject when both prompt and task are empty", async () => {
    const tool = createAgentToolTool()
    const r = await tool.execute({}, ctx)
    expect(r.isError).toBe(true)
  })

  it("should accept files parameter", async () => {
    const tool = createAgentToolTool()
    const r = await tool.execute({ task: "fix bug", files: ["src/index.ts"] }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.files).toEqual(["src/index.ts"])
  })

  it("should generate description from prompt when not provided", async () => {
    const tool = createAgentToolTool()
    const r = await tool.execute({ task: "refactor this code and clean it up" }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.description).toBeDefined()
    expect(p.description.length).toBeGreaterThan(0)
  })

  it("should use spawnSubagent when available", async () => {
    const localCtx = {
      ...ctx,
      spawnSubagent: async (opts: any) => ({
        status: "completed",
        id: "subagent_test",
        subagent_type: "Plan",
        description: "test plan",
        result: "analysis complete",
        files: [],
        usage: { promptTokens: 10, completionTokens: 20 },
        warnings: [],
      }),
    }
    const tool = createAgentToolTool()
    const r = await tool.execute({ prompt: "analyze auth", description: "analyze", subagent_type: "Plan" }, localCtx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.status).toBe("completed")
    expect(p.subagent_type).toBe("Plan")
    expect(p.result).toBe("analysis complete")
  })
})

describe("SendMessage", () => {
  it("should send a message", async () => {
    const tool = createSendMessageTool()
    const r = await tool.execute({ recipient: "build-agent", message: "start working" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.recipient).toBe("build-agent")
    expect(p.messageType).toBe("info")
    expect(p.timestamp).toBeGreaterThan(0)
  })

  it("should accept type parameter", async () => {
    const tool = createSendMessageTool()
    const r = await tool.execute({ recipient: "plan-agent", message: "error occurred", type: "error" }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.messageType).toBe("error")
  })

  it("should reject empty string recipient", async () => {
    const tool = createSendMessageTool()
    const r = await tool.execute({ recipient: "", message: "hi" }, ctx)
    expect(r.isError).toBe(true)
  })
})

describe("LSP", () => {
  it("should reject empty action", async () => {
    const tool = createLspTool()
    const r = await tool.execute({ action: "", file_path: "/tmp/test.ts" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should return unavailable for non-existent file", async () => {
    const tool = createLspTool()
    const r = await tool.execute({ action: "definition", file_path: "/nonexistent/file.ts" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should return an error for language with no default server", async () => {
    const tool = createLspTool()
    writeFileSync(join(ctx.cwd, "test.rb"), "puts 42")
    const r = await tool.execute({ action: "diagnostics", file_path: "test.rb" }, ctx)
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.message).toContain("LSP server not found for language")
  })

  it("should execute a configured LSP hover request", async () => {
    const tool = createLspTool()
    mkdirSync(join(ctx.cwd, ".covalo"), { recursive: true })
    writeFileSync(join(ctx.cwd, "test.ts"), "const answer = 42\n")
    writeFileSync(join(ctx.cwd, ".covalo", "lsp.json"), JSON.stringify({
      languages: { typescript: { command: process.execPath, args: [join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp.mjs")] } },
    }))
    const r = await tool.execute({ action: "hover", file_path: "test.ts" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.status).toBe("ok")
    expect(p.action).toBe("hover")
    expect(p.items).toBeDefined()
    expect(p.items[0].contents).toBe("fake hover")
  })
})

describe("WebSearch", () => {
  it("should reject empty query", async () => {
    const tool = createWebSearchTool()
    const r = await tool.execute({ query: "" }, ctx)
    expect(r.isError).toBe(true)
  })
})

describe("WebFetch", () => {
  it("should reject empty URL", async () => {
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should handle invalid URL", async () => {
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "not a url" }, ctx)
    expect(r.isError).toBe(true)
  })
})
