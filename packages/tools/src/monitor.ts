import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { sampleDisk, sampleMemory, sampleProcesses } from "./platform/monitor-backend.js"

const VALID_TARGETS = ["process", "disk", "memory", "file"] as const

export function createMonitorTool(): AgentTool {
  return {
    name: "Monitor",
    description: "Monitor system processes, file changes, or resource usage. Use for watching log output, waiting for file creation, or checking system state.",
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          enum: [...VALID_TARGETS],
          description: "What to monitor: 'process' for process list, 'disk' for disk usage, 'memory' for memory usage, 'file' for file changes",
        },
        path: { type: "string", description: "File path when monitoring a specific file" },
        interval_ms: { type: "number", description: "Check interval in ms, default 1000" },
        timeout_ms: { type: "number", description: "Total monitoring time in ms, default 30000" },
      },
      required: ["target"],
    },
    concurrency: "exclusive",
    approval: "read",
    async execute(args, ctx) {
      const target = args.target
      if (!VALID_TARGETS.includes(target as any)) {
        return { content: safeStringify({ error: `target must be one of: ${VALID_TARGETS.join(", ")}` }), isError: true }
      }

      if (target === "file" && (typeof args.path !== "string" || !args.path)) {
        return { content: safeStringify({ error: "path is required when monitoring a file" }), isError: true }
      }

      const intervalMs = Math.max(100, Math.floor(typeof args.interval_ms === "number" ? args.interval_ms : 1000))
      const timeoutMs = Math.max(intervalMs, Math.floor(typeof args.timeout_ms === "number" ? args.timeout_ms : 30_000))
      const maxSamples = Math.ceil(timeoutMs / intervalMs)

      const samples: unknown[] = []
      const t0 = Date.now()

      while (samples.length < maxSamples) {
        if (ctx.signal?.aborted) break

        const sample = await takeSample(target as typeof VALID_TARGETS[number], args.path as string | undefined, ctx)
        if (sample) samples.push(sample)

        const elapsed = Date.now() - t0
        if (elapsed >= timeoutMs) break

        // Wait for next interval (respect abort)
        try {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, intervalMs)
            if (ctx.signal) {
              if (ctx.signal.aborted) { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); return }
              ctx.signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")) }, { once: true })
            }
          })
        } catch {
          break
        }
      }

      return {
        content: safeStringify({ target, samples, totalSamples: samples.length, durationMs: Date.now() - t0 }),
        isError: false,
      }
    },
  }
}

async function takeSample(
  target: typeof VALID_TARGETS[number],
  filePath: string | undefined,
  ctx: { cwd: string; signal?: AbortSignal },
): Promise<unknown> {
  try {
    switch (target) {
      case "process": {
        return await sampleProcesses(ctx.signal)
      }
      case "disk": {
        return await sampleDisk(ctx.signal)
      }
      case "memory": {
        return sampleMemory()
      }
      case "file": {
        const fullPath = resolve(ctx.cwd, filePath!)
        try {
          const s = await stat(fullPath)
          return { exists: true, path: filePath, size: s.size, mtimeMs: s.mtimeMs }
        } catch {
          return { exists: false, path: filePath }
        }
      }
    }
  } catch (error) {
    return { error: `Failed to sample ${target}: ${error instanceof Error ? error.message : String(error)}`, backend: target === "memory" || target === "file" ? "node" : "platform" }
  }
}
