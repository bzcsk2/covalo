import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"

export function createAgentToolTool(): AgentTool {
  return {
    name: "AgentTool",
    description: `Delegate a subtask to a sub-agent. Creates an isolated agent session to work on a specific task.

For named sub-agents (Explore, Plan, general-purpose), the sub-agent starts with zero context — your prompt must include full background, goals, file paths, constraints, and expected output.

For fork sub-agents (future), the sub-agent inherits context and the prompt should be a directive.

Parameters:
- description (required): 3-5 word summary for logging/UI
- prompt (required): Complete task for the sub-agent
- subagent_type (optional): "Explore" (read-only search), "Plan" (read-only planning), "general-purpose" (default, can read/write but no exec)
- model (optional): Override model. Use "inherit" (default) to use the parent's model.
- files (optional): Relevant file paths to provide as context.

Legacy parameters (still supported):
- task: Maps to prompt
- agent_type: "plan" maps to subagent_type "Plan", "build" maps to "general-purpose"

Returns structured JSON with status, id, subagent_type, result, files, usage.`,
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "3-5 word summary for logging/UI (e.g. 'review auth flow')" },
        prompt: { type: "string", description: "Complete task description for the sub-agent. Must include full background and goals for non-fork agents." },
        subagent_type: { type: "string", enum: ["Explore", "Plan", "general-purpose"], description: "Sub-agent type. 'Explore' and 'Plan' are read-only. 'general-purpose' can read/write but cannot run exec tools." },
        model: { type: "string", description: "Optional model override. 'inherit' (default) uses parent's model." },
        task: { type: "string", description: "[Legacy] Maps to prompt." },
        agent_type: { type: "string", enum: ["build", "plan"], description: "[Legacy] 'build' maps to general-purpose, 'plan' maps to Plan." },
        files: { type: "array", items: { type: "string" }, description: "Relevant file paths to provide as context." },
      },
    },
    concurrency: "exclusive",
    approval: "read",
    async execute(args, ctx) {
      // Resolve prompt from new or legacy param
      const prompt = typeof args.prompt === "string" && args.prompt
        ? args.prompt
        : typeof args.task === "string" && args.task
          ? args.task
          : ""

      if (!prompt) {
        return { content: safeStringify({ error: "prompt (or legacy task) is required and must be non-empty" }), isError: true }
      }

      // Resolve description
      const description = typeof args.description === "string" && args.description
        ? args.description
        : prompt.split(/\s+/).slice(0, 5).join(" ") + (prompt.split(/\s+/).length > 5 ? "..." : "")

      // Resolve subagent_type from new or legacy param
      let subagentType: string | undefined
      if (typeof args.subagent_type === "string" && args.subagent_type) {
        subagentType = args.subagent_type
      } else if (args.agent_type === "plan") {
        subagentType = "Plan"
      } else if (args.agent_type === "build") {
        subagentType = "general-purpose"
      }

      const files = Array.isArray(args.files) ? args.files.map(String) : []

      // Use spawnSubagent if available (new path)
      if (ctx.spawnSubagent) {
        const result = await ctx.spawnSubagent({
          description,
          prompt,
          subagentType,
          model: typeof args.model === "string" ? args.model : "inherit",
          files,
        })
        return { content: safeStringify(result), isError: result.status !== "completed" }
      }

      // Fallback to delegateTask (legacy path)
      if (!ctx.delegateTask) {
        return { content: safeStringify({ error: "Sub-agent execution is unavailable outside the engine runtime" }), isError: true }
      }

      const agentType = subagentType === "Plan" ? "plan" : "build"
      const result = await ctx.delegateTask(prompt, agentType, files)
      return {
        content: safeStringify({
          status: "completed",
          id: `delegate_legacy`,
          subagent_type: agentType === "plan" ? "Plan" : "general-purpose",
          description,
          result,
          files,
          usage: { promptTokens: 0, completionTokens: 0 },
          warnings: [],
        }),
        isError: false,
      }
    },
  }
}
