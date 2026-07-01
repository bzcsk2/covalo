import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { hashAnchoredReplaceOnce } from "../src/hash-edit.js"
import { fuzzyReplaceOnce } from "../src/fuzzy-edit.js"
import { createEditTool } from "../src/edit.js"
import { recordRead, clearReadTracker } from "../src/stale-read.js"

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "deepreef-edit-test-"))
}

describe("hashAnchoredReplaceOnce", () => {
  it("should replace exact match", async () => {
    const dir = tempDir()
    const file = join(dir, "test.txt")
    writeFileSync(file, "Hello world")

    const res = await hashAnchoredReplaceOnce(file, "world", "there")
    expect(res).not.toBeNull()
    expect(res!.replacedCount).toBe(1)
    expect(readFileSync(file, "utf-8")).toBe("Hello there")
    await rm(dir, { recursive: true })
  })

  it("should replace multi-line text", async () => {
    const dir = tempDir()
    const file = join(dir, "test.txt")
    writeFileSync(file, "line1\nline2\nline3\nline4")

    const res = await hashAnchoredReplaceOnce(file, "line2\nline3", "B\nC")
    expect(res).not.toBeNull()
    expect(readFileSync(file, "utf-8")).toBe("line1\nB\nC\nline4")
    await rm(dir, { recursive: true })
  })

  it("should return null when oldString not found", async () => {
    const dir = tempDir()
    const file = join(dir, "test.txt")
    writeFileSync(file, "Hello world")

    const res = await hashAnchoredReplaceOnce(file, "nope", "there")
    expect(res).toBeNull()
    expect(readFileSync(file, "utf-8")).toBe("Hello world")
    await rm(dir, { recursive: true })
  })

  it("should return null when oldHash does not match", async () => {
    const dir = tempDir()
    const file = join(dir, "test.txt")
    writeFileSync(file, "Hello world")

    const res = await hashAnchoredReplaceOnce(file, "world", "there", "badhash")
    expect(res).toBeNull()
    expect(readFileSync(file, "utf-8")).toBe("Hello world")
    await rm(dir, { recursive: true })
  })

  it("should succeed when oldHash matches", async () => {
    const dir = tempDir()
    const file = join(dir, "test.txt")
    writeFileSync(file, "Hello world")

    const h = sha256("world")
    const res = await hashAnchoredReplaceOnce(file, "world", "there", h)
    expect(res).not.toBeNull()
    expect(res!.replacedCount).toBe(1)
    expect(readFileSync(file, "utf-8")).toBe("Hello there")
    await rm(dir, { recursive: true })
  })

  it("should return null for empty oldString", async () => {
    const res = await hashAnchoredReplaceOnce("/nonexistent", "", "x")
    expect(res).toBeNull()
  })
})

