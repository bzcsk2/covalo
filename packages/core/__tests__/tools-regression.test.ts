import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { createWriteFileTool, createGrepTool, createListDirTool, createTodoWriteTool } from "../../tools/src/index.ts"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { tmpdir } from "node:os"

function tmpCtx(cwd: string) {
  return { cwd, signal: new AbortController().signal } as any
}

// ============================================================
// write_file 工具测试
// ============================================================
describe("write_file tool (B2: new tool)", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = resolve(tmpdir(), `covalo-test-wf-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("should create a new file with given content", async () => {
    const tool = createWriteFileTool()
    const result = await tool.execute({ path: "hello.txt", content: "world" }, tmpCtx(tmpDir))
    expect(result.isError).toBe(false)
    const out = JSON.parse(result.content as string)
    expect(out.path).toMatch(/hello\.txt$/)
    expect(out.size).toBe(5)
  })

  it("should overwrite an existing file", async () => {
    const filePath = "overwrite.txt"
    await writeFile(resolve(tmpDir, filePath), "old", "utf-8")

    const tool = createWriteFileTool()
    const result = await tool.execute({ path: filePath, content: "new content" }, tmpCtx(tmpDir))
    expect(result.isError).toBe(false)
    const out = JSON.parse(result.content as string)
    expect(out.size).toBe(11)
  })

  // S1-3: 写入敏感路径返回 "Writing to protected file is denied"（区分 read 的 "sensitive"）
  it("should reject sensitive paths like api-key", async () => {
    const tool = createWriteFileTool()
    const result = await tool.execute({ path: "api-key", content: "sk-xxx" }, tmpCtx(tmpDir))
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("protected")
  })

  it("should reject sensitive paths like .env", async () => {
    const tool = createWriteFileTool()
    const result = await tool.execute({ path: ".env", content: "SECRET=1" }, tmpCtx(tmpDir))
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("protected")
  })

  it("should reject sensitive paths containing .git/", async () => {
    const tool = createWriteFileTool()
    const result = await tool.execute({ path: ".git/config", content: "[core]" }, tmpCtx(tmpDir))
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("protected")
  })

  it("should reject sensitive paths like known_hosts", async () => {
    const tool = createWriteFileTool()
    const result = await tool.execute({ path: "known_hosts", content: "github.com" }, tmpCtx(tmpDir))
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("protected")
  })

  it("should reject missing path argument", async () => {
    const tool = createWriteFileTool()
    const result = await tool.execute({ path: "", content: "x" }, tmpCtx(tmpDir))
    expect(result.isError).toBe(true)
  })

  it("should reject missing content argument", async () => {
    const tool = createWriteFileTool()
    const result = await tool.execute({ path: "/tmp/test.txt", content: 123 as any }, tmpCtx(tmpDir))
    expect(result.isError).toBe(true)
  })
})

// ============================================================
// grep 工具测试
// ============================================================
describe("grep tool (C1: new tool)", () => {
  const ctx = { cwd: process.cwd(), signal: new AbortController().signal } as any

  it("should find matching patterns in files", async () => {
    const tool = createGrepTool()
    const result = await tool.execute({ pattern: "createWriteFileTool", path: "packages/tools/src" }, ctx)
    expect(result.isError).toBe(false)
    const out = JSON.parse(result.content as string)
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results.some((r: string) => r.includes("write-file.ts"))).toBe(true)
  })

  it("should return empty results when no match found", async () => {
    const tool = createGrepTool()
    const result = await tool.execute({ pattern: "XYZZZ_NONEXISTENT_12345", path: "packages/tools/src" }, ctx)
    expect(result.isError).toBe(false)
    const out = JSON.parse(result.content as string)
    expect(out.results).toHaveLength(0)
    expect(out.totalMatches).toBe(0)
  })

  it("should respect include filter", async () => {
    const tool = createGrepTool()
    const result = await tool.execute({ pattern: "create", include: "*.ts", path: "packages/tools/src" }, ctx)
    expect(result.isError).toBe(false)
    const out = JSON.parse(result.content as string)
    expect(out.results.length).toBeGreaterThan(0)
  })

  it("should reject empty pattern", async () => {
    const tool = createGrepTool()
    const result = await tool.execute({ pattern: "", path: "." }, ctx)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("pattern")
  })
})

// ============================================================
// list_dir 工具测试
// ============================================================
describe("list_dir tool (C1: new tool)", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = resolve(tmpdir(), `covalo-test-ld-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    await writeFile(resolve(tmpDir, "a.txt"), "aaa", "utf-8")
    await writeFile(resolve(tmpDir, "b.txt"), "bbb", "utf-8")
    await mkdir(resolve(tmpDir, "sub"), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("should list directory contents with types and sizes", async () => {
    const tool = createListDirTool()
    const result = await tool.execute({ path: tmpDir }, tmpCtx(tmpDir))
    expect(result.isError).toBe(false)
    const out = JSON.parse(result.content as string)
    expect(out.items.length).toBe(3)

    const a = out.items.find((i: any) => i.name === "a.txt")
    expect(a).toBeDefined()
    expect(a.type).toBe("file")
    expect(a.size).toBe(3)

    const sub = out.items.find((i: any) => i.name === "sub")
    expect(sub).toBeDefined()
    expect(sub.type).toBe("dir")
  })

  it("should return error for non-existent directory", async () => {
    const tool = createListDirTool()
    const result = await tool.execute({ path: resolve(tmpDir, "nonexistent") }, tmpCtx(tmpDir))
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("not found")
  })

  it("should reject missing path argument", async () => {
    const tool = createListDirTool()
    const result = await tool.execute({ path: "" }, tmpCtx(tmpDir))
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("path")
  })
})

// ============================================================
// todowrite 工具测试
// ============================================================
describe("todowrite tool (C1: new tool)", () => {
  const ctx = { cwd: process.cwd(), signal: new AbortController().signal } as any

  it("should create todos with various statuses", async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({
      todos: [
        { content: "Task A", status: "completed", priority: "high" },
        { content: "Task B", status: "in_progress", priority: "medium" },
        { content: "Task C", status: "pending", priority: "low" },
        { content: "Task D", status: "cancelled", priority: "high" },
      ],
    }, ctx)
    expect(result.isError).toBe(false)
    const out = JSON.parse(result.content as string)
    expect(out.todos).toHaveLength(4)
    expect(out.summary).toContain("[✓] Task A")
    expect(out.summary).toContain("[→] Task B")
    expect(out.summary).toContain("[ ] Task C")
    expect(out.summary).toContain("[✗] Task D")
  })

  it("should reject empty todos array", async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({ todos: [] }, ctx)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("todos")
  })

  it("should reject non-array todos", async () => {
    const tool = createTodoWriteTool()
    const result = await tool.execute({ todos: "not an array" }, ctx)
    expect(result.isError).toBe(true)
  })
})

