import type { MemoryService } from "../memory-service.js"

export interface DeepreefMemoryBridgeConfig {
  autoObserve: boolean
  injectContext: boolean
}

export class DeepreefMemoryBridge {
  constructor(
    private memory: MemoryService,
    private config: DeepreefMemoryBridgeConfig,
  ) {}

  async onSessionStart(sessionId: string): Promise<void> {
    if (!this.config.autoObserve) return
    try {
      await this.memory.trigger("mem::observe", {
        hookType: "session_start",
        sessionId,
        timestamp: new Date().toISOString(),
        raw: JSON.stringify({ event: "session_started" }),
      })
    } catch { /* non-blocking */ }
  }

  async onSessionEnd(sessionId: string): Promise<void> {
    if (!this.config.autoObserve) return
    try {
      await this.memory.trigger("event::session::stopped", { sessionId })
      await this.memory.trigger("event::session::ended", { sessionId })
    } catch { /* non-blocking */ }
  }

  async onPromptSubmit(sessionId: string, prompt: string): Promise<void> {
    if (!this.config.autoObserve) return
    try {
      await this.memory.trigger("mem::observe", {
        hookType: "prompt_submit",
        sessionId,
        timestamp: new Date().toISOString(),
        userPrompt: prompt,
        raw: JSON.stringify({ event: "prompt_submit" }),
      })
    } catch { /* non-blocking */ }
  }

  /**
   * @experimental 未接入生产路径。
   * 设计意图：在工具调用前注入 memory context，实现"工具调用前上下文增强"。
   * 当前 HookManager 的 beforeToolCall 已有 hook 机制，未来可在此处接入。
   * 详见 docs/unintegrated_code_audit_20260703.md §3.8（Phase 2.3 选项 A）。
   */
  async onPreToolUse(sessionId: string, toolName: string, toolInput: unknown): Promise<string | undefined> {
    if (!this.config.autoObserve && !this.config.injectContext) return
    let context = ""
    if (this.config.injectContext) {
      try {
        const result = await this.memory.trigger("mem::context", {
          sessionId,
          maxChars: 2000,
        })
        if (result && typeof result === "object" && "context" in result) {
          context = (result as { context: string }).context
        }
      } catch { /* non-blocking */ }
    }
    if (this.config.autoObserve) {
      try {
        await this.memory.trigger("mem::observe", {
          hookType: "pre_tool_use",
          sessionId,
          toolName,
          toolInput,
          timestamp: new Date().toISOString(),
          raw: JSON.stringify({ toolName, toolInput }),
        }).catch(() => {})
      } catch { /* non-blocking */ }
    }
    return context || undefined
  }

  async onPostToolUse(sessionId: string, toolName: string, toolOutput: unknown): Promise<void> {
    if (!this.config.autoObserve) return
    try {
      await this.memory.trigger("mem::observe", {
        hookType: "post_tool_use",
        sessionId,
        toolName,
        toolOutput,
        timestamp: new Date().toISOString(),
        raw: JSON.stringify({ toolName, toolOutput }),
      })
    } catch { /* non-blocking */ }
  }

  async onPostToolFailure(sessionId: string, toolName: string, error: string): Promise<void> {
    if (!this.config.autoObserve) return
    try {
      await this.memory.trigger("mem::observe", {
        hookType: "post_tool_failure",
        sessionId,
        toolName,
        timestamp: new Date().toISOString(),
        toolOutput: { error },
        raw: JSON.stringify({ toolName, error }),
      })
    } catch { /* non-blocking */ }
  }

  // Phase 2.3: onPreCompact / onSubagentStart / onSubagentStop 已删除
  // （无未来设计意图，无任何调用方）。
  // 详见 docs/unintegrated_code_audit_20260703.md §3.8。

  async onGenerationComplete(sessionId: string): Promise<void> {
    if (!this.config.autoObserve) return
    try {
      await this.memory.trigger("mem::observe", {
        hookType: "stop",
        sessionId,
        timestamp: new Date().toISOString(),
        raw: JSON.stringify({ event: "generation_complete" }),
      })
    } catch { /* non-blocking */ }
  }
}
