import { randomUUID } from "node:crypto"
import type { AgentRole } from "../agent-profile/types.js"
import type { ChatMessage } from "../types.js"
import type { WorkflowLoopState, WorkflowCheckpoint } from "../workflow-coordinator/types.js"
import { SessionLoader, AsyncSessionWriter } from "../session.js"
import type { RuntimeLogger } from "../runtime-logger.js"
import { noopRuntimeLogger } from "../runtime-logger.js"
import type {
  DualSessionConfig,
  RoleSessionState,
  DualSessionSnapshot,
  AdviceHistoryEntry,
  SessionCheckpoint,
  DualSessionOptions,
} from "./types.js"
import { SESSION_VERSION } from "./types.js"

export interface DualSessionOptionsExtended extends DualSessionOptions {
  workerSystemPrompt?: string
  supervisorSystemPrompt?: string
  workerModelTarget?: string
  supervisorModelTarget?: string
  /** 用于写入 Session JSONL 的 writer（可选，不传则只读） */
  sessionWriter?: AsyncSessionWriter
  logger?: RuntimeLogger
}

/**
 * DualSession — 双角色 Session 管理器
 *
 * 使用现有 Session JSONL 作为存储后端，禁止保留独立第二套真相源。
 * 存储格式：
 * - dual-session: 双角色会话快照（worker/supervisor 消息、配置等）
 * - workflow-checkpoint: Workflow 检查点
 * - advice-history: Advice 采用历史（防止重复采用）
 */
export class DualSession {
  private config: DualSessionConfig
  private worker: RoleSessionState
  private supervisor: RoleSessionState
  private workflow?: WorkflowCheckpoint
  private adviceHistory: AdviceHistoryEntry[] = []
  private sessionWriter?: AsyncSessionWriter
  private logger: RuntimeLogger
  /** 已采用的 advice 键（workflowId:iteration），用于防止重复采用 */
  private adoptedAdviceKeys: Set<string> = new Set()
  /** 已执行的工具调用 ID，用于防止重复执行（上限 5000 防止内存泄漏） */
  private executedToolCallIds: Set<string> = new Set()
  private static readonly MAX_EXECUTED_TOOL_CALL_IDS = 5000

