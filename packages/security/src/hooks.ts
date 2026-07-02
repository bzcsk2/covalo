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

export class HookManager {
  private hooks: ToolCallHooks[] = []
  private onHookError?: (error: unknown, phase: HookPhase) => void
  private pending: Set<Promise<void>> = new Set()

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
    // The first hook that returns "allow" or "deny" determines the result.
    for (const hooks of this.hooks) {
      if (hooks.beforeToolCall) {
        try {
          const result = await hooks.beforeToolCall(context)
          if (result === "deny" || result === "allow") return result
        } catch (e) {
          this.onHookError?.(e, "before")
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
    await p.finally(() => this.pending.delete(p))
  }

  /** Wait for all in-flight hook calls to complete (best-effort). */
  async drain(): Promise<void> {
    await Promise.all([...this.pending])
  }
}
