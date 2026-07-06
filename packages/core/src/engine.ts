import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { DeepreefConfig } from "./config.js"
import type { CovaloConfig } from "./config/schema.js"
import { ContextManager } from "./context/manager.js"
import type { ToolCall, ChatMessage } from "./types.js"
import type { CoreEngine, AgentConfig, AgentTool, LoopEvent, AgentState, SessionStats, ToolResult, EnqueueInstructionResult, ChatClient } from "./interface.js"
import type { QuestionInfo, QuestionAnswer } from "./question/types.js"
import { DeepSeekClient } from "./client.js"

import { StreamingToolExecutor } from "./streaming-executor.js"
import { SessionLoader } from "./session.js"
import { runLoop } from "./loop.js"
import type { LoopOptions } from "./loop.js"
import { getAgent, agentConfigFor } from "./agent.js"
import type { WorkflowMode } from "./dual-agent-runtime/types.js"
import { resolveEffectiveTools } from "./resolve-effective-tools.js"
import { TOOL_CATEGORIES } from "./tool-routing/two-stage-router.js"
import type { WorkflowPhase } from "./workflow-coordinator/types.js"
import { checkSubagentPermission } from "./subagent/index.js"
import { getSubagentSystemPrompt } from "./subagent/definition.js"
import type { SubagentRunOptions, SubagentRunResult } from "./subagent/index.js"
import type { ThinkingMode } from "./provider-thinking.js"
import { createRuntimeLoggerFromEnv, type RuntimeLogger } from "./runtime-logger.js"
import type { ResultPersistenceConfig } from "./result-persistence.js"
import type { ToolRuntimeHooks, ReasonixEngineOptions } from "./tool-runtime-hooks.js"
import { EngineInstructionRuntime } from "./engine-runtime/instruction-runtime.js"
import { EngineSessionRuntime } from "./engine-runtime/session-runtime.js"
import { EngineToolRuntime } from "./engine-runtime/tool-runtime.js"
import { EngineSupervisorRuntime } from "./engine-runtime/supervisor-runtime.js"
import { EngineGovernanceRuntime } from "./engine-runtime/governance-runtime.js"
import { buildSupervisorLoopModePrompt } from "./engine-runtime/build-supervisor-loop-prompt.js"
import { buildActiveSkillsPrompt } from "./engine-runtime/build-active-skills-prompt.js"
import { injectExperienceRecall } from "./engine-runtime/inject-experience-recall.js"
import { recoverCheckpoint, saveFinalCheckpoint } from "./engine-runtime/checkpoint-policy.js"
import { configureBranchBudget } from "./engine-runtime/branch-budget-policy.js"
import { configureReadBeforeWrite } from "./engine-runtime/read-before-write-policy.js"

import type { EngineStatusSnapshot } from "./status.js"
import type { ContextReductionMode, ContextReductionResult } from "./context/manager.js"
import type { ContextPolicy } from "./context/policy.js"
import { validateContextPolicy, mergeContextPolicy, DEFAULT_CONTEXT_POLICY } from "./context/policy.js"
import { ContextPolicyStore } from "./context/policy-store.js"
import type { ContextSummarizer } from "./context/summarizer.js"
import {
  TaskLedgerTracker,
  shouldCreateLedger,
  planRequestInstruction,
} from "./task-ledger.js"
import { getPromptLocale, setPromptLocale } from "./prompt-locale.js"
import { resolveModelProfile } from "./model-profile/resolver.js"
import { resolveHarnessStrictness, resolveEffectiveHarnessPolicy, readProjectHarnessConfig } from "./harness/index.js"
import type { EffectiveHarnessPolicy, HarnessStrictness } from "./harness/index.js"
import { EarlyStopDetector } from "./early-stop.js"
import { CheckpointEngine } from "./checkpoint/checkpoint-engine.js"
import { createSupervisorGuidanceState } from "./supervisor/index.js"
import { resolveModelTarget, targetToConfig, createClientForTarget } from "./model-target.js"
import type { ModelTarget } from "./model-target.js"
export type { ContextPolicy } from "./context/policy.js"

export interface ContextPolicyStatus {
  policy: ContextPolicy
  totalTokens: number
  window: number
  ratio: number
  triggerTokens: number
  targetTokens: number
}

/**
 * Resolve phase-specific maxTurns limit.
 *
 * - supervisor_analyse: capped at 2 — allows shallow get_goal/list_dir
 *   orientation, then must produce a plan.
 * - supervisor_intervene: capped at 1 — brief guidance only, no new
 *   Supervisor self-loop.
 * - supervisor_check: uncapped — may need multiple turns for evidence
 *   inspection (read_file/grep).
 */
function resolvePhaseMaxTurns(
  role: "worker" | "supervisor" | undefined,
  mode: WorkflowMode | undefined,
  workflowPhase: WorkflowPhase | undefined,
  policyMaxTurns: number | undefined,
): number | undefined {
  if (role === "supervisor" && mode === "loop") {
    if (workflowPhase === "supervisor_analyse") return 2
    if (workflowPhase === "supervisor_intervene") return 1
  }
  return policyMaxTurns
}

/**
 * S0-2: 运行时结构守卫，判断 config 是否真的是 CovaloConfig 形状。
 * DeepreefConfig 上可能挂一个部分 tools 对象（如 e2e 测试只传 { approvalPolicy }），
 * 这种对象不是 CovaloConfig，isToolAllowed 会访问 config.tools[role][mode] 而崩溃。
 * 这里检查 isToolAllowed 必然访问的 worker/supervisor 键是否存在，避免裸 cast。
 */
function isCovaloConfigLike(config: unknown): config is CovaloConfig {
  if (typeof config !== "object" || config === null) return false
  const tools = (config as { tools?: unknown }).tools
  if (typeof tools !== "object" || tools === null) return false
  const t = tools as { worker?: unknown; supervisor?: unknown }
  return typeof t.worker === "object" && t.worker !== null &&
    typeof t.supervisor === "object" && t.supervisor !== null
}

/**
 * ReasonixEngine 是 Deepreef 的核心引擎，负责：
 * - 管理对话上下文（ContextManager）
 * - 与 DeepSeek API 进行流式通信
 * - 执行工具调用（tool calling）
 * - 记录会话统计信息和持久化
 *
 * 整个驱动循环（submit 方法）是一个状态机：
 *   用户输入 → API 流式响应 → 工具调用（可选）→ 继续循环 → 最终输出
 */
export class ReasonixEngine implements CoreEngine {
  /** 当前会话 ID（公开供外部扩展使用） */
  getSessionId(): string { return this.sessionRuntime.getSessionId() }

  /** Public accessors for backward-compatible test access */
  get sessionId(): string { return this.sessionRuntime.sessionId }
  set sessionId(val: string) { this.sessionRuntime.sessionId = val }
  get subagentRegistry() { return this.supervisorRuntime.subagentRegistry }
  get verificationGateState() { return this.governanceRuntime.verificationGateState }
  set verificationGateState(val: typeof this.governanceRuntime.verificationGateState) { this.governanceRuntime.verificationGateState = val }
  get supervisorGuidanceState() { return this.supervisorRuntime.supervisorGuidanceState }
  set supervisorGuidanceState(val: typeof this.supervisorRuntime.supervisorGuidanceState) { this.supervisorRuntime.supervisorGuidanceState = val }
  get effectivePolicy() { return this.governanceRuntime.effectivePolicy }
  get sessionStrictness() { return this.governanceRuntime.sessionStrictness }

  /** Deepreef 全局配置 */
  private config: DeepreefConfig
  /** 上下文管理器，负责维护消息历史和 system prompt */
  private ctx: ContextManager
  /** LLM 客户端 */
  private client: ChatClient
  /** 中断标记，由外部调用 interrupt() 设置 */
  private _interrupted = false
  /** 当前活动的 AbortController，用于中断正在进行的 API 请求 */
  private activeAbortController?: AbortController
  /** 开发诊断日志。默认关闭，不参与业务语义。 */
  private logger: RuntimeLogger
  /** 可选：新引擎初始化时调用的清理钩子（如清除全局 stale-read tracker） */
  private onStart?: () => void
  /** 可选：工具运行时钩子（由 CLI 层注入，解耦 core 对 tools 的编译时依赖） */
  private toolRuntimeHooks?: ToolRuntimeHooks
  /** P2-N: Engine runtime services */
  private instructionRuntime = new EngineInstructionRuntime()
  private sessionRuntime: EngineSessionRuntime
  private toolRuntime = new EngineToolRuntime()
  private supervisorRuntime = new EngineSupervisorRuntime()
  private governanceRuntime = new EngineGovernanceRuntime()

