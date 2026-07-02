import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { LspClient } from "./lsp/lsp-client.js"

interface LspRequestOptions {
  command: string
  args: string[]
  cwd: string
  filePath: string
  language: string
  action: string
  method?: string
  line: number
  column: number
  query?: string
  new_name?: string
  timeoutMs: number
  signal?: AbortSignal
}

export async function runLspRequest(options: LspRequestOptions): Promise<unknown> {
  const client = new LspClient({
    command: options.command,
    args: options.args,
    cwd: options.cwd,
    rootPath: options.cwd,
    language: options.language,
    timeoutMs: options.timeoutMs,
  })

  await client.start()
  await client.initialize()

  try {
    const uri = pathToFileURL(options.filePath).href
    const content = await readFile(options.filePath, "utf8")
    await client.openDocument(options.filePath, options.language, content)

    if (options.action === "diagnostics") {
      await new Promise((resolve) => setTimeout(resolve, Math.min(options.timeoutMs, 750)))
      return client.getDiagnostics(uri)
    }

    if (options.action === "workspace_symbols") {
      return await client.request(options.method!, { query: options.query ?? "" })
    }

    if (options.action === "signature_help") {
      return await client.request(options.method!, {
        textDocument: { uri },
        position: { line: options.line, character: options.column },
      })
    }

    if (options.action === "rename_preview") {
      return await client.request(options.method!, {
        textDocument: { uri },
        position: { line: options.line, character: options.column },
        newName: options.new_name,
      })
    }

    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line: options.line, character: options.column },
    }
    if (options.action === "references") params.context = { includeDeclaration: true }
    return await client.request(options.method!, params)
  } catch (error) {
    const stderr = client.getStderr()
    if (stderr.trim() && error instanceof Error) throw new Error(`${error.message}; server stderr: ${stderr.trim()}`)
    throw error
  } finally {
    await client.shutdown()
  }
}
