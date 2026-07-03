import { pathToFileURL } from "node:url"
import { LspClient } from "./lsp-client.js"
import type { LspServerState } from "./lsp-client.js"
import type { LspLanguageConfig } from "./config.js"
import { createHash } from "node:crypto"

interface DocumentCacheEntry {
  uri: string
  version: number
  contentHash: string
  language: string
  serverKey: string
}

interface PoolEntry {
  client: LspClient
  language: string
  cwd: string
  server: LspLanguageConfig
  lastUsed: number
  refCount: number
  createdAt: number
  documents: Map<string, DocumentCacheEntry>
}

export interface PoolEntryStatus {
  serverKey: string
  language: string
  workspaceRoot: string
  pid: number | undefined
  state: LspServerState
  uptimeMs: number
  pendingRequests: number
  lastUsedAt: number
  documents: number
}

function configHash(server: LspLanguageConfig): string {
  return createHash("sha256")
    .update(JSON.stringify({ command: server.command, args: server.args, initializationOptions: server.initializationOptions, settings: server.settings }))
    .digest("hex")
    .slice(0, 16)
}

function buildServerKey(language: string, cwd: string, server: LspLanguageConfig): string {
  return `${language}::${cwd}::${configHash(server)}`
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

export class LspClientPool {
  private clients = new Map<string, PoolEntry>()
  private idleTimer: ReturnType<typeof setInterval> | null = null

  async acquire(language: string, cwd: string, server: LspLanguageConfig, timeoutMs?: number): Promise<{ client: LspClient; serverKey: string }> {
    const serverKey = buildServerKey(language, cwd, server)
    const existing = this.clients.get(serverKey)

    if (existing) {
      existing.refCount++
      existing.lastUsed = Date.now()
      return { client: existing.client, serverKey }
    }

    const client = new LspClient({
      command: server.command,
      args: server.args ?? [],
      cwd,
      rootPath: cwd,
      language,
      timeoutMs: timeoutMs ?? 8000,
      initializationOptions: server.initializationOptions,
      settings: server.settings,
    })

    await client.start()
    await client.initialize()

    const entry: PoolEntry = {
      client,
      language,
      cwd,
      server: { command: server.command, args: server.args, initializationOptions: server.initializationOptions, settings: server.settings },
      lastUsed: Date.now(),
      refCount: 1,
      createdAt: Date.now(),
      documents: new Map(),
    }
    this.clients.set(serverKey, entry)
    return { client, serverKey }
  }

  release(serverKey: string): void {
    const entry = this.clients.get(serverKey)
    if (!entry) return
    entry.refCount = Math.max(0, entry.refCount - 1)
    entry.lastUsed = Date.now()
  }

  buildKeyFor(language: string, cwd: string, server: LspLanguageConfig): string {
    return buildServerKey(language, cwd, server)
  }

  findServerKey(language: string, cwd: string, server: LspLanguageConfig): string | undefined {
    const computed = buildServerKey(language, cwd, server)
    if (this.clients.has(computed)) return computed
    for (const key of this.clients.keys()) {
      if (key.startsWith(`${language}::${cwd}::`)) return key
    }
    return undefined
  }

  async ensureDocument(serverKey: string, filePath: string, language: string, content: string): Promise<void> {
    const entry = this.clients.get(serverKey)
    if (!entry) throw new Error(`No client for server key: ${serverKey}`)

    const uri = pathToFileURL(filePath).href
    const hash = contentHash(content)
    const existing = entry.documents.get(uri)

    if (!existing) {
      await entry.client.openDocument(filePath, language, content)
      entry.documents.set(uri, { uri, version: 1, contentHash: hash, language, serverKey })
    } else if (existing.contentHash !== hash) {
      existing.version++
      existing.contentHash = hash
      await entry.client.changeDocument(filePath, existing.version, content)
    }
  }

  startIdleSweep(intervalMs = 60000, idleTimeoutMs = 300000): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      const now = Date.now()
      for (const [key, entry] of this.clients.entries()) {
        if (entry.refCount > 0) continue
        if (now - entry.lastUsed < idleTimeoutMs) continue
        entry.client.shutdown().catch(() => entry.client.kill())
        this.clients.delete(key)
      }
    }, intervalMs)
    this.idleTimer.unref?.()
  }

  stopIdleSweep(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }

  getStatus(): PoolEntryStatus[] {
    const statuses: PoolEntryStatus[] = []
    for (const [key, entry] of this.clients.entries()) {
      const health = entry.client.getHealth()
      statuses.push({
        serverKey: key,
        language: entry.client.getLanguage(),
        workspaceRoot: entry.cwd,
        pid: entry.client.getPid(),
        state: health.state,
        uptimeMs: health.uptimeMs,
        pendingRequests: health.pendingRequests,
        lastUsedAt: entry.lastUsed,
        documents: entry.documents.size,
      })
    }
    return statuses
  }

  async restart(serverKey: string): Promise<boolean> {
    const entry = this.clients.get(serverKey)
    if (!entry) throw new Error(`No client for server key: ${serverKey}`)

    const { language, cwd, server } = entry

    await entry.client.shutdown().catch(() => entry.client.kill())
    this.clients.delete(serverKey)

    await this.acquire(language, cwd, server)
    return true
  }

  async disposeAll(): Promise<void> {
    this.stopIdleSweep()
    const promises: Promise<void>[] = []
    for (const [, entry] of this.clients) {
      promises.push(entry.client.shutdown().catch(() => entry.client.kill()))
    }
    this.clients.clear()
    await Promise.allSettled(promises)
  }
}
