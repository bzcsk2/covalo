import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { DeepicodeConfig } from "./config.js"
import { ContextManager } from "./context/manager.js"
import type { ToolCall, ToolSpec, ChatMessage } from "./types.js"
import type { CoreEngine, AgentConfig, AgentTool, LoopEvent, AgentState, SessionStats, ToolResult, EnqueueInstructionResult, ChatClient } from "./interface.js"
import { DeepSeekClient } from "./client.js"
import { FreeAutoClient } from "./free-auto/client.js"
import { StreamingToolExecutor } from "./streaming-executor.js"
import { AsyncSessionWriter, SessionLoader } from "./session.js"
import { runLoop } from "./loop.js"
import type { LoopOptions } from "./loop.js"
import { PermissionEngine, HookManager } from "@deepicode/security"
import { getAgent, agentConfigFor, getMainMode } from "./agent.js"
import { SubagentRegistry, checkSubagentPermission } from "./subagent/index.js"
import type { SubagentRunOptions, SubagentRunResult, SubagentDefinition } from "./subagent/index.js"
import { createModeSelectorState } from "./mode-selector.js"
import type { ModeSelectorState } from "./mode-selector.js"
import type { ThinkingMode } from "./provider-thinking.js"
import { createModeStats, getModeSummary } from "./mode-stats.js"
import type { ModeStats } from "./mode-stats.js"
import { createRuntimeLoggerFromEnv, type RuntimeLogger } from "./runtime-logger.js"
import type { ResultPersistenceConfig } from "./result-persistence.js"
import { getTier, type StrategyTier } from "./strategy/tiers.js"
import type { EngineStatusSnapshot } from "./status.js"
import type { ContextReductionMode, ContextReductionResult } from "./context/manager.js"
import type { ContextPolicy } from "./context/policy.js"
import { validateContextPolicy, mergeContextPolicy, DEFAULT_CONTEXT_POLICY } from "./context/policy.js"
import { ContextPolicyStore } from "./context/policy-store.js"
import type { ContextSummarizer } from "./context/summarizer.js"
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
 * ReasonixEngine 是 Deepicode 的核心引擎，负责：
 * - 管理对话上下文（ContextManager）
 * - 与 DeepSeek API 进行流式通信
 * - 执行工具调用（tool calling）
 * - 记录会话统计信息和持久化
 *
 * 整个驱动循环（submit 方法）是一个状态机：
 *   用户输入 → API 流式响应 → 工具调用（可选）→ 继续循环 → 最终输出
 */
export class ReasonixEngine implements CoreEngine {
  /** Deepicode 全局配置 */
  private config: DeepicodeConfig
  /** 上下文管理器，负责维护消息历史和 system prompt */
  private ctx: ContextManager
  /** 注册的工具集合，key 为工具名 */
  private tools: Map<string, AgentTool> = new Map()
  /** LLM 客户端（普通 provider 用 DeepSeekClient，free-auto 用 FreeAutoClient） */
  private client: ChatClient
  /** Free Auto 客户端实例（需要 reset sticky 状态） */
  private freeAutoClient?: FreeAutoClient
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

  /** prefix.build 缓存：避免每次 submit 重复重建（P3-4-2） */
  private prefixCacheKey = ""

  /** exec 工具权限确认：pending Promise 由 TUI 响应 resolve */
  private pendingPermission: { resolve: (v: boolean) => void; toolName: string; args: Record<string, unknown> } | null = null

  /** LIFE-01: shutdown flag for idempotent cleanup */
  private _shutDown = false

  /** AS3: Thinking mode selector state */
  private modeSelectorState: ModeSelectorState = createModeSelectorState()

  /** AS6: Thinking mode statistics */
  private modeStats: ModeStats = createModeStats()

  /** ST2: Current strategy tier */
  private currentTier: StrategyTier = getTier("normal")

  /** 当前会话启用的技能内容，会附加到 system prompt */
  private activeSkills: Array<{ name: string; description: string; content: string }> = []

  private contextPolicy: ContextPolicy = { ...DEFAULT_CONTEXT_POLICY }

  /** Context policy store for persistence */
  private policyStore: ContextPolicyStore
  private contextPolicyLoadPromise: Promise<void> = Promise.resolve()

  /** ST2: Pending tier decision from TUI */
  private pendingTierDecision: { resolve: (v: boolean) => void; tier: string } | null = null

