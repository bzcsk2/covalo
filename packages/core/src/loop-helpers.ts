import type { ToolCall } from "./types.js"
import type { LoopEvent } from "./interface.js"
import type { ContextManager } from "./context/manager.js"
import type { AsyncSessionWriter } from "./session.js"
import { createHash, randomUUID } from "node:crypto"
import type { PendingInstruction } from "./loop.js"

// ─── Tool Call ID Normalize ───

/**
 * L8: Tool call ID normalizer（per-engine 实例）。
 *
 * 原先是模块级全局变量 toolCallSeq，多个并发的 runLoop（subagent 场景）
 * 会共享同一个计数器，per-turn reset 语义在并发场景下被破坏。
 *
 * 现在改为 factory 模式：每个 engine/loop 持有独立实例，互不影响。
 * randomUUID() 已保证全局唯一性，seq 仅用于人类可读排序。
 */
export interface ToolCallIdNormalizer {
  normalize(rawId: string | undefined, toolName: string): string
  reset(): void
}

export function createToolCallIdNormalizer(): ToolCallIdNormalizer {
  let seq = 0
  return {
    normalize(rawId, toolName) {
      if (rawId && rawId.trim()) return rawId.trim()
      return `${toolName}-${++seq}-${randomUUID()}`
    },
    reset() {
      seq = 0
    },
  }
}

// 向后兼容：保留模块级默认实例的导出（仅供未迁移的调用方使用）。
// 新代码应使用 createToolCallIdNormalizer() 创建独立实例。
const defaultNormalizer = createToolCallIdNormalizer()

/** CL-51: Normalize tool call ID: ensure non-empty, stable, unique per turn. */
export function normalizeToolCallId(rawId: string | undefined, toolName: string): string {
  return defaultNormalizer.normalize(rawId, toolName)
}

/** CL-51: Reset per-turn sequence counter. */
export function resetToolCallSeq(): void {
  defaultNormalizer.reset()
}

// ─── Duplicate Tool-Call Detector ───

export interface DuplicateDetector {
  check: (tc: ToolCall) => { duplicate: boolean; blocked: boolean; count: number; warning?: string }
}

export const DUPLICATE_TOOL_WARNING_THRESHOLD = 3
export const DUPLICATE_TOOL_BLOCK_THRESHOLD = 5

/**
 * CL-51: Tracks tool calls and detects loops (same tool+args called repeatedly).
 * Pure data structure — no side effects.
 */
export function createDuplicateDetector(): DuplicateDetector {
  const recentToolCalls = new Map<string, number>()

  return {
    check(tc) {
      const key = `${tc.function.name}:${tc.function.arguments}`
      const count = (recentToolCalls.get(key) ?? 0) + 1
      recentToolCalls.set(key, count)
      if (count >= DUPLICATE_TOOL_BLOCK_THRESHOLD) {
        return {
          duplicate: true,
          blocked: true,
          count,
          warning: `Tool call loop stopped: ${tc.function.name} called ${count} times with identical arguments`,
        }
      }
      if (count >= DUPLICATE_TOOL_WARNING_THRESHOLD) {
        return {
          duplicate: true,
          blocked: false,
          count,
          warning: `Tool call loop detected: ${tc.function.name} called ${count} times with identical arguments`,
        }
      }
      return { duplicate: false, blocked: false, count }
    },
  }
}

// ─── Repeated Tool-Failure Tracker ───

/**
 * S2-1: 按 {toolName, normalizedArgs, errorSignature} 追踪重复失败。
 * 同一 signature 连续失败 N 次才报告 blocked=true，避免误伤调试流程
 * （如：typecheck 失败 → 修复 → typecheck 又失败但参数或错误信息不同，不算重复）。
 */
export interface RepeatedFailureTracker {
  record: (
    toolName: string,
    args: Record<string, unknown>,
    errorContent: string,
  ) => { count: number; threshold: number; blocked: boolean }
  /** 成功调用时清除该 (toolName, args) 下所有失败签名的计数 */
  clear: (toolName: string, args: Record<string, unknown>) => void
}

export const REPEATED_FAILURE_THRESHOLD = 3

export function createRepeatedFailureTracker(): RepeatedFailureTracker {
  // fullKey → count
  const counts = new Map<string, number>()
  // argsHashPrefix(16 char) → Set<fullKey>
  const argsIndex = new Map<string, Set<string>>()

  function argsHashPrefix(toolName: string, args: Record<string, unknown>): string {
    return createHash("sha256")
      .update(toolName)
      .update(JSON.stringify(args))
      .digest("hex")
      .slice(0, 16)
  }

  function fullKey(toolName: string, args: Record<string, unknown>, errorContent: string): string {
    return createHash("sha256")
      .update(toolName)
      .update(JSON.stringify(args))
      .update(errorContent.slice(0, 300))
      .digest("hex")
      .slice(0, 16)
  }

  return {
    record(toolName, args, errorContent) {
      const k = fullKey(toolName, args, errorContent)
      const count = (counts.get(k) ?? 0) + 1
      counts.set(k, count)
      const ak = argsHashPrefix(toolName, args)
      if (!argsIndex.has(ak)) argsIndex.set(ak, new Set())
      argsIndex.get(ak)!.add(k)
      return {
        count,
        threshold: REPEATED_FAILURE_THRESHOLD,
        blocked: count >= REPEATED_FAILURE_THRESHOLD,
      }
    },
    clear(toolName, args) {
      const ak = argsHashPrefix(toolName, args)
      const keys = argsIndex.get(ak)
      if (keys) {
        for (const k of keys) counts.delete(k)
        argsIndex.delete(ak)
      }
    },
  }
}

// ─── Pending Instruction Safe-Point ───

/**
 * CL-51: Consume one pending instruction from the queue and inject it into context.
 * Returns a status event if an instruction was injected, null otherwise.
 */
export function injectPendingInstruction(
  takePendingInstruction: (() => PendingInstruction | null) | undefined,
  ctx: ContextManager,
  sessionWriter: AsyncSessionWriter | undefined,
  turnCount: number,
): LoopEvent | null {
  const pending = takePendingInstruction?.()
  if (!pending) return null
  ctx.log.append({ role: "user", content: pending.content })
  sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
  return {
    role: "status",
    content: "instruction_injected",
    metadata: {
      kind: "instruction_injected",
      queueLength: pending.remaining,
      turnCount,
    },
  }
}
