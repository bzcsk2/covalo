import { resolve } from "node:path"
import { AsyncSessionWriter, SessionLoader } from "../session.js"
import type { SessionWriterStatus, SessionRecord } from "../session.js"
import type { SessionStats } from "../interface.js"
import type { ChatMessage } from "../types.js"

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

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    const messages = await SessionLoader.read(sessionId)
    if (messages.length > 0) {
      const nonSystem = messages.filter(m => m.role !== "system")
      return nonSystem
    }
    this.resetStats()
    return messages
  }

  resetStats(): void {
    this.stats = {
      promptTokens: 0, completionTokens: 0,
      cacheHitTokens: 0, cacheMissTokens: 0,
      apiCalls: 0, toolCalls: 0, totalCost: 0,
    }
  }

  incrementToolCalls(): void {
    this.stats.toolCalls++
  }

  async drainWriter(): Promise<void> {
    await this.sessionWriter?.drain()
  }

  getWriterStatus(): SessionWriterStatus | undefined {
    return this.sessionWriter?.getStatus()
  }

  enqueueToWriter(data: SessionRecord): void {
    this.sessionWriter?.enqueue(data)
  }
}
