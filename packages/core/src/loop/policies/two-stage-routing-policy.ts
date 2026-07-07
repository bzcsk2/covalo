import type { ToolCall } from "../../types.js"
import type { ToolResult } from "../../interface.js"
import { parseSelectedCategory } from "../../tool-routing/two-stage-router.js"
import type { ToolCategory } from "../../tool-routing/types.js"
import type { LoopPolicy, ToolBatchInfo, ToolBatchInterception } from "../policy.js"

export interface TwoStageRoutingState {
  readonly selectedCategory?: ToolCategory
  setSelectedCategory(category: ToolCategory | undefined): void
}

export function createTwoStageRoutingState(): TwoStageRoutingState {
  let selectedCategory: ToolCategory | undefined
  return {
    get selectedCategory() {
      return selectedCategory
    },
    setSelectedCategory(category: ToolCategory | undefined) {
      selectedCategory = category
    },
  }
}

export interface CreateTwoStageRoutingLoopPolicyInput {
  state: TwoStageRoutingState
  appendToolResult: (tc: ToolCall, result: ToolResult) => void
}

export function createTwoStageRoutingLoopPolicy(input: CreateTwoStageRoutingLoopPolicyInput): LoopPolicy {
  const { state, appendToolResult } = input
  return {
    name: "two-stage-routing",
    beforeToolBatch(_ctx, toolCalls: readonly ToolCall[], info: ToolBatchInfo): ToolBatchInterception | void {
      if (info.source !== "native") return
      const categoryCall = toolCalls.find((tc) => tc.function.name === "select_category")
      if (!categoryCall) return

      const parsedCategory = parseSelectedCategory(categoryCall.function.arguments)
      if (!parsedCategory) {
        appendToolResult(categoryCall, {
          content: "Invalid category. Please select a valid category from: read, write, search, run, plan, code_intel, full.",
          isError: true,
          metadata: { reason: "two_stage_invalid_category" },
        })
        return {
          handled: true,
          events: [{ role: "status", content: "tools_completed" }],
        }
      }

      state.setSelectedCategory(parsedCategory)
      appendToolResult(categoryCall, {
        content: `Category selected: ${parsedCategory}. Continuing with tools from this category.`,
        isError: false,
        metadata: { reason: "two_stage_category_selected", selectedCategory: parsedCategory },
      })
      for (const tc of toolCalls) {
        if (tc.id === categoryCall.id) continue
        appendToolResult(tc, {
          content: "Skipped: select_category was called in this batch; please retry in the next turn.",
          isError: true,
          metadata: { reason: "two_stage_batch_skipped" },
        })
      }

      return {
        handled: true,
        events: [{
          role: "status",
          content: "two_stage_category_selected",
          metadata: { selectedCategory: parsedCategory },
        }],
      }
    },
    afterToolBatch(_ctx, _toolCalls: readonly ToolCall[], info: ToolBatchInfo): void {
      if (info.source !== "native") return
      if (state.selectedCategory) {
        state.setSelectedCategory(undefined)
      }
    },
  }
}
