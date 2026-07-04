import type { AgentTool, ToolResult, ToolProgressUpdate } from "./interface.js"
import type { ToolCall } from "./types.js"
import type { PermissionEngine, HookManager, PermissionDecision } from "@covalo/security"
import { maybePersistResult, type ResultPersistenceConfig } from "./result-persistence.js"
import { type RuntimeLogger } from "./runtime-logger.js"
import { repairToolArguments } from "./context/repair.js"
import { normalizeToolArguments } from "./tool-arguments/normalizer.js"

// ─── Permission Decision Helper ───

export type PermissionOutcome = "allow" | "deny" | "ask" | "invalid"

export type ParsedToolCallArgs =
  | { ok: true; args: Record<string, unknown>; repaired: boolean }
  | { ok: false; error: string }

export function parseToolCallArgs(raw: string, toolName: string): ParsedToolCallArgs {
  let args: Record<string, unknown>
  let repaired = false
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: `Invalid JSON arguments for tool ${toolName}: arguments must be a JSON object` }
    }
    args = parsed as Record<string, unknown>
  } catch {
    const repairResult = repairToolArguments(raw)
    if (!repairResult.success) {
      return { ok: false, error: `Invalid JSON arguments for tool ${toolName}: failed all repair stages` }
    }
    if (repairResult.partial) {
      return { ok: false, error: `Invalid JSON arguments for tool ${toolName}: partial repair is unsafe` }
    }
    args = repairResult.args
    repaired = true
  }
  return { ok: true, args: normalizeToolArguments(args), repaired }
}

/**
 * CL-50: Evaluate whether a tool call should be allowed, denied, or requires user confirmation.
 * Pure function — no side effects beyond the provided callbacks.
 *
 * Phase 2.1: PermissionService 分支已从生产路径移除（路径 B：deprecate）。
 * PermissionService 模块本身保留为 @deprecated，未来版本将移除。
 * 生产权限决策走 PermissionEngine（@covalo/security）。
 */
export async function evaluatePermission(
  tc: ToolCall,
  tools: Map<string, AgentTool>,
  permissionEngine?: PermissionEngine,
  hookManager?: HookManager,
  requestPermission?: (toolName: string, args: Record<string, unknown>) => { requestId: string; promise: Promise<boolean> },
  parsedArgs?: Record<string, unknown>,
): Promise<PermissionOutcome> {
  const handler = tools.get(tc.function.name)
  if (!handler) return "allow"

  const argsResult = parsedArgs ? { ok: true as const, args: parsedArgs, repaired: false } : parseToolCallArgs(tc.function.arguments, tc.function.name)
  if (!argsResult.ok) return "invalid"
  const args = argsResult.args

  // Legacy PermissionEngine check
  if (permissionEngine) {
    const check = permissionEngine.decide(tc.function.name, args, handler.approval)
    if (check?.decision !== "ask") {
      // Allow or deny from legacy engine
      return check?.decision === "allow" ? "allow" : "deny"
    }
  }

  // Hook check (runs when decision is "ask")
  let hookDecision: PermissionDecision | void
  try {
    hookDecision = await hookManager?.runBeforeToolCall({
      toolName: tc.function.name, args, tier: handler.approval,
      permissionDecision: "ask",
    })
  } catch (e) {
    hookDecision = "deny"
    if (hookManager) {
      hookManager.lastHookDenyReason = `Hook execution failed: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  if (hookDecision === "allow") return "allow"
  if (hookDecision === "deny") return "deny"
  if (requestPermission) return "ask"
  // 无权限基础设施时默认允许（测试/无头模式）
  if (!permissionEngine) return "allow"
  return "deny"
}

/**
 * 解析权限拒绝时的错误消息，优先使用 PermissionEngine 返回的 reason。
 */
export function resolveDenyMessage(
  tc: ToolCall,
  tools: Map<string, AgentTool>,
  permissionEngine?: PermissionEngine,
  args?: Record<string, unknown>,
  hookManager?: HookManager,
): string {
  // T1: Check if a hook error caused the deny — include the reason
  if (hookManager?.lastHookDenyReason) {
    const reason = hookManager.lastHookDenyReason
    hookManager.lastHookDenyReason = undefined // consume after read
    return reason
  }
  const handler = tools.get(tc.function.name)
  if (permissionEngine && handler && args) {
    const check = permissionEngine.decide(tc.function.name, args, handler.approval)
    if (check?.decision === "deny") return check.reason ?? "Permission denied"
  }
  return `Tool call denied: ${tc.function.name} requires manual approval`
}

// ─── Settle Ledger ───

export interface SettleLedger {
  settle: (tc: ToolCall, index: number, result: ToolResult) => boolean
  isSettled: (index: number) => boolean
}

/**
 * CL-50: Tracks which tool call indices have already written a result.
 * Every branch (success, error, permission deny, user deny, abort) must go
 * through settle() which checks the set before calling appendToolResult.
 */
export function createSettleLedger(
  appendToolResult: (tc: ToolCall, result: ToolResult) => void,
): SettleLedger {
  const settled = new Set<number>()

  return {
    settle(tc, index, result) {
      if (settled.has(index)) return false
      settled.add(index)
      appendToolResult(tc, result)
      return true
    },
    isSettled(index) {
      return settled.has(index)
    },
  }
}

// ─── Bounded Progress Queue ───

export interface ProgressQueue {
  push: (update: ToolProgressUpdate) => void
  flush: () => ToolProgressUpdate[]
  length: () => number
}

/**
 * CL-50: Buffers progress updates during tool execution.
 * Flush yields all buffered updates in order and resets the buffer.
 */
export function createProgressQueue(): ProgressQueue {
  const buffer: ToolProgressUpdate[] = []
  return {
    push(update) { buffer.push(update) },
    flush() { const items = [...buffer]; buffer.length = 0; return items },
    length() { return buffer.length },
  }
}

// ─── Result Persistence Adapter ───

/**
 * CL-50: Apply overflow persistence to a tool result.
 * Returns the possibly-modified result with persisted metadata attached.
 * Pure adapter — no control flow, just data transformation.
 */
export async function applyResultPersistence(
  rawResult: ToolResult,
  sessionId: string,
  toolName: string,
  config: ResultPersistenceConfig,
  hookManager?: HookManager,
  logger?: RuntimeLogger,
): Promise<ToolResult> {
  if (rawResult.isError) return rawResult

  const persisted = await maybePersistResult(
    rawResult.content,
    sessionId,
    toolName,
    config,
    logger,
  )

  const result: ToolResult = { ...rawResult, content: persisted.content }
  if (persisted.persisted) {
    result.metadata = { ...result.metadata, ...persisted.persisted }
  }
  if (persisted.warning) {
    hookManager?.runAfterToolCall(toolName, { content: persisted.warning, isError: false, metadata: { warning: true } })
  }
  return result
}
