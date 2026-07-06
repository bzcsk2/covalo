import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { TaskManager } from "./task-manager.js"

export function createTaskUpdateTool(): AgentTool {
  return {
    name: "TaskUpdate",
    description: "Update an existing task's content, status, or priority.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task ID." },
        content: { type: "string", description: "Updated task description (optional)." },
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "cancelled"],
          description: "Updated task status (optional).",
        },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Updated task priority (optional).",
        },
      },
      required: ["id"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args, ctx) {
      if (typeof args.id !== "string" || !args.id.trim()) {
        return { content: safeStringify({ error: "id is required" }), isError: true }
      }
      const manager = new TaskManager(ctx.cwd)
      const partial: Record<string, unknown> = {}
      if (typeof args.content === "string" && args.content.trim()) partial.content = args.content.trim()
      if (typeof args.status === "string") partial.status = args.status
      if (typeof args.priority === "string") partial.priority = args.priority
      const ok = manager.update(args.id.trim(), partial)
      if (!ok) {
        return { content: safeStringify({ error: `Task not found: ${args.id}` }), isError: true }
      }
      return { content: safeStringify(manager.get(args.id.trim())), isError: false }
    },
  }
}
