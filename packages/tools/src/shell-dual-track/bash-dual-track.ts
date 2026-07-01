/**
 * Shell 双轨执行工具逻辑。
 *
 * - short → 前台短超时
 * - long  → 默认后台
 * - auto  → 前台，超过软超时升级到后台
 * - action: check / list / stop 支持增量 cursor
 */

import { spawn, type ChildProcess } from "node:child_process"
import { resolve } from "node:path"
import type { AgentTool, ToolContext, ToolProgressUpdate } from "@deepreef/core"
import { safeStringify, hasBinaryEncoding } from "../safe-stringify.js"
import { normalizePlatform } from "../platform/capabilities.js"
import { resolveShellBackend, type ShellBackendId } from "../platform/shell-backend.js"
import { spawnProcess, terminateProcessTree } from "../platform/process-tree.js"
import {
  classifyShellCommand,
  pickBackgroundHardTimeout,
  pickForegroundTimeout,
  HARD_TIMEOUT_LONG_MS,
  SOFT_TIMEOUT_MS,
} from "./shell-runtime-classifier.js"
import { getBackgroundTaskManagerFor } from "./background-task-manager.js"
import { isDestructiveShellCommand, validateShellCommand } from "./shell-security.js"

const DEFAULT_TIMEOUT = 30_000
const DEFAULT_MAX_CHARS = 200_000

function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(-maxChars) + `\n... [truncated: ${text.length - maxChars} more chars]`
}

export interface DualTrackBashOptions {
  /** 工具名称，默认 bash */
  name?: string
}

interface BoundedBuffer {
  text: string
  max: number
  dropped: number
}

function pushBounded(buf: BoundedBuffer, chunk: string): void {
  buf.text += chunk
  if (buf.text.length > buf.max * 2) {
    const excess = buf.text.length - buf.max
    buf.text = buf.text.slice(excess)
    buf.dropped += excess
  }
}

function finalizeBounded(buf: BoundedBuffer): { text: string; dropped: number } {
  if (buf.dropped > 0) {
    return {
      text: buf.text.slice(-buf.max) + `\n... [dropped ${buf.dropped} earlier chars]`,
      dropped: buf.dropped,
    }
  }
  if (buf.text.length > buf.max) {
    return {
      text: buf.text.slice(-buf.max) + `\n... [truncated: ${buf.text.length - buf.max} more chars]`,
      dropped: buf.text.length - buf.max,
    }
  }
  return { text: buf.text, dropped: 0 }
}

function createProgressThrottle(report?: (update: ToolProgressUpdate) => void): (update: ToolProgressUpdate) => void {
  if (!report) return () => {}
  let lastContent = ""
  let lastTs = 0
  const MIN_INTERVAL = 200
  return (update) => {
    const now = Date.now()
    if (update.content !== lastContent && now - lastTs >= MIN_INTERVAL) {
      lastContent = update.content
      lastTs = now
      report(update)
    }
  }
}

/**
 * 创建支持双轨执行的 bash 工具。
 */
