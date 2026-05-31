import type { AgentTool, LoopEvent, ToolContext, ToolResult } from "./interface.js"
import type { ToolCall } from "./types.js"
import { repairToolArguments } from "./context/repair.js"
import type { PermissionEngine, HookManager, PermissionDecision } from "@deepicode/security"

export class StreamingToolExecutor {
  private tools: Map<string, AgentTool>
  private sessionId: string
  private cwd: string
  private permissionEngine?: PermissionEngine
  private hookManager?: HookManager
  private requestPermission?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  private delegateTask?: (task: string, agentType: "build" | "plan", files: string[]) => Promise<string>
  private switchAgent?: (name: "build" | "plan") => string

  constructor(
    tools: Map<string, AgentTool>,
    sessionId: string,
    cwd?: string,
    permissionEngine?: PermissionEngine,
    hookManager?: HookManager,
    requestPermission?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>,
    delegateTask?: (task: string, agentType: "build" | "plan", files: string[]) => Promise<string>,
    switchAgent?: (name: "build" | "plan") => string,
  ) {
    this.tools = tools
    this.sessionId = sessionId
    this.cwd = cwd ?? process.cwd()
    this.permissionEngine = permissionEngine
    this.hookManager = hookManager
    this.requestPermission = requestPermission
    this.delegateTask = delegateTask
    this.switchAgent = switchAgent
  }

