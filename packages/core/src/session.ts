import { mkdir, appendFile, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { ChatMessage } from "./types.js"

export interface SessionRecord {
  ts: number
  type: "event" | "messages" | "stats"
  payload: unknown
}

export class SessionLoader {
  static sessionDir = `${process.cwd()}/.deepicode/sessions`

  static async read(sessionId: string): Promise<ChatMessage[]> {
    const path = resolve(this.sessionDir, `${sessionId}.jsonl`)
    let raw: string
    try {
      raw = await readFile(path, "utf-8")
    } catch {
      return []
    }
    const lines = raw.trim().split("\n")
    // Scan from end to find the most recent valid messages record
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const rec: SessionRecord = JSON.parse(lines[i])
        if (rec.type === "messages" && Array.isArray(rec.payload)) {
          return rec.payload as ChatMessage[]
        }
      } catch {
        continue
      }
    }
    return []
  }
}

export class AsyncSessionWriter {
  private path: string
  private queue: string[] = []
  private flushing = false
  private initPromise?: Promise<void>

  constructor(path: string) {
    this.path = path
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = mkdir(dirname(this.path), { recursive: true }).then(() => {})
    }
    await this.initPromise
  }

  enqueue(record: SessionRecord): void {
    try {
      this.queue.push(JSON.stringify(record) + "\n")
      void this.flushSoon()
    } catch {
      // best-effort: drop unserializable records silently
    }
  }

  private async flushSoon(): Promise<void> {
    if (this.flushing) return
    this.flushing = true
    try {
      if (this.initPromise) {
        await this.initPromise.catch(() => {}) // wait for init to finish (or fail)
      }
      while (this.queue.length > 0) {
        const chunk = this.queue.splice(0, 50).join("")
        await appendFile(this.path, chunk, "utf-8")
      }
    } catch {
      // best-effort: swallow write errors silently
    } finally {
      this.flushing = false
      if (this.queue.length > 0) {
        void this.flushSoon()
      }
    }
  }
}