  /** 当前活跃 agent 名称 */
  private currentAgent: string

  /** SFR-20: 原始基础系统提示（含 cwd、平台等运行环境），与角色提示分层组合 */
  private baseSystemPrompt: string = ""

  /** prefix.build 缓存：避免每次 submit 重复重建（P3-4-2） */
  private prefixCacheKey = ""

  /** SPEC-G: 上次 build prefix 时的 system prompt 文本，用于检测 prompt 变化 */
  private lastSystemPromptKey = ""

  /** LIFE-01: shutdown flag for idempotent cleanup */
  private _shutDown = false

  /**
   * @deprecated 使用 AgentProfile 中的 thinking 配置代替
   * 当前会话启用的技能内容，会附加到 system prompt
   */
  private activeSkills: Array<{ name: string; description: string; content: string }> = []

  private contextPolicy: ContextPolicy = { ...DEFAULT_CONTEXT_POLICY }

  /** Context policy store for persistence */
  private policyStore: ContextPolicyStore
  private contextPolicyLoadPromise: Promise<void> = Promise.resolve()

  /** DRF-40: 当前 submit 的任务账本 */
  private taskLedger?: TaskLedgerTracker
  private checkpointEngine: CheckpointEngine

  get permissionEngine() { return this.toolRuntime.permissionEngine }
  get hookManager() { return this.toolRuntime.hookManager }

  /** Get context window size */
  getContextWindow(): number {
    return this.ctx.getContextWindow()
  }

  private isSubmitting = false

  /** SA-1: 注入 child client factory（测试用） */
  setChildClientFactory(factory: (target: ModelTarget, logger: RuntimeLogger) => ChatClient): void {
    this.supervisorRuntime.setChildClientFactory(factory)
  }

  /** TUI-FIX-10: 设置编排事件发射回调 */
  setOnOrchestrationEvent(handler: (event: LoopEvent) => void): void {
    this.supervisorRuntime.setOnOrchestrationEvent(handler)
  }

  /** TUI 调用以定向响应某个 permission 请求。 */
  respondPermissionForRequest(requestId: string, allow: boolean, alwaysAllow?: boolean): boolean {
    if (this.toolRuntime.respondPermissionForRequest(requestId, allow, alwaysAllow)) return true
    for (const child of this.supervisorRuntime.activeChildEngines) {
      if (child.respondPermissionForRequest(requestId, allow, alwaysAllow)) return true
    }
    return false
  }

  /** TUI 调用以响应权限确认提示（legacy 兼容路径）。 */
  respondPermission(allow: boolean, alwaysAllow?: boolean): void {
    this.toolRuntime.respondPermission(allow, alwaysAllow, this.supervisorRuntime.activeChildEngines)
  }

  /** QST-10: TUI 调用以回答 Question */
  respondQuestion(requestId: string, answers: QuestionAnswer[]): void {
    this.supervisorRuntime.respondQuestion(requestId, answers)
  }

  /** QST-10: TUI 调用以拒绝 Question */
  rejectQuestion(requestId: string): void {
    this.supervisorRuntime.rejectQuestion(requestId)
  }

  /** QST-10: 获取待处理的 Question 列表 */
  listPendingQuestions(): Array<{ id: string; sessionId: string; questions: QuestionInfo[] }> {
    return this.supervisorRuntime.listPendingQuestions()
  }

  /** QST-10: 内部方法，供 ToolContext.askUser 调用 */
  private async askUserFromTool(questions: QuestionInfo[]): Promise<QuestionAnswer[]> {
    return this.supervisorRuntime.askUserFromTool(this.sessionRuntime.sessionId, questions)
  }

  /** P2: Enqueue a mid-session instruction for consumption at the next safe point */
  enqueueInstruction(instruction: string): EnqueueInstructionResult {
    return this.instructionRuntime.enqueue(instruction, this.isSubmitting)
  }

  constructor(config: DeepreefConfig, onStart?: () => void, sessionId?: string, customClient?: ChatClient, runtimeLogger?: RuntimeLogger, options?: ReasonixEngineOptions) {
    this.config = config
    this.toolRuntimeHooks = options?.toolRuntimeHooks
    this.ctx = new ContextManager(config.maxContextRounds, config.contextWindow)
    this.sessionRuntime = new EngineSessionRuntime(sessionId ?? randomUUID())
    this.logger = runtimeLogger ?? createRuntimeLoggerFromEnv({ sessionId: this.sessionRuntime.sessionId })
    this.client = this.resolveClient(customClient)
    this.currentAgent = "build"
    this.toolRuntime.configurePermissionDefaults(config as unknown as { tools?: { approvalPolicy?: string; strictMode?: boolean } })
    this.toolRuntime.hookManager.setErrorObserver((error, phase) => {
      if (this.logger.isEnabled("error")) {
        this.logger.error("hook.error", error, { phase })
      }
    })
    const persistConfig: ResultPersistenceConfig = {
      sessionQuotaBytes: 50 * 1024 * 1024,
      maxResultSizeChars: 200_000,
      previewChars: 2_000,
      maxFilesPerSession: 200,
      baseDir: process.cwd(),
    }

    this.toolRuntime.toolExecutor = new StreamingToolExecutor(
      this.toolRuntime.tools,
      this.sessionRuntime.sessionId,
      undefined,
      this.toolRuntime.permissionEngine,
      this.toolRuntime.hookManager,
      this.toolRuntime.requestPermission,
      (task, agentType, files) => this.delegateTask(task, agentType, files),
      (name) => this.switchAgent(name),
      (options) => this.spawnSubagent(options),
      (questions) => this.askUserFromTool(questions),
      persistConfig,
      this.logger,
    )
    this.onStart = onStart
    this.onStart?.()

    // Initialize policy store and load saved policy
    this.policyStore = new ContextPolicyStore()
    this.contextPolicyLoadPromise = this.policyStore.load().then(savedPolicy => {
      this.contextPolicy = savedPolicy
      if (this.logger.isEnabled("info")) {
        this.logger.info("context.policy.loaded", { policy: savedPolicy })
      }
    }).catch(() => {
      // If load fails, keep default policy
    })

    // 尝试初始化会话持久化（best-effort，失败则不记录）
    this.sessionRuntime.rebindSessionWriter(process.cwd())
    // F0-1: CheckpointEngine 初始化（sessionDir 与 sessionWriter 同目录）
    const sessionDir = resolve(process.cwd(), ".covalo", "sessions")
    this.checkpointEngine = new CheckpointEngine(sessionDir, this.sessionRuntime.sessionId)
    if (this.logger.isEnabled()) this.logger.info("engine.created", { provider: config.provider, model: config.model })
  }

  static async recover(config: DeepreefConfig, sessionId: string, options?: ReasonixEngineOptions): Promise<ReasonixEngine> {
    if (!SessionLoader.validateSessionId(sessionId)) {
      throw new Error(`Invalid session ID for recover: ${sessionId}`)
    }
    const engine = new ReasonixEngine(config, undefined, sessionId, undefined, undefined, options)
    await engine._loadSessionMessages(sessionId)

    // SPEC-I: restore taskLedger and verificationGate from checkpoint
    if (engine.checkpointEngine) {
      const v2 = await engine.checkpointEngine.loadV2()
      if (v2) {
        if (v2.taskLedger) {
          engine.taskLedger = new TaskLedgerTracker(v2.taskLedger.goal)
          engine.taskLedger.applySnapshot(v2.taskLedger)
          engine.injectTaskLedgerContext(engine.taskLedger)
        }
        if (v2.verificationGate) {
          engine.governanceRuntime.verificationGateState = { ...v2.verificationGate }
        }
      }
    }

    return engine
  }

