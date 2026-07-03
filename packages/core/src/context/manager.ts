import type { ChatMessage, ToolCall } from "../types.js"
import { AppendOnlyLog } from "./append-log.js"
import { ImmutablePrefix } from "./immutable.js"
import { VolatileScratch } from "./scratch.js"
import { getFoldDecision, estimateTokens } from "./token-estimator.js"
import type { FoldDecision } from "./token-estimator.js"
import { ContextSummary } from "./summary.js"
import type { ContextSummarizer } from "./summarizer.js"

export interface ContextBudget {
  prefixTokens: number
  summaryTokens: number
  logTokens: number
  scratchTokens: number
  totalTokens: number
  window: number
  ratio: number
}

export type ContextReductionMode = "trim" | "compress"
export type { ContextPolicyMode } from "./policy.js"

export interface ContextReductionResult {
  mode: ContextReductionMode
  beforeTokens: number
  afterTokens: number
  targetTokens: number
  removedMessages: number
  summaryTokens: number
}

export class ContextManager {
  readonly prefix: ImmutablePrefix
  readonly log: AppendOnlyLog
  readonly scratch: VolatileScratch
  private summary: ContextSummary
  private summarizer?: ContextSummarizer
  private maxRounds: number

  constructor(maxRounds = 20, private contextWindow = 128_000) {
    this.prefix = new ImmutablePrefix()
    this.log = new AppendOnlyLog()
    this.scratch = new VolatileScratch()
    this.summary = new ContextSummary()
    this.maxRounds = maxRounds
  }

  getContextWindow(): number { return this.contextWindow }

  getMaxRounds(): number { return this.maxRounds }

  updateContextWindow(window: number): void {
    this.contextWindow = window
  }

  estimateTokens(): number {
    return estimateTokens(this.buildMessages())
  }

  getBudget(): ContextBudget {
    const prefixTokens = estimateTokens([...this.prefix.messages])
    const summaryTokens = estimateTokens(this.summary.getMessages())
    const log = this.prepareLog()
    const logTokens = estimateTokens(log)
    const scratchTokens = estimateTokens([...this.scratch.messages])
    const totalTokens = prefixTokens + summaryTokens + logTokens + scratchTokens
    return { prefixTokens, summaryTokens, logTokens, scratchTokens, totalTokens, window: this.contextWindow, ratio: totalTokens / this.contextWindow }
  }

  getFoldDecision(): FoldDecision {
    const used = this.estimateTokens()
    return getFoldDecision(used, this.contextWindow)
  }

  shutdown(): void {
    // No-op: TokenizerPool removed in RM-30
  }

  private prepareLog(): ChatMessage[] {
    let log = [...this.log.messages]
    if (this.maxRounds > 0) {
      log = this.truncateByRounds(log)
    }
    // M1-fix: 截断前先修复，避免 orphaned tool_result 撑爆 token 估算
    // 导致 truncateToBudget 过度删除整 round（丢失有效上下文）
    log = this.repairMessageStructure(log)
    log = this.truncateToBudget(log)
    return log
  }

