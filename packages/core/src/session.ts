import { mkdir, appendFile, readFile, readdir, stat, unlink } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { ChatMessage } from "./types.js"
import { noopRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js"

export interface SessionRecord {
  ts: number
  type: "event" | "messages" | "stats" | "workflow-checkpoint"
  payload: unknown
}

export interface SessionSummary {
  id: string
  ts: number
  messageCount: number
  userMessages: number
  inputTokens: number
  outputTokens: number
}

export type SessionReadStatus = "ok" | "missing" | "empty" | "corrupt" | "unreadable"

export interface SessionReadResult {
  status: SessionReadStatus
  messages: ChatMessage[]
  skippedLines: number
  error?: string
}

export interface SessionWriterStatus {
  queueSize: number
  droppedCount: number
  flushing: boolean
  lastError?: string
  lastFlushAt?: number
}

export class SessionLoader {
  static sessionDir = resolve(process.cwd(), ".covalo", "sessions")

  static validateSessionId(id: string): boolean {
    if (!id || typeof id !== "string") return false
    if (id.length > 128 || id.length < 1) return false
    if (/[\x00-\x1f\x7f/\\:?*"<>|]/.test(id)) return false
    if (id === "." || id === "..") return false
    if (/\.\./.test(id)) return false
    return true
  }

  private static safePath(sessionId: string): string {
    if (!this.validateSessionId(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`)
    }
    return resolve(this.sessionDir, `${sessionId}.jsonl`)
  }

  static async read(sessionId: string): Promise<ChatMessage[]> {
    return (await this.readDetailed(sessionId)).messages
  }

  static async readDetailed(sessionId: string): Promise<SessionReadResult> {
    const path = this.safePath(sessionId)
    let raw: string
    try {
      raw = await readFile(path, "utf-8")
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : undefined
      if (code === "ENOENT") {
        return { status: "missing", messages: [], skippedLines: 0 }
      }
      return {
        status: "unreadable",
        messages: [],
        skippedLines: 0,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    if (!raw.trim()) {
      return { status: "empty", messages: [], skippedLines: 0 }
    }
    const lines = raw.trim().split("\n")
    let skippedLines = 0
    // Scan from end to find the most recent valid messages record
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec: SessionRecord = JSON.parse(lines[i])
        if (rec.type === "messages" && Array.isArray(rec.payload)) {
          return { status: "ok", messages: rec.payload as ChatMessage[], skippedLines }
        }
      } catch {
        skippedLines++
      }
    }
    return { status: skippedLines > 0 ? "corrupt" : "empty", messages: [], skippedLines }
  }

  static async list(): Promise<SessionSummary[]> {
    const entries: SessionSummary[] = []
    let files: string[]
    try {
      files = await readdir(this.sessionDir)
    } catch {
      return []
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue
      const id = f.slice(0, -6)
      if (!this.validateSessionId(id)) continue
      const path = resolve(this.sessionDir, f)
      try {
        const raw = await readFile(path, "utf-8")
        const lines = raw.trim().split("\n")
        if (lines.length === 0) continue
        let messageCount = 0
        let userMessages = 0
        let inputTokens = 0
        let outputTokens = 0
        let lastTs = 0
        // scan for last valid records
        let lastInputTokens = 0
        let lastOutputTokens = 0
        for (const line of lines) {
          try {
            const rec = JSON.parse(line) as SessionRecord
            if (rec.ts > lastTs) lastTs = rec.ts
            if (rec.type === "messages" && Array.isArray(rec.payload)) {
              const msgs = rec.payload as ChatMessage[]
              messageCount = msgs.length
              userMessages = msgs.filter(m => m.role === "user").length
            }
            if (rec.type === "stats" && typeof rec.payload === "object" && rec.payload) {
              const s = rec.payload as Record<string, unknown>
              // Prefer new format (promptTokens/completionTokens), fallback to old format (inputTokens/outputTokens)
              if (typeof s.promptTokens === "number") lastInputTokens = s.promptTokens
              else if (typeof s.inputTokens === "number") lastInputTokens = s.inputTokens
              if (typeof s.completionTokens === "number") lastOutputTokens = s.completionTokens
              else if (typeof s.outputTokens === "number") lastOutputTokens = s.outputTokens
            }
          } catch { continue }
        }
        inputTokens = lastInputTokens
        outputTokens = lastOutputTokens
        entries.push({ id, ts: lastTs, messageCount, userMessages, inputTokens, outputTokens })
      } catch { continue }
    }
    entries.sort((a, b) => b.ts - a.ts)
    return entries.slice(0, 20)
  }

  static async cleanup(maxSessions = 50): Promise<number> {
    let files: string[]
    try {
      files = await readdir(this.sessionDir)
    } catch {
      return 0
    }
    const jsonl = files.filter(f => f.endsWith(".jsonl"))
    if (jsonl.length <= maxSessions) return 0
    const withStats = await Promise.all(jsonl.map(async (f) => {
      const path = resolve(this.sessionDir, f)
      try { return { f, path, mtime: (await stat(path)).mtimeMs } }
      catch { return { f, path, mtime: 0 } }
    }))
    withStats.sort((a, b) => b.mtime - a.mtime)
    const toDelete = withStats.slice(maxSessions)
    let deleted = 0
    for (const { path } of toDelete) {
      try {
        await unlink(path)
        deleted++
      } catch (err) {
        // FG-60-R: 低噪音日志，不覆盖原始错误语义
        if (process.env.COVALO_DEBUG?.includes("session")) {
          console.debug(`[session] cleanup unlink failed: ${path}`, err)
        }
      }
    }
    return deleted
  }
}

export class AsyncSessionWriter {
  private path: string
  private queue: string[] = []
  private queueRecords: SessionRecord[] = []
  private flushing = false
  private initPromise?: Promise<void>
  private droppedCount = 0
  private lastError?: string
  private lastFlushAt?: number
  private logger: RuntimeLogger

  private static MAX_QUEUE_SIZE = 500

  constructor(path: string, logger: RuntimeLogger = noopRuntimeLogger) {
    this.path = path
    this.logger = logger
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(dirname(this.path), { recursive: true }).then(() => {
        if (this.logger.isEnabled("debug")) {
          this.logger.debug("session.writer.ready", { path: this.path })
        }
      })
    }
    await this.initPromise
  }

  enqueue(record: SessionRecord): void {
    try {
      const serialized = JSON.stringify(record) + "\n"
      this.queue.push(serialized)
      this.queueRecords.push(record)
      this.evictIfNeeded()
      this.flushSoon().catch(() => {})
    } catch (err) {
      if (this.logger.isEnabled("debug")) {
        this.logger.debug("session.writer.serialize_error", {
          type: record.type,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  private evictIfNeeded(): void {
    const before = this.queue.length
    while (this.queue.length > AsyncSessionWriter.MAX_QUEUE_SIZE) {
      const idx = this.queueRecords.findIndex(r => r.type === "event")
      if (idx >= 0) {
        this.queue.splice(idx, 1)
        this.queueRecords.splice(idx, 1)
        this.droppedCount++
        continue
      }
      if (this.queue.length > 1) {
        this.queue.shift()
        this.queueRecords.shift()
        this.droppedCount++
      } else {
        break
      }
    }
    if (this.droppedCount > 0 && this.logger.isEnabled("debug")) {
      this.logger.debug("session.writer.overflow", {
        droppedCount: this.droppedCount,
        queueSize: this.queue.length,
        evicted: before - this.queue.length,
      })
    }
  }

  getDroppedCount(): number {
    return this.droppedCount
  }

  getStatus(): SessionWriterStatus {
    return {
      queueSize: this.queue.length,
      droppedCount: this.droppedCount,
      flushing: this.flushing,
      lastError: this.lastError,
      lastFlushAt: this.lastFlushAt,
    }
  }

  /** Best-effort drain: wait until the queue is empty and no flush in progress.
   *  Idempotent; does not throw. */
  async drain(): Promise<void> {
    try {
      // Wait for any active flush to finish
      while (this.flushing) {
        await new Promise(r => setTimeout(r, 5))
      }
      // Trigger one more flush if there's anything left
      if (this.queue.length > 0) {
        await this.flushSoon()
      }
      // Wait until queue is fully drained
      while (this.flushing || this.queue.length > 0) {
        await new Promise(r => setTimeout(r, 5))
      }
    } catch (e) {
      // ADV-BUG-05: Log session drain errors
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("session.writer.drain_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  private async flushSoon(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      if (this.initPromise) {
        await this.initPromise.catch(() => {})
      }
      while (this.queue.length > 0) {
        const chunk = this.queue.splice(0, 50).join("")
        this.queueRecords.splice(0, 50)
        try {
          await appendFile(this.path, chunk, "utf-8")
        } catch (err) {
          this.lastError = err instanceof Error ? err.message : String(err)
          if (this.logger.isEnabled("debug")) {
            this.logger.debug("session.writer.append_error", {
              error: err instanceof Error ? err.message : String(err),
              path: this.path,
            })
          }
          throw err
        }
      }
      this.lastError = undefined
      this.lastFlushAt = Date.now()
    } catch (e) {
      // ADV-BUG-05: Log flush errors
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("session.writer.flush_error", { error: e instanceof Error ? e.message : String(e) })
      }
    } finally {
      this.flushing = false
      if (this.queue.length > 0) {
        this.flushSoon().catch(() => {})
      }
    }
  }
}
