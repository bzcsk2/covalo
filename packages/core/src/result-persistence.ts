/**
 * P4: Result Overflow Persistence
 *
 * When tool results exceed a size threshold, the full content is written to
 * a file under `.deepicode/results/<sessionId>/` and the context receives
 * only a preview with metadata pointing to the persisted file.
 */

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const DEFAULT_MAX_RESULT_CHARS = 200_000
const DEFAULT_PREVIEW_CHARS = 2_000
const DEFAULT_SESSION_QUOTA_BYTES = 50 * 1024 * 1024 // 50 MiB

export interface ResultPersistenceConfig {
  maxResultSizeChars?: number
  previewChars?: number
  sessionQuotaBytes?: number
}

export interface PersistedResult {
  /** The preview text to use in context */
  preview: string
  /** Path to the full persisted file */
  persistedPath: string
  /** Original content size in chars */
  originalChars: number
  /** Preview size in chars */
  previewChars: number
}

/**
 * Check if a tool result needs persistence and optionally persist it.
 * Returns the original result if under threshold, or a modified result
 * with preview + metadata if over threshold.
 *
 * Write failures fall back to truncated preview with a warning — never blocks main flow.
 */
export async function maybePersistResult(
  content: string,
  sessionId: string,
  toolName: string,
  config?: ResultPersistenceConfig,
): Promise<{ content: string; persisted?: PersistedResult; warning?: string }> {
  const maxChars = config?.maxResultSizeChars ?? DEFAULT_MAX_RESULT_CHARS
  if (content.length <= maxChars) {
    return { content }
  }

  const previewLen = config?.previewChars ?? DEFAULT_PREVIEW_CHARS
  const preview = content.slice(0, previewLen)

  try {
    const dir = join(process.cwd(), ".deepicode", "results", sanitizeId(sessionId))
    await mkdir(dir, { recursive: true, mode: 0o700 })

    const filename = `${sanitizeId(toolName)}-${randomUUID()}.txt`
    const filePath = join(dir, filename)
    await writeFile(filePath, content, { mode: 0o600 })

    const persisted: PersistedResult = {
      preview,
      persistedPath: filePath,
      originalChars: content.length,
      previewChars: previewLen,
    }

    return {
      content: preview,
      persisted,
    }
  } catch (e) {
    // Write failure — fall back to truncated preview with warning
    const warning = `Result persistence failed: ${e instanceof Error ? e.message : String(e)}`
    return {
      content: preview,
      warning,
    }
  }
}

/**
 * Sanitize an ID for use in file paths. Replaces non-alphanumeric chars
 * with hyphens, prevents path traversal.
 */
function sanitizeId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
}

export { DEFAULT_MAX_RESULT_CHARS, DEFAULT_PREVIEW_CHARS, DEFAULT_SESSION_QUOTA_BYTES }