  buildMessages(): ChatMessage[] {
    const prefixMsgs = this.prefix.messages
    const summaryMsgs = this.summary.getMessages()
    const scratchMsgs = this.scratch.messages

    const log = this.prepareLog()

    // CL-30: Check prefix alone exceeds window — configuration error
    const prefixTokens = estimateTokens([...prefixMsgs])
    if (prefixTokens > this.contextWindow) {
      throw new Error(`Context budget exceeded: prefix alone (${prefixTokens}t) exceeds window (${this.contextWindow}t)`)
    }

    const scratchTokens = estimateTokens([...scratchMsgs])
    if (scratchTokens > this.contextWindow) {
      throw new Error(`Context budget exceeded: scratch alone (${scratchTokens}t) exceeds window (${this.contextWindow}t)`)
    }

    // ADV-BUG-03 + M1-fix: 先修复消息结构，再算 token，再判断预算。
    // 原先先算 token 再修复，修复后不重新算 token：
    //  1. 预算内分支：修复插入占位 tool_result 后可能超窗，却静默返回
    //  2. 超预算分支：修复删除 orphaned tool_result 后可能已回到预算内，
    //     却仍走 aggressive truncation，丢失不必要的上下文
    // 现在以「修复后的最终消息」作为预算校验基准。
    const summaryTokens = estimateTokens(summaryMsgs)
    let allMessages = this.repairMessageStructure([...prefixMsgs, ...summaryMsgs, ...log, ...scratchMsgs])
    let totalTokens = estimateTokens(allMessages)

    if (totalTokens <= this.contextWindow) {
      return allMessages
    }

    // Log warning for diagnostics
    if (this.contextWindow > 0) {
      console.warn(
        `[ContextManager] Final budget exceeded: ${totalTokens}t > ${this.contextWindow}t. ` +
        `Attempting aggressive truncation.`
      )
    }

    // ADV-BUG-03: Aggressive truncation — remove oldest rounds until under budget
    const truncatedLog = this.aggressiveTruncate(log, prefixTokens, summaryTokens, scratchTokens)
    let truncatedMessages = this.repairMessageStructure([...prefixMsgs, ...summaryMsgs, ...truncatedLog, ...scratchMsgs])
    const finalTokens = estimateTokens(truncatedMessages)

    if (finalTokens > this.contextWindow) {
      // ADV-BUG-03: Throw diagnostic error — cannot continue to provider
      throw new Error(
        `[ContextManager] FATAL: Unable to fit within budget after aggressive truncation. ` +
        `Total: ${finalTokens}t, Window: ${this.contextWindow}t. ` +
        `Cannot proceed with provider request. Consider increasing context window or reducing system prompt size.`
      )
    }

    return truncatedMessages
  }

