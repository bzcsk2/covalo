import type { SubagentRunUsage, SubagentRunOptions, SubagentRunResult } from "@covalo/protocol"
export type { SubagentRunUsage, SubagentRunOptions, SubagentRunResult }

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

export interface SubagentRunStoreEntry {
  run: SubagentRun
  abortController?: AbortController
}
