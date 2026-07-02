import { spawn, type ChildProcess } from "node:child_process"
import { pathToFileURL } from "node:url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, type MessageConnection } from "vscode-jsonrpc/node"
import { terminateProcessTree } from "../platform/process-tree.js"
import { normalizePlatform } from "../platform/capabilities.js"
import type { SupportedPlatform } from "../platform/shell-backend.js"

const INITIALIZE_TIMEOUT_MS = 10000
const SHUTDOWN_TIMEOUT_MS = 5000

export type LspServerState =
  | "idle"
  | "starting"
  | "running"
  | "shutdown"
  | "stopped"
  | "unhealthy"

export interface LspClientOptions {
  command: string
  args: string[]
  cwd: string
  rootPath: string
  language: string
  initializationOptions?: Record<string, unknown>
  settings?: Record<string, unknown>
  timeoutMs?: number
}

export interface LspClientHealth {
  state: LspServerState
  language: string
  pid: number | undefined
  uptimeMs: number
  pendingRequests: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class LspClient {
  private child: ChildProcess | null = null
  private connection: MessageConnection | null = null
  private platform: SupportedPlatform
  private state: LspServerState = "idle"
  private options: LspClientOptions
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private diagnostics = new Map<string, unknown[]>()
  private startedAt = 0
  private stderr = ""
  private serverCapabilities: Record<string, unknown> = {}
  private diagnosticRegistrations = new Map<string, { id: string; method: string }>()
  private initializationOptions: Record<string, unknown> = {}

  constructor(options: LspClientOptions) {
    this.options = options
    this.platform = normalizePlatform()
  }

  getState(): LspServerState {
    return this.state
  }

  getLanguage(): string {
    return this.options.language
  }

  getPid(): number | undefined {
    return this.child?.pid
  }

  async start(): Promise<void> {
    if (this.state === "running" || this.state === "starting") {
      return
    }

    this.state = "starting"
    this.startedAt = Date.now()
    this.stderr = ""

    try {
      this.child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        detached: this.platform !== "win32",
      })

      this.child.stderr?.on("data", (chunk: Buffer) => {
        this.stderr += String(chunk)
      })

      this.child.on("exit", (code, signal) => {
        this.handleExit(code, signal)
      })

      this.child.on("error", (error) => {
        this.handleError(error)
      })

      this.connection = createMessageConnection(
        new StreamMessageReader(this.child.stdout!),
        new StreamMessageWriter(this.child.stdin!),
      )

      this.setupConnectionHandlers()
      this.connection.listen()
    } catch (error) {
      this.state = "unhealthy"
      throw error
    }
  }

  private setupConnectionHandlers(): void {
    if (!this.connection) return

    this.connection.onNotification("textDocument/publishDiagnostics", (params) => {
      const uri = (params as { uri?: string }).uri
      if (uri) {
        this.diagnostics.set(uri, (params as { diagnostics?: unknown[] }).diagnostics ?? [])
      }
    })

    this.connection.onRequest("workspace/configuration", (params) => {
      const items = (params as { items?: { section?: string }[] }).items ?? []
      return items.map((item) => this.getConfigurationValue(item.section))
    })

    this.connection.onRequest("workspace/workspaceFolders", () => [
      {
        name: "workspace",
        uri: pathToFileURL(this.options.rootPath).href,
      },
    ])

    this.connection.onRequest("client/registerCapability", (params) => {
      const registrations = (params as { registrations?: { id: string; method: string }[] }).registrations ?? []
      for (const registration of registrations) {
        this.diagnosticRegistrations.set(registration.id, registration)
      }
    })

    this.connection.onRequest("client/unregisterCapability", (params) => {
      const registrations = (params as { unregisterations?: { id: string; method: string }[] }).unregisterations ?? []
      for (const registration of registrations) {
        this.diagnosticRegistrations.delete(registration.id)
      }
    })

    this.connection.onRequest("window/workDoneProgress/create", () => null)
    this.connection.onRequest("workspace/diagnostic/refresh", () => null)
  }

  private getConfigurationValue(section?: string): unknown {
    if (!section) return this.options.settings ?? null
    return section.split(".").reduce<unknown>((acc, key) => {
      if (!acc || typeof acc !== "object" || !(key in acc)) return undefined
      return (acc as Record<string, unknown>)[key]
    }, this.options.settings) ?? null
  }

  async initialize(): Promise<Record<string, unknown>> {
    if (!this.connection) {
      throw new Error("LSP client not started")
    }

    const rootUri = pathToFileURL(this.options.rootPath).href
    const result = await this.sendRequest<{ capabilities?: Record<string, unknown> }>("initialize", {
      processId: process.pid,
      rootUri,
      workspaceFolders: [
        {
          name: "workspace",
          uri: rootUri,
        },
      ],
      initializationOptions: this.options.initializationOptions,
      capabilities: {
        window: {
          workDoneProgress: true,
        },
        workspace: {
          configuration: true,
          didChangeWatchedFiles: {
            dynamicRegistration: true,
          },
          diagnostics: {
            refreshSupport: false,
          },
        },
        textDocument: {
          synchronization: {
            didOpen: true,
            didChange: true,
          },
          diagnostic: {
            dynamicRegistration: true,
            relatedDocumentSupport: true,
          },
          publishDiagnostics: {
            versionSupport: false,
          },
        },
      },
    }, INITIALIZE_TIMEOUT_MS)

    this.serverCapabilities = result?.capabilities ?? {}
    this.state = "running"
    await this.connection.sendNotification("initialized", {})

    if (this.options.settings) {
      await this.connection.sendNotification("workspace/didChangeConfiguration", {
        settings: this.options.settings,
      })
    }

    return this.serverCapabilities
  }

  async request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.connection || this.state !== "running") {
      throw new Error(`LSP client not ready (state: ${this.state})`)
    }
    return this.sendRequest(method, params, timeoutMs ?? this.options.timeoutMs)
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (!this.connection || this.state !== "running") {
      throw new Error(`LSP client not ready (state: ${this.state})`)
    }
    await this.connection.sendNotification(method, params)
  }

  private async sendRequest<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    if (!this.connection) {
      throw new Error("No connection")
    }

    return new Promise<T>((resolve, reject) => {
      const timeout = timeoutMs ?? this.options.timeoutMs ?? INITIALIZE_TIMEOUT_MS
      let settled = false
      const id = this.nextId++
      let timer: ReturnType<typeof setTimeout> | undefined

      const pendingEntry: PendingRequest = {
        resolve: (value: unknown) => {
          if (!settled) {
            settled = true
            if (timer) clearTimeout(timer)
            this.pending.delete(id)
            resolve(value as T)
          }
        },
        reject: (error: Error) => {
          if (!settled) {
            settled = true
            if (timer) clearTimeout(timer)
            this.pending.delete(id)
            reject(error)
          }
        },
      }
      this.pending.set(id, pendingEntry)

      timer = setTimeout(() => {
        this.pending.delete(id)
        if (!settled) {
          settled = true
          reject(new Error(`Request ${method} timed out after ${timeout}ms`))
        }
      }, timeout)

      this.connection!.sendRequest(method, params).then(
        (result) => pendingEntry.resolve(result),
        (error) => pendingEntry.reject(error instanceof Error ? error : new Error(String(error))),
      )
    })
  }

  async openDocument(filePath: string, languageId: string, content: string): Promise<void> {
    const uri = pathToFileURL(filePath).href
    await this.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text: content,
      },
    })
  }

  async changeDocument(filePath: string, version: number, content: string): Promise<void> {
    const uri = pathToFileURL(filePath).href
    await this.notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    })
  }

  async closeDocument(filePath: string): Promise<void> {
    const uri = pathToFileURL(filePath).href
    await this.notify("textDocument/didClose", {
      textDocument: { uri },
    })
  }

  getDiagnostics(uri: string): unknown[] {
    return this.diagnostics.get(uri) ?? []
  }

  hasStaticDiagnostics(): boolean {
    return Boolean(this.serverCapabilities.diagnosticProvider)
  }

  getServerCapabilities(): Record<string, unknown> {
    return this.serverCapabilities
  }

  async shutdown(): Promise<void> {
    if (this.state === "stopped" || this.state === "shutdown") {
      return
    }

    this.state = "shutdown"

    try {
      if (this.connection) {
        await Promise.race([
          this.connection.sendRequest("shutdown"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("Shutdown timeout")), SHUTDOWN_TIMEOUT_MS)),
        ])
        await this.connection.sendNotification("exit")
      }
    } catch {
      // Ignore shutdown errors
    } finally {
      this.kill()
    }
  }

  kill(): void {
    if (this.child) {
      terminateProcessTree(this.child, true, this.platform)
      this.child = null
    }
    this.connection = null
    this.state = "stopped"

    for (const [id, pending] of this.pending) {
      pending.reject(new Error("LSP client killed"))
      this.pending.delete(id)
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.state === "shutdown") {
      this.state = "stopped"
      return
    }

    this.state = "unhealthy"
    this.connection = null

    for (const [id, pending] of this.pending) {
      pending.reject(new Error(`LSP server exited with code ${code}, signal ${signal}`))
      this.pending.delete(id)
    }
  }

  private handleError(error: Error): void {
    this.state = "unhealthy"
    this.stderr += `\n${error.message}`
  }

  getHealth(): LspClientHealth {
    return {
      state: this.state,
      language: this.options.language,
      pid: this.child?.pid,
      uptimeMs: Date.now() - this.startedAt,
      pendingRequests: this.pending.size,
    }
  }

  getStderr(): string {
    return this.stderr
  }
}
