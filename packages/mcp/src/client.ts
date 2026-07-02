import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"
import { terminateProcessTree, normalizePlatform } from "@covalo/tools"
import type { DiagnosticLogger } from "./diagnostics.js"
import { noopDiagnosticLogger } from "./diagnostics.js"
import { EventEmitter } from "node:events"

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpResource {
  uri: string
  name: string
  description?: string
  mimeType?: string
}

export interface McpPrompt {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id: string | number
  method: string
  params?: Record<string, unknown>
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id?: string | number  // undefined for notifications
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}

const REQUEST_TIMEOUT = 30_000

function rejectAllPending(pending: Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>, err: Error): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer)
    entry.reject(err)
  }
  pending.clear()
}

export class McpClient extends EventEmitter {
  private proc: ChildProcess | null = null
  private buffer = ""
  private pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private msgId = 0
  private _connected = false
  private name: string
  private logger: DiagnosticLogger
  private platform: ReturnType<typeof normalizePlatform>

  constructor(name: string, logger: DiagnosticLogger = noopDiagnosticLogger) {
    super()
    this.name = name
    this.logger = logger
    this.platform = normalizePlatform()
  }

  get connected(): boolean { return this._connected }

  get serverName(): string { return this.name }

  async connect(command: string, args: string[] = [], env?: Record<string, string>): Promise<void> {
    if (this._connected) return

    const startedAt = this.logger.isEnabled("info") ? Date.now() : 0

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
      detached: this.platform !== "win32",
    })

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString()
      this.processLines()
    })

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      if (this.logger.isEnabled("debug")) {
        const snippet = chunk.toString().slice(0, 200)
        this.logger.debug("mcp.stderr", { mcpServer: this.name, length: chunk.length, snippet })
      }
    })

    this.proc.on("exit", (code) => {
      this._connected = false
      this.flushBuffer()
      rejectAllPending(this.pending, new Error(`MCP server exited with code ${code}`))
    })

    this.proc.on("error", (err) => {
      this._connected = false
      rejectAllPending(this.pending, err)
    })

    // Send initialize
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "covalo", version: "0.1.0" },
    }).catch((err) => {
      // initialize failed — clean up before rethrowing
      if (this.proc) terminateProcessTree(this.proc, false, this.platform)
      rejectAllPending(this.pending, err)
      this.proc = null
      this._connected = false
      throw err
    })

    const initResult = result as { protocolVersion?: string; capabilities?: Record<string, unknown>; serverInfo?: Record<string, unknown> }
    if (!initResult?.protocolVersion) {
      if (this.proc) terminateProcessTree(this.proc, false, this.platform)
      rejectAllPending(this.pending, new Error("MCP initialize failed: no protocolVersion in response"))
      this.proc = null
      this._connected = false
      throw new Error("MCP initialize failed: no protocolVersion in response")
    }
    try {
      this.proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n")
    } catch {
      // notification write failure is non-fatal
    }
    this._connected = true
  }

  async disconnect(): Promise<void> {
    // Even if !_connected, clean up if proc exists
    if (!this.proc) return
    rejectAllPending(this.pending, new Error("MCP client disconnected"))
    try {
      if (this.proc) terminateProcessTree(this.proc, false, this.platform)
      await new Promise<void>(resolve => {
        const t = setTimeout(() => { if (this.proc) terminateProcessTree(this.proc, true, this.platform); resolve() }, 5000)
        this.proc?.once("exit", () => { clearTimeout(t); resolve() })
      })
    } catch {}
    this.proc = null
    this._connected = false
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request("tools/list", {}) as { tools?: McpTool[] }
    return result?.tools ?? []
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args })
  }

  async listResources(): Promise<McpResource[]> {
    const result = await this.request("resources/list", {}) as { resources?: McpResource[] }
    return result?.resources ?? []
  }

  async readResource(uri: string): Promise<unknown> {
    return this.request("resources/read", { uri })
  }

  async listPrompts(): Promise<McpPrompt[]> {
    const result = await this.request("prompts/list", {}) as { prompts?: McpPrompt[] }
    return result?.prompts ?? []
  }

  private async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.msgId
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params }
    const startedAt = this.logger.isEnabled("debug") ? Date.now() : 0

    // Check process and stdin are alive before sending
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) {
      const err = new Error(`MCP request failed: ${this.name} not connected or stdin not writable`)
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("mcp.request.fail", { mcpServer: this.name, method, error: err.message })
      }
      throw err
    }

    if (this.logger.isEnabled("debug")) {
      this.logger.debug("mcp.request.start", { mcpServer: this.name, method, requestId: id })
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        if (this.logger.isEnabled("warn")) {
          this.logger.warn("mcp.request.timeout", { mcpServer: this.name, method, timeoutMs: REQUEST_TIMEOUT })
        }
        reject(new Error(`MCP request timed out after ${REQUEST_TIMEOUT}ms: ${method}`))
      }, REQUEST_TIMEOUT)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.proc!.stdin!.write(JSON.stringify(msg) + "\n", (err: Error | null | undefined) => {
          if (err) {
            this.pending.delete(id)
            clearTimeout(timer)
            reject(new Error(`MCP request write failed: ${err.message}`))
          }
        })
      } catch (writeErr) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`MCP request write failed: ${(writeErr as Error).message}`))
      }
    }).finally(() => {
      if (this.logger.isEnabled("debug")) {
        this.logger.debug("mcp.request.done", { mcpServer: this.name, method, durationMs: Date.now() - startedAt })
      }
    })
  }

  private processLines(): void {
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? ""
    for (const line of lines) {
      this.processMessageLine(line)
    }
  }

  private processMessageLine(line: string): void {
    if (!line.trim()) return
    try {
      const resp = JSON.parse(line) as JsonRpcResponse

      // C3: Handle JSON-RPC notifications (no id, has method)
      if (resp.id === undefined && typeof (resp as unknown as JsonRpcNotification).method === "string") {
        const notification = resp as unknown as JsonRpcNotification
        this.handleNotification(notification.method, notification.params)
        return
      }

      // C4: response with undefined id that is not a notification — skip
      if (resp.id === undefined) return

      const handler = this.pending.get(resp.id)
      if (handler) {
        clearTimeout(handler.timer)
        this.pending.delete(resp.id)
        if (resp.error) {
          if (this.logger.isEnabled("warn")) {
            this.logger.warn("mcp.request.error", { mcpServer: this.name, method: resp.id, errorClass: "JsonRpcError" })
          }
          handler.reject(new Error(`MCP error ${resp.error.code}: ${resp.error.message}`))
        } else {
          handler.resolve(resp.result)
        }
      }
    } catch {
      if (this.logger.isEnabled("debug")) {
        this.logger.debug("mcp.parse.error", { mcpServer: this.name, length: line.length })
      }
    }
  }

  /**
   * Handle a JSON-RPC notification by emitting an event.
   */
  private handleNotification(method: string, params: unknown): void {
    if (this.logger.isEnabled("debug")) {
      this.logger.debug("mcp.notification", { mcpServer: this.name, method })
    }
    this.emit("notification", { method, params })
    this.emit(method, params)
  }

  /**
   * Flush any remaining data in the buffer (for messages without trailing newline).
   */
  private flushBuffer(): void {
    if (this.buffer.trim()) {
      try {
        JSON.parse(this.buffer)
        this.processMessageLine(this.buffer)
      } catch {
        if (this.logger.isEnabled("debug")) {
          this.logger.debug("mcp.flush.incomplete", { mcpServer: this.name, length: this.buffer.length })
        }
      }
      this.buffer = ""
    }
  }
}
