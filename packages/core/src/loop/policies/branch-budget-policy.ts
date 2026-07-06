import type { ToolCall } from "../../types.js"
import type { LoopEvent, ToolResult } from "../../interface.js"
import { parseToolCallArgs } from "../../executor-helpers.js"
import { extractToolTargetPath, extractRunCommand } from "../../governance/branch-budget-tool-path.js"
import type { BranchBudgetTracker } from "../../governance/branch-budget.js"
import type { RuntimeExecutionState } from "../../governance/mode-decision.js"
import type { LoopPolicy } from "../policy.js"
import type { LoopPolicyContext, ToolResultInfo } from "../policy.js"

export interface CheckBranchBudgetBlocksInput {
  branchBudgetTracker?: BranchBudgetTracker
  toolCalls: ToolCall[]
  workspaceRoot?: string
}

export function checkBranchBudgetBlocks(input: CheckBranchBudgetBlocksInput): Map<string, string> {
  const { branchBudgetTracker, toolCalls, workspaceRoot } = input
  const blocks = new Map<string, string>()
  if (!branchBudgetTracker) return blocks
  for (const tc of toolCalls) {
    const argsResult = parseToolCallArgs(tc.function.arguments, tc.function.name)
    if (!argsResult.ok) continue
    const decision = branchBudgetTracker.checkToolBlock(
      tc.function.name,
      argsResult.args,
      extractToolTargetPath,
      extractRunCommand,
      { workspaceRoot },
    )
    if (decision.blocked && decision.message) {
      blocks.set(tc.id, decision.message)
    }
  }
  return blocks
}

export interface RecordBranchBudgetResultInput {
  branchBudgetTracker?: BranchBudgetTracker
  toolName: string
  args: Record<string, unknown>
  result: ToolResult
  runtimeState: RuntimeExecutionState
}

export function recordBranchBudgetResult(input: RecordBranchBudgetResultInput): void {
  const { branchBudgetTracker, toolName, args, result, runtimeState } = input
  if (!branchBudgetTracker) return
  const isErr = result.isError || !!result.metadata?.error
  if (extractToolTargetPath(toolName, args) && !isErr) {
    branchBudgetTracker.recordFileEdit(extractToolTargetPath(toolName, args))
  }
  if (toolName === "bash" && isErr) {
    const cmd = extractRunCommand(args)
    if (cmd) branchBudgetTracker.recordFailedCommandAttempt(cmd)
  }
  if (isErr) {
    const sig = (typeof result.content === "string" ? result.content : "").slice(0, 200)
    if (sig) branchBudgetTracker.recordError(sig)
  }
  runtimeState.lastToolSuccess = !isErr
}

export interface CreateBranchBudgetLoopPolicyInput {
  branchBudgetTracker?: BranchBudgetTracker
  runtimeState: RuntimeExecutionState
}

export function createBranchBudgetLoopPolicy(input: CreateBranchBudgetLoopPolicyInput): LoopPolicy {
  const { branchBudgetTracker, runtimeState } = input
  return {
    name: "branch-budget",
    afterToolResult(_ctx: LoopPolicyContext, event: LoopEvent, info: ToolResultInfo): void {
      if (info.source !== "native") return
      if (event.role !== "tool" && event.role !== "error") return
      if (!info.toolCall) return
      const argsResult = parseToolCallArgs(info.toolCall.function.arguments, info.toolCall.function.name)
      if (!argsResult.ok) return
      recordBranchBudgetResult({
        branchBudgetTracker,
        toolName: info.toolCall.function.name,
        args: argsResult.args,
        result: {
          isError: event.role === "error" || !!event.metadata?.error,
          content: event.content ?? "",
          metadata: event.metadata,
        },
        runtimeState,
      })
    },
  }
}