export function createDualTrackBashTool(options: DualTrackBashOptions = {}): AgentTool {
  return {
    name: options.name ?? "bash",
    description:
      "Run shell commands with dual-track execution. Short commands (git status, ls, echo) run foreground with a 10s cap. Long jobs (npm test/build/dev, vitest, docker build) start in background and return task_id. Ambiguous commands run foreground but escalate to background after 8s if still running. Use action:\"check\" with task_id and since (cursor) to poll incremental output. Use action:\"list\" to list background tasks. Use action:\"stop\" to kill a running task. Force background with background:true; never use background for destructive commands.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: { type: "string", description: "Working directory (optional)." },
        timeout_ms: { type: "number", description: "Timeout in milliseconds for foreground execution." },
        max_chars: { type: "number", description: "Max chars for combined foreground output." },
        background: { type: "boolean", description: "Force background execution; returns task_id immediately." },
        task_id: { type: "string", description: "Background task ID for check/stop actions." },
        action: { type: "string", description: "Background management: check, stop, or list." },
        label: { type: "string", description: "Optional label for background tasks." },
        since: { type: "number", description: "For action:check — return output since this cursor (from previous check)." },
      },
      required: [],
    },
    concurrency: "exclusive",
    approval: "exec",
    async execute(args, ctx) {
      const sessionId = ctx.sessionId || "default"
      const bgManager = getBackgroundTaskManagerFor(sessionId, ctx.cwd)
      const action = typeof args.action === "string" ? args.action : ""

      if (action === "list") {
        const tasks = bgManager.list()
        if (tasks.length === 0) {
          return { content: safeStringify({ mode: "list", tasks: [], message: "No background tasks." }), isError: false }
        }
        return {
          content: safeStringify({
            mode: "list",
            tasks: tasks.map((t) => ({
              taskId: t.taskId,
              label: t.label,
              status: t.status,
              elapsed: t.elapsed,
              ...(t.exitCode !== null ? { exitCode: t.exitCode } : {}),
            })),
          }),
          isError: false,
        }
      }

      const taskId = typeof args.task_id === "string" ? args.task_id : ""

      if (action === "check") {
        if (!taskId) {
          return { content: safeStringify({ error: "task_id is required for check action" }), isError: true }
        }
        const status = bgManager.getStatus(taskId)
        if (!status) {
          return {
            content: safeStringify({
              error: `Task ${taskId} not found. Run action:"list" for active tasks.`,
            }),
            isError: true,
          }
        }
        const since = typeof args.since === "number" && args.since >= 0 ? args.since : 0
        const incremental = bgManager.getOutputSince(taskId, since)
        const tailOutput = bgManager.getOutput(taskId, 100) || ""
        const result: Record<string, unknown> = {
          mode: "check",
          taskId: status.taskId,
          label: status.label,
          command: status.command,
          status: status.status,
          elapsed: status.elapsed,
          cursor: incremental?.cursor ?? 0,
          truncated: incremental?.truncated ?? false,
          hasMore: status.status === "running",
          output: (incremental?.output || (since === 0 ? tailOutput : "")) || "(no new output)",
        }
        if (status.exitCode !== null) result.exitCode = status.exitCode
        if (status.error) result.error = status.error
        return {
          content: safeStringify(result),
          isError: status.status === "failed" || status.status === "timeout" || status.status === "killed",
          metadata: status.exitCode !== null ? { exitCode: status.exitCode } : undefined,
        }
      }

      if (action === "stop") {
        if (!taskId) {
          return { content: safeStringify({ error: "task_id is required for stop action" }), isError: true }
        }
        const status = bgManager.getStatus(taskId)
        if (!status) {
          return {
            content: safeStringify({ error: `Task ${taskId} not found.` }),
            isError: true,
          }
        }
        if (status.status !== "running") {
          return {
            content: safeStringify({ error: `Task ${taskId} is not running (status: ${status.status})` }),
            isError: true,
          }
        }
        const killed = bgManager.kill(taskId)
        return killed
          ? { content: safeStringify({ mode: "stop", taskId, message: `Task ${taskId} terminated.` }), isError: false }
          : { content: safeStringify({ error: `Failed to stop task ${taskId}` }), isError: true }
      }

      if (typeof args.command !== "string" || !args.command.trim()) {
        return { content: safeStringify({ error: "command is required" }), isError: true }
      }

      const command = args.command.trim()
      const cwd = typeof args.cwd === "string" ? resolve(ctx.cwd, args.cwd) : ctx.cwd
      bgManager.setWorkDir(cwd)

      let backend
      try {
        backend = await resolveShellBackend(normalizePlatform())
      } catch (error) {
        return {
          content: safeStringify({ error: error instanceof Error ? error.message : String(error) }),
          isError: true,
        }
      }

      const security = validateShellCommand(command, backend.id, cwd)
      if (!security.ok) {
        return { content: safeStringify({ error: security.error }), isError: true }
      }

      const shellClass = classifyShellCommand(command)
      const maxChars = typeof args.max_chars === "number" ? Math.max(0, Math.floor(args.max_chars)) : DEFAULT_MAX_CHARS

      if (ctx.sandboxProvider) {
        const timeoutMs = pickForegroundTimeout(
          shellClass,
          typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
          DEFAULT_TIMEOUT,
        )
        const result = await ctx.sandboxProvider.run({
          command,
          cwd,
          timeoutMs,
          allowNetwork: false,
          readRoots: [cwd],
          writeRoots: [cwd],
        })
        const out = {
          mode: "foreground" as const,
          backend: "sandbox",
          command,
          cwd,
          stdout: truncateOutput(result.stdout, maxChars),
          stderr: truncateOutput(result.stderr, maxChars),
          exitCode: result.exitCode ?? 1,
          timedOut: result.timedOut,
          classifiedAs: shellClass,
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

      const explicitBackground = args.background === true
      const explicitForeground = args.background === false
      const destructive = isDestructiveShellCommand(command, backend.id)

      const shouldBackground =
        !destructive &&
        !explicitForeground &&
        (explicitBackground || shellClass === "long")

      if (shouldBackground) {
        const userTimeoutMs = typeof args.timeout_ms === "number" ? args.timeout_ms : 0
        const hardTimeoutMs = userTimeoutMs > 0
          ? userTimeoutMs
          : pickBackgroundHardTimeout(shellClass, { explicitBackground })
        const label = typeof args.label === "string" ? args.label : ""
        const bgResult = await bgManager.spawn(command, hardTimeoutMs, label)
        if (bgResult.error) {
          return { content: safeStringify({ error: bgResult.error }), isError: true }
        }
        const bgStatus = bgManager.getStatus(bgResult.taskId)
        return {
          content: safeStringify({
            mode: "background",
            taskId: bgResult.taskId,
            status: "started",
            label: bgStatus?.label || label,
            timeout: `${hardTimeoutMs / 1000}s`,
            classifiedAs: shellClass,
            message: "Task started in background. Use action:\"check\" with task_id to poll progress.",
          }),
          isError: false,
        }
      }

      const timeoutMs = pickForegroundTimeout(
        shellClass,
        typeof args.timeout_ms === "number" ? args.timeout_ms : undefined,
        DEFAULT_TIMEOUT,
      )
      const enableEscalate = shellClass === "auto" && !explicitForeground

      const out = await runForegroundShell({
        command,
        cwd,
        timeoutMs,
        maxChars,
        signal: ctx.signal,
        reportProgress: ctx.reportProgress,
        backend,
        enableEscalate,
        bgManager,
        label: typeof args.label === "string" ? args.label : command.substring(0, 40),
      })

      if (out.mode === "foreground") {
        if (hasBinaryEncoding(out.stdout) || hasBinaryEncoding(out.stderr)) {
          ;(out as Record<string, unknown>).encoding_warning = "output contains non-UTF-8 binary data"
        }
      }

      return {
        content: safeStringify(out),
        isError: out.mode === "foreground" ? out.exitCode !== 0 : false,
        metadata: out.mode === "foreground" ? { exitCode: out.exitCode } : undefined,
      }
    },
  }
}

