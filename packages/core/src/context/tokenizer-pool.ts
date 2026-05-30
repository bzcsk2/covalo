import { Worker } from "node:worker_threads"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { estimateTokens as fallbackEstimate } from "./token-estimator.js"
import type { ChatMessage } from "../types.js"

type TaskId = number

interface TaskEntry {
  resolve: (value: number) => void
  reject: (reason: unknown) => void
}

export class TokenizerPool {
  private worker?: Worker
  private tasks = new Map<TaskId, TaskEntry>()
  private nextId = 1
  private healthy = true
  private consecutiveTimeouts = 0

  constructor() {
    try {
      const __dirname = dirname(fileURLToPath(import.meta.url))
      const workerPath = resolve(__dirname, "tokenizer-worker.js")
      this.worker = new Worker(workerPath)
      this.worker.on("message", (msg: { id: TaskId; result: number }) => {
        this.consecutiveTimeouts = 0
        const entry = this.tasks.get(msg.id)
        if (entry) {
          this.tasks.delete(msg.id)
          entry.resolve(msg.result)
        }
      })
      this.worker.on("error", () => { this.healthy = false })
      this.worker.on("exit", (code) => {
        if (code !== 0) this.healthy = false
      })
    } catch {
      this.healthy = false
    }
  }

  async estimate(messages: ChatMessage[]): Promise<number> {
    if (!this.healthy || !this.worker) return fallbackEstimate(messages)

    const id = this.nextId++
    return new Promise<number>((resolve, reject) => {
      this.tasks.set(id, { resolve, reject })
      this.worker!.postMessage({ id, messages })
      // timeout guard: if worker hangs, fallback to main thread
      setTimeout(() => {
        if (this.tasks.has(id)) {
          this.tasks.delete(id)
          this.consecutiveTimeouts++
          if (this.consecutiveTimeouts >= 3) this.healthy = false
          resolve(fallbackEstimate(messages))
        }
      }, 5_000)
    })
  }

  shutdown(): void {
    this.worker?.terminate().catch(() => {})
    this.tasks.clear()
  }
}
