import { writeFile as fsWriteFile, mkdir, stat } from "node:fs/promises"
import { dirname } from "node:path"
import type { AgentTool } from "@covalo/protocol"
import { resolvePath, PathContainmentError } from "./resolve-path.js"
import { checkStale } from "./stale-read.js"
import { isWriteProtected } from "./sensitive.js"
import { safeStringify } from "./safe-stringify.js"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10 MB

export function createWriteFileTool(): AgentTool {
  return {
    name: "write_file",
    description: "Create a new file with content. Will overwrite if file already exists.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to create." },
        content: { type: "string", description: "File content." },
      },
      required: ["path", "content"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args, ctx) {
      if (typeof args.path !== "string" || !args.path) {
        return { content: safeStringify({ error: "path is required" }), isError: true }
      }
      if (typeof args.content !== "string") {
        return { content: safeStringify({ error: "content is required" }), isError: true }
      }

      if (args.content.length > MAX_FILE_SIZE) {
        return { content: safeStringify({ error: `Content too large (${args.content.length} bytes). Max allowed: ${MAX_FILE_SIZE} bytes.` }), isError: true }
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

      if (isWriteProtected(path)) {
        return { content: safeStringify({ error: `Writing to protected file is denied: ${args.path}` }), isError: true }
      }

      // Stale-write check for existing files
      let exists = false
      try {
        await stat(path)
        exists = true
      } catch { /* new file */ }

      if (exists) {
        const staleCheck = await checkStale(path)
        if (staleCheck.isStale) {
          return { content: safeStringify({ error: staleCheck.message, path: args.path }), isError: true }
        }
      }

      await mkdir(dirname(path), { recursive: true })
      await fsWriteFile(path, args.content, "utf-8")
      return { content: safeStringify({ path: args.path, size: args.content.length, cwd: ctx.cwd }), isError: false }
    },
  }
}
