import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { TaskManager } from "./task-manager.js"

export function createTaskListTool(): AgentTool {
  return {
    name: "TaskList",
    description: "List tasks, optionally filtered by status or priority.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "in_progress", "completed", "cancelled"],
          description: "Filter by status (optional).",
        },
        priority: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Filter by priority (optional).",
        },
      },
      required: [],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args, ctx) {
      const manager = new TaskManager(ctx.cwd)
      let tasks = manager.list()
      if (typeof args.status === "string") {
        tasks = tasks.filter((t) => t.status === args.status)
      }
      if (typeof args.priority === "string") {
        tasks = tasks.filter((t) => t.priority === args.priority)
      }
      return { content: safeStringify({ tasks, count: tasks.length }), isError: false }
    },
  }
}
