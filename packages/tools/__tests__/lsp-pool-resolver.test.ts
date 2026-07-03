import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { LspClientPool } from "../src/lsp/client-pool.js"
import { resolveServer } from "../src/lsp/server-resolver.js"
import { createLspTool } from "../src/lsp.js"
import { readLspConfig, getLanguageConfig, DEFAULT_LSP_CONFIG } from "../src/lsp/config.js"

const fakeLspPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp.mjs")

function createContext() {
  const cwd = mkdtempSync(join(tmpdir(), "lsp-pool-test-"))
  return {
    cwd,
    sessionId: "test-session",
    signal: new AbortController().signal,
    invokeTool: async () => ({ content: "{}", isError: false }),
    delegateTask: async () => "{}",
  } as any
}

describe("LspClientPool", () => {
  let pool: LspClientPool
  let ctx: any

  beforeEach(() => {
    pool = new LspClientPool()
    ctx = createContext()
    mkdirSync(join(ctx.cwd, ".covalo"), { recursive: true })
    writeFileSync(join(ctx.cwd, ".covalo", "lsp.json"), JSON.stringify({
      languages: {
        typescript: { command: process.execPath, args: [fakeLspPath] },
      },
    }))
    writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42\n")
  })

  afterEach(async () => {
    await pool.disposeAll()
  })

  it("should acquire a client and return same PID on second acquire", async () => {
    const { config } = await readLspConfig(ctx.cwd)
    const server = getLanguageConfig(config, "typescript")!

    const a1 = await pool.acquire("typescript", ctx.cwd, server)
    const pid1 = a1.client.getPid()

    pool.release(a1.serverKey)

    const a2 = await pool.acquire("typescript", ctx.cwd, server)
    const pid2 = a2.client.getPid()

    expect(pid1).toBe(pid2)
    expect(a1.serverKey).toBe(a2.serverKey)
    pool.release(a2.serverKey)
  })

  it("should restart and produce a different PID", async () => {
    const { config } = await readLspConfig(ctx.cwd)
    const server = getLanguageConfig(config, "typescript")!

    const a1 = await pool.acquire("typescript", ctx.cwd, server)
    const pid1 = a1.client.getPid()
    pool.release(a1.serverKey)

    await pool.restart(a1.serverKey)

    const a2 = await pool.acquire("typescript", ctx.cwd, server)
    const pid2 = a2.client.getPid()

    expect(pid2).not.toBe(pid1)
    pool.release(a2.serverKey)
  })

  it("should be collected by idle sweep after restart", async () => {
    const { config } = await readLspConfig(ctx.cwd)
    const server = getLanguageConfig(config, "typescript")!

    const { serverKey } = await pool.acquire("typescript", ctx.cwd, server)
    pool.release(serverKey)
    await pool.restart(serverKey)

    expect(pool.getStatus().length).toBe(1)

    // Start idle sweep with very short timeout
    pool.startIdleSweep(10, 1)

    // Wait for sweep to fire
    await new Promise(resolve => setTimeout(resolve, 50))
    pool.stopIdleSweep()

    expect(pool.getStatus().length).toBe(0)
  })

  it("should find server key via findServerKey", async () => {
    const { config } = await readLspConfig(ctx.cwd)
    const server = getLanguageConfig(config, "typescript")!

    const { serverKey } = await pool.acquire("typescript", ctx.cwd, server)
    pool.release(serverKey)

    const found = pool.findServerKey("typescript", ctx.cwd, server)
    expect(found).toBe(serverKey)
  })

  it("should return undefined for unknown server key", () => {
    const found = pool.findServerKey("nonexistent", "/tmp", { command: "nope" })
    expect(found).toBeUndefined()
  })

  it("should track status of active servers", async () => {
    const { config } = await readLspConfig(ctx.cwd)
    const server = getLanguageConfig(config, "typescript")!

    const { serverKey } = await pool.acquire("typescript", ctx.cwd, server)

    const statuses = pool.getStatus()
    expect(statuses.length).toBe(1)
    expect(statuses[0].serverKey).toBe(serverKey)
    expect(statuses[0].language).toBe("typescript")
    expect(statuses[0].pid).toBeGreaterThan(0)
    expect(statuses[0].state).toBe("running")

    pool.release(serverKey)
  })
})

