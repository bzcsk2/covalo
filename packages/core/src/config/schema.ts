import { z } from "zod"

// Provider 配置 schema
export const ProviderConfigSchema = z.object({
  type: z.enum(["openai-compatible", "ollama", "lmstudio", "custom"]),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  apiKeyCmd: z.string().optional(),
  model: z.string(),
  local: z.boolean(),
  free: z.boolean(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().nonnegative(),
  headers: z.record(z.string(), z.string()),
})

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

// Agent 配置 schema
export const AgentConfigSchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2),
  topP: z.number().min(0).max(1),
  maxOutputTokens: z.number().int().positive(),
  reasoningEffort: z.enum(["low", "medium", "high"]),
  systemPromptOverride: z.string().optional(),
  systemPromptAppend: z.string().optional(),
  contextStrategy: z.enum(["full", "summary", "last_n_turns"]),
  contextTurns: z.number().int().positive(),
})

export type AgentConfig = z.infer<typeof AgentConfigSchema>

// Agents 配置 schema
export const AgentsConfigSchema = z.object({
  supervisor: AgentConfigSchema,
  worker: AgentConfigSchema,
})

export type AgentsConfig = z.infer<typeof AgentsConfigSchema>

// Workflow 配置 schema
export const WorkflowConfigSchema = z.object({
  defaultMode: z.enum(["alone", "subagent", "loop"]),
  maxRounds: z.number().int().positive(),
  maxConsecutiveErrors: z.number().int().positive(),
  supervisorInterventionErrorThreshold: z.number().int().positive(),
  structuredProtocol: z.boolean(),
  requireJsonDecisions: z.boolean(),
  legacyTextFallback: z.boolean(),
  askUserOnBlocked: z.boolean(),
  autoResumeAfterAskUser: z.boolean(),
})

export type WorkflowConfig = z.infer<typeof WorkflowConfigSchema>

// Goal 配置 schema
export const GoalConfigSchema = z.object({
  enabled: z.boolean(),
  autoContinue: z.boolean(),
  maxAutoContinuations: z.number().int().nonnegative(),
  maxConsecutiveBlockedTurns: z.number().int().positive(),
  maxConsecutiveTurnErrors: z.number().int().positive(),
  defaultTokenBudget: z.number().int().nonnegative(),
  completionAuditRequired: z.boolean(),
  blockedAuditRequired: z.boolean(),
  injectContinuationPrompt: z.boolean(),
  injectObjectiveUpdatedPrompt: z.boolean(),
  injectBudgetLimitPrompt: z.boolean(),
})

export type GoalConfig = z.infer<typeof GoalConfigSchema>

// Mailbox 配置 schema
export const MailboxConfigSchema = z.object({
  enabled: z.boolean(),
  storage: z.enum(["memory", "jsonl"]),
  waitTimeoutMs: z.number().int().positive(),
  maxMessagesPerRole: z.number().int().positive(),
  markReadAfterTurn: z.boolean(),
  persistStructuredPayloads: z.boolean(),
  showInTui: z.boolean(),
})

export type MailboxConfig = z.infer<typeof MailboxConfigSchema>

// Tool 策略配置 schema
export const ToolRoleModePolicySchema = z.object({
  allow: z.array(z.string()),
  deny: z.array(z.string()),
})

export type ToolRoleModePolicy = z.infer<typeof ToolRoleModePolicySchema>

// Tools 配置 schema
export const ToolsConfigSchema = z.object({
  approvalPolicy: z.enum(["never", "on-request", "on-failure", "always"]),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]),
  dangerousToolsEnabled: z.boolean(),
  // Backward-compatible default for existing user/project configs.
  strictMode: z.boolean().default(false),
  // S1-2: RuntimeGuard review 策略配置
  runtimeGuard: z.object({
    reviewPolicy: z.enum(["allow", "ask", "block"]).default("ask"),
  }).default({ reviewPolicy: "ask" }),
  supervisor: z.object({
    loop: ToolRoleModePolicySchema,
    subagent: ToolRoleModePolicySchema,
  }),
  worker: z.object({
    loop: ToolRoleModePolicySchema,
    subagent: ToolRoleModePolicySchema,
  }),
})

