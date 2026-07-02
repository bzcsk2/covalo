import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { extname } from "node:path"
import { pathToFileURL } from "node:url"
import { LspClient, type LspClientHealth, type LspServerState } from "./lsp-client.js"
import { readLspConfig, getLanguageConfig, getIdleTimeout, type LspConfig } from "./config.js"
import { inferLanguage } from "./language.js"

const CONFIG_CHECK_INTERVAL_MS = 30000
const DEFAULT_IDLE_TIMEOUT_MS = 300000

interface ServerKey {
  workspaceRoot: string
  language: string
  configHash: string
}

interface ManagedServer {
  key: string
  client: LspClient
  workspaceRoot: string
  language: string
  configHash: string
  lastUsedAt: number
  createdAt: number
}

interface DocumentInfo {
  uri: string
  filePath: string
  language: string
  version: number
  contentHash: string
}

export interface LspManagerStatus {
  servers: Array<{
    key: string
    language: string
    workspaceRoot: string
    state: LspServerState
    pid: number | undefined
    uptimeMs: number
    pendingRequests: number
    lastUsedAt: number
  }>
  documents: number
}

export class LspManager {
  private servers = new Map<string, ManagedServer>()
  private documents = new Map<string, DocumentInfo>()
  private configCache = new Map<string, { config: LspConfig; hash: string; checkedAt: number }>()
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private cwd: string

