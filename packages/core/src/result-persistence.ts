import { mkdir, writeFile, readdir, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { noopRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js"

const DEFAULT_MAX_RESULT_CHARS = 200_000
const DEFAULT_PREVIEW_CHARS = 2_000
const DEFAULT_SESSION_QUOTA_BYTES = 50 * 1024 * 1024 // 50 MiB
const DEFAULT_MAX_FILES_PER_SESSION = 200

export interface ResultPersistenceConfig {
  maxResultSizeChars?: number
  previewChars?: number
  sessionQuotaBytes?: number
  maxFilesPerSession?: number
  baseDir?: string
}

export interface PersistedResult {
  preview: string
  persistedPath: string
  originalChars: number
  previewChars: number
  truncated: boolean
}

/** Per-session byte usage tracker (process-lifetime soft quota) */
const sessionByteUsage = new Map<string, number>()
/** Track which sessions have been initialized from disk */
const sessionInitialized = new Set<string>()

async function initSessionUsage(sessionId: string, baseDir: string, logger: RuntimeLogger): Promise<void> {
  if (sessionInitialized.has(sessionId)) return
  sessionInitialized.add(sessionId)
  const dir = join(baseDir, ".covalo", "results", sanitizeId(sessionId))
  try {
    const files = await readdir(dir)
    let totalBytes = 0
    for (const f of files) {
      try {
        const s = await stat(join(dir, f))
        totalBytes += s.size
      } catch {
        continue
      }
    }
    sessionByteUsage.set(sessionId, totalBytes)
    if (logger.isEnabled("debug")) {
      logger.debug("tool.result.usage_init", { sessionId, existingBytes: totalBytes, fileCount: files.length })
    }
  } catch {
    sessionByteUsage.set(sessionId, 0)
  }
}

function addByteUsage(sessionId: string, bytes: number): void {
  const current = sessionByteUsage.get(sessionId) ?? 0
  sessionByteUsage.set(sessionId, current + bytes)
}

function subtractByteUsage(sessionId: string, bytes: number): void {
  const current = sessionByteUsage.get(sessionId) ?? 0
  sessionByteUsage.set(sessionId, Math.max(0, current - bytes))
}

export async function maybePersistResult(
  content: string,
  sessionId: string,
  toolName: string,
  config?: ResultPersistenceConfig,
  logger: RuntimeLogger = noopRuntimeLogger,
): Promise<{ content: string; persisted?: PersistedResult; warning?: string }> {
  const maxChars = config?.maxResultSizeChars ?? DEFAULT_MAX_RESULT_CHARS
  if (content.length <= maxChars) {
    return { content }
  }

  const previewLen = config?.previewChars ?? DEFAULT_PREVIEW_CHARS
  const truncated = content.length > previewLen
  const preview = truncated
    ? content.slice(0, previewLen) + `\n\n[TRUNCATED: ${content.length} chars total, preview shows ${previewLen} chars]`
    : content

  if (logger.isEnabled("info")) {
    logger.info("tool.result.overflow", { toolName, originalChars: content.length, previewChars: previewLen })
  }

  // CL-31: Initialize usage from disk on first use for this session
  const baseDir = config?.baseDir ?? process.cwd()
  await initSessionUsage(sessionId, baseDir, logger)

  const quota = config?.sessionQuotaBytes ?? DEFAULT_SESSION_QUOTA_BYTES
  const contentBytes = Buffer.byteLength(content, "utf-8")
  const used = sessionByteUsage.get(sessionId) ?? 0

  if (used + contentBytes > quota) {
    if (logger.isEnabled("warn")) {
      logger.warn("tool.result.quota_exceeded", {
        toolName,
        sessionId,
        used,
        quota,
        required: contentBytes,
      })
    }
    return {
      content: preview,
      warning: `Session result quota exceeded (${used}/${quota} bytes). Result truncated to preview.`,
      persisted: {
        preview,
        persistedPath: "",
        originalChars: content.length,
        previewChars: previewLen,
        truncated: true,
      },
    }
  }

  try {
    const dir = join(baseDir, ".covalo", "results", sanitizeId(sessionId))
    await mkdir(dir, { recursive: true, mode: 0o700 })

    const filename = `${sanitizeId(toolName)}-${randomUUID()}.txt`
    const filePath = join(dir, filename)
    await writeFile(filePath, content, { mode: 0o600 })

    addByteUsage(sessionId, contentBytes)

    const persisted: PersistedResult = {
      preview,
      persistedPath: filePath,
      originalChars: content.length,
      previewChars: previewLen,
      truncated,
    }

    if (logger.isEnabled("info")) {
      logger.info("tool.result.persisted", { toolName, persistedPath: filePath, originalChars: content.length })
    }

    const maxFiles = config?.maxFilesPerSession ?? DEFAULT_MAX_FILES_PER_SESSION
    scheduleCleanup(dir, maxFiles, sessionId, logger)

    return {
      content: preview,
      persisted,
    }
  } catch (e) {
    const warning = `Result persistence failed: ${e instanceof Error ? e.message : String(e)}`
    if (logger.isEnabled("warn")) {
      logger.warn("tool.result.persist_error", { toolName, error: e instanceof Error ? e.message : String(e) })
    }
    return {
      content: preview,
      warning,
      persisted: {
        preview,
        persistedPath: "",
        originalChars: content.length,
        previewChars: previewLen,
        truncated: true,
      },
    }
  }
}

/** Per-dir cleanup state: ensure only one cleanup worker per directory. */
const cleanupState = new Map<string, { running: boolean; dirty: boolean }>()

function scheduleCleanup(
  dir: string,
  maxFiles: number,
  sessionId: string,
  logger: RuntimeLogger,
): void {
  const state = cleanupState.get(dir) ?? { running: false, dirty: false }
  state.dirty = true
  cleanupState.set(dir, state)

  if (state.running) return

  state.running = true

  void (async () => {
    try {
      while (state.dirty) {
        state.dirty = false
        await cleanupOldFiles(dir, maxFiles, sessionId, logger)
      }
    } catch (e) {
      if (logger.isEnabled("warn")) {
        logger.warn("tool.result.cleanup_schedule_error", {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    } finally {
      state.running = false
      if (!state.dirty) cleanupState.delete(dir)
    }
  })()
}

async function cleanupOldFiles(dir: string, maxFiles: number, sessionId: string, logger: RuntimeLogger): Promise<void> {
  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return
  }

  if (files.length <= maxFiles) return

  const entries = await Promise.all(
    files.map(async (name) => {
      const fullPath = join(dir, name)
      try {
        const s = await stat(fullPath)
        return { name, mtimeMs: s.mtimeMs, size: s.size }
      } catch {
        return null
      }
    }),
  )

  const valid = entries.filter((e): e is NonNullable<typeof e> => e !== null)
  valid.sort((a, b) => b.mtimeMs - a.mtimeMs)

  const toRemove = valid.slice(maxFiles)
  let totalRemovedBytes = 0
  for (const entry of toRemove) {
    try {
      await rm(join(dir, entry.name))
      totalRemovedBytes += entry.size
      if (logger.isEnabled("debug")) {
        logger.debug("tool.result.cleanup", { removed: entry.name, size: entry.size })
      }
    } catch (e) {
      if (logger.isEnabled("warn")) {
        logger.warn("tool.result.cleanup_error", { file: entry.name, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  // CL-31: Reclaim memory count for removed files
  if (totalRemovedBytes > 0) {
    subtractByteUsage(sessionId, totalRemovedBytes)
  }
}

export function resetSessionByteUsage(sessionId?: string): void {
  if (sessionId) {
    sessionByteUsage.delete(sessionId)
    sessionInitialized.delete(sessionId)
  } else {
    sessionByteUsage.clear()
    sessionInitialized.clear()
  }
}

export function getSessionByteUsage(sessionId: string): number {
  return sessionByteUsage.get(sessionId) ?? 0
}

function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
}

export { DEFAULT_MAX_RESULT_CHARS, DEFAULT_PREVIEW_CHARS, DEFAULT_SESSION_QUOTA_BYTES }
