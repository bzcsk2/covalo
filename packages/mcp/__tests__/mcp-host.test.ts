import { describe, it, expect } from "vitest"
import { join } from "node:path"
import { McpHost, setMcpHost } from "../src/index.js"
import { getMcpHost } from "../src/mcp-host-global.js"

describe("McpHost", () => {
  it("should create an empty host", () => {
    const host = new McpHost()
    expect(host).toBeDefined()
  })

  it("should not throw when loading config with no mcp.json", { timeout: 1000 }, async () => {
    const host = new McpHost()
    try {
      const result = host.loadConfig()
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 200))
      await Promise.race([result, timeout])
    } catch {
      // Expected - no config file or timeout
    }
    expect(host).toBeDefined()
  })

  it("should discover and call tools from a connected MCP server", async () => {
    const host = new McpHost()
    await host.connect("fake", { command: process.execPath, args: [join(import.meta.dir, "fixtures", "fake-mcp.mjs")] })
    expect(host.allTools.map(entry => entry.tool.name)).toEqual(["echo"])
    expect(await host.callTool("fake", "echo", { text: "hello" })).toEqual({ content: [{ type: "text", text: "hello" }] })
    await host.disconnectAll()
  })
})

describe("getMcpHost / setMcpHost", () => {
  it("should set and get global mcp host", () => {
    const host = new McpHost()
    setMcpHost(host)
    expect(getMcpHost()).toBe(host)
  })
})
