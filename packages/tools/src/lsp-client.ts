import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

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
  timeoutMs: number
  signal?: AbortSignal
}

export async function runLspRequest(options: LspRequestOptions): Promise<unknown> {
  const child = spawn(options.command, options.args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"] })
  let nextId = 1
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let stderr = ""
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const diagnostics: unknown[] = []

  child.stderr.on("data", chunk => { stderr += String(chunk) })
  child.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)])
    buffer = consumeMessages(buffer, message => {
      if (typeof message.id === "number") {
        const request = pending.get(message.id)
        if (!request) return
        pending.delete(message.id)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
      } else if (message.method === "textDocument/publishDiagnostics") {
        diagnostics.push(message.params)
      }
    })
  })

  const abort = () => child.kill()
  options.signal?.addEventListener("abort", abort, { once: true })
  try {
    const request = (method: string, params: unknown): Promise<unknown> => {
      const id = nextId++
      send(child.stdin, { jsonrpc: "2.0", id, method, params })
      return withTimeout(new Promise((resolve, reject) => pending.set(id, { resolve, reject })), options.timeoutMs, () => {
        pending.delete(id)
        child.kill()
      })
    }
    const notify = (method: string, params: unknown) => send(child.stdin, { jsonrpc: "2.0", method, params })
    const rootUri = pathToFileURL(options.cwd).href
    await request("initialize", { processId: process.pid, rootUri, capabilities: {} })
    notify("initialized", {})

    const uri = pathToFileURL(options.filePath).href
    notify("textDocument/didOpen", {
      textDocument: { uri, languageId: options.language, version: 1, text: await readFile(options.filePath, "utf8") },
    })

    if (options.action === "diagnostics") {
      await delay(Math.min(options.timeoutMs, 750), options.signal)
      return diagnostics
    }

    const params: Record<string, unknown> = { textDocument: { uri }, position: { line: options.line, character: options.column } }
    if (options.action === "references") params.context = { includeDeclaration: true }
    return await request(options.method!, params)
  } catch (error) {
    if (stderr.trim() && error instanceof Error) throw new Error(`${error.message}; server stderr: ${stderr.trim()}`)
    throw error
  } finally {
    options.signal?.removeEventListener("abort", abort)
    child.kill()
  }
}

function send(stdin: NodeJS.WritableStream, message: unknown): void {
  const payload = JSON.stringify(message)
  stdin.write(`Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`)
}

function consumeMessages(buffer: Buffer<ArrayBufferLike>, handle: (message: Record<string, any>) => void): Buffer<ArrayBufferLike> {
  while (true) {
    const boundary = buffer.indexOf("\r\n\r\n")
    if (boundary < 0) return buffer
    const header = buffer.subarray(0, boundary).toString("ascii")
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) return Buffer.alloc(0)
    const length = Number(match[1])
    const end = boundary + 4 + length
    if (buffer.length < end) return buffer
    try { handle(JSON.parse(buffer.subarray(boundary + 4, end).toString("utf8"))) } catch {}
    buffer = buffer.subarray(end)
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout(); reject(new Error(`Timed out after ${timeoutMs}ms`)) }, timeoutMs)
    promise.then(value => { clearTimeout(timer); resolve(value) }, error => { clearTimeout(timer); reject(error) })
  })
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("Aborted")) }, { once: true })
  })
}
