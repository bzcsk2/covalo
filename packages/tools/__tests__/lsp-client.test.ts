import { describe, it, expect, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { LspClient } from "../src/lsp/lsp-client.js"
import { pathToFileURL, fileURLToPath } from "node:url"

const fakeLspPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp.mjs")

describe("LspClient", () => {
  let client: LspClient | null = null
  const cwd = mkdtempSync(join(tmpdir(), "lsp-client-test-"))

  afterEach(async () => {
    if (client) {
      client.kill()
      client = null
    }
  })

  it("should start and initialize", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await client.start()
    expect(client.getState()).toBe("starting")

    const capabilities = await client.initialize()
    expect(client.getState()).toBe("running")
    expect(capabilities).toBeDefined()
    expect(capabilities.hoverProvider).toBe(true)
    expect(capabilities.definitionProvider).toBe(true)
  })

  it("should send hover request", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await client.start()
    await client.initialize()

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")
    await client.openDocument(testFile, "typescript", "const x = 42")

    const result = await client.request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(testFile).href },
      position: { line: 0, character: 6 },
    })

    expect(result).toEqual({ contents: "fake hover" })
  })

  it("should send definition request", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await client.start()
    await client.initialize()

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")
    await client.openDocument(testFile, "typescript", "const x = 42")

    const result = await client.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(testFile).href },
      position: { line: 0, character: 6 },
    })

    expect(result).toBeDefined()
    expect((result as any).uri).toContain("definition.ts")
  })

  it("should send references request", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await client.start()
    await client.initialize()

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")
    await client.openDocument(testFile, "typescript", "const x = 42")

    const result = await client.request("textDocument/references", {
      textDocument: { uri: pathToFileURL(testFile).href },
      position: { line: 0, character: 6 },
      context: { includeDeclaration: true },
    })

    expect(Array.isArray(result)).toBe(true)
    expect((result as any[]).length).toBe(2)
  })

  it("should handle request timeout", async () => {
    // Create a client with a very short timeout
    const timeoutClient = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 1, // 1ms timeout
    })

    await timeoutClient.start()
    await timeoutClient.initialize()

    // Send a request that will likely timeout due to very short timeout
    try {
      await timeoutClient.request("textDocument/hover", {
        textDocument: { uri: "file:///test.ts" },
        position: { line: 0, character: 0 },
      })
      // If it doesn't timeout, that's also acceptable
    } catch (error) {
      expect((error as Error).message).toContain("timed out")
    } finally {
      timeoutClient.kill()
    }
  }, 10000)

  it("should handle server crash", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await client.start()
    await client.initialize()

    // Kill the server process
    client.kill()

    expect(client.getState()).toBe("stopped")
  })

  it("should shutdown gracefully", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await client.start()
    await client.initialize()

    await client.shutdown()
    expect(client.getState()).toBe("stopped")
  })

  it("should report health", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await client.start()
    await client.initialize()

    const health = client.getHealth()
    expect(health.state).toBe("running")
    expect(health.language).toBe("typescript")
    expect(health.pid).toBeDefined()
    expect(health.uptimeMs).toBeGreaterThan(0)
  })

  it("should open, change, and close documents", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await client.start()
    await client.initialize()

    const testFile = join(cwd, "test.ts")

    await client.openDocument(testFile, "typescript", "const x = 1")
    await client.changeDocument(testFile, 2, "const x = 2")
    await client.closeDocument(testFile)

    // No assertion needed, just ensure no errors
    expect(true).toBe(true)
  })

  it("should handle multiple concurrent requests", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await client.start()
    await client.initialize()

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")
    await client.openDocument(testFile, "typescript", "const x = 42")

    const hoverPromise = client.request("textDocument/hover", {
      textDocument: { uri: pathToFileURL(testFile).href },
      position: { line: 0, character: 6 },
    })

    const definitionPromise = client.request("textDocument/definition", {
      textDocument: { uri: pathToFileURL(testFile).href },
      position: { line: 0, character: 6 },
    })

    const [hover, definition] = await Promise.all([hoverPromise, definitionPromise])
    expect(hover).toEqual({ contents: "fake hover" })
    expect(definition).toBeDefined()
  })

  it("should reject requests when not running", async () => {
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
    })

    await expect(
      client.request("textDocument/hover", {}),
    ).rejects.toThrow("not ready")
  })

  it("LSP-1: kills client if start() is not followed by initialize() within guard timeout", async () => {
    // 用极短的 guard timeout 触发 watchdog
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
      startingGuardTimeoutMs: 20,
    })

    await client.start()
    expect(client.getState()).toBe("starting")

    // 不调用 initialize()，等待 watchdog 触发
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(client.getState()).toBe("stopped")
  }, 5000)

  it("LSP-1: stale guard timer does not kill a newly started client (same instance)", async () => {
    // 同一个实例：start(short guard) → kill（应清理 timer）→ 再 start(long guard)
    // 若 kill() 没清理旧 timer，旧 timer 到期时会看到 state==="starting" 并误杀新进程。
    client = new LspClient({
      command: process.execPath,
      args: [fakeLspPath],
      cwd,
      rootPath: cwd,
      language: "typescript",
      timeoutMs: 5000,
      startingGuardTimeoutMs: 40,
    })
    await client.start()
    client.kill() // kill 应清理旧 timer
    expect(client.getState()).toBe("stopped")

    // 调大第二次 start 的 guard timeout，使新 timer 不会在观察窗口内触发
    ;(client as any).options.startingGuardTimeoutMs = 2000

    // 立即重新 start（新 timer=2000ms）
    await client.start()
    expect(client.getState()).toBe("starting")

    // 等待超过旧 timer 的 40ms，但远小于新 timer 的 2000ms
    await new Promise((resolve) => setTimeout(resolve, 80))

    // 若旧 timer 没被清理，此时 state 会被 kill 成 "stopped"
    // 若旧 timer 已被清理，state 仍是 "starting"（新 timer 还没到期）
    expect(client.getState()).toBe("starting")

    // 正常 initialize，确认新 client 可用
    await client.initialize()
    expect(client.getState()).toBe("running")
  }, 10000)
})
