import type { ToolCall, ChatMessage } from "../types.js"
import type { LoopEvent, SessionStats, ChatClient } from "../interface.js"
import { isToolUseFinishReason } from "../finish-reason.js"
import type { ContextManager } from "../context/manager.js"
import type { StreamingToolExecutor } from "../streaming-executor.js"
import type { AsyncSessionWriter } from "../session.js"
import type { FoldDecision } from "../context/token-estimator.js"
import { runPolicyHook, runPolicyHookEvents, runPolicyToolBatchHooks } from "./policy.js"
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
import { salvageTextToolCallsInResponse, TextToolCallStreamFilter } from "../tool-calls/text-salvage.js"
import type { TaskLedgerTracker } from "../task-ledger.js"
import { runVerificationGate } from "./policies/verification-gate-policy.js"
import { parseToolCallArgs } from "../executor-helpers.js"
import type { SupervisorGuidanceConfig } from "../supervisor/guided-loop.js"
import { runSupervisorGuidanceSafePoint } from "./policies/supervisor-guidance-policy.js"
import type { EffectiveHarnessPolicy } from "../harness/index.js"
import { parseSelectedCategory } from "../tool-routing/two-stage-router.js"
import type { ToolCategory } from "../tool-routing/types.js"
import { resolveLoopToolRouting } from "./policies/tool-routing-policy.js"
import { createBranchBudgetLoopPolicy } from "./policies/branch-budget-policy.js"
import { createTaskLedgerLoopPolicy } from "./policies/task-ledger-policy.js"
import { createSupervisorEvidenceLoopPolicy } from "./policies/supervisor-evidence-policy.js"
import { createRepeatedFailureLoopPolicy } from "./policies/repeated-failure-policy.js"
import { createToolCallLoopPolicy } from "./policies/tool-call-loop-policy.js"
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

  // ADV-HAR-07/TR-1: Two-stage routing 的当前类别选择状态。
  // 由 loop 内部拦截 select_category 工具调用后填充，下一轮 resolveToolRouting
  // 会基于此返回 Stage 2（仅注入该 category 的工具）。这是 loop 内部协议状态，
  // 不暴露给 StreamingToolExecutor 或 createDefaultTools。
  let selectedCategory: ToolCategory | undefined

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

  /** DRF-40: 尝试拦截 done 并注入验证提示 */
  const tryVerificationGate = function* (): Generator<LoopEvent, boolean> {
    return yield* runVerificationGate({
      taskLedger,
      requireVerificationBeforeFinal,
      verificationMode,
      verificationGateState,
      ctx,
      sessionWriter,
    })
  }

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
      selectedCategory,
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
        selectedCategory,
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

            const toolBatchPolicy = await runPolicyToolBatchHooks(policies, policyCtx, toolCalls, { source: "native" })
            yield* emitPolicyEvents(toolBatchPolicy.events)
            if (toolBatchPolicy.interception) {
              if (toolBatchPolicy.interception.persistMessages !== false) {
                sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
              }
              if (toolBatchPolicy.interception.done) {
                const { reason: doneReason, metadata } = toolBatchPolicy.interception.done
                yield await emitDone(doneReason, metadata)
                return
              }
              break streamLoop
            }

            // TR-1: 拦截 two-stage routing 的内部协议工具 select_category。
            // select_category 是 loop 内部虚拟工具（不注册到 createDefaultTools，
            // 不进入 StreamingToolExecutor），由 loop 直接处理：
            // 1. 解析参数得到类别
            // 2. appendToolResult 让 LLM 看到选择已生效
            // 3. 更新 selectedCategory，下一轮 resolveToolRouting 进入 Stage 2
            // 4. break streamLoop 进入下一轮
            const categoryCall = toolCalls.find((tc) => tc.function.name === "select_category")
            if (categoryCall) {
              const parsedCategory = parseSelectedCategory(categoryCall.function.arguments)
              if (parsedCategory) {
                selectedCategory = parsedCategory
                appendToolResult(categoryCall, {
                  content: `Category selected: ${parsedCategory}. Continuing with tools from this category.`,
                  isError: false,
                  metadata: { reason: "two_stage_category_selected", selectedCategory: parsedCategory },
                })
                // 理论上 Stage 1 只注入 select_category，batch 不会有其他工具；
                // 但为健壮起见，给 batch 中其他工具补 skip 消息避免 orphan tool_call
                for (const tc of toolCalls) {
                  if (tc.id !== categoryCall.id) {
                    appendToolResult(tc, {
                      content: "Skipped: select_category was called in this batch; please retry in the next turn.",
                      isError: true,
                      metadata: { reason: "two_stage_batch_skipped" },
                    })
                  }
                }
                yield {
                  role: "status",
                  content: "two_stage_category_selected",
                  metadata: { selectedCategory: parsedCategory },
                }
                sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "status", content: "two_stage_category_selected", metadata: { selectedCategory: parsedCategory } } })
                sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
                break streamLoop
              } else {
                // 解析失败：给 select_category 回错误，让模型重试
                appendToolResult(categoryCall, {
                  content: "Invalid category. Please select a valid category from: read, write, search, run, plan, code_intel, full.",
                  isError: true,
                  metadata: { reason: "two_stage_invalid_category" },
                })
                yield { role: "status", content: "tools_completed" }
                sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "status", content: "tools_completed" } })
                sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
                break streamLoop
              }
            }

            try {
              for await (const toolEvent of toolExecutor.run(toolCalls, signal, appendToolResult, diagnosticsEnabled ? { submitId, turnCount } : undefined, effectiveAllowedToolNames, effectivePolicy?.maxParallelTools)) {
                yield toolEvent
                // P5.5: tool_progress is transient — don't persist to session
                if (toolEvent.role !== 'tool_progress') {
                  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: toolEvent })
                }
                const matchedTc = (toolEvent.role === "tool" || toolEvent.role === "error") && toolEvent.toolName
                  ? findToolCallByIdOrName(toolCalls, toolEvent.toolCallId, toolEvent.toolName, toolEvent.toolCallIndex) ?? undefined
                  : undefined
                const nativeParsedArgs = matchedTc ? parseToolCallArgs(matchedTc.function.arguments, matchedTc.function.name) : undefined
                const policyEvents = await runPolicyHookEvents(policies, "afterToolResult", policyCtx, toolEvent, { source: "native", toolCalls, toolCall: matchedTc, parsedArgs: nativeParsedArgs?.ok ? nativeParsedArgs.args : undefined })
                for (const emission of policyEvents) {
                  yield emission.event
                  if (emission.persist === false) continue
                  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: emission.sessionEvent ?? emission.event })
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
            await runPolicyHook(policies, "afterToolBatch", policyCtx, toolCalls, { source: "native" })

            // TR-1: selectedCategory 是一次性状态。
            // Stage 2 的一批真实工具调用执行完成后清空，让下一轮模型
            // 需要工具时重新走 select_category 选择新类别（避免被锁定
            // 在第一次选择的类别里无法切换 read→write→search→run）。
            if (selectedCategory) {
              selectedCategory = undefined
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

            // DRF-31: stop 且无原生 tool_calls 时，抢救正文中的嵌入工具调用
            // FIX-H2: 只有 textToolSalvage 设置为 "always" 或 "on-native-failure" 时才允许抢救
            const salvageMode = effectivePolicy?.textToolSalvage ?? "on-native-failure"
            const allowTextToolSalvage = salvageMode === "always" || salvageMode === "on-native-failure"
            // TODO: "on-native-failure" currently means "fallback when no native tool_calls were produced".
            // Provider-level native parse error telemetry is not yet available.
            if (allowTextToolSalvage && reason === "stop" && toolCalls.length === 0 && fullContent.trim()) {
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

                const salvageBatchPolicy = await runPolicyToolBatchHooks(policies, policyCtx, salvagedCalls, { source: "salvage" })
                yield* emitPolicyEvents(salvageBatchPolicy.events)
                if (salvageBatchPolicy.interception) {
                  if (salvageBatchPolicy.interception.persistMessages !== false) {
                    sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
                  }
                  if (salvageBatchPolicy.interception.done) {
                    const { reason: doneReason, metadata } = salvageBatchPolicy.interception.done
                    yield await emitDone(doneReason, metadata)
                    return
                  }
                  break
                }
                try {
                  for await (const toolEvent of toolExecutor.run(salvagedCalls, signal, appendToolResult, diagnosticsEnabled ? { submitId, turnCount } : undefined, effectiveAllowedToolNames, effectivePolicy?.maxParallelTools)) {
                    yield toolEvent
                    if (toolEvent.role !== "tool_progress") {
                      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: toolEvent })
                    }
                    const salvageMatchedTc = (toolEvent.role === "tool" || toolEvent.role === "error") && toolEvent.toolName
                      ? findToolCallByIdOrName(salvagedCalls, toolEvent.toolCallId, toolEvent.toolName, toolEvent.toolCallIndex) ?? undefined
                      : undefined
                    const salvageParsedArgs = salvageMatchedTc ? parseToolCallArgs(salvageMatchedTc.function.arguments, salvageMatchedTc.function.name) : undefined
                    const policyEvents = await runPolicyHookEvents(policies, "afterToolResult", policyCtx, toolEvent, { source: "salvage", toolCalls: salvagedCalls, toolCall: salvageMatchedTc, parsedArgs: salvageParsedArgs?.ok ? salvageParsedArgs.args : undefined })
                    for (const emission of policyEvents) {
                      yield emission.event
                      if (emission.persist === false) continue
                      sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: emission.sessionEvent ?? emission.event })
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
                await runPolicyHook(policies, "afterToolBatch", policyCtx, salvagedCalls, { source: "salvage" })

                const injectedAfterSalvage = appendPendingInstruction()
                if (injectedAfterSalvage) {
                  yield injectedAfterSalvage
                }
                break
              }
            }

            yield* emitPolicyEvents(await runPolicyHookEvents(
              policies,
              "beforeAssistantFinal",
              policyCtx,
              { content: fullContent, totalToolCalls, finishReason: reason },
            ))

            ctx.log.append({ role: "assistant", content: fullContent })

            // P2: Safe point 2 — check for pending instructions before ending turn
            const injectedBeforeDone = appendPendingInstruction()
            if (injectedBeforeDone) {
              yield injectedBeforeDone
              // Don't yield done — continue the loop to process the injected instruction
              break
            }

            await runPolicyHook(policies, "beforeFinal", policyCtx)
            // DRF-40: Verification Gate — 拦截未验证的 done
            const gated = yield* tryVerificationGate()
            if (gated) {
              break
            }

            await runPolicyHook(policies, "beforeFinalDraft", policyCtx)

            sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
            yield await emitDone("success", { reason })
            return
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
      if (isInterrupted()) {
        yield { role: "status", content: "interrupted" }
        yield await emitDone("interrupted")
        return
      }
      await runPolicyHook(policies, "afterStreamError", policyCtx, streamError)
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

/** Find tool call by id (preferred), then index, then name (fallback). */
function findToolCallByIdOrName(
  toolCalls: import("../types.js").ToolCall[],
  toolCallId?: string,
  toolName?: string,
  toolCallIndex?: number,
): import("../types.js").ToolCall | undefined {
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
