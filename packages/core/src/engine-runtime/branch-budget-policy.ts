import type { BranchBudgetTracker } from "../governance/branch-budget.js"

export type { BranchBudgetTracker }
export type BranchBudgetPolicyMode = "enforce" | "recover" | "observe"

/**
 * F0-1: 根据 effectivePolicy.branchBudget 配置 BranchBudgetTracker。
 *
 * - "enforce" → 启用 + 硬拦截
 * - "recover" → 启用 + 仅记录
 * - "observe" → 禁用
 */
export function configureBranchBudget(
  branchBudgetTracker: BranchBudgetTracker,
  mode: BranchBudgetPolicyMode | undefined,
): void {
  const enabled = mode !== "observe" && mode !== undefined
  branchBudgetTracker.setEnabled(enabled)
  branchBudgetTracker.bindWorkspaceRoot(process.cwd())
}
