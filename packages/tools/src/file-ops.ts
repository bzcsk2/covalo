import { readFile, stat } from "node:fs/promises"
import type { AgentTool } from "@deepreef/core"
import { recordRead } from "./stale-read.js"
import { resolvePath, PathContainmentError } from "./resolve-path.js"
import { isSensitive } from "./sensitive.js"
import { safeStringify, hasBinaryEncoding } from "./safe-stringify.js"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export function createReadFileTool(): AgentTool {
  return {
    name: "read_file",
    description: "Read a UTF-8 text file. Optionally slice by line range.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative file path." },
        start_line: { type: "number", description: "0-based start line (inclusive)." },
        end_line: { type: "number", description: "0-based end line (inclusive)." },
        max_chars: { type: "number", description: "Max characters to return." },
      },
      required: ["path"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.path !== "string" || !args.path) {
        return { content: safeStringify({ error: "path is required" }), isError: true }
      }

      let path: string
      try {
        path = await resolvePath(args.path, ctx.cwd)
      } catch (e) {
        if (e instanceof PathContainmentError) {
          return { content: safeStringify({ error: `path is outside the project directory: ${args.path}` }), isError: true }
        }
        return { content: safeStringify({ error: `cannot resolve path: ${args.path}` }), isError: true }
      }

      if (isSensitive(path)) {
        return { content: safeStringify({ error: `Reading sensitive file is denied: ${args.path}` }), isError: true }
      }

      let fileStat
      try {
        fileStat = await stat(path)
      } catch {
        return { content: safeStringify({ error: `File not found: ${args.path}` }), isError: true }
      }

      if (!fileStat.isFile()) {
        return { content: safeStringify({ error: `Not a file: ${args.path}` }), isError: true }
      }

      if (fileStat.size > MAX_FILE_SIZE) {
        return { content: safeStringify({ error: `File too large (${fileStat.size} bytes). Max allowed: ${MAX_FILE_SIZE} bytes.` }), isError: true }
      }

      const maxChars = typeof args.max_chars === "number" ? Math.max(0, args.max_chars) : 200_000
      const raw = await readFile(path, "utf-8")
      if (hasBinaryEncoding(raw)) {
        return { content: safeStringify({ error: `File appears to be binary: ${args.path}` }), isError: true }
      }
      let out = raw

      const start = typeof args.start_line === "number" ? Math.max(0, Math.floor(args.start_line)) : undefined
      const end = typeof args.end_line === "number" ? Math.max(0, Math.floor(args.end_line)) : undefined

      if (start !== undefined || end !== undefined) {
        const lines = raw.split("\n")
        const s = start ?? 0
        const e = end ?? (lines.length - 1)
        out = lines.slice(s, e + 1).join("\n")
      }

      if (out.length > maxChars) out = out.slice(0, maxChars) + `\n... [truncated: ${out.length - maxChars} more chars]`
      await recordRead(path, fileStat.mtimeMs, fileStat.size)
      return {
        content: safeStringify({ path: args.path, content: out, cwd: ctx.cwd }),
        isError: false,
      }
    },
  }
}

