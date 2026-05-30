import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import { readFile } from "node:fs/promises"

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
  id: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class McpClient {
  private proc: ChildProcess | null = null
  private buffer = ""
  private pending = new Map<string | number, { resolve: (v: JsonRpcResponse) => void; reject: (e: Error) => void }>()
  private msgId = 0
  private _connected = false
  private name: string

  constructor(name: string) {
    this.name = name
  }

  get connected(): boolean { return this._connected }

  get serverName(): string { return this.name }

  async connect(command: string, args: string[] = [], env?: Record<string, string>): Promise<void> {
    if (this._connected) return

    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    })

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString()
      this.processLines()
    })

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      // MCP servers often log to stderr; ignore by default
    })

    this.proc.on("exit", (code) => {
      this._connected = false
      for (const [, handler] of this.pending) {
        handler.reject(new Error(`MCP server exited with code ${code}`))
      }
      this.pending.clear()
    })

    this.proc.on("error", (err) => {
      this._connected = false
      for (const [, handler] of this.pending) {
        handler.reject(err)
      }
      this.pending.clear()
    })

    // Send initialize
    const result = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "deepicode", version: "0.1.0" },
    })

    const initResult = result as { protocolVersion?: string; capabilities?: Record<string, unknown>; serverInfo?: Record<string, unknown> }
    if (initResult?.protocolVersion) {
      await this.request("notifications/initialized", {})
    }

    this._connected = true
  }

  async disconnect(): Promise<void> {
    if (!this._connected || !this.proc) return
    try { this.proc.kill("SIGTERM") } catch {}
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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.proc?.stdin?.write(JSON.stringify(msg) + "\n")
    })
  }

  private processLines(): void {
    const lines = this.buffer.split("\n")
    this.buffer = lines.pop() ?? "" // keep partial line
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const resp = JSON.parse(line) as JsonRpcResponse
        const handler = this.pending.get(resp.id)
        if (handler) {
          this.pending.delete(resp.id)
          if (resp.error) {
            handler.reject(new Error(`MCP error ${resp.error.code}: ${resp.error.message}`))
          } else {
            handler.resolve(resp)
          }
        }
      } catch {
        // malformed JSON line, ignore
      }
    }
  }
}
