import type { QuestionInfo, QuestionAnswer } from "./question.js"
import type { SubagentRunOptions, SubagentRunResult } from "./subagent.js"

export type ToolTier = "read" | "write" | "exec"

export type ToolConcurrency = "shared" | "exclusive"

export interface ToolSandboxCommand {
  command: string
  cwd: string
  timeoutMs: number
  allowNetwork: boolean
  readRoots: string[]
  writeRoots: string[]
}

export interface ToolSandboxResult {
  stdout: string
  stderr: string
  exitCode?: number | null
  timedOut?: boolean
}

export interface ToolSandboxProvider {
  id: string
  run(options: ToolSandboxCommand): Promise<ToolSandboxResult>
}

export interface AgentTool {
  name: string
  description: string
  parameters: Record<string, unknown>
  concurrency: ToolConcurrency
  approval: ToolTier
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
}

export interface ToolContext {
  cwd: string
  sessionId: string
  signal?: AbortSignal
  sandboxProvider?: ToolSandboxProvider
  reportProgress?: (update: ToolProgressUpdate) => void
  invokeTool?: (name: string, args: Record<string, unknown>) => Promise<ToolResult>
  delegateTask?: (task: string, agentType: string, files: string[]) => Promise<string>
  switchAgent?: (name: string) => string
  spawnSubagent?: (options: SubagentRunOptions) => Promise<SubagentRunResult>
  askUser?: (questions: QuestionInfo[]) => Promise<QuestionAnswer[]>
}

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
