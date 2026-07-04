import type { ChatMessage } from "../types.js"
import { cloneChatMessage, cloneChatMessages } from "./message.js"

/**
 * ScratchSource — 每条 scratch 消息的来源标记。
 */
export type ScratchSource = "task_ledger" | "supervisor_advice" | "pending_instruction" | "runtime" | "experience_recall"

interface ScratchEntry {
  source: ScratchSource
  message: ChatMessage
}

/**
 * VolatileScratch — 每轮临时状态（易失区域）
 *
 * SPEC-B: source-aware scratch — 每条消息带 source 标记，
 * 允许按来源精确替换/删除，避免 reset() 全量清空非 ledger 内容。
 *
 * 参考 Reasonix (github.com/bczsk2/reasonix-core) 的
 * VolatileScratch 设计：每轮清空，用于暂存当前轮的
 * 思考过程、中间状态、或辅助指令。
 */
export class VolatileScratch {
  // 内部存储：带来源标记的临时消息列表
  private entries: ScratchEntry[] = []

  setMessages(msgs: ChatMessage[]): void {
    this.entries = cloneChatMessages(msgs).map(m => ({ source: "runtime" as ScratchSource, message: m }))
  }

  // 追加单条消息到暂存区
  append(message: ChatMessage, source: ScratchSource = "runtime"): void {
    this.entries.push({ source, message: cloneChatMessage(message) })
  }

  // SPEC-B: 替换指定 source 的所有消息，不删除其他 source
  replaceSource(source: ScratchSource, messages: ChatMessage[]): void {
    this.entries = this.entries.filter(e => e.source !== source)
    for (const message of messages) {
      this.entries.push({ source, message: cloneChatMessage(message) })
    }
  }

  // SPEC-B: 移除指定 source 的所有消息
  removeSource(source: ScratchSource): void {
    this.entries = this.entries.filter(e => e.source !== source)
  }

  reset(): void {
    this.entries = []
  }

  get messages(): readonly ChatMessage[] {
    return cloneChatMessages(this.entries.map(e => e.message))
  }
}
