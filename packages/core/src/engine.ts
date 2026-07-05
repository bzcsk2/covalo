import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { DeepreefConfig } from "./config.js"
import type { CovaloConfig } from "./config/schema.js"
import { ContextManager } from "./context/manager.js"
import type { ToolCall, ToolSpec, ChatMessage } from "./types.js"
import type { CoreEngine, AgentConfig, AgentTool, LoopEvent, AgentState, SessionStats, ToolResult, EnqueueInstructionResult, ChatClient } from "./interface.js"
import type { QuestionInfo, QuestionAnswer } from "./question/types.js"
import { QuestionService } from "./question/service.js"
import { DeepSeekClient } from "./client.js"

import { StreamingToolExecutor } from "./streaming-executor.js"
import { AsyncSessionWriter, SessionLoader } from "./session.js"
import { runLoop } from "./loop.js"
import type { LoopOptions } from "./loop.js"
import { PermissionEngine, HookManager } from "@covalo/security"
import { getAgent, agentConfigFor, getMainMode } from "./agent.js"
import type { WorkflowMode } from "./dual-agent-runtime/types.js"
import { resolveEffectiveTools } from "./resolve-effective-tools.js"
import { TOOL_CATEGORIES } from "./tool-routing/two-stage-router.js"
import type { WorkflowPhase } from "./workflow-coordinator/types.js"
import { SubagentRegistry, checkSubagentPermission } from "./subagent/index.js"
import { getSubagentSystemPrompt } from "./subagent/definition.js"
import type { SubagentRunOptions, SubagentRunResult, SubagentDefinition } from "./subagent/index.js"
import type { ThinkingMode } from "./provider-thinking.js"
import { createRuntimeLoggerFromEnv, type RuntimeLogger } from "./runtime-logger.js"
import type { ResultPersistenceConfig } from "./result-persistence.js"

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
import { ReadTracker } from "./read-before-write.js"
import { EarlyStopDetector } from "./early-stop.js"
import type { VerificationGateState } from "./governance/verification-gate.js"
import { BranchBudgetTracker } from "./governance/branch-budget.js"
import { ModeDecisionEngine } from "./governance/mode-decision.js"
import { CheckpointEngine } from "./checkpoint/checkpoint-engine.js"
import {
  createSupervisorGuidanceState,
  SupervisorBudgetTracker,
  loadSupervisorPool,
  type SupervisorGuidanceConfig,
} from "./supervisor/index.js"
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
  getSessionId(): string { return this.sessionId }

  /** Deepreef 全局配置 */
  private config: DeepreefConfig
  /** 上下文管理器，负责维护消息历史和 system prompt */
  private ctx: ContextManager
  /** 注册的工具集合，key 为工具名 */
  private tools: Map<string, AgentTool> = new Map()
  /** LLM 客户端 */
  private client: ChatClient
  /** 流式工具执行器，负责并发执行工具调用并流式返回结果 */
  private toolExecutor: StreamingToolExecutor
  /** 中断标记，由外部调用 interrupt() 设置 */
  private _interrupted = false
  /** 当前活动的 AbortController，用于中断正在进行的 API 请求 */
  private activeAbortController?: AbortController
  /** 当前会话 ID */
  private sessionId: string
  /** 会话持久化写入器（best-effort，失败静默忽略） */
  private sessionWriter?: AsyncSessionWriter
  /** 开发诊断日志。默认关闭，不参与业务语义。 */
  private logger: RuntimeLogger
  /** 会话级别的 token 用量和成本统计 */
  private stats: SessionStats = {
    promptTokens: 0, completionTokens: 0,
    cacheHitTokens: 0, cacheMissTokens: 0,
    apiCalls: 0, toolCalls: 0, totalCost: 0,
  }
  /** 可选：新引擎初始化时调用的清理钩子（如清除全局 stale-read tracker） */
  private onStart?: () => void

  /** 权限引擎：三级判定（Deny → Allow → Ask） */
  permissionEngine: PermissionEngine
  /** Hook 管理器：tool call 前后 + loop 事件 */
  hookManager: HookManager
  /** 当前活跃 agent 名称 */
  private currentAgent: string

  /** SFR-20: 原始基础系统提示（含 cwd、平台等运行环境），与角色提示分层组合 */
  private baseSystemPrompt: string = ""

  /** prefix.build 缓存：避免每次 submit 重复重建（P3-4-2） */
  private prefixCacheKey = ""

  /** SPEC-G: 上次 build prefix 时的 system prompt 文本，用于检测 prompt 变化 */
  private lastSystemPromptKey = ""

  /** exec 工具权限确认：pending Promise 由 TUI 响应 resolve */
  private pendingPermission: { resolve: (v: boolean) => void; toolName: string; args: Record<string, unknown> } | null = null

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



  /** Subagent registry for resolving subagent definitions */
  private subagentRegistry: SubagentRegistry

  /** QST-10: Question service for user interaction */
  private questionService: QuestionService

  /** DRF-40: 当前 submit 的任务账本 */
  private taskLedger?: TaskLedgerTracker
  /** DRF-40: Verification Gate 计数器 */
  private verificationGateState: VerificationGateState = { continuationCount: 0 }
  /** DRF-60: Supervisor 指导状态（单 submit 生命周期） */
  private supervisorGuidanceState = createSupervisorGuidanceState()

  /** TUI-FIX-10: 编排事件发射回调（供 TUI Bridge 消费） */
  private emitOrchestration?: (event: LoopEvent) => void
  /** 子 Worker 的原始事件，在父 submit 流中按顺序转发给 TUI。 */
  private delegatedEvents: LoopEvent[] = []
  private delegatedEventWaiters = new Set<() => void>()
  private activeChildEngines = new Set<ReasonixEngine>()

  /**
   * SA-1: 可测试的 child client factory 注入点。
   * 生产代码留 undefined → spawnSubagent 用默认 createClientForTarget。
   * 测试时注入 mock factory → 避免触发真实 DeepSeekClient / 网络。
   */
  private childClientFactory?: (target: ModelTarget, logger: RuntimeLogger) => ChatClient

  /** SA-1: 注入 child client factory（测试用） */
  setChildClientFactory(factory: (target: ModelTarget, logger: RuntimeLogger) => ChatClient): void {
    this.childClientFactory = factory
  }

  /**
   * @deprecated 使用 AgentProfile 中的 harness 配置代替
   * ADV-HAR-01: 当前会话的 Harness 严格度（可通过 /harness 切换）
   */
  private sessionStrictness?: HarnessStrictness
  /** ADV-HAR-02: 当前 submit 解析后的不可变策略（每次 submit 刷新） */
  private effectivePolicy: EffectiveHarnessPolicy | null = null

  /** F0-1: governance/checkpoint 三件套（构造时实例化，submit 中按 effectivePolicy 启停） */
  private branchBudgetTracker: BranchBudgetTracker = new BranchBudgetTracker()
  private checkpointEngine: CheckpointEngine
  private modeDecisionEngine: ModeDecisionEngine = new ModeDecisionEngine()

  /** Get context window size */
  getContextWindow(): number {
    return this.ctx.getContextWindow()
  }

  /** P2: Mid-session instruction queue — consumed by loop at safe points */
  private pendingInstructionQueue: string[] = []
  private isSubmitting = false
  private static readonly MAX_PENDING_INSTRUCTIONS = 10

  /** 流式执行器内部调用，等待 TUI 返回确认结果 */
  private requestPermission = async (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
    return new Promise(resolve => { this.pendingPermission = { resolve, toolName, args } })
  }

  /** TUI-FIX-10: 设置编排事件发射回调 */
  setOnOrchestrationEvent(handler: (event: LoopEvent) => void): void {
    this.emitOrchestration = handler
  }

  /** TUI 调用以响应权限确认提示 */
  respondPermission(allow: boolean, alwaysAllow?: boolean): void {
    if (this.pendingPermission) {
      if (allow && alwaysAllow) {
        this.permissionEngine.addAllowRule({ toolName: this.pendingPermission.toolName })
      }
      this.pendingPermission.resolve(allow)
      this.pendingPermission = null
      return
    }
    for (const child of this.activeChildEngines) child.respondPermission(allow, alwaysAllow)
  }

  /** QST-10: TUI 调用以回答 Question */
  respondQuestion(requestId: string, answers: QuestionAnswer[]): void {
    if (this.questionService.list().some(request => request.id === requestId)) {
      this.questionService.reply({ requestId, answers })
      return
    }
    for (const child of this.activeChildEngines) child.respondQuestion(requestId, answers)
  }

  /** QST-10: TUI 调用以拒绝 Question */
  rejectQuestion(requestId: string): void {
    if (this.questionService.list().some(request => request.id === requestId)) {
      this.questionService.reject(requestId)
      return
    }
    for (const child of this.activeChildEngines) child.rejectQuestion(requestId)
  }

  /** QST-10: 获取待处理的 Question 列表 */
  listPendingQuestions(): Array<{ id: string; sessionId: string; questions: QuestionInfo[] }> {
    return this.questionService.list()
  }

  /** QST-10: 内部方法，供 ToolContext.askUser 调用 */
  private async askUserFromTool(questions: QuestionInfo[]): Promise<QuestionAnswer[]> {
    return this.questionService.ask({
      sessionId: this.sessionId,
      questions,
    })
  }

  /** P2: Enqueue a mid-session instruction for consumption at the next safe point */
  enqueueInstruction(instruction: string): EnqueueInstructionResult {
    const trimmed = instruction.trim()
    if (!trimmed) {
      return { status: "ignored", queueLength: this.pendingInstructionQueue.length }
    }
    if (!this.isSubmitting) {
      return { status: "idle", queueLength: 0 }
    }
    if (this.pendingInstructionQueue.length >= ReasonixEngine.MAX_PENDING_INSTRUCTIONS) {
      return { status: "full", queueLength: this.pendingInstructionQueue.length }
    }
    this.pendingInstructionQueue.push(trimmed)
    return { status: "queued", queueLength: this.pendingInstructionQueue.length }
  }

  constructor(config: DeepreefConfig, onStart?: () => void, sessionId?: string, customClient?: ChatClient, runtimeLogger?: RuntimeLogger) {
    this.config = config
    this.ctx = new ContextManager(config.maxContextRounds, config.contextWindow)
    this.sessionId = sessionId ?? randomUUID()
    this.logger = runtimeLogger ?? createRuntimeLoggerFromEnv({ sessionId: this.sessionId })
    this.client = this.resolveClient(customClient)
    this.currentAgent = "build"
    this.permissionEngine = new PermissionEngine()
    this.configurePermissionDefaults()
    this.hookManager = new HookManager()
    this.subagentRegistry = new SubagentRegistry()
    this.questionService = new QuestionService()
    this.hookManager.setErrorObserver((error, phase) => {
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

    this.toolExecutor = new StreamingToolExecutor(
      this.tools,
      this.sessionId,
      undefined,
      this.permissionEngine,
      this.hookManager,
      this.requestPermission,
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
    this.rebindSessionWriter(this.sessionId)
    // F0-1: CheckpointEngine 初始化（sessionDir 与 sessionWriter 同目录）
    const sessionDir = resolve(process.cwd(), ".covalo", "sessions")
    this.checkpointEngine = new CheckpointEngine(sessionDir, this.sessionId)
    if (this.logger.isEnabled()) this.logger.info("engine.created", { provider: config.provider, model: config.model })
  }

  /**
   * 根据 approvalPolicy 配置权限引擎默认值。
   * 安全默认：读允许，写/编辑/执行询问。
   */
  private configurePermissionDefaults(): void {
    const toolsConfig = (this.config as unknown as Record<string, unknown>).tools as { approvalPolicy?: string; strictMode?: boolean } | undefined
    const policy = toolsConfig?.approvalPolicy ?? "on-request"
    const strictMode = toolsConfig?.strictMode ?? false

    // 设置 strictMode
    this.permissionEngine.setStrictMode(strictMode)

    // 安全默认：读允许，写/编辑/执行询问
    this.permissionEngine.setDefaultDecision("read", "allow")
    this.permissionEngine.setDefaultDecision("write", "ask")
    this.permissionEngine.setDefaultDecision("edit", "ask")
    this.permissionEngine.setDefaultDecision("exec", "ask")

    // 明确无审批模式，才放宽写/编辑/执行
    if (policy === "never") {
      this.permissionEngine.setDefaultDecision("write", "allow")
      this.permissionEngine.setDefaultDecision("edit", "allow")
      this.permissionEngine.setDefaultDecision("exec", "allow")
    }

    // always：连 read 也走 ask；适合极端审计模式
    if (policy === "always") {
      this.permissionEngine.setDefaultDecision("read", "ask")
    }
  }

  static async recover(config: DeepreefConfig, sessionId: string): Promise<ReasonixEngine> {
    if (!SessionLoader.validateSessionId(sessionId)) {
      throw new Error(`Invalid session ID for recover: ${sessionId}`)
    }
    const engine = new ReasonixEngine(config, undefined, sessionId)
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
          engine.verificationGateState = { ...v2.verificationGate }
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
    // 原先 loadSession 不清理旧 session 的 manager，导致旧 session 的后台 shell
    // 子进程、hard timer、log 写流驻留在 managersBySession Map 中直到进程退出。
    if (this.sessionId !== sessionId) {
      try {
        const { disposeBackgroundTaskManagerFor } = await import("@covalo/tools")
        disposeBackgroundTaskManagerFor(this.sessionId)
      } catch {
        // best-effort: 不阻塞 session 切换
      }
    }
    this.sessionId = sessionId
    // SPEC-A: session boundary — clear all context zones and submit-local state
    // FIX-H3: 清空跨 session 的 harness strictness/policy 残留
    this.sessionStrictness = undefined
    this.effectivePolicy = null
    this.ctx.log.clear()
    this.ctx.clearTransientState()
    this.taskLedger = undefined
    this.verificationGateState = { continuationCount: 0 }
    this.supervisorGuidanceState = createSupervisorGuidanceState()
    this.pendingInstructionQueue = []
    this.toolExecutor.setSessionId(sessionId)
    this.logger = this.logger.child({ sessionId })
    this.rebindSessionWriter(sessionId)
    // F0-1: 切换 session 时重建 CheckpointEngine，重置 governance 状态
    const sessionDir = resolve(process.cwd(), ".covalo", "sessions")
    this.checkpointEngine = new CheckpointEngine(sessionDir, sessionId)
    this.branchBudgetTracker.reset()
    this.modeDecisionEngine.resetSubmittedSignals()
    // TUI-FIX-10: 清除前一 session 的所有 worker
    this.emitOrchestration?.({ role: "orchestration", orchestration: { kind: "worker_remove", workerId: "*" } })
    return this._loadSessionMessages(sessionId)
  }

  private rebindSessionWriter(sessionId: string): void {
    const sessionPath = resolve(process.cwd(), ".covalo", "sessions", `${sessionId}.jsonl`)
    const writer = new AsyncSessionWriter(sessionPath)
    writer.init().catch(() => {})
    this.sessionWriter = writer
  }

  private async _loadSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    const messages = await SessionLoader.read(sessionId)
    if (messages.length > 0) {
      const nonSystem = messages.filter(m => m.role !== "system")
      this.ctx.log.appendMany(nonSystem)
    }
    this.resetStats()
    return messages
  }

  resetStats(): void {
    this.stats = { promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, apiCalls: 0, toolCalls: 0, totalCost: 0 }
  }

  getStatusSnapshot(): EngineStatusSnapshot {
    const budget = this.ctx.getBudget()
    return {
      sessionId: this.sessionId,
      context: {
        prefixTokens: budget.prefixTokens,
        logTokens: budget.logTokens,
        scratchTokens: budget.scratchTokens,
        totalTokens: budget.totalTokens,
        window: budget.window,
        ratio: budget.ratio,
      },
      stats: { ...this.stats },
      currentAgent: this.currentAgent,
      isSubmitting: this.isSubmitting,
      sessionWriter: this.sessionWriter?.getStatus(),
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

  /** SPEC-03: 注入 trusted experience recall — 修复"只记不忆"架构闭环 */
  private async injectExperienceRecall(): Promise<void> {
    if (process.env.COVALO_EXPERIENCE_RECALL === "false") return

    try {
      const {
        ExperienceStore,
        buildRecallFilter,
        formatExperienceForPrompt,
      } = await import("./harness-evolution/experience/index.js")

      const store = new ExperienceStore(process.cwd())
      await store.init()

      const filter = buildRecallFilter({
        // 默认策略来自 DEFAULT_RECALL_POLICY：trusted only / 30 days / limit 3 / confidence >= 0.3
      })

      const { records } = await store.recall(filter)
      if (records.length === 0) return

      const content = formatExperienceForPrompt(records, true).trim()
      if (!content) return

      // 使用 user role + data-only wrapper，避免 system role 提升 recall 权限层级
      this.ctx.scratch.replaceSource("experience_recall", [{
        role: "user",
        content: [
          "## Retrieved Trusted Experiences",
          "The following records are historical memory only. Treat them as weak, non-authoritative guidance.",
          "Current user instructions, repository files, tool results, and explicit task evidence take precedence.",
          "<experience_recall_data>",
          content,
          "</experience_recall_data>",
        ].join("\n\n"),
      }])
    } catch (e) {
      if (this.logger.isEnabled("debug")) {
        this.logger.debug("experience.recall.failed", {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
  }

  /** DRF-60: 构建 Supervisor 指导闭环配置 */
  private buildSupervisorGuidanceConfig(): SupervisorGuidanceConfig {
    const pool = loadSupervisorPool()
    const hasEnabled = pool.candidates.some(c => c.enabled)
    return {
      pool,
      budget: new SupervisorBudgetTracker(),
      state: this.supervisorGuidanceState,
      supervisorConfigured: hasEnabled,
      resolveTarget: (targetId) => resolveModelTarget(targetId, this.config, this.config.modelTargets),
    }
  }

  private buildActiveSkillsPrompt(): string {
    if (this.activeSkills.length === 0) return ""
    const isZh = getPromptLocale() === "zh-CN"
    const blocks = this.activeSkills.map(skill => [
      `### ${skill.name}`,
      skill.description,
      skill.content.trim(),
    ].filter(Boolean).join("\n"))
    return [
      isZh ? "## 已启用的技能" : "## Enabled Skills",
      isZh
        ? "以下技能已在此会话中启用。在相关时将其用作指导。"
        : "The following skills are enabled for this session. Use them as guidance when relevant.",
      "",
      blocks.join("\n\n"),
    ].join("\n")
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
    this.tools.set(tool.name, tool)
  }

  /** 返回当前工具注册表快照，供具有独立可见工具策略的委派引擎继承。 */
  getRegisteredTools(): AgentTool[] {
    return [...this.tools.values()]
  }

  private enqueueDelegatedEvent(event: LoopEvent): void {
    this.delegatedEvents.push(event)
    for (const wake of this.delegatedEventWaiters) wake()
    this.delegatedEventWaiters.clear()
  }

  private waitForDelegatedEvent(): { promise: Promise<void>; cancel: () => void } {
    let wake!: () => void
    const promise = new Promise<void>(resolve => { wake = resolve })
    this.delegatedEventWaiters.add(wake)
    return { promise, cancel: () => this.delegatedEventWaiters.delete(wake) }
  }

  /** 标记中断，终止当前正在进行的请求和工具执行 */
  interrupt(): void {
    if (this.logger.isEnabled()) this.logger.info("engine.interrupt", { isSubmitting: this.isSubmitting })
    this._interrupted = true
    this.pendingInstructionQueue = []
    this.respondPermission(false)
    this.questionService.interrupt()
    for (const child of this.activeChildEngines) child.interrupt()
    this.activeAbortController?.abort()
  }

  /** LIFE-01: 幂等的显式关闭入口。重复调用安全，部分初始化失败也安全。 */
  async shutdown(): Promise<void> {
    if (this._shutDown) return
    this._shutDown = true
    if (this.logger.isEnabled("info")) this.logger.info("engine.shutdown.start", { sessionId: this.sessionId })

    try {
      this.interrupt()
    } catch (e) {
      // ADV-BUG-05: Log interrupt errors
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.shutdown.interrupt_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    try {
      await this.ctx.shutdown()
    } catch (e) {
      // ADV-BUG-05: Log context shutdown errors
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.shutdown.context_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    try {
      await this.sessionWriter?.drain()
    } catch (e) {
      // ADV-BUG-05: Log session drain errors
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.shutdown.session_drain_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    // P1-fix: dispose BackgroundTaskManager for this session。
    // 原先生产代码从不调用 dispose，导致后台 shell 子进程、hard timer、
    // log 写流在进程退出或 session 切换时泄漏。
    try {
      const { disposeBackgroundTaskManagerFor } = await import("@covalo/tools")
      disposeBackgroundTaskManagerFor(this.sessionId)
    } catch (e) {
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.shutdown.bg_task_dispose_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    // F0-1: shutdown 时最后落盘一次 checkpoint（trigger: final_draft，无论 free/forced 都落盘）
    try {
      if (this.checkpointEngine) {
        await this.checkpointEngine.save({
          trigger: "final_draft",
          branchBudget: this.branchBudgetTracker,
          lastStopReason: "aborted",
          taskLedger: this.taskLedger?.snapshot(),
          verificationGate: this.verificationGateState,
        })
      }
    } catch (e) {
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.shutdown.checkpoint_save_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    if (this.logger.isEnabled("info")) this.logger.info("engine.shutdown.done", { sessionId: this.sessionId })

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
    // Re-resolve client when provider changes
    if (providerChanged) {
      this.client = this.resolveClient()
    }
    const partialToolsConfig = (partial as unknown as Record<string, unknown>).tools as { approvalPolicy?: string; strictMode?: boolean } | undefined
    if (partialToolsConfig?.approvalPolicy !== undefined || partialToolsConfig?.strictMode !== undefined) {
      this.configurePermissionDefaults()
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
   * 设置会话级 Harness 严格度。
   *
   * 生效时机：
   * - 如果当前没有 submit 正在运行，则下一次 submit 开始时生效。
   * - 如果当前 submit 正在运行，不会改变本次 loop 的工具集、路由、验证或 checkpoint 策略。
   *   新严格度会在下一次 submit 开始时重新解析并固化。
   *
   * 这是有意设计：避免同一次 loop 中途发生工具集/权限/路由突变。
   *
   * @deprecated 使用 AgentProfile 中的 harness 配置代替
   */
  setHarnessStrictness(strictness: HarnessStrictness): void {
    this.sessionStrictness = strictness
  }

  /**
   * @deprecated 使用 AgentProfile 中的 thinking 配置代替
   * 设置推理档位（off / open / high），传递给 DeepSeek thinking API
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
    return this.effectivePolicy?.strictness ?? this.sessionStrictness ?? "normal"
  }

  /** ADV-HAR-02: 获取当前有效 Harness 策略（只读） */
  getEffectivePolicy(): EffectiveHarnessPolicy | null {
    return this.effectivePolicy
  }

  /**
   * 获取当前引擎状态的快照，包括消息列表、流式状态、待执行工具等
   * @param isStreaming 是否正在流式输出
   * @param streamingMessage 当前已流式输出的内容
   * @param pendingToolCalls 待执行的工具调用列表
   */
  getState(isStreaming = false, streamingMessage = "", pendingToolCalls: Array<{ name: string; args: string }> = []): AgentState {
    return {
      sessionId: this.sessionId,
      messages: [...this.ctx.buildMessages()],
      isStreaming,
      streamingMessage,
      pendingToolCalls,
      currentAgent: this.currentAgent,
      stats: { ...this.stats },
    }
  }

  private buildSupervisorLoopModePrompt(workflowPhase?: WorkflowPhase): string {
    const isZh = getPromptLocale() === "zh-CN"
    if (workflowPhase === "supervisor_analyse") {
      return isZh
        ? `## 循环模式 —— Supervisor 分析

你是规划阶段的 Supervisor。

WorkflowCoordinator 控制执行顺序：
supervisor_analyse -> worker_do -> worker_report -> supervisor_check

你当前的任务：
- 为 Worker 制定具体计划。
- 不要自行执行计划。
- 不要检查实现文件。
- 不要验证代码。
- 不要执行 Worker 任务。
- 不要调用 read_file、grep、bash、edit、write、apply_patch、AgentTool 或调度工具。
- 如果工具可用，最多使用 get_goal 和 list_dir 做浅层了解。
- 不要重复调用工具。如果浅层了解不够，在计划中说明假设，让 Worker 去检查细节。
- 制定计划后停止。协调器会将你的计划传递给 Worker。

返回结构化计划，包含：
- objective
- 具体的 Worker 步骤
- constraints
- risks
- expected evidence / verification criteria`
        : `## Loop Mode — Supervisor Analyse

You are the Supervisor in the planning phase.

The WorkflowCoordinator owns execution order:
supervisor_analyse -> worker_do -> worker_report -> supervisor_check.

Your current job:
- Create a concrete plan for the Worker.
- Do not execute the plan yourself.
- Do not inspect implementation files.
- Do not verify code.
- Do not perform Worker tasks.
- Do not call read_file, grep, bash, edit, write, apply_patch, AgentTool, mailbox, or dispatch tools.
- If tools are available, use at most get_goal and list_dir for shallow orientation.
- Do not call tools repeatedly. If shallow orientation is insufficient, state assumptions in the plan and let the Worker inspect details.
- After producing the plan, stop. The coordinator will pass your plan to the Worker.

Return a structured plan with:
- objective
- concrete Worker steps
- constraints
- risks
- expected evidence / verification criteria`
    }

    if (workflowPhase === "supervisor_check") {
      return isZh
        ? `## 循环模式 —— Supervisor 审查

你是审查阶段的 Supervisor。

你当前的任务：
- 审查 Worker 报告。
- 对照计划和目标验证 Worker 输出。
- 你可以使用 read_file 和 grep 检查证据。
- 不要自行执行 Worker 任务。
- 不要编辑文件。
- 不要执行实现步骤。
- 决定以下之一：continue、revise、approve、ask_user 或 blocked。

除非你提供了逐需求的完成审核及具体证据，否则不要批准。`
        : `## Loop Mode — Supervisor Check

You are the Supervisor in the review phase.

Your current job:
- Review the Worker report.
- Verify the Worker output against the plan and goal.
- You may use read_file and grep to inspect evidence.
- Do not perform Worker tasks yourself.
- Do not edit files.
- Do not run implementation steps.
- Decide one of: continue, revise, approve, ask_user, or blocked.

Do not approve unless you provide a requirement-by-requirement completion audit with concrete evidence.`
    }

    if (workflowPhase === "supervisor_intervene") {
      return isZh
        ? `## 循环模式 —— Supervisor 干预

你正在给 Worker 提供简要的中途指导。

你当前的任务：
- 诊断 Worker 的阻塞点。
- 提供简洁的指导。
- 不要自行执行 Worker 任务。
- 不要批准或完成工作流。
- 不要编辑文件。
- 除非绝对必要，不使用工具。`
        : `## Loop Mode — Supervisor Intervention

You are giving brief mid-workflow guidance to the Worker.

Your current job:
- Diagnose the Worker blocker.
- Provide concise guidance.
- Do not perform Worker tasks yourself.
- Do not approve or complete the workflow.
- Do not edit files.
- Use no tools unless strictly necessary.`
    }

    return isZh
      ? `## 循环模式 —— Supervisor

你是当前循环目标的 Supervisor。

WorkflowCoordinator 控制执行顺序：
supervisor_analyse -> worker_do -> worker_report -> supervisor_check

遵循当前工作流阶段。不要自行执行 Worker 任务。`
      : `## Loop Mode — Supervisor

You are the Supervisor for the active loop goal.

The WorkflowCoordinator owns execution order:
supervisor_analyse -> worker_do -> worker_report -> supervisor_check.

Follow the current workflow phase. Do not perform Worker tasks yourself.`
  }

  async *submit(userInput: string, agentConfig?: AgentConfig, role?: "worker" | "supervisor", mode?: WorkflowMode, workflowPhase?: WorkflowPhase): AsyncGenerator<LoopEvent> {
    // C1: Wait for context policy to load before proceeding
    await this.contextPolicyLoadPromise

    const diagnosticsEnabled = this.logger.isEnabled("error")
    const submitStartedAt = diagnosticsEnabled ? Date.now() : 0
    const submitId = diagnosticsEnabled ? randomUUID() : undefined
    const submitLogger = submitId ? this.logger.child({ submitId }) : this.logger
    this._interrupted = false
    this.delegatedEvents = []
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
    const activeSkillsPrompt = this.buildActiveSkillsPrompt()
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
        ? this.buildSupervisorLoopModePrompt(workflowPhase)
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
      sessionStrictness: this.sessionStrictness,
      projectConfig,
      modelName,
      modelProfile,
    })
    this.effectivePolicy = resolveEffectiveHarnessPolicy(strictness, source)
    // ADV-HAR-03: 根据 effectivePolicy.shellPolicy 重新注册 bash 工具
    if (this.effectivePolicy.shellPolicy === "dual-track" || this.effectivePolicy.shellPolicy === "dual-track-conservative") {
      const { createBashTool } = await import("@covalo/tools")
      this.tools.set("bash", createBashTool({
        dualTrack: true,
        conservative: this.effectivePolicy.shellPolicy === "dual-track-conservative",
      }))
    }

    // FIX-H5: 根据 effectivePolicy.checkpoint 设置 checkpoint 落盘频率
    this.checkpointEngine.setCheckpointPolicy(this.effectivePolicy.checkpoint)

    // ADV-HAR-05: 根据 effectivePolicy.readBeforeWrite 配置 ReadTracker
    if (this.effectivePolicy.readBeforeWrite === "block") {
      this.toolExecutor.setReadTracker(new ReadTracker({ strict: true }))
    } else if (this.effectivePolicy.readBeforeWrite === "warn") {
      this.toolExecutor.setReadTracker(new ReadTracker({ strict: false }))
    } else {
      this.toolExecutor.setReadTracker(undefined)
    }

    // F0-1: 根据 effectivePolicy 配置 governance 三件套
    // branchBudget: "enforce" → 启用 + 硬拦截；"recover" → 启用 + 仅记录；"observe" → 禁用
    const branchBudgetMode = this.effectivePolicy.branchBudget
    this.branchBudgetTracker.setEnabled(branchBudgetMode !== "observe")
    this.branchBudgetTracker.bindWorkspaceRoot(process.cwd())
    // checkpoint: "frequent" → 任何 trigger 都落盘；"safe-point" → safe point 落盘；"minimal" → 仅 tool_failed/final_draft
    // 由 CheckpointEngine.shouldPersistOnTrigger 内部根据 forcedPolicyActive 判定，这里只负责 loadV2 恢复
    // executionMode: "forced" → 强制 forced；"adaptive" → 自适应决策；"free" → 强制 free
    // ModeDecisionEngine 在 loop.ts 中每轮 evaluate；engine 层只需把 harnessMode 映射进去
    // F0-1/B4: 每次 submit 开始时尝试恢复 checkpoint，跨 submit 持久化真正生效。
    // 恢复的三维计数会延续到本 submit，不会被立即清空（不再调用 resetRoundBudget）。
    // recoverTriggers 也从快照恢复（跨 submit recovery 去重）。
    //
    // F0-1/B6-2: 仅在 adaptive 模式下向 ModeDecisionEngine 提交 checkpoint_resumed signal。
    // free/forced 模式下 loop.evaluateExecutionMode() 不调用 evaluate()，submitted signal
    // 不会被消费，会残留到下一次 submit 污染 mode decision。BranchBudget 快照恢复与 mode
    // signal 解耦——快照恢复对硬拦截/enforce 仍有意义，但 mode signal 只在 adaptive 下提交。
    const isAdaptiveMode = this.effectivePolicy.executionMode === "adaptive"
    try {
      const v2 = await this.checkpointEngine.loadV2()
      if (v2) {
        this.branchBudgetTracker.applySnapshot(v2.branchBudget)
        if (isAdaptiveMode) {
          this.modeDecisionEngine.submitSignal("checkpoint_engine", "checkpoint_resumed")
        } else {
          // 非 adaptive 模式下，pending recovery signals 直接标记为已消费，
          // 避免 engine 层恢复 checkpoint 后 signal 残留。
          this.checkpointEngine.markRecoverySignalsConsumed(() => true)
        }
        if (this.logger.isEnabled("info")) {
          this.logger.info("engine.checkpoint.resumed", { sessionId: this.sessionId, executionMode: this.effectivePolicy.executionMode })
        }
      }
    } catch (e) {
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("engine.checkpoint.resume_error", { error: e instanceof Error ? e.message : String(e) })
      }
    }

    this.verificationGateState = { continuationCount: 0 }
    this.supervisorGuidanceState = createSupervisorGuidanceState()

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
    this.sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: this.ctx.buildMessages() })
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
        registeredTools: this.tools,
        role: effectiveRole,
        mode: effectiveMode,
        agentToolNames: ac.toolNames,
        workflowPhase,
        config: maybeCovaloConfig,
      })
      // 识别自定义工具：不在任何内置类别中的工具名集合，
      // 用于在 two-stage-router 中放行 custom tool，而非直接 return true
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
          registeredCount: this.tools.size,
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

      const phaseMaxTurns = resolvePhaseMaxTurns(role, mode, workflowPhase, this.effectivePolicy?.maxTurns)

      const loopOpts: LoopOptions = {
        ctx: this.ctx,
        client: this.client,
        toolExecutor: this.toolExecutor,
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
        sessionWriter: this.sessionWriter,
        stats: this.stats,
        isInterrupted: () => this._interrupted,
        thinkingMode: this.thinkingMode,
        appendToolResult: (tc, result) => this.appendToolResult(tc, result),
        takePendingInstruction: () => {
          const content = this.pendingInstructionQueue.shift()
          if (!content) return null
          return { content, remaining: this.pendingInstructionQueue.length }
        },
        logger: submitLogger,
        submitId,
        taskLedger: this.taskLedger,
        // ADV-HAR-02: 使用 effectivePolicy 而不是 harnessProfile 的字段
        effectivePolicy: this.effectivePolicy ?? undefined,
        maxTurns: phaseMaxTurns,
        requireVerificationBeforeFinal:
          this.effectivePolicy?.verification === "block"
          || this.effectivePolicy?.verification === "require-or-waive",
        verificationGateState: this.verificationGateState,
        refreshLedgerContext: () => {
          this.injectTaskLedgerContext(this.taskLedger)
        },
        // ADV-HAR-06: 根据 effectivePolicy.earlyStop 配置 EarlyStopDetector
        earlyStop: new EarlyStopDetector({
          repetitionThreshold: this.effectivePolicy?.earlyStop === "aggressive" ? 2
            : this.effectivePolicy?.earlyStop === "critical-only" ? 5
            : 3,
        }),
        // ADV-HAR-07: 传递 toolRouting 策略供 loop 使用
        toolRouting: this.effectivePolicy?.toolRouting,
        // ADV-HAR-08: 传递 verification 策略供 loop 使用
        verificationPolicy: this.effectivePolicy?.verification,
        // F0-1: 传入 governance/checkpoint 三件套
        branchBudgetTracker: this.branchBudgetTracker,
        checkpointEngine: this.checkpointEngine,
        modeDecisionEngine: this.modeDecisionEngine,
        workspaceRoot: process.cwd(),
        allowedToolNames: effectiveMode === "loop"
          ? new Set(toolSpecs.map(spec => spec.function.name))
          : undefined,
        supervisorGuidance: this.effectivePolicy?.supervisorPolicy !== "off"
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
        customToolNames,
      }

      const loopIterator = runLoop(loopOpts)[Symbol.asyncIterator]()
      let nextLoopEvent = loopIterator.next()
      while (true) {
        while (this.delegatedEvents.length > 0) {
          yield this.delegatedEvents.shift()!
        }
        const delegatedWake = this.waitForDelegatedEvent()
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
      while (this.delegatedEvents.length > 0) {
        yield this.delegatedEvents.shift()!
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
      this.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: errEvt })
      const doneEvt: LoopEvent = {
        role: "done",
        metadata: { reason: "submit_error" } as Record<string, unknown>,
      }
      yield doneEvt
      this.sessionWriter?.enqueue({ ts: Date.now(), type: "event", payload: doneEvt })
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
    this.stats.toolCalls++
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
    const def = this.subagentRegistry.resolve(options.subagentType ?? "general-purpose")
    const workerId = `worker_${randomUUID().slice(0, 8)}`
    const workerStartedAt = Date.now()
    const emitWorkerEvent = (event: LoopEvent): void => {
      this.enqueueDelegatedEvent(event)
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
      ? (this.childClientFactory
          ? this.childClientFactory(resolvedTarget, this.logger.child({ delegate: true, subagentType: def.name }))
          : createClientForTarget(resolvedTarget, this.logger.child({ delegate: true, subagentType: def.name })))
      : this.client

    const child = new ReasonixEngine(
      childConfig,
      undefined,
      undefined,
      childClient,
      this.logger.child({ delegate: true, subagentType: def.name }),
    )
    this.activeChildEngines.add(child)

    // SPEC-C: 子引擎继承父引擎 contextPolicy
    await child.setContextPolicy(this.getContextPolicy())

    try {
      for (const tool of this.tools.values()) {
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
        toolNames: this.subagentRegistry.getEffectiveTools(def) ?? undefined,
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
        this.enqueueDelegatedEvent({
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
      this.activeChildEngines.delete(child)
      // Keep worker visible for a while so React can render final state
      // worker_remove will be emitted on next submit or session switch
      await child.shutdown()
    }
  }
}

// buildOmpContext removed: engine now talks directly to DeepSeek official API.
