import type { ToolCall, ChatMessage } from "../types.js"
import type { LoopEvent, SessionStats, ChatClient } from "../interface.js"
import { isToolUseFinishReason } from "../finish-reason.js"
import type { ContextManager } from "../context/manager.js"
import type { AsyncSessionWriter } from "../session.js"
import type { FoldDecision } from "../context/token-estimator.js"
import { runPolicyHook, runPolicyHookEvents } from "./policy.js"
import type { ThinkingMode } from "../provider-thinking.js"
import { createDeepSeekCapabilities } from "../provider-thinking.js"
import { calculateCost } from "../pricing.js"
import { noopRuntimeLogger, type RuntimeLogger } from "../runtime-logger.js"
import {
  createToolCallIdNormalizer,
  createDuplicateDetector,
  createRepeatedFailureTracker,
  injectPendingInstruction,
} from "../loop-helpers.js"
import { TextToolCallStreamFilter } from "../tool-calls/text-salvage.js"
import type { TaskLedgerTracker } from "../task-ledger.js"
import type { SupervisorGuidanceConfig } from "../supervisor/guided-loop.js"
import { runSupervisorGuidanceSafePoint } from "./policies/supervisor-guidance-policy.js"
import type { EffectiveHarnessPolicy } from "../harness/index.js"
import { resolveLoopToolRouting } from "./policies/tool-routing-policy.js"
import { createBranchBudgetLoopPolicy } from "./policies/branch-budget-policy.js"
import { createTaskLedgerLoopPolicy } from "./policies/task-ledger-policy.js"
import { createSupervisorEvidenceLoopPolicy } from "./policies/supervisor-evidence-policy.js"
import { createRepeatedFailureLoopPolicy } from "./policies/repeated-failure-policy.js"
import { createToolCallLoopPolicy } from "./policies/tool-call-loop-policy.js"
import { createTwoStageRoutingLoopPolicy, createTwoStageRoutingState } from "./policies/two-stage-routing-policy.js"
import { createEarlyStopGreetingLoopPolicy, createEarlyStopRepetitionLoopPolicy, createEarlyStopToolLoopPolicy } from "./policies/early-stop-policy.js"
import {
  createEmptyRuntimeExecutionState,
  resolveInitialExecutionMode,
  isAutoModeDecisionEnabled,
  type ExecutionMode,
  type ModeDecision,
} from "../governance/mode-decision.js"
import { evaluateLoopExecutionMode } from "./policies/execution-mode-policy.js"
import type { HarnessMode } from "../model-profile/types.js"
import type { AgentRole } from "../agent-profile/types.js"
import type { LoopPolicy, LoopPolicyEventEmission } from "./policy.js"
import type { LoopOptions } from "../loop.js"
import type { LoopPolicyContext } from "./policy.js"
import { runToolBatch } from "./tool-batch-runner.js"
import { runTextToolSalvage } from "./text-salvage-runner.js"
import { runFinalResponse } from "./final-response-runner.js"
import { recoverFromStreamError } from "./stream-error-runner.js"

const DEFAULT_MAX_TURNS = 100

