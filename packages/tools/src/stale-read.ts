import { stat, realpath } from "node:fs/promises"

interface ReadRecord {
  mtimeMs: number
  size: number
}

const track = new Map<string, ReadRecord>()

export async function recordRead(absPath: string, mtimeMs: number, size: number): Promise<void> {
  // Normalize path for cross-platform consistency (e.g., Windows short names → full names)
  const originalPath = absPath
  try { absPath = await realpath(absPath) } catch { /* use as-is */ }
  track.set(absPath, { mtimeMs, size })
  // Also store under original path: on Windows, realpath may resolve short names
  // (e.g. ADMINI~1 → Administrator), but checkStale may fall back to the short
  // name if the file has been deleted and realpath fails.
  if (absPath !== originalPath) {
    track.set(originalPath, { mtimeMs, size })
  }
}

export function clearReadTracker(): void {
  track.clear()
}

export async function checkStale(absPath: string): Promise<{ isStale: boolean; message?: string }> {
  // Normalize for consistent lookup (e.g., Windows short names in resolvePath)
  try { absPath = await realpath(absPath) } catch { /* use as-is */ }
  const record = track.get(absPath)
  if (!record) return { isStale: false }

  let st
  try {
    st = await stat(absPath)
  } catch {
    return { isStale: true, message: "File not found or inaccessible. It may have been deleted or moved." }
  }

  if (st.mtimeMs !== record.mtimeMs || st.size !== record.size) {
    return {
      isStale: true,
      message: `File has been modified since last read (mtime or size changed). Please re-read the file with read_file first.`,
    }
  }

  return { isStale: false }
}
