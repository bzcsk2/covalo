import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createWebFetchTool } from "../src/web-fetch.js"

const ctx = { cwd: process.cwd(), signal: new AbortController().signal } as any

describe("WebFetch validation", () => {
  it("should reject empty url", async () => {
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "" }, ctx)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("url")
  })

  it("should reject missing url", async () => {
    const tool = createWebFetchTool()
    const r = await tool.execute({} as any, ctx)
    expect(r.isError).toBe(true)
  })

  it("should reject invalid URL", async () => {
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "not a valid url" }, ctx)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("Invalid URL")
  })

  it("should reject URL with username:password", async () => {
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "https://user:pass@example.com" }, ctx)
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("credentials")
  })

  it("should reject private IP address", async () => {
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "http://127.0.0.1:8080" }, ctx)
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("internal network")
  })

  it("should reject private IP via 10.x.x.x", async () => {
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "http://10.0.0.1" }, ctx)
    expect(r.isError).toBe(true)
  })
})

vi.mock("node:dns", () => ({
  promises: {
    // web-fetch.ts 用的是 dns.lookup(hostname, { all: true }) 做 SSRF 检查
    // 之前 mock 里只有 resolve，lookup 未被 mock 导致 SSRF 抛错，所有测试失败
    resolve: vi.fn().mockResolvedValue(["93.184.216.34"]),
    lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
  },
}))

describe("M12: WebFetch full flow", () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    fetchMock = vi.fn()
    globalThis.fetch = fetchMock
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it("should handle normal HTTPS URL", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Map([["content-type", "text/plain"]]),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode("Hello world").buffer),
      redirected: false,
      url: "https://example.com",
    })
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "https://example.com" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.content).toContain("Hello world")
    expect(p.code).toBe(200)
  })

  it("should upgrade HTTP to HTTPS", async () => {
    let calledUrl = ""
    fetchMock.mockImplementation(async (url: string) => {
      calledUrl = url
      return {
        ok: true, status: 200, statusText: "OK",
        headers: new Map([["content-type", "text/plain"]]),
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode("ok").buffer),
        redirected: false,
        url,
      }
    })
    const tool = createWebFetchTool()
    await tool.execute({ url: "http://example.com" }, ctx)
    expect(calledUrl).toMatch(/^https:\/\//)
  })

  it("should handle redirect (follow by default)", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: new Map([["content-type", "text/plain"]]),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode("final").buffer),
      redirected: true,
      url: "https://final.example.com",
    })
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "https://example.com" }, ctx)
    expect(r.isError).toBe(false)
  })

  it("should convert HTML to markdown", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: new Map([["content-type", "text/html"]]),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode("<html><body><p>Hello <b>world</b></p></body></html>").buffer),
      redirected: false,
    })
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "https://example.com" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.format).toBe("markdown")
    expect(p.content).toContain("Hello **world**")
  })

  it("should reject content >10MB", async () => {
    const bigBuf = new Uint8Array(11 * 1024 * 1024)
    fetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: new Map([["content-type", "text/plain"]]),
      arrayBuffer: () => Promise.resolve(bigBuf.buffer),
      redirected: false,
    })
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "https://example.com" }, ctx)
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("too large")
  })

  it("should truncate output at max_length", async () => {
    const longText = "x".repeat(100_000)
    fetchMock.mockResolvedValue({
      ok: true, status: 200, statusText: "OK",
      headers: new Map([["content-type", "text/plain"]]),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode(longText).buffer),
      redirected: false,
    })
    const tool = createWebFetchTool()
    const r = await tool.execute({ url: "https://example.com", max_length: 100 }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.content.length).toBeLessThan(200)
    expect(p.content).toContain("truncated")
  })
})
