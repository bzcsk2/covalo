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
  queueBytes: number  // SPEC-06: 队列总字节，用于观测内存压力
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
    const jsonlNames = new Set(jsonl.map(f => f.replace(/\.jsonl$/, "")))

    // 清理孤儿 .checkpoint.json（无对应 .jsonl），不受 maxSessions 限制
    for (const f of files) {
      const m = f.match(/^(.+)\.checkpoint\.json$/)
      if (!m) continue
      // 跳过无效 session ID（含路径穿越或空 basename）
      if (!m[1] || m[1].includes("/") || m[1].includes("\\") || m[1] === "." || m[1] === "..") continue
      if (!jsonlNames.has(m[1])) {
        await unlink(resolve(this.sessionDir, f)).catch(() => {})
      }
    }

    if (jsonl.length <= maxSessions) return 0
    const withStats = await Promise.all(jsonl.map(async (f) => {
      const p = resolve(this.sessionDir, f)
      try { return { f, p, mtime: (await stat(p)).mtimeMs } }
      catch { return { f, p, mtime: 0 } }
    }))
    withStats.sort((a, b) => b.mtime - a.mtime)
    const toDelete = withStats.slice(maxSessions)
    let deleted = 0
    for (const { f, p } of toDelete) {
      try {
        await unlink(p)
        deleted++
      } catch (err) {
        if (process.env.COVALO_DEBUG?.includes("session")) {
          console.debug(`[session] cleanup unlink failed: ${p}`, err)
        }
      }
      // 删对应 checkpoint 文件（若无则静默跳过）
      const basename = f.replace(/\.jsonl$/, "")
      const checkpointPath = resolve(this.sessionDir, `${basename}.checkpoint.json`)
      try { await unlink(checkpointPath) } catch {}
    }
    return deleted
  }
}

export class AsyncSessionWriter {
  private path: string
  private queue: string[] = []
  private queueRecords: SessionRecord[] = []
  private queueSizes: number[] = []  // SPEC-06: 每条记录的字节大小，与 queue/queueRecords 同步
  private queueBytes = 0              // SPEC-06: 队列总字节，用于触发淘汰
  private flushing = false
  private initPromise?: Promise<void>
  private droppedCount = 0
  private lastError?: string
  private lastFlushAt?: number
  private logger: RuntimeLogger

  private static MAX_QUEUE_SIZE = 500
  // SPEC-06: 字节上限 10MiB，避免 500 条大 messages 快照占用过多内存
  private static MAX_QUEUE_BYTES = 10 * 1024 * 1024

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
      const size = Buffer.byteLength(serialized, "utf8")

      // SPEC-06: messages 类型入队前，先 coalesce 掉旧的未 flush messages 快照
      // 最新 messages 快照保留，旧的可以丢，因为 readDetailed 只读最后一条
      if (record.type === "messages") {
        this.evictOlderQueuedMessages()
      }

      this.queue.push(serialized)
      this.queueRecords.push(record)
      this.queueSizes.push(size)
      this.queueBytes += size
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

  /**
   * SPEC-06: 丢弃队列中所有已存在的旧 messages 快照。
   * 即将入队的新 messages 是最新快照，旧的可以丢，因为 readDetailed 只读最后一条。
   * 从后向前删，避免索引漂移。
   */
  private evictOlderQueuedMessages(): void {
    for (let i = this.queueRecords.length - 1; i >= 0; i--) {
      if (this.queueRecords[i].type === "messages") {
        this.queueBytes -= this.queueSizes[i]
        this.queue.splice(i, 1)
        this.queueRecords.splice(i, 1)
        this.queueSizes.splice(i, 1)
        this.droppedCount++
      }
    }
  }

  private evictIfNeeded(): void {
    const before = this.queue.length
    // SPEC-06: 同时考虑条数和字节，超出任一上限都触发淘汰
    while (
      this.queue.length > AsyncSessionWriter.MAX_QUEUE_SIZE ||
      this.queueBytes > AsyncSessionWriter.MAX_QUEUE_BYTES
    ) {
      // 优先丢 event（事件可以丢，不影响状态恢复）
      const idx = this.queueRecords.findIndex(r => r.type === "event")
      if (idx >= 0) {
        this.queueBytes -= this.queueSizes[idx]
        this.queue.splice(idx, 1)
        this.queueRecords.splice(idx, 1)
        this.queueSizes.splice(idx, 1)
        this.droppedCount++
        continue
      }
      // 再丢 stats（统计可以丢）
      const statsIdx = this.queueRecords.findIndex(r => r.type === "stats")
      if (statsIdx >= 0) {
        this.queueBytes -= this.queueSizes[statsIdx]
        this.queue.splice(statsIdx, 1)
        this.queueRecords.splice(statsIdx, 1)
        this.queueSizes.splice(statsIdx, 1)
        this.droppedCount++
        continue
      }
      // 最后丢最旧的 messages，但尽量保留最新一条 messages
      // 找最老的 messages（保留最新一条）
      let oldestMsgIdx = -1
      let msgCount = 0
      for (let i = 0; i < this.queueRecords.length; i++) {
        if (this.queueRecords[i].type === "messages") {
          msgCount++
          if (oldestMsgIdx < 0) oldestMsgIdx = i
        }
      }
      if (oldestMsgIdx >= 0 && msgCount > 1) {
        this.queueBytes -= this.queueSizes[oldestMsgIdx]
        this.queue.splice(oldestMsgIdx, 1)
        this.queueRecords.splice(oldestMsgIdx, 1)
        this.queueSizes.splice(oldestMsgIdx, 1)
        this.droppedCount++
        continue
      }
      // 兜底：丢最旧的一条（不再保留 messages）
      if (this.queue.length > 1) {
        const size = this.queueSizes[0]
        this.queueBytes -= size
        this.queue.shift()
        this.queueRecords.shift()
        this.queueSizes.shift()
        this.droppedCount++
      } else {
        break
      }
    }
    if (this.droppedCount > 0 && this.logger.isEnabled("debug")) {
      this.logger.debug("session.writer.overflow", {
        droppedCount: this.droppedCount,
        queueSize: this.queue.length,
        queueBytes: this.queueBytes,
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
      queueBytes: this.queueBytes,
      droppedCount: this.droppedCount,
      flushing: this.flushing,
      lastError: this.lastError,
      lastFlushAt: this.lastFlushAt,
    }
  }

  /** Best-effort drain: wait until the queue is empty and no flush in progress.
   *  Idempotent; does not throw.
   *  @param timeoutMs max time to wait in ms (default 10_000). After timeout, logs warning and returns. */
  async drain(timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    const timedOut = () => Date.now() >= deadline
    const sleep = () => new Promise(r => setTimeout(r, 5))
    try {
      while (this.flushing && !timedOut()) {
        await sleep()
      }
      if (this.queue.length > 0 && !timedOut()) {
        await this.flushSoon()
      }
      while ((this.flushing || this.queue.length > 0) && !timedOut()) {
        await sleep()
      }
      if (this.queue.length > 0 || this.flushing) {
        if (this.logger.isEnabled("warn")) {
          this.logger.warn("session.writer.drain_timeout", {
            queueSize: this.queue.length,
            queueBytes: this.queueBytes,
            flushing: this.flushing,
            lastError: this.lastError,
            timeoutMs,
          })
        }
      }
    } catch (e) {
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
        const batch = this.queue.splice(0, 50)
        const sizes = this.queueSizes.splice(0, 50)
        this.queueRecords.splice(0, 50)
        const chunkBytes = sizes.reduce((a, b) => a + b, 0)
        this.queueBytes -= chunkBytes
        const chunk = batch.join("")
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