  /** 设置上下文压缩器 */
  setSummarizer(summarizer: ContextSummarizer): void {
    this.ctx.setSummarizer(summarizer)
  }

  /** 加载指定 session 的历史消息到当前引擎上下文 */
  async loadSession(sessionId: string): Promise<ChatMessage[]> {
    if (this.isSubmitting) {
      throw new Error('Cannot switch sessions while submit is active')
    }
    if (!SessionLoader.validateSessionId(sessionId)) {
      throw new Error(`Invalid session ID: ${sessionId}`)
    }
    // P1-fix: 切换 session 前 dispose 旧 session 的 BackgroundTaskManager。
    if (this.sessionRuntime.sessionId !== sessionId) {
      try {
        this.toolRuntimeHooks?.disposeBackgroundTaskManagerFor(this.sessionRuntime.sessionId)
      } catch {
        // best-effort: 不阻塞 session 切换
      }
    }
    this.sessionRuntime.updateSessionId(sessionId)
    // SPEC-A: session boundary — clear all context zones and submit-local state
    this.governanceRuntime.resetForLoadSession()
    this.supervisorRuntime.supervisorGuidanceState = createSupervisorGuidanceState()
    this.ctx.log.clear()
    this.ctx.clearTransientState()
    this.taskLedger = undefined
    this.instructionRuntime.clear()
    this.toolRuntime.setToolSessionId(sessionId)
    this.logger = this.logger.child({ sessionId })
    this.sessionRuntime.rebindSessionWriter(process.cwd())
    // F0-1: 切换 session 时重建 CheckpointEngine，重置 governance 状态
    const sessionDir = resolve(process.cwd(), ".covalo", "sessions")
    this.checkpointEngine = new CheckpointEngine(sessionDir, sessionId)
    // TUI-FIX-10: 清除前一 session 的所有 worker
    this.supervisorRuntime.emitOrchestration?.({ role: "orchestration", orchestration: { kind: "worker_remove", workerId: "*" } })
    return this._loadSessionMessages(sessionId)
  }

