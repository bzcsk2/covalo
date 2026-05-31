import type { ChatMessage, ToolSpec, Usage } from "./types.js"
import type { DeepSeekStreamEvent, DeepSeekClientOptions } from "./client.js"

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
  | "strategy_notify"
  | "strategy_estimate_refined"
  | "tool_progress"
  | "usage"
  | "permission_ask"

export interface LoopEvent {
  role: LoopEventRole
  content?: string
  toolName?: string
  toolCallIndex?: number
  severity?: "info" | "warning" | "error"
  metadata?: Record<string, unknown>
}

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
  signal?: AbortSignal
  invokeTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  delegateTask?: (task: string, agentType: "build" | "plan", files: string[]) => Promise<string>
  switchAgent?: (name: "build" | "plan") => string
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

export interface CoreEngine {
  submit(userInput: string, agentConfig?: AgentConfig): AsyncGenerator<LoopEvent>
  getState(isStreaming?: boolean, streamingMessage?: string, pendingToolCalls?: Array<{ name: string; args: string }>): AgentState
  interrupt(): void
  registerTool(tool: AgentTool): void
  switchAgent(agentName: string): string
  getAgentName(): string
  resolveTierDecision(tier: string): void
  respondPermission(allow: boolean, alwaysAllow?: boolean): void
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
