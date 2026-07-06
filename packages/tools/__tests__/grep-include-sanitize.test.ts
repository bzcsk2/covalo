import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createGrepTool } from "../src/grep.js"
import type { AgentTool } from "@covalo/protocol"

describe("S1-7: grep include 输入约束", () => {
  let tmpDir: string
  let grepTool: AgentTool
  let ctx: { cwd: string; signal: AbortSignal }

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-grep-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    await writeFile(join(tmpDir, "a.ts"), "const x = 1\n")
    await writeFile(join(tmpDir, "b.js"), "const y = 2\n")
    await writeFile(join(tmpDir, "c.tsx"), "const z = 3\n")
    grepTool = createGrepTool()
    ctx = { cwd: tmpDir, signal: new AbortController().signal }
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("'*.ts' 正常搜索", async () => {
    const result = await grepTool.execute({ pattern: "const", include: "*.ts" }, ctx)
    expect(result.isError).toBeFalsy()
    const content = typeof result.content === "string" ? result.content : String(result.content)
    expect(content).toContain("a.ts")
  })

  it("'*.{ts,tsx}' 正常搜索", async () => {
    const result = await grepTool.execute({ pattern: "const", include: "*.{ts,tsx}" }, ctx)
    expect(result.isError).toBeFalsy()
    const content = typeof result.content === "string" ? result.content : String(result.content)
    expect(content).toContain("a.ts")
    expect(content).toContain("c.tsx")
  })

  it("路径逃逸 '..' 被拒绝", async () => {
    const result = await grepTool.execute({ pattern: "test", include: "../../../etc/passwd" }, ctx)
    expect(result.isError).toBe(true)
    const content = typeof result.content === "string" ? result.content : String(result.content)
    expect(content).toContain("Invalid include pattern")
  })

  it("'--hidden' 被拒绝", async () => {
    const result = await grepTool.execute({ pattern: "test", include: "--hidden" }, ctx)
    expect(result.isError).toBe(true)
    expect(typeof result.content === "string" ? result.content : String(result.content)).toContain("Invalid include pattern")
  })

  it("'-v' 被拒绝", async () => {
    const result = await grepTool.execute({ pattern: "test", include: "-v" }, ctx)
    expect(result.isError).toBe(true)
  })

  it("含路径分隔符的 include 被拒绝", async () => {
    const result = await grepTool.execute({ pattern: "test", include: "src/*.ts" }, ctx)
    expect(result.isError).toBe(true)
  })

  it("含反斜杠的 include 被拒绝", async () => {
    const result = await grepTool.execute({ pattern: "test", include: "src\\*.ts" }, ctx)
    expect(result.isError).toBe(true)
  })

  it("不传 include 时行为不变", async () => {
    const result = await grepTool.execute({ pattern: "const" }, ctx)
    expect(result.isError).toBeFalsy()
    const content = typeof result.content === "string" ? result.content : String(result.content)
    expect(content).toContain("a.ts")
    expect(content).toContain("b.js")
  })

  it("超长 include 被拒绝", async () => {
    const result = await grepTool.execute({ pattern: "test", include: "a".repeat(300) }, ctx)
    expect(result.isError).toBe(true)
  })

  it("含 null 字符的 include 被拒绝", async () => {
    const result = await grepTool.execute({ pattern: "test", include: "test\0.ts" }, ctx)
    expect(result.isError).toBe(true)
  })
})