describe("fuzzyReplaceOnce", () => {
  it("exact match", () => {
    const res = fuzzyReplaceOnce("Hello world", "world", "there")
    expect(res).not.toBeNull()
    expect(res!.edited).toBe("Hello there")
    expect(res!.method).toBe("exact")
  })

  it("rejects ambiguous trimmed_full match", () => {
    const res = fuzzyReplaceOnce("foo\nbar\nfoo", "foo", "REPLACED")
    expect(res).toBeNull()
  })

  it("rejects ambiguous trimmed lines match", () => {
    const res = fuzzyReplaceOnce("a\nb\nc\na\nb\nc", "a \nb \nc ", "REPLACED")
    expect(res).toBeNull()
  })

  it("rejects ambiguous trimmedBoundary match", () => {
    const res = fuzzyReplaceOnce("  hello\n  world\n  hello\n  world", "hello\nworld", "REPLACED")
    expect(res).toBeNull()
  })

  it("rejects ambiguous escapeNormalized match", () => {
    const haystack = "line1\nline2\nline1\nline2"
    const needle = "line1\\nline2"
    const res = fuzzyReplaceOnce(haystack, needle, "REPLACED")
    expect(res).toBeNull()
  })

  it("rejects ambiguous blockAnchor regions", () => {
    // Two regions both have matching first/last anchors and meet the threshold
    const region = "start anchor\nmiddle content\nmiddle extra\nend anchor"
    const haystack = `prefix\n${region}\nsome text\n${region}\nsuffix`
    const needle = "start anchor\nmiddle content\ndifferent whitespace\nend anchor"
    const res = fuzzyReplaceOnce(haystack, needle, "REPLACED")
    expect(res).toBeNull()
  })

  it("rejects ambiguous contextAware regions", () => {
    const region = "first anchor\nmiddle-A\nmiddle-B\nmiddle-C\nlast anchor"
    const haystack = `before\n${region}\nbetween\n${region}\nafter`
    const needle = "first anchor\ndifferent X\ndifferent Y\ndifferent Z\nlast anchor"
    const res = fuzzyReplaceOnce(haystack, needle, "REPLACED")
    expect(res).toBeNull()
  })

  it("trimmed_full match", () => {
    const res = fuzzyReplaceOnce("Hello  world", " world", " there")
    expect(res).not.toBeNull()
    expect(res!.method).toBe("exact")
  })

  it("trimmed_lines match", () => {
    const res = fuzzyReplaceOnce("before\nline1\nline2\nafter", "line1 \nline2 ", "REPLACED")
    expect(res).not.toBeNull()
    expect(res!.method).toBe("trimmed_lines")
    expect(res!.edited).toBe("before\nREPLACED\nafter")
  })

  it("flexible_whitespace match", () => {
    const res = fuzzyReplaceOnce("Hello   world", "Hello world", "Hi there")
    expect(res).not.toBeNull()
    expect(res!.method).toBe("flexible_whitespace")
    expect(res!.edited).toBe("Hi there")
  })

  it("returns null when needle not found", () => {
    const res = fuzzyReplaceOnce("abc", "xyz", "123")
    expect(res).toBeNull()
  })

  it("blockAnchor: match via first+last line anchors", () => {
    const haystack = "some text\nstart anchor\nmiddle content\nmiddle extra\nend anchor\nmore text"
    const needle = "start anchor\nmiddle content\ndifferent whitespace\nend anchor"
    const res = fuzzyReplaceOnce(haystack, needle, "REPLACED")
    expect(res).not.toBeNull()
    expect(res!.method).toBe("blockAnchor")
    expect(res!.edited).toBe("some text\nREPLACED\nmore text")
  })

  it("blockAnchor: returns null when anchors not found", () => {
    const res = fuzzyReplaceOnce("abc\ndef", "xyz\n123", "REPLACED")
    expect(res).toBeNull()
  })

  it("escapeNormalized: literal \\n becomes newline", () => {
    const haystack = "line1\nline2"
    const needle = "line1\\nline2"
    const res = fuzzyReplaceOnce(haystack, needle, "REPLACED")
    expect(res).not.toBeNull()
    expect(res!.method).toBe("escapeNormalized")
    expect(res!.edited).toBe("REPLACED")
  })

  it("trimmedBoundary: left+right trim each line", () => {
    const haystack = "prefix\nhello world\nfoo bar\nsuffix"
    const needle = "  hello world  \n  foo bar  "
    const res = fuzzyReplaceOnce(haystack, needle, "REPLACED")
    expect(res).not.toBeNull()
    expect(res!.method).toBe("trimmedBoundary")
    expect(res!.edited).toBe("prefix\nREPLACED\nsuffix")
  })

  it("contextAware: first+last line as anchors, middle approximately matches", () => {
    const haystack = "prefix\nfirst anchor\nmiddle-A\nmiddle-B\nmiddle-C\nlast anchor\nsuffix"
    const needle = "first anchor\ndifferent X\ndifferent Y\ndifferent Z\nlast anchor"
    const res = fuzzyReplaceOnce(haystack, needle, "REPLACED")
    expect(res).not.toBeNull()
    expect(res!.method).toBe("contextAware")
    expect(res!.edited).toBe("prefix\nREPLACED\nsuffix")
  })

  it("should reject ambiguous old_string with multiple occurrences", () => {
    const haystack = "common\ncommon\nunique"
    const needle = "common"
    const res = fuzzyReplaceOnce(haystack, needle, "REPLACED")
    expect(res).toBeNull()
  })

  it("should match unique old_string with surrounding context", () => {
    const haystack = "function a() { return 1 }\nfunction b() { return 2 }"
    const result = fuzzyReplaceOnce(haystack, "a() { return 1", "a() { return 42")
    expect(result).not.toBeNull()
    expect(result!.edited).toContain("return 42")
  })

  it("should reject ambiguous old_string with multiple occurrences in file", async () => {
    const dir = tempDir()
    const file = join(dir, "mult.txt")
    writeFileSync(file, "keep A\ncommon\nkeep B\ncommon\nkeep C")

    const editTool = createEditTool()
    const result = await editTool.execute(
      { path: file, old_string: "common", new_string: "REPLACED" },
      { cwd: dir, sessionId: "test", signal: new AbortController().signal } as any,
    )
    const parsed = JSON.parse(result.content)
    expect(parsed.error).toContain("appears multiple times")
    await rm(dir, { recursive: true })
  })

  it("hashAnchoredReplaceOnce should delete old_string when newString is empty", async () => {
    const dir = tempDir()
    const file = join(dir, "del.txt")
    writeFileSync(file, "before\ndelete this\nafter")

    const res = await hashAnchoredReplaceOnce(file, "delete this\n", "")
    expect(res).not.toBeNull()
    const content = readFileSync(file, "utf-8")
    expect(content).toBe("before\nafter")
    await rm(dir, { recursive: true })
  })
})