  /** Subagent registry for resolving subagent definitions */
  private subagentRegistry: SubagentRegistry

  /** AS3: Set thinking mode for auto-switch */
  setThinkingMode(mode: ThinkingMode): void {
    this.modeSelectorState.currentMode = mode
  }

  /** AS3: Get current thinking mode */
  getThinkingMode(): ThinkingMode {
    return this.modeSelectorState.currentMode
  }

  /** Get context window size */
  getContextWindow(): number {
    return this.ctx.getContextWindow()
  }

  /** AS6: Get thinking mode statistics summary */
  getModeSummary(): string {
    return getModeSummary(this.modeStats)
  }

  /** P2: Mid-session instruction queue — consumed by loop at safe points */
  private pendingInstructionQueue: string[] = []
  private isSubmitting = false
  private static readonly MAX_PENDING_INSTRUCTIONS = 10

  /** 流式执行器内部调用，等待 TUI 返回确认结果 */
  private requestPermission = async (toolName: string, args: Record<string, unknown>): Promise<boolean> => {
    return new Promise(resolve => { this.pendingPermission = { resolve, toolName, args } })
  }

  /** TUI 调用以响应权限确认提示 */
  respondPermission(allow: boolean, alwaysAllow?: boolean): void {
    if (this.pendingPermission) {
      if (allow && alwaysAllow) {
        this.permissionEngine.addAllowRule({ toolName: this.pendingPermission.toolName })
      }
      this.pendingPermission.resolve(allow)
      this.pendingPermission = null
    }
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

  constructor(config: DeepicodeConfig, onStart?: () => void, sessionId?: string, customClient?: ChatClient, runtimeLogger?: RuntimeLogger) {
    this.config = config
    this.ctx = new ContextManager(config.maxContextRounds, config.contextWindow)
    this.sessionId = sessionId ?? randomUUID()
    this.logger = runtimeLogger ?? createRuntimeLoggerFromEnv({ sessionId: this.sessionId })
    this.freeAutoClient = undefined
    this.client = this.resolveClient(customClient)
    this.currentAgent = "build"
    this.permissionEngine = new PermissionEngine()
    this.hookManager = new HookManager()
    this.subagentRegistry = new SubagentRegistry()
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
    if (this.logger.isEnabled()) this.logger.info("engine.created", { provider: config.provider, model: config.model })
  }

  static async recover(config: DeepicodeConfig, sessionId: string): Promise<ReasonixEngine> {
    if (!SessionLoader.validateSessionId(sessionId)) {
      throw new Error(`Invalid session ID for recover: ${sessionId}`)
    }
    const engine = new ReasonixEngine(config, undefined, sessionId)
    await engine._loadSessionMessages(sessionId)
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
    this.sessionId = sessionId
    this.ctx.log.clear()
    this.toolExecutor.setSessionId(sessionId)
    this.logger = this.logger.child({ sessionId })
    this.rebindSessionWriter(sessionId)
    return this._loadSessionMessages(sessionId)
  }

  private rebindSessionWriter(sessionId: string): void {
    const sessionPath = resolve(process.cwd(), ".deepicode", "sessions", `${sessionId}.jsonl`)
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

  async getStatusSnapshot(): Promise<EngineStatusSnapshot> {
    const budget = await this.ctx.getBudget()
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
      timestamp: new Date().toISOString(),
    }
  }

  /** 设置系统级 system prompt */
  setSystemPrompt(prompt: string): void {
    this.ctx.prefix.build(prompt)
  }

  /** 更新当前会话启用的技能列表 */
  setActiveSkills(skills: Array<{ name: string; description: string; content: string }>): void {
    this.activeSkills = skills.map(skill => ({
      name: skill.name,
      description: skill.description,
      content: skill.content,
    }))
  }

  /** 获取当前会话启用的技能列表 */
  getActiveSkills(): Array<{ name: string; description: string; content: string }> {
    return this.activeSkills.map(skill => ({ ...skill }))
  }

  private buildActiveSkillsPrompt(): string {
    if (this.activeSkills.length === 0) return ""
    const blocks = this.activeSkills.map(skill => [
      `### ${skill.name}`,
      skill.description,
      skill.content.trim(),
    ].filter(Boolean).join("\n"))
    return [
      "## Enabled Skills",
      "The following skills are enabled for this session. Use them as guidance when relevant.",
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
    const budget = await this.ctx.getBudget()
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

  /** 标记中断，终止当前正在进行的请求和工具执行 */
  interrupt(): void {
    if (this.logger.isEnabled()) this.logger.info("engine.interrupt", { isSubmitting: this.isSubmitting })
    this._interrupted = true
    this.pendingInstructionQueue = []
    this.activeAbortController?.abort()
  }

  /** LIFE-01: 幂等的显式关闭入口。重复调用安全，部分初始化失败也安全。 */
  async shutdown(): Promise<void> {
    if (this._shutDown) return
    this._shutDown = true
    if (this.logger.isEnabled("info")) this.logger.info("engine.shutdown.start", { sessionId: this.sessionId })

    try {
      this.interrupt()
    } catch {
      // ignore
    }

    try {
      await this.ctx.shutdown()
    } catch {
      // ignore
    }

    try {
      await this.sessionWriter?.drain()
    } catch {
      // best-effort: don't let session flush block exit
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
    const baseClient = new DeepSeekClient(this.logger)
    if (this.config.provider === "free-auto") {
      const fa = new FreeAutoClient(baseClient)
      this.freeAutoClient = fa
      return fa
    }
    return baseClient
  }

  /** 运行时更新引擎配置（用于 /model 命令切换 Provider） */
  updateConfig(partial: Partial<DeepicodeConfig>): void {
    const providerChanged = partial.provider !== undefined && partial.provider !== this.config.provider
    Object.assign(this.config, partial)
    if (partial.contextWindow !== undefined) {
      this.ctx.updateContextWindow(partial.contextWindow)
    }
    // Re-resolve client when provider changes (e.g. switching to/from free-auto)
    if (providerChanged) {
      this.freeAutoClient = undefined
      this.client = this.resolveClient()
    }
  }

  /** 切换 agent，返回 agent label */
  switchAgent(agentName: string): string {
    const def = getAgent(agentName)
    this.currentAgent = def.name
    return def.label
  }

  /** ST2: Process tier decision from UI — sets current tier */
  resolveTierDecision(tier: string): void {
    const resolved = getTier(tier)
    this.currentTier = resolved
    if (this.logger.isEnabled("info")) {
      this.logger.info("tier.resolved", { tier: resolved.id, label: resolved.label })
    }
  }

  /** 获取当前 agent 名称 */
  getAgentName(): string {
    return this.currentAgent
  }

  /** ST2: Get current strategy tier */
  getTier(): StrategyTier {
    return this.currentTier
  }

  /** ST2: Set strategy tier */
  setTier(tierId: string): void {
    this.currentTier = getTier(tierId)
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

  async *submit(userInput: string, agentConfig?: AgentConfig): AsyncGenerator<LoopEvent> {
    const diagnosticsEnabled = this.logger.isEnabled("error")
    const submitStartedAt = diagnosticsEnabled ? Date.now() : 0
    const submitId = diagnosticsEnabled ? randomUUID() : undefined
    const submitLogger = submitId ? this.logger.child({ submitId }) : this.logger
    this._interrupted = false
    this.isSubmitting = true
    const abortController = new AbortController()
    this.activeAbortController = abortController

    // 合并 agent 配置：优先使用传入的 agentConfig，否则用当前 agent 的默认配置
    const ac = agentConfig ?? agentConfigFor(this.currentAgent)
    const baseSystemPrompt = ac.systemPrompt ?? this.ctx.prefix.messages[0]?.content ?? ""
    const activeSkillsPrompt = this.buildActiveSkillsPrompt()
    const systemPrompt = [baseSystemPrompt, activeSkillsPrompt].filter(Boolean).join("\n\n")
    this.ctx.prefix.build(systemPrompt)

    this.ctx.startTurn()
    this.ctx.log.append({ role: "user", content: userInput })
    const budget = await this.ctx.getBudget()
    if (budget.ratio >= this.contextPolicy.triggerRatio) {
      let result
      if (this.contextPolicy.mode === "compact") {
        const targetTokens = Math.floor(budget.window * this.contextPolicy.targetRatio)
        const success = await this.ctx.runSummarize(targetTokens, abortController.signal)
        if (success) {
          result = this.ctx.reduceToTarget("trim", this.contextPolicy.targetRatio)
          if (this.logger.isEnabled("info")) {
            this.logger.info("context.reduction.compact.success", { ...result })
          }
        } else {
          result = this.ctx.reduceToTarget("trim", this.contextPolicy.targetRatio)
          if (this.logger.isEnabled("info")) {
            this.logger.info("context.reduction.compact.fallback", { ...result })
          }
        }
      } else {
        result = this.ctx.reduceToTarget("trim", this.contextPolicy.targetRatio)
        if (this.logger.isEnabled("info")) {
          this.logger.info("context.reduction.trim", { ...result })
        }
      }
    }
    this.sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: this.ctx.buildMessages() })
    if (diagnosticsEnabled) submitLogger.info("submit.start", { agent: this.currentAgent, inputLength: userInput.length })

    try {
      // ST3: Notify current tier at submit start
      yield { role: "strategy_notify", content: this.currentTier.id, metadata: { tier: this.currentTier } }

      const toolSpecs: ToolSpec[] = []
      for (const tool of this.tools.values()) {
        if (ac.toolNames && !ac.toolNames.includes(tool.name)) continue
        toolSpecs.push({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          },
        })
      }

      const toolSpecsKey = JSON.stringify([...toolSpecs].sort((a, b) => a.function.name.localeCompare(b.function.name)))
      const skillsKey = JSON.stringify(this.activeSkills.map(skill => ({ name: skill.name, description: skill.description, content: skill.content })))
      const cacheKey = `${systemPrompt}|${toolSpecsKey}|${skillsKey}`
      if (cacheKey !== this.prefixCacheKey) {
        this.ctx.prefix.build(systemPrompt, toolSpecs)
        this.prefixCacheKey = cacheKey
      }

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
        appendToolResult: (tc, result) => this.appendToolResult(tc, result),
        takePendingInstruction: () => {
          const content = this.pendingInstructionQueue.shift()
          if (!content) return null
          return { content, remaining: this.pendingInstructionQueue.length }
        },
        thinkingMode: this.modeSelectorState.currentMode,
        modeSelectorState: this.modeSelectorState,
        modeStats: this.modeStats,
        logger: submitLogger,
        submitId,
        tier: this.currentTier,
      }

      for await (const event of runLoop(loopOpts)) {
        yield event
        // P5: Use .catch() for async hook — sync try/catch cannot catch Promise rejections
        void this.hookManager.runOnLoopEvent(event as unknown as Record<string, unknown>).catch(() => {})
      }
    } finally {
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

  private async delegateTask(task: string, agentType: "build" | "plan", files: string[]): Promise<string> {
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

    const child = new ReasonixEngine(
      this.config,
      undefined,
      undefined,
      this.client,
      this.logger.child({ delegate: true, subagentType: def.name }),
    )

    try {
      for (const tool of this.tools.values()) {
        if (tool.name === "AgentTool") continue
        if (def.disallowedTools?.includes(tool.name)) continue
        if (def.tools && def.tools[0] !== "*" && !def.tools.includes(tool.name)) continue

        child.registerTool(tool)

        const perm = checkSubagentPermission(tool.name, def.permissionMode)
        if (!perm.allowed) {
          child.permissionEngine.addDenyRule({
            toolName: tool.name,
            reason: perm.reason ?? `Denied by subagent permission mode: ${def.permissionMode}`,
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
        systemPrompt: def.systemPrompt,
        toolNames: this.subagentRegistry.getEffectiveTools(def) ?? undefined,
        model: typeof options.model === "string" && options.model !== "inherit" ? options.model : undefined,
      })

      let output = ""
      const warnings: string[] = []
      let usage = { promptTokens: 0, completionTokens: 0 }

      for await (const event of child.submit(options.prompt, agentCfg)) {
        if (event.role === "assistant_delta") output += event.content ?? ""
        if (event.role === "usage" && event.metadata) {
          usage = {
            promptTokens: (event.metadata.promptTokens as number) ?? 0,
            completionTokens: (event.metadata.completionTokens as number) ?? 0,
          }
        }
        if (event.role === "error") {
          warnings.push(event.content ?? "unknown error")
        }
      }

      return {
        status: "completed",
        id: `subagent_${randomUUID().slice(0, 8)}`,
        subagent_type: def.name,
        description: options.description,
        result: output.trim(),
        files: options.files ?? [],
        usage,
        warnings,
      }
    } finally {
      await child.shutdown()
    }
  }
}

// buildOmpContext removed: engine now talks directly to DeepSeek official API.
