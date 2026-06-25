import type { DeepReefConfig } from "./schema.js"
import type { WorkflowConfig as LegacyWorkflowConfig } from "../workflow-coordinator/types.js"
import type { GoalRuntimeConfig } from "../goal/runtime.js"

/**
 * 配置适配器：将新的配置系统配置转换为各个模块使用的格式
 */

/**
 * 将新的WorkflowConfig转换为WorkflowCoordinator使用的格式
 */
export function toWorkflowCoordinatorConfig(config: DeepReefConfig): Partial<LegacyWorkflowConfig> {
  return {
    maxRounds: config.workflow.maxRounds,
    requireSupervisorPlan: config.workflow.structuredProtocol,
    requireVerificationGate: config.workflow.requireJsonDecisions,
  }
}

/**
 * 将新的GoalConfig转换为GoalRuntime使用的格式
 */
export function toGoalRuntimeConfig(config: DeepReefConfig): Partial<GoalRuntimeConfig> {
  return {
    maxAutoContinuations: config.goal.maxAutoContinuations,
    maxConsecutiveTurnErrors: config.goal.maxConsecutiveTurnErrors,
  }
}

/**
 * 获取Supervisor的工具策略
 */
export function getSupervisorToolPolicy(config: DeepReefConfig, mode: "loop" | "subagent") {
  return config.tools.supervisor[mode]
}

/**
 * 获取Worker的工具策略
 */
export function getWorkerToolPolicy(config: DeepReefConfig, mode: "loop" | "subagent") {
  return config.tools.worker[mode]
}

/**
 * 检查工具是否被允许
 */
export function isToolAllowed(
  config: DeepReefConfig,
  role: "supervisor" | "worker",
  mode: "loop" | "subagent",
  toolName: string
): boolean {
  const policy = config.tools[role][mode]
  
  // 检查deny列表
  if (policy.deny.includes(toolName)) {
    return false
  }
  
  // 检查allow列表（如果为空，则允许所有）
  if (policy.allow.length > 0) {
    return policy.allow.includes(toolName)
  }
  
  // 默认允许
  return true
}

/**
 * 检查是否是hard deny工具（Supervisor loop不能使用的工程工具）
 */
export function isHardDeniedForSupervisorLoop(toolName: string): boolean {
  const hardDenied = ["bash", "edit_file", "apply_patch", "write_file", "AgentTool"]
  return hardDenied.includes(toolName)
}

/**
 * 检查是否是hard deny工具（Worker loop不能使用的工具）
 */
export function isHardDeniedForWorkerLoop(toolName: string): boolean {
  const hardDenied = ["update_goal"]
  return hardDenied.includes(toolName)
}

/**
 * 获取Mailbox配置
 */
export function getMailboxConfig(config: DeepReefConfig) {
  return {
    enabled: config.mailbox.enabled,
    storage: config.mailbox.storage,
    waitTimeoutMs: config.mailbox.waitTimeoutMs,
    maxMessagesPerRole: config.mailbox.maxMessagesPerRole,
    markReadAfterTurn: config.mailbox.markReadAfterTurn,
  }
}

/**
 * 获取Context配置
 */
export function getContextConfig(config: DeepReefConfig) {
  return {
    strategy: config.context.strategy,
    maxInputTokens: config.context.maxInputTokens,
    summaryEnabled: config.context.summaryEnabled,
    summaryEveryTurns: config.context.summaryEveryTurns,
    includeMailboxHistory: config.context.includeMailboxHistory,
    includeGoalHistory: config.context.includeGoalHistory,
    includeToolEvents: config.context.includeToolEvents,
  }
}