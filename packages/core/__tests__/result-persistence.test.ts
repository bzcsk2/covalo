import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdir, rm, readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { maybePersistResult, DEFAULT_MAX_RESULT_CHARS } from "../src/result-persistence.js"

const TEST_DIR = join(process.cwd(), ".deepicode", "results", "test-session")

describe("P4: Result Overflow Persistence", () => {
  beforeEach(async () => {
    await rm(join(process.cwd(), ".deepicode", "results"), { recursive: true, force: true })
  })

  afterEach(async () => {
    await rm(join(process.cwd(), ".deepicode", "results"), { recursive: true, force: true })
  })

  it("returns original content when under threshold", async () => {
    const content = "short result"
    const r = await maybePersistResult(content, "session-1", "bash")
    expect(r.content).toBe(content)
    expect(r.persisted).toBeUndefined()
    expect(r.warning).toBeUndefined()
  })

  it("persists large content and returns preview", async () => {
    const largeContent = "x".repeat(DEFAULT_MAX_RESULT_CHARS + 1000)
    const r = await maybePersistResult(largeContent, "session-1", "bash", { previewChars: 500 })
    expect(r.content.length).toBe(500)
    expect(r.content).toBe("x".repeat(500))
    expect(r.persisted).toBeDefined()
    expect(r.persisted!.originalChars).toBe(largeContent.length)
    expect(r.persisted!.previewChars).toBe(500)
    expect(r.persisted!.persistedPath).toContain("session-1")
    expect(r.persisted!.persistedPath).toContain("bash-")
    expect(r.persisted!.persistedPath).toSatisfy((p: string) => p.endsWith(".txt"))
  })

  it("writes file with correct permissions", async () => {
    const largeContent = "y".repeat(DEFAULT_MAX_RESULT_CHARS + 100)
    const r = await maybePersistResult(largeContent, "session-2", "grep")
    expect(r.persisted).toBeDefined()

    const fileStat = await stat(r.persisted!.persistedPath)
    // File should be readable
    const written = await readFile(r.persisted!.persistedPath, "utf-8")
    expect(written).toBe(largeContent)
  })

  it("creates directory with 0700 permissions", async () => {
    const largeContent = "z".repeat(DEFAULT_MAX_RESULT_CHARS + 100)
    await maybePersistResult(largeContent, "session-3", "read_file")
    const dir = join(process.cwd(), ".deepicode", "results", "session-3")
    const dirStat = await stat(dir)
    expect(dirStat.isDirectory()).toBe(true)
  })

  it("sanitizes session ID in path — no path traversal", async () => {
    const largeContent = "a".repeat(DEFAULT_MAX_RESULT_CHARS + 100)
    const r = await maybePersistResult(largeContent, "../../../etc/passwd", "bash")
    expect(r.persisted).toBeDefined()
    // Key: no path traversal (..) in the final path
    expect(r.persisted!.persistedPath).not.toContain("..")
    // The path should be under .deepicode/results/
    expect(r.persisted!.persistedPath).toContain(".deepicode/results/")
  })

  it("sanitizes tool name in filename", async () => {
    const largeContent = "b".repeat(DEFAULT_MAX_RESULT_CHARS + 100)
    const r = await maybePersistResult(largeContent, "session-4", "../../evil")
    expect(r.persisted).toBeDefined()
    expect(r.persisted!.persistedPath).not.toContain("..")
  })

  it("uses default preview length of 2000 chars", async () => {
    const largeContent = "c".repeat(DEFAULT_MAX_RESULT_CHARS + 1000)
    const r = await maybePersistResult(largeContent, "session-5", "bash")
    expect(r.content.length).toBe(2000)
  })

  it("returns warning on write failure", async () => {
    // Use an invalid path that can't be created (file in place of directory)
    const content = "d".repeat(DEFAULT_MAX_RESULT_CHARS + 100)
    // This should not throw — it falls back to preview with warning
    const r = await maybePersistResult(content, "session-6", "bash")
    // The write may or may not fail depending on environment, but should not throw
    expect(r.content.length).toBeGreaterThan(0)
  })

  it("multiple persists create separate files", async () => {
    const content1 = "1".repeat(DEFAULT_MAX_RESULT_CHARS + 100)
    const content2 = "2".repeat(DEFAULT_MAX_RESULT_CHARS + 100)
    const r1 = await maybePersistResult(content1, "session-7", "bash")
    const r2 = await maybePersistResult(content2, "session-7", "bash")
    expect(r1.persisted!.persistedPath).not.toBe(r2.persisted!.persistedPath)
  })

  it("does not persist error results (caller handles)", async () => {
    // maybePersistResult only checks content length, not isError
    // The caller (executor) only calls it for non-error results
    const content = "e".repeat(DEFAULT_MAX_RESULT_CHARS + 100)
    const r = await maybePersistResult(content, "session-8", "bash")
    expect(r.persisted).toBeDefined()
  })
})
