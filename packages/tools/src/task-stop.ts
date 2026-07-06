import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { TaskManager } from "./task-manager.js"

export function createTaskStopTool(): AgentTool {
  return {
    name: "TaskStop",
    description: "Stop/cancel a task by ID.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The task ID to cancel." },
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
      const ok = manager.stop(args.id.trim())
      if (!ok) {
        return { content: safeStringify({ error: `Task not found: ${args.id}` }), isError: true }
      }
      return { content: safeStringify(manager.get(args.id.trim())), isError: false }
    },
  }
}
