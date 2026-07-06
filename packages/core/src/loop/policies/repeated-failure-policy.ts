import type { LoopEvent } from "../../interface.js"
import type { RepeatedFailureTracker } from "../../loop-helpers.js"
import type { LoopPolicy, LoopPolicyContext, ToolResultInfo, LoopPolicyEventEmission } from "../policy.js"

export interface CreateRepeatedFailureLoopPolicyInput {
  repeatedFailures: RepeatedFailureTracker
}

export function createRepeatedFailureLoopPolicy(input: CreateRepeatedFailureLoopPolicyInput): LoopPolicy {
  const { repeatedFailures } = input
  return {
    name: "repeated-failure",
    afterToolResult(_ctx: LoopPolicyContext, event: LoopEvent, info: ToolResultInfo): LoopPolicyEventEmission | void {
      if (info.source !== "native") return
      if (event.role !== "tool" && event.role !== "error") return
      if (!event.toolName) return
      if (!info.parsedArgs) return

      const isErr = event.role === "error" || !!event.metadata?.error
      if (!isErr) {
        repeatedFailures.clear(event.toolName, info.parsedArgs)
        return
      }

      const failure = repeatedFailures.record(
        event.toolName,
        info.parsedArgs,
        event.content ?? "",
      )
      if (!failure.blocked) return

      return {
        event: {
          role: "warning",
          content: `Repeated tool failure: "${event.toolName}" failed ${failure.count} times with identical arguments and error. Stop retrying; re-read context, adjust the plan, or report the blocker.`,
          severity: "warning",
        },
        sessionEvent: {
          role: "warning",
          content: `repeated_failure_blocked: ${event.toolName}`,
        },
      }
    },
  }
}
