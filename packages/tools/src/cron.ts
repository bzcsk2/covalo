import { spawn } from "node:child_process"
import type { AgentTool } from "@deepicode/core"
import { safeStringify } from "./safe-stringify.js"

const JOB_MARKER = "# deepicode-job:"
const TIMEOUT_MS = 5_000

export function createCronTool(): AgentTool {
  return {
    name: "Cron",
    description: "Schedule, remove, or list cron jobs. Creates simple cron tasks using system crontab.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "delete", "list"],
          description: "create, delete, or list a cron job.",
        },
        name: { type: "string", description: "Unique job identifier (required for create/delete)." },
        schedule: { type: "string", description: "Cron expression like '0 * * * *' (required for create)." },
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

      const { lines, error } = await getCrontab(ctx.signal)
      if (error) {
        return { content: safeStringify({ error: `Crontab error: ${error}` }), isError: true }
      }

      if (action === "list") {
        const jobs = parseJobs(lines)
        return { content: safeStringify({ jobs }), isError: false }
      }

      if (action === "create") {
        const name = args.name as string | undefined
        const schedule = args.schedule as string | undefined
        const command = args.command as string | undefined

        if (!name) return { content: safeStringify({ error: "name is required for create action" }), isError: true }
        if (!schedule) return { content: safeStringify({ error: "schedule is required for create action" }), isError: true }
        if (!command) return { content: safeStringify({ error: "command is required for create action" }), isError: true }

        const sanitizedCommand = command.replace(/[\n\r]/g, " ")
        const sanitizedName = name.replace(/[\n\r]/g, "_")

        const existing = parseJobs(lines).find((j) => j.name === sanitizedName)
        if (existing) {
          return { content: safeStringify({ error: `Job "${sanitizedName}" already exists. Delete it first or use a different name.` }), isError: true }
        }

        const newLines = [...lines, "", `${JOB_MARKER}${sanitizedName}`, schedule + " " + sanitizedCommand]
        const setErr = await setCrontab(newLines, ctx.signal)
        if (setErr) return { content: safeStringify({ error: setErr }), isError: true }

        return { content: safeStringify({ message: `Cron job "${name}" created`, name, schedule, command }), isError: false }
      }

      const name = args.name as string | undefined
      if (!name) return { content: safeStringify({ error: "name is required for delete action" }), isError: true }

      const newLines = deleteJob(lines, name)
      if (newLines.length === lines.length) {
        return { content: safeStringify({ error: `No job found with name "${name}"` }), isError: true }
      }

      const setErr = await setCrontab(newLines, ctx.signal)
      if (setErr) return { content: safeStringify({ error: setErr }), isError: true }

      return { content: safeStringify({ message: `Cron job "${name}" deleted` }), isError: false }
    },
  }
}

async function getCrontab(signal?: AbortSignal): Promise<{ lines: string[]; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn("crontab", ["-l"], { timeout: TIMEOUT_MS, signal })
    let stdout = ""
    let stderr = ""

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on("error", () => {
      resolve({ lines: [], error: "crontab not available on this system" })
    })

    proc.on("close", (code) => {
      if (code !== 0) {
        if (stderr.includes("no crontab") || stderr.includes("No crontab")) {
          resolve({ lines: [] })
        } else {
          resolve({ lines: [], error: stderr.trim() || "crontab -l failed" })
        }
        return
      }
      const text = stdout || ""
      resolve({ lines: text.split("\n").filter((l) => !l.endsWith("\r")).map((l) => l.replace(/\r$/, "")) })
    })
  })
}

async function setCrontab(lines: string[], signal?: AbortSignal): Promise<string | undefined> {
  const input = lines.join("\n") + (lines.length > 0 && !lines[lines.length - 1] ? "" : "\n")

  return new Promise((resolve) => {
    const proc = spawn("crontab", ["-"], { timeout: TIMEOUT_MS, signal })
    let stderr = ""

    proc.stdin.write(input)
    proc.stdin.end()

    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })

    proc.on("error", (err) => {
      resolve(err.message)
    })

    proc.on("close", (code) => {
      if (code !== 0) {
        resolve(stderr.trim() || "crontab update failed")
      } else {
        resolve(undefined)
      }
    })
  })
}

function parseJobs(lines: string[]): Array<{ name: string; schedule: string; command: string }> {
  const jobs: Array<{ name: string; schedule: string; command: string }> = []

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(new RegExp(`^${escapeRegex(JOB_MARKER)}(\\S+)`))
    if (!match) continue

    const name = match[1]
    i++
    while (i < lines.length && (!lines[i].trim() || lines[i].startsWith("#"))) {
      i++
    }
    if (i >= lines.length) break

    const parts = lines[i].trim().split(/\s+/)
    if (parts.length >= 6) {
      const schedule = parts.slice(0, 5).join(" ")
      const command = parts.slice(5).join(" ")
      jobs.push({ name, schedule, command })
    }
  }

  return jobs
}

function deleteJob(lines: string[], name: string): string[] {
  const result: string[] = []
  const marker = `${JOB_MARKER}${name}`
  let skipping = false

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === marker) {
      skipping = true
      continue
    }
    if (skipping) {
      const trimmed = lines[i].trim()
      if (!trimmed || trimmed.startsWith("#")) {
        skipping = false
        continue
      }
      skipping = false
      continue
    }
    result.push(lines[i])
  }

  return result
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