  /**
   * M1: 检测并修复消息结构中的孤儿 tool_call / tool_result（基于全局 ID 配对）。
   * - orphaned tool_call（assistant 有 tool_calls 但全序列无对应 tool_result）：
   *   在该 assistant 消息后插入占位 tool_result（is_error: true）。
   * - orphaned tool_result（tool 消息全序列无对应 tool_call）：
   *   删除该 tool 消息。
   *
   * 职责边界（M1-clarify）：
   *   本方法只做「全局 ID 配对」层面的修复，不保证 OpenAI tool-call 协议要求的
   *   「assistant tool_calls 紧跟对应 tool_result」严格相邻序列。provider 协议
   *   合法性的最终兜底由 client.ts 的 repairToolCallSequence() 统一保证（它维护
   *   pending tool calls 状态机，遇到非 tool 消息前自动补齐）。
   *   本方法负责上下文层的展示/截断一致性，避免 ContextManager 拼装的消息
   *   因双向孤儿导致 token 估算严重偏差或日志混乱。
   *
   * 返回修复后的新数组（不修改原数组）。
   */
  private repairMessageStructure(messages: ChatMessage[]): ChatMessage[] {
    const toolCallIds = new Set<string>()
    const toolResultIds = new Set<string>()

    for (const msg of messages) {
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolCallIds.add(tc.id)
        }
      }
      if (msg.role === "tool" && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id)
      }
    }

    // 双向检测孤儿
    const orphanedToolCallIds = new Set<string>()
    for (const tcId of toolCallIds) {
      if (!toolResultIds.has(tcId)) orphanedToolCallIds.add(tcId)
    }
    const orphanedToolResultIds = new Set<string>()
    for (const trId of toolResultIds) {
      if (!toolCallIds.has(trId)) orphanedToolResultIds.add(trId)
    }

    if (orphanedToolCallIds.size === 0 && orphanedToolResultIds.size === 0) {
      return messages
    }

    // 修复：构建新数组
    const repaired: ChatMessage[] = []
    for (const msg of messages) {
      // 删除 orphaned tool_result（无对应 tool_call）
      if (msg.role === "tool" && msg.tool_call_id && orphanedToolResultIds.has(msg.tool_call_id)) {
        console.warn(
          `[ContextManager] Removing orphaned tool_result: ${msg.tool_call_id} has no corresponding tool_call.`
        )
        continue
      }
      repaired.push(msg)
      // 为 orphaned tool_call 插入占位 tool_result
      if (msg.role === "assistant" && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (orphanedToolCallIds.has(tc.id)) {
            console.warn(
              `[ContextManager] Inserting placeholder tool_result for orphaned tool_call: ${tc.id}.`
            )
            repaired.push({
              role: "tool",
              tool_call_id: tc.id,
              content: "[result unavailable: truncated]",
              name: tc.function.name,
              is_error: true,
            })
          }
        }
      }
    }

    return repaired
  }

  /**
   * Find the end index of the first complete round starting from a user message.
   * A round ends at the next user message or at the end of the array.
   * If `startUserIdx` points to a non-user message, returns 0.
   */
  private findFirstCompleteRoundEnd(messages: ChatMessage[], startUserIdx: number): number {
    if (messages[startUserIdx]?.role !== "user") return 0
    for (let i = startUserIdx + 1; i < messages.length; i++) {
      if (messages[i].role === "user") return i
    }
    return messages.length
  }

  /**
   * Strip orphan tool/assistant messages at the beginning of the log
   * that have no preceding user message.
   */
  private stripLeadingOrphans(log: ChatMessage[]): ChatMessage[] {
    let idx = 0
    while (idx < log.length && log[idx].role !== "user") {
      idx++
    }
    return idx > 0 ? log.slice(idx) : log
  }

  /**
   * ADV-BUG-03: Aggressive truncation when over budget.
   * Removes oldest rounds while preserving structure.
   */
  private aggressiveTruncate(
    log: ChatMessage[],
    prefixTokens: number,
    summaryTokens: number,
    scratchTokens: number,
  ): ChatMessage[] {
    const availableTokens = this.contextWindow - prefixTokens - summaryTokens - scratchTokens
    if (availableTokens <= 0) return []
    
    let current = this.stripLeadingOrphans([...log])
    let estimated = estimateTokens(current)
    
    while (estimated > availableTokens && current.length > 0) {
      const firstUserIdx = current.findIndex(m => m.role === "user")
      if (firstUserIdx < 0) break
      const roundEnd = this.findFirstCompleteRoundEnd(current, firstUserIdx)
      if (roundEnd <= 0) break
      current = current.slice(roundEnd)
      estimated = estimateTokens(current)
    }
    
    return current
  }

  reduceToTarget(mode: ContextReductionMode, targetRatio: number): ContextReductionResult {
    const targetTokens = Math.max(1, Math.floor(this.contextWindow * targetRatio))
    const beforeTokens = estimateTokens(this.buildMessages())
    if (beforeTokens <= targetTokens) {
      return {
        mode,
        beforeTokens,
        afterTokens: beforeTokens,
        targetTokens,
        removedMessages: 0,
        summaryTokens: estimateTokens(this.summary.getMessages()),
      }
    }

    const originalLog = [...this.log.messages]
    const protectedStart = this.lastRoundStart(originalLog)
    const protectedTail = protectedStart >= 0 ? originalLog.slice(protectedStart) : []
    let current = protectedStart >= 0 ? originalLog.slice(0, protectedStart) : [...originalLog]
    const removed: ChatMessage[] = []

    const estimateWithTail = (candidate: ChatMessage[]): number =>
      estimateTokens([...this.prefix.messages, ...this.summary.getMessages(), ...candidate, ...protectedTail, ...this.scratch.messages])

    while (current.length > 0 && estimateWithTail(current) > targetTokens) {
      const end = this.firstRoundEnd(current)
      removed.push(...current.slice(0, end))
      current = current.slice(end)
    }

    if (mode === "compress" && removed.length > 0) {
      const summaryContent = this.createSummaryContent(removed)
      this.summary.replace(summaryContent)
      while (current.length > 0 && estimateWithTail(current) > targetTokens) {
        const end = this.firstRoundEnd(current)
        current = current.slice(end)
      }
    }

    this.log.replaceAll([...current, ...protectedTail])
    const afterTokens = estimateTokens(this.buildMessages())
    return {
      mode,
      beforeTokens,
      afterTokens,
      targetTokens,
      removedMessages: removed.length,
      summaryTokens: estimateTokens(this.summary.getMessages()),
    }
  }

  private firstRoundEnd(messages: ChatMessage[]): number {
    if (messages.length === 0) return 0
    const firstUserIdx = messages.findIndex(m => m.role === "user")
    if (firstUserIdx < 0) return messages.length
    return this.findFirstCompleteRoundEnd(messages, firstUserIdx)
  }

  private lastRoundStart(messages: ChatMessage[]): number {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return i
    }
    return -1
  }

  private createSummaryContent(messages: ChatMessage[]): string {
    const existing = this.summary.getRawContent()
    const lines = messages.map((message) => {
      const raw = message.content ?? ""
      const content = raw.replace(/\s+/g, " ").trim()
      const clipped = content.length > 240 ? `${content.slice(0, 239)}...` : content
      return `${message.role}: ${clipped}`
    }).filter(line => !line.endsWith(": "))

    return [
      "Previous conversation summary:",
      existing,
      lines.join("\n"),
      "This summary was generated to reduce context usage. Newer messages override this summary when conflicts exist.",
    ].filter(Boolean).join("\n\n")
  }

  private truncateByRounds(log: ChatMessage[]): ChatMessage[] {
    const userIdx: number[] = []
    for (let i = 0; i < log.length; i++) {
      if (log[i].role === "user") userIdx.push(i)
    }
    if (userIdx.length <= this.maxRounds) return log

    let cutFrom = userIdx[userIdx.length - this.maxRounds]
    for (let i = cutFrom; i < log.length; i++) {
      if (log[i].role === "tool" && (i === 0 || log[i - 1].role !== "assistant")) {
        while (i < log.length && log[i].role !== "user") i++
        cutFrom = i
        break
      }
    }
    return log.slice(cutFrom)
  }

  private truncateToBudget(log: ChatMessage[]): ChatMessage[] {
    if (log.length === 0) return log

    const baselineTokens = estimateTokens([...this.prefix.messages, ...this.summary.getMessages(), ...this.scratch.messages])

    let current = this.stripLeadingOrphans([...log])
    let estimated = estimateTokens(current)

    while (estimated + baselineTokens > this.contextWindow && current.length > 0) {
      const firstUserIdx = current.findIndex(m => m.role === "user")
      if (firstUserIdx < 0) break
      const roundEnd = this.findFirstCompleteRoundEnd(current, firstUserIdx)
      if (roundEnd <= 0) break
      current = current.slice(roundEnd)
      estimated = estimateTokens(current)
    }

    return current
  }

  startTurn(): void {
    this.scratch.reset()
  }

  getSummary(): ContextSummary {
    return this.summary
  }

  setSummarizer(summarizer: ContextSummarizer): void {
    this.summarizer = summarizer
  }

  async runSummarize(targetTokens: number, signal?: AbortSignal): Promise<boolean> {
    if (!this.summarizer) return false

    const log = [...this.log.messages]
    if (log.length === 0) return false

    try {
      const result = await this.summarizer.summarize(
        {
          messages: log,
          currentSummary: this.summary.getRawContent(),
          targetTokens,
        },
        signal,
      )

      if (result.summary) {
        this.summary.replace(result.summary)
        return true
      }
      return false
    } catch {
      return false
    }
  }
}
