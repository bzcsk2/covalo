import { spawn } from "node:child_process"
import * as os from "node:os"
import { resolve } from "node:path"
import type { AgentTool } from "../../core/src/interface.js"
import { safeStringify, hasBinaryEncoding } from "./safe-stringify.js"
import { isSensitive } from "./sensitive.js"

const DENY_PATTERNS = [
  /\brm\s+(?:-[A-Za-z]*r[A-Za-z]*\s+.*\/\*|.*-[A-Za-z]*r[A-Za-z]*\s+\/)/, // catch rm -rf / or rm -rf /*
  /\bsudo\b/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bdd\b/,
  /\bfdisk\b/,
  /\bmkfs\.\w+\b/,
  /\bgit\s+push\b/,
  /\bgit\s+commit\b/,
]

function isDenied(command: string): string | null {
  for (const p of DENY_PATTERNS) {
    if (p.test(command.trim())) return p.source
  }
  return null
}

export function createBashTool(): AgentTool {
  return {
    name: "bash",
    description: "Run a shell command (bash). Returns stdout+stderr (truncated).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: { type: "string", description: "Working directory (optional)." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds." },
        max_chars: { type: "number", description: "Max chars for combined output." },
      },
      required: ["command"],
    },
    concurrency: "exclusive",
    approval: "exec",
    async execute(args, ctx) {
      if (typeof args.command !== "string" || !args.command.trim()) {
        return { content: safeStringify({ error: "command is required" }), isError: true }
      }
      const command = args.command.trim()
      const denied = isDenied(command)
      if (denied) {
        return { content: safeStringify({ error: `Command denied: matches dangerous pattern /${denied}/` }), isError: true }
      }
      // Extract file paths from command and check sensitive files
      const pathRe = /\b([\w./-]*(?:\.\w{1,10}))\b/g
      let pathMatch: RegExpExecArray | null
      while ((pathMatch = pathRe.exec(command)) !== null) {
        const fp = pathMatch[1]
        if (isSensitive(fp)) {
          return { content: safeStringify({ error: `Command references sensitive file: ${fp}` }), isError: true }
        }
      }
      const cwd = typeof args.cwd === "string" ? resolve(ctx.cwd, args.cwd) : ctx.cwd
      const timeoutMs = typeof args.timeout_ms === "number" ? Math.max(0, Math.floor(args.timeout_ms)) : 30_000
      const maxChars = typeof args.max_chars === "number" ? Math.max(0, Math.floor(args.max_chars)) : 200_000

      const out = await runBash(command, cwd, timeoutMs, maxChars, ctx.signal)
      if (hasBinaryEncoding(out.stdout) || hasBinaryEncoding(out.stderr)) {
        ;(out as any).encoding_warning = "output contains non-UTF-8 binary data"
      }
      return { content: safeStringify(out), isError: out.exitCode !== 0, metadata: { exitCode: out.exitCode } }
    },
  }
}

async function runBash(command: string, cwd: string, timeoutMs: number, maxChars: number, signal?: AbortSignal): Promise<{
  command: string
  cwd: string
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}> {
  return await new Promise((resolve, reject) => {
    const isWindows = os.platform() === "win32"
    // Use detached to create a process group on Unix, so we can kill children (zombies)
    const child = spawn("bash", ["-c", command], {
      cwd, detached: !isWindows,
      env: { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", EDITOR: "true" },
    })
    
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let done = false
    let sigtermTimer: ReturnType<typeof setTimeout> | null = null

    const killChild = (graceful = false) => {
      try {
        if (graceful) {
          // SIGTERM first, then SIGKILL after grace period
          if (!isWindows && child.pid) {
            process.kill(-child.pid, "SIGTERM")
          } else {
            child.kill("SIGTERM")
          }
          sigtermTimer = setTimeout(() => {
            try {
              if (!isWindows && child.pid) {
                process.kill(-child.pid, "SIGKILL")
              } else {
                child.kill("SIGKILL")
              }
            } catch {
              child.kill("SIGKILL")
            }
          }, 5000)
          return
        }
        if (!isWindows && child.pid) {
          process.kill(-child.pid, "SIGKILL")
        } else {
          child.kill("SIGKILL")
        }
      } catch {
        child.kill("SIGKILL")
      }
    }

    const finish = (exitCode: number) => {
      if (done) return
      done = true
      if (sigtermTimer) {
        clearTimeout(sigtermTimer)
        sigtermTimer = null
      }
      resolve({
        command,
        cwd,
        stdout: truncate(stdout, maxChars),
        stderr: truncate(stderr, maxChars),
        exitCode,
        timedOut,
      })
    }

    const timer = setTimeout(() => {
      timedOut = true
      killChild(true)
      finish(124)
    }, timeoutMs)

    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer)
        if (sigtermTimer) clearTimeout(sigtermTimer)
        killChild()
        finish(130)
        return
      }
      signal.addEventListener("abort", () => {
        clearTimeout(timer)
        if (sigtermTimer) clearTimeout(sigtermTimer)
        killChild()
        finish(130)
      }, { once: true })
    }

    child.stdout.on("data", (b) => { stdout += String(b) })
    child.stderr.on("data", (b) => { stderr += String(b) })
    child.on("error", (e) => {
      clearTimeout(timer)
      if (sigtermTimer) clearTimeout(sigtermTimer)
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      finish(code ?? 0)
    })
  })
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n... [truncated: ${s.length - max} more chars]`
}