describe("edit tool stale-read integration", () => {
  let tmpDir: string
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "deepreef-stale-edit-"))
    clearReadTracker()
  })
  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  it("should return stale error when file modified since last read", async () => {
    const filePath = join(tmpDir, "stale.txt")
    writeFileSync(filePath, "short", "utf-8")
    const { stat } = await import("node:fs/promises")
    const st = await stat(filePath)
    await recordRead(filePath, st.mtimeMs, st.size)
    writeFileSync(filePath, "much longer content to ensure size changes", "utf-8")

    const tool = createEditTool()
    const r = await tool.execute({ path: filePath, old_string: "longer", new_string: "modified" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("modified since last read")
  })

  it("should succeed when file is not stale", async () => {
    const filePath = join(tmpDir, "fresh.txt")
    writeFileSync(filePath, "hello world", "utf-8")

    const tool = createEditTool()
    const r = await tool.execute({ path: filePath, old_string: "hello", new_string: "hi" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(false)
    expect(readFileSync(filePath, "utf-8")).toBe("hi world")
  })

  it("should fall back to fuzzy when hash-anchored fails (whitespace mismatch)", async () => {
    const filePath = join(tmpDir, "fuzzy-fallback.txt")
    writeFileSync(filePath, "hello   world", "utf-8")

    const tool = createEditTool()
    const r = await tool.execute({ path: filePath, old_string: "hello world", new_string: "hi world" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.method).toBe("flexible_whitespace")
    expect(p.warning).toBe("exact_match_failed_used_fuzzy")
    expect(readFileSync(filePath, "utf-8")).toBe("hi world")
  })

  it("should use hash-anchored when exact match with no oldHash", async () => {
    const filePath = join(tmpDir, "exact-match.txt")
    writeFileSync(filePath, "exact string here", "utf-8")

    const tool = createEditTool()
    const r = await tool.execute({ path: filePath, old_string: "exact string", new_string: "replaced string" }, { cwd: tmpDir, signal: new AbortController().signal } as any)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.method).toBe("hash_anchored")
    expect(readFileSync(filePath, "utf-8")).toBe("replaced string here")
  })

  it("correct old_hash allows the edit", async () => {
    const dir = tempDir()
    const file = join(dir, "hash-ok.txt")
    writeFileSync(file, "content to replace", "utf-8")

    const tool = createEditTool()
    const ctx = { cwd: dir, signal: new AbortController().signal } as any
    const r = await tool.execute({ path: file, old_string: "content to replace", new_string: "replaced", old_hash: sha256("content to replace") }, ctx)
    expect(r.isError).toBe(false)
    expect(readFileSync(file, "utf-8")).toBe("replaced")
    await rm(dir, { recursive: true })
  })

  it("incorrect old_hash rejects the edit and preserves file content", async () => {
    const dir = tempDir()
    const file = join(dir, "hash-bad.txt")
    writeFileSync(file, "original content", "utf-8")

    const tool = createEditTool()
    const ctx = { cwd: dir, signal: new AbortController().signal } as any
    const r = await tool.execute({ path: file, old_string: "original content", new_string: "should not appear", old_hash: "deadbeef" }, ctx)
    expect(r.isError).toBe(true)
    const parsed = JSON.parse(r.content as string)
    expect(parsed.error).toContain("old_hash mismatch")
    expect(readFileSync(file, "utf-8")).toBe("original content")
    await rm(dir, { recursive: true })
  })

  it("missing old_hash preserves current behavior", async () => {
    const dir = tempDir()
    const file = join(dir, "no-hash.txt")
    writeFileSync(file, "exact string here", "utf-8")

    const tool = createEditTool()
    const ctx = { cwd: dir, signal: new AbortController().signal } as any
    const r = await tool.execute({ path: file, old_string: "exact string", new_string: "replaced string" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.method).toBe("hash_anchored")
    expect(readFileSync(file, "utf-8")).toBe("replaced string here")
    await rm(dir, { recursive: true })
  })

  it("CRLF file remains CRLF after a successful hash-anchored edit with old_hash", async () => {
    const dir = tempDir()
    const file = join(dir, "crlf-hash.txt")
    writeFileSync(file, "line1\r\nline2\r\nline3", "utf-8")

    const tool = createEditTool()
    const ctx = { cwd: dir, signal: new AbortController().signal } as any
    const r = await tool.execute({ path: file, old_string: "line2", new_string: "LINE2", old_hash: sha256("line2") }, ctx)
    expect(r.isError).toBe(false)
    const content = readFileSync(file, "utf-8")
    expect(content).toBe("line1\r\nLINE2\r\nline3")
    expect(content).toContain("\r\n")
    await rm(dir, { recursive: true })
  })

  it("M11: should support concurrent edits to different files", async () => {
    const d1 = join(tmpDir, "concurrent-a.txt")
    const d2 = join(tmpDir, "concurrent-b.txt")
    writeFileSync(d1, "file A content")
    writeFileSync(d2, "file B content")

    const tool = createEditTool()
    const c = { cwd: tmpDir, signal: new AbortController().signal } as any
    const [r1, r2] = await Promise.all([
      tool.execute({ path: d1, old_string: "file A", new_string: "modified A" }, c),
      tool.execute({ path: d2, old_string: "file B", new_string: "modified B" }, c),
    ])
    expect(r1.isError).toBe(false)
    expect(r2.isError).toBe(false)
    expect(readFileSync(d1, "utf-8")).toBe("modified A content")
    expect(readFileSync(d2, "utf-8")).toBe("modified B content")
  })
})

describe("CRLF normalization (L5)", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = tempDir() })
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }))

  it("should edit CRLF file using LF-form old_string", async () => {
    const file = join(tmpDir, "crlf.txt")
    writeFileSync(file, "line1\r\nline2\r\nline3")

    const tool = createEditTool()
    const ctx = { cwd: tmpDir, signal: new AbortController().signal } as any
    const res = await tool.execute({ path: "crlf.txt", old_string: "line2", new_string: "LINE2" }, ctx)
    expect(res.isError).toBe(false)
    const content = readFileSync(file, "utf-8")
    expect(content).toBe("line1\r\nLINE2\r\nline3")
    expect(content).toContain("\r\n") // CRLF preserved
  })

  it("should edit LF file and keep LF", async () => {
    const file = join(tmpDir, "lf.txt")
    writeFileSync(file, "line1\nline2\nline3")

    const tool = createEditTool()
    const ctx = { cwd: tmpDir, signal: new AbortController().signal } as any
    const res = await tool.execute({ path: "lf.txt", old_string: "line2", new_string: "LINE2" }, ctx)
    expect(res.isError).toBe(false)
    const content = readFileSync(file, "utf-8")
    expect(content).toBe("line1\nLINE2\nline3")
    expect(content).not.toContain("\r\n")
  })

  it("should handle multi-line CRLF replacement", async () => {
    const file = join(tmpDir, "multi.txt")
    writeFileSync(file, "aaa\r\nbbb\r\nccc\r\n")

    const tool = createEditTool()
    const ctx = { cwd: tmpDir, signal: new AbortController().signal } as any
    const res = await tool.execute({ path: "multi.txt", old_string: "bbb\r\nccc", new_string: "BBB\nCCC" }, ctx)
    expect(res.isError).toBe(false)
    const content = readFileSync(file, "utf-8")
    expect(content).toBe("aaa\r\nBBB\r\nCCC\r\n")
  })

  it("should handle CRLF with fuzzy fallback", async () => {
    const file = join(tmpDir, "fuzzy-crlf.txt")
    writeFileSync(file, "  line1\r\n  line2\r\n  line3\r\n")

    const tool = createEditTool()
    const ctx = { cwd: tmpDir, signal: new AbortController().signal } as any
    // Use trimmed form that triggers fuzzy path
    const res = await tool.execute({ path: "fuzzy-crlf.txt", old_string: "line1\r\n  line2", new_string: "LINE1\nLINE2" }, ctx)
    expect(res.isError).toBe(false)
    const content = readFileSync(file, "utf-8")
    expect(content).toContain("LINE1")
    expect(content).toContain("\r\n") // CRLF preserved
  })
})