  private async _loadSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    const messages = await SessionLoader.read(sessionId)
    if (messages.length > 0) {
      const nonSystem = messages.filter(m => m.role !== "system")
      this.ctx.log.appendMany(nonSystem)
    }
    this.sessionRuntime.resetStats()
    return messages
  }

  resetStats(): void {
    this.sessionRuntime.resetStats()
  }

  getStatusSnapshot(): EngineStatusSnapshot {
    const budget = this.ctx.getBudget()
    return {
      sessionId: this.sessionRuntime.sessionId,
      context: {
        prefixTokens: budget.prefixTokens,
        logTokens: budget.logTokens,
        scratchTokens: budget.scratchTokens,
        totalTokens: budget.totalTokens,
        window: budget.window,
        ratio: budget.ratio,
      },
      stats: { ...this.sessionRuntime.stats },
      currentAgent: this.currentAgent,
      isSubmitting: this.isSubmitting,
      sessionWriter: this.sessionRuntime.sessionWriter?.getStatus(),
      timestamp: new Date().toISOString(),
    }
  }

  /** 设置系统级 system prompt（基础运行环境提示，与角色提示分层组合） */
  setSystemPrompt(prompt: string): void {
    this.baseSystemPrompt = prompt
    this.ctx.prefix.build(prompt)
  }

  /** Update the prompt locale and persist it for subsequent submits. */
  setPromptLocale(locale: import("./prompt-locale.js").PromptLocale): void {
    setPromptLocale(locale)
  }

  /** Trigger a system prompt rebuild so the next submit uses the new locale. */
  updateSystemPrompt(): void {
    // Base system prompt string is rebuilt by tui.ts on init.
    // This signals the engine to re-resolve locale-dependent layers (mode prompts, skills, etc.)
    // which are rebuilt in submit() via buildActiveSkillsPrompt(), buildSupervisorLoopModePrompt(), etc.
    // No action needed here since submit() uses getPromptLocale() directly.
  }

  /**
   * @deprecated 使用 AgentProfile 中的 skills 配置代替
   * 更新当前会话启用的技能列表
   */
  setActiveSkills(skills: Array<{ name: string; description: string; content: string }>): void {
    this.activeSkills = skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
    }))
  }

  /**
   * @deprecated 使用 AgentProfile 中的 skills 配置代替
   * 获取当前会话启用的技能列表
   */
  getActiveSkills(): Array<{ name: string; description: string; content: string }> {
    return this.activeSkills.map(skill => ({ ...skill }))
  }

  /** DRF-40: 获取当前 TaskLedger 快照（测试/调试） */
  getTaskLedgerSnapshot() {
    return this.taskLedger?.snapshot()
  }

  /** DRF-40: 将 TaskLedger 注入可变 scratch 上下文 — 按来源精确替换，避免污染其他来源消息 */
  private injectTaskLedgerContext(ledger?: TaskLedgerTracker, includePlanRequest = false): void {
    if (!ledger) return
    const messages: ChatMessage[] = []
    if (includePlanRequest && ledger.plan.length === 0) {
      messages.push({ role: "user", content: planRequestInstruction() })
    }
    const formatted = ledger.formatForContext()
    if (formatted.trim()) {
      messages.push({ role: "user", content: formatted })
    }
    if (messages.length > 0) {
      this.ctx.scratch.replaceSource("task_ledger", messages)
    } else {
      this.ctx.scratch.removeSource("task_ledger")
    }
  }

  /** SPEC-03: 注入 trusted experience recall */
  private async injectExperienceRecall(): Promise<void> {
    await injectExperienceRecall(this.ctx, this.logger)
  }

  /** DRF-60: 构建 Supervisor 指导闭环配置 */
  private buildSupervisorGuidanceConfig() {
    return this.supervisorRuntime.buildSupervisorGuidanceConfig(this.config)
  }




  /** 获取上下文管理器实例 */
  getContextManager(): ContextManager {
    return this.ctx
  }

  getContextPolicy(): ContextPolicy {
    return { ...this.contextPolicy }
  }

  async getContextPolicyAsync(): Promise<ContextPolicy> {
    await this.contextPolicyLoadPromise
    return this.getContextPolicy()
  }

  async setContextPolicy(policy: Partial<ContextPolicy>): Promise<void> {
    await this.contextPolicyLoadPromise
    this.contextPolicy = mergeContextPolicy(this.contextPolicy, policy)
    await this.policyStore.save(this.contextPolicy)
    if (this.logger.isEnabled("info")) {
      this.logger.info("context.policy.saved", { policy: this.contextPolicy })
    }
  }

  async getContextPolicyStatus(): Promise<ContextPolicyStatus> {
    await this.contextPolicyLoadPromise
    const budget = this.ctx.getBudget()
    return {
      policy: this.getContextPolicy(),
      totalTokens: budget.totalTokens,
      window: budget.window,
      ratio: budget.ratio,
      triggerTokens: Math.floor(budget.window * this.contextPolicy.triggerRatio),
      targetTokens: Math.floor(budget.window * this.contextPolicy.targetRatio),
    }
  }

  async runContextReduction(mode?: ContextReductionMode): Promise<ContextReductionResult> {
    await this.contextPolicyLoadPromise
    const effectiveMode = mode ?? (this.contextPolicy.mode === "compact" ? "compress" : this.contextPolicy.mode)
    return this.ctx.reduceToTarget(effectiveMode, this.contextPolicy.targetRatio)
  }

  /** 注册一个工具到引擎 */
  registerTool(tool: AgentTool): void {
    this.toolRuntime.registerTool(tool)
  }

  /** 返回当前工具注册表快照，供具有独立可见工具策略的委派引擎继承。 */
  getRegisteredTools(): AgentTool[] {
    return this.toolRuntime.getRegisteredTools()
  }

  /** 标记中断，终止当前正在进行的请求和工具执行 */
  interrupt(): void {
    if (this.logger.isEnabled()) this.logger.info("engine.interrupt", { isSubmitting: this.isSubmitting })
    this._interrupted = true
    this.instructionRuntime.clear()
    this.respondPermission(false)
    this.supervisorRuntime.interruptQuestions()
    for (const child of this.supervisorRuntime.activeChildEngines) child.interrupt()
    this.activeAbortController?.abort()
  }

  /** LIFE-01: 幂等的显式关闭入口。重复调用安全，部分初始化失败也安全。 */
  async shutdown(): Promise<void> {
    if (this._shutDown) return
    this._shutDown = true
    if (this.logger.isEnabled("info")) this.logger.info("engine.shutdown.start", { sessionId: this.sessionRuntime.sessionId })

    try {
      this.interrupt()
    } catch (e) {
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.shutdown.interrupt_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    try {
      await this.ctx.shutdown()
    } catch (e) {
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.shutdown.context_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    try {
      await this.sessionRuntime.drainWriter()
    } catch (e) {
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.shutdown.session_drain_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    try {
      this.toolRuntimeHooks?.disposeBackgroundTaskManagerFor(this.sessionRuntime.sessionId)
    } catch (e) {
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.shutdown.bg_task_dispose_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    await saveFinalCheckpoint(
      this.checkpointEngine,
      this.governanceRuntime.branchBudgetTracker,
      this.taskLedger?.snapshot(),
      this.governanceRuntime.verificationGateState,
      this.logger,
    )

    if (this.logger.isEnabled("info")) this.logger.info("engine.shutdown.done", { sessionId: this.sessionRuntime.sessionId })

    try {
      await this.logger.flush()
    } catch {
      // best-effort: don't let log flush block exit
    }
  }

  /** Resolve the appropriate client for the current provider */
  private resolveClient(customClient?: ChatClient): ChatClient {
    if (customClient) return customClient
    return new DeepSeekClient(this.logger)
  }

  /** 运行时更新引擎配置（用于 /model 命令切换 Provider） */
  updateConfig(partial: Partial<DeepreefConfig>): void {
    const providerChanged = partial.provider !== undefined && partial.provider !== this.config.provider
    Object.assign(this.config, partial)
    if (partial.contextWindow !== undefined) {
      this.ctx.updateContextWindow(partial.contextWindow)
    }
    if (providerChanged) {
      this.client = this.resolveClient()
    }
    const partialToolsConfig = (partial as unknown as Record<string, unknown>).tools as { approvalPolicy?: string; strictMode?: boolean } | undefined
    if (partialToolsConfig?.approvalPolicy !== undefined || partialToolsConfig?.strictMode !== undefined) {
      this.toolRuntime.configurePermissionDefaults(this.config as unknown as { tools?: { approvalPolicy?: string; strictMode?: boolean } })
    }
  }

  /** 获取当前模型名（用于 UI 显示与 per-role 状态同步） */
  getModel(): string {
    return this.config.model
  }

  /** 获取当前 provider（用于 UI 显示与 per-role 状态同步） */
  getProvider(): string {
    return this.config.provider ?? 'zen'
  }

  /** 切换 agent，返回 agent label */
  switchAgent(agentName: string): string {
    const def = getAgent(agentName)
    this.currentAgent = def.name
    return def.label
  }

  /** 获取当前 agent 名称 */
  getAgentName(): string {
    return this.currentAgent
  }

  /**
   * @deprecated 使用 AgentProfile 中的 harness 配置代替
   */
  setHarnessStrictness(strictness: HarnessStrictness): void {
    this.governanceRuntime.setHarnessStrictness(strictness)
  }

  /**
   * @deprecated 使用 AgentProfile 中的 thinking 配置代替
   */
  private thinkingMode: ThinkingMode = "off"
  setThinkingMode(mode: ThinkingMode): void {
    this.thinkingMode = mode
  }
  getThinkingMode(): ThinkingMode {
    return this.thinkingMode
  }

  /** ADV-HAR-01: 获取当前有效 Harness 严格度 */
  getHarnessStrictness(): HarnessStrictness {
    return this.governanceRuntime.getHarnessStrictness()
  }

  /** ADV-HAR-02: 获取当前有效 Harness 策略（只读） */
  getEffectivePolicy(): EffectiveHarnessPolicy | null {
    return this.governanceRuntime.getEffectivePolicy()
  }

  /**
   * 获取当前引擎状态的快照
   */
  getState(isStreaming = false, streamingMessage = "", pendingToolCalls: Array<{ name: string; args: string }> = []): AgentState {
    return {
      sessionId: this.sessionRuntime.sessionId,
      messages: [...this.ctx.buildMessages()],
      isStreaming,
      streamingMessage,
      pendingToolCalls,
      currentAgent: this.currentAgent,
      stats: { ...this.sessionRuntime.stats },
    }
  }


  async *submit(userInput: string, agentConfig?: AgentConfig, role?: "worker" | "supervisor", mode?: WorkflowMode, workflowPhase?: WorkflowPhase): AsyncGenerator<LoopEvent> {
    // C1: Wait for context policy to load before proceeding
    await this.contextPolicyLoadPromise

    const diagnosticsEnabled = this.logger.isEnabled("error")
    const submitStartedAt = diagnosticsEnabled ? Date.now() : 0
    const submitId = diagnosticsEnabled ? randomUUID() : undefined
    const submitLogger = submitId ? this.logger.child({ submitId }) : this.logger
    this._interrupted = false
    this.supervisorRuntime.delegatedEvents = []
    this.isSubmitting = true
    const abortController = new AbortController()
    this.activeAbortController = abortController

    // P1-fix: 把 isSubmitting = true 之后的整个 submit 生命周期放入外层 try/catch/finally。
    // 原先 try 从 guard 之后才开始，中间的 prefix.build / readProjectHarnessConfig /
    // resolveHarnessStrictness / ctx.getBudget / runSummarize / reduceToTarget 等抛错时
    // finally 不执行，isSubmitting 和 activeAbortController 泄漏。
    let submitFailed = false
    const packetRunId = submitId ?? `loop-${Date.now().toString(36)}`

    try {
    // ADV-HAR-P1: 不再在 submit 开始时清除所有 worker
    // worker 生命周期由 spawnSubagent 管理，completed/failed/cancelled 状态保留供 React 渲染
    // worker_remove 仅在 session 切换时调用

    // 合并 agent 配置：优先使用传入的 agentConfig，否则用 role 或 currentAgent 的默认配置
    const agentName = role ?? this.currentAgent
    const ac = agentConfig ?? agentConfigFor(agentName)

    // SFR-20: 分层组合系统提示，不再用 ?? 互斥覆盖
    const baseLayer = this.baseSystemPrompt || this.ctx.prefix.messages[0]?.content || ""
    const roleLayer = ac.systemPrompt || ""
    const activeSkillsPrompt = buildActiveSkillsPrompt(this.activeSkills)
    const promptLocale = getPromptLocale()
    const isZh = promptLocale === "zh-CN"
    const modeLayer = role === "supervisor" && mode === "subagent"
      ? isZh
        ? `## 子代理模式
你负责通过委派的 Worker 完成用户任务。
当任务需要代码探索、实现、测试或其他工程工作时，主动调用 AgentTool。
不要等待用户明确要求你委派。只将规划、综合、审查和用户沟通留给自己。
给每个 Worker 完整自包含的任务，包含上下文、约束、相关文件和预期输出。`
        : `## Subagent Mode
You are responsible for completing the user's task through delegated Workers.
Proactively call AgentTool whenever the task requires codebase exploration, implementation, testing, or other engineering work.
Do not wait for the user to explicitly ask you to delegate. Keep only planning, synthesis, review, and user communication for yourself.
Give each Worker a complete, self-contained task with context, constraints, relevant files, and expected output.`
      : role === "supervisor" && mode === "loop"
        ? buildSupervisorLoopModePrompt(workflowPhase)
        : role === "worker" && mode === "loop"
          ? isZh
            ? `## 循环模式 —— Worker
你是当前循环目标的 Worker。
WorkflowCoordinator 直接传递当前任务给你。
使用工程工具执行分配的任务。
被要求时在 assistant 回复中报告结果。
不要更改目标状态。`
            : `## Loop Mode — Worker
You are the Worker for the active loop goal.
The WorkflowCoordinator passes you the current task directly.
Use engineering tools to execute the assigned tasks.
Report results in your assistant response when asked.
Do not change goal status.`
          : ""
    const layers = [baseLayer, roleLayer, modeLayer, activeSkillsPrompt].filter(Boolean)
    const systemPrompt = layers.join("\n\n")

    // SPEC-G: 仅在 system prompt 实际变化时重建 prefix，避免无谓刷新
    if (this.ctx.prefix.messages.length === 0 || this.lastSystemPromptKey !== systemPrompt) {
      this.ctx.prefix.build(systemPrompt)
      this.lastSystemPromptKey = systemPrompt
    }

    this.ctx.startTurn()

    // ADV-HAR-02: 解析并固化本次 submit 的有效策略
    const modelName = ac.model ?? this.config.model
    const isLocal = this.config.provider === "openai-compatible"
    const projectConfig = readProjectHarnessConfig()
    // ADV-HAR-P0: 解析 modelProfile 用于推断默认严格度
    const modelProfile = resolveModelProfile(modelName, isLocal, 0, undefined)
    const { strictness, source } = resolveHarnessStrictness({
      sessionStrictness: this.governanceRuntime.sessionStrictness,
      projectConfig,
      modelName,
      modelProfile,
    })
    this.governanceRuntime.effectivePolicy = resolveEffectiveHarnessPolicy(strictness, source)
    // ADV-HAR-03: 根据 effectivePolicy.shellPolicy 重新注册 bash 工具
    if (this.governanceRuntime.effectivePolicy.shellPolicy === "dual-track" || this.governanceRuntime.effectivePolicy.shellPolicy === "dual-track-conservative") {
      if (this.toolRuntimeHooks) {
        this.toolRuntime.tools.set("bash", this.toolRuntimeHooks.createBashTool({
          dualTrack: true,
          conservative: this.governanceRuntime.effectivePolicy.shellPolicy === "dual-track-conservative",
        }))
      }
    }

    // FIX-H5: 根据 effectivePolicy.checkpoint 设置 checkpoint 落盘频率
    this.checkpointEngine.setCheckpointPolicy(this.governanceRuntime.effectivePolicy.checkpoint)

    configureReadBeforeWrite(
      this.toolRuntime.toolExecutor,
      this.governanceRuntime.effectivePolicy.readBeforeWrite,
    )

    configureBranchBudget(
      this.governanceRuntime.branchBudgetTracker,
      this.governanceRuntime.effectivePolicy.branchBudget,
    )
    // checkpoint: "frequent" → 任何 trigger 都落盘；"safe-point" → safe point 落盘；"minimal" → 仅 tool_failed/final_draft
    // 由 CheckpointEngine.shouldPersistOnTrigger 内部根据 forcedPolicyActive 判定，这里只负责 loadV2 恢复
    // executionMode: "forced" → 强制 forced；"adaptive" → 自适应决策；"free" → 强制 free
    // ModeDecisionEngine 在 loop.ts 中每轮 evaluate；engine 层只需把 harnessMode 映射进去
    // F0-1/B4: 每次 submit 开始时尝试恢复 checkpoint，跨 submit 持久化真正生效。
    // 恢复的三维计数会延续到本 submit，不会被立即清空（不再调用 resetRoundBudget）。
    // recoverTriggers 也从快照恢复（跨 submit recovery 去重）。
    //
    await recoverCheckpoint(
      this.checkpointEngine,
      this.governanceRuntime.branchBudgetTracker,
      this.governanceRuntime.modeDecisionEngine,
      this.logger,
      this.sessionRuntime.sessionId,
      this.governanceRuntime.effectivePolicy.executionMode,
    )

    this.governanceRuntime.verificationGateState = { continuationCount: 0 }
    this.supervisorRuntime.supervisorGuidanceState = createSupervisorGuidanceState()

    // SPEC-03: 注入 trusted experience recall（只记不忆修复）
    await this.injectExperienceRecall()

    if (shouldCreateLedger(userInput)) {
      this.taskLedger = new TaskLedgerTracker(userInput)
      this.injectTaskLedgerContext(this.taskLedger, true)
    } else {
      this.taskLedger = undefined
    }

    this.ctx.log.append({ role: "user", content: userInput })
    const budget = this.ctx.getBudget()
    if (budget.ratio >= this.contextPolicy.triggerRatio) {
      let result
      if (this.contextPolicy.mode === "compact") {
        result = await this.ctx.compactToTarget(
          this.contextPolicy.targetRatio,
          abortController.signal,
        )
        this.logger.info("context.reduction.compact", { ...result })
      } else {
        result = this.ctx.reduceToTarget("trim", this.contextPolicy.targetRatio)
        this.logger.info("context.reduction.trim", { ...result })
      }
    }
    // P1-fix (A): buildMessages() 在外层 try 内、guard 之前持久化。
    // 确保即使 guard block 也能记录用户输入和当时上下文，且 buildMessages
    // 抛错时 finally 能清理。原先此行在 try 之前，抛错会泄漏 isSubmitting。
    this.sessionRuntime.sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: this.ctx.buildMessages() })
    if (diagnosticsEnabled) submitLogger.info("submit.start", { agent: this.currentAgent, role: role ?? "unspecified", mode: mode ?? "unspecified", inputLength: userInput.length })

    // TUI-FIX-10: emit loop_transition at submit start
    yield {
      role: "orchestration",
      orchestration: {
        kind: "loop_transition",
        transition: { from: "observe", to: "observe", attempt: 1, timestamp: Date.now() },
      },
    }

    // Packet lifecycle: create actual packets and emit phases
    let packetStore: import("./harness-evolution/packets/packet-store").PacketStore | null = null;
    let guardBlocked = false;
    if (mode === "loop" || mode === "subagent") {
      yield { role: "status", content: "Task digest created", metadata: { runId: packetRunId } }

      // Initialize PacketStore for this run
      try {
        const { PacketStore } = await import("./harness-evolution/packets/packet-store");
        packetStore = new PacketStore({ baseDir: process.cwd(), runId: packetRunId });
        await packetStore.init();

        // Create and persist TaskDigestPacket
        const { createTaskDigest } = await import("./harness-evolution/packets/task-digest");
        const digestPacket = createTaskDigest({
          packetId: `${packetRunId}:digest`,
          runId: packetRunId,
          mode: mode as "loop" | "eval",
          role: (role ?? "worker") as "worker" | "supervisor" | "system",
          goal: userInput.slice(0, 500),
          acceptanceCriteria: [],
          repoFacts: {
            cwd: process.cwd(),
            packageManager: undefined,
            gitBranch: undefined,
            gitClean: undefined,
            relevantConfigFiles: [],
          },
          contextFiles: [],
          constraints: [],
          verificationPlan: [],
          omittedContext: [],
        });
        await packetStore.append(digestPacket);
        await packetStore.writeArtifact("task-digest.json", digestPacket);
      } catch {
        // PacketStore is optional
      }

      // Runtime guard on user input
      const { guardPrompt, createRuntimeGuardPacket } = await import("./harness-evolution/packets/runtime-guard");
      const guard = guardPrompt(userInput);
      const guardPacket = createRuntimeGuardPacket({
        packetId: `${packetRunId}:guard`,
        runId: packetRunId,
        prompt: userInput,
        mode: (mode as "loop" | "eval") || "loop",
        role: (role ?? "worker") as "worker" | "supervisor" | "system",
      });
      // Persist guard packet
      if (packetStore) {
        try {
          await packetStore.append(guardPacket);
          await packetStore.writeArtifact("runtime-guard.json", guardPacket);
        } catch {}
      }

      // S1-2: review 策略由 runtimeGuard.reviewPolicy 配置驱动
      const toolsConfig = (this.config as unknown as Record<string, unknown>).tools as
        | { runtimeGuard?: { reviewPolicy?: "allow" | "ask" | "block" } }
        | undefined
      const reviewPolicy = toolsConfig?.runtimeGuard?.reviewPolicy ?? "ask"

      if (guard.disposition === "allow") {
        yield { role: "status", content: "Runtime guard allowed", metadata: { runId: packetRunId } };
        this.logger.info("harness.guard.allow", { runId: packetRunId, mode, role, promptLength: userInput.length });
      } else {
        yield { role: "status", content: `Runtime guard ${guard.disposition}: ${guard.findings.map(f => f.kind).join(", ")}`, severity: "warning", metadata: { runId: packetRunId } };
        if (guard.disposition === "block") {
          guardBlocked = true;
          this.logger.warn("harness.guard.block", { runId: packetRunId, mode, role, findings: guard.findings.map(f => f.kind), promptLength: userInput.length });
        } else {
          // review disposition: 按 reviewPolicy 决定行为
          if (reviewPolicy === "block") {
            guardBlocked = true;
            this.logger.warn("harness.guard.review_blocked", { runId: packetRunId, mode, role, findings: guard.findings.map(f => f.kind), promptLength: userInput.length });
          } else if (reviewPolicy === "ask") {
            // ask: 若 approvalPolicy 为 always 则视为需要确认但无 UI 时阻断
            const approvalPolicy = (toolsConfig as { approvalPolicy?: string } | undefined)?.approvalPolicy ?? "on-request"
            guardBlocked = approvalPolicy === "always"
            this.logger.info("harness.guard.review_ask", { runId: packetRunId, mode, role, findings: guard.findings.map(f => f.kind), blocked: guardBlocked });
          } else {
            // allow: 仅记录日志，不阻断
            this.logger.info("harness.guard.review_allowed", { runId: packetRunId, mode, role, findings: guard.findings.map(f => f.kind) });
          }
        }
      }
      if (!guardBlocked) {
        yield { role: "status", content: "Worker running", metadata: { runId: packetRunId } };
      }
    }

    // If runtime guard blocked, skip execution and emit block event
    let guardSkipped = false;
    if (guardBlocked) {
      guardSkipped = true;
      yield { role: "error", content: `Runtime guard blocked: ${userInput.slice(0, 200)}`, severity: "error" };
    }

      // If guard blocked, skip the entire loop execution
      if (guardSkipped) {
        // Break out of try to trigger finally cleanup
        return;
      }

      // SFR-30: 使用 resolveEffectiveTools 统一计算有效工具列表
      const effectiveRole: "worker" | "supervisor" = role ?? (agentName === "supervisor" ? "supervisor" : "worker")
      const effectiveMode: WorkflowMode = mode ?? "alone"
      // S0-2: 只在 config 是 CovaloConfig 形状时传入。
      // DeepreefConfig.tools 可能是部分对象（如 e2e 测试只传 { approvalPolicy }），
      // 不带 worker/supervisor 键时 isToolAllowed 会访问 config.tools[role][mode] 崩溃。
      // 这里做结构守卫，避免把任意带 tools 字段的对象误当 CovaloConfig。
      const maybeCovaloConfig = isCovaloConfigLike(this.config) ? (this.config as unknown as CovaloConfig) : undefined
      const { tools: toolSpecs, filteredCount, filteredReason } = resolveEffectiveTools({
        registeredTools: this.toolRuntime.tools,
        role: effectiveRole,
        mode: effectiveMode,
        // FIX-CUSTOM-TOOLS: 合并 ac.toolNames 与 registerTool() 注册的自定义工具。
        // 否则 resolveEffectiveTools 的 agentToolNames 白名单会过滤掉自定义工具，
        // 导致 H1 effectiveAllowedToolNames 限制下自定义工具无法执行。
        agentToolNames: ac.toolNames
          ? [...new Set([...ac.toolNames, ...this.toolRuntime.tools.keys()])]
          : ac.toolNames,
        workflowPhase,
        config: maybeCovaloConfig,
      })
      const builtinToolNames = new Set(Object.values(TOOL_CATEGORIES).flatMap(cat => cat.tools))
      const customToolNames = new Set<string>()
      for (const spec of toolSpecs) {
        if (!builtinToolNames.has(spec.function.name)) {
          customToolNames.add(spec.function.name)
        }
      }
      if (filteredCount > 0 && this.logger.isEnabled("warn")) {
        this.logger.warn("tools.filtered", {
          role: effectiveRole,
          mode: effectiveMode,
          workflowPhase,
          registeredCount: this.toolRuntime.tools.size,
          effectiveCount: toolSpecs.length,
          filteredCount,
          reason: filteredReason ?? "unknown",
        })
      }

      const toolSpecsKey = JSON.stringify([...toolSpecs].sort((a, b) => a.function.name.localeCompare(b.function.name)))
      const skillsKey = JSON.stringify(this.activeSkills.map(skill => ({ name: skill.name, description: skill.description, content: skill.content })))
      const cacheKey = `${systemPrompt}|${toolSpecsKey}|${skillsKey}`
      if (cacheKey !== this.prefixCacheKey) {
        this.ctx.prefix.build(systemPrompt, toolSpecs)
        this.prefixCacheKey = cacheKey
      }

      const phaseMaxTurns = resolvePhaseMaxTurns(role, mode, workflowPhase, this.governanceRuntime.effectivePolicy?.maxTurns)

      const loopOpts: LoopOptions = {
        ctx: this.ctx,
        client: this.client,
        toolExecutor: this.toolRuntime.toolExecutor,
        toolSpecs,
        config: {
          apiKey: this.config.apiKey,
          baseUrl: this.config.baseUrl,
          model: ac.model ?? this.config.model,
          maxTokens: ac.maxTokens ?? this.config.maxTokens,
          temperature: ac.temperature ?? this.config.temperature,
          provider: this.config.provider,
        },
        signal: abortController.signal,
        sessionWriter: this.sessionRuntime.sessionWriter,
        stats: this.sessionRuntime.stats,
        isInterrupted: () => this._interrupted,
        thinkingMode: this.thinkingMode,
        appendToolResult: (tc, result) => this.appendToolResult(tc, result),
        takePendingInstruction: () => this.instructionRuntime.takeOne(),
        logger: submitLogger,
        submitId,
        taskLedger: this.taskLedger,
        // ADV-HAR-02: 使用 effectivePolicy 而不是 harnessProfile 的字段
        effectivePolicy: this.governanceRuntime.effectivePolicy ?? undefined,
        maxTurns: phaseMaxTurns,
        requireVerificationBeforeFinal:
          this.governanceRuntime.effectivePolicy?.verification === "block"
          || this.governanceRuntime.effectivePolicy?.verification === "require-or-waive",
        verificationGateState: this.governanceRuntime.verificationGateState,
        refreshLedgerContext: () => {
          this.injectTaskLedgerContext(this.taskLedger)
        },
        // ADV-HAR-06: 根据 effectivePolicy.earlyStop 配置 EarlyStopDetector
        earlyStop: new EarlyStopDetector({
          repetitionThreshold: this.governanceRuntime.effectivePolicy?.earlyStop === "aggressive" ? 2
            : this.governanceRuntime.effectivePolicy?.earlyStop === "critical-only" ? 5
            : 3,
        }),
        // ADV-HAR-07: 传递 toolRouting 策略供 loop 使用
        toolRouting: this.governanceRuntime.effectivePolicy?.toolRouting,
        // ADV-HAR-08: 传递 verification 策略供 loop 使用
        verificationPolicy: this.governanceRuntime.effectivePolicy?.verification,
        // F0-1: 传入 governance/checkpoint 三件套
        branchBudgetTracker: this.governanceRuntime.branchBudgetTracker,
        checkpointEngine: this.checkpointEngine,
        modeDecisionEngine: this.governanceRuntime.modeDecisionEngine,
        workspaceRoot: process.cwd(),
        allowedToolNames: effectiveMode === "loop"
          ? new Set(toolSpecs.map(spec => spec.function.name))
          : undefined,
        customToolNames,
        supervisorGuidance: this.governanceRuntime.effectivePolicy?.supervisorPolicy !== "off"
          ? this.buildSupervisorGuidanceConfig()
          : undefined,
        buildSupervisorExtras: () => {
          if (!this.taskLedger) return {}
          const failedVerifications = this.taskLedger?.lastVerification != null && this.taskLedger.lastVerification.exitCode !== 0 ? 1 : 0
          const doneSteps = this.taskLedger.plan.filter(s => s.status === "done").length
          return {
            consecutiveVerificationFailures: failedVerifications,
            ledgerStagnantRounds: doneSteps === 0 && this.taskLedger.plan.length > 0 ? 1 : 0,
          }
        },
        // FIX-H1: 传入 role 让 loop 跳过 supervisor 的 toolset 二次过滤
        role: effectiveRole,
      }

      const loopIterator = runLoop(loopOpts)[Symbol.asyncIterator]()
      let nextLoopEvent = loopIterator.next()
      while (true) {
        while (this.supervisorRuntime.delegatedEvents.length > 0) {
          yield this.supervisorRuntime.delegatedEvents.shift()!
        }
        const delegatedWake = this.supervisorRuntime.waitForDelegatedEvent()
        const next = await Promise.race([
          nextLoopEvent.then(result => ({ kind: "loop" as const, result })),
          delegatedWake.promise.then(() => ({ kind: "delegated" as const })),
        ])
        delegatedWake.cancel()
        if (next.kind === "delegated") continue
        if (next.result.done) break
        const event = next.result.value
        yield event
        // P5: Use .catch() for async hook — sync try/catch cannot catch Promise rejections
        void this.hookManager.runOnLoopEvent(event as unknown as Record<string, unknown>).catch(() => {})
        nextLoopEvent = loopIterator.next()
      }
      while (this.supervisorRuntime.delegatedEvents.length > 0) {
        yield this.supervisorRuntime.delegatedEvents.shift()!
      }

      // Post-loop packet lifecycle: create review/incident/recovery packets based on outcome
      if (mode === "loop" || mode === "subagent") {
        try {
          const { createReviewPacket } = await import("./harness-evolution/packets/review-packet");
          const { createIncidentPacket, classifyFailureClass } = await import("./harness-evolution/packets/incident-packet");
          const { createRecoveryPacket } = await import("./harness-evolution/packets/recovery-packet");

          const hasVerifierFailure = this.taskLedger?.lastVerification != null && this.taskLedger.lastVerification.exitCode !== 0;
          const workerError = this._interrupted;
          const verdict = workerError || hasVerifierFailure ? "NEEDS_FIX" : "ACCEPTED";

          // Create ReviewPacket from loop outcome
          const reviewPacket = createReviewPacket({
            packetId: `${packetRunId}:review`,
            runId: packetRunId,
            mode: (mode === "subagent" ? "subagent" : "loop") as "loop" | "eval",
            role: "supervisor",
            verdict,
            findings: hasVerifierFailure ? [{
              id: "F1:verifier",
              severity: "major" as const,
              category: "correctness" as const,
              summary: "Verification command failed",
              evidence: this.taskLedger?.lastVerification
                ? [{ file: "verification", excerpt: `exit ${this.taskLedger.lastVerification.exitCode}` }]
                : [],
              recommendedChecks: [],
            }] : [],
            requiredChecks: [],
            evidenceRefs: [],
            confidence: workerError ? 0 : hasVerifierFailure ? 0.3 : 1,
          });

          if (packetStore) {
            await packetStore.append(reviewPacket);
            await packetStore.writeArtifact("review-packet.json", reviewPacket);
          }

          // If failed, create incident and recovery packets
          if (verdict === "NEEDS_FIX") {
            const failureClass = workerError ? "worker_failure" : "verifier_contract_failure";
            const fc = classifyFailureClass(failureClass);
            const incidentPacket = createIncidentPacket({
              packetId: `${packetRunId}:incident`,
              runId: packetRunId,
              mode: (mode === "subagent" ? "subagent" : "loop") as "loop" | "eval",
              role: "system",
              incidents: [{
                id: `I1:${failureClass}`,
                kind: fc.kind,
                severity: fc.severity,
                failureClass,
                harnessLayer: fc.harnessLayer,
                summary: workerError ? "Worker interrupted by user" : "Verification command failed",
                evidence: [],
                recommendedChecks: [],
              }],
            });

            const recoveryPacket = createRecoveryPacket({
              packetId: `${packetRunId}:recovery`,
              runId: packetRunId,
              mode: (mode === "subagent" ? "subagent" : "loop") as "loop" | "eval",
              role: "system",
              incidents: incidentPacket.incidents,
            });

            if (packetStore) {
              await packetStore.append(incidentPacket);
              await packetStore.writeArtifact("incident-packet.json", incidentPacket);
              await packetStore.append(recoveryPacket);
              await packetStore.writeArtifact("recovery-packet.json", recoveryPacket);
            }

            this.logger.info("harness.packet.created", {
              packetId: incidentPacket.packetId, packetType: "incident",
              runId: packetRunId, mode, failureClass,
            });
          }

          this.logger.info("harness.packet.created", {
            packetId: reviewPacket.packetId, packetType: "review",
            runId: packetRunId, mode, verdict,
          });
        } catch {
          // Packet lifecycle is optional
        }
      }
    } catch (err) {
      // P1-fix (B): submit 总 catch — 把任何 throw 转为 error + done 事件。
      // 原先 submit() 只有 try/finally 无 catch，throw 直接传播给 async generator
      // 消费者，TUI 难以处理。现在统一转为 error 事件，确保 finally 仍执行清理。
      submitFailed = true
      const errMsg = err instanceof Error ? err.message : String(err)
      if (this.logger.isEnabled("error")) {
        this.logger.error("submit.uncaught_error", err instanceof Error ? err : new Error(String(err)), { submitId })
      }
      const errEvt: LoopEvent = {
        role: "error",
        content: `Submit failed: ${errMsg}`,
        severity: "error" as const,
        metadata: { source: "submit", submitId },
      }
      yield errEvt
      this.sessionRuntime.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: errEvt })
      const doneEvt: LoopEvent = {
        role: "done",
        metadata: { reason: "submit_error" } as Record<string, unknown>,
      }
      yield doneEvt
      this.sessionRuntime.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: doneEvt })
    } finally {
      // Packet lifecycle: emit completed phase
      // P1-fix: submit 失败时标记为 Failed，不再误报 Accepted
      if (mode === "loop" || mode === "subagent") {
        yield {
          role: "status",
          content: submitFailed ? "Failed" : this._interrupted ? "Interrupted" : "Accepted",
          severity: (submitFailed || this._interrupted) ? "warning" : undefined,
          metadata: { runId: packetRunId },
        };
      }

      // TUI-FIX-10: emit loop_transition at submit end
      yield {
        role: "orchestration",
        orchestration: {
          kind: "loop_transition",
          transition: {
            from: "observe",
            to: submitFailed ? "failed" : this._interrupted ? "paused" : "done",
            attempt: 1,
            timestamp: Date.now(),
          },
        },
      }
      if (this._interrupted) {
        yield {
          role: "orchestration",
          orchestration: {
            kind: "runtime_signal",
            signal: { kind: "no-progress", message: "submit_interrupted" },
          },
        }
      }
      if (diagnosticsEnabled) {
        submitLogger.info("submit.done", {
          durationMs: Date.now() - submitStartedAt,
          interrupted: this._interrupted,
        })
      }
      this.isSubmitting = false
      if (this.activeAbortController === abortController) {
        this.activeAbortController = undefined
      }
    }
  }

  /** 将工具调用的结果追加到对话上下文中 */
  private appendToolResult(tc: ToolCall, result: ToolResult): void {
    this.sessionRuntime.stats.toolCalls++
    this.ctx.log.append({
      role: "tool",
      tool_call_id: tc.id,
      content: result.content,
      name: tc.function.name,
      is_error: result.isError,
    })
  }

  private async delegateTask(task: string, agentType: string, files: string[]): Promise<string> {
    const subagentType = agentType === "plan" ? "Plan" : "general-purpose"
    const result = await this.spawnSubagent({
      description: task.split(/\s+/).slice(0, 5).join(" ") + "...",
      prompt: files.length > 0
        ? `${task}\n\nRelevant files:\n${files.map(file => `- ${file}`).join("\n")}`
        : task,
      subagentType,
      files,
    })
    if (result.status === "completed") return result.result
    return `[error] Sub-agent task failed: ${JSON.stringify(result)}`
  }

  async spawnSubagent(options: SubagentRunOptions): Promise<SubagentRunResult> {
    const def = this.supervisorRuntime.subagentRegistry.resolve(options.subagentType ?? "general-purpose")
    const workerId = `worker_${randomUUID().slice(0, 8)}`
    const workerStartedAt = Date.now()
    const emitWorkerEvent = (event: LoopEvent): void => {
      this.supervisorRuntime.enqueueDelegatedEvent(event)
    }

    // TUI-FIX-10: emit worker_upsert (starting)
    emitWorkerEvent({
      role: "orchestration",
      orchestration: {
        kind: "worker_upsert",
        worker: {
          id: workerId,
          modelTarget: options.target ?? def.target ?? "default",
          status: "starting",
          currentTask: options.description,
          elapsedMs: Date.now() - workerStartedAt,
        },
      },
    })

    // SA-1: 迁移 SubagentRunner 的 target 解析能力 — 按 target 解析独立 client，
    // 不再无条件共享父级 client。保留 TUI orchestration 事件和 cancel/interrupt 逻辑。
    // 测试时可通过 setChildClientFactory() 注入 mock factory，避免触发真实 client。
    const targetId = options.target ?? def.target
    const resolvedTarget = targetId
      ? resolveModelTarget(targetId, this.config, this.config.modelTargets)
      : null
    const childConfig = resolvedTarget ? targetToConfig(resolvedTarget) : this.config
    const childClient = resolvedTarget
      ? (this.supervisorRuntime.childClientFactory
          ? this.supervisorRuntime.childClientFactory(resolvedTarget, this.logger.child({ delegate: true, subagentType: def.name }))
          : createClientForTarget(resolvedTarget, this.logger.child({ delegate: true, subagentType: def.name })))
      : this.client

    const child = new ReasonixEngine(
      childConfig,
      undefined,
      undefined,
      childClient,
      this.logger.child({ delegate: true, subagentType: def.name }),
      this.toolRuntimeHooks ? { toolRuntimeHooks: this.toolRuntimeHooks } : undefined,
    )
    this.supervisorRuntime.activeChildEngines.add(child)

    // SPEC-C: 子引擎继承父引擎 contextPolicy
    await child.setContextPolicy(this.getContextPolicy())

    try {
      for (const tool of this.toolRuntime.tools.values()) {
        if (tool.name === "AgentTool") continue
        if (def.disallowedTools?.includes(tool.name)) continue
        if (def.tools && def.tools[0] !== "*" && !def.tools.includes(tool.name)) continue

        child.registerTool(tool)

        const perm = checkSubagentPermission(tool.name, def.permissionMode)
        if (!perm.allowed) {
          const reason = perm.bubble
            ? `${perm.reason ?? `Denied by subagent permission mode: ${def.permissionMode}`}. Bubble approval is not implemented; request was denied.`
            : (perm.reason ?? `Denied by subagent permission mode: ${def.permissionMode}`)
          child.permissionEngine.addDenyRule({
            toolName: tool.name,
            reason,
          })
        }

        if (def.permissionMode === "denyExec" && tool.approval === "exec") {
          child.permissionEngine.addDenyRule({
            toolName: tool.name,
            reason: `Subagent in denyExec mode cannot run exec tool: ${tool.name}`,
          })
        }
      }

      const agentCfg = agentConfigFor("build", {
        systemPrompt: getSubagentSystemPrompt(def),
        toolNames: this.supervisorRuntime.subagentRegistry.getEffectiveTools(def) ?? undefined,
        model: typeof options.model === "string" && options.model !== "inherit" ? options.model : undefined,
      })

      let output = ""
      const warnings: string[] = []
      let usage = { promptTokens: 0, completionTokens: 0 }
      let workerFailed = false
      let workerCancelled = false
      let workerErrorCount = 0

      // TUI-FIX-10: emit worker_upsert (running)
      emitWorkerEvent({
        role: "orchestration",
        orchestration: {
          kind: "worker_upsert",
          worker: {
            id: workerId,
            modelTarget: options.target ?? def.target ?? "default",
            status: "running",
            currentTask: options.description,
            elapsedMs: Date.now() - workerStartedAt,
          },
        },
      })

      for await (const event of child.submit(options.prompt, agentCfg)) {
        this.supervisorRuntime.enqueueDelegatedEvent({
          ...event,
          metadata: {
            ...event.metadata,
            agentRole: "worker",
            parentRole: "supervisor",
            workerId,
          },
        })
        if (event.role === "assistant_delta") output += event.content ?? ""
        if (event.role === "usage" && event.metadata) {
          usage = {
            promptTokens: (event.metadata.promptTokens as number) ?? 0,
            completionTokens: (event.metadata.completionTokens as number) ?? 0,
          }
        }
        if (event.role === "error") {
          warnings.push(event.content ?? "unknown error")
          workerErrorCount++
          // Only mark as failed on repeated errors or severe errors
          if (workerErrorCount >= 2 || event.severity === "error") {
            workerFailed = true
          }
        }
        // TUI-FIX-10: detect waiting states from subagent events
        if (event.role === "permission_ask") {
          emitWorkerEvent({
            role: "orchestration",
            orchestration: {
              kind: "worker_upsert",
              worker: {
                id: workerId,
                modelTarget: options.target ?? def.target ?? "default",
                status: "waiting_permission",
                currentTask: options.description,
                elapsedMs: Date.now() - workerStartedAt,
              },
            },
          })
        }
        if (event.role === "question_ask") {
          emitWorkerEvent({
            role: "orchestration",
            orchestration: {
              kind: "worker_upsert",
              worker: {
                id: workerId,
                modelTarget: options.target ?? def.target ?? "default",
                status: "waiting_question",
                currentTask: options.description,
                elapsedMs: Date.now() - workerStartedAt,
              },
            },
          })
        }
        if (event.role === "status" && event.content === "interrupted") {
          workerCancelled = true
        }
      }

      // TUI-FIX-10: emit final worker status (keep visible, don't remove)
      const finalElapsedMs = Date.now() - workerStartedAt
      if (workerCancelled) {
        emitWorkerEvent({
          role: "orchestration",
          orchestration: {
            kind: "worker_upsert",
            worker: {
              id: workerId,
              modelTarget: options.target ?? def.target ?? "default",
              status: "cancelled",
              currentTask: options.description,
              elapsedMs: finalElapsedMs,
            },
          },
        })
      } else if (workerFailed) {
        emitWorkerEvent({
          role: "orchestration",
          orchestration: {
            kind: "worker_upsert",
            worker: {
              id: workerId,
              modelTarget: options.target ?? def.target ?? "default",
              status: "failed",
              currentTask: options.description,
              elapsedMs: finalElapsedMs,
            },
          },
        })
      } else {
        emitWorkerEvent({
          role: "orchestration",
          orchestration: {
            kind: "worker_upsert",
            worker: {
              id: workerId,
              modelTarget: options.target ?? def.target ?? "default",
              status: "completed",
              currentTask: options.description,
              elapsedMs: finalElapsedMs,
            },
          },
        })
      }

      return {
        status: workerCancelled ? "cancelled" as const : workerFailed ? "failed" as const : "completed" as const,
        id: `subagent_${randomUUID().slice(0, 8)}`,
        subagent_type: def.name,
        description: options.description,
        result: output.trim(),
        files: options.files ?? [],
        usage,
        warnings,
      }
    } finally {
      this.supervisorRuntime.activeChildEngines.delete(child)
      // Keep worker visible for a while so React can render final state
      // worker_remove will be emitted on next submit or session switch
      await child.shutdown()
    }
  }
}

// buildOmpContext removed: engine now talks directly to DeepSeek official API.
