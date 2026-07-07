import type { ToolCall } from "../../types.js"
import type { LoopEvent, ToolResult } from "../../interface.js"
import { parseToolCallArgs } from "../../executor-helpers.js"
import { extractToolTargetPath, extractRunCommand } from "../../governance/branch-budget-tool-path.js"
import type { BranchBudgetTracker } from "../../governance/branch-budget.js"
import type { RuntimeExecutionState } from "../../governance/mode-decision.js"
import type { EffectiveHarnessPolicy } from "../../harness/index.js"
import type { LoopPolicy, ToolBatchInfo, ToolBatchInterception } from "../policy.js"
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
  appendToolResult?: (tc: ToolCall, result: ToolResult) => void
  effectivePolicy?: EffectiveHarnessPolicy
  workspaceRoot?: string
}

export function createBranchBudgetLoopPolicy(input: CreateBranchBudgetLoopPolicyInput): LoopPolicy {
  const { branchBudgetTracker, runtimeState, appendToolResult, effectivePolicy, workspaceRoot } = input
  return {
    name: "branch-budget",
    beforeToolBatch(_ctx: LoopPolicyContext, toolCalls: readonly ToolCall[], info: ToolBatchInfo): ToolBatchInterception | void {
      if (info.source !== "native") return
      if (effectivePolicy?.branchBudget !== "enforce") return
      if (!appendToolResult) return
      const branchBudgetBlocks = checkBranchBudgetBlocks({
        branchBudgetTracker,
        toolCalls: [...toolCalls],
        workspaceRoot,
      })
      if (branchBudgetBlocks.size === 0) return

      const events = []
      for (const tc of toolCalls) {
        const blockMsg = branchBudgetBlocks.get(tc.id)
        if (blockMsg) {
          appendToolResult(tc, { content: blockMsg, isError: true, metadata: { reason: "branch_budget_blocked" } })
          events.push({
            event: {
              role: "error" as const,
              content: blockMsg,
              severity: "warning" as const,
              metadata: { reason: "branch_budget_blocked", toolName: tc.function.name, toolCallId: tc.id },
            },
            sessionEvent: {
              role: "error" as const,
              content: blockMsg,
              metadata: { reason: "branch_budget_blocked", toolName: tc.function.name },
            },
          })
        } else {
          const skipMsg = "Skipped: BranchBudget blocked another tool in this batch; please retry in the next turn."
          appendToolResult(tc, { content: skipMsg, isError: true, metadata: { reason: "branch_budget_batch_skipped" } })
        }
      }
      events.push({
        event: { role: "status" as const, content: "tools_completed" },
      })

      return {
        handled: true,
        events,
      }
    },
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
