import type { ChatMessage } from "../types.js"
import { cloneChatMessage, cloneChatMessages } from "./message.js"

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
  // 内部存储：当前轮的临时消息列表
  private entries: ChatMessage[] = []

  setMessages(msgs: ChatMessage[]): void {
    this.entries = cloneChatMessages(msgs)
  }

  // 追加单条消息到暂存区
  append(message: ChatMessage): void {
    this.entries.push(cloneChatMessage(message))
  }

  // 重置暂存区：清空所有消息（每轮开始前调用）
  reset(): void {
    this.entries = []
  }

  // 获取当前暂存区消息的只读视图
  get messages(): readonly ChatMessage[] {
    return cloneChatMessages(this.entries)
  }
}