// ============================================================
// bash 工具安全基线测试（D2: 敏感命令拦截）
// ============================================================
describe("bash tool security baseline (D2: deny patterns)", () => {
  const ctx = { cwd: process.cwd(), signal: new AbortController().signal } as any
  const isWin = process.platform === "win32"

  it("should deny rm -rf / command", async () => {
    const { createBashTool } = await import("../../tools/src/index.ts")
    const tool = createBashTool()
    const cmd = isWin ? "rm -Recurse -Force /" : "rm -rf /"
    const result = await tool.execute({ command: cmd }, ctx)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("denied")
  })

  it("should deny sudo commands", async () => {
    if (isWin) return // sudo does not exist on Windows
    const { createBashTool } = await import("../../tools/src/index.ts")
    const tool = createBashTool()
    const result = await tool.execute({ command: "sudo whoami" }, ctx)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("denied")
  })

  it("should deny mkfs commands", async () => {
    if (isWin) return // mkfs does not exist on Windows
    const { createBashTool } = await import("../../tools/src/index.ts")
    const tool = createBashTool()
    const result = await tool.execute({ command: "mkfs.ext4 /dev/sda1" }, ctx)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("denied")
  })

  it("should deny chmod -R 777 /", async () => {
    if (isWin) return // chmod does not exist on Windows
    const { createBashTool } = await import("../../tools/src/index.ts")
    const tool = createBashTool()
    const result = await tool.execute({ command: "chmod -R 777 /" }, ctx)
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content as string).error).toContain("denied")
  })
})
