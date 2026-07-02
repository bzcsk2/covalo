/**
 * 后台 Shell 任务管理器。
 *
 * 管理后台运行的 shell 进程，支持：
 * - 启动后台命令（立即返回 task ID）
 * - 查询任务状态与增量输出（cursor）
 * - 终止任务
 * - 软超时 escalate 时 adopt 前台子进程
 * - 超时自动终止与完成后自动清理
 *
 * 复用 Deepreef 平台 shell backend 与进程树终止逻辑。
 */

import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdirSync, createWriteStream, type WriteStream } from "node:fs"
import path from "node:path"
import { normalizePlatform } from "../platform/capabilities.js"
import { spawnProcess, terminateProcessTree } from "../platform/process-tree.js"
import { resolveShellBackend, type ShellBackendId } from "../platform/shell-backend.js"
import { validateShellCommand } from "./shell-security.js"

/** 任务状态 */
export type BackgroundTaskStatus = "running" | "completed" | "failed" | "timeout" | "killed"

/** 后台任务信息（内部） */
export interface BackgroundTask {
  taskId: string
  command: string
  label: string
  status: BackgroundTaskStatus
  child: ChildProcess | null
  /** 环形缓冲区：最近的输出行 */
  outputLines: string[]
  startTime: number
  endTime: number | null
  exitCode: number | null
  error: string | null
  /** 任务期间累计输出行数（含被环形缓冲淘汰的） */
  totalOutputLines: number
  /** 最近一次有 stdout/stderr 数据到达的时刻 */
  lastOutputAt: number
  /** 落盘日志写流；null 表示未启用落盘 */
  logStream: WriteStream | null
  /** 落盘日志路径（绝对路径） */
  logPath: string | null
  /** spawn 时的根 PID */
  rootPid: number | null
  backend: ShellBackendId
  /** hard timeout timer，用于超时后清理 */
  hardTimer?: ReturnType<typeof setTimeout> | null
}

/** 任务状态摘要（返回给调用方，不含 child 引用） */
export interface BackgroundTaskSummary {
  taskId: string
  command: string
  label: string
  status: BackgroundTaskStatus
  elapsed: string
  exitCode: number | null
  error: string | null
  lineCount: number
}

/** 增量输出查询结果 */
export interface OutputSinceResult {
  /** 新增行文本 */
  output: string
  /** 下次应传入的 cursor（即当前 totalOutputLines） */
  cursor: number
  /** since 早于当前环形缓冲起点时为 true */
  truncated: boolean
}

const MAX_OUTPUT_LINES = 500
const MAX_CONCURRENT = 8
const AUTO_CLEANUP_DELAY = 30 * 60 * 1000

/** 生成短 ID */
function generateId(): string {
  return "bg_" + Math.random().toString(36).substring(2, 8)
}

/** 格式化耗时 */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainSeconds = seconds % 60
  return `${minutes}m${remainSeconds}s`
}

/**
 * 后台 Shell 任务管理器。
 *
 * 每个 sessionId 一个独立实例（通过 {@link getBackgroundTaskManagerFor} 获取）。
 */
export class BackgroundTaskManager extends EventEmitter {
  private tasks = new Map<string, BackgroundTask>()
  private cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private workDir: string
  readonly sessionId: string
  private readonly logDir: string
  private readonly platform = normalizePlatform()

  /**
   * @param workDir 命令执行 cwd
   * @param sessionId 会话标识
   * @param logDir 后台日志目录（可选）
   */
  constructor(workDir: string, sessionId: string = "default", logDir?: string) {
    super()
    this.workDir = path.resolve(workDir)
    this.sessionId = sessionId
    this.logDir = logDir ?? path.join(this.workDir, ".covalo", "sessions", sessionId, "bg")
  }

  /** 当前命令执行 cwd */
  getWorkDir(): string {
    return this.workDir
  }