  constructor(options: DualSessionOptionsExtended = {}) {
    const sessionId = options.sessionId ?? randomUUID()
    const workerSessionId = options.workerSessionId ?? randomUUID()
    const supervisorSessionId = options.supervisorSessionId ?? randomUUID()

    this.config = {
      sessionId,
      workerSessionId,
      supervisorSessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.worker = {
      role: "worker",
      agentSessionId: workerSessionId,
      messages: [],
      systemPrompt: options.workerSystemPrompt ?? "",
      thinkingMode: "high",
      modelTarget: options.workerModelTarget ?? "zen/mimo-v2.5-free",
      stats: {
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        apiCalls: 0,
        toolCalls: 0,
        totalCost: 0,
      },
    }

    this.supervisor = {
      role: "supervisor",
      agentSessionId: supervisorSessionId,
      messages: [],
      systemPrompt: options.supervisorSystemPrompt ?? "",
      thinkingMode: "off",
      modelTarget: options.supervisorModelTarget ?? "zen/mimo-v2.5-free",
      stats: {
        promptTokens: 0,
        completionTokens: 0,
        cacheHitTokens: 0,
        cacheMissTokens: 0,
        apiCalls: 0,
        toolCalls: 0,
        totalCost: 0,
      },
    }

    this.sessionWriter = options.sessionWriter
    this.logger = options.logger ?? noopRuntimeLogger
  }

  getConfig(): DualSessionConfig {
    return { ...this.config }
  }

  getSessionId(): string {
    return this.config.sessionId
  }

  getWorkerSessionId(): string {
    return this.config.workerSessionId
  }

  getSupervisorSessionId(): string {
    return this.config.supervisorSessionId
  }

  getRoleState(role: AgentRole): RoleSessionState {
    return role === "worker" ? { ...this.worker } : { ...this.supervisor }
  }

  addMessage(role: AgentRole, message: ChatMessage): void {
    const session = role === "worker" ? this.worker : this.supervisor
    session.messages.push(message)
    this.config.updatedAt = Date.now()
    this.persist()
  }

  getMessages(role: AgentRole): ChatMessage[] {
    const session = role === "worker" ? this.worker : this.supervisor
    return [...session.messages]
  }

  setSystemPrompt(role: AgentRole, prompt: string): void {
    const session = role === "worker" ? this.worker : this.supervisor
    session.systemPrompt = prompt
    this.config.updatedAt = Date.now()
    this.persist()
  }

  setThinkingMode(role: AgentRole, mode: "off" | "open" | "high"): void {
    const session = role === "worker" ? this.worker : this.supervisor
    session.thinkingMode = mode
    this.config.updatedAt = Date.now()
    this.persist()
  }

  setModelTarget(role: AgentRole, target: string): void {
    const session = role === "worker" ? this.worker : this.supervisor
    session.modelTarget = target
    this.config.updatedAt = Date.now()
    this.persist()
  }

  updateStats(role: AgentRole, stats: Partial<RoleSessionState["stats"]>): void {
    const session = role === "worker" ? this.worker : this.supervisor
    session.stats = { ...session.stats, ...stats }
    this.config.updatedAt = Date.now()
    this.persist()
  }

  setWorkflowCheckpoint(checkpoint: WorkflowCheckpoint): void {
    this.workflow = checkpoint
    this.config.updatedAt = Date.now()
    this.persistWorkflow()
  }

  getWorkflowCheckpoint(): WorkflowCheckpoint | undefined {
    return this.workflow ? { ...this.workflow } : undefined
  }

  addAdviceHistory(entry: AdviceHistoryEntry): void {
    this.adviceHistory.push(entry)
    // 更新已采用 advice 键集合
    if (entry.adopted) {
      this.adoptedAdviceKeys.add(`${entry.workflowId}:${entry.iteration}`)
    }
    this.config.updatedAt = Date.now()
    this.persistAdviceHistory()
  }

  getAdviceHistory(): AdviceHistoryEntry[] {
    return [...this.adviceHistory]
  }

  isAdviceAdopted(workflowId: string, iteration: number): boolean {
    return this.adoptedAdviceKeys.has(`${workflowId}:${iteration}`)
  }

  /**
   * 检查 advice 是否可以采用（防止重复采用）
   */
  canAdoptAdvice(workflowId: string, iteration: number): boolean {
    return !this.isAdviceAdopted(workflowId, iteration)
  }

  /**
   * 记录工具调用 ID（防止重复执行）。
   * 达到上限时驱逐最旧的条目（Set 迭代顺序即插入顺序）。
   */
  recordToolCallExecution(toolCallId: string): void {
    // Evict oldest entries when at capacity
    if (this.executedToolCallIds.size >= DualSession.MAX_EXECUTED_TOOL_CALL_IDS) {
      const entries = [...this.executedToolCallIds]
      const toRemove = entries.slice(0, Math.floor(DualSession.MAX_EXECUTED_TOOL_CALL_IDS / 4))
      for (const id of toRemove) {
        this.executedToolCallIds.delete(id)
      }
    }
    this.executedToolCallIds.add(toolCallId)
  }

  /**
   * 检查工具调用是否已执行（防止重复执行）
   */
  isToolCallExecuted(toolCallId: string): boolean {
    return this.executedToolCallIds.has(toolCallId)
  }

  /**
   * 持久化双角色会话快照到 Session JSONL
   */
  private persist(): void {
    if (!this.sessionWriter) return
    const snapshot = this.toSnapshot()
    this.sessionWriter.enqueue({
      ts: Date.now(),
      type: "dual-session",
      payload: snapshot,
    })
  }

  /**
   * 持久化 Workflow 检查点
   */
  private persistWorkflow(): void {
    if (!this.sessionWriter || !this.workflow) return
    this.sessionWriter.enqueue({
      ts: Date.now(),
      type: "workflow-checkpoint",
      payload: this.workflow,
    })
  }

  /**
   * 持久化 Advice 采用历史
   */
  private persistAdviceHistory(): void {
    if (!this.sessionWriter) return
    this.sessionWriter.enqueue({
      ts: Date.now(),
      type: "advice-history",
      payload: this.adviceHistory,
    })
  }

  /**
   * 强制刷新所有待写入的数据
   */
  async flush(): Promise<void> {
    if (!this.sessionWriter) return
    // 写入最终快照
    this.persist()
    this.persistWorkflow()
    this.persistAdviceHistory()
    // 等待 writer 刷盘
    await this.sessionWriter.drain()
  }

  toSnapshot(): DualSessionSnapshot {
    return {
      config: { ...this.config },
      worker: { ...this.worker },
      supervisor: { ...this.supervisor },
      workflow: this.workflow ? { ...this.workflow } : undefined,
      adviceHistory: [...this.adviceHistory],
    }
  }

  static fromSnapshot(snapshot: DualSessionSnapshot): DualSession {
    const session = new DualSession({
      sessionId: snapshot.config.sessionId,
      workerSessionId: snapshot.config.workerSessionId,
      supervisorSessionId: snapshot.config.supervisorSessionId,
    })

    session.worker = { ...snapshot.worker }
    session.supervisor = { ...snapshot.supervisor }
    session.workflow = snapshot.workflow ? { ...snapshot.workflow } : undefined
    session.adviceHistory = [...snapshot.adviceHistory]
    session.config = { ...snapshot.config }

    // 重建已采用 advice 键集合
    for (const entry of session.adviceHistory) {
      if (entry.adopted) {
        session.adoptedAdviceKeys.add(`${entry.workflowId}:${entry.iteration}`)
      }
    }

    return session
  }

  /**
   * 从 Session JSONL 恢复 DualSession
   */
  static async load(sessionId: string, logger?: RuntimeLogger): Promise<DualSession | null> {
    const result = await SessionLoader.readDualSession(sessionId)
    if (result.status !== "ok" || !result.snapshot) {
      return null
    }

    const session = DualSession.fromSnapshot(result.snapshot)
    if (result.workflowCheckpoint) {
      session.workflow = result.workflowCheckpoint
    }
    if (result.adviceHistory) {
      session.adviceHistory = result.adviceHistory
      // 重建已采用 advice 键集合
      for (const entry of session.adviceHistory) {
        if (entry.adopted) {
          session.adoptedAdviceKeys.add(`${entry.workflowId}:${entry.iteration}`)
        }
      }
    }

    if (logger) {
      session.logger = logger
    }

    return session
  }

  toCheckpoint(): SessionCheckpoint {
    return {
      dualSessionId: this.config.sessionId,
      snapshot: this.toSnapshot(),
      savedAt: Date.now(),
      version: SESSION_VERSION,
    }
  }

  static fromCheckpoint(checkpoint: SessionCheckpoint): DualSession {
    return DualSession.fromSnapshot(checkpoint.snapshot)
  }
}
