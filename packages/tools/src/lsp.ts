import type { AgentTool } from "../../core/src/interface.js"
import { safeStringify } from "./safe-stringify.js"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { isSensitive } from "./sensitive.js"
import { runLspRequest } from "./lsp-client.js"

const ACTION_METHODS: Record<string, string> = {
  definition: "textDocument/definition",
  references: "textDocument/references",
  hover: "textDocument/hover",
  completion: "textDocument/completion",
}

export function createLspTool(): AgentTool {
  return {
    name: "LSP",
    description: "Query a configured Language Server Protocol process for definitions, references, hover info, diagnostics, or completion. Configure servers in .deepicode/lsp.json.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["definition", "references", "hover", "diagnostics", "completion"], description: "LSP action to perform." },
        file_path: { type: "string", description: "Path to the source file." },
        line: { type: "number", description: "Line number (0-indexed)." },
        column: { type: "number", description: "Column number (0-indexed)." },
        language: { type: "string", description: "Language identifier. Inferred from extension when omitted." },
        timeout_ms: { type: "number", description: "Request timeout in milliseconds. Defaults to 5000." },
      },
      required: ["action", "file_path"],
    },
    concurrency: "exclusive",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.action !== "string" || typeof args.file_path !== "string") {
        return { content: safeStringify({ error: "action and file_path are required" }), isError: true }
      }
      if (args.action !== "diagnostics" && !ACTION_METHODS[args.action]) {
        return { content: safeStringify({ error: `Unsupported LSP action: ${args.action}` }), isError: true }
      }
      const filePath = resolve(ctx.cwd, args.file_path)
      if (isSensitive(filePath)) return { content: safeStringify({ error: `Access to sensitive file is denied: ${args.file_path}` }), isError: true }
      if (!existsSync(filePath)) return { content: safeStringify({ error: `File not found: ${filePath}` }), isError: true }

      const language = typeof args.language === "string" && args.language.trim()
        ? args.language.trim()
        : inferLanguage(filePath)
      if (!language) return { content: safeStringify({ error: `Cannot infer language for: ${args.file_path}` }), isError: true }

      const config = await readLspConfig(ctx.cwd)
      const server = config.languages?.[language]
      if (!server?.command) {
        return { content: safeStringify({ error: `No LSP server configured for language "${language}". Add it to .deepicode/lsp.json.` }), isError: true }
      }

      try {
        const result = await runLspRequest({
          command: server.command,
          args: server.args ?? [],
          cwd: ctx.cwd,
          filePath,
          language,
          action: args.action,
          method: ACTION_METHODS[args.action],
          line: numberOrZero(args.line),
          column: numberOrZero(args.column),
          timeoutMs: typeof args.timeout_ms === "number" ? Math.max(100, Math.floor(args.timeout_ms)) : 5000,
          signal: ctx.signal,
        })
        return { content: safeStringify({ status: "ok", action: args.action, file: filePath, language, result }), isError: false }
      } catch (e) {
        return { content: safeStringify({ error: `LSP request failed: ${e instanceof Error ? e.message : String(e)}` }), isError: true }
      }
    },
  }
}

interface LspConfig {
  languages?: Record<string, { command: string; args?: string[] }>
}

async function readLspConfig(cwd: string): Promise<LspConfig> {
  try { return JSON.parse(await readFile(resolve(cwd, ".deepicode", "lsp.json"), "utf8")) as LspConfig } catch { return {} }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function inferLanguage(filePath: string): string {
  return ({
    ".ts": "typescript", ".tsx": "typescriptreact",
    ".js": "javascript", ".jsx": "javascriptreact",
    ".py": "python", ".go": "go", ".rs": "rust",
    ".json": "json", ".css": "css", ".html": "html",
  } as Record<string, string>)[extname(filePath)] ?? ""
}
