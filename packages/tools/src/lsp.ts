import type { AgentTool } from "@covalo/core"
import { safeStringify } from "./safe-stringify.js"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { isSensitive } from "./sensitive.js"
import { LspClient } from "./lsp/lsp-client.js"
import { readLspConfig, getLanguageConfig, getRequestTimeout, getInstallHint } from "./lsp/config.js"
import { inferLanguage } from "./lsp/language.js"
import {
  normalizeLocationArray,
  normalizeHover,
  normalizeDiagnostics,
  normalizeCompletion,
  normalizeDocumentSymbols,
  normalizeWorkspaceSymbols,
  normalizeRenameEdit,
  normalizeSignatureHelp,
  formatNormalizedItems,
  normalizeLocation,
} from "./lsp/normalize.js"

type LspAction =
  | "hover"
  | "definition"
  | "declaration"
  | "type_definition"
  | "implementation"
  | "references"
  | "document_symbols"
  | "workspace_symbols"
  | "diagnostics"
  | "completion"
  | "signature_help"
  | "rename_preview"
  | "server_status"
  | "restart_server"
  | "goToDefinition"
  | "findReferences"
  | "goToImplementation"
  | "documentSymbol"
  | "workspaceSymbol"

const ACTION_METHODS: Record<string, string> = {
  hover: "textDocument/hover",
  definition: "textDocument/definition",
  goToDefinition: "textDocument/definition",
  declaration: "textDocument/declaration",
  type_definition: "textDocument/typeDefinition",
  implementation: "textDocument/implementation",
  goToImplementation: "textDocument/implementation",
  references: "textDocument/references",
  findReferences: "textDocument/references",
  document_symbols: "textDocument/documentSymbol",
  documentSymbol: "textDocument/documentSymbol",
  workspace_symbols: "workspace/symbol",
  workspaceSymbol: "workspace/symbol",
  completion: "textDocument/completion",
  signature_help: "textDocument/signatureHelp",
  rename_preview: "textDocument/rename",
}

const ALIAS_MAP: Record<string, LspAction> = {
  goToDefinition: "definition",
  findReferences: "references",
  goToImplementation: "implementation",
  documentSymbol: "document_symbols",
  workspaceSymbol: "workspace_symbols",
}

const VALID_ACTIONS: LspAction[] = [
  "hover", "definition", "declaration", "type_definition",
  "implementation", "references", "document_symbols",
  "workspace_symbols", "diagnostics", "completion",
  "signature_help", "rename_preview", "server_status", "restart_server",
  "goToDefinition", "findReferences", "goToImplementation",
  "documentSymbol", "workspaceSymbol",
]

