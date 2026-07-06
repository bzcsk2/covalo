export type Role = "system" | "user" | "assistant" | "tool"

export interface ChatMessage {
  role: Role
  content: string | null
  reasoning_content?: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
  is_error?: boolean
}

export interface ToolCall {
  id: string
  type: "function"
  function: {
    name: string
    arguments: string
  }
}

export interface ToolSpec {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  prompt_cache_hit_tokens?: number
  prompt_cache_miss_tokens?: number
}
