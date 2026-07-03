import type { CovaloConfig } from "./schema.js"

/**
 * 配置适配器：将新的配置系统配置转换为各个模块使用的格式
 *
 * Phase 2.2: 已删除 6 个未使用的函数（无生产调用方）：
 * - toWorkflowCoordinatorConfig
 * - toGoalRuntimeConfig
 * - getSupervisorToolPolicy
 * - getWorkerToolPolicy
 * - getMailboxConfig
 * - getContextConfig
 * 详见 docs/unintegrated_code_audit_20260703.md §3.7。
 * 保留的函数：isToolAllowed / isHardDeniedForSupervisorLoop / isHardDeniedForWorkerLoop
 * （被 resolve-effective-tools.ts 使用）。
 */

/**
 * 检查工具是否被允许
 */
export function isToolAllowed(
  config: CovaloConfig,
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
