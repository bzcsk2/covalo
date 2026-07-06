import type { LoopEvent } from "../../interface.js"
import type { SupervisorGuidanceConfig } from "../../supervisor/guided-loop.js"
import {
  recordSupervisorFailureEvidence,
  recordSupervisorToolEvidence,
} from "../../supervisor/guided-loop.js"
import type { LoopPolicy, LoopPolicyContext, ToolResultInfo } from "../policy.js"

export interface CreateSupervisorEvidenceLoopPolicyInput {
  supervisorGuidance?: SupervisorGuidanceConfig
}

export function createSupervisorEvidenceLoopPolicy(input: CreateSupervisorEvidenceLoopPolicyInput): LoopPolicy {
  const { supervisorGuidance } = input
  return {
    name: "supervisor-evidence",
    afterToolResult(_ctx: LoopPolicyContext, event: LoopEvent, info: ToolResultInfo): void {
      if (info.source !== "native") return
      if (event.role !== "tool" && event.role !== "error") return
      if (!event.toolName) return
      if (!info.parsedArgs) return
      if (!supervisorGuidance) return

      const isErr = event.role === "error" || !!event.metadata?.error
      recordSupervisorToolEvidence(
        supervisorGuidance.state,
        event.toolName,
        !isErr,
        (event.content ?? "").slice(0, 200),
      )
      if (!isErr) return

      const sigKey = typeof info.parsedArgs.path === "string"
        ? info.parsedArgs.path
        : typeof info.parsedArgs.command === "string"
          ? info.parsedArgs.command
          : "err"
      recordSupervisorFailureEvidence(
        supervisorGuidance.state,
        `${event.toolName}:${sigKey}`,
        event.content,
      )
    },
  }
}
