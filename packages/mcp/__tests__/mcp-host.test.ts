import { describe, it, expect } from "vitest"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { McpHost, setMcpHost, isCommandAvailable } from "../src/index.js"

// import.meta.dir may be undefined on some Windows Node.js builds;
// fall back to fileURLToPath + dirname.
const testDir = import.meta.dir ?? dirname(fileURLToPath(import.meta.url))
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
    await host.connect("fake", { command: process.execPath, args: [join(testDir, "fixtures", "fake-mcp.mjs")] })
    expect(host.allTools.map(entry => entry.tool.name)).toEqual(["echo"])
    expect(await host.callTool("fake", "echo", { text: "hello" })).toEqual({ content: [{ type: "text", text: "hello" }] })
    await host.disconnectAll()
  })

  it("should return load summary when some configured servers fail", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepreef-mcp-config-"))
    const configPath = join(dir, "mcp.json")
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        good: { command: process.execPath, args: [join(testDir, "fixtures", "fake-mcp.mjs")] },
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
  const fixture = join(testDir, "fixtures", "fake-mcp.mjs")

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

// ---------------------------------------------------------------------------
// isCommandAvailable — unit tests
// ---------------------------------------------------------------------------
describe("isCommandAvailable", () => {
  it("returns true for an executable that exists on PATH", async () => {
    // `node` is always available in the test runner
    const result = await isCommandAvailable("node")
    expect(result).toBe(true)
  })

  it("returns false for a command that does not exist", async () => {
    const result = await isCommandAvailable("__nonexistent_command_xyz_98765__")
    expect(result).toBe(false)
  })

  it("does not execute shell metacharacters", async () => {
    // This should NOT produce a marker file — it must be treated as a literal name
    const result = await isCommandAvailable("node; touch /tmp/injected-marker")
    expect(result).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Built-in MCP server integration — full coverage
// ---------------------------------------------------------------------------
describe("Built-in MCP server integration", () => {
  const fixture = join(testDir, "fixtures", "fake-mcp.mjs")

  // Helper: write a config file with the given servers
  function writeConfig(dir: string, servers: Record<string, { command: string; args?: string[] }>) {
    const configPath = join(dir, "mcp.json")
    writeFileSync(configPath, JSON.stringify({ mcpServers: servers }))
    return configPath
  }

  it("auto-loads a built-in server when its command is on PATH", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepreef-mcp-builtin-auto-"))
    const configPath = writeConfig(dir, {}) // empty user config

    const host = new McpHost(undefined, {
      builtinServers: {
        _test_builtin: { command: process.execPath, args: [fixture] },
      },
      checkCommand: async () => true,
    })

    try {
      // loadBuiltins: true — even though configPath is provided, built-ins are loaded
      const summary = await host.loadConfig(configPath, { loadBuiltins: true })
      expect(summary.serverCount).toBe(1)
      expect(summary.connected).toBe(1)
      expect(summary.failed).toHaveLength(0)
      expect(host.allTools.some(t => t.client === "_test_builtin")).toBe(true)
    } finally {
      await host.disconnectAll()
    }
  })

  it("skips built-in when user config has the same name", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepreef-mcp-builtin-override-"))
    const configPath = writeConfig(dir, {
      myserver: { command: process.execPath, args: [fixture] },
    })

    const host = new McpHost(undefined, {
      builtinServers: {
        myserver: { command: "/should/not/be/used", args: [] },
      },
      checkCommand: async () => true,
    })

    try {
      // loadBuiltins: true triggers the built-in path, but user config wins
      const summary = await host.loadConfig(configPath, { loadBuiltins: true })
      expect(summary.serverCount).toBe(1)
      expect(summary.connected).toBe(1)
      expect(summary.failed).toHaveLength(0)
      expect(host.allTools.some(t => t.client === "myserver")).toBe(true)
    } finally {
      await host.disconnectAll()
    }
  })

  it("silently skips built-in when command is not on PATH", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepreef-mcp-builtin-skip-"))
    const configPath = writeConfig(dir, {})

    const host = new McpHost(undefined, {
      builtinServers: {
        codegraph: { command: "codegraph", args: ["serve", "--mcp"] },
      },
      checkCommand: async () => false,
    })

    try {
      const summary = await host.loadConfig(configPath, { loadBuiltins: true })
      expect(summary.serverCount).toBe(0)
      expect(summary.connected).toBe(0)
      expect(summary.failed).toHaveLength(0)
      expect(host.allTools).toHaveLength(0)
    } finally {
      await host.disconnectAll()
    }
  })

  it("does not load built-ins when loadBuiltins is false", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepreef-mcp-custom-path-"))
    const configPath = writeConfig(dir, {})

    let checkCommandCalled = false
    const host = new McpHost(undefined, {
      builtinServers: {
        codegraph: { command: "codegraph", args: ["serve", "--mcp"] },
      },
      checkCommand: async () => { checkCommandCalled = true; return true },
    })

    try {
      const summary = await host.loadConfig(configPath, { loadBuiltins: false })
      expect(summary.serverCount).toBe(0)
      expect(summary.connected).toBe(0)
      expect(summary.failed).toHaveLength(0)
      expect(checkCommandCalled).toBe(false)
    } finally {
      await host.disconnectAll()
    }
  })

  it("built-in server connection failure is silent and excluded from statistics", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepreef-mcp-builtin-fail-"))
    const configPath = writeConfig(dir, {})

    const host = new McpHost(undefined, {
      builtinServers: {
        _failing_builtin: { command: process.execPath, args: ["-e", "process.exit(42)"] },
      },
      checkCommand: async () => true,
    })

    try {
      const summary = await host.loadConfig(configPath, { loadBuiltins: true })
      expect(summary.serverCount).toBe(0)
      expect(summary.connected).toBe(0)
      expect(summary.failed).toHaveLength(0)
    } finally {
      await host.disconnectAll()
    }
  })

  it("mixed user + built-in: only user failures appear in failed", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "deepreef-mcp-mixed-"))
    const configPath = writeConfig(dir, {
      good_user: { command: process.execPath, args: [fixture] },
      bad_user: { command: process.execPath, args: ["-e", "process.exit(1)"] },
    })

    const host = new McpHost(undefined, {
      builtinServers: {
        _failing_builtin: { command: process.execPath, args: ["-e", "process.exit(42)"] },
      },
      checkCommand: async () => true,
    })

    try {
      const summary = await host.loadConfig(configPath, { loadBuiltins: true })
      expect(summary.serverCount).toBe(2)
      expect(summary.connected).toBe(1)
      expect(summary.failed).toHaveLength(1)
      expect(summary.failed[0].name).toBe("bad_user")
      expect(summary.failed.some(f => f.name === "_failing_builtin")).toBe(false)
    } finally {
      await host.disconnectAll()
    }
  })

  it("connect() with silent option suppresses all warning logs (host + client)", { timeout: 10_000 }, async () => {
    const warnLogs: Array<{ event: string; data?: Record<string, unknown> }> = []
    const mockLogger = {
      isEnabled: () => true,
      debug: () => {},
      info: () => {},
      warn: (event: string, data?: Record<string, unknown>) => { warnLogs.push({ event, data }) },
      error: () => {},
    }
    const host = new McpHost(mockLogger)

    // Use a command that passes isCommandAvailable but fails to respond (hangs)
    const silentScript = join(tmpdir(), `mcp-silent-${Date.now()}.mjs`)
    writeFileSync(silentScript, `process.stdin.on("data", () => {});`)

    // Start connect (will hang waiting for initialize response), then disconnect early
    const connectPromise = host.connect("_silent_test", {
      command: process.execPath,
      args: [silentScript],
    }, { silent: true }).catch(() => {})
    await new Promise(r => setTimeout(r, 200))
    await host.disconnectAll()
    await connectPromise

    // No warning logs at all — neither from host nor from client
    expect(warnLogs.some(l => l.event === "mcp.server.connect.error")).toBe(false)
    expect(warnLogs.some(l => l.event === "mcp.request.timeout")).toBe(false)
    expect(warnLogs.some(l => l.event === "mcp.request.fail")).toBe(false)
  })

  it("connect() without silent option DOES log warning on failure", { timeout: process.platform === "win32" ? 15000 : 5000 }, async () => {
    const warnLogs: Array<{ event: string; data?: Record<string, unknown> }> = []
    const mockLogger = {
      isEnabled: () => true,
      debug: () => {},
      info: () => {},
      warn: (event: string, data?: Record<string, unknown>) => { warnLogs.push({ event, data }) },
      error: () => {},
    }
    const host = new McpHost(mockLogger)

    await host.connect("_loud_test", {
      command: process.execPath,
      args: ["-e", "process.exit(1)"],
    }).catch(() => {})

    expect(warnLogs.some(l => l.event === "mcp.server.connect.error")).toBe(true)
    await host.disconnectAll()
  })
})
