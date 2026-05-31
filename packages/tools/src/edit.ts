import { readFile, writeFile, stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentTool } from "../../core/src/interface.js"
import { hashAnchoredReplaceOnce } from "./hash-edit.js"
import { fuzzyReplaceOnce } from "./fuzzy-edit.js"
import { checkStale } from "./stale-read.js"
import { isSensitive } from "./sensitive.js"
import { safeStringify } from "./safe-stringify.js"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

/** Detect whether content uses CRLF line endings. */
function detectLineEnding(content: string): "\r\n" | "\n" {
  // Check for \r\n before the first \n
  const crlfIndex = content.indexOf("\r\n")
  const lfIndex = content.indexOf("\n")
  if (crlfIndex >= 0 && (lfIndex < 0 || crlfIndex < lfIndex)) return "\r\n"
  return "\n"
}

/** Normalize \r\n to \n for comparison purposes. */
function toLF(s: string): string {
  return s.replace(/\r\n/g, "\n")
}

/** Restore original line ending style after replacement. */
function restoreLineEndings(content: string, ending: "\r\n" | "\n"): string {
  if (ending === "\r\n") return content.replace(/\n/g, "\r\n")
  return content
}

export function createEditTool(): AgentTool {
  return {
    name: "edit",
    description: "Edit a text file by replacing an old_string with new_string. Uses hash-anchored edit with fuzzy fallback.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path." },
        old_string: { type: "string", description: "Exact old text to replace." },
        new_string: { type: "string", description: "New text to insert." },
        old_hash: { type: "string", description: "Optional SHA-256 hash of old_string for integrity verification." },
      },
      required: ["path", "old_string", "new_string"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args, ctx) {
      if (typeof args.path !== "string" || !args.path) {
        return { content: safeStringify({ error: "path is required" }), isError: true }
      }
      if (typeof args.old_string !== "string") {
        return { content: safeStringify({ error: "old_string is required" }), isError: true }
      }
      if (typeof args.new_string !== "string") {
        return { content: safeStringify({ error: "new_string is required" }), isError: true }
      }

      const path = resolve(ctx.cwd, args.path)
      const oldString = args.old_string
      const newString = args.new_string
      const oldHash = typeof args.old_hash === "string" && args.old_hash ? args.old_hash : undefined

      if (isSensitive(path)) {
        return { content: safeStringify({ error: `Editing sensitive file is denied: ${args.path}` }), isError: true }
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

      const staleCheck = await checkStale(path)
      if (staleCheck.isStale) {
        return { content: safeStringify({ error: staleCheck.message, path: args.path }), isError: true }
      }

      // CRLF normalization: detect original style, normalize to LF for comparison
      const raw = await readFile(path, "utf-8")
      const lineEnding = detectLineEnding(raw)
      const normalizedContent = toLF(raw)
      const normalizedOld = toLF(oldString)
      const normalizedNew = toLF(newString)

      // Try hash-anchored edit on normalized content (in-memory, acceptable for ≤10MB)
      if (normalizedOld) {
        const idx = normalizedContent.indexOf(normalizedOld)
        if (idx >= 0) {
          const result = normalizedContent.slice(0, idx) + normalizedNew + normalizedContent.slice(idx + normalizedOld.length)
          await writeFile(path, restoreLineEndings(result, lineEnding), "utf-8")
          return { content: safeStringify({ path: args.path, replaced: 1, method: "hash_anchored", cwd: ctx.cwd }), isError: false }
        }
      }

      // Fallback: fuzzy replace on normalized content
      const fuzzy = fuzzyReplaceOnce(normalizedContent, normalizedOld, normalizedNew)
      if (!fuzzy) {
        return { content: safeStringify({ error: "old_string not found", path: args.path }), isError: true }
      }
      await writeFile(path, restoreLineEndings(fuzzy.edited, lineEnding), "utf-8")
      return { content: safeStringify({ path: args.path, replaced: fuzzy.replacedCount, method: fuzzy.method, cwd: ctx.cwd }), isError: false }
    },
  }
}

