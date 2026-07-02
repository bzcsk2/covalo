import { appendFile, mkdir, symlink, unlink, readdir, stat } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { dirname, resolve, join } from "node:path"

export type RuntimeLogLevel = "debug" | "info" | "warn" | "error"

export interface RuntimeLogRecord {
  ts: string
  level: RuntimeLogLevel
  event: string
  [key: string]: unknown
}

export interface RuntimeLoggerOptions {
  enabled?: boolean
  level?: RuntimeLogLevel
  filePath?: string
  bindings?: Record<string, unknown>
  maxQueueSize?: number
  filter?: string
  createSymlink?: boolean
}

const LEVEL_WEIGHT: Record<RuntimeLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
}

const REDACTED = "[REDACTED]"
const MAX_STRING_LENGTH = 2_000
const DEFAULT_MAX_QUEUE_SIZE = 1_000
const FLUSH_INTERVAL_MS = 1000

class RuntimeLogSink {
  readonly enabled: boolean
  readonly level: RuntimeLogLevel
  readonly filePath: string
  readonly filter: string | null
  readonly createSymlink: boolean
  private readonly maxQueueSize: number
  private queue: string[] = []
  private bufferBytes = 0
  private flushing = false
  private initPromise?: Promise<void>
  private droppedCount = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private pendingOverflow: string[] | null = null

  constructor(options: RuntimeLoggerOptions) {
    this.enabled = options.enabled ?? true
    this.level = options.level ?? "info"
    this.filePath = options.filePath ?? defaultLogPath()
    this.maxQueueSize = options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE
    this.filter = options.filter ?? null
    this.createSymlink = options.createSymlink ?? false
  }

  accepts(level: RuntimeLogLevel): boolean {
    return this.enabled && LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.level]
  }

  matchesFilter(event: string): boolean {
    if (!this.filter) return true
    const patterns = this.filter.split(",").map(p => p.trim().toLowerCase())
    return patterns.some(pattern => event.toLowerCase().includes(pattern))
  }

  enqueue(record: RuntimeLogRecord): void {
    if (!this.accepts(record.level)) return
    if (!this.matchesFilter(record.event)) return
    try {
      const serialized = JSON.stringify(record) + "\n"
      this.queue.push(serialized)
      this.bufferBytes += serialized.length
      this.scheduleFlush()
      if (this.queue.length >= 50 || this.bufferBytes >= 65536) {
        this.flushDeferred()
      }
      while (this.queue.length > this.maxQueueSize) {
        this.queue.shift()
        this.droppedCount++
      }
    } catch {
      // Runtime logging must never break the agent.
    }
  }

  getDroppedCount(): number {
    return this.droppedCount
  }

  async flush(): Promise<void> {
    if (!this.enabled) return
    // Cancel any scheduled timer so the event loop can exit after this flush
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushSync()
    while (this.flushing) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  }

  flushSync(): void {
    if (this.pendingOverflow) {
      void this.writeChunk(this.pendingOverflow)
      this.pendingOverflow = null
    }
    if (this.queue.length === 0) return
    const chunk = this.queue.splice(0)
    this.bufferBytes = 0
    void this.writeChunk(chunk)
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null
        this.flushSync()
      }, FLUSH_INTERVAL_MS)
    }
  }

  private flushDeferred(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.pendingOverflow) {
      // Trim pendingOverflow before appending new records to bound memory
      const maxOverflowRecords = this.maxQueueSize
      if (this.pendingOverflow.length >= maxOverflowRecords) {
        const excess = this.pendingOverflow.length - maxOverflowRecords
        this.pendingOverflow.splice(0, excess)
        this.droppedCount += excess
      }
      const capacity = maxOverflowRecords - this.pendingOverflow.length
      if (this.queue.length > capacity) {
        this.droppedCount += this.queue.length - capacity
        this.queue = this.queue.slice(this.queue.length - capacity)
      }
      for (let i = 0; i < this.queue.length; i++) {
        this.pendingOverflow.push(this.queue[i])
      }
      this.queue = []
      this.bufferBytes = 0
      return
    }
    this.pendingOverflow = this.queue.splice(0)
    this.bufferBytes = 0
    setImmediate(() => {
      const toWrite = this.pendingOverflow
      this.pendingOverflow = null
      if (toWrite) void this.writeChunk(toWrite)
    })
  }

  private async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(dirname(this.filePath), { recursive: true }).then(() => {})
    }
    await this.initPromise
  }

  private async writeChunk(chunk: string[]): Promise<void> {
    if (chunk.length === 0) return
    this.flushing = true
    try {
      await this.init()
      await appendFile(this.filePath, chunk.join(""), "utf-8")
      if (this.createSymlink) {
        await this.updateSymlink()
      }
    } catch {
      // Best-effort file logging: keep the main execution path alive.
    } finally {
      this.flushing = false
    }
  }

  private async updateSymlink(): Promise<void> {
    try {
      const symlinkPath = resolve(dirname(this.filePath), "latest.jsonl")
      await unlink(symlinkPath).catch(() => {})
      await symlink(this.filePath, symlinkPath)
    } catch {
      // Symlink is optional, ignore errors
    }
  }
}

