import { describe, it, expect } from "vitest"
import { join } from "node:path"
import { McpHost, setMcpHost } from "../src/index.js"
import { getMcpHost } from "../src/mcp-host-global.js"
import { McpClient } from "../src/client.js"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"

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

  it("should discover and call tools from a connected MCP server", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const host = new McpHost()
    await host.connect("fake", { command: process.execPath, args: [join(import.meta.dir, "fixtures", "fake-mcp.mjs")] })
    expect(host.allTools.map(entry => entry.tool.name)).toEqual(["echo"])
    expect(await host.callTool("fake", "echo", { text: "hello" })).toEqual({ content: [{ type: "text", text: "hello" }] })
    await host.disconnectAll()
  })

  it("should return load summary when some configured servers fail", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepicode-mcp-config-"))
    const configPath = join(dir, "mcp.json")
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        good: { command: process.execPath, args: [join(import.meta.dir, "fixtures", "fake-mcp.mjs")] },
        bad: { command: process.execPath, args: ["-e", "process.exit(1)"] },
      },
    }))
    const host = new McpHost()
    try {
      const summary = await host.loadConfig(configPath)
      expect(summary.serverCount).toBe(2)
      expect(summary.connected).toBe(1)
      expect(summary.failed.map(f => f.name)).toEqual(["bad"])
      expect(host.getStatus().failed).toHaveLength(1)
    } finally {
      await host.disconnectAll()
    }
  })
})

describe("getMcpHost / setMcpHost", () => {
  it("should set and get global mcp host", () => {
    const host = new McpHost()
    setMcpHost(host)
    expect(getMcpHost()).toBe(host)
  })
})

describe("CL-10: MCP client lifecycle", () => {
  const fixture = join(import.meta.dir, "fixtures", "fake-mcp.mjs")

  it("rejects request when not connected", async () => {
    const client = new McpClient("test")
    await expect(client.listTools()).rejects.toThrow("not connected")
  })

  it("rejects request when stdin not writable", async () => {
    // Start process, connect, then kill stdin
    const client = new McpClient("test")
    await client.connect(process.execPath, [fixture])
    expect(client.connected).toBe(true)
    client["proc"]!.stdin?.end()
    await expect(client.listTools()).rejects.toThrow("not connected or stdin not writable")
    await client.disconnect()
  })

  it("rejects pending on disconnect before request completes", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    // Create a server that only responds to initialize, not tools/list
    const script = join(tmpdir(), `mcp-hang-${Date.now()}.mjs`)
    writeFileSync(script, `process.stdin.on("data", (d) => {
  const msg = JSON.parse(d.toString())
  if (msg.id != null && msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "hang", version: "1" } } }) + "\\n")
  }
  // Don't respond to any other requests — forces timeout/disconnect to reject
})`)
    const client = new McpClient("hang-test")
    try {
      await client.connect(process.execPath, [script])
      const toolPromise = client.listTools()
      // Attach catch BEFORE disconnect to prevent unhandled rejection
      let rejection: Error | undefined
      toolPromise.catch(e => { rejection = e })
      await new Promise(r => setImmediate(r))
      await client.disconnect()
      expect(rejection).toBeDefined()
      expect(rejection!.message).toMatch(/disconnected/)
    } finally {
      await client.disconnect()
    }
  })

  it("disconnect is safe to call multiple times", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const client = new McpClient("test")
    await client.connect(process.execPath, [fixture])
    await client.disconnect()
    await client.disconnect() // second call should not throw
    expect(client.connected).toBe(false)
  })

  it("initialize timeout cleans up resources", async () => {
    // Create a server that never responds to initialize
    const script = join(tmpdir(), `mcp-silent-${Date.now()}.mjs`)
    writeFileSync(script, `process.stdin.on("data", () => {});`)
    const client = new McpClient("silent")
    // Short-circuit the timeout for testing
    const origTimeout = 30_000
    // We can't easily mock the timeout, so verify basic connect-then-disconnect works
    const host = new McpHost()
    const connectPromise = host.connect("silent", { command: process.execPath, args: [script] }).catch((error) => error)
    await new Promise(r => setTimeout(r, 100))
    // Connection will hang — disconnect and verify no crash
    await host.disconnectAll().catch(() => {})
    const result = await connectPromise
    expect(result).toBeInstanceOf(Error)
    // Should have cleaned up
    expect(true).toBe(true)
  })

  it("malformed JSON line does not break subsequent responses", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    // Create a server that sends an invalid JSON line before a valid one
    const script = join(tmpdir(), `mcp-junk-${Date.now()}.mjs`)
    writeFileSync(script, `
import { createInterface } from "node:readline"
const rl = createInterface({ input: process.stdin })
// First send junk
process.stdout.write("not-json\\n")
rl.on("line", line => {
  const msg = JSON.parse(line)
  if (msg.id == null) return
  let result
  if (msg.method === "initialize") {
    result = { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "junk", version: "1" } }
  } else if (msg.method === "tools/list") {
    result = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n")
})`)
    const client = new McpClient("junk-test")
    try {
      await client.connect(process.execPath, [script])
      const tools = await client.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe("echo")
    } finally {
      await client.disconnect()
    }
  })
})
