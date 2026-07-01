import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { recordRead, checkStale, clearReadTracker } from "../src/stale-read.js"
import { writeFile, rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("stale-read", () => {
  let tmpDir: string
  const testFile = "test-stale.txt"

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `deepreef-stale-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    await writeFile(join(tmpDir, testFile), "hello", "utf-8")
    clearReadTracker()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("should not report stale when file is unchanged", async () => {
    const fullPath = join(tmpDir, testFile)
    const { mtimeMs, size } = await import("node:fs/promises").then((fs) => fs.stat(fullPath))
    await recordRead(fullPath, mtimeMs, size)
    const result = await checkStale(fullPath)
    expect(result.isStale).toBe(false)
  })

  it("should report stale when file size changes", async () => {
    const fullPath = join(tmpDir, testFile)
    const { mtimeMs, size } = await import("node:fs/promises").then((fs) => fs.stat(fullPath))
    await recordRead(fullPath, mtimeMs, size)
    await writeFile(fullPath, "hello world", "utf-8")
    const result = await checkStale(fullPath)
    expect(result.isStale).toBe(true)
    expect(result.message).toContain("modified")
  })

  it("should return not stale for never-read files", async () => {
    const result = await checkStale("/nonexistent/file.txt")
    expect(result.isStale).toBe(false)
  })

  it("should report stale when file is deleted", async () => {
    const fullPath = join(tmpDir, testFile)
    const { mtimeMs, size } = await import("node:fs/promises").then((fs) => fs.stat(fullPath))
    await recordRead(fullPath, mtimeMs, size)
    await rm(fullPath)
    const result = await checkStale(fullPath)
    expect(result.isStale).toBe(true)
  })

  it("should handle clearReadTracker", async () => {
    await recordRead("/tmp/test.txt", 100, 10)
    clearReadTracker()
    // Should be treated as never-read
  })
})
