import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import type { DeepicodeConfig } from "./config.js"
import { ContextManager } from "./context/manager.js"
import type { ToolCall, ToolSpec, ChatMessage } from "./types.js"
import type { CoreEngine, AgentConfig, AgentTool, LoopEvent, AgentState, SessionStats, ToolResult, EnqueueInstructionResult } from "./interface.js"
import { DeepSeekClient } from "./client.js"
import { StreamingToolExecutor } from "./streaming-executor.js"
import { AsyncSessionWriter, SessionLoader } from "./session.js"
import { runLoop } from "./loop.js"
import type { LoopOptions } from "./loop.js"
import { PermissionEngine, HookManager } from "@deepicode/security"
import { getAgent, agentConfigFor } from "./agent.js"
import { createModeSelectorState } from "./mode-selector.js"
import type { ModeSelectorState } from "./mode-selector.js"
import type { ThinkingMode } from "./provider-thinking.js"
import { createModeStats, getModeSummary } from "./mode-stats.js"
import type { ModeStats } from "./mode-stats.js"

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
  /** DeepSeek API 客户端 */
  private client: DeepSeekClient
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

  /** AS3: Thinking mode selector state */
  private modeSelectorState: ModeSelectorState = createModeSelectorState()

  /** AS6: Thinking mode statistics */
  private modeStats: ModeStats = createModeStats()

  /** AS3: Set thinking mode for auto-switch */
  setThinkingMode(mode: ThinkingMode): void {
    this.modeSelectorState.currentMode = mode
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

  constructor(config: DeepicodeConfig, onStart?: () => void, sessionId?: string, customClient?: DeepSeekClient) {
    this.config = config
    this.ctx = new ContextManager(config.maxContextRounds, config.contextWindow)
    this.client = customClient ?? new DeepSeekClient()
    this.sessionId = sessionId ?? randomUUID()
    this.currentAgent = "build"
    this.permissionEngine = new PermissionEngine()
    this.hookManager = new HookManager()
    this.toolExecutor = new StreamingToolExecutor(
      this.tools,
      this.sessionId,
      undefined,
      this.permissionEngine,
      this.hookManager,
      this.requestPermission,
      (task, agentType, files) => this.delegateTask(task, agentType, files),
      (name) => this.switchAgent(name),
    )
    this.onStart = onStart
    this.onStart?.()

    // 尝试初始化会话持久化（best-effort，失败则不记录）
    const sessionPath = resolve(process.cwd(), ".deepicode", "sessions", `${this.sessionId}.jsonl`)
    const writer = new AsyncSessionWriter(sessionPath)
    writer.init().catch(() => {})
    this.sessionWriter = writer
  }

  static async recover(config: DeepicodeConfig, sessionId: string): Promise<ReasonixEngine> {
    const engine = new ReasonixEngine(config, undefined, sessionId)
    await engine._loadSessionMessages(sessionId)
    return engine
  }

  /** 加载指定 session 的历史消息到当前引擎上下文 */
  async loadSession(sessionId: string): Promise<ChatMessage[]> {
    this.sessionId = sessionId
    this.ctx.log.clear()
    return this._loadSessionMessages(sessionId)
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

  /** 设置系统级 system prompt */
  setSystemPrompt(prompt: string): void {
    this.ctx.prefix.build(prompt)
  }

  /** 获取上下文管理器实例 */
  getContextManager(): ContextManager {
    return this.ctx
  }

  /** 注册一个工具到引擎 */
  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  /** 标记中断，终止当前正在进行的请求和工具执行 */
  interrupt(): void {
    this._interrupted = true
    this.pendingInstructionQueue = []
    this.activeAbortController?.abort()
  }

  /** 运行时更新引擎配置（用于 /model 命令切换 Provider） */
  updateConfig(partial: Partial<DeepicodeConfig>): void {
    Object.assign(this.config, partial)
    if (partial.contextWindow !== undefined) {
      this.ctx.updateContextWindow(partial.contextWindow)
    }
  }

  /** 切换 agent，返回 agent label */
  switchAgent(agentName: string): string {
    const def = getAgent(agentName)
    this.currentAgent = def.name
    return def.label
  }

  /** 处理 tier 决策（由权限引擎发起，外部 UI 通过此方法响应） */
  resolveTierDecision(_tier: string): void {
    // 由外部 UI（如 TUI）覆盖此方法的实现来提供交互式批准
  }

  /** 获取当前 agent 名称 */
  getAgentName(): string {
    return this.currentAgent
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
    this._interrupted = false
    this.isSubmitting = true
    const abortController = new AbortController()
    this.activeAbortController = abortController

    // 合并 agent 配置：优先使用传入的 agentConfig，否则用当前 agent 的默认配置
    const ac = agentConfig ?? agentConfigFor(this.currentAgent)
    const systemPrompt = ac.systemPrompt ?? this.ctx.prefix.messages[0]?.content ?? ""
    this.ctx.prefix.build(systemPrompt)

    this.ctx.startTurn()
    this.ctx.log.append({ role: "user", content: userInput })
    this.sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: this.ctx.buildMessages() })

    try {
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
      const cacheKey = `${systemPrompt}|${toolSpecsKey}`
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
      }

      for await (const event of runLoop(loopOpts)) {
        yield event
        // P5: Use .catch() for async hook — sync try/catch cannot catch Promise rejections
        void this.hookManager.runOnLoopEvent(event as unknown as Record<string, unknown>).catch(() => {})
      }
    } finally {
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
    const child = new ReasonixEngine(this.config)
    for (const tool of this.tools.values()) {
      if (tool.name === "AgentTool") continue
      child.registerTool(tool)
      if (tool.approval === "exec") {
        child.permissionEngine.addDenyRule({
          toolName: tool.name,
          reason: `Background sub-agent cannot run exec tool without an interactive confirmation channel: ${tool.name}`,
        })
      }
    }

    const fileContext = files.length > 0
      ? `\nRelevant files:\n${files.map(file => `- ${file}`).join("\n")}`
      : ""
    let output = ""
    for await (const event of child.submit(`${task}${fileContext}`, agentConfigFor(agentType))) {
      if (event.role === "assistant_delta") output += event.content ?? ""
      if (event.role === "error") output += `\n[error] ${event.content ?? "unknown error"}`
    }
    return output.trim()
  }
}

// buildOmpContext removed: engine now talks directly to DeepSeek official API.
