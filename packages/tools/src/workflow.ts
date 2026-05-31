import type { AgentTool } from "../../core/src/interface.js"
import { safeStringify } from "./safe-stringify.js"

export function createWorkflowTool(): AgentTool {
  return {
    name: "Workflow",
    description: "Execute multi-step workflow scripts. A workflow is a JSON array of steps, each with a tool name, arguments, and optional conditions. Runs steps sequentially with output from each step fed to the next.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "Array of workflow steps. Each step: { tool: string, args: object, description?: string }",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Tool name to call" },
              args: { type: "object", description: "Arguments for the tool" },
              description: { type: "string", description: "Human-readable step description" },
            },
            required: ["tool", "args"],
          },
        },
      },
      required: ["steps"],
    },
    concurrency: "exclusive",
    approval: "exec",
    async execute(args, ctx) {
      if (!Array.isArray(args.steps) || args.steps.length === 0) {
        return { content: safeStringify({ error: "steps array is required" }), isError: true }
      }
      const results: Array<{ step: number; tool: string; status: string; output?: unknown; error?: string }> = []
      if (!ctx.invokeTool) {
        return { content: safeStringify({ error: "Workflow requires an engine tool invocation context" }), isError: true }
      }
      for (let i = 0; i < args.steps.length; i++) {
        const step = args.steps[i]
        if (typeof step.tool !== "string" || !step.tool) {
          results.push({ step: i, tool: "unknown", status: "error", error: "step missing tool name" })
          continue
        }
        const stepArgs = step.args && typeof step.args === "object" && !Array.isArray(step.args)
          ? step.args as Record<string, unknown>
          : {}
        const result = await ctx.invokeTool(step.tool, stepArgs)
        results.push({
          step: i,
          tool: step.tool,
          status: result.isError ? "error" : "completed",
          ...(result.isError ? { error: result.content } : { output: result.content }),
        })
        if (result.isError) break
      }
      return {
        content: safeStringify({ totalSteps: args.steps.length, results }),
        isError: results.some(result => result.status === "error"),
      }
    },
  }
}
