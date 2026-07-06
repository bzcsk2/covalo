export interface SubagentRunUsage {
  promptTokens: number
  completionTokens: number
}

export interface SubagentRunOptions {
  description: string
  prompt: string
  subagentType?: string
  model?: "inherit" | string
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
