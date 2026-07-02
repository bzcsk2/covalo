import { resolve } from "node:path"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentTool } from "@covalo/core"
import { resolvePath, PathContainmentError } from "./resolve-path.js"
import { isSensitive } from "./sensitive.js"
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

      let searchPath: string
      if (typeof args.path === "string") {
        try {
          searchPath = await resolvePath(args.path, ctx.cwd)
        } catch (e) {
          if (e instanceof PathContainmentError) {
            return { content: safeStringify({ error: `path is outside the project directory: ${args.path}` }), isError: true }
          }
          return { content: safeStringify({ error: `cannot resolve path: ${args.path}` }), isError: true }
        }
      } else {
        searchPath = ctx.cwd
      }

      const pattern = args.pattern
      const include = typeof args.include === "string" ? args.include : undefined

      if (isSensitive(searchPath) || isSensitive(searchPath + "/")) {
        return { content: safeStringify({ error: `Searching sensitive path is denied: ${args.path ?? ctx.cwd}` }), isError: true }
      }

      let stdout: string
      try {
        stdout = await runSearch(pattern, searchPath, include, ctx.signal)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return { content: safeStringify({ error: `Search failed: ${msg}` }), isError: true }
      }

      const lines = stdout.split("\n").filter(Boolean)
      const filtered = lines.filter((line) => {
        // Extract file path: handle both Unix (path:num:text) and Windows (C:\path:num:text)
        // Use second-last colon as the separator between path and line number
        const lastColon = line.lastIndexOf(":")
        const secondLastColon = lastColon > 0 ? line.lastIndexOf(":", lastColon - 1) : -1
        const filePath = secondLastColon >= 0 ? line.substring(0, secondLastColon) : line.split(":")[0]
        return !isSensitive(resolve(searchPath, filePath))
      })
      const maxResults = 200
      const truncated = filtered.length > maxResults
      const results = truncated ? filtered.slice(0, maxResults) : filtered

      return {
        content: safeStringify({
          pattern,
          path: args.path ?? ctx.cwd,
          results,
          totalMatches: filtered.length,
          truncated,
          cwd: ctx.cwd,
        }),
        isError: false,
      }
    },
  }
}

function runSearch(pattern: string, searchPath: string, include?: string, signal?: AbortSignal): Promise<string> {
  return tryRg(pattern, searchPath, include, signal)
    .catch(() => tryGrep(pattern, searchPath, include, signal))
    .catch(() => tryFindstr(pattern, searchPath, include, signal))
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

/**
 * Detects if a pattern contains regex metacharacters that findstr can't handle
 * in its `/c:` literal mode but that require regex interpretation.
 * findstr `/r` output has no line breaks on Windows pipe, so we use a JS-based
 * regex engine for patterns that are actually regex.
 */
function isRegexPattern(pattern: string): boolean {
  // Characters that are meaningful in JS regex that distinguish regex from literal
  return /[.+*?^${}()|[\]\\]/.test(pattern) && !/^[a-zA-Z0-9_\s-]+$/.test(pattern)
}

function tryFindstr(pattern: string, searchPath: string, include?: string, signal?: AbortSignal): Promise<string> {
  // If the pattern is a true regex (not just a literal string), use Node.js-based
  // regex search because findstr /r produces broken output (no line breaks) on Windows pipe.
  if (isRegexPattern(pattern)) {
    return tryNodeGrep(pattern, searchPath, include, signal)
  }

  return new Promise((resolve, reject) => {
    // findstr /s /n /c:"pattern" <target>
    // /s = recursive, /n = line numbers, /c: = literal search string
    const findstrArgs = ["/s", "/n"]

    // Normalize path separators for findstr
    const normalizedPath = searchPath.replace(/\//g, "\\")

    let target = normalizedPath
    if (include) {
      // include is a glob like "*.ts" — findstr uses wildcards directly
      findstrArgs.push("/c:" + pattern, normalizedPath + "\\" + include)
    } else {
      // For directories, findstr /s with a directory target searches all files recursively
      try {
        const stat = fs.statSync(searchPath)
        if (stat.isDirectory()) {
          target = normalizedPath + "\\*"
        }
      } catch { /* fall through */ }
      findstrArgs.push("/c:" + pattern, target)
    }

    const proc = spawn("findstr", findstrArgs, { signal, timeout: TIMEOUT_MS })
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
      else if (code === 0 || code === null) resolve(stdout)
      else reject(new Error(`findstr exited with code ${code}`))
    })

    proc.on("error", reject)
  })
}

/**
 * Node.js-based regex grep. Used when findstr /r would produce broken output
 * (Windows pipe strips line breaks in /r mode). Reads files directly and
 * applies JS RegExp pattern.
 */
function tryNodeGrep(pattern: string, searchPath: string, include?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    try {
      const stat = fs.statSync(searchPath)
      let files: string[] = []

      const collectFiles = (dir: string) => {
        if (signal?.aborted) { reject(new Error("aborted")); return }
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git") continue
            collectFiles(fullPath)
          } else if (entry.isFile()) {
            if (include) {
              const ext = include.replace(/^\*/, "")
              if (!entry.name.endsWith(ext)) continue
            }
            files.push(fullPath)
          }
        }
      }

      if (stat.isDirectory()) {
        collectFiles(searchPath)
      } else {
        files = [searchPath]
      }

      const regex = new RegExp(pattern)
      const results: string[] = []

      for (const file of files) {
        if (signal?.aborted) { reject(new Error("aborted")); return }
        try {
          const content = fs.readFileSync(file, "utf-8")
          const lines = content.split(/\r?\n/)
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              const normalizedPath = file.replace(/\//g, "\\")
              results.push(`${normalizedPath}:${i + 1}:${lines[i]}`)
              if (results.join("\n").length > MAX_OUTPUT_CHARS) {
                resolvePromise(results.join("\n"))
                return
              }
            }
          }
        } catch {
        }
      }

      resolvePromise(results.join("\n"))
    } catch (err: any) {
      reject(err)
    }
  })
}
