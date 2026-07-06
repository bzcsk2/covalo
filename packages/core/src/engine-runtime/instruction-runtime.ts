import type { EnqueueInstructionResult } from "../interface.js"

export class EngineInstructionRuntime {
  private queue: string[] = []
  static readonly MAX_PENDING_INSTRUCTIONS = 10

  enqueue(instruction: string, isSubmitting: boolean): EnqueueInstructionResult {
    const trimmed = instruction.trim()
    if (!trimmed) {
      return { status: "ignored", queueLength: this.queue.length }
    }
    if (!isSubmitting) {
      return { status: "idle", queueLength: 0 }
    }
    if (this.queue.length >= EngineInstructionRuntime.MAX_PENDING_INSTRUCTIONS) {
      return { status: "full", queueLength: this.queue.length }
    }
    this.queue.push(trimmed)
    return { status: "queued", queueLength: this.queue.length }
  }

  takeOne(): { content: string; remaining: number } | null {
    const content = this.queue.shift()
    if (!content) return null
    return { content, remaining: this.queue.length }
  }

  clear(): void {
    this.queue = []
  }

  /** Test-only snapshot of the current queue */
  getQueueSnapshot(): string[] {
    return [...this.queue]
  }

  /** Test-only: create an instance with pre-loaded queue */
  static withQueue(items: string[]): EngineInstructionRuntime {
    const r = new EngineInstructionRuntime()
    r.queue = [...items]
    return r
  }
}
