import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { listJobs, createJob, deleteJob as schedulerDeleteJob, normalizePlatform } from "./platform/scheduler-backend.js"

export function createCronTool(): AgentTool {
  return {
    name: "Cron",
    description: "Schedule, remove, or list cron jobs. Creates simple cron tasks using the system scheduler (crontab on POSIX, schtasks on Windows).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "delete", "list"],
          description: "create, delete, or list a cron job.",
        },
        name: { type: "string", description: "Unique job identifier (required for create/delete)." },
        schedule: { type: "string", description: "Cron expression like '0 * * * *' (required for create). On Windows, supports minute, hourly, daily, weekly, and monthly patterns." },
        command: { type: "string", description: "Shell command to execute (required for create)." },
      },
      required: ["action"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args, ctx) {
      const action = args.action as string | undefined
      if (!action || !["create", "delete", "list"].includes(action)) {
        return { content: safeStringify({ error: "action must be one of: create, delete, list" }), isError: true }
      }

      if (action === "list") {
        const result = await listJobs(undefined, ctx.signal)
        if (result.error) {
          return { content: safeStringify({ error: result.error }), isError: true }
        }
        return { content: safeStringify({ jobs: result.jobs, backend: result.backend }), isError: false }
      }

      if (action === "create") {
        const name = args.name as string | undefined
        const schedule = args.schedule as string | undefined
        const command = args.command as string | undefined

        if (!name) return { content: safeStringify({ error: "name is required for create action" }), isError: true }
        if (!schedule) return { content: safeStringify({ error: "schedule is required for create action" }), isError: true }
        if (!command) return { content: safeStringify({ error: "command is required for create action" }), isError: true }

        const result = await createJob(name, schedule, command, undefined, ctx.signal)
        if (result.error) {
          return { content: safeStringify({ error: result.error }), isError: true }
        }
        return { content: safeStringify({ message: `Cron job "${name}" created`, name, schedule, command, backend: result.backend }), isError: false }
      }

      // delete
      const name = args.name as string | undefined
      if (!name) return { content: safeStringify({ error: "name is required for delete action" }), isError: true }

      const result = await schedulerDeleteJob(name, undefined, ctx.signal)
      if (result.error) {
        return { content: safeStringify({ error: result.error }), isError: true }
      }
      return { content: safeStringify({ message: `Cron job "${name}" deleted`, backend: result.backend }), isError: false }
    },
  }
}
