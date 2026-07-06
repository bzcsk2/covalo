import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { TaskManager } from "./task-manager.js"

export function createTaskCreateTool(): AgentTool {
  return {
    name: "TaskCreate",
    description: "Create a new task in the persistent task store.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "The task description." },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Task priority (optional, default: medium).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for the task.",
        },
      },
      required: ["content"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args, ctx) {
      if (typeof args.content !== "string" || !args.content.trim()) {
        return { content: safeStringify({ error: "content is required" }), isError: true }
      }
      const manager = new TaskManager(ctx.cwd)
      const task = manager.create({
        content: args.content.trim(),
        status: "pending",
        priority: typeof args.priority === "string" ? args.priority : "medium",
        tags: Array.isArray(args.tags) ? args.tags.filter((t): t is string => typeof t === "string") : undefined,
      })
      return { content: safeStringify(task), isError: false }
    },
  }
}
