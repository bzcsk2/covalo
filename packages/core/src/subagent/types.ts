export type SubagentPermissionMode = "readonly" | "acceptEdits" | "denyExec" | "bubble"

export interface SubagentDefinition {
  name: string
  description: string
  tools?: string[]
  disallowedTools?: string[]
  /** @deprecated 使用 target 替代 */
  model?: "inherit" | string
  /** DRF-10: 默认 target ID */
  target?: string
  maxTurns?: number
  permissionMode: SubagentPermissionMode
  background?: boolean
  inheritContext?: boolean
  systemPrompt: string
  /** Optional bilingual alternatives */
  systemPromptByLocale?: Partial<Record<"zh-CN" | "en", string>>
}

export type SubagentRunStatus = "running" | "completed" | "failed" | "cancelled"

export interface SubagentRunUsage {
  promptTokens: number
  completionTokens: number
}

export interface SubagentRun {
  id: string
  definitionName: string
  description: string
  status: SubagentRunStatus
  prompt: string
  result?: string
  error?: string
  transcript?: string
  files?: string[]
  usage?: SubagentRunUsage
  warnings?: string[]
  createdAt: Date
  finishedAt?: Date
}

export interface SubagentRunOptions {
  description: string
  prompt: string
  subagentType?: string
  /** @deprecated 使用 target 替代，仅覆盖 model 字符串 */
  model?: "inherit" | string
  /** DRF-10: 角色化 target ID（如 worker.local、supervisor.zen-free） */
  target?: string
  runInBackground?: boolean
  files?: string[]
}

export type SubagentRunResult =
  | {
      status: "completed"
      id: string
      subagent_type: string
      description: string
      result: string
      files: string[]
      usage: SubagentRunUsage
      warnings: string[]
    }
  | {
      status: "failed"
      id: string
      subagent_type: string
      description: string
      result: string
      files: string[]
      usage: SubagentRunUsage
      warnings: string[]
    }
  | {
      status: "cancelled"
      id: string
      subagent_type: string
      description: string
      result: string
      files: string[]
      usage: SubagentRunUsage
      warnings: string[]
    }
  | {
      status: "async_launched"
      id: string
      description: string
    }

export interface SubagentRunStoreEntry {
  run: SubagentRun
  abortController?: AbortController
}