export class RuntimeLogger {
  private readonly sink: RuntimeLogSink
  private readonly bindings: Record<string, unknown>

  constructor(options: RuntimeLoggerOptions = {}, sink?: RuntimeLogSink) {
    this.sink = sink ?? new RuntimeLogSink(options)
    this.bindings = sanitizeObject(options.bindings ?? {})
  }

  child(bindings: Record<string, unknown>): RuntimeLogger {
    if (!this.sink.enabled) return this
    return new RuntimeLogger(
      { bindings: { ...this.bindings, ...sanitizeObject(bindings) } },
      this.sink,
    )
  }

  isEnabled(level: RuntimeLogLevel = "info"): boolean {
    return this.sink.accepts(level)
  }

  debug(event: string, data?: Record<string, unknown>): void {
    this.write("debug", event, data)
  }

  info(event: string, data?: Record<string, unknown>): void {
    this.write("info", event, data)
  }

  warn(event: string, data?: Record<string, unknown>): void {
    this.write("warn", event, data)
  }

  error(event: string, error?: unknown, data?: Record<string, unknown>): void {
    this.write("error", event, {
      ...data,
      error: serializeError(error),
    })
  }

  getDroppedCount(): number {
    return this.sink.getDroppedCount()
  }

  flush(): Promise<void> {
    return this.sink.flush()
  }

  private write(level: RuntimeLogLevel, event: string, data?: Record<string, unknown>): void {
    if (!this.sink.accepts(level)) return
    this.sink.enqueue({
      ts: new Date().toISOString(),
      level,
      event,
      ...this.bindings,
      ...sanitizeObject(data ?? {}),
    })
  }
}

export const noopRuntimeLogger = new RuntimeLogger({ enabled: false })

function readLogFileLevel(cwd: string): string | undefined {
  try {
    const configPath = resolve(cwd, ".covalo", "config.json")
    const raw = readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed.logLevel === "string") return parsed.logLevel.trim().toLowerCase()
    return undefined
  } catch {
    return undefined
  }
}

export function createRuntimeLoggerFromEnv(
  bindings: Record<string, unknown> = {},
  cwd = process.cwd(),
): RuntimeLogger {
  const envLevel = process.env.COVALO_LOG_LEVEL?.trim().toLowerCase()
  const fileLevel = readLogFileLevel(cwd)
  const configuredLevel = envLevel ?? fileLevel
  const enabled = configuredLevel !== undefined && configuredLevel !== "" && configuredLevel !== "off"
  const level = isRuntimeLogLevel(configuredLevel)
    ? configuredLevel
    : "info"
  const filePath = process.env.COVALO_LOG_FILE?.trim()
    ? resolve(cwd, process.env.COVALO_LOG_FILE.trim())
    : defaultLogPath(cwd)
  const filter = process.env.COVALO_LOG_FILTER?.trim() || undefined
  const createSymlink = process.env.COVALO_LOG_SYMLINK === "1"
  return new RuntimeLogger({ enabled, level, filePath, bindings, filter, createSymlink })
}

export function parseDebugArgs(args: string[]): { level?: RuntimeLogLevel; filter?: string; file?: string; trace?: boolean } {
  const result: { level?: RuntimeLogLevel; filter?: string; file?: string; trace?: boolean } = {}
  for (const arg of args) {
    if (arg === "--debug" || arg === "-d") {
      result.level = "debug"
    } else if (arg.startsWith("--debug=")) {
      result.level = "debug"
      const value = arg.slice("--debug=".length)
      if (value) result.filter = value
    } else if (arg.startsWith("--debug-file=")) {
      result.file = arg.slice("--debug-file=".length)
    } else if (arg === "--trace") {
      result.trace = true
    }
  }
  return result
}

// Cleanup registry for graceful shutdown
type CleanupFn = () => Promise<void>
const cleanupFunctions = new Set<CleanupFn>()

export function registerCleanup(cleanupFn: CleanupFn): () => void {
  cleanupFunctions.add(cleanupFn)
  return () => cleanupFunctions.delete(cleanupFn)
}

