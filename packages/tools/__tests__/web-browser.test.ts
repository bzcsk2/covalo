import { describe, it, expect } from "vitest"
import { createWebBrowserTool } from "../src/web-browser.js"

const ctx = { cwd: process.cwd(), signal: new AbortController().signal } as any

describe("WebBrowser", () => {
  it("should reject invalid action", async () => {
    const tool = createWebBrowserTool()
    const r = await tool.execute({ action: "invalid" }, ctx)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("action")
  })

  it("should reject missing action", async () => {
    const tool = createWebBrowserTool()
    const r = await tool.execute({} as any, ctx)
    expect(r.isError).toBe(true)
  })

  it("should reject navigate without url", async () => {
    const tool = createWebBrowserTool()
    const r = await tool.execute({ action: "navigate" }, ctx)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("url")
  })

  it("should reject screenshot without url", async () => {
    const tool = createWebBrowserTool()
    const r = await tool.execute({ action: "screenshot" }, ctx)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("url")
  })

  it("should require url for click/fill/extract", async () => {
    const tool = createWebBrowserTool()
    const r = await tool.execute({ action: "click", selector: "#btn" }, ctx)
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("url")
  })
})
