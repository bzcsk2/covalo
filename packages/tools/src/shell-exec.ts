import { spawn } from "node:child_process"
import type { AgentTool, ToolProgressUpdate } from "@covalo/core"
import { safeStringify, hasBinaryEncoding } from "./safe-stringify.js"
import { normalizePlatform } from "./platform/capabilities.js"
import { terminateProcessTree } from "./platform/process-tree.js"
import { resolveShellBackend, type ShellBackendId } from "./platform/shell-backend.js"
import { validateShellCommand } from "./shell-dual-track/shell-security.js"
import { createDualTrackBashTool } from "./shell-dual-track/bash-dual-track.js"
import { truncateOutput, pushBounded, finalizeBounded, createProgressThrottle, type BoundedBuffer } from "./shell-output-buffer.js"
import { resolvePath, PathContainmentError } from "./resolve-path.js"

export interface BashToolOptions {
  /** 启用 Shell 双轨执行（short 前台 / long 后台 / auto 软超时升级） */
  dualTrack?: boolean
}

/**
 * 创建 bash 工具。默认前台单轨；`dualTrack: true` 启用双轨执行。
 */
export function createBashTool(options: BashToolOptions = {}): AgentTool {
  if (options.dualTrack) {
    return createDualTrackBashTool()
  }
  return createForegroundBashTool()
}

/** 前台单轨 bash 工具（原有行为） */
function createForegroundBashTool(): AgentTool {
  return {
    name: "bash",
    description: "Run a command using the current platform shell. The historical tool name remains bash for compatibility. Returns stdout+stderr (truncated).",
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
      let backend
      try {
        backend = await resolveShellBackend(normalizePlatform())
      } catch (error) {
        return { content: safeStringify({ error: error instanceof Error ? error.message : String(error) }), isError: true }
      }
      let cwd: string
      try {
        cwd = typeof args.cwd === "string" ? await resolvePath(args.cwd, ctx.cwd) : ctx.cwd
      } catch (e) {
        if (e instanceof PathContainmentError) {
          return { content: safeStringify({ error: `cwd is outside the project directory: ${args.cwd}` }), isError: true }
        }
        return { content: safeStringify({ error: `cannot resolve cwd: ${args.cwd}` }), isError: true }
      }
      const security = validateShellCommand(command, backend.id, cwd)
      if (!security.ok) {
        return { content: safeStringify({ error: security.error }), isError: true }
      }
      const timeoutMs = typeof args.timeout_ms === "number" ? Math.max(0, Math.floor(args.timeout_ms)) : 30_000
      const maxChars = typeof args.max_chars === "number" ? Math.max(0, Math.floor(args.max_chars)) : 200_000

      if (ctx.sandboxProvider) {
        const result = await ctx.sandboxProvider.run({
          command,
          cwd,
          timeoutMs,
          allowNetwork: false,
          readRoots: [cwd],
          writeRoots: [cwd],
        })
        const out = {
          backend: "sandbox",
          command,
          cwd,
          stdout: truncateOutput(result.stdout, maxChars),
          stderr: truncateOutput(result.stderr, maxChars),
          exitCode: result.exitCode ?? 1,
          timedOut: result.timedOut,
        }
        if (hasBinaryEncoding(out.stdout) || hasBinaryEncoding(out.stderr)) {
          ;(out as Record<string, unknown>).encoding_warning = "output contains non-UTF-8 binary data"
        }
        return {
          content: safeStringify(out),
          isError: out.exitCode !== 0,
          metadata: { exitCode: out.exitCode, providerId: ctx.sandboxProvider.id },
        }
      }

      const out = await runShell(command, cwd, timeoutMs, maxChars, ctx.signal, ctx.reportProgress, backend)
      if (hasBinaryEncoding(out.stdout) || hasBinaryEncoding(out.stderr)) {
        ;(out as Record<string, unknown>).encoding_warning = "output contains non-UTF-8 binary data"
      }
      return { content: safeStringify(out), isError: out.exitCode !== 0, metadata: { exitCode: out.exitCode } }
    },
  }
}



async function runShell(command: string, cwd: string, timeoutMs: number, maxChars: number, signal: AbortSignal | undefined, reportProgress: ((update: ToolProgressUpdate) => void) | undefined, backend: { id: ShellBackendId; executable: string; args: string[] }): Promise<{
  backend: ShellBackendId
  command: string
  cwd: string
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}> {
  return await new Promise((resolvePromise, reject) => {
    const platform = normalizePlatform()
    const child = spawn(backend.executable, [...backend.args, command], {
      cwd, detached: platform !== "win32",
      env: { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", EDITOR: "true" },
    })

    const stdoutBuf: BoundedBuffer = { text: "", max: maxChars, dropped: 0 }
    const stderrBuf: BoundedBuffer = { text: "", max: maxChars, dropped: 0 }
    let timedOut = false
    let done = false
    let sigtermTimer: ReturnType<typeof setTimeout> | null = null

    const report = createProgressThrottle(reportProgress)

    const killChild = (graceful = false) => {
      terminateProcessTree(child, !graceful, platform)
      if (graceful) {
        sigtermTimer = setTimeout(() => {
          terminateProcessTree(child, true, platform)
        }, 5000)
      }
    }

    const cleanup = () => {
      if (sigtermTimer) {
        clearTimeout(sigtermTimer)
        sigtermTimer = null
      }
      if (signal) {
        signal.removeEventListener("abort", onAbort)
      }
    }

    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      killChild()
      finish(130)
    }

    const finish = (exitCode: number) => {
      if (done) return
      done = true
      cleanup()
      const stdoutFinal = finalizeBounded(stdoutBuf)
      const stderrFinal = finalizeBounded(stderrBuf)
      resolvePromise({
        backend: backend.id,
        command,
        cwd,
        stdout: stdoutFinal.text,
        stderr: stderrFinal.text,
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
        cleanup()
        killChild()
        finish(130)
        return
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }

    child.stdout.on("data", (b) => {
      const chunk = String(b)
      pushBounded(stdoutBuf, chunk)
      report({ content: `stdout: ${chunk.slice(-200)}` })
    })
    child.stderr.on("data", (b) => {
      const chunk = String(b)
      pushBounded(stderrBuf, chunk)
      report({ content: `stderr: ${chunk.slice(-200)}` })
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      cleanup()
      reject(e)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      finish(code ?? 0)
    })
  })
}
