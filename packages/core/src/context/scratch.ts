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
 * 三区域上下文分区的第三部分。
 * 参考 Reasonix (github.com/bczsk2/reasonix-core) 的
 * VolatileScratch 设计：每轮清空，用于暂存当前轮的
 * 思考过程、中间状态、或辅助指令。
 *
 * 参考 Reasonix 源码: src/context/VolatileScratch.ts
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

  // 按来源替换消息：先删除该来源全部消息，再追加新消息
  replaceSource(source: ScratchSource, messages: ChatMessage[]): void {
    this.entries = this.entries.filter(e => e.source !== source)
    for (const message of messages) {
      this.entries.push({ source, message: cloneChatMessage(message) })
    }
  }

  // 按来源删除消息
  removeSource(source: ScratchSource): void {
    this.entries = this.entries.filter(e => e.source !== source)
  }

  // 重置暂存区：清空所有消息（每轮开始前调用）
  reset(): void {
    this.entries = []
  }

  // 获取当前暂存区消息的只读视图
  get messages(): readonly ChatMessage[] {
    return cloneChatMessages(this.entries.map(e => e.message))
  }
}