interface ForegroundRunOptions {
  command: string
  cwd: string
  timeoutMs: number
  maxChars: number
  signal?: AbortSignal
  reportProgress?: (update: ToolProgressUpdate) => void
  backend: { id: ShellBackendId; executable: string; args: string[] }
  enableEscalate: boolean
  bgManager: ReturnType<typeof getBackgroundTaskManagerFor>
  label: string
}

type ForegroundRunResult =
  | {
      mode: "foreground"
      backend: ShellBackendId
      command: string
      cwd: string
      stdout: string
      stderr: string
      exitCode: number
      timedOut: boolean
      classifiedAs?: string
    }
  | {
      mode: "escalated"
      taskId: string
      reason: "soft_timeout"
      partialOutput: string
      hint: string
      classifiedAs: string
    }

async function runForegroundShell(opts: ForegroundRunOptions): Promise<ForegroundRunResult> {
  const platform = normalizePlatform()
  return await new Promise((resolvePromise, reject) => {
    const child = spawnProcess(
      opts.backend.executable,
      [...opts.backend.args, opts.command],
      {
        cwd: opts.cwd,
        env: { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", EDITOR: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      },
      platform,
    )

    const stdoutBuf: BoundedBuffer = { text: "", max: opts.maxChars, dropped: 0 }
    const stderrBuf: BoundedBuffer = { text: "", max: opts.maxChars, dropped: 0 }
    let timedOut = false
    let done = false
    let escalated = false
    let sigtermTimer: ReturnType<typeof setTimeout> | null = null
    const report = createProgressThrottle(opts.reportProgress)

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
      if (opts.signal) {
        opts.signal.removeEventListener("abort", onAbort)
      }
    }

    const onAbort = () => {
      clearTimeout(hardTimer)
      if (softTimer) clearTimeout(softTimer)
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
        mode: "foreground",
        backend: opts.backend.id,
        command: opts.command,
        cwd: opts.cwd,
        stdout: stdoutFinal.text,
        stderr: stderrFinal.text,
        exitCode,
        timedOut,
        classifiedAs: classifyShellCommand(opts.command),
      })
    }

    const hardTimer = setTimeout(() => {
      if (escalated || done) return
      timedOut = true
      killChild(true)
      finish(124)
    }, opts.timeoutMs)

    let softTimer: ReturnType<typeof setTimeout> | null = null
    if (opts.enableEscalate) {
      softTimer = setTimeout(() => {
        if (done || timedOut) return

        // Try to adopt BEFORE detaching foreground listeners.
        // adopt() checks background capacity internally via attachChildHandlers.
        // If adopt succeeds, foreground listeners are removed; if it fails,
        // the child remains fully managed by foreground listeners + hard timer.
        const stdout = finalizeBounded(stdoutBuf).text
        const stderr = finalizeBounded(stderrBuf).text
        const prefix = stdout + (stderr ? `\n[stderr]\n${stderr}` : "")
        const adoptResult = opts.bgManager.adopt(child, {
          command: opts.command,
          label: opts.label,
          prefixOutput: prefix,
          hardTimeoutMs: HARD_TIMEOUT_LONG_MS,
          backend: opts.backend.id,
          reason: "soft_timeout",
        })

        if (adoptResult.error) {
          // Capacity full or other error — keep running in foreground
          return
        }

        // Adopt succeeded — flag before detaching to prevent race on close
        escalated = true
        clearTimeout(hardTimer)
        try { child.stdout?.removeAllListeners("data") } catch { /* ignore */ }
        try { child.stderr?.removeAllListeners("data") } catch { /* ignore */ }
        try { child.removeAllListeners("close") } catch { /* ignore */ }
        try { child.removeAllListeners("error") } catch { /* ignore */ }

        done = true
        cleanup()
        resolvePromise({
          mode: "escalated",
          taskId: adoptResult.taskId,
          reason: "soft_timeout",
          partialOutput: prefix.slice(-2000),
          hint: "Command still running after 8s; moved to background. Poll with action:\"check\" and task_id.",
          classifiedAs: "auto",
        })
      }, SOFT_TIMEOUT_MS)
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(hardTimer)
        if (softTimer) clearTimeout(softTimer)
        cleanup()
        killChild()
        finish(130)
        return
      }
      opts.signal.addEventListener("abort", onAbort, { once: true })
    }

    child.stdout?.on("data", (b) => {
      const chunk = String(b)
      pushBounded(stdoutBuf, chunk)
      report({ content: `stdout: ${chunk.slice(-200)}` })
    })
    child.stderr?.on("data", (b) => {
      const chunk = String(b)
      pushBounded(stderrBuf, chunk)
      report({ content: `stderr: ${chunk.slice(-200)}` })
    })
    child.on("error", (e) => {
      clearTimeout(hardTimer)
      if (softTimer) clearTimeout(softTimer)
      cleanup()
      reject(e)
    })
    child.on("close", (code) => {
      if (escalated || done) return
      if (softTimer) clearTimeout(softTimer)
      clearTimeout(hardTimer)
      finish(code ?? 0)
    })
  })
}

/** 跨平台 sleep 命令（用于测试） */
export function sleepCommand(seconds: number): string {
  if (process.platform === "win32") {
    return `Start-Sleep -Seconds ${seconds}`
  }
  return `sleep ${seconds}`
}

/** 直接 spawn 用于 adopt 单元测试 — 使用与 dual-track tool 相同的 shell */
export function spawnTestShell(command: string, cwd: string): ChildProcess {
  const platform = normalizePlatform()
  if (platform === "win32") {
    return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      cwd, stdio: ["ignore", "pipe", "pipe"],
    })
  }
  return spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] })
}