export function createLspTool(): AgentTool {
  return {
    name: "LSP",
    description: "Query a configured Language Server Protocol process for definitions, references, hover info, diagnostics, completion, and more. Configure servers in .covalo/lsp.json.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: VALID_ACTIONS,
          description: "LSP action to perform.",
        },
        file_path: { type: "string", description: "Path to the source file." },
        line: { type: "number", description: "Line number (0-indexed)." },
        column: { type: "number", description: "Column number (0-indexed)." },
        query: { type: "string", description: "Query string for workspace_symbols." },
        new_name: { type: "string", description: "New name for rename_preview." },
        language: { type: "string", description: "Language identifier. Inferred from extension when omitted." },
        timeout_ms: { type: "number", description: "Request timeout in milliseconds. Defaults to 8000." },
        max_results: { type: "number", description: "Maximum number of results. Defaults to 50." },
        include_raw: { type: "boolean", description: "Include raw server response. Defaults to false." },
      },
      required: ["action", "file_path"],
    },
    concurrency: "exclusive",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.action !== "string") {
        return { content: safeStringify({ error: "action is required" }), isError: true }
      }
      if (!VALID_ACTIONS.includes(args.action as LspAction)) {
        return { content: safeStringify({ error: `Unsupported LSP action: ${args.action}` }), isError: true }
      }
      const rawAction = args.action as LspAction
      const action = ALIAS_MAP[rawAction] ?? rawAction

      if (action === "server_status") {
        return { content: safeStringify({ status: "ok", action: "server_status", message: "LSP manager not yet implemented" }), isError: false }
      }
      if (action === "restart_server") {
        return { content: safeStringify({ status: "ok", action: "restart_server", message: "LSP manager not yet implemented" }), isError: false }
      }

      if (typeof args.file_path !== "string") {
        return { content: safeStringify({ error: "file_path is required" }), isError: true }
      }

      const filePath = resolve(ctx.cwd, args.file_path)
      if (isSensitive(filePath)) {
        return { content: safeStringify({ error: `Access to sensitive file is denied: ${args.file_path}` }), isError: true }
      }
      if (!existsSync(filePath)) {
        return { content: safeStringify({ error: `File not found: ${filePath}` }), isError: true }
      }

      const language = typeof args.language === "string" && args.language.trim()
        ? args.language.trim()
        : inferLanguage(filePath)
      if (!language) {
        return { content: safeStringify({ error: `Cannot infer language for: ${args.file_path}` }), isError: true }
      }

      const { config } = await readLspConfig(ctx.cwd)
      const server = getLanguageConfig(config, language)
      if (!server?.command) {
        const hint = getInstallHint(language)
        return {
          content: safeStringify({
            status: "error",
            errorType: "server_not_configured",
            message: `No LSP server configured for language "${language}".`,
            installHint: hint,
            action,
            language,
          }),
          isError: true,
        }
      }

      if (action === "workspace_symbols" && typeof args.query !== "string") {
        return { content: safeStringify({ error: "query is required for workspace_symbols" }), isError: true }
      }

      if (action === "rename_preview") {
        if (typeof args.new_name !== "string" || !args.new_name) {
          return { content: safeStringify({ error: "new_name is required for rename_preview" }), isError: true }
        }
        if (typeof args.line !== "number" || typeof args.column !== "number") {
          return { content: safeStringify({ error: "line and column are required for rename_preview" }), isError: true }
        }
      }

      const timeoutMs = typeof args.timeout_ms === "number"
        ? Math.max(1000, Math.min(30000, Math.floor(args.timeout_ms)))
        : getRequestTimeout(config)

      try {
        // LSP-3: 直接使用 LspClient，不再经过 lsp-client.ts 包装器（已删除）。
        // 逻辑等价于原 runLspRequest：start → initialize → 单次请求 → shutdown。
        const client = new LspClient({
          command: server.command,
          args: server.args ?? [],
          cwd: ctx.cwd,
          rootPath: ctx.cwd,
          language,
          timeoutMs,
        })

        let result: unknown
        try {
          // 把 start/initialize 也纳入 try/finally：若 initialize() 抛错
          // （timeout/协议错误），立即 shutdown 而非等 watchdog 30s 后清理。
          await client.start()
          await client.initialize()

          const uri = pathToFileURL(filePath).href
          const content = await readFile(filePath, "utf8")
          await client.openDocument(filePath, language, content)

          if (action === "diagnostics") {
            await new Promise((resolve) => setTimeout(resolve, Math.min(timeoutMs, 750)))
            result = client.getDiagnostics(uri)
          } else if (action === "workspace_symbols") {
            result = await client.request(ACTION_METHODS[action], { query: typeof args.query === "string" ? args.query : "" })
          } else if (action === "signature_help") {
            result = await client.request(ACTION_METHODS[action], {
              textDocument: { uri },
              position: { line: numberOrZero(args.line), character: numberOrZero(args.column) },
            })
          } else if (action === "rename_preview") {
            result = await client.request(ACTION_METHODS[action], {
              textDocument: { uri },
              position: { line: numberOrZero(args.line), character: numberOrZero(args.column) },
              newName: typeof args.new_name === "string" ? args.new_name : "",
            })
          } else {
            const params: Record<string, unknown> = {
              textDocument: { uri },
              position: { line: numberOrZero(args.line), character: numberOrZero(args.column) },
            }
            if (action === "references") params.context = { includeDeclaration: true }
            result = await client.request(ACTION_METHODS[action], params)
          }
        } catch (error) {
          const stderr = client.getStderr()
          if (stderr.trim() && error instanceof Error) throw new Error(`${error.message}; server stderr: ${stderr.trim()}`)
          throw error
        } finally {
          // shutdown 失败时降级为 kill，确保子进程被回收
          await client.shutdown().catch(() => client.kill())
        }

        const normalized = normalizeResult(action, result)
        const response: Record<string, unknown> = {
          status: "ok",
          action,
          language,
          file: filePath,
        }

        if (normalized !== null) {
          response.items = normalized
          response.summary = formatNormalizedItems(normalized)
        }

        if (args.include_raw === true) {
          response.raw = result
        }

        return { content: safeStringify(response), isError: false }
      } catch (e) {
        return {
          content: safeStringify({
            status: "error",
            errorType: "request_failed",
            message: `LSP request failed: ${e instanceof Error ? e.message : String(e)}`,
            action,
            language,
          }),
          isError: true,
        }
      }
    },
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function normalizeResult(action: string, raw: unknown): import("./lsp/normalize.js").NormalizedItem[] | null {
  if (raw === null || raw === undefined) return null

  switch (action) {
    case "hover": {
      const hover = normalizeHover(raw)
      return hover ? [hover] : null
    }
    case "definition":
    case "declaration":
    case "type_definition":
    case "implementation":
    case "references":
      return normalizeLocationArray(raw)
    case "document_symbols":
      return normalizeDocumentSymbols(raw)
    case "workspace_symbols":
      return normalizeWorkspaceSymbols(raw)
    case "diagnostics":
      return normalizeDiagnostics(raw)
    case "completion":
      return normalizeCompletion(raw)
    case "signature_help": {
      const sig = normalizeSignatureHelp(raw)
      return sig ? [sig] : null
    }
    case "rename_preview": {
      const edit = normalizeRenameEdit(raw)
      return edit ? [edit] : null
    }
    default:
      return null
  }
}