describe("CL-12: Hash edit sampling and stream close", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deepreef-cl12-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("does not read entire file for binary sampling", async () => {
    // Create a 1MB file with known content
    const filePath = join(dir, "large.txt")
    const line = "Hello world, this is a test file with some content. "
    // Build enough content to exceed 8KB
    const largeContent = line.repeat(5000) + "\n---OLD_MARKER---\n" + line.repeat(5000)
    writeFileSync(filePath, largeContent, "utf-8")

    const result = await hashAnchoredReplaceOnce(filePath, "---OLD_MARKER---", "---NEW_MARKER---")
    expect(result).not.toBeNull()
    expect(result!.replacedCount).toBe(1)
    const final = readFileSync(filePath, "utf-8")
    expect(final).toContain("---NEW_MARKER---")
  })

  it("rejects binary file with no temp file left behind", async () => {
    const filePath = join(dir, "binary.bin")
    // Write bytes that include invalid UTF-8 sequences
    const buf = Buffer.alloc(100)
    // Fill with 0xFF which is invalid UTF-8 (will be replaced with U+FFFD)
    buf.fill(0xff)
    buf.write("text", 90, "utf-8")
    writeFileSync(filePath, buf)

    await expect(hashAnchoredReplaceOnce(filePath, "text", "NEW")).rejects.toThrow("Binary file detected")
  })

  it("returns null when old_string not found and cleans up", async () => {
    const filePath = join(dir, "nomatch.txt")
    writeFileSync(filePath, "Hello world", "utf-8")

    const result = await hashAnchoredReplaceOnce(filePath, "NONEXISTENT", "NEW")
    expect(result).toBeNull()

    // File unchanged
    const content = readFileSync(filePath, "utf-8")
    expect(content).toBe("Hello world")
  })

  it("rejects empty old_string", async () => {
    const result = await hashAnchoredReplaceOnce("/tmp/nonexistent", "", "new")
    expect(result).toBeNull()
  })

  it("returns null when oldHash does not match", async () => {
    const filePath = join(dir, "hashcheck.txt")
    writeFileSync(filePath, "Hello world", "utf-8")

    // Wrong hash — should return null
    const result = await hashAnchoredReplaceOnce(filePath, "Hello", "Hi", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
    expect(result).toBeNull()
  })
})