export async function* runCoreLoop(opts: LoopOptions & { policies?: LoopPolicy[] }): AsyncGenerator<LoopEvent> {
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
    customToolNames,
    /** F0-1: governance/checkpoint 三件套 */
    branchBudgetTracker,
    checkpointEngine,
    modeDecisionEngine,
    workspaceRoot,
    /** FIX-H1: 当前 loop 角色，supervisor 跳过 toolset 二次过滤 */
    role,
    /** F0-1: 有效策略（executionMode / branchBudget / checkpoint 三字段被运行时消费） */
    effectivePolicy,
    policies: _policies,
  } = opts
  let turnCount = 0
  const policyCtx: LoopPolicyContext = {
    get turnCount() { return turnCount },
    logger, signal, ctx, effectivePolicy, role,
  }
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
  const emitDone = async (reason: string, metadata: Record<string, unknown> = {}): Promise<LoopEvent> => {
    await runPolicyHook(policies, "afterDone", policyCtx)
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
  let consecutiveErrors = 0
  const recentToolCalls = createDuplicateDetector()
  // S2-1: 按 {toolName, args, errorContent} 追踪重复失败；同签名连续 3 次报告 blocked
  const repeatedFailures = createRepeatedFailureTracker()
  // L8: per-loop 独立的 tool call ID normalizer 实例，避免 subagent 并发时
  // 共享模块级全局 seq 导致 per-turn reset 语义被破坏
  const toolCallIdNormalizer = createToolCallIdNormalizer()
  let totalToolCalls = 0

  const twoStageRoutingState = createTwoStageRoutingState()

  // F0-1: governance/checkpoint 运行时状态
  // 从 effectivePolicy.executionMode 映射到 HarnessMode（free/adaptive/forced/strict）
  const harnessMode: HarnessMode = effectivePolicy?.executionMode === "forced"
    ? "forced"
    : effectivePolicy?.executionMode === "free"
      ? "free"
      : "adaptive"
  // 是否启用自动 mode 决策（free 模式下完全跳过 evaluate）
  const autoModeDecisionEnabled = isAutoModeDecisionEnabled(harnessMode)
  // 当前 executionMode（free/forced），由 ModeDecisionEngine 每轮刷新；
  // forced/strict 直接从 forced 开始；free/adaptive 从 free 开始
  let currentExecutionMode: ExecutionMode = resolveInitialExecutionMode(harnessMode)
  // mode lock 倒计时（enter_forced 时设为 lockRounds，每轮递减）
  let executionModeLockRemaining = 0
  // 是否在 submit 开始时已经从 checkpoint 恢复过（避免重复 loadV2）
  // engine.ts 在 submit 入口已经做过一次 loadV2 + applySnapshot，loop 不应再做
  // 运行时执行状态快照（喂给 ModeDecisionEngine.evaluate）
  const runtimeState = createEmptyRuntimeExecutionState()
  if (workspaceRoot) {
    branchBudgetTracker?.bindWorkspaceRoot(workspaceRoot)
  }
  const policies: LoopPolicy[] = [
    ...(_policies ?? []),
    createToolCallLoopPolicy({ recentToolCalls, appendToolResult }),
    createBranchBudgetLoopPolicy({
      branchBudgetTracker,
      runtimeState,
      appendToolResult,
      effectivePolicy,
      workspaceRoot,
    }),
    createTwoStageRoutingLoopPolicy({
      state: twoStageRoutingState,
      appendToolResult,
    }),
    createTaskLedgerLoopPolicy({
      taskLedger,
      refreshLedgerContext,
      verificationGateState,
      requireVerificationBeforeFinal,
    }),
    createSupervisorEvidenceLoopPolicy({ supervisorGuidance }),
    createRepeatedFailureLoopPolicy({ repeatedFailures }),
    createEarlyStopRepetitionLoopPolicy({
      earlyStop,
      sessionWriter,
      supervisorState: supervisorGuidance?.state,
    }),
    createEarlyStopToolLoopPolicy({
      earlyStop,
      sessionWriter,
      supervisorState: supervisorGuidance?.state,
    }),
    createEarlyStopGreetingLoopPolicy({
      earlyStop,
      sessionWriter,
      supervisorState: supervisorGuidance?.state,
    }),
  ]
  // F0-1: enforced 模式下初始化时即开启 forced policy
  if (currentExecutionMode === "forced") {
    checkpointEngine?.setForcedPolicy(true)
  }

  const evaluateExecutionMode = (): ModeDecision | null => {
    const { decision, currentExecutionMode: newMode, executionModeLockRemaining: newLock } = evaluateLoopExecutionMode({
      modeDecisionEngine, checkpointEngine, branchBudgetTracker, runtimeState,
      turnCount, currentExecutionMode, executionModeLockRemaining,
      harnessMode, autoModeDecisionEnabled, taskLedger,
    })
    currentExecutionMode = newMode
    executionModeLockRemaining = newLock
    return decision
  }

  const emitPolicyEvents = function* (emissions: LoopPolicyEventEmission[]): Generator<LoopEvent> {
    for (const emission of emissions) {
      yield emission.event
    }
    for (const emission of emissions) {
      if (emission.persist === false) continue
      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: emission.sessionEvent ?? emission.event })
    }
  }

  /** DRF-60: 在安全点请求 Supervisor 指导并注入 scratch */
  const trySupervisorGuidance = () => runSupervisorGuidanceSafePoint({
    supervisorGuidance, taskLedger, buildSupervisorExtras, ctx, sessionWriter,
  })

  while (turnCount < maxTurns) {
    turnCount++
    earlyStop?.newTurn()
    await runPolicyHook(policies, "beforeTurn", policyCtx)
    if (diagnosticsEnabled) logger.debug("loop.turn.start", { turnCount, thinkingMode })
    toolCallIdNormalizer.reset()  // L8: per-loop 实例 reset per-turn sequence

    // F0-1: 每轮 turn 开始时评估 executionMode（mode lock 递减）
    if (executionModeLockRemaining > 0) executionModeLockRemaining--
    const modeDecision = evaluateExecutionMode()
    if (modeDecision && diagnosticsEnabled) {
      logger.info("loop.mode_decision", {
        turnCount,
        action: modeDecision.action,
        mode: currentExecutionMode,
      })
    }

    if (isInterrupted()) {
      yield { role: "status", content: "interrupted" }
      yield await emitDone("interrupted")
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

    // ADV-HAR-07/TR-1: 根据 toolRouting 策略决定本轮注入的工具集
    const { routedTools, effectiveAllowedToolNames, routingDecision } = resolveLoopToolRouting({
      toolSpecs,
      toolRoutingMode,
      contextWindow: ctx.getContextWindow(),
      selectedCategory: twoStageRoutingState.selectedCategory,
      effectivePolicy,
      role,
      customToolNames,
      allowedToolNames,
    })

    if (routingDecision?.schemaBudgetExceeded && diagnosticsEnabled) {
      logger.info("loop.toolRouting", {
        mode: routingDecision.mode,
        stage: routingDecision.stage,
        estimatedSchemaTokens: routingDecision.estimatedSchemaTokens,
        toolCount: routedTools?.length ?? 0,
        selectedCategory: twoStageRoutingState.selectedCategory,
      })
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
      await runPolicyHook(policies, "onError", policyCtx, err)
      yield errEvt
      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: errEvt })
      yield await emitDone("context_error")
      return
    }

    try {
    await runPolicyHook(policies, "beforeModelCall", policyCtx)
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
        yield await emitDone("interrupted")
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
          yield* emitPolicyEvents(await runPolicyHookEvents(policies, "afterModelEvent", policyCtx, event, { fullContent }))
          break
        }

        case "status":
          yield* emitPolicyEvents(await runPolicyHookEvents(policies, "afterModelEvent", policyCtx, event, { fullContent }))
          yield { role: "status", content: event.content, metadata: event.metadata }
          break

        case "reasoning_delta":
          yield* emitPolicyEvents(await runPolicyHookEvents(policies, "afterModelEvent", policyCtx, event, { fullContent }))
          fullReasoning += event.delta
          yield { role: "reasoning_delta", content: event.delta }
          sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "reasoning_delta", content: event.delta } })
          break

        case "tool_call_end": {
          yield* emitPolicyEvents(await runPolicyHookEvents(policies, "afterModelEvent", policyCtx, event, { fullContent }))
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
          yield* emitPolicyEvents(await runPolicyHookEvents(policies, "afterModelEvent", policyCtx, event, { fullContent }))
          stats.promptTokens += event.usage.promptTokens
          stats.completionTokens += event.usage.completionTokens
          stats.cacheHitTokens += event.usage.cacheHitTokens ?? 0
          stats.cacheMissTokens += event.usage.cacheMissTokens ?? 0
          stats.totalCost = calculateCost(config.model, stats.promptTokens, stats.completionTokens, stats.cacheHitTokens, stats.cacheMissTokens)
          yield { role: "usage", metadata: { input: event.usage.promptTokens, output: event.usage.completionTokens, cacheHit: event.usage.cacheHitTokens ?? 0, cacheMiss: event.usage.cacheMissTokens ?? 0 } as Record<string, unknown> }
          sessionWriter?.enqueue({ ts: Date.now(), type: "stats", payload: { ...stats } })
          break

        case "done": {
          yield* emitPolicyEvents(await runPolicyHookEvents(policies, "afterModelEvent", policyCtx, event, { fullContent }))
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
            finishedWithToolUse = true
            ctx.log.append({ role: "assistant", content: fullContent || null, reasoning_content: fullReasoning || undefined, tool_calls: toolCalls })
            sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            totalToolCalls += toolCalls.length

            const toolBatchResult = yield* runToolBatch({
              source: "native",
              toolCalls,
              toolExecutor,
              signal,
              appendToolResult,
              diagnosticsEnabled,
              submitId,
              turnCount,
              effectiveAllowedToolNames,
              maxParallelTools: effectivePolicy?.maxParallelTools,
              ctx,
              sessionWriter,
              policies,
              policyCtx,
              logger,
              errorLogName: "loop.tool_batch_error",
            })
            if (toolBatchResult.done) {
              const { reason: doneReason, metadata } = toolBatchResult.done
              yield await emitDone(doneReason, metadata)
              return
            }
            if (toolBatchResult.intercepted) {
              break streamLoop
            }

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

            const salvageResult = yield* runTextToolSalvage({
              fullContent,
              fullReasoning,
              finishReason: reason,
              nativeToolCalls: toolCalls,
              effectivePolicy,
              toolExecutor,
              signal,
              appendToolResult,
              diagnosticsEnabled,
              submitId,
              turnCount,
              effectiveAllowedToolNames,
              ctx,
              sessionWriter,
              policies,
              policyCtx,
              logger,
            })
            totalToolCalls += salvageResult.toolCallCount
            if (salvageResult.done) {
              const { reason: doneReason, metadata } = salvageResult.done
              yield await emitDone(doneReason, metadata)
              return
            }
            if (salvageResult.handled) {
              const injectedAfterSalvage = appendPendingInstruction()
              if (injectedAfterSalvage) {
                yield injectedAfterSalvage
              }
              break
            }

            const finalResult = yield* runFinalResponse({
              content: fullContent,
              finishReason: reason,
              totalToolCalls,
              ctx,
              sessionWriter,
              policies,
              policyCtx,
              appendPendingInstruction,
              taskLedger,
              requireVerificationBeforeFinal,
              verificationMode,
              verificationGateState,
            })
            if (finalResult.done) {
              yield await emitDone("success", { reason })
              return
            }
            break
          }
          break
        }

        case "error":
          yield* emitPolicyEvents(await runPolicyHookEvents(policies, "afterModelEvent", policyCtx, event, { fullContent }))
          streamError = { role: "error", content: event.message, severity: "error" as const, metadata: { ...(event.status ? { status: event.status } : {}), responseBody: event.body } }
          await runPolicyHook(policies, "onError", policyCtx, event)
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
      await runPolicyHook(policies, "onError", policyCtx, err)
      if (isInterrupted() || (err instanceof Error && (err.name === "AbortError" || signal.aborted))) {
        yield { role: "status", content: "interrupted" }
        yield await emitDone("interrupted")
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
      const recovery = yield* recoverFromStreamError({
        streamError,
        toolCalls,
        fullContent,
        consecutiveErrors,
        turnCount,
        diagnosticsEnabled,
        isInterrupted,
        appendToolResult,
        ctx,
        sessionWriter,
        policies,
        policyCtx,
        logger,
      })
      consecutiveErrors = recovery.consecutiveErrors
      if (recovery.action === "interrupted") {
        yield await emitDone("interrupted")
        return
      }
      if (recovery.action === "error_limit") {
        yield await emitDone("error_limit")
        return
      }
      continue
    }
    consecutiveErrors = 0
  }

  if (diagnosticsEnabled) logger.warn("loop.max_turns", { maxTurns })
  yield { role: "warning", content: `Reached maximum tool loop count (${maxTurns}).`, severity: "warning" as const }
  yield await emitDone("maxTurns")
}