  constructor(cwd: string) {
    this.cwd = cwd
    this.startCleanupTimer()
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupIdleServers()
    }, 60000)
  }

  private stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  private async getConfig(workspaceRoot: string): Promise<{ config: LspConfig; hash: string }> {
    const cached = this.configCache.get(workspaceRoot)
    if (cached && Date.now() - cached.checkedAt < CONFIG_CHECK_INTERVAL_MS) {
      return { config: cached.config, hash: cached.hash }
    }

    const { config } = await readLspConfig(workspaceRoot)
    const hash = createHash("md5").update(JSON.stringify(config)).digest("hex")
    this.configCache.set(workspaceRoot, { config, hash, checkedAt: Date.now() })
    return { config, hash }
  }

  private makeServerKey(workspaceRoot: string, language: string, configHash: string): string {
    return `${workspaceRoot}:${language}:${configHash}`
  }

  private async getOrCreateClient(
    workspaceRoot: string,
    language: string,
    filePath: string,
  ): Promise<ManagedServer | null> {
    const { config, hash: configHash } = await this.getConfig(workspaceRoot)
    const serverConfig = getLanguageConfig(config, language)
    if (!serverConfig?.command) return null

    const key = this.makeServerKey(workspaceRoot, language, configHash)
    const existing = this.servers.get(key)
    if (existing) {
      existing.lastUsedAt = Date.now()
      if (existing.client.getState() === "running") {
        return existing
      }
      // Client is unhealthy, remove it and clear associated documents
      existing.client.kill()
      this.servers.delete(key)
      this.clearDocumentsForServer(key)
    }

    const client = new LspClient({
      command: serverConfig.command,
      args: serverConfig.args ?? [],
      cwd: workspaceRoot,
      rootPath: workspaceRoot,
      language,
      initializationOptions: serverConfig.initializationOptions,
      settings: serverConfig.settings,
      timeoutMs: config.requestTimeoutMs,
    })

    try {
      await client.start()
      await client.initialize()

      const managed: ManagedServer = {
        key,
        client,
        workspaceRoot,
        language,
        configHash,
        lastUsedAt: Date.now(),
        createdAt: Date.now(),
      }
      this.servers.set(key, managed)
      return managed
    } catch {
      client.kill()
      return null
    }
  }

  private async detectLanguage(filePath: string, workspaceRoot: string): Promise<string> {
    const ext = extname(filePath).toLowerCase()
    const language = inferLanguage(filePath)
    if (language) return language

    // Try to detect from file content (e.g., shebang)
    try {
      const content = await readFile(filePath, "utf8")
      const firstLine = content.split("\n")[0] ?? ""
      if (firstLine.startsWith("#!/usr/bin/env python")) return "python"
      if (firstLine.startsWith("#!/usr/bin/python")) return "python"
      if (firstLine.startsWith("#!/usr/bin/env node")) return "javascript"
      if (firstLine.startsWith("#!/usr/bin/env ruby")) return "ruby"
      if (firstLine.startsWith("#!/usr/bin/env bash")) return "shellscript"
      if (firstLine.startsWith("#!/usr/bin/env sh")) return "shellscript"
    } catch {
      // Ignore read errors
    }

    return ""
  }

  private async computeContentHash(filePath: string): Promise<string> {
    try {
      const content = await readFile(filePath, "utf8")
      return createHash("md5").update(content).digest("hex")
    } catch {
      return ""
    }
  }

  private async ensureDocumentSync(
    managed: ManagedServer,
    filePath: string,
    language: string,
  ): Promise<void> {
    const uri = pathToFileURL(filePath).href
    const existing = this.documents.get(uri)

    try {
      const content = await readFile(filePath, "utf8")
      const contentHash = createHash("md5").update(content).digest("hex")

      if (!existing) {
        // First time opening this document
        await managed.client.openDocument(filePath, language, content)
        this.documents.set(uri, {
          uri,
          filePath,
          language,
          version: 1,
          contentHash,
        })
      } else if (existing.contentHash !== contentHash) {
        // Document has changed
        const newVersion = existing.version + 1
        await managed.client.changeDocument(filePath, newVersion, content)
        existing.version = newVersion
        existing.contentHash = contentHash
      }
    } catch {
      // Ignore file read errors
    }
  }

  async request(
    method: string,
    params: unknown,
    filePath: string,
    timeoutMs?: number,
  ): Promise<unknown> {
    const workspaceRoot = this.cwd
    const language = await this.detectLanguage(filePath, workspaceRoot)
    if (!language) {
      throw new Error(`Cannot detect language for: ${filePath}`)
    }

    const managed = await this.getOrCreateClient(workspaceRoot, language, filePath)
    if (!managed) {
      throw new Error(`No LSP server available for language: ${language}`)
    }

    await this.ensureDocumentSync(managed, filePath, language)
    return managed.client.request(method, params, timeoutMs)
  }

  async notify(method: string, params: unknown, filePath: string): Promise<void> {
    const workspaceRoot = this.cwd
    const language = await this.detectLanguage(filePath, workspaceRoot)
    if (!language) {
      throw new Error(`Cannot detect language for: ${filePath}`)
    }

    const managed = await this.getOrCreateClient(workspaceRoot, language, filePath)
    if (!managed) {
      throw new Error(`No LSP server available for language: ${language}`)
    }

    await managed.client.notify(method, params)
  }

  async markDirty(filePath: string): Promise<void> {
    const uri = pathToFileURL(filePath).href
    const existing = this.documents.get(uri)
    if (!existing) return

    try {
      const content = await readFile(filePath, "utf8")
      const contentHash = createHash("md5").update(content).digest("hex")

      if (existing.contentHash !== contentHash) {
        const managed = this.findClientForLanguage(existing.language)
        if (managed) {
          const newVersion = existing.version + 1
          await managed.client.changeDocument(filePath, newVersion, content)
          existing.version = newVersion
          existing.contentHash = contentHash
        }
      }
    } catch {
      // Ignore file read errors
    }
  }

  private findClientForLanguage(language: string): ManagedServer | null {
    for (const managed of this.servers.values()) {
      if (managed.language === language && managed.client.getState() === "running") {
        return managed
      }
    }
    return null
  }

  private clearDocumentsForServer(serverKey: string): void {
    for (const [uri, doc] of this.documents) {
      const serverForDoc = this.findClientForLanguage(doc.language)
      if (!serverForDoc || serverForDoc.key !== serverKey) {
        this.documents.delete(uri)
      }
    }
  }

  private cleanupIdleServers(): void {
    const now = Date.now()
    const idleTimeout = DEFAULT_IDLE_TIMEOUT_MS

    for (const [key, managed] of this.servers) {
      if (now - managed.lastUsedAt > idleTimeout) {
        managed.client.kill()
        this.servers.delete(key)
        this.clearDocumentsForServer(key)
      }
    }
  }

  async shutdownWorkspace(workspaceRoot: string): Promise<void> {
    for (const [key, managed] of this.servers) {
      if (managed.workspaceRoot === workspaceRoot) {
        await managed.client.shutdown()
        this.servers.delete(key)
        this.clearDocumentsForServer(key)
      }
    }
  }

  async shutdownAll(): Promise<void> {
    this.stopCleanupTimer()
    for (const managed of this.servers.values()) {
      await managed.client.shutdown()
    }
    this.servers.clear()
    this.documents.clear()
  }

  getStatus(): LspManagerStatus {
    const servers = Array.from(this.servers.values()).map((managed) => ({
      key: managed.key,
      language: managed.language,
      workspaceRoot: managed.workspaceRoot,
      state: managed.client.getState(),
      pid: managed.client.getPid(),
      uptimeMs: managed.client.getHealth().uptimeMs,
      pendingRequests: managed.client.getHealth().pendingRequests,
      lastUsedAt: managed.lastUsedAt,
    }))

    return {
      servers,
      documents: this.documents.size,
    }
  }

  getHealth(): LspClientHealth[] {
    return Array.from(this.servers.values()).map((managed) => managed.client.getHealth())
  }
}