export async function runCleanupFunctions(): Promise<void> {
  await Promise.all(Array.from(cleanupFunctions).map(fn => fn()))
}

let shutdownRegistered = false

export function registerShutdownFlush(logger: RuntimeLogger, timeoutMs = 200): void {
  if (shutdownRegistered) return
  shutdownRegistered = true

  const flushWithTimeout = async (): Promise<void> => {
    const timeout = new Promise<void>(resolve => setTimeout(resolve, timeoutMs))
    const flush = logger.flush()
    await Promise.race([flush, timeout])
  }

  registerCleanup(async () => {
    logger.info("process.shutdown.start", { reason: "graceful" })
    await flushWithTimeout()
    logger.info("process.shutdown.done", { droppedCount: logger.getDroppedCount() })
  })

  process.on("SIGINT", async () => {
    await flushWithTimeout()
    process.exit(130)
  })

  process.on("SIGTERM", async () => {
    await flushWithTimeout()
    process.exit(143)
  })
}

function defaultLogPath(cwd = process.cwd()): string {
  const day = new Date().toISOString().slice(0, 10)
  return resolve(cwd, ".covalo", "logs", `runtime-${day}.jsonl`)
}

function isRuntimeLogLevel(value: string | undefined): value is RuntimeLogLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error"
}

function sanitizeObject(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized = sanitizeValue(value)
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? sanitized as Record<string, unknown>
    : {}
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (isSensitiveKey(key)) return REDACTED
  if (depth > 5) return "[TRUNCATED]"
  if (typeof value === "string") {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}...[TRUNCATED]`
      : value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(item => sanitizeValue(item, key, depth + 1))
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = sanitizeValue(childValue, childKey, depth + 1)
    }
    return result
  }
  return value
}

function isSensitiveKey(key: string): boolean {
  return /api[-_]?key|authorization|password|passwd|secret|credential|cookie|private[-_]?key|access[-_]?key|(?:^|[-_])token$|(?:access|refresh|auth|bearer|id|session)[-_]?token/i.test(key)
}

function serializeError(error: unknown): Record<string, unknown> | undefined {
  if (error === undefined) return undefined
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }
  return { message: String(error) }
}

/**
 * Clean up old log files based on retention settings.
 * Runs in background, does not block TUI.
 */
export async function cleanupOldLogs(logsDir?: string): Promise<void> {
  const retentionDays = parseInt(process.env.COVALO_LOG_RETENTION_DAYS ?? "7", 10)
  const maxTotalMB = parseInt(process.env.COVALO_LOG_MAX_TOTAL_MB ?? "100", 10)

  if (retentionDays <= 0 && maxTotalMB <= 0) return

  const dir = logsDir ?? join(process.cwd(), ".covalo", "logs")

  try {
    await mkdir(dir, { recursive: true })
    const files = await readdir(dir)
    const logFiles = files.filter(f => f.startsWith("runtime-") && f.endsWith(".jsonl"))

    if (logFiles.length === 0) return

    const now = Date.now()
    const cutoffMs = retentionDays > 0 ? retentionDays * 24 * 60 * 60 * 1000 : Infinity
    let totalBytes = 0
    const fileInfo: Array<{ name: string; size: number; mtimeMs: number }> = []

    for (const file of logFiles) {
      const filePath = join(dir, file)
      const fileStat = await stat(filePath).catch(() => null)
      if (fileStat) {
        totalBytes += fileStat.size
        fileInfo.push({ name: file, size: fileStat.size, mtimeMs: fileStat.mtimeMs })
      }
    }

    // Delete files older than retention period
    if (cutoffMs < Infinity) {
      for (const file of fileInfo) {
        if (now - file.mtimeMs > cutoffMs) {
          await unlink(join(dir, file.name)).catch(() => {})
          totalBytes -= file.size
        }
      }
    }

    // Delete oldest files if over size limit
    const maxTotalBytes = maxTotalMB * 1024 * 1024
    if (totalBytes > maxTotalBytes) {
      const sorted = fileInfo.sort((a, b) => a.mtimeMs - b.mtimeMs)
      for (const file of sorted) {
        if (totalBytes <= maxTotalBytes) break
        await unlink(join(dir, file.name)).catch(() => {})
        totalBytes -= file.size
      }
    }
  } catch {}
}

/**
 * Check for deprecated COVALO_DEBUG env var and warn
 */
export function checkDeprecatedDebugEnv(): void {
  if (process.env.COVALO_DEBUG !== undefined) {
    console.error(
      "[deprecated] COVALO_DEBUG is deprecated. Use COVALO_LOG_LEVEL=debug instead.",
    )
  }
}
