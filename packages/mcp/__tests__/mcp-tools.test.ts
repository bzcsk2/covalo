import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { setMcpHost, McpHost } from "../src/index.js"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

describe("McpAuth", () => {
  it("should return list action with empty configured array", async () => {
    const { createMcpAuthTool } = await import("../src/auth.js")
    const tool = createMcpAuthTool()
    const r = await tool.execute({ action: "list" }, {} as any)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.configured).toEqual([])
  })

  it("should reject set action without server", async () => {
    const { createMcpAuthTool } = await import("../src/auth.js")
    const tool = createMcpAuthTool()
    const r = await tool.execute({ action: "set", api_key: "sk-xxx" }, {} as any)
    expect(r.isError).toBe(true)
  })

  it("should reject set action without api_key", async () => {
    const { createMcpAuthTool } = await import("../src/auth.js")
    const tool = createMcpAuthTool()
    const r = await tool.execute({ action: "set", server: "my-server" }, {} as any)
    expect(r.isError).toBe(true)
  })

  it("should reject unknown action", async () => {
    const { createMcpAuthTool } = await import("../src/auth.js")
    const tool = createMcpAuthTool()
    const r = await tool.execute({ action: "delete" }, {} as any)
    expect(r.isError).toBe(true)
  })

  it("should reject missing action", async () => {
    const { createMcpAuthTool } = await import("../src/auth.js")
    const tool = createMcpAuthTool()
    const r = await tool.execute({} as any, {} as any)
    expect(r.isError).toBe(true)
  })

  it("should store, list, and delete a credential without exposing the secret", async () => {
    const { createMcpAuthTool } = await import("../src/auth.js")
    const tool = createMcpAuthTool()
    const ctx = { cwd: mkdtempSync(join(tmpdir(), "deepicode-mcp-auth-")) } as any
    expect((await tool.execute({ action: "set", server: "demo", api_key: "sk-1234567890" }, ctx)).isError).toBe(false)
    const listed = JSON.parse((await tool.execute({ action: "list" }, ctx)).content as string)
    expect(listed.configured[0].server).toBe("demo")
    expect(listed.configured[0].apiKey).not.toContain("1234567890")
    expect(JSON.parse((await tool.execute({ action: "delete", server: "demo" }, ctx)).content as string).status).toBe("deleted")
  })
})

describe("MCP tool bridge", () => {
  beforeEach(() => {
    setMcpHost({
      allTools: [{ client: "demo", tool: { name: "echo", description: "Echo", inputSchema: { type: "object" } } }],
      callTool: async (server: string, tool: string, args: Record<string, unknown>) => ({ server, tool, args }),
    } as any)
  })

  it("should list discovered MCP tools", async () => {
    const { createListMcpToolsTool } = await import("../src/list-tools.js")
    const result = await createListMcpToolsTool().execute({}, {} as any)
    expect(JSON.parse(result.content as string).tools[0]).toMatchObject({ server: "demo", name: "echo" })
  })

  it("should invoke a discovered MCP tool", async () => {
    const { createCallMcpToolTool } = await import("../src/call-tool.js")
    const result = await createCallMcpToolTool().execute({ server: "demo", tool: "echo", arguments: { text: "hi" } }, {} as any)
    expect(JSON.parse(result.content as string)).toEqual({ server: "demo", tool: "echo", args: { text: "hi" } })
  })
})

describe("ListMcpResources", () => {
  beforeEach(() => {
    // Reset global MCP host
    setMcpHost(undefined as any)
  })

  it("should return error when MCP host not initialized", async () => {
    const { createListMcpResourcesTool } = await import("../src/list-resources.js")
    const tool = createListMcpResourcesTool()
    const r = await tool.execute({}, {} as any)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("not initialized")
  })
})

describe("ReadMcpResource", () => {
  beforeEach(() => {
    setMcpHost(undefined as any)
  })

  it("should reject missing uri", async () => {
    const { createReadMcpResourceTool } = await import("../src/read-resource.js")
    const tool = createReadMcpResourceTool()
    const r = await tool.execute({} as any, {} as any)
    expect(r.isError).toBe(true)
  })

  it("should reject empty uri", async () => {
    const { createReadMcpResourceTool } = await import("../src/read-resource.js")
    const tool = createReadMcpResourceTool()
    const r = await tool.execute({ uri: "" }, {} as any)
    expect(r.isError).toBe(true)
  })

  it("should return error when MCP host not initialized", async () => {
    const { createReadMcpResourceTool } = await import("../src/read-resource.js")
    const tool = createReadMcpResourceTool()
    const r = await tool.execute({ uri: "test://resource" }, {} as any)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("not initialized")
  })
})
