import type { AgentTool, LoopEvent, ToolContext, ToolResult, ToolProgressUpdate } from "./interface.js"
import type { ToolCall } from "./types.js"
import type { PermissionEngine, HookManager } from "@covalo/security"
import { type ResultPersistenceConfig } from "./result-persistence.js"
import { noopRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js"
import { evaluatePermission, resolveDenyMessage, createSettleLedger, createProgressQueue, applyResultPersistence, parseToolCallArgs } from "./executor-helpers.js"
import { shouldBlockSalvagedTruncatedWrite, buildSalvagedTruncatedWriteBlockMessage } from "./tool-arguments/truncation-recovery.js"
import { ReadTracker, extractFilePath, isWriteTool, isReadTool } from "./read-before-write.js"
import type { SubagentRunOptions, SubagentRunResult } from "./subagent/types.js"
import type { QuestionInfo, QuestionAnswer } from "./question/types.js"
import { getCurrentCaseWorkspace } from "./eval/runner.js"
import { evalToolTracker } from "./eval/tool-tracker.js"
import { getEvalSandboxProvider } from "./eval/workspace.js"

export class StreamingToolExecutor {
  private tools: Map<string, AgentTool>
  private sessionId: string
  private cwd: string
  private permissionEngine?: PermissionEngine
  private hookManager?: HookManager
  private requestPermission?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>
  private delegateTask?: (task: string, agentType: string, files: string[]) => Promise<string>
  private switchAgent?: (name: string) => string
  private spawnSubagent?: (options: SubagentRunOptions) => Promise<SubagentRunResult>
  private askUser?: (questions: QuestionInfo[]) => Promise<QuestionAnswer[]>
  private resultPersistenceConfig?: ResultPersistenceConfig
  private logger: RuntimeLogger
  private readTracker?: ReadTracker

  /** DRF-20: 启用 read-before-write 守卫 */
  setReadTracker(tracker: ReadTracker | undefined): void {
    this.readTracker = tracker
  }

  setSessionId(id: string): void {
    this.sessionId = id
  }

  constructor(
    tools: Map<string, AgentTool>,
    sessionId: string,
    cwd?: string,
    permissionEngine?: PermissionEngine,
    hookManager?: HookManager,
    requestPermission?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>,
    delegateTask?: (task: string, agentType: string, files: string[]) => Promise<string>,
    switchAgent?: (name: string) => string,
    spawnSubagent?: (options: SubagentRunOptions) => Promise<SubagentRunResult>,
    askUser?: (questions: QuestionInfo[]) => Promise<QuestionAnswer[]>,
    resultPersistenceConfig?: ResultPersistenceConfig,
    logger: RuntimeLogger = noopRuntimeLogger,
  ) {
    this.tools = tools
    this.sessionId = sessionId
    this.cwd = cwd ?? process.cwd()
    this.permissionEngine = permissionEngine
    this.hookManager = hookManager
    this.requestPermission = requestPermission
    this.delegateTask = delegateTask
    this.switchAgent = switchAgent
    this.spawnSubagent = spawnSubagent
    this.askUser = askUser
    this.resultPersistenceConfig = resultPersistenceConfig
    this.logger = logger
  }

  async *run(
    toolCalls: ToolCall[],
    signal: AbortSignal,
    appendToolResult: (tc: ToolCall, result: ToolResult) => void,
    traceContext?: Record<string, unknown>,
    allowedToolNames?: ReadonlySet<string>,
  ): AsyncGenerator<LoopEvent> {
    const logger = traceContext && this.logger.isEnabled("error")
      ? this.logger.child(traceContext)
      : this.logger
    // CL-50: Settled set tracks which tool call indices have already written a result.
    const { settle, isSettled } = createSettleLedger(appendToolResult)

    let sharedBatch: Array<{ tc: ToolCall; index: number }> = []

    const flushSharedBatch = async function* (
      exec: StreamingToolExecutor,
      batch: Array<{ tc: ToolCall; index: number }>,
    ): AsyncGenerator<LoopEvent> {
      if (batch.length === 0) return
      const diagnosticsEnabled = logger.isEnabled("error")
      const batchStartedAt = diagnosticsEnabled ? Date.now() : 0
      if (diagnosticsEnabled) {
        const sharedCount = batch.filter(({ tc }) => exec.tools.get(tc.function.name)?.concurrency === "shared").length
        logger.debug("tool.batch.start", { count: batch.length, sharedCount, exclusiveCount: batch.length - sharedCount })
      }

      // Permission check for all tools in batch (must run before dispatching)
      const allowedBatch: Array<{ tc: ToolCall; index: number }> = []
      for (const { tc, index } of batch) {
        const argsResult = parseToolCallArgs(tc.function.arguments, tc.function.name)
        if (!argsResult.ok) {
          const result = makeToolError(argsResult.error)
          settle(tc, index, result)
          if (diagnosticsEnabled) logger.warn("tool.args.invalid_json", { toolName: tc.function.name, toolCallIndex: index, argumentLength: tc.function.arguments.length })
          yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
          continue
        }
        if (shouldBlockSalvagedTruncatedWrite(tc.function.name, argsResult.args)) {
          const result = makeToolError(buildSalvagedTruncatedWriteBlockMessage(tc.function.name, argsResult.args))
          settle(tc, index, result)
          if (diagnosticsEnabled) logger.warn("tool.args.salvage_truncated_write_blocked", { toolName: tc.function.name, toolCallIndex: index })
          yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
          continue
        }

        const permResult = await evaluatePermission(tc, exec.tools, exec.permissionEngine, exec.hookManager, exec.requestPermission, argsResult.args)
        if (permResult === "deny") {
          const result = makeToolError(resolveDenyMessage(tc, exec.tools, exec.permissionEngine, argsResult.args))
          settle(tc, index, result)
          yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
          continue
        }
        if (permResult === "ask") {
          const permPromise = exec.requestPermission!(tc.function.name, argsResult.args)
          yield { role: "permission_ask", toolName: tc.function.name, content: JSON.stringify(argsResult.args) }
          const allowed = await permPromise
          if (!allowed) {
            const result = makeToolError(`Tool call denied by user: ${tc.function.name}`)
            settle(tc, index, result)
            if (diagnosticsEnabled) logger.warn("tool.execute.denied", { permissionSource: "user", durationMs: Date.now() - batchStartedAt })
            yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
            continue
          }
        }
        allowedBatch.push({ tc, index })
      }
      if (allowedBatch.length === 0) return

      // P1: Start executing tools BEFORE yielding events, so tools that complete
      // synchronously finish before the consumer can abort.
      // CL-50: Collect progress from shared tools via per-tool progress queues
      const progressQueues = new Map<number, ReturnType<typeof createProgressQueue>>()
      const pending = allowedBatch.map(({ tc, index }) => {
        const q = createProgressQueue()
        progressQueues.set(index, q)
        return exec.executeToolResult(tc, index, signal, logger, q.push).then((r) => ({ index, tc, ...r })) as Promise<{ index: number; tc: ToolCall; event: LoopEvent; result: ToolResult }>
      })

      for (const { tc, index } of allowedBatch) {
        yield { role: "tool_start", toolName: tc.function.name, toolCallIndex: index }
        yield { role: "tool_progress", toolName: tc.function.name, toolCallIndex: index, content: "running" }
      }

      const completed = await Promise.allSettled(pending)
      // Reorder by declaration index before yielding
      const settled_results: Array<{ index: number; tc: ToolCall; event: LoopEvent; result: ToolResult }> = []
      for (let i = 0; i < completed.length; i++) {
        const entry = completed[i]
        if (entry.status === "fulfilled") {
          settled_results.push(entry.value)
        } else {
          // Promise rejected (shouldn't happen since executeToolResult catches, but defensive)
          const { tc, index } = allowedBatch[i]
          const result = makeToolError(`Tool execution failed: ${errorMessage(entry.reason)}`)
          settle(tc, index, result)
          yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
        }
      }
      settled_results.sort((a, b) => a.index - b.index)

      // CL-50: Flush progress queues before final events
      for (const { index } of settled_results) {
        const q = progressQueues.get(index)
        if (q) {
          for (const p of q.flush()) {
            yield { role: "tool_progress", toolName: "", toolCallIndex: index, content: p.content, metadata: p.metadata }
          }
        }
      }

      for (const { index, tc, event, result } of settled_results) {
        settle(tc, index, result)
        yield event
        yield { role: "tool_progress", toolName: event.toolName, toolCallIndex: index, content: "done" }
      }
      if (diagnosticsEnabled) {
        const errorCount = settled_results.filter(r => r.result.isError).length
        logger.debug("tool.batch.done", { durationMs: Date.now() - batchStartedAt, errorCount })
      }
    }

    try {
      for (let index = 0; index < toolCalls.length; index++) {
        const tc = toolCalls[index]
        if (allowedToolNames && !allowedToolNames.has(tc.function.name)) {
          const result = makeToolError(`Tool not available in this turn: ${tc.function.name}`)
          settle(tc, index, result)
          if (logger.isEnabled("error")) logger.warn("tool.execute.not_allowed", { toolName: tc.function.name, toolCallIndex: index })
          yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error", metadata: { error: true, reason: "tool_not_allowed" } }
          continue
        }
        const handler = this.tools.get(tc.function.name)

        if (handler?.concurrency === "shared") {
          sharedBatch.push({ tc, index })
          continue
        }

        yield* flushSharedBatch(this, sharedBatch)
        sharedBatch = []

        yield { role: "tool_start", toolName: tc.function.name, toolCallIndex: index }
        yield* this.executeToolCall(tc, index, signal, settle, logger)
      }

      yield* flushSharedBatch(this, sharedBatch)
    } catch (err) {
      // CL-50: On generator abort, settle any remaining unsettled tool calls.
      logger?.warn("tool.batch.interrupted_or_failed", {
        error: err instanceof Error ? err.message : String(err),
      })
      for (let index = 0; index < toolCalls.length; index++) {
        if (!isSettled(index)) {
          const tc = toolCalls[index]
          const result = makeToolError("tool execution interrupted")
          settle(tc, index, result)
          yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
        }
      }
    }
  }

  // CL-50: Permission check delegated to evaluatePermission helper
  private async checkAskPermission(tc: ToolCall, _index: number, args: Record<string, unknown>): Promise<"allow" | "deny" | "ask" | "invalid"> {
    return evaluatePermission(tc, this.tools, this.permissionEngine, this.hookManager, this.requestPermission, args)
  }

  // Execute tool and return result without appending to context
  private async executeToolResult(tc: ToolCall, index: number, signal: AbortSignal, baseLogger = this.logger, reportProgress?: (update: ToolProgressUpdate) => void): Promise<{ event: LoopEvent; result: ToolResult }> {
    const diagnosticsEnabled = baseLogger.isEnabled("error")
    const startedAt = diagnosticsEnabled ? Date.now() : 0
    const logger = diagnosticsEnabled
      ? baseLogger.child({ toolCallId: tc.id, toolName: tc.function.name, toolCallIndex: index })
      : baseLogger
    const handler = this.tools.get(tc.function.name)
    const toolCtx = this.createToolContext(signal, [tc.function.name], reportProgress)

    if (!handler) {
      const result = makeToolError(`Unknown tool: ${tc.function.name}`)
      if (diagnosticsEnabled) logger.warn("tool.execute.unknown", { durationMs: Date.now() - startedAt })
      return { event: makeErrorEvent(result, tc.function.name, index), result }
    }
    if (diagnosticsEnabled) logger.info("tool.execute.start", { concurrency: handler.concurrency, approval: handler.approval })

    const argsResult = parseToolCallArgs(tc.function.arguments, tc.function.name)
    if (!argsResult.ok) {
      const result = makeToolError(argsResult.error)
      if (diagnosticsEnabled) logger.warn("tool.args.invalid_json", { durationMs: Date.now() - startedAt, argumentLength: tc.function.arguments.length })
      return { event: makeErrorEvent(result, tc.function.name, index), result }
    }
    if (shouldBlockSalvagedTruncatedWrite(tc.function.name, argsResult.args)) {
      const result = makeToolError(buildSalvagedTruncatedWriteBlockMessage(tc.function.name, argsResult.args))
      if (diagnosticsEnabled) logger.warn("tool.args.salvage_truncated_write_blocked", { durationMs: Date.now() - startedAt })
      return { event: makeErrorEvent(result, tc.function.name, index), result }
    }
    const args = argsResult.args
    if (argsResult.repaired && diagnosticsEnabled) logger.warn("tool.arguments.repaired")

    // DRF-20: read-before-write 守卫
    if (this.readTracker) {
      const filePath = extractFilePath(tc.function.name, args)
      if (filePath && isWriteTool(tc.function.name)) {
        const guard = this.readTracker.checkWrite(filePath, this.cwd)
        if (!guard.ok) {
          const result = makeToolError(guard.reason ?? "Write guard: read file first")
          if (diagnosticsEnabled) logger.warn("tool.write_guard", { toolName: tc.function.name, filePath })
          return { event: makeErrorEvent(result, tc.function.name, index), result }
        }
      }
    }

    try {
      const check = this.permissionEngine?.decide(tc.function.name, args, handler.approval)
      if (check?.decision === "deny") {
        const result = makeToolError(check.reason ?? "Permission denied")
        if (diagnosticsEnabled) logger.warn("tool.execute.denied", { durationMs: Date.now() - startedAt })
        return { event: makeErrorEvent(result, tc.function.name, index), result }
      }

      // Action certificate gate: check high-risk bash commands before execution
      if (tc.function.name === "bash" || tc.function.name === "shell" || tc.function.name === "exec") {
        const command = typeof args.command === "string" ? args.command : typeof args.commands === "string" ? args.commands : ""
        if (command) {
          const { classifyRisk, createActionCertificate, completeActionCertificate } = await import("./harness-evolution/packets/action-certificate");
          const risk = classifyRisk(command);
          if (risk === "high" || risk === "medium") {
            const cert = createActionCertificate({
              packetId: `ac:streaming-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              runId: this.sessionId ?? "streaming",
              actionId: `action-${index}-${Date.now()}`,
              action: {
                toolName: tc.function.name,
                command: command.slice(0, 500),
                affectedFiles: [command],
                promptSha256: undefined,
              },
              riskLevel: risk,
              approval: { class: "runtime_enforced", approvedBy: "policy" },
              assumptions: [],
              rollbackPlan: "N/A",
              mode: "loop",
              role: "worker",
            });
            const outcome = { status: "cancelled" as const, exitCode: -1, durationMs: 0 };
            const completedCert = completeActionCertificate(cert, outcome);
            // Persist the certificate as sidecar artifact
            try {
              const { mkdir, writeFile } = await import("node:fs/promises");
              const { join } = await import("node:path");
              const certDir = join(process.cwd(), ".covalo", "harness", "certificates");
              await mkdir(certDir, { recursive: true });
              await writeFile(join(certDir, `${completedCert.packetId}.json`), JSON.stringify(completedCert, null, 2), "utf-8");
            } catch {
              // Certificate artifact is optional
            }
            // Log the certificate blocking event
            if (diagnosticsEnabled) logger.warn("tool.action_certificate_blocked", {
              toolName: tc.function.name, risk,
              command: command.slice(0, 200),
              packetId: completedCert.packetId,
              approval: completedCert.approval.class,
              outcome: completedCert.outcome?.status,
            });
            // Block execution: return tool error with the certificate evidence
            const blockedResult = makeToolError(`Action certificate: blocked ${risk}-risk command. Certificate ${completedCert.packetId} recorded outcome=${completedCert.outcome?.status}. Command: ${command.slice(0, 200)}`);
            return { event: makeErrorEvent(blockedResult, tc.function.name, index), result: blockedResult };
          }
        }
      }
      // "ask" decisions are handled upstream in executeToolCall (async generator)
      // where yield is available for UI confirmation events.
      // Here we only enforce deny; allow or unhandled-ask fall through to execution.

      // P1: If signal already aborted before execution starts, fail immediately
      // rather than letting the tool run and produce a result that will be ignored.
      if (signal.aborted) {
        const result = makeToolError("tool execution interrupted")
        if (diagnosticsEnabled) logger.warn("tool.execute.aborted", { durationMs: Date.now() - startedAt })
        return { event: makeErrorEvent(result, tc.function.name, index), result }
      }

      const rawResult = normalizeToolResult(await handler.execute(args, toolCtx))

      // CL-50: Apply overflow persistence via adapter
      let result = rawResult
      if (!rawResult.isError && this.resultPersistenceConfig) {
        result = await applyResultPersistence(rawResult, this.sessionId, tc.function.name, this.resultPersistenceConfig, this.hookManager, logger)
      }

      this.hookManager?.runAfterToolCall(tc.function.name, { content: result.content, isError: result.isError, metadata: result.metadata })
      evalToolTracker.record(result.isError)

      // DRF-20: 记录读/写跟踪
      if (this.readTracker && !result.isError) {
        const filePath = extractFilePath(tc.function.name, args)
        if (filePath) {
          if (isReadTool(tc.function.name)) this.readTracker.recordRead(filePath, this.cwd)
          if (isWriteTool(tc.function.name)) this.readTracker.recordWrite(filePath, this.cwd)
        }
      }

      if (diagnosticsEnabled) logger.info("tool.execute.done", { durationMs: Date.now() - startedAt, isError: result.isError })
      return {
        event: {
          role: result.isError ? "error" : "tool",
          toolName: tc.function.name,
          toolCallIndex: index,
          toolCallId: tc.id,
          content: result.content,
          severity: result.isError ? "error" : undefined,
          metadata: result.metadata,
        },
        result,
      }
    } catch (e) {
      const result = makeToolError(errorMessage(e))
      this.hookManager?.runAfterToolCall(tc.function.name, { content: result.content, isError: true, metadata: result.metadata })
      evalToolTracker.record(true)
      if (diagnosticsEnabled) logger.error("tool.execute.error", e, { durationMs: Date.now() - startedAt })
      return { event: makeErrorEvent(result, tc.function.name, index), result }
    }
  }

  private createToolContext(signal: AbortSignal, stack: string[], reportProgress?: (update: ToolProgressUpdate) => void): ToolContext {
    return {
      cwd: getCurrentCaseWorkspace() ?? this.cwd,
      sessionId: this.sessionId,
      sandboxProvider: getEvalSandboxProvider() ?? undefined,
      signal,
      reportProgress,
      delegateTask: this.delegateTask,
      switchAgent: this.switchAgent,
      spawnSubagent: this.spawnSubagent,
      askUser: this.askUser,
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
    settle: (tc: ToolCall, index: number, result: ToolResult) => boolean,
    logger: RuntimeLogger,
  ): AsyncGenerator<LoopEvent, void> {
    yield { role: "tool_progress", toolName: tc.function.name, toolCallIndex: index, content: "running" }

    // CL-50: Progress queue — tools push updates via reportProgress, flushed after execution
    const progressQueue = createProgressQueue()

    const argsResult = parseToolCallArgs(tc.function.arguments, tc.function.name)
    if (!argsResult.ok) {
      const result = makeToolError(argsResult.error)
      settle(tc, index, result)
      yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
      return
    }
    if (shouldBlockSalvagedTruncatedWrite(tc.function.name, argsResult.args)) {
      const result = makeToolError(buildSalvagedTruncatedWriteBlockMessage(tc.function.name, argsResult.args))
      settle(tc, index, result)
      yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
      return
    }
    const permResult = await this.checkAskPermission(tc, index, argsResult.args)
    if (permResult === "deny") {
      const result = makeToolError(resolveDenyMessage(tc, this.tools, this.permissionEngine, argsResult.args))
      settle(tc, index, result)
      yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
      return
    }
    if (permResult === "ask") {
      const permPromise = this.requestPermission!(tc.function.name, argsResult.args) // create Promise before yielding
      yield { role: "permission_ask", toolName: tc.function.name, content: JSON.stringify(argsResult.args) }
      const allowed = await permPromise
      if (!allowed) {
        const result = makeToolError(`Tool call denied by user: ${tc.function.name}`)
        settle(tc, index, result)
        yield { role: "error", content: result.content, toolName: tc.function.name, toolCallIndex: index, severity: "error" }
        return
      }
    }

    const { event, result } = await this.executeToolResult(tc, index, signal, logger, progressQueue.push)
    settle(tc, index, result)
    // CL-50: Flush buffered progress before "done"
    for (const p of progressQueue.flush()) {
      yield { role: "tool_progress", toolName: tc.function.name, toolCallIndex: index, content: p.content, metadata: p.metadata }
    }
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
