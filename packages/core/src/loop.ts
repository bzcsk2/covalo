import type { ToolCall, ToolSpec, ChatMessage } from "./types.js"
import type { LoopEvent, SessionStats, ToolResult, ChatClient } from "./interface.js"
import { isToolUseFinishReason } from "./client.js"
import type { ContextManager } from "./context/manager.js"
import type { StreamingToolExecutor } from "./streaming-executor.js"
import type { AsyncSessionWriter } from "./session.js"
import type { FoldDecision } from "./context/token-estimator.js"
import type { ThinkingMode } from "./provider-thinking.js"
import { createDeepSeekCapabilities } from "./provider-thinking.js"
import { calculateCost } from "./pricing.js"
import { noopRuntimeLogger, type RuntimeLogger } from "./runtime-logger.js"
import {
  createToolCallIdNormalizer,
  createDuplicateDetector,
  injectPendingInstruction,
} from "./loop-helpers.js"
import { EarlyStopDetector } from "./early-stop.js"
import type { StopSignal } from "./early-stop.js"
import { salvageTextToolCallsInResponse, TextToolCallStreamFilter } from "./tool-calls/text-salvage.js"
import type { TaskLedgerTracker } from "./task-ledger.js"
import {
  evaluateVerificationGate,
  maybeResetVerificationGateCounter,
  type VerificationGateState,
} from "./governance/verification-gate.js"
import { parseToolCallArgs } from "./executor-helpers.js"
import type { SupervisorGuidanceConfig } from "./supervisor/guided-loop.js"
import {
  buildSupervisorTriggerContext,
  recordSupervisorFailureEvidence,
  recordSupervisorToolEvidence,
  runSupervisorGuidanceAtSafePoint,
} from "./supervisor/guided-loop.js"
import type { SupervisorTriggerContext } from "./supervisor/types.js"
import type { EffectiveHarnessPolicy } from "./harness/index.js"
import { resolveToolRouting } from "./tool-routing/two-stage-router.js"
import type { ToolRoutingMode } from "./tool-routing/types.js"

export interface PendingInstruction {
  content: string
  remaining: number
}

export interface LoopOptions {
  ctx: ContextManager
  client: ChatClient
  toolExecutor: StreamingToolExecutor
  toolSpecs: ToolSpec[]
  config: {
    apiKey: string
    baseUrl: string
    model: string
    maxTokens: number
    temperature: number
    provider?: string
  }
  signal: AbortSignal
  sessionWriter?: AsyncSessionWriter
  stats: SessionStats
  isInterrupted: () => boolean
  appendToolResult: (tc: ToolCall, result: ToolResult) => void
  takePendingInstruction?: () => PendingInstruction | null
  maxTurns?: number
  thinkingMode?: ThinkingMode
  logger?: RuntimeLogger
  submitId?: string
  /** ADV-HAR-02: 当前 submit 的有效 Harness 策略 */
  effectivePolicy?: EffectiveHarnessPolicy
  /** DRF-20: 早停检测器 */
  earlyStop?: EarlyStopDetector
  /** DRF-40: 任务账本 */
  taskLedger?: TaskLedgerTracker
  /** DRF-40: 完成前是否要求验证 */
  requireVerificationBeforeFinal?: boolean
  /** DRF-40: Verification Gate 计数器 */
  verificationGateState?: VerificationGateState
  /** DRF-40: ledger 更新后刷新可变上下文 */
  refreshLedgerContext?: () => void
  /** DRF-60: Supervisor 指导回注配置 */
  supervisorGuidance?: SupervisorGuidanceConfig
  /** DRF-60: 构建额外 Supervisor 触发上下文 */
  buildSupervisorExtras?: () => Partial<SupervisorTriggerContext>
  /** ADV-HAR-07: 工具路由策略 */
  toolRouting?: "two-stage" | "auto" | "direct"
  /** ADV-HAR-08: 验证策略 */
  verificationPolicy?: "block" | "require-or-waive" | "warn"
  /** Tool names allowed to execute in this loop turn. Undefined preserves legacy execution behavior. */
  allowedToolNames?: ReadonlySet<string>
}