  async *run(toolCalls: ToolCall[], signal: AbortSignal, appendToolResult: (tc: ToolCall, result: ToolResult) => void): AsyncGenerator<LoopEvent> {
    let sharedBatch: Array<{ tc: ToolCall; index: number }> = []

    const flushSharedBatch = async function* (
      exec: StreamingToolExecutor,
      batch: Array<{ tc: ToolCall; index: number }>,
    ): AsyncGenerator<LoopEvent> {
      if (batch.length === 0) return

      // Permission check for all tools in batch (must run before dispatching)
      const allowedBatch: Array<{ tc: ToolCall; index: number }> = []
      for (const { tc, index } of batch) {
        const permResult = await exec.checkAskPermission(tc, index)
        if (permResult === "deny") {
          yield { role: "error", content: `Tool call denied: ${tc.function.name} requires manual approval`, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
          continue
        }
        if (permResult === "ask") {
          let args: Record<string, unknown>
          try { args = JSON.parse(tc.function.arguments) } catch { args = {} }
          const permPromise = exec.requestPermission!(tc.function.name, args)
          yield { role: "permission_ask", toolName: tc.function.name, content: JSON.stringify(args) }
          const allowed = await permPromise
          if (!allowed) {
            yield { role: "error", content: `Tool call denied by user: ${tc.function.name}`, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
            continue
          }
        }
        allowedBatch.push({ tc, index })
      }
      if (allowedBatch.length === 0) return

      for (const { tc, index } of allowedBatch) {
        yield { role: "tool_start", toolName: tc.function.name, toolCallIndex: index }
        yield { role: "tool_progress", toolName: tc.function.name, toolCallIndex: index, content: "running" }
      }

      const pending = allowedBatch.map(({ tc, index }) =>
        exec.executeToolResult(tc, index, signal).then((r) => ({ index, ...r })) as Promise<{ index: number; event: LoopEvent; result: ToolResult }>,
      )

      const completed = await Promise.all(pending)
      // Reorder by declaration index before yielding/appending
      completed.sort((a, b) => a.index - b.index)

      for (const { index, event, result } of completed) {
        const originalTc = batch.find((b) => b.index === index)?.tc
        if (!originalTc) {
          yield { role: "error", content: `Tool call index ${index} not found in batch`, severity: "error", toolName: event.toolName, toolCallIndex: index }
          continue
        }
        appendToolResult(originalTc, result)
        yield event
        yield { role: "tool_progress", toolName: event.toolName, toolCallIndex: index, content: "done" }
      }
    }

    for (let index = 0; index < toolCalls.length; index++) {
      const tc = toolCalls[index]
      const handler = this.tools.get(tc.function.name)

      if (handler?.concurrency === "shared") {
        sharedBatch.push({ tc, index })
        continue
      }

      yield* flushSharedBatch(this, sharedBatch)
      sharedBatch = []

      yield { role: "tool_start", toolName: tc.function.name, toolCallIndex: index }
      yield* this.executeToolCall(tc, index, signal, appendToolResult)
    }

    yield* flushSharedBatch(this, sharedBatch)
  }

  // Check "ask" permission decision. Returns:
  //   "allow" — hook allowed or no "ask" decision
  //   "deny"  — hook denied or no confirmation channel
  //   "ask"   — need to yield permission_ask event and await user response
  private async checkAskPermission(tc: ToolCall, _index: number): Promise<"allow" | "deny" | "ask"> {
    const handler = this.tools.get(tc.function.name)
    if (!handler || !this.permissionEngine) return "allow"
    let args: Record<string, unknown>
    try { args = parseToolArguments(tc.function.arguments) } catch { args = {} }
    const check = this.permissionEngine.decide(tc.function.name, args, handler.approval)
    if (check?.decision !== "ask") return "allow"
    let hookDecision: PermissionDecision | void
    try {
      hookDecision = await this.hookManager?.runBeforeToolCall({
        toolName: tc.function.name, args, tier: handler.approval,
        permissionDecision: "ask", permissionReason: check.reason,
      })
    } catch { hookDecision = "deny" }
    if (hookDecision === "allow") return "allow"
    if (hookDecision === "deny") return "deny"
    if (this.requestPermission) return "ask"
    return "deny" // no confirmation channel
  }

  // Execute tool and return result without appending to context
  private async executeToolResult(tc: ToolCall, index: number, signal: AbortSignal): Promise<{ event: LoopEvent; result: ToolResult }> {
    const handler = this.tools.get(tc.function.name)
    const toolCtx = this.createToolContext(signal, [tc.function.name])

    if (!handler) {
      const result = makeToolError(`Unknown tool: ${tc.function.name}`)
      return { event: makeErrorEvent(result, tc.function.name, index), result }
    }

    let args: Record<string, unknown>
    try {
      args = parseToolArguments(tc.function.arguments)
    } catch {
      const repaired = repairToolArguments(tc.function.arguments)
      if (!repaired.success) {
        const result = makeToolError(`Invalid arguments for ${tc.function.name}: failed all repair stages`)
        return { event: makeErrorEvent(result, tc.function.name, index), result }
      }
      args = repaired.args
    }

    try {
      const check = this.permissionEngine?.decide(tc.function.name, args, handler.approval)
      if (check?.decision === "deny") {
        const result = makeToolError(check.reason ?? "Permission denied")
        return { event: makeErrorEvent(result, tc.function.name, index), result }
      }
      // "ask" decisions are handled upstream in executeToolCall (async generator)
      // where yield is available for UI confirmation events.
      // Here we only enforce deny; allow or unhandled-ask fall through to execution.

      const result = normalizeToolResult(await handler.execute(args, toolCtx))
      this.hookManager?.runAfterToolCall(tc.function.name, { content: result.content, isError: result.isError, metadata: result.metadata })
      return {
        event: {
          role: result.isError ? "error" : "tool",
          toolName: tc.function.name,
          toolCallIndex: index,
          content: result.content,
          severity: result.isError ? "error" : undefined,
          metadata: result.metadata,
        },
        result,
      }
    } catch (e) {
      const result = makeToolError(errorMessage(e))
      this.hookManager?.runAfterToolCall(tc.function.name, { content: result.content, isError: true, metadata: result.metadata })
      return { event: makeErrorEvent(result, tc.function.name, index), result }
    }
  }

  private createToolContext(signal: AbortSignal, stack: string[]): ToolContext {
    return {
      cwd: this.cwd,
      sessionId: this.sessionId,
      signal,
      delegateTask: this.delegateTask,
      switchAgent: this.switchAgent,
      invokeTool: async (name, args) => {
        if (stack.includes(name)) {
          return makeToolError(`Recursive tool invocation is not allowed: ${[...stack, name].join(" -> ")}`)
        }
        const handler = this.tools.get(name)
        if (!handler) return makeToolError(`Unknown tool: ${name}`)
        const permission = this.permissionEngine?.decide(name, args, handler.approval)
        if (permission?.decision === "deny") return makeToolError(permission.reason ?? `Permission denied: ${name}`)
        // Workflow itself is exec-tier and its complete step list was already
        // confirmed by the user. Deny rules still take precedence above.
        if (permission?.decision === "ask" && stack[0] !== "Workflow") {
          return makeToolError(`Nested tool requires direct confirmation and was not executed: ${name}`)
        }
        try {
          return normalizeToolResult(await handler.execute(args, this.createToolContext(signal, [...stack, name])))
        } catch (e) {
          return makeToolError(errorMessage(e))
        }
      },
    }
  }

  private async *executeToolCall(
    tc: ToolCall,
    index: number,
    signal: AbortSignal,
    appendToolResult: (tc: ToolCall, result: ToolResult) => void,
  ): AsyncGenerator<LoopEvent, void> {
    yield { role: "tool_progress", toolName: tc.function.name, toolCallIndex: index, content: "running" }

    const permResult = await this.checkAskPermission(tc, index)
    if (permResult === "deny") {
      const result = makeToolError(`Tool call denied: ${tc.function.name} requires manual approval`)
      appendToolResult(tc, result)
      yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
      return
    }
    if (permResult === "ask") {
      let args: Record<string, unknown>
      try { args = parseToolArguments(tc.function.arguments) } catch { args = {} }
      const permPromise = this.requestPermission!(tc.function.name, args) // create Promise before yielding
      yield { role: "permission_ask", toolName: tc.function.name, content: JSON.stringify(args) }
      const allowed = await permPromise
      if (!allowed) {
        const result = makeToolError(`Tool call denied by user: ${tc.function.name}`)
        appendToolResult(tc, result)
        yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
        return
      }
    }

    const { event, result } = await this.executeToolResult(tc, index, signal)
    appendToolResult(tc, result)
    yield event
    yield { role: "tool_progress", toolName: tc.function.name, toolCallIndex: index, content: "done" }
  }
}

function makeErrorEvent(result: ToolResult, toolName: string, index: number): LoopEvent {
  return {
    role: "error",
    content: result.content,
    toolName,
    toolCallIndex: index,
    severity: "error",
    metadata: result.metadata,
  }
}

function normalizeToolResult(result: ToolResult): ToolResult {
  return {
    content: result.content,
    isError: result.isError,
    metadata: result.metadata,
  }
}

function makeToolError(message: string): ToolResult {
  return {
    content: JSON.stringify({ error: message }),
    isError: true,
    metadata: { error: message },
  }
}

function parseToolArguments(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("arguments must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
