import { resolve } from "node:path"
import { realpathSync } from "node:fs"
import type { AgentTool } from "../../core/src/interface.js"
import { safeStringify } from "./safe-stringify.js"

const MAX_RESULTS = 100
const DEFAULT_PATH = process.cwd()

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
      const searchPath = typeof args.path === "string" ? resolve(ctx.cwd, args.path) : ctx.cwd
      // Validate path is within project directory
      try {
        const realSearch = realpathSync(searchPath)
        const realBase = realpathSync(ctx.cwd)
        if (!realSearch.startsWith(realBase + "/") && realSearch !== realBase) {
          return { content: safeStringify({ error: "path is outside the project directory" }), isError: true }
        }
      } catch {
        return { content: safeStringify({ error: `cannot resolve path: ${searchPath}` }), isError: true }
      }
      const pattern = args.pattern

      const t0 = Date.now()
      try {
        const { Glob } = await import("bun")
        const glob = new Glob(pattern)
        const results: string[] = []
        for await (const entry of glob.scan({ cwd: searchPath, absolute: false })) {
          results.push(entry)
          if (results.length >= MAX_RESULTS) break
        }
        const elapsed = Date.now() - t0
        return {
          content: safeStringify({
            numFiles: results.length,
            filenames: results,
            truncated: results.length >= MAX_RESULTS,
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
