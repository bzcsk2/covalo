import type { PermissionDecision } from "./permission.js"

export interface BeforeToolCallContext {
  toolName: string
  args: Record<string, unknown>
  tier: string
  permissionDecision: PermissionDecision
  permissionReason?: string
}

export interface ToolCallResult {
  content: string
  isError: boolean
  metadata?: Record<string, unknown>
}

export interface ToolCallHooks {
  beforeToolCall?: (context: BeforeToolCallContext) => Promise<PermissionDecision | void>
  afterToolCall?: (toolName: string, result: ToolCallResult) => Promise<void>
  onLoopEvent?: (event: Record<string, unknown>) => Promise<void>
}

export type HookPhase = "before" | "after" | "loop_event"

/**
 * T12: loop_event hook 的最长等待时间。
 *
 * `runOnLoopEvent` 将 hook 调用加入 pending Set 并 await，若 hook 因异常或外部依赖卡住，
 * drain() 会永久等待。这里加一个 30s 兜底超时 — 超时后 drain() 可以返回，但 hook
 * 本身仍在后台运行（不会被中断），只是不再阻塞调用方。
 */
const HOOK_LOOP_EVENT_TIMEOUT_MS = 30_000

export class HookManager {
  private hooks: ToolCallHooks[] = []
  private onHookError?: (error: unknown, phase: HookPhase) => void
  private pending: Set<Promise<void>> = new Set()
  /** T1: Stores the most recent hook failure reason for error reporting (consumed by resolveDenyMessage). */
  lastHookDenyReason: string | undefined

  addHooks(hooks: ToolCallHooks): void {
    this.hooks.push(hooks)
  }

  removeHooks(hooks: ToolCallHooks): void {
    this.hooks = this.hooks.filter(h => h !== hooks)
  }

  clear(): void {
    this.hooks = []
  }

  /** P5: Set optional error observation callback */
  setErrorObserver(callback: (error: unknown, phase: HookPhase) => void): void {
    this.onHookError = callback
  }

  async runBeforeToolCall(context: BeforeToolCallContext): Promise<PermissionDecision | void> {
    // First-match-wins: hooks are evaluated in registration order.
    // The first hook that returns "deny", "allow", or "ask" determines the result.
    for (const hooks of this.hooks) {
      if (hooks.beforeToolCall) {
        try {
          const result = await hooks.beforeToolCall(context)
          if (result === "deny" || result === "allow" || result === "ask") return result
        } catch (e) {
          this.onHookError?.(e, "before")
          // T1: Hook failure = deny, with explicit reason for downstream error reporting
          const message = e instanceof Error ? e.message : String(e)
          this.lastHookDenyReason = `beforeToolCall hook failed: ${message}`
          return "deny" // hook failure = deny (fail-safe)
        }
      }
    }
  }

  async runAfterToolCall(toolName: string, result: ToolCallResult): Promise<void> {
    for (const hooks of this.hooks) {
      if (hooks.afterToolCall) {
        try { await hooks.afterToolCall(toolName, result) } catch (e) {
          // P5: after hook failure must not interrupt main flow
          this.onHookError?.(e, "after")
        }
      }
    }
  }

  async runOnLoopEvent(event: Record<string, unknown>): Promise<void> {
    const p = (async () => {
      for (const hooks of this.hooks) {
        if (hooks.onLoopEvent) {
          // P5: loop_event hook failure must not interrupt main flow
          try { await hooks.onLoopEvent(event) } catch (e) {
            this.onHookError?.(e, "loop_event")
          }
        }
      }
    })()
    this.pending.add(p)
    // T12: 30s 兜底超时 — 防止 hook 卡住导致 drain() 永久等待。
    // 超时不会中断 hook 本身，只让当前 await 提前返回。
    const timeout = new Promise<void>((resolve) =>
      setTimeout(resolve, HOOK_LOOP_EVENT_TIMEOUT_MS),
    )
    await Promise.race([p, timeout]).finally(() => this.pending.delete(p))
  }

  /** Wait for all in-flight hook calls to complete (best-effort). */
  async drain(): Promise<void> {
    await Promise.all([...this.pending])
  }
}
