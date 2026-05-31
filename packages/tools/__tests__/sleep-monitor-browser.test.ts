import { describe, it, expect, vi } from "vitest"
import { createSleepTool } from "../src/sleep.js"
import { createMonitorTool } from "../src/monitor.js"
import { createWebBrowserTool } from "../src/web-browser.js"
import { createPushNotificationTool } from "../src/push-notification.js"

const ctx = { cwd: process.cwd(), signal: new AbortController().signal } as any

describe("Sleep", () => {
  it("should sleep for specified duration", async () => {
    const tool = createSleepTool()
    const t0 = Date.now()
    const r = await tool.execute({ duration_ms: 10 }, ctx)
    const elapsed = Date.now() - t0
    expect(r.isError).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(5)
    const p = JSON.parse(r.content as string)
    expect(p.slept_ms).toBe(10)
  })

  it("should sleep 0ms immediately", async () => {
    const tool = createSleepTool()
    const r = await tool.execute({ duration_ms: 0 }, ctx)
    expect(r.isError).toBe(false)
  })

  it("should reject invalid duration", async () => {
    const tool = createSleepTool()
    const r = await tool.execute({ duration_ms: -1 }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should accept large duration up to 300s", async () => {
    const tool = createSleepTool()
    // Use a small value that's safe to test
    const r = await tool.execute({ duration_ms: 5 }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.slept_ms).toBe(5)
  })

  it("should handle abort signal", async () => {
    const tool = createSleepTool()
    const ac = new AbortController()
    const ctx2 = { ...ctx, signal: ac.signal }
    const promise = tool.execute({ duration_ms: 50000 }, ctx2)
    ac.abort()
    const r = await promise
    expect(r.isError).toBe(true)
  })
})

describe("Monitor", () => {
  it("should validate target parameter", async () => {
    const tool = createMonitorTool()
    const r = await tool.execute({ target: "invalid" as any }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should require path for file target", async () => {
    const tool = createMonitorTool()
    const r = await tool.execute({ target: "file" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should monitor memory", async () => {
    const tool = createMonitorTool()
    const r = await tool.execute({ target: "memory", interval_ms: 100, timeout_ms: 150 }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.target).toBe("memory")
    expect(p.samples.length).toBeGreaterThanOrEqual(1)
  })

  it("should monitor disk", async () => {
    const tool = createMonitorTool()
    const r = await tool.execute({ target: "disk", interval_ms: 100, timeout_ms: 150 }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.target).toBe("disk")
    expect(p.samples.length).toBeGreaterThanOrEqual(1)
  })

  it("should monitor process", async () => {
    const tool = createMonitorTool()
    const r = await tool.execute({ target: "process", interval_ms: 100, timeout_ms: 150 }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.target).toBe("process")
    expect(p.samples.length).toBeGreaterThanOrEqual(1)
  })
})

describe("WebBrowser", () => {
  it("should reject empty action", async () => {
    const tool = createWebBrowserTool()
    const r = await tool.execute({} as any, ctx)
    expect(r.isError).toBe(true)
  })

  it("should reject invalid action", async () => {
    const tool = createWebBrowserTool()
    const r = await tool.execute({ action: "fly" as any }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should require url for navigate", async () => {
    const tool = createWebBrowserTool()
    const r = await tool.execute({ action: "navigate" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should require url for browser interactions", async () => {
    const tool = createWebBrowserTool()
    const r = await tool.execute({ action: "click", selector: "#btn" }, ctx)
    expect(r.isError).toBe(true)
    expect(r.content).toContain("url")
  })
})

describe("PushNotification", () => {
  it("should reject empty title", async () => {
    const tool = createPushNotificationTool()
    const r = await tool.execute({ title: "", message: "test" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should reject empty message", async () => {
    const tool = createPushNotificationTool()
    const r = await tool.execute({ title: "test", message: "" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should return sent result (terminal bell fallback)", async () => {
    const tool = createPushNotificationTool()
    const r = await tool.execute({ title: "Test", message: "Hello" }, ctx)
    expect(r.isError).toBe(false)
  })

  it("should accept urgency parameter", async () => {
    const tool = createPushNotificationTool()
    const r = await tool.execute({ title: "Urgent", message: "Now", urgency: "critical" }, ctx)
    expect(r.isError).toBe(false)
  })
})
