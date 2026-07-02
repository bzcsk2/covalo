import type { AgentTool, ToolResult, ToolProgressUpdate } from "./interface.js"
import type { ToolCall } from "./types.js"
import type { PermissionEngine, HookManager, PermissionDecision } from "@covalo/security"
import type { PermissionService, PermissionRule } from "./permission/index.js"
import { evaluateRules, fromConfig, createSessionRule } from "./permission/index.js"
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
 * Extract resource patterns from tool arguments for permission evaluation.
 */
function extractResourcePatterns(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  // File path patterns
  const filePath = args.filePath ?? args.path ?? args.file
  if (typeof filePath === "string") {
    return [filePath]
  }

  // Shell command patterns
  const command = args.command ?? args.cmd
  if (typeof command === "string" && (toolName === "bash" || toolName === "exec" || toolName === "shell")) {
    return [command]
  }

  // URL patterns
  const url = args.url ?? args.query
  if (typeof url === "string" && (toolName === "webfetch" || toolName === "websearch")) {
    return [url]
  }

  // Generic pattern fallback
  return [toolName]
}

/**
 * CL-50: Evaluate whether a tool call should be allowed, denied, or requires user confirmation.
 * Pure function — no side effects beyond the provided callbacks.
 *
 * Supports both the legacy PermissionEngine and the new PermissionService.
 */
export async function evaluatePermission(
  tc: ToolCall,
  tools: Map<string, AgentTool>,
  permissionEngine?: PermissionEngine,
  hookManager?: HookManager,
  requestPermission?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>,
  parsedArgs?: Record<string, unknown>,
  permissionService?: PermissionService,
  configRules?: PermissionRule[],
  sessionId?: string,
): Promise<PermissionOutcome> {
  const handler = tools.get(tc.function.name)
  if (!handler) return "allow"

  const argsResult = parsedArgs ? { ok: true as const, args: parsedArgs, repaired: false } : parseToolCallArgs(tc.function.arguments, tc.function.name)
  if (!argsResult.ok) return "invalid"
  const args = argsResult.args

  // Extract resource patterns for the new permission system
  const patterns = extractResourcePatterns(tc.function.name, args)

  // Try new permission system first (if available)
  if (permissionService && sessionId) {
    // Check session-approved rules first
    if (permissionService.matchesSessionRules({
      id: "",
      sessionId,
      permission: tc.function.name,
      patterns,
      always: [],
      metadata: {},
    })) {
      return "allow"
    }

    // Evaluate against config rules
    const sessionRules = permissionService.getSessionRules(sessionId)
    const decision = evaluateRules(
      tc.function.name,
      patterns[0] ?? "*",
      configRules ?? [],
      sessionRules,
    )

    if (decision === "allow") return "allow"
    if (decision === "deny") return "deny"
    // If "ask", continue to legacy system and hook checks
  }

  // Legacy PermissionEngine check
  if (permissionEngine) {
    const check = permissionEngine.decide(tc.function.name, args, handler.approval)
    if (check?.decision !== "ask") {
      // Allow or deny from legacy engine
      return check?.decision === "allow" ? "allow" : "deny"
    }
  }

  // Hook check (runs for both systems when decision is "ask")
  let hookDecision: PermissionDecision | void
  try {
    hookDecision = await hookManager?.runBeforeToolCall({
      toolName: tc.function.name, args, tier: handler.approval,
      permissionDecision: "ask",
    })
  } catch {
    hookDecision = "deny"
  }

  if (hookDecision === "allow") return "allow"
  if (hookDecision === "deny") return "deny"
  if (requestPermission) return "ask"
  // 无权限基础设施时默认允许（测试/无头模式）
  if (!permissionEngine && !permissionService) return "allow"
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
): string {
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
  unsettledIndices: () => number[]
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
    unsettledIndices() {
      const indices: number[] = []
      // We don't know the total count here, so callers track via toolCalls.length
      return indices
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
