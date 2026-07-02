import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LspManager } from "../src/lsp/manager.js"
import { pathToFileURL } from "node:url"

const fakeLspPath = join(import.meta.dir, "fixtures", "fake-lsp.mjs")

describe("LspManager", () => {
  let manager: LspManager | null = null
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "lsp-manager-test-"))
    mkdirSync(join(cwd, ".covalo"), { recursive: true })
    writeFileSync(join(cwd, ".covalo", "lsp.json"), JSON.stringify({
      languages: {
        typescript: { command: process.execPath, args: [fakeLspPath] },
      },
    }))
  })

  afterEach(async () => {
    if (manager) {
      await manager.shutdownAll()
      manager = null
    }
  })

  it("should create manager", () => {
    manager = new LspManager(cwd)
    expect(manager).toBeDefined()
  })

  it("should get status with no servers", () => {
    manager = new LspManager(cwd)
    const status = manager.getStatus()
    expect(status.servers).toHaveLength(0)
    expect(status.documents).toBe(0)
  })

  it("should start server on request", async () => {
    manager = new LspManager(cwd)

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")

    const result = await manager.request(
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 0, character: 6 },
      },
      testFile,
    )

    expect(result).toEqual({ contents: "fake hover" })
  }, 15000)

  it("should reuse server for same language", async () => {
    manager = new LspManager(cwd)

    const testFile1 = join(cwd, "test1.ts")
    writeFileSync(testFile1, "const x = 42")

    const testFile2 = join(cwd, "test2.ts")
    writeFileSync(testFile2, "const y = 43")

    await manager.request(
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(testFile1).href },
        position: { line: 0, character: 6 },
      },
      testFile1,
    )

    const status1 = manager.getStatus()
    expect(status1.servers).toHaveLength(1)

    await manager.request(
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(testFile2).href },
        position: { line: 0, character: 6 },
      },
      testFile2,
    )

    const status2 = manager.getStatus()
    expect(status2.servers).toHaveLength(1)
  }, 15000)

  it("should track documents", async () => {
    manager = new LspManager(cwd)

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")

    await manager.request(
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 0, character: 6 },
      },
      testFile,
    )

    const status = manager.getStatus()
    expect(status.documents).toBe(1)
  }, 15000)

  it("should handle definition request", async () => {
    manager = new LspManager(cwd)

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")

    const result = await manager.request(
      "textDocument/definition",
      {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 0, character: 6 },
      },
      testFile,
    )

    expect(result).toBeDefined()
    expect((result as any).uri).toContain("definition.ts")
  }, 15000)

  it("should handle references request", async () => {
    manager = new LspManager(cwd)

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")

    const result = await manager.request(
      "textDocument/references",
      {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 0, character: 6 },
        context: { includeDeclaration: true },
      },
      testFile,
    )

    expect(Array.isArray(result)).toBe(true)
    expect((result as any[]).length).toBe(2)
  }, 15000)

  it("should mark document dirty and sync", async () => {
    manager = new LspManager(cwd)

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")

    await manager.request(
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 0, character: 6 },
      },
      testFile,
    )

    // Modify file
    writeFileSync(testFile, "const x = 43")
    await manager.markDirty(testFile)

    // Request should still work
    const result = await manager.request(
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 0, character: 6 },
      },
      testFile,
    )

    expect(result).toEqual({ contents: "fake hover" })
  }, 15000)

  it("should get health status", async () => {
    manager = new LspManager(cwd)

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")

    await manager.request(
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 0, character: 6 },
      },
      testFile,
    )

    const health = manager.getHealth()
    expect(health).toHaveLength(1)
    expect(health[0].state).toBe("running")
    expect(health[0].language).toBe("typescript")
  }, 15000)

  it("should shutdown all servers", async () => {
    manager = new LspManager(cwd)

    const testFile = join(cwd, "test.ts")
    writeFileSync(testFile, "const x = 42")

    await manager.request(
      "textDocument/hover",
      {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 0, character: 6 },
      },
      testFile,
    )

    await manager.shutdownAll()

    const status = manager.getStatus()
    expect(status.servers).toHaveLength(0)
  }, 15000)

  it("should handle unknown language gracefully", async () => {
    manager = new LspManager(cwd)

    const testFile = join(cwd, "test.xyz")
    writeFileSync(testFile, "content")

    await expect(
      manager.request("textDocument/hover", {}, testFile),
    ).rejects.toThrow("Cannot detect language")
  })

  it("should handle missing server config gracefully", async () => {
    mkdirSync(join(cwd, ".covalo2"), { recursive: true })
    writeFileSync(join(cwd, ".covalo2", "lsp.json"), JSON.stringify({
      languages: {},
    }))

    manager = new LspManager(join(cwd, ".covalo2"))

    const testFile = join(cwd, ".covalo2", "test.ts")
    writeFileSync(testFile, "const x = 42")

    await expect(
      manager.request("textDocument/hover", {}, testFile),
    ).rejects.toThrow("No LSP server available")
  })

  it("LSP-2: DocumentInfo tracks serverKey and clears only matching docs on server shutdown", async () => {
    // 准备两个 workspace，各自有独立的 .covalo/lsp.json 配置 typescript
    const ws1 = mkdtempSync(join(tmpdir(), "lsp-ws1-"))
    const ws2 = mkdtempSync(join(tmpdir(), "lsp-ws2-"))
    mkdirSync(join(ws1, ".covalo"), { recursive: true })
    mkdirSync(join(ws2, ".covalo"), { recursive: true })
    writeFileSync(join(ws1, ".covalo", "lsp.json"), JSON.stringify({
      languages: { typescript: { command: process.execPath, args: [fakeLspPath] } },
    }))
    writeFileSync(join(ws2, ".covalo", "lsp.json"), JSON.stringify({
      languages: { typescript: { command: process.execPath, args: [fakeLspPath] } },
    }))

    const manager1 = new LspManager(ws1)
    const manager2 = new LspManager(ws2)
    try {
      const file1 = join(ws1, "a.ts")
      const file2 = join(ws2, "b.ts")
      writeFileSync(file1, "const x = 1")
      writeFileSync(file2, "const y = 2")

      // 在两个 workspace 各打开一个文件，触发 server 启动和 DocumentInfo 创建
      await manager1.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(file1).href },
        position: { line: 0, character: 6 },
      }, file1)
      await manager2.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(file2).href },
        position: { line: 0, character: 6 },
      }, file2)

      // 各自有一个 server 和一个 document
      expect(manager1.getStatus().documents).toBe(1)
      expect(manager2.getStatus().documents).toBe(1)

      // 关闭 ws1 的 server，应只清理 ws1 的 documents
      await manager1.shutdownAll()
      expect(manager1.getStatus().documents).toBe(0)
      // ws2 的 documents 不受影响
      expect(manager2.getStatus().documents).toBe(1)
    } finally {
      await manager1.shutdownAll().catch(() => {})
      await manager2.shutdownAll().catch(() => {})
    }
  }, 20000)
})
