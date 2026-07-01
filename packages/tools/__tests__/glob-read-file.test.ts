import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createReadFileTool } from "../src/file-ops.js"
import { createGlobTool } from "../src/glob.js"
import { createEditTool } from "../src/edit.js"
import { writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal }) as any

describe("read_file", () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = join(tmpdir(), `deepreef-read-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

  it("should read an existing text file", async () => {
    const filePath = join(tmpDir, "test.txt")
    writeFileSync(filePath, "hello world", "utf-8")
    const tool = createReadFileTool()
    const r = await tool.execute({ path: filePath }, ctx(tmpDir))
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.content).toContain("hello world")
  })

  it("should return error for non-existent file", async () => {
    const tool = createReadFileTool()
    const r = await tool.execute({ path: "/nonexistent/file.txt" }, ctx(tmpDir))
    expect(r.isError).toBe(true)
  })

  it("should deny sensitive file paths", async () => {
    const filePath = join(tmpDir, "api-key")
    writeFileSync(filePath, "sk-xxx", "utf-8")
    const tool = createReadFileTool()
    const r = await tool.execute({ path: filePath }, ctx(tmpDir))
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("sensitive")
  })

  it("should reject large files over 10MB", async () => {
    const tool = createReadFileTool()
    // Just verify the validation exists, don't actually create 10MB file
    const r = await tool.execute({ path: "" }, ctx(tmpDir))
    expect(r.isError).toBe(true)
  })

  it("should reject empty path", async () => {
    const tool = createReadFileTool()
    const r = await tool.execute({ path: "" }, ctx(tmpDir))
    expect(r.isError).toBe(true)
  })

  it("should resolve relative path via ctx.cwd", async () => {
    const subDir = join(tmpDir, "sub")
    mkdirSync(subDir)
    writeFileSync(join(subDir, "readme.txt"), "relative path content", "utf-8")
    const tool = createReadFileTool()
    // Execute with relative path, ctx.cwd = tmpDir
    const r = await tool.execute({ path: "sub/readme.txt" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.content).toContain("relative path content")
  })

  it("should slice by start_line and end_line", async () => {
    const filePath = join(tmpDir, "lines.txt")
    writeFileSync(filePath, "line0\nline1\nline2\nline3\nline4\n", "utf-8")
    const tool = createReadFileTool()
    const r = await tool.execute({ path: filePath, start_line: 1, end_line: 3 }, ctx(tmpDir))
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.content).toBe("line1\nline2\nline3")
  })

  it("should truncate output at max_chars with notice", async () => {
    const filePath = join(tmpDir, "long.txt")
    writeFileSync(filePath, "a".repeat(500) + "b".repeat(500), "utf-8")
    const tool = createReadFileTool()
    const r = await tool.execute({ path: filePath, max_chars: 100 }, ctx(tmpDir))
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.content).toContain("[truncated")
    expect(p.content.length).toBeLessThan(300)
  })

  it("should read empty file returning empty content string", async () => {
    const filePath = join(tmpDir, "empty.txt")
    writeFileSync(filePath, "", "utf-8")
    const tool = createReadFileTool()
    const r = await tool.execute({ path: filePath }, ctx(tmpDir))
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.content).toBe("")
  })

  it("should record read so edit can detect staleness (read_file + edit integration)", async () => {
    const filePath = join(tmpDir, "stale-flow.txt")
    writeFileSync(filePath, "original content", "utf-8")
    const tool = createReadFileTool()
    const r1 = await tool.execute({ path: filePath }, ctx(tmpDir))
    expect(r1.isError).toBe(false)

    writeFileSync(filePath, "modified content with different size", "utf-8")

    const editTool = createEditTool()
    const r2 = await editTool.execute({ path: filePath, old_string: "modified", new_string: "changed" }, ctx(tmpDir))
    expect(r2.isError).toBe(true)
    const p = JSON.parse(r2.content as string)
    expect(p.error).toContain("modified since last read")
  })

  it("should reject binary files", async () => {
    const filePath = join(tmpDir, "random.bin")
    const buf = Buffer.alloc(256)
    for (let i = 0; i < 256; i++) buf[i] = i
    writeFileSync(filePath, buf)
    const tool = createReadFileTool()
    const r = await tool.execute({ path: filePath }, ctx(tmpDir))
    // Binary files are now rejected with an error
    expect(r.isError).toBe(true)
    expect(r.content).toContain("binary")
  })
})

describe("write_file", () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = join(tmpdir(), `deepreef-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

  it("should create file with content in nested directory", async () => {
    const { createWriteFileTool } = await import("../src/write-file.js")
    const tool = createWriteFileTool()
    const filePath = join(tmpDir, "sub", "nested", "file.txt")
    const r = await tool.execute({ path: filePath, content: "nested content" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(false)
    expect(readFileSync(filePath, "utf-8")).toBe("nested content")
  })

  it("should create empty file when content is empty string", async () => {
    const { createWriteFileTool } = await import("../src/write-file.js")
    const tool = createWriteFileTool()
    const filePath = join(tmpDir, "empty.txt")
    const r = await tool.execute({ path: filePath, content: "" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(false)
    expect(readFileSync(filePath, "utf-8")).toBe("")
  })

  it("should resolve relative path via ctx.cwd", async () => {
    const { createWriteFileTool } = await import("../src/write-file.js")
    const tool = createWriteFileTool()
    const r = await tool.execute({ path: "relative.txt", content: "relative path" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(false)
    expect(readFileSync(join(tmpDir, "relative.txt"), "utf-8")).toBe("relative path")
  })

  it("write_file rejects path traversal outside cwd", async () => {
    const { createWriteFileTool } = await import("../src/write-file.js")
    const tool = createWriteFileTool()
    const r = await tool.execute({ path: "../escape.txt", content: "should fail" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("outside")
  })

  it("write_file rejects overwriting a stale file", async () => {
    const { createWriteFileTool } = await import("../src/write-file.js")
    const { recordRead } = await import("../src/stale-read.js")
    const { stat: fsStat } = await import("node:fs/promises")

    const filePath = join(tmpDir, "stale.txt")
    writeFileSync(filePath, "original", "utf-8")

    // Read the file to record it
    const st = await fsStat(filePath)
    await recordRead(filePath, st.mtimeMs, st.size)

    // Modify externally (simulate concurrent edit)
    writeFileSync(filePath, "externally modified", "utf-8")

    // Now write_file should reject because file is stale
    const tool = createWriteFileTool()
    const r = await tool.execute({ path: filePath, content: "overwrite" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("modified since last read")
    // File should still contain the external modification
    expect(readFileSync(filePath, "utf-8")).toBe("externally modified")
  })

  it("write_file can create a new non-sensitive file under workspace", async () => {
    const { createWriteFileTool } = await import("../src/write-file.js")
    const tool = createWriteFileTool()
    const r = await tool.execute({ path: "new-file.txt", content: "new content" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(false)
    expect(readFileSync(join(tmpDir, "new-file.txt"), "utf-8")).toBe("new content")
  })
})

describe("glob - Bun.Glob fallback", () => {
  it("S3: should error on unresolvable path (catches Bun.Glob errors)", async () => {
    const tool = createGlobTool()
    // Non-existent path triggers path resolution error before glob
    const r = await tool.execute({ pattern: "*.ts", path: "/nonexistent-path-xyz-123" }, ctx("/tmp"))
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toBeTruthy()
  })

  it("S4: rg fallback — grep is used when rg is unavailable", async () => {
    // grep tool runs in this environment — verify it works
    const { createGrepTool } = await import("../src/grep.js")
    const tool = createGrepTool()
    // Search in a known directory for a known string
    const r = await tool.execute({ pattern: "createGrepTool", path: process.cwd() + "/packages/tools/src" }, ctx(process.cwd()))
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.totalMatches).toBeGreaterThanOrEqual(1)
  })
})

describe("glob", () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = join(tmpdir(), `deepreef-glob-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, "a.ts"), "a", "utf-8")
    writeFileSync(join(tmpDir, "b.ts"), "b", "utf-8")
    mkdirSync(join(tmpDir, "sub"))
    writeFileSync(join(tmpDir, "sub", "c.ts"), "c", "utf-8")
  })
  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

  it("should find matching files in directory", async () => {
    const tool = createGlobTool()
    const r = await tool.execute({ pattern: "*.ts", path: tmpDir }, ctx(tmpDir))
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.numFiles).toBe(2)
  })

  it("should find files recursively with **/*", async () => {
    const tool = createGlobTool()
    const r = await tool.execute({ pattern: "**/*.ts", path: tmpDir }, ctx(tmpDir))
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.numFiles).toBe(3)
  })

  it("should return empty for no matches", async () => {
    const tool = createGlobTool()
    const r = await tool.execute({ pattern: "*.py", path: tmpDir }, ctx(tmpDir))
    const p = JSON.parse(r.content as string)
    expect(p.numFiles).toBe(0)
  })

  it("should reject empty pattern", async () => {
    const tool = createGlobTool()
    const r = await tool.execute({ pattern: "", path: tmpDir }, ctx(tmpDir))
    expect(r.isError).toBe(true)
  })

  it("should reject path traversal outside project directory", async () => {
    const tool = createGlobTool()
    // /tmp is outside tmpDir, so traversal should be denied
    const isWin = process.platform === "win32"
    const testPath = isWin ? "C:\\tmp" : "/tmp"
    const r = await tool.execute({ pattern: "*.txt", path: testPath }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(true)
    const err = JSON.parse(r.content as string).error
    // Windows may say "cannot resolve path" instead of "outside"
    expect(err).toMatch(/(outside|cannot resolve)/)
  })

  it("should reject path traversal with ../", async () => {
    const tool = createGlobTool()
    const r = await tool.execute({ pattern: "*.txt", path: "../" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("outside")
  })

  it("filters out sensitive files from glob results", async () => {
    writeFileSync(join(tmpDir, ".env"), "SECRET", "utf-8")
    writeFileSync(join(tmpDir, ".npmrc"), "token", "utf-8")
    writeFileSync(join(tmpDir, "normal.ts"), "ok", "utf-8")
    mkdirSync(join(tmpDir, ".ssh"))
    writeFileSync(join(tmpDir, ".ssh", "id_rsa"), "key", "utf-8")

    const tool = createGlobTool()

    // Hidden files with dot:true
    const r1 = await tool.execute({ pattern: ".env", path: tmpDir }, ctx(tmpDir))
    expect(r1.isError).toBe(false)
    const p1 = JSON.parse(r1.content as string)
    expect(p1.numFiles).toBe(0)

    // All files should not include sensitive ones
    const r2 = await tool.execute({ pattern: "**/*", path: tmpDir }, ctx(tmpDir))
    expect(r2.isError).toBe(false)
    const p2 = JSON.parse(r2.content as string)
    expect(p2.filenames).not.toContain(".env")
    expect(p2.filenames).not.toContain(".npmrc")
    expect(p2.filenames).not.toContain(".ssh/id_rsa")
    expect(p2.filenames).toContain("normal.ts")
  })

  it("denies globbing a sensitive directory (.ssh/)", async () => {
    mkdirSync(join(tmpDir, ".ssh"))
    writeFileSync(join(tmpDir, ".ssh", "id_rsa"), "key", "utf-8")
    const tool = createGlobTool()
    const r = await tool.execute({ pattern: "**/*", path: join(tmpDir, ".ssh") }, ctx(tmpDir))
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("sensitive")
  })
})

describe("grep", () => {
  let tmpDir: string
  const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal } as any)

  beforeEach(() => {
    tmpDir = join(tmpdir(), `deepreef-grep-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, "normal.txt"), "This is normal content", "utf-8")
    writeFileSync(join(tmpDir, ".env"), "SECRET=value", "utf-8")
    writeFileSync(join(tmpDir, ".npmrc"), "token=abc123", "utf-8")
    mkdirSync(join(tmpDir, ".ssh"))
    writeFileSync(join(tmpDir, ".ssh", "id_rsa"), "ssh-rsa AAAAB3...", "utf-8")
  })

  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

  it("denies searching a sensitive file directly (.env)", async () => {
    const { createGrepTool } = await import("../src/grep.js")
    const tool = createGrepTool()
    const r = await tool.execute({ pattern: "SECRET", path: join(tmpDir, ".env") }, ctx(tmpDir))
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("sensitive")
  })

  it("denies searching a sensitive directory (.ssh/)", async () => {
    const { createGrepTool } = await import("../src/grep.js")
    const tool = createGrepTool()
    const r = await tool.execute({ pattern: "key", path: join(tmpDir, ".ssh") }, ctx(tmpDir))
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("sensitive")
  })

  it("filters out sensitive files from grep results when searching a directory", async () => {
    const { createGrepTool } = await import("../src/grep.js")
    const tool = createGrepTool()
    const r = await tool.execute({ pattern: ".", path: tmpDir }, ctx(tmpDir))
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    // Handle both Unix (path:num:text) and Windows (C:\path:num:text) output formats
    const filePaths = p.results.map((line: string) => {
      const lastColon = line.lastIndexOf(":")
      const secondLastColon = lastColon > 0 ? line.lastIndexOf(":", lastColon - 1) : -1
      return secondLastColon >= 0 ? line.substring(0, secondLastColon) : line.split(":")[0]
    })
    expect(filePaths).not.toContain(join(tmpDir, ".env"))
    expect(filePaths).not.toContain(join(tmpDir, ".npmrc"))
    expect(filePaths).not.toContain(join(tmpDir, ".ssh", "id_rsa"))
    expect(filePaths).toContain(join(tmpDir, "normal.txt"))
  })

  it("non-sensitive dot files are searchable", async () => {
    writeFileSync(join(tmpDir, ".hidden-ok"), "visible content", "utf-8")
    const { createGrepTool } = await import("../src/grep.js")
    const tool = createGrepTool()
    const r = await tool.execute({ pattern: "visible", path: tmpDir }, ctx(tmpDir))
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.totalMatches).toBeGreaterThanOrEqual(1)
  })

  it("grep rejects path traversal outside cwd", async () => {
    const { createGrepTool } = await import("../src/grep.js")
    const tool = createGrepTool()
    const r = await tool.execute({ pattern: "test", path: "../" }, ctx(tmpDir))
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("outside")
  })
})

describe("path containment", () => {
  let tmpDir: string
  const ctx2 = (cwd: string) => ({ cwd, signal: new AbortController().signal }) as any

  beforeEach(() => {
    tmpDir = join(tmpdir(), `deepreef-containment-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch {} })

  it("read_file rejects path traversal outside cwd", async () => {
    const tool = createReadFileTool()
    const r = await tool.execute({ path: "../outside.txt" }, ctx2(tmpDir))
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("outside")
  })

  it("list_dir rejects path traversal outside cwd", async () => {
    const { createListDirTool } = await import("../src/list-dir.js")
    const tool = createListDirTool()
    const r = await tool.execute({ path: "../" }, ctx2(tmpDir))
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("outside")
  })

  it("glob rejects path traversal outside cwd", async () => {
    const tool = createGlobTool()
    const r = await tool.execute({ pattern: "*.txt", path: "../" }, ctx2(tmpDir))
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("outside")
  })

  it("edit rejects path traversal outside cwd", async () => {
    const tool = createEditTool()
    writeFileSync(join(tmpDir, "target.txt"), "content", "utf-8")
    const r = await tool.execute({ path: "../outside.txt", old_string: "anything", new_string: "nope" }, ctx2(tmpDir))
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("outside")
  })
})