export type ToolsConfig = z.infer<typeof ToolsConfigSchema>

// Context 配置 schema
export const ContextConfigSchema = z.object({
  strategy: z.enum(["full", "summary", "sliding_window", "goal_focused"]),
  maxInputTokens: z.number().int().positive(),
  summaryEnabled: z.boolean(),
  summaryEveryTurns: z.number().int().positive(),
  includeMailboxHistory: z.boolean(),
  includeGoalHistory: z.boolean(),
  includeToolEvents: z.boolean(),
})

export type ContextConfig = z.infer<typeof ContextConfigSchema>

// TUI 配置 schema
export const TuiConfigSchema = z.object({
  theme: z.string(),
  showGoalPanel: z.boolean(),
  showAgentCommFeed: z.boolean(),
  showTokenUsage: z.boolean(),
  showToolEvents: z.boolean(),
  compactReasoning: z.boolean(),
  confirmBeforeReplacingGoal: z.boolean(),
  confirmDangerousToolPolicy: z.boolean(),
})

export type TuiConfig = z.infer<typeof TuiConfigSchema>

// Logging 配置 schema
export const LoggingConfigSchema = z.object({
  level: z.enum(["debug", "info", "warn", "error"]),
  path: z.string(),
  eventsJsonl: z.boolean(),
  mailboxJsonl: z.boolean(),
  workflowJsonl: z.boolean(),
  redactSecrets: z.boolean(),
})

export type LoggingConfig = z.infer<typeof LoggingConfigSchema>

// Trace 配置 schema
export const TraceConfigSchema = z.object({
  enabled: z.boolean(),
  includePrompts: z.boolean(),
  includeToolArgs: z.boolean(),
  includeToolResults: z.boolean(),
  includeModelOutputs: z.boolean(),
})

export type TraceConfig = z.infer<typeof TraceConfigSchema>

// Providers 配置 schema (record of provider configs)
export const ProvidersConfigSchema = z.record(z.string(), ProviderConfigSchema)

export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>

// 主配置 schema
export const CovaloConfigSchema = z.object({
  version: z.number().int().positive(),
  providers: ProvidersConfigSchema,
  agents: AgentsConfigSchema,
  workflow: WorkflowConfigSchema,
  goal: GoalConfigSchema,
  mailbox: MailboxConfigSchema,
  tools: ToolsConfigSchema,
  context: ContextConfigSchema,
  tui: TuiConfigSchema,
  logging: LoggingConfigSchema,
  trace: TraceConfigSchema,
})

export type CovaloConfig = z.infer<typeof CovaloConfigSchema>

// 为了向后兼容，导出为DeepreefConfig
export type DeepreefConfig = CovaloConfig

// 配置源类型
export type ConfigSource = {
  kind: "default" | "user" | "project" | "cli" | "tui"
  path?: string
  loaded: boolean
}

// 配置警告类型
export type ConfigWarning = {
  path: string
  message: string
}

// 配置加载选项
export interface ConfigLoadOptions {
  cwd: string
  userConfigPath?: string
  projectConfigPath?: string
  cliOverrides?: Partial<CovaloConfig>
}

// 解析原始配置（处理 snake_case 到 camelCase 的转换）
export function parseConfig(raw: unknown): CovaloConfig {
  // 先处理 snake_case 到 camelCase 的转换
  const normalized = normalizeSnakeToCamel(raw)
  
  // 使用 zod schema 进行验证和默认值填充
  const result = CovaloConfigSchema.safeParse(normalized)
  
  if (!result.success) {
    const errors = result.error.issues.map(issue => {
      const path = issue.path.join('.')
      return `[${path}] ${issue.message}`
    }).join('\n')
    
    throw new Error(`配置验证失败:\n${errors}`)
  }
  
  return result.data
}

// 将 snake_case 对象转换为 camelCase
function normalizeSnakeToCamel(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj
  }
  
  if (Array.isArray(obj)) {
    return obj.map(item => normalizeSnakeToCamel(item))
  }
  
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const camelKey = snakeToCamel(key)
      result[camelKey] = normalizeSnakeToCamel(value)
    }
    return result
  }
  
  return obj
}

// snake_case 到 camelCase 转换
function snakeToCamel(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}