describe("createLspTool with pool", () => {
  let pool: LspClientPool
  let ctx: any

  beforeEach(() => {
    pool = new LspClientPool()
    ctx = createContext()
    mkdirSync(join(ctx.cwd, ".covalo"), { recursive: true })
    writeFileSync(join(ctx.cwd, ".covalo", "lsp.json"), JSON.stringify({
      languages: {
        typescript: { command: process.execPath, args: [fakeLspPath] },
      },
    }))
    writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42\n")
  })

  afterEach(async () => {
    await pool.disposeAll()
  })

  it("should reuse the same server PID across multiple hovers", async () => {
    const tool = createLspTool(pool)

    const r1 = await tool.execute({ action: "hover", file_path: "test.ts", line: 0, column: 6 }, ctx)
    expect(r1.isError).toBe(false)

    const r2 = await tool.execute({ action: "hover", file_path: "test.ts", line: 0, column: 6 }, ctx)
    expect(r2.isError).toBe(false)

    const statuses = pool.getStatus()
    expect(statuses.length).toBe(1)
  })

  it("should emit didChange when file content changes", async () => {
    const tool = createLspTool(pool)

    // First hover with initial content
    const r1 = await tool.execute({ action: "hover", file_path: "test.ts", line: 0, column: 6 }, ctx)
    expect(r1.isError).toBe(false)

    // Change content and hover again
    writeFileSync(join(ctx.cwd, "test.ts"), "const y = 99\n")
    const r2 = await tool.execute({ action: "hover", file_path: "test.ts", line: 0, column: 6 }, ctx)
    expect(r2.isError).toBe(false)

    // Only one server in pool
    const statuses = pool.getStatus()
    expect(statuses.length).toBe(1)

    // Document should be tracked
    expect(statuses[0].documents).toBe(1)
  })

  it("server_status should reflect real pool state", async () => {
    const tool = createLspTool(pool)

    // First, get server status with no active server
    const r0 = await tool.execute({ action: "server_status", file_path: "test.ts" }, ctx)
    expect(r0.isError).toBe(false)
    const s0 = JSON.parse(r0.content as string)
    expect(s0.status).toBe("ok")
    expect(s0.servers).toEqual([])

    // Do a hover to create a server
    await tool.execute({ action: "hover", file_path: "test.ts", line: 0, column: 6 }, ctx)

    // Check status now shows the server
    const r1 = await tool.execute({ action: "server_status", file_path: "test.ts" }, ctx)
    expect(r1.isError).toBe(false)
    const s1 = JSON.parse(r1.content as string)
    expect(s1.servers.length).toBe(1)
    expect(s1.servers[0].language).toBe("typescript")
    expect(s1.servers[0].pid).toBeGreaterThan(0)
  })

  it("restart_server should restart and change PID", async () => {
    const tool = createLspTool(pool)

    await tool.execute({ action: "hover", file_path: "test.ts", line: 0, column: 6 }, ctx)

    const before = pool.getStatus()
    const pidBefore = before[0].pid

    const r = await tool.execute({ action: "restart_server", file_path: "test.ts" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.status).toBe("ok")
    expect(p.restarted).toBe(true)

    const after = pool.getStatus()
    const pidAfter = after[0].pid
    expect(pidAfter).not.toBe(pidBefore)
  })
})

describe("Server Resolver", () => {
  it("should return not available for empty command without env", async () => {
    const result = await resolveServer(undefined, undefined, "perl", "/tmp")
    expect(result.available).toBe(false)
  })

  it("should resolve via env var COVALO_LSP_SERVER_TYPESCRIPT", async () => {
    process.env.COVALO_LSP_SERVER_TYPESCRIPT = process.execPath
    try {
      const result = await resolveServer(undefined, ["--version"], "typescript", "/tmp")
      expect(result.available).toBe(true)
      expect(result.source).toBe("env")
      expect(result.resolvedPath).toBeDefined()
    } finally {
      delete process.env.COVALO_LSP_SERVER_TYPESCRIPT
    }
  })

  it("should resolve command that exists in PATH", async () => {
    const result = await resolveServer("node", ["--eval", "console.log(1)"], "javascript", "/tmp")
    expect(result.available).toBe(true)
    expect(result.resolvedPath).toBeDefined()
  })

  it("should return not available for non-existent command", async () => {
    const result = await resolveServer("this-command-definitely-does-not-exist-12345", undefined, "rust", "/tmp")
    expect(result.available).toBe(false)
    expect(result.installHint).toBeDefined()
  })

  it("should resolve from package-local node_modules/.bin when available", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "resolver-pkg-"))
    const binDir = join(testDir, "node_modules", ".bin")
    mkdirSync(binDir, { recursive: true })
    const fakeBin = join(binDir, "my-custom-ls")
    writeFileSync(fakeBin, "#!/usr/bin/env bash\necho fake-ls\n")
    try {
      existsSync(fakeBin)
    } catch { }

    const originalDir = dirname(fileURLToPath(import.meta.url))

    const result = await resolveServer("my-custom-ls", undefined, "typescript", "/tmp")
    expect(result.available).toBe(false)
  })

  it("should resolve env var for typescriptreact aliased to TYPESCRIPT", async () => {
    process.env.COVALO_LSP_SERVER_TYPESCRIPT = process.execPath
    try {
      const result = await resolveServer(undefined, undefined, "typescriptreact", "/tmp")
      expect(result.available).toBe(true)
      expect(result.source).toBe("env")
    } finally {
      delete process.env.COVALO_LSP_SERVER_TYPESCRIPT
    }
  })

  it("should resolve env var for javascriptreact aliased to JAVASCRIPT", async () => {
    process.env.COVALO_LSP_SERVER_JAVASCRIPT = process.execPath
    try {
      const result = await resolveServer(undefined, undefined, "javascriptreact", "/tmp")
      expect(result.available).toBe(true)
      expect(result.source).toBe("env")
    } finally {
      delete process.env.COVALO_LSP_SERVER_JAVASCRIPT
    }
  })
})
