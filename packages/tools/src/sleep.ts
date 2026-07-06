import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"

const MAX_SLEEP_MS = 300_000

export function createSleepTool(): AgentTool {
  return {
    name: "Sleep",
    description: "Delay execution for a specified duration. Use when you need to wait before proceeding (e.g., waiting for a process to start, file to appear, or API rate limit).",
    parameters: {
      type: "object",
      properties: {
        duration_ms: { type: "number", description: "Duration to sleep in milliseconds (max 300000 = 5 minutes)" },
      },
      required: ["duration_ms"],
    },
    concurrency: "exclusive",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.duration_ms !== "number" || args.duration_ms < 0) {
        return { content: safeStringify({ error: "duration_ms must be a positive number" }), isError: true }
      }
      const duration = Math.min(Math.floor(args.duration_ms), MAX_SLEEP_MS)

      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, duration)
          if (ctx.signal) {
            if (ctx.signal.aborted) {
              clearTimeout(timer)
              reject(new DOMException("Aborted", "AbortError"))
              return
            }
            ctx.signal.addEventListener("abort", () => {
              clearTimeout(timer)
              reject(new DOMException("Aborted", "AbortError"))
            }, { once: true })
          }
        })
        return { content: safeStringify({ slept_ms: duration }), isError: false }
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          return { content: safeStringify({ error: "Sleep aborted", slept_ms: duration }), isError: true }
        }
        throw e
      }
    },
  }
}
