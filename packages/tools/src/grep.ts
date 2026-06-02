import { resolve } from "node:path"
import { spawn } from "node:child_process"
import type { AgentTool } from "@deepicode/core"
import { safeStringify } from "./safe-stringify.js"

const MAX_OUTPUT_CHARS = 500_000
const TIMEOUT_MS = 15_000

export function createGrepTool(): AgentTool {
  return {
    name: "grep",
    description: "Search file contents using regular expressions. Returns matching files with line numbers. Uses ripgrep (rg) if available, otherwise falls back to grep.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression to search for." },
        path: { type: "string", description: "Directory or file to search in (optional, defaults to working directory)." },
        include: { type: "string", description: "File pattern to include (e.g. '*.ts', '*.{ts,tsx}')." },
      },
      required: ["pattern"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.pattern !== "string" || !args.pattern) {
        return { content: safeStringify({ error: "pattern is required" }), isError: true }
      }

      const searchPath = typeof args.path === "string" ? resolve(ctx.cwd, args.path) : ctx.cwd
      const pattern = args.pattern
      const include = typeof args.include === "string" ? args.include : undefined

      let stdout: string
      try {
        stdout = await runSearch(pattern, searchPath, include, ctx.signal)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: safeStringify({ error: `Search failed: ${msg}` }), isError: true }
      }

      const lines = stdout.split("\n").filter(Boolean)
      const maxResults = 200
      const truncated = lines.length > maxResults
      const results = truncated ? lines.slice(0, maxResults) : lines

      return {
        content: safeStringify({
          pattern,
          path: args.path ?? ctx.cwd,
          results,
          totalMatches: lines.length,
          truncated,
          cwd: ctx.cwd,
        }),
        isError: false,
      }
    },
  }
}

function runSearch(pattern: string, searchPath: string, include?: string, signal?: AbortSignal): Promise<string> {
  return tryRg(pattern, searchPath, include, signal).catch(() => tryGrep(pattern, searchPath, include, signal))
}

function tryRg(pattern: string, searchPath: string, include?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const rgArgs = ["-n", "--no-heading"]
    if (include) rgArgs.push("-g", include)
    rgArgs.push("--", pattern, searchPath)

    const proc = spawn("rg", rgArgs, { signal, timeout: TIMEOUT_MS })
    let stdout = ""
    let outputTruncated = false

    proc.stdout.on("data", (chunk: Buffer) => {
      if (outputTruncated) return
      stdout += chunk.toString()
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS)
        outputTruncated = true
        proc.kill()
      }
    })

    proc.stderr.on("data", () => {})

    proc.on("close", (code) => {
      if (code === 127) reject(new Error("rg not found"))
      else resolve(stdout)
    })

    proc.on("error", reject)
  })
}

function tryGrep(pattern: string, searchPath: string, include?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const grepArgs = ["-rn"]
    if (include) grepArgs.push(`--include=${include}`)
    grepArgs.push("--", pattern, searchPath)

    const proc = spawn("grep", grepArgs, { signal, timeout: TIMEOUT_MS })
    let stdout = ""
    let outputTruncated = false

    proc.stdout.on("data", (chunk: Buffer) => {
      if (outputTruncated) return
      stdout += chunk.toString()
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS)
        outputTruncated = true
        proc.kill()
      }
    })

    proc.stderr.on("data", () => {})

    proc.on("close", (code) => {
      if (code === 1) resolve("") // no matches
      else resolve(stdout)
    })

    proc.on("error", reject)
  })
}
