import type { ChatMessage, ToolSpec, Usage } from "./types.js"
import type { DeepSeekStreamEvent, DeepSeekClientOptions } from "./client.js"
import type { QuestionInfo, QuestionAnswer } from "./question/types.js"
import type { SandboxProvider } from "./sandbox/types.js"
import type { WorkflowMode } from "./dual-agent-runtime/types.js"
import type { WorkflowPhase } from "./workflow-coordinator/types.js"
import type { ThinkingMode } from "./provider-thinking.js"

/* ── LoopEvent — core yields these, shell consumes them ── */

export type LoopEventRole =
  | "assistant_delta"
  | "assistant_final"
  | "reasoning_delta"
  | "tool_call_delta"
  | "tool_start"
  | "tool"
  | "warning"
  | "error"
  | "status"
  | "done"
  | "tool_progress"
  | "usage"
  | "permission_ask"
  | "question_ask"
  | "question_replied"
  | "question_rejected"
  // TUI-OT-60: 多 Agent 编排事件（结构化状态同步）
  | "orchestration"

export interface LoopEvent {
  role: LoopEventRole
  content?: string
  toolName?: string
  toolCallIndex?: number
  toolCallId?: string
  severity?: "info" | "warning" | "error"
  metadata?: Record<string, unknown>
  // TUI-OT-60: orchestration 事件时携带结构化数据
  orchestration?: OrchestrationEventPayload
}

/* ── OrchestrationEvent — TUI-OT-60 多 Agent 编排可视化 ── */

export type OrchestrationKind =
  | "worker_upsert"      // Worker 创建或更新
  | "worker_remove"      // Worker 移除
  | "supervisor_upsert"  // Supervisor 创建或更新
  | "supervisor_advice"  // Supervisor 给出建议
  | "loop_transition"    // Loop 阶段转换
  | "runtime_signal"     // 运行时信号
  | "agent_tree_upsert"  // Agent 树节点更新
  | "checkpoint"         // Checkpoint 保存

export interface WorkerSnapshot {
  id: string
  modelTarget: string
  status: "queued" | "starting" | "running" | "waiting_permission" | "waiting_question" | "waiting_supervisor" | "verifying" | "paused" | "completed" | "failed" | "cancelled" | "idle"
  currentTask?: string
  elapsedMs: number
  parentAgentId?: string
}

export interface SupervisorSnapshot {
  id: string
  modelTarget: string
  status: "disabled" | "idle" | "queued" | "reviewing" | "cooldown" | "unavailable" | "error"
  reviewingWorkerId?: string
  cooldownRemainingMs?: number
}

export interface LoopTransition {
  from: "observe" | "plan" | "act" | "verify" | "reflect" | "retry" | "paused" | "done" | "failed"
  to: "observe" | "plan" | "act" | "verify" | "reflect" | "retry" | "paused" | "done" | "failed"
  attempt: number
  timestamp: number
}

export interface RuntimeSignal {
  kind: "no-progress" | "repeated-error" | "verification-failed" | "checkpoint-saved"
  message?: string
}

export interface AgentTreeNode {
  id: string
  kind: "main" | "worker" | "supervisor" | "subagent"
  label: string
  status: string
  parentId?: string
}

export interface CheckpointSnapshot {
  runId: string
  savedAt: number
}

export type OrchestrationEventPayload =
  | { kind: "worker_upsert"; worker: WorkerSnapshot }
  | { kind: "worker_remove"; workerId: string }
  | { kind: "supervisor_upsert"; supervisor: SupervisorSnapshot }
  | { kind: "supervisor_advice"; supervisorId: string; workerId: string; advice: string; adopted: boolean }
  | { kind: "loop_transition"; transition: LoopTransition }
  | { kind: "runtime_signal"; signal: RuntimeSignal }
  | { kind: "agent_tree_upsert"; node: AgentTreeNode }
  | { kind: "checkpoint"; checkpoint: CheckpointSnapshot }

/* ── Permission tiers ── */

export type ToolTier = "read" | "write" | "exec"

/* ── AgentTool — every tool must implement this ── */

export type ToolConcurrency = "shared" | "exclusive"

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  concurrency: ToolConcurrency
  approval: ToolTier
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}

/* ── Tool execution context ── */

export interface ToolContext {
  cwd: string
  sessionId: string
  sandboxProvider?: SandboxProvider
  signal?: AbortSignal
  reportProgress?: (update: ToolProgressUpdate) => void
  invokeTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  delegateTask?: (task: string, agentType: string, files: string[]) => Promise<string>
  switchAgent?: (name: string) => string
  spawnSubagent?: (options: SubagentRunOptions) => Promise<SubagentRunResult>
  askUser?: (questions: QuestionInfo[]) => Promise<QuestionAnswer[]>
}

import type { SubagentRunOptions, SubagentRunResult } from "./subagent/types.js"

export interface ToolProgressUpdate {
  content: string
  toolName?: string
  metadata?: Record<string, unknown>
}

export interface ToolResult {
  content: string
  isError: boolean
  metadata?: Record<string, unknown>
}

/* ── AgentState — snapshot of current agent status ── */

export interface AgentState {
  sessionId: string
  messages: ChatMessage[]
  isStreaming: boolean
  streamingMessage: string
  pendingToolCalls: Array<{ name: string; args: string }>
  currentAgent: string
  stats: SessionStats
  errorMessage?: string
}

export interface SessionStats {
  promptTokens: number
  completionTokens: number
  cacheHitTokens: number
  cacheMissTokens: number
  apiCalls: number
  toolCalls: number
  totalCost: number
}

/* ── CoreEngine — the central engine interface ── */

export type EnqueueInstructionResult =
  | { status: "queued"; queueLength: number }
  | { status: "idle"; queueLength: 0 }
  | { status: "ignored"; queueLength: number }
  | { status: "full"; queueLength: number }

export interface CoreEngine {
  submit(userInput: string, agentConfig?: AgentConfig, role?: "worker" | "supervisor", mode?: WorkflowMode, workflowPhase?: WorkflowPhase): AsyncGenerator<LoopEvent>
  getState(isStreaming?: boolean, streamingMessage?: string, pendingToolCalls?: Array<{ name: string; args: string }>): AgentState
  interrupt(): void
  registerTool(tool: AgentTool): void
  switchAgent(agentName: string): string
  getAgentName(): string
  respondPermission(allow: boolean, alwaysAllow?: boolean): void
  /** SPEC S0-1: 按 requestId 定向响应权限请求，避免广播误消费 */
  respondPermissionForRequest(requestId: string, allow: boolean, alwaysAllow?: boolean): boolean
  enqueueInstruction(instruction: string): EnqueueInstructionResult
  respondQuestion(requestId: string, answers: QuestionAnswer[]): void
  rejectQuestion(requestId: string): void
  getContextWindow?(): number
  setThinkingMode?(mode: ThinkingMode): void
}

export interface AgentConfig {
  name: string
  model?: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
  toolNames?: string[]
}

/* ── ChatClient — abstract provider interface ── */
export interface ChatClient {
  chatCompletionsStream(messages: ChatMessage[], opts: DeepSeekClientOptions): AsyncGenerator<DeepSeekStreamEvent>
}
