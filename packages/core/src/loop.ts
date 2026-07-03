import type { ToolCall, ToolSpec, ChatMessage } from "./types.js"
import type { LoopEvent, SessionStats, ToolResult, ChatClient } from "./interface.js"
import { isToolUseFinishReason } from "./finish-reason.js"
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
import { BranchBudgetTracker } from "./governance/branch-budget.js"
import { extractToolTargetPath, extractRunCommand } from "./governance/branch-budget-tool-path.js"
import { CheckpointEngine } from "./checkpoint/checkpoint-engine.js"
import type { CheckpointSaveTrigger } from "./checkpoint/runtime-checkpoint.js"
import {
  ModeDecisionEngine,
  createEmptyRuntimeExecutionState,
  resolveInitialExecutionMode,
  isAutoModeDecisionEnabled,
  type ExecutionMode,
  type ModeDecision,
} from "./governance/mode-decision.js"
import type { HarnessMode } from "./model-profile/types.js"

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
  /** F0-1: 分支预算追踪器 — 工具前硬拦截、工具后计数 */
  branchBudgetTracker?: BranchBudgetTracker
  /** F0-1: CheckpointEngine — safe point 落盘与恢复 */
  checkpointEngine?: CheckpointEngine
  /** F0-1: ModeDecisionEngine — 每轮 free/forced 决策 */
  modeDecisionEngine?: ModeDecisionEngine
  /** F0-1: 工作区根（BranchBudgetTracker 路径规范化用） */
  workspaceRoot?: string
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
    /** F0-1: governance/checkpoint 三件套 */
    branchBudgetTracker,
    checkpointEngine,
    modeDecisionEngine,
    workspaceRoot,
    /** F0-1: 有效策略（executionMode / branchBudget / checkpoint 三字段被运行时消费） */
    effectivePolicy,
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
  // F0-1: enforced 模式下初始化时即开启 forced policy
  if (currentExecutionMode === "forced") {
    checkpointEngine?.setForcedPolicy(true)
  }

  /**
   * F0-1: 调用 CheckpointEngine.save 的安全包装。
   * 根据 forcedPolicyActive 与 trigger 决定是否真实落盘；失败不阻塞 loop。
   */
  const saveCheckpoint = async (trigger: CheckpointSaveTrigger, extras?: {
    appendTool?: import("./checkpoint/runtime-checkpoint.js").ToolHistoryEntry
    appendFailure?: import("./checkpoint/runtime-checkpoint.js").FailureHistoryEntry
    appendRecoverySignal?: import("./checkpoint/runtime-checkpoint.js").RecoverySignal
  }): Promise<void> => {
    if (!checkpointEngine) return
    if (!checkpointEngine.shouldPersistOnTrigger(trigger)) return
    try {
      await checkpointEngine.save({
        trigger,
        branchBudget: branchBudgetTracker,
        ...extras,
      })
    } catch (e) {
      if (diagnosticsEnabled) {
        logger.warn("loop.checkpoint.save_error", {
          trigger,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  /**
   * F0-1: 每轮 turn 开始时评估 executionMode。
   * - 收集 BranchBudgetTracker 的 recovery 信号
   * - 调用 ModeDecisionEngine.evaluate
   * - 应用决策：切换 mode、设置 checkpoint forced policy、启停 BranchBudgetTracker
   */
  const evaluateExecutionMode = (): ModeDecision | null => {
    if (!modeDecisionEngine) return null
    // F0-1/B1: free 模式（executionMode: "free"）下完全跳过自动 mode 决策，
    // 不会被 runtime 信号拉入 forced；forced/strict 已经在初始化时进入 forced。
    if (!autoModeDecisionEnabled) {
      // F0-1/B6-2: 非 adaptive 模式下 evaluate() 不会被调用，submitted signals 不会被
      // finally 块清空。这里显式清理，避免 engine 层在 submit 开始时提交的 checkpoint_resumed
      // 或其他 signals 残留到下一次 submit 污染 mode decision。
      modeDecisionEngine.resetSubmittedSignals()
      // 同步消费 pending recovery signals，保持 lifecycle 闭环。
      if (checkpointEngine) {
        checkpointEngine.markRecoverySignalsConsumed(() => true)
      }
      return null
    }

    // 收集 recovery_pending 信号
    if (branchBudgetTracker) {
      const decision = branchBudgetTracker.shouldBranchRecover()
      if (decision.triggered) {
        modeDecisionEngine.submitSignal("branch_budget", "recovery_pending", {
          dimension: decision.dimension,
          key: decision.key,
          count: decision.currentCount,
        })
      }
    }

    // 收集 checkpoint 恢复信号并消费（B6：避免每轮重复提交）
    if (checkpointEngine) {
      const pending = checkpointEngine.pendingRecoverySignals()
      if (pending.length > 0) {
        modeDecisionEngine.submitSignal("checkpoint_engine", "checkpoint_resumed")
        // 标记为已消费：本批 pending signal 已转化为 checkpoint_resumed 信号提交给 ModeDecisionEngine，
        // 后续轮次不再重复提交；signal 本身仍保留在 v2State.recoverySignals 中以便审计。
        checkpointEngine.markRecoverySignalsConsumed(() => true)
      }
    }

    // 同步 runtimeState 字段
    runtimeState.round = turnCount
    runtimeState.recoveryPending = branchBudgetTracker?.shouldBranchRecover().triggered ?? false
    runtimeState.verificationPending = taskLedger?.verificationPending ?? false
    // runtimeState.lastToolSuccess 由 recordBranchBudget 同步，这里保留前一轮设置

    const modeDecision = modeDecisionEngine.evaluate({
      round: turnCount,
      executionMode: currentExecutionMode,
      executionModeLockRemaining,
      // F0-1/B1: 使用真实 harnessMode（来自 effectivePolicy.executionMode），不再硬编码
      harnessMode,
      // F0-1/B1: riskLevel 仍保持 L1_minor_edit 作为 runtime 默认值；
      // 真正的 task 风险分级由 task-graph executor 提供，本 loop 不参与
      riskLevel: "L1_minor_edit",
      state: runtimeState,
      signals: [],
    })

    // 应用决策
    if (modeDecision.action === "enter_forced") {
      currentExecutionMode = "forced"
      executionModeLockRemaining = modeDecision.lockRounds
      checkpointEngine?.setForcedPolicy(true)
      branchBudgetTracker?.setEnabled(true)
    } else if (modeDecision.action === "exit_forced") {
      currentExecutionMode = "free"
      checkpointEngine?.setForcedPolicy(false)
    }

    return modeDecision
  }

  /**
   * F0-1: 工具批次前对每个 toolCall 做 BranchBudget 硬拦截。
   * 返回被拦截的 toolCall → 拦截消息映射。
   */
  const checkBranchBudgetBlocks = (toolCalls: ToolCall[]): Map<string, string> => {
    const blocks = new Map<string, string>()
    if (!branchBudgetTracker) return blocks
    for (const tc of toolCalls) {
      const argsResult = parseToolCallArgs(tc.function.arguments, tc.function.name)
      if (!argsResult.ok) continue
      const decision = branchBudgetTracker.checkToolBlock(
        tc.function.name,
        argsResult.args,
        extractToolTargetPath,
        extractRunCommand,
        { workspaceRoot },
      )
      if (decision.blocked && decision.message) {
        blocks.set(tc.id, decision.message)
      }
    }
    return blocks
  }

  /**
   * F0-1: 工具结果回调中累加 BranchBudget 计数。
   */
  const recordBranchBudget = (toolName: string, args: Record<string, unknown>, result: ToolResult): void => {
    if (!branchBudgetTracker) return
    const isErr = result.isError || !!result.metadata?.error
    if (extractToolTargetPath(toolName, args) && !isErr) {
      branchBudgetTracker.recordFileEdit(extractToolTargetPath(toolName, args))
    }
    if (toolName === "bash" && isErr) {
      const cmd = extractRunCommand(args)
      if (cmd) branchBudgetTracker.recordFailedCommandAttempt(cmd)
    }
    if (isErr) {
      const sig = (typeof result.content === "string" ? result.content : "").slice(0, 200)
      if (sig) branchBudgetTracker.recordError(sig)
    }
    // 同步 runtimeState
    runtimeState.lastToolSuccess = !isErr
  }

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

            // F0-1/B2: 工具批次执行前做 BranchBudget 硬拦截。
            // 仅当 effectivePolicy.branchBudget === "enforce" 时才硬拦截；
            // "recover" 模式只记录、触发 recovery_pending，不阻断工具执行。
            const shouldHardBlock = effectivePolicy?.branchBudget === "enforce"
            const branchBudgetBlocks = shouldHardBlock ? checkBranchBudgetBlocks(toolCalls) : new Map<string, string>()
            if (branchBudgetBlocks.size > 0) {
              // F0-1/B5: 一旦 batch 中有任意 tool_call 被 BranchBudget 拦截，
              // 整个 batch 全部不执行，并给每个 tool_call 都 append 一个 tool_result，
              // 避免产生 orphan tool_call 破坏 provider 协议（assistant.tool_calls 与
              // tool_result 必须一一配对）。
              for (const tc of toolCalls) {
                const blockMsg = branchBudgetBlocks.get(tc.id)
                if (blockMsg) {
                  appendToolResult(tc, { content: blockMsg, isError: true, metadata: { reason: "branch_budget_blocked" } })
                  yield {
                    role: "error",
                    content: blockMsg,
                    severity: "warning" as const,
                    metadata: { reason: "branch_budget_blocked", toolName: tc.function.name, toolCallId: tc.id },
                  }
                  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "error", content: blockMsg, metadata: { reason: "branch_budget_blocked", toolName: tc.function.name } } })
                } else {
                  // 未被拦截的 tool_call 也补一个 tool_result，避免 orphan tool_call
                  const skipMsg = "Skipped: BranchBudget blocked another tool in this batch; please retry in the next turn."
                  appendToolResult(tc, { content: skipMsg, isError: true, metadata: { reason: "branch_budget_batch_skipped" } })
                }
              }
              // 跳过本轮工具执行，直接进入下一轮让模型看到拦截消息
              yield { role: "status", content: "tools_completed" }
              sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: { role: "status", content: "tools_completed" } })
              sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: ctx.buildMessages() })
              break streamLoop
            }

            try {
              for await (const toolEvent of toolExecutor.run(toolCalls, signal, appendToolResult, diagnosticsEnabled ? { submitId, turnCount } : undefined, allowedToolNames)) {
                yield toolEvent
                // P5.5: tool_progress is transient — don't persist to session
                if (toolEvent.role !== 'tool_progress') {
                  sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: toolEvent })
                }
                // F0-1/B3: BranchBudget 记录不依赖 TaskLedger — 普通任务（无 ledger）
                // 也需要累加 file edit / command retry / error 计数，否则 shouldBranchRecover()
                // 永远没有数据来源，governance 在普通任务中失效。
                if ((toolEvent.role === "tool" || toolEvent.role === "error") && toolEvent.toolName) {
                  const tc = findToolCallByIdOrName(toolCalls, toolEvent.toolCallId, toolEvent.toolName, toolEvent.toolCallIndex)
                  if (tc) {
                    const argsResult = parseToolCallArgs(tc.function.arguments, tc.function.name)
                    if (argsResult.ok) {
                      const isErr = toolEvent.role === "error" || !!toolEvent.metadata?.error
                      // F0-1: 同步累加 BranchBudget 计数（file edit / command retry / error）
                      recordBranchBudget(toolEvent.toolName, argsResult.args, {
                        isError: isErr,
                        content: toolEvent.content ?? "",
                        metadata: toolEvent.metadata,
                      })
                      // DRF-40: 记录工具结果到 TaskLedger（仅在 ledger 存在时）
                      if (taskLedger) {
                        recordLedgerTool(toolEvent.toolName, argsResult.args, {
                          isError: isErr,
                          content: toolEvent.content ?? "",
                          metadata: toolEvent.metadata,
                        })
                      }
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

            // F0-1: safe point — 落盘 checkpoint（trigger: step_completed）
            // 在 forced 模式下才会真实落盘（由 forcedPolicyActive 控制）
            await saveCheckpoint("step_completed")

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

            // F0-1: final_draft safe point — 落盘 checkpoint（无论 free/forced 都落盘）
            await saveCheckpoint("final_draft")

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
      // F0-1: tool_failed trigger — 流式错误时落盘（无论 free/forced 都落盘）
      await saveCheckpoint("tool_failed")
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
