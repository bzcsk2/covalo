import { spawn } from "node:child_process"
import { resolve } from "node:path"
import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"
import { isSensitive } from "./sensitive.js"
import { terminateProcessTree } from "./platform/process-tree.js"
import { normalizePlatform } from "./platform/capabilities.js"

export function createWorktreeTool(): AgentTool {
  return {
    name: "Worktree",
    description: "Manage git worktrees for isolated development. Create (enter) or remove (exit) a git worktree.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["enter", "exit"],
          description: "enter to create a worktree, exit to remove one.",
        },
        branch: { type: "string", description: "Branch name to create (required for enter)." },
        path: { type: "string", description: "Worktree path (optional for enter, required for exit)." },
      },
      required: ["action"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args, ctx) {
      const action = args.action as string | undefined
      if (!action || !["enter", "exit"].includes(action)) {
        return { content: safeStringify({ error: "action must be 'enter' or 'exit'" }), isError: true }
      }

      const gitCheck = await runGit(["rev-parse", "--git-dir"], ctx.cwd, 5000, ctx.signal)
      if (gitCheck.exitCode !== 0) {
        return { content: safeStringify({ error: "Not a git repository or git not available" }), isError: true }
      }

      if (action === "enter") {
        const branch = args.branch as string | undefined
        if (!branch) {
          return { content: safeStringify({ error: "branch is required for enter action" }), isError: true }
        }
        const worktreePath = typeof args.path === "string" ? resolve(ctx.cwd, args.path) : resolve(ctx.cwd, "..", `${branch}-worktree`)
        if (isSensitive(worktreePath)) {
          return { content: safeStringify({ error: `Cannot create worktree at sensitive path: ${worktreePath}` }), isError: true }
        }

        const result = await runGit(["worktree", "add", worktreePath, branch], ctx.cwd, 30000, ctx.signal)
        if (result.exitCode !== 0) {
          return { content: safeStringify({ error: `Failed to create worktree: ${result.stderr}` }), isError: true }
        }

        return { content: safeStringify({ path: worktreePath, branch, message: `Worktree created at ${worktreePath}` }), isError: false }
      }

      const worktreePath = args.path as string | undefined
      if (!worktreePath) {
        return { content: safeStringify({ error: "path is required for exit action" }), isError: true }
      }

      const result = await runGit(["worktree", "remove", worktreePath], ctx.cwd, 30000, ctx.signal)
      if (result.exitCode !== 0) {
        return { content: safeStringify({ error: `Failed to remove worktree: ${result.stderr}` }), isError: true }
      }

      return { content: safeStringify({ path: worktreePath, message: "Worktree removed" }), isError: false }
    },
  }
}

function runGit(args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const platform = normalizePlatform()
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, detached: platform !== "win32" })
    let stdout = ""
    let stderr = ""
    let done = false

    const finish = (exitCode: number) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ exitCode, stdout: stdout.trim(), stderr: stderr.trim() })
    }

    const timer = setTimeout(() => {
      terminateProcessTree(child, true, platform)
      finish(124)
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) { terminateProcessTree(child, true, platform); finish(130); return }
      signal.addEventListener("abort", () => { terminateProcessTree(child, true, platform); finish(130) }, { once: true })
    }

    child.stdout.on("data", (b) => { stdout += String(b) })
    child.stderr.on("data", (b) => { stderr += String(b) })
    child.on("close", (code) => { finish(code ?? 0) })
    child.on("error", () => { finish(1) })
  })
}
