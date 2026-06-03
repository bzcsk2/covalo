import type { SessionStats } from "./interface.js"

export interface EngineStatusSnapshot {
  sessionId: string
  context: {
    prefixTokens: number
    logTokens: number
    scratchTokens: number
    totalTokens: number
    window: number
    ratio: number
  }
  stats: SessionStats
  currentAgent: string
  isSubmitting: boolean
  timestamp: string
}
