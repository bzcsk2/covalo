import type { RuntimeLogger } from "../runtime-logger.js"
import type { ContextManager } from "../context/manager.js"
import type { EffectiveHarnessPolicy } from "../harness/index.js"
import type { AgentRole } from "../agent-profile/types.js"
import type { ToolCall } from "../types.js"
import type { LoopEvent } from "../interface.js"

export type ToolBatchSource = "native" | "salvage"

export interface ToolBatchInfo {
  source: ToolBatchSource
}

export interface ToolResultInfo {
  source: ToolBatchSource
  toolCalls: readonly ToolCall[]
  toolCall?: ToolCall
  parsedArgs?: Record<string, unknown>
}

export interface LoopPolicyEventEmission {
  event: LoopEvent
  sessionEvent?: LoopEvent
}

export type LoopPolicyEventResult =
  | void
  | LoopEvent
  | LoopPolicyEventEmission
  | readonly (LoopEvent | LoopPolicyEventEmission)[]

export interface LoopPolicyContext {
  turnCount: number
  logger: RuntimeLogger
  signal: AbortSignal
  ctx: ContextManager
  effectivePolicy?: EffectiveHarnessPolicy
  role?: AgentRole
}

export function createPolicyContext(
  turnCount: number,
  logger: RuntimeLogger,
  signal: AbortSignal,
  ctx: ContextManager,
  effectivePolicy?: EffectiveHarnessPolicy,
  role?: AgentRole,
): LoopPolicyContext {
  return { turnCount, logger, signal, ctx, effectivePolicy, role }
}

export interface LoopPolicy {
  name: string
  /** Called at the start of each loop iteration, before any turn work. */
  beforeTurn?(ctx: LoopPolicyContext): Promise<void> | void
  /** Called before the model API call, after messages are built. */
  beforeModelCall?(ctx: LoopPolicyContext): Promise<void> | void
  /** Called for each event received from the model stream. */
  afterModelEvent?(ctx: LoopPolicyContext, event: unknown): Promise<void> | void
  /** Called before each tool batch execution, with the tool calls to execute. */
  beforeToolBatch?(ctx: LoopPolicyContext, toolCalls: readonly ToolCall[], info: ToolBatchInfo): Promise<void> | void
  /** Called after each tool/error event yielded from the tool executor. */
  afterToolResult?(ctx: LoopPolicyContext, event: LoopEvent, info: ToolResultInfo): Promise<LoopPolicyEventResult> | LoopPolicyEventResult
  /** Called after the entire tool batch completes (all tools settled), before safe-points. */
  afterToolBatch?(ctx: LoopPolicyContext, toolCalls: readonly ToolCall[], info: ToolBatchInfo): Promise<void> | void
  /** Called before the final done decision, while there is still time to intercept. */
  beforeFinal?(ctx: LoopPolicyContext): Promise<void> | void
  /** Called after verification gate passes, before the final-draft checkpoint. */
  beforeFinalDraft?(ctx: LoopPolicyContext): Promise<void> | void
  /** Called before a done event is yielded. */
  afterDone?(ctx: LoopPolicyContext): Promise<void> | void
  /** Called after a stream error event is confirmed, before retry logic. */
  afterStreamError?(ctx: LoopPolicyContext, event: LoopEvent): Promise<void> | void
  /** Called when an unrecoverable error occurs during the loop. */
  onError?(ctx: LoopPolicyContext, error: unknown): Promise<void> | void
}

type PolicyHook = Exclude<keyof LoopPolicy, "name">

type HookArgs<K extends PolicyHook> =
  K extends "afterModelEvent" ? [event: unknown] :
  K extends "beforeToolBatch" ? [toolCalls: readonly ToolCall[], info: ToolBatchInfo] :
  K extends "afterToolResult" ? [event: LoopEvent, info: ToolResultInfo] :
  K extends "afterToolBatch" ? [toolCalls: readonly ToolCall[], info: ToolBatchInfo] :
  K extends "afterStreamError" ? [event: LoopEvent] :
  K extends "onError" ? [error: unknown] :
  []

export async function runPolicyHook<K extends PolicyHook>(
  policies: LoopPolicy[],
  hook: K,
  ctx: LoopPolicyContext,
  ...args: HookArgs<K>
): Promise<void> {
  for (const policy of policies) {
    const fn = policy[hook]
    if (!fn) continue
    try {
      await (fn as (...a: any[]) => Promise<void> | void)(ctx, ...args)
    } catch {
      // Individual hook errors must not break the pipeline
    }
  }
}

function normalizePolicyEvents(result: LoopPolicyEventResult): LoopPolicyEventEmission[] {
  if (!result) return []
  const items = Array.isArray(result) ? result : [result]
  return items.map((item) => {
    if ("event" in item) return item
    return { event: item }
  })
}

export async function runPolicyHookEvents<K extends PolicyHook>(
  policies: LoopPolicy[],
  hook: K,
  ctx: LoopPolicyContext,
  ...args: HookArgs<K>
): Promise<LoopPolicyEventEmission[]> {
  const events: LoopPolicyEventEmission[] = []
  for (const policy of policies) {
    const fn = policy[hook]
    if (!fn) continue
    try {
      const result = await (fn as (...a: any[]) => Promise<LoopPolicyEventResult> | LoopPolicyEventResult)(ctx, ...args)
      events.push(...normalizePolicyEvents(result))
    } catch {
      // Individual hook errors must not break the pipeline
    }
  }
  return events
}

export function createPoliciesFromLoopOptions(_opts: unknown): LoopPolicy[] {
  return []
}