  /** workspace 切换时更新 spawn cwd */
  setWorkDir(workDir: string): void {
    this.workDir = path.resolve(workDir)
  }

  /** 创建落盘日志写流；失败不抛 */
  private openLogStream(taskId: string): { stream: WriteStream | null; logPath: string | null } {
    try {
      mkdirSync(this.logDir, { recursive: true })
      const logPath = path.join(this.logDir, `${taskId}.log`)
      const stream = createWriteStream(logPath, { flags: "a", encoding: "utf-8" })
      stream.on("error", () => {})
      return { stream, logPath }
    } catch {
      return { stream: null, logPath: null }
    }
  }

  /** 终止任务关联进程 */
  private killTaskProcesses(task: BackgroundTask): void {
    if (task.child) {
      terminateProcessTree(task.child, true, this.platform)
    }
  }

  /**
   * 把已 spawn 的前台 ChildProcess 转交为后台任务（软超时 escalate 专用）。
   */
  adopt(
    child: ChildProcess,
    options: {
      command: string
      label?: string
      prefixOutput?: string
      hardTimeoutMs?: number
      backend: ShellBackendId
      reason?: "soft_timeout" | "explicit_background"
    },
  ): { taskId: string; error?: string } {
    const runningCount = Array.from(this.tasks.values())
      .filter((t) => t.status === "running").length
    if (runningCount >= MAX_CONCURRENT) {
      return {
        taskId: "",
        error: `后台任务数已达上限 (${MAX_CONCURRENT})，请等待其他任务完成`,
      }
    }

    const taskId = generateId()
    const command = options.command
    const hardTimeoutMs = options.hardTimeoutMs ?? 24 * 60 * 60 * 1000
    const now = Date.now()
    const { stream: logStream, logPath } = this.openLogStream(taskId)

    const task: BackgroundTask = {
      taskId,
      command,
      label: options.label || command.substring(0, 50),
      status: "running",
      child,
      outputLines: [],
      startTime: now,
      endTime: null,
      exitCode: null,
      error: null,
      totalOutputLines: 0,
      lastOutputAt: now,
      logStream,
      logPath,
      rootPid: child.pid ?? null,
      backend: options.backend,
    }

    if (options.prefixOutput) {
      this.appendOutput(task, Buffer.from(options.prefixOutput), "")
    }

    this.tasks.set(taskId, task)
    this.attachChildHandlers(task, hardTimeoutMs)
    return { taskId }
  }