const DEFAULT_MAX_TURNS = 100

export async function* runLoop(opts: LoopOptions): AsyncGenerator<LoopEvent> {
  const {
    ctx, client, toolExecutor, toolSpecs, config, signal, sessionWriter, stats, isInterrupted,
    appendToolResult, takePendingInstruction, maxTurns: maxTurnsOverride,
    thinkingMode: thinkingModeOverride = "off", logger = noopRuntimeLogger, submitId, earlyStop,
    taskLedger, requireVerificationBeforeFinal = false, verificationGateState,
    refreshLedgerContext, supervisorGuidance, buildSupervisorExtras,
    /** ADV-HAR-07: 工具路由策略 */
    toolRouting: toolRoutingMode,
    /** ADV-HAR-08: 验证策略 */
    verificationPolicy: verificationMode,
    allowedToolNames,
  } = opts
  const diagnosticsEnabled = logger.isEnabled("error")

  const maxTurns = maxTurnsOverride ?? DEFAULT_MAX_TURNS
  const thinkingMode = thinkingModeOverride

  // TUI-FIX-10: emit initial loop_transition
  yield {
    role: "orchestration",
    orchestration: {
      kind: "loop_transition",
      transition: { from: "observe", to: "observe", attempt: 1, timestamp: Date.now() },
    },
  }

  // CL-51: Safe-point helper — consume one pending instruction from the queue.
  const appendPendingInstruction = (): LoopEvent | null => {
    return injectPendingInstruction(takePendingInstruction, ctx, sessionWriter, turnCount)
  }

  // L2-fix: 统一 done 事件构造 + 持久化到 sessionWriter。
  // 原先新增的 interrupt/error_limit 路径只 yield 不写入 sessionWriter，
  // 导致 session replay / 崩溃恢复 / 调试日志不一致。
  const emitDone = (reason: string, metadata: Record<string, unknown> = {}): LoopEvent => {
    const evt: LoopEvent = { role: "done", metadata: { reason, ...metadata } }
    sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })
    return evt
  }

  const contextWindow = ctx.getContextWindow()

  // fold check before first turn (synchronous budget estimation)
  const fold = ctx.getFoldDecision()
  if (fold.action === "force") {
    yield { role: "status", content: "Context budget exceeded — forcing fold on next turn", severity: "warning" as const, metadata: { fold } }
  } else if (fold.action !== "none") {
    yield { role: "status", content: `Context at ${(fold.ratio * 100).toFixed(0)}% — fold recommended`, metadata: { fold } }
  }

  let turnCount = 0
  let consecutiveErrors = 0
  const recentToolCalls = createDuplicateDetector()
  // L8: per-loop 独立的 tool call ID normalizer 实例，避免 subagent 并发时
  // 共享模块级全局 seq 导致 per-turn reset 语义被破坏
  const toolCallIdNormalizer = createToolCallIdNormalizer()
  let totalToolCalls = 0

  /** DRF-40: 记录工具结果到 TaskLedger */
  const recordLedgerTool = (toolName: string, args: Record<string, unknown>, result: ToolResult): void => {
    if (!taskLedger) return
    const pendingBefore = taskLedger.verificationPending
    taskLedger.recordToolResult(toolName, args, result)
    refreshLedgerContext?.()
    if (verificationGateState) {
      const blockingAfter = taskLedger.verificationPending && taskLedger.changedFiles.length > 0
      maybeResetVerificationGateCounter(
        verificationGateState,
        pendingBefore,
        taskLedger.verificationPending,
        blockingAfter && requireVerificationBeforeFinal,
      )
    }
  }

  /** DRF-60: 在安全点请求 Supervisor 指导并注入 scratch */
  const trySupervisorGuidance = async function* (): AsyncGenerator<LoopEvent, boolean> {
    if (!supervisorGuidance || !taskLedger) return false

    const extras = buildSupervisorExtras?.() ?? {}
    const triggerCtx = buildSupervisorTriggerContext(supervisorGuidance.state, {
      supervisorConfigured: supervisorGuidance.supervisorConfigured ?? true,
      ...extras,
    })

    const outcome = await runSupervisorGuidanceAtSafePoint(
      supervisorGuidance,
      triggerCtx,
      taskLedger.snapshot(),
      ctx,
    )

    if (!outcome.statusContent) return false

    // TUI-FIX-10: emit supervisor orchestration events
    if (outcome.injected && outcome.result?.candidateId) {
      yield {
        role: "orchestration",
        orchestration: {
          kind: "supervisor_upsert",
          supervisor: {
            id: outcome.result.candidateId,
            modelTarget: outcome.result.candidateId,
            status: "idle",
          },
        },
      }
      if (outcome.result.advice) {
        yield {
          role: "orchestration",
          orchestration: {
            kind: "supervisor_advice",
            supervisorId: outcome.result.candidateId,
            workerId: "main",
            advice: outcome.result.advice.diagnosis,
            adopted: true,
          },
        }
      }
    } else if (!outcome.injected) {
      yield {
        role: "orchestration",
        orchestration: {
          kind: "supervisor_upsert",
          supervisor: {
            id: "supervisor",
            modelTarget: "supervisor",
            status: "unavailable",
          },
        },
      }
    }

    const evt: LoopEvent = {
      role: "status",
      content: outcome.statusContent,
      severity: outcome.injected ? "info" : "warning",
      metadata: outcome.statusMetadata,
    }
    yield evt
    sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })

    if (outcome.injected) {
      sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
      return true
    }

    if (outcome.degradedMessage) {
      const degradeEvt: LoopEvent = {
        role: "status",
        content: outcome.degradedMessage,
        severity: "warning",
        metadata: { supervisorDegraded: true },
      }
      yield degradeEvt
      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: degradeEvt })
    }
    return false
  }

  /** DRF-40: 尝试拦截 done 并注入验证提示 */
  const tryVerificationGate = function* (): Generator<LoopEvent, boolean> {
    // ADV-HAR-08: warn 模式即使 requireVerificationBeforeFinal=false 也要产生警告
    // require-or-waive / block 模式仅在有 taskLedger 且 requireVerificationBeforeFinal 时生效
    if (!taskLedger) return false
    if (!requireVerificationBeforeFinal && verificationMode !== "warn") return false

    const gateState = verificationGateState ?? { continuationCount: 0 }
    const decision = evaluateVerificationGate(
      taskLedger.snapshot(),
      requireVerificationBeforeFinal,
      gateState,
    )
    if (!decision.blocking) return false

    // ADV-HAR-08: 根据 verificationPolicy 决定行为
    // - "block": 硬阻断，必须验证
    // - "require-or-waive": 要求验证或用户可继续绕过
    // - "warn": 仅警告，不阻断
    const mode = verificationMode ?? "block"

    if (mode === "warn") {
      const warnEvt: LoopEvent = {
        role: "status",
        content: "verification_gate_warning",
        severity: "warning",
        metadata: {
          verificationPending: taskLedger.verificationPending,
          changedFiles: taskLedger.changedFiles.length,
          message: "Verification pending but not blocking (loose mode)",
        },
      }
      yield warnEvt
      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: warnEvt })
      return false
    }

    if (mode === "require-or-waive") {
      // require-or-waive: 提醒用户验证，但允许继续
      // 首次触发时发出可豁免警告；重复触发时退化为硬阻断
      gateState.continuationCount++
      const isFirstWaive = gateState.continuationCount <= 2
      const evt: LoopEvent = {
        role: "status",
        content: isFirstWaive ? "verification_gate_waivable" : "verification_gate",
        severity: "warning",
        metadata: {
          verificationPending: taskLedger.verificationPending,
          changedFiles: taskLedger.changedFiles.length,
          continuationCount: gateState.continuationCount,
          verificationMode: mode,
          waivable: isFirstWaive,
          message: isFirstWaive
            ? "Verification recommended — continue to waive verification"
            : `Verification required after ${gateState.continuationCount} continuations`,
        },
      }
      yield evt
      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })
      if (isFirstWaive) {
        // 首次：允许绕过（用户通过再次 submit 继续即可）
        ctx.log.append({ role: "user", content: decision.prompt })
        sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
      }
      // 始终返回 true（阻塞 done），用户可再次 submit 继续
      return true
    }

    // block 模式：硬阻断
    gateState.continuationCount++
    ctx.log.append({ role: "user", content: decision.prompt })
    sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })

    const evt: LoopEvent = {
      role: "status",
      content: "verification_gate",
      severity: "warning",
      metadata: {
        verificationPending: taskLedger.verificationPending,
        changedFiles: taskLedger.changedFiles.length,
        continuationCount: gateState.continuationCount,
        requiresUser: decision.requiresUser,
        verificationMode: mode,
      },
    }
    yield evt
    sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })
    return true
  }

  while (turnCount < maxTurns) {
    turnCount++
    earlyStop?.newTurn()
    if (diagnosticsEnabled) logger.debug("loop.turn.start", { turnCount, thinkingMode })
    toolCallIdNormalizer.reset()  // L8: per-loop 实例 reset per-turn sequence
    if (isInterrupted()) {
      yield { role: "status", content: "interrupted" }
      yield emitDone("interrupted")
      return
    }

    let fullContent = ""
    let fullReasoning = ""
    const toolCalls: ToolCall[] = []
    let streamError: LoopEvent | null = null
    let finishedWithToolUse = false
    const textToolCallFilter = new TextToolCallStreamFilter()

    const provider = config.provider ?? ""
    const isKeyless = provider === "kilo" || provider === "openai-compatible"
    const useMaxTokens = provider === "kilo" || provider === "openai-compatible"
    const supportsThinking = provider === "deepseek" || provider === "zen" || provider === "mimo"

    // ADV-HAR-07: 根据 toolRouting 策略决定本轮注入的工具集
    let routedTools: ToolSpec[] | undefined
    if (toolSpecs.length > 0) {
      const routingMode: ToolRoutingMode = toolRoutingMode === "two-stage" ? "two_stage" : "direct"
      const routingCtx = {
        allTools: toolSpecs,
        contextWindow: ctx.getContextWindow(),
        routingOverride: routingMode,
      }
      const routingDecision = resolveToolRouting(routingCtx)
      routedTools = routingDecision.tools
      if (routingDecision.schemaBudgetExceeded && diagnosticsEnabled) {
        logger.info("loop.toolRouting", {
          mode: routingDecision.mode,
          stage: routingDecision.stage,
          estimatedSchemaTokens: routingDecision.estimatedSchemaTokens,
          toolCount: routedTools.length,
        })
      }
    }

    // L1-fix: 把 ctx.buildMessages() 从 stream try-catch 中拆出。
    // 原先 buildMessages 抛出的确定性错误（prefix/scratch 超窗、aggressive
    // truncation 后仍超窗、消息结构错误）会被 stream catch 捕获并转入
    // consecutiveErrors 重试逻辑，但这类错误重试无意义，且会让 TUI/日志
    // 误判为 stream 层失败。现在 context error 直接 error + done 退出。
    let requestMessages: ChatMessage[]
    try {
      requestMessages = ctx.buildMessages()
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      const errEvt: LoopEvent = {
        role: "error",
        content: errMsg,
        severity: "error" as const,
        metadata: { source: "context_build", ...(err instanceof Error ? { name: err.name } : {}) },
      }
      yield errEvt
      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: errEvt })
      yield emitDone("context_error")
      return
    }

    try {
    streamLoop:
    for await (const event of client.chatCompletionsStream(requestMessages, {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      signal,
      keyless: isKeyless,
      useMaxCompletionTokens: !useMaxTokens,
      tools: routedTools,
      ...(supportsThinking ? createDeepSeekCapabilities(provider).mapMode(thinkingMode) : {}),
      traceContext: diagnosticsEnabled ? { submitId, turnCount } : undefined,
      firstEventTimeoutMs: config.provider === "zen" ? 15_000 : undefined,
      fallbackModel: config.provider === "zen" && config.model !== "deepseek-v4-flash-free"
        ? "deepseek-v4-flash-free"
        : undefined,
    })) {
      if (isInterrupted()) {
        yield { role: "status", content: "interrupted" }
        yield emitDone("interrupted")
        return
      }

      switch (event.type) {
        case "text_delta": {
          fullContent += event.delta
          const visibleDelta = textToolCallFilter.feed(event.delta)
          if (visibleDelta) {
            yield { role: "assistant_delta", content: visibleDelta }
            sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "assistant_delta", content: visibleDelta } })
          }
          if (earlyStop) {
            const repSignal = earlyStop.checkRepetition(fullContent)
            if (repSignal) {
              yield* emitEarlyStopSignal(repSignal, ctx, sessionWriter, supervisorGuidance?.state)
            }
          }
          break
        }

        case "status":
          yield { role: "status", content: event.content, metadata: event.metadata }
          break

        case "reasoning_delta":
          fullReasoning += event.delta
          yield { role: "reasoning_delta", content: event.delta }
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "reasoning_delta", content: event.delta } })
          break

        case "tool_call_end": {
          const normalizedId = toolCallIdNormalizer.normalize(event.id, event.name)
          const tc: ToolCall = {
            id: normalizedId,
            type: "function",
            function: { name: event.name, arguments: event.arguments },
          }
          toolCalls.push(tc)
          yield { role: "tool_call_delta", toolName: event.name, toolCallIndex: event.toolCallIndex, content: event.arguments }
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "tool_call_delta", toolName: event.name, toolCallIndex: event.toolCallIndex, content: event.arguments } })
          break
        }

        case "usage":
          stats.promptTokens += event.usage.promptTokens
          stats.completionTokens += event.usage.completionTokens
          stats.cacheHitTokens += event.usage.cacheHitTokens ?? 0
          stats.cacheMissTokens += event.usage.cacheMissTokens ?? 0
          stats.totalCost = calculateCost(config.model, stats.promptTokens, stats.completionTokens, stats.cacheHitTokens, stats.cacheMissTokens)
          yield { role: "usage", metadata: { input: event.usage.promptTokens, output: event.usage.completionTokens, cacheHit: event.usage.cacheHitTokens ?? 0, cacheMiss: event.usage.cacheMissTokens ?? 0 } as Record<string, unknown> }
          sessionWriter?.enqueue({ ts: Date.now(), type: "stats", payload: { ...stats } })
          break

        case "done": {
          stats.apiCalls++  // 每轮只计数一次，避免 usage 重复事件导致偏高
          const reason = event.finishReason ?? "stop"
          const isToolUse = isToolUseFinishReason(reason)

          yield { role: "assistant_final", content: fullContent, metadata: { reasoning: fullReasoning || undefined } }

          if (isToolUse) {
            // Some OpenAI-compatible providers repeat the same finish_reason
            // chunk after usage. Never execute a completed tool batch twice.
            if (finishedWithToolUse) break
            if (toolCalls.length === 0) {
              yield { role: "warning", content: "API returned tool_calls finish_reason but no tool calls found", severity: "warning" as const }
              break
            }
            // CL-51: duplicate tool call detection
            let blockedToolCall: { name: string; count: number } | null = null
            for (const tc of toolCalls) {
              const { warning, blocked, count } = recentToolCalls.check(tc)
              if (warning) {
                yield { role: "warning", content: warning, severity: "warning" as const }
              }
              if (blocked && !blockedToolCall) {
                blockedToolCall = { name: tc.function.name, count }
              }
            }

            finishedWithToolUse = true
            ctx.log.append({ role: "assistant", content: fullContent || null, reasoning_content: fullReasoning || undefined, tool_calls: toolCalls })
            sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            totalToolCalls += toolCalls.length

            if (blockedToolCall) {
              const content = `Stopped repeated tool-call loop: ${blockedToolCall.name} was requested ${blockedToolCall.count} times with identical arguments.`
              for (const tc of toolCalls) {
                appendToolResult(tc, { content, isError: true, metadata: { reason: "toolCallLoop" } })
              }
              yield { role: "error", content, severity: "error" as const, metadata: { reason: "toolCallLoop", toolName: blockedToolCall.name, count: blockedToolCall.count } }
              yield { role: "done", metadata: { reason: "toolCallLoop" } }
              sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
              sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "done", metadata: { reason: "toolCallLoop" } } })
              return
            }

            try {
              for await (const toolEvent of toolExecutor.run(toolCalls, signal, appendToolResult, diagnosticsEnabled ? { submitId, turnCount } : undefined, allowedToolNames)) {
                yield toolEvent
                // P5.5: tool_progress is transient — don't persist to session
                if (toolEvent.role !== 'tool_progress') {
                  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: toolEvent })
                }
                // DRF-40: 记录工具结果到 TaskLedger
                if (taskLedger && (toolEvent.role === "tool" || toolEvent.role === "error") && toolEvent.toolName) {
                  const tc = findToolCallByIdOrName(toolCalls, toolEvent.toolCallId, toolEvent.toolName, toolEvent.toolCallIndex)
                  if (tc) {
                    const argsResult = parseToolCallArgs(tc.function.arguments, tc.function.name)
                    if (argsResult.ok) {
                      const isErr = toolEvent.role === "error" || !!toolEvent.metadata?.error
                      recordLedgerTool(toolEvent.toolName, argsResult.args, {
                        isError: isErr,
                        content: toolEvent.content ?? "",
                        metadata: toolEvent.metadata,
                      })
                      if (supervisorGuidance) {
                        recordSupervisorToolEvidence(
                          supervisorGuidance.state,
                          toolEvent.toolName,
                          !isErr,
                          (toolEvent.content ?? "").slice(0, 200),
                        )
                        if (isErr) {
                          const sigKey = typeof argsResult.args.path === "string"
                            ? argsResult.args.path
                            : typeof argsResult.args.command === "string"
                              ? argsResult.args.command
                              : "err"
                          recordSupervisorFailureEvidence(
                            supervisorGuidance.state,
                            `${toolEvent.toolName}:${sigKey}`,
                            toolEvent.content,
                          )
                        }
                      }
                    }
                  }
                }
                // DRF-20: 早停信号检测
                if (earlyStop && (toolEvent.role === "tool" || toolEvent.role === "error") && toolEvent.toolName) {
                  const toolSignal = earlyStop.recordReadTool(toolEvent.toolName)
                  if (toolSignal) yield* emitEarlyStopSignal(toolSignal, ctx, sessionWriter, supervisorGuidance?.state)
                  if (!toolEvent.metadata?.error && ["write_file", "edit", "NotebookEdit", "bash"].includes(toolEvent.toolName)) {
                    earlyStop.recordWriteTool(toolEvent.toolName)
                  }
                }
              }
              // persist messages with tool results for crash recovery
              sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            } catch (err) {
              logger?.warn("loop.tool_batch_error", {
                error: err instanceof Error ? err.message : String(err),
                turnCount,
              })
              // P1: StreamingToolExecutor handles settling remaining tools internally.
              // No blind batch补写 here — it would duplicate results for already-completed tools.
            }
            yield { role: "status", content: "tools_completed" }
            sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "status", content: "tools_completed" } })

            // DRF-60: Safe point — Supervisor 指导（暂停工具环后继续 Worker）
            const supervisorInjected = yield* trySupervisorGuidance()
            if (supervisorInjected) {
              break streamLoop
            }

            // P2: Safe point 1 — consume one pending instruction after tool batch
            const injectedAfterTools = appendPendingInstruction()
            if (injectedAfterTools) {
              yield injectedAfterTools
            }
            // End current stream consumption: return to outer while for next turn
            break streamLoop
          } else if (finishedWithToolUse) {
            // defensive: second done after tool use
            break streamLoop
          } else {
            const filterTail = textToolCallFilter.flush()
            if (filterTail) {
              yield { role: "assistant_delta", content: filterTail }
              sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "assistant_delta", content: filterTail } })
            }

            // DRF-31: stop 且无原生 tool_calls 时，抢救正文中的嵌入工具调用
            if (reason === "stop" && toolCalls.length === 0 && fullContent.trim()) {
              const salvaged = salvageTextToolCallsInResponse({
                content: fullContent,
                finishReason: reason,
                toolCalls: [],
              })
              if (salvaged.toolCalls?.length) {
                const salvagedCalls = salvaged.toolCalls
                const cleanContent = salvaged.content || ""
                ctx.log.append({
                  role: "assistant",
                  content: cleanContent || null,
                  reasoning_content: fullReasoning || undefined,
                  tool_calls: salvagedCalls,
                })
                sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
                totalToolCalls += salvagedCalls.length

                try {
                  for await (const toolEvent of toolExecutor.run(salvagedCalls, signal, appendToolResult, diagnosticsEnabled ? { submitId, turnCount } : undefined, allowedToolNames)) {
                    yield toolEvent
                    if (toolEvent.role !== "tool_progress") {
                      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: toolEvent })
                    }
                    if (taskLedger && (toolEvent.role === "tool" || toolEvent.role === "error") && toolEvent.toolName) {
                      const tc = findToolCallByIdOrName(salvagedCalls, toolEvent.toolCallId, toolEvent.toolName, toolEvent.toolCallIndex)
                      if (tc) {
                        const argsResult = parseToolCallArgs(tc.function.arguments, tc.function.name)
                        if (argsResult.ok) {
                          recordLedgerTool(toolEvent.toolName, argsResult.args, {
                            isError: toolEvent.role === "error" || !!toolEvent.metadata?.error,
                            content: toolEvent.content ?? "",
                            metadata: toolEvent.metadata,
                          })
                        }
                      }
                    }
                    if (earlyStop && (toolEvent.role === "tool" || toolEvent.role === "error") && toolEvent.toolName) {
                      const toolSignal = earlyStop.recordReadTool(toolEvent.toolName)
                      if (toolSignal) yield* emitEarlyStopSignal(toolSignal, ctx, sessionWriter, supervisorGuidance?.state)
                      if (!toolEvent.metadata?.error && ["write_file", "edit", "NotebookEdit", "bash"].includes(toolEvent.toolName)) {
                        earlyStop.recordWriteTool(toolEvent.toolName)
                      }
                    }
                  }
                  sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
                } catch (err) {
                  logger?.warn("loop.tool_batch_error_secondary", {
                    error: err instanceof Error ? err.message : String(err),
                    turnCount,
                  })
                  // StreamingToolExecutor handles settling remaining tools internally
                }
                yield { role: "status", content: "tools_completed" }
                sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "status", content: "tools_completed" } })

                const injectedAfterSalvage = appendPendingInstruction()
                if (injectedAfterSalvage) {
                  yield injectedAfterSalvage
                }
                break
              }
            }

            if (earlyStop) {
              const greetSignal = earlyStop.checkGreeting(fullContent, totalToolCalls > 0)
              if (greetSignal) yield* emitEarlyStopSignal(greetSignal, ctx, sessionWriter, supervisorGuidance?.state)
            }

            // DRF-40: 尝试从模型响应提取计划
            if (taskLedger && fullContent.trim()) {
              if (taskLedger.ingestPlanFromText(fullContent)) {
                refreshLedgerContext?.()
                yield {
                  role: "status",
                  content: "task_ledger_plan",
                  metadata: { stepCount: taskLedger.plan.length },
                }
              }
            }

            ctx.log.append({ role: "assistant", content: fullContent })

            // P2: Safe point 2 — check for pending instructions before ending turn
            const injectedBeforeDone = appendPendingInstruction()
            if (injectedBeforeDone) {
              yield injectedBeforeDone
              // Don't yield done — continue the loop to process the injected instruction
              break
            }

            // DRF-40: Verification Gate — 拦截未验证的 done
            const gated = yield* tryVerificationGate()
            if (gated) {
              break
            }

            yield { role: "done", metadata: { reason } as Record<string, unknown> }
            sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "done", metadata: { reason } } })
            return
          }
          break
        }

        case "error":
          streamError = { role: "error", content: event.message, severity: "error" as const, metadata: { ...(event.status ? { status: event.status } : {}), responseBody: event.body } }
          yield streamError
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: streamError })
          if (toolCalls.length > 0) {
            break streamLoop
          }
          break
      }
    }
    } catch (err) {
      // L1/L3: 统一处理流式 throw（AbortError / 网络错误 / JSON 解析错误）
      // 原先 for await 无 try-catch，throw 会直接击穿循环
      if (isInterrupted() || (err instanceof Error && (err.name === "AbortError" || signal.aborted))) {
        yield { role: "status", content: "interrupted" }
        yield emitDone("interrupted")
        return
      }
      // 转换为 streamError，走下方重试路径（与 emit error 事件一致）
      streamError = {
        role: "error",
        content: err instanceof Error ? err.message : String(err),
        severity: "error" as const,
        metadata: { ...(err instanceof Error ? { name: err.name } : {}), source: "throw" },
      }
      yield streamError
      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: streamError })
    }

    if (streamError) {
      if (isInterrupted()) {
        yield { role: "status", content: "interrupted" }
        yield emitDone("interrupted")
        return
      }
      if (toolCalls.length > 0) {
        // Stream error after tool_calls were emitted: append tool_calls + error results
        // to maintain protocol consistency, then retry
        ctx.log.append({ role: "assistant", content: fullContent || null, tool_calls: toolCalls })
        for (const tc of toolCalls) {
          appendToolResult(tc, { content: "Stream error: tool call result not available", isError: true, metadata: { error: "stream_error" } })
        }
        sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
      } else if (fullContent) {
        ctx.log.append({ role: "assistant", content: fullContent })
      }
      consecutiveErrors++
      if (diagnosticsEnabled) logger.warn("loop.stream.retry", { consecutiveErrors, turnCount })
      if (consecutiveErrors >= 3) {
        yield { role: "error", content: `Stream failed after ${consecutiveErrors} consecutive attempts`, severity: "error" as const }
        yield emitDone("error_limit")
        return
      }
      continue
    }
    consecutiveErrors = 0
  }

  if (diagnosticsEnabled) logger.warn("loop.max_turns", { maxTurns })
  yield { role: "warning", content: `Reached maximum tool loop count (${maxTurns}).`, severity: "warning" as const }
  yield { role: "done", metadata: { reason: "maxTurns" } }
}

