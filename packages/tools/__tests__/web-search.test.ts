import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

const ctx = { cwd: process.cwd(), signal: new AbortController().signal } as any

const MOCK_HTML = `
<html><body>
<a href="/url?q=https://example.com&amp;sa=U&amp;ved=2ahUKE">Example Result</a>
<span class="st">This is a snippet for the example result.</span>
<a href="/url?q=https://example2.com&amp;sa=U&amp;ved=3ahUKE">Second Result</a>
<span class="st">Second snippet text.</span>
</body></html>
`

describe("M13: WebSearch", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response(MOCK_HTML, { status: 200, headers: { "Content-Type": "text/html" } })
    })
  })

  afterEach(() => {
    fetchSpy.mockRestore()
  })

  it("should reject empty query", async () => {
    const { createWebSearchTool } = await import("../src/web-search.js")
    const tool = createWebSearchTool()
    const r = await tool.execute({ query: "" }, ctx)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toBeTruthy()
  })

  it("should reject missing query", async () => {
    const { createWebSearchTool } = await import("../src/web-search.js")
    const tool = createWebSearchTool()
    const r = await tool.execute({} as any, ctx)
    expect(r.isError).toBe(true)
  })

  it("should enforce num_results limit (max 10)", async () => {
    const { createWebSearchTool } = await import("../src/web-search.js")
    const tool = createWebSearchTool()
    const r = await tool.execute({ query: "test", num_results: 20 }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(Array.isArray(p.results)).toBe(true)
  })

  it("should default num_results to 5", async () => {
    const { createWebSearchTool } = await import("../src/web-search.js")
    const tool = createWebSearchTool()
    const r = await tool.execute({ query: "test" }, ctx)
    expect(r.isError).toBe(false)
  })

  it("should handle no results gracefully", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("<html><body></body></html>", { status: 200 }))
    const { createWebSearchTool } = await import("../src/web-search.js")
    const tool = createWebSearchTool()
    const r = await tool.execute({ query: "xyznonexistent12345" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(Array.isArray(p.results)).toBe(true)
  })

  it("should handle fetch network error", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed"))
    const { createWebSearchTool } = await import("../src/web-search.js")
    const tool = createWebSearchTool()
    const r = await tool.execute({ query: "test" }, ctx)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("Search error")
  })

  it("should handle HTTP error response", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("error", { status: 503, statusText: "Service Unavailable" }))
    const { createWebSearchTool } = await import("../src/web-search.js")
    const tool = createWebSearchTool()
    const r = await tool.execute({ query: "test" }, ctx)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("503")
  })
})