  /**
   * 启动后台命令，立即返回 task ID。
   */
  async spawn(
    command: string,
    timeoutMs: number = 300_000,
    label: string = "",
  ): Promise<{ taskId: string; error?: string }> {
    let backend
    try {
      backend = await resolveShellBackend(this.platform)
    } catch (error) {
      return {
        taskId: "",
        error: error instanceof Error ? error.message : String(error),
      }
    }

    const security = validateShellCommand(command, backend.id, this.workDir)
    if (!security.ok) {
      return { taskId: "", error: security.error }
    }

    const runningCount = Array.from(this.tasks.values())
      .filter((t) => t.status === "running").length
    if (runningCount >= MAX_CONCURRENT) {
      return {
        taskId: "",
        error: `后台任务数已达上限 (${MAX_CONCURRENT})，请等待其他任务完成`,
      }
    }

    const taskId = generateId()
    const child = spawnProcess(
      backend.executable,
      [...backend.args, command],
      {
        cwd: this.workDir,
        env: { ...process.env, GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", EDITOR: "true" },
        stdio: ["ignore", "pipe", "pipe"],
      },
      this.platform,
    )

    const now = Date.now()
    const { stream: logStream, logPath } = this.openLogStream(taskId)
    const task: BackgroundTask = {
      taskId,
      command,
      label: label || command.substring(0, 50),
      status: "running",
      child,
      outputLines: [],
      startTime: now,
      endTime: null,
      exitCode: null,
      error: null,
      totalOutputLines: 0,
      lastOutputAt: now,
      logStream,
      logPath,
      rootPid: child.pid ?? null,
      backend: backend.id,
    }

    this.tasks.set(taskId, task)
    this.attachChildHandlers(task, timeoutMs)
    return { taskId }
  }

  /** 挂载子进程事件与 hard timeout */
  private attachChildHandlers(task: BackgroundTask, hardTimeoutMs: number): void {
    const child = task.child
    if (!child) return

    child.stdout?.on("data", (data: Buffer) => this.appendOutput(task, data, ""))
    child.stderr?.on("data", (data: Buffer) => this.appendOutput(task, data, "[stderr] "))

    child.on("close", (code) => {
      if (task.hardTimer) { clearTimeout(task.hardTimer); task.hardTimer = null }
      if (task.status === "running") {
        task.status = code === 0 ? "completed" : "failed"
        task.exitCode = code
        task.endTime = Date.now()
        task.child = null
        this.closeLogStream(task)
        this.scheduleCleanup(task.taskId)
      }
    })

    child.on("error", (err) => {
      if (task.hardTimer) { clearTimeout(task.hardTimer); task.hardTimer = null }
      if (task.status === "running") {
        task.status = "failed"
        task.error = `进程启动失败: ${err.message}`
        task.endTime = Date.now()
        task.child = null
        this.closeLogStream(task)
        this.scheduleCleanup(task.taskId)
      }
    })

    task.hardTimer = setTimeout(() => {
      if (task.status === "running") {
        task.status = "timeout"
        task.error = `执行超时 (${formatElapsed(hardTimeoutMs)})`
        task.endTime = Date.now()
        this.killTaskProcesses(task)
        this.closeLogStream(task)
        setTimeout(() => {
          task.child = null
          this.scheduleCleanup(task.taskId)
        }, 2500)
      }
    }, hardTimeoutMs)
  }

  /** 收集输出到环形缓冲与落盘 */
  private appendOutput(task: BackgroundTask, data: Buffer, prefix: string): void {
    const text = prefix + data.toString()
    task.lastOutputAt = Date.now()

    if (task.logStream) {
      try { task.logStream.write(text) } catch { /* ignore */ }
    }

    const lines = text.split("\n")
    if (lines.length > 1 && lines[lines.length - 1] === "") {
      lines.pop()
    }
    for (const line of lines) {
      task.outputLines.push(line)
      task.totalOutputLines += 1
      if (task.outputLines.length > MAX_OUTPUT_LINES) {
        task.outputLines.splice(0, task.outputLines.length - MAX_OUTPUT_LINES)
      }
    }
    this.emit("taskOutput", { taskId: task.taskId, newLines: lines.length })
  }

  private closeLogStream(task: BackgroundTask): void {
    if (task.logStream) {
      try { task.logStream.end() } catch { /* ignore */ }
      task.logStream = null
    }
  }

  /** 获取任务状态摘要 */
  getStatus(taskId: string): BackgroundTaskSummary | null {
    const task = this.tasks.get(taskId)
    if (!task) return null

    const elapsed = task.endTime
      ? task.endTime - task.startTime
      : Date.now() - task.startTime

    return {
      taskId: task.taskId,
      command: task.command,
      label: task.label,
      status: task.status,
      elapsed: formatElapsed(elapsed),
      exitCode: task.exitCode,
      error: task.error,
      lineCount: task.outputLines.length,
    }
  }

  /** 获取任务输出（最近 N 行） */
  getOutput(taskId: string, tail: number = 50): string | null {
    const task = this.tasks.get(taskId)
    if (!task) return null
    return task.outputLines.slice(-tail).join("\n")
  }

  /**
   * 获取任务的增量输出（自上次 cursor 起）。
   *
   * @param taskId 任务 ID
   * @param since 上次返回的 cursor（首次传 0）
   */
  getOutputSince(taskId: string, since: number = 0): OutputSinceResult | null {
    const task = this.tasks.get(taskId)
    if (!task) return null

    const totalLines = task.totalOutputLines
    const bufferStart = totalLines - task.outputLines.length
    const sinceClamped = Math.max(0, Math.min(since, totalLines))
    const truncated = sinceClamped < bufferStart
    const start = Math.max(0, sinceClamped - bufferStart)
    const newLines = task.outputLines.slice(start)
    return {
      output: newLines.join("\n"),
      cursor: totalLines,
      truncated,
    }
  }

  /** 终止任务 */
  kill(taskId: string): boolean {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== "running") return false

    task.status = "killed"
    task.endTime = Date.now()
    task.error = "被用户终止"
    if (task.hardTimer) { clearTimeout(task.hardTimer); task.hardTimer = null }
    this.appendOutput(task, Buffer.from("[terminated by user]\n"), "")
    this.killTaskProcesses(task)
    this.closeLogStream(task)
    setTimeout(() => {
      task.child = null
    }, 2500)
    this.scheduleCleanup(taskId)
    return true
  }

