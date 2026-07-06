import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { TaskManager } from "./task-manager.js"

export function createTaskGetTool(): AgentTool {
  return {
    name: "TaskGet",
    description: "Get a single task by its ID.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task ID." },
      },
      required: ["id"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args, ctx) {
      if (typeof args.id !== "string" || !args.id.trim()) {
        return { content: safeStringify({ error: "id is required" }), isError: true }
      }
      const manager = new TaskManager(ctx.cwd)
      const task = manager.get(args.id.trim())
      if (!task) {
        return { content: safeStringify({ error: `Task not found: ${args.id}` }), isError: true }
      }
      return { content: safeStringify(task), isError: false }
    },
  }
}
