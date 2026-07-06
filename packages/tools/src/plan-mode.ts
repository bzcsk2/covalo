import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"

export function createPlanModeTool(): AgentTool {
  return {
    name: "PlanMode",
    description: "Signal a mode switch between 'plan' (planning/design) and 'build' (implementation).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["enter", "exit"],
          description: "'enter' to switch to planning mode, 'exit' to switch back to build mode.",
        },
      },
      required: ["action"],
    },
    concurrency: "exclusive",
    approval: "read",
    async execute(args, ctx) {
      if (args.action !== "enter" && args.action !== "exit") {
        return { content: safeStringify({ error: "action must be 'enter' or 'exit'" }), isError: true }
      }
      const isEnter = args.action === "enter"
      const mode = isEnter ? "plan" : "build"
      if (!ctx.switchAgent) {
        return { content: safeStringify({ error: "PlanMode requires an engine runtime context" }), isError: true }
      }
      const label = ctx.switchAgent(mode)
      return {
        content: safeStringify({
          mode,
          label,
          message: isEnter
            ? "Switched to planning mode. Analyze requirements, design architecture, and outline implementation before writing code."
            : "Switched to build mode. Implement the planned solution with code.",
          action: args.action,
        }),
        isError: false,
      }
    },
  }
}