  /** 列出所有任务（运行中优先） */
  list(): BackgroundTaskSummary[] {
    const result: BackgroundTaskSummary[] = []
    for (const task of this.tasks.values()) {
      const summary = this.getStatus(task.taskId)
      if (summary) result.push(summary)
    }
    return result.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1
      if (b.status === "running" && a.status !== "running") return 1
      return 0
    })
  }

  /** 清理所有资源 */
  dispose(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        this.killTaskProcesses(task)
      }
      if (task.hardTimer) { clearTimeout(task.hardTimer); task.hardTimer = null }
      this.closeLogStream(task)
    }
    for (const timer of this.cleanupTimers.values()) {
      clearTimeout(timer)
    }
    this.tasks.clear()
    this.cleanupTimers.clear()
  }

  private scheduleCleanup(taskId: string): void {
    const timer = setTimeout(() => {
      this.tasks.delete(taskId)
      this.cleanupTimers.delete(taskId)
    }, AUTO_CLEANUP_DELAY)
    this.cleanupTimers.set(taskId, timer)
  }
}

const managersBySession = new Map<string, BackgroundTaskManager>()

/**
 * 获取或创建指定 session 的 BackgroundTaskManager。
 */
export function getBackgroundTaskManagerFor(
  sessionId: string,
  workDir: string,
): BackgroundTaskManager {
  const resolved = path.resolve(workDir)
  let m = managersBySession.get(sessionId)
  if (!m) {
    m = new BackgroundTaskManager(resolved, sessionId)
    managersBySession.set(sessionId, m)
    return m
  }
  if (path.resolve(m.getWorkDir()).toLowerCase() !== resolved.toLowerCase()) {
    m.setWorkDir(resolved)
  }
  return m
}

/** 重置全部 session 的 manager 缓存（仅测试使用） */
export function __resetBackgroundTaskManagers(): void {
  for (const m of managersBySession.values()) {
    try { m.dispose() } catch { /* ignore */ }
  }
  managersBySession.clear()
}

/**
 * P1-fix: 释放指定 session 的 BackgroundTaskManager。
 *
 * 仅在 manager 存在时 dispose 并从缓存删除，避免：
 *  - engine.shutdown() 时后台 shell 子进程、hard timer、log 写流泄漏
 *  - engine.loadSession() 切换 session 时旧 session 的 manager 驻留
 *
 * 与 getBackgroundTaskManagerFor 不同：若 session 从未创建过 manager，
 * 本函数不会创建新实例（避免仅为 dispose 而实例化空 manager）。
 */
export function disposeBackgroundTaskManagerFor(sessionId: string): void {
  const m = managersBySession.get(sessionId)
  if (!m) return
  try {
    m.dispose()
  } catch {
    // best-effort: dispose 失败不应阻塞 shutdown / loadSession
  }
  managersBySession.delete(sessionId)
}
