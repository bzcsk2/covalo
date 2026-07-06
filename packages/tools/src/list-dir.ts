import { readdir, stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { AgentTool } from "@covalo/protocol"
import { resolvePath, PathContainmentError } from "./resolve-path.js"
import { isSensitive } from "./sensitive.js"
import { safeStringify } from "./safe-stringify.js"

export function createListDirTool(): AgentTool {
  return {
    name: "list_dir",
    description: "List files and directories in a given path. Returns a structured listing with types and sizes.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path to list." },
      },
      required: ["path"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.path !== "string" || !args.path) {
        return { content: safeStringify({ error: "path is required" }), isError: true }
      }

      let dir: string
      try {
        dir = await resolvePath(args.path, ctx.cwd)
      } catch (e) {
        if (e instanceof PathContainmentError) {
          return { content: safeStringify({ error: `path is outside the project directory: ${args.path}` }), isError: true }
        }
        return { content: safeStringify({ error: `cannot resolve path: ${args.path}` }), isError: true }
      }

      // Check with trailing / to match directory-sensitive patterns (.ssh/, .git/)
      if (isSensitive(dir) || isSensitive(dir + "/")) {
        return { content: safeStringify({ error: `Listing sensitive path is denied: ${args.path}` }), isError: true }
      }

      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        return { content: safeStringify({ error: `Directory not found: ${args.path}` }), isError: true }
      }

      const items: Array<{ name: string; type: "file" | "dir" | "unknown"; size?: number }> = []
      for (const name of entries) {
        const full = resolve(dir, name)
        // isSensitive patterns for directories require trailing /, for files do not
        if (isSensitive(full) || isSensitive(full + "/")) continue
        try {
          const st = await stat(full)
          items.push({ name, type: st.isDirectory() ? "dir" : "file", size: st.size })
        } catch {
          items.push({ name, type: "unknown" })
        }
      }

      return {
        content: safeStringify({ path: args.path, items, cwd: ctx.cwd }),
        isError: false,
      }
    },
  }
}
