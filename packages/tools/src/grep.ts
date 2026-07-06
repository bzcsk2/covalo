import { resolve } from "node:path"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import type { AgentTool } from "@covalo/protocol"
import { resolvePath, PathContainmentError } from "./resolve-path.js"
import { isSensitive } from "./sensitive.js"
import { safeStringify } from "./safe-stringify.js"

const MAX_OUTPUT_CHARS = 500_000
const TIMEOUT_MS = 15_000

/**
 * S1-7: Sanitize include pattern to prevent flag injection and path traversal.
 * Returns the cleaned pattern, or null if the pattern is rejected.
 */
function sanitizeIncludePattern(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.length > 256) return null
  if (trimmed.includes("\0")) return null
  if (trimmed.includes("..")) return null
  if (trimmed.startsWith("-")) return null
  if (/[\/\\]/.test(trimmed)) return null

  // Allow common glob characters, extensions, and brace expansion
  if (!/^[a-zA-Z0-9_*?.{},[\]!\-]+$/.test(trimmed)) return null

  return trimmed
}

/**
 * Expand brace expansion in glob patterns.
 *
 * CI 上 `*.{ts,tsx}` 在 rg 的某些版本/场景下 brace 支持不稳定，回退到 grep 时
 * `grep --include=*.{ts,tsx}` 完全不支持 brace（把花括号当字面字符），导致零匹配。
 * 这里在调用 rg/grep/findstr 之前先把 brace 展开成多个简单 glob，然后对每个 glob
 * 各传一次 `-g` / `--include`。
 *
 * - `*.{ts,tsx}` → `["*.ts", "*.tsx"]`
 * - `*.{js,ts,tsx}` → `["*.js", "*.ts", "*.tsx"]`
 * - `*.ts` → `["*.ts"]` (无 brace，原样返回)
 * - `prefix{x,y}suffix` → `["prefixxsuffix", "prefixysuffix"]`
 */
function expandBrace(pattern: string): string[] {
  const match = pattern.match(/^([^{]*)\{([^}]+)\}(.*)$/)
  if (!match) return [pattern]
  const [, prefix = "", body = "", suffix = ""] = match
  const alternatives = body.split(",").map(s => s.trim()).filter(Boolean)
  if (alternatives.length === 0) return [pattern]
  return alternatives.map(alt => `${prefix}${alt}${suffix}`)
}

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
      // S1-7: sanitize include pattern to prevent flag injection and path traversal
      const rawInclude = typeof args.include === "string" ? args.include : undefined
      const include = rawInclude ? sanitizeIncludePattern(rawInclude) : undefined

      if (rawInclude && !include) {
        return { content: safeStringify({ error: `Invalid include pattern: ${rawInclude}` }), isError: true }
      }

      // Expand brace patterns like `*.{ts,tsx}` → `["*.ts", "*.tsx"]` before passing to rg/grep/findstr.
      // rg 在某些版本对 brace 支持不稳定；grep 的 --include 完全不支持 brace。
      const includes = include ? expandBrace(include) : []

      if (isSensitive(searchPath) || isSensitive(searchPath + "/")) {
        return { content: safeStringify({ error: `Searching sensitive path is denied: ${args.path ?? ctx.cwd}` }), isError: true }
      }

      // Require include filter for broad patterns to avoid excessive scanning
      if (!include && pattern.length <= 2 && !/^[A-Za-z0-9_]+$/.test(pattern)) {
        return { content: safeStringify({ error: `Broad search pattern "${pattern}" requires an "include" filter (e.g. include: "*.ts")` }), isError: true }
      }

      let stdout: string
      try {
        stdout = await runSearch(pattern, searchPath, includes, ctx.signal)
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

function runSearch(pattern: string, searchPath: string, includes: string[], signal?: AbortSignal): Promise<string> {
  return tryRg(pattern, searchPath, includes, signal)
    .catch(() => tryGrep(pattern, searchPath, includes, signal))
    .catch(() => tryFindstr(pattern, searchPath, includes, signal))
}

function tryRg(pattern: string, searchPath: string, includes: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const rgArgs = ["-n", "--no-heading"]
    // S1-7: brace 已在 expandBrace 中展开为多个简单 glob，对每个 glob 各传一次 -g。
    for (const inc of includes) rgArgs.push("-g", inc)
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

function tryGrep(pattern: string, searchPath: string, includes: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const grepArgs = ["-rn"]
    // S1-7: 对每个展开后的 glob 各传一次 --include（grep 不支持 brace expansion）。
    for (const inc of includes) grepArgs.push(`--include=${inc}`)
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

function tryFindstr(pattern: string, searchPath: string, includes: string[], signal?: AbortSignal): Promise<string> {
  // If the pattern is a true regex (not just a literal string), use Node.js-based
  // regex search because findstr /r produces broken output (no line breaks) on Windows pipe.
  if (isRegexPattern(pattern)) {
    return tryNodeGrep(pattern, searchPath, includes, signal)
  }

  return new Promise((resolve, reject) => {
    // findstr /s /n /c:"pattern" <target>
    // /s = recursive, /n = line numbers, /c: = literal search string
    const findstrArgs = ["/s", "/n"]

    // Normalize path separators for findstr
    const normalizedPath = searchPath.replace(/\//g, "\\")

    if (includes.length > 0) {
      // S1-7: brace 已展开为多个简单 glob。findstr 用空格分隔多个 target 通配符，
      // 例如 `findstr /s /n /c:"pattern" path\*.ts path\*.tsx`。
      findstrArgs.push("/c:" + pattern)
      for (const inc of includes) {
        findstrArgs.push(normalizedPath + "\\" + inc)
      }
    } else {
      // For directories, findstr /s with a directory target searches all files recursively
      let target = normalizedPath
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
function tryNodeGrep(pattern: string, searchPath: string, includes: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    try {
      const stat = fs.statSync(searchPath)
      let files: string[] = []

      // S1-7: 把每个 include 转换成"后缀匹配"条件。
      // expandBrace 已经把 `*.{ts,tsx}` 展开成 `["*.ts", "*.tsx"]`，
      // 这里对每个 glob 取 `*` 之后的部分作为后缀（如 `*.ts` → `.ts`），
      // 文件名匹配任意一个后缀即收集。
      const suffixes = includes.map(inc => inc.replace(/^\*/, ""))

      const matchesAnyInclude = (fileName: string): boolean => {
        if (suffixes.length === 0) return true
        return suffixes.some(suffix => fileName.endsWith(suffix))
      }

      const collectFiles = (dir: string) => {
        if (signal?.aborted) { reject(new Error("aborted")); return }
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            if (entry.name === "node_modules" || entry.name === ".git") continue
            collectFiles(fullPath)
          } else if (entry.isFile()) {
            if (!matchesAnyInclude(entry.name)) continue
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
