import { resolve } from "node:path"
import type { AgentTool } from "@covalo/protocol"
import { resolvePath, PathContainmentError } from "./resolve-path.js"
import { isSensitive } from "./sensitive.js"
import { safeStringify } from "./safe-stringify.js"
import fg from "fast-glob"

const MAX_RESULTS = 100

export function createGlobTool(): AgentTool {
  return {
    name: "glob",
    description: "Fast file pattern matching tool. Finds files and directories matching a glob pattern.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern to match files against (e.g. '**/*.ts', 'src/**/*.tsx')." },
        path: { type: "string", description: "The directory to search in (optional, defaults to working directory)." },
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
            return { content: safeStringify({ error: "path is outside the project directory" }), isError: true }
          }
          return { content: safeStringify({ error: `cannot resolve path: ${args.path}` }), isError: true }
        }
      } else {
        searchPath = ctx.cwd
      }
      const pattern = args.pattern

      if (isSensitive(searchPath) || isSensitive(searchPath + "/")) {
        return { content: safeStringify({ error: `Globbing sensitive path is denied: ${args.path ?? ctx.cwd}` }), isError: true }
      }

      const t0 = Date.now()
      try {
        const results = await fg(pattern, {
          cwd: searchPath,
          absolute: false,
          dot: true,
          suppressErrors: true,
        })
        const filtered = results.filter((f) => !isSensitive(resolve(searchPath, f).replace(/\\/g, "/")))
        const elapsed = Date.now() - t0
        return {
          content: safeStringify({
            numFiles: Math.min(filtered.length, MAX_RESULTS),
            filenames: filtered.slice(0, MAX_RESULTS),
            truncated: filtered.length > MAX_RESULTS,
            durationMs: elapsed,
          }),
          isError: false,
        }
      } catch (e) {
        return {
          content: safeStringify({ error: `Glob error: ${e instanceof Error ? e.message : String(e)}` }),
          isError: true,
        }
      }
    },
  }
}
