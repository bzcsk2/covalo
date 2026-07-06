import { resolve } from "node:path"
import { AsyncSessionWriter } from "../session.js"
import type { SessionStats } from "../interface.js"

export class EngineSessionRuntime {
  sessionId: string
  stats: SessionStats = {
    promptTokens: 0, completionTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0,
    apiCalls: 0, toolCalls: 0, totalCost: 0,
  }
  sessionWriter?: AsyncSessionWriter

  constructor(sessionId: string) {
    this.sessionId = sessionId
  }

  getSessionId(): string {
    return this.sessionId
  }

  updateSessionId(sessionId: string): void {
    this.sessionId = sessionId
  }

  rebindSessionWriter(baseDir: string): void {
    const sessionPath = resolve(baseDir, ".covalo", "sessions", `${this.sessionId}.jsonl`)
    const writer = new AsyncSessionWriter(sessionPath)
    writer.init().catch(() => {})
    this.sessionWriter = writer
  }

  resetStats(): void {
    this.stats = {
      promptTokens: 0, completionTokens: 0,
      cacheHitTokens: 0, cacheMissTokens: 0,
      apiCalls: 0, toolCalls: 0, totalCost: 0,
    }
  }

  async drainWriter(): Promise<void> {
    await this.sessionWriter?.drain()
  }

}