/** 注入早停纠正信号到上下文 */
function* emitEarlyStopSignal(
  signal: StopSignal,
  ctx: ContextManager,
  sessionWriter?: AsyncSessionWriter,
  supervisorState?: SupervisorGuidanceConfig["state"],
): Generator<LoopEvent> {
  if (supervisorState) {
    supervisorState.lastStopSignalReason = signal.reason
  }
  const evt: LoopEvent = {
    role: "status",
    content: "early_stop",
    severity: "warning",
    metadata: { reason: signal.reason, message: signal.message, action: signal.action },
  }
  // TUI-FIX-10: emit runtime_signal orchestration event
  const signalKind = signal.reason === "repetition" ? "no-progress"
    : signal.reason === "read-loop" ? "no-progress"
    : signal.reason === "patch-spiral" ? "repeated-error"
    : "verification-failed"
  const orchEvent: LoopEvent = {
    role: "orchestration",
    orchestration: {
      kind: "runtime_signal",
      signal: { kind: signalKind, message: signal.message },
    },
  }
  ctx.log.append({ role: "user", content: signal.injection })
  sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
  yield evt
  yield orchEvent
  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: evt })
  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: orchEvent })
}

/** Find tool call by id (preferred), then index, then name (fallback). */
function findToolCallByIdOrName(
  toolCalls: import("./types.js").ToolCall[],
  toolCallId?: string,
  toolName?: string,
  toolCallIndex?: number,
): import("./types.js").ToolCall | undefined {
  if (toolCallId) {
    const byId = toolCalls.find(t => t.id === toolCallId)
    if (byId) return byId
  }
  if (toolCallIndex !== undefined && toolCallIndex >= 0 && toolCallIndex < toolCalls.length) {
    return toolCalls[toolCallIndex]
  }
  if (toolName) {
    return toolCalls.find(t => t.function.name === toolName)
  }
  return undefined
}
