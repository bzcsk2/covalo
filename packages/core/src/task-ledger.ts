/**
 * TaskLedger — 任务账本与计划锚点
 *
 * DRF-40: 从 SmallCode plan_tracker.js 适配（MIT）
 * Source: smallcode/src/session/plan_tracker.js
 */

import { createHash } from "node:crypto"

import { isHarnessVerificationCommand } from "./governance/verification-command.js"
import { processVerificationCommandResult } from "./governance/verification-gate.js"
import { getPromptLocale } from "./prompt-locale.js"
import type { PromptLocale } from "./prompt-locale.js"

/** 计划步骤状态 */
export type PlanStepStatus = "pending" | "active" | "done" | "blocked"

/** 计划步骤 */
export interface PlanStep {
  id: string
  text: string
  status: PlanStepStatus
}

/** 最近一次验证结果 */
export interface LastVerification {
  command: string
  exitCode: number
  summary: string
}

/** 已执行命令记录 */
export interface CommandRunEntry {
  commandHash: string
  success: boolean
}

/** 任务账本快照 */
export interface TaskLedger {
  goal: string
  plan: PlanStep[]
  changedFiles: string[]
  commandsRun: CommandRunEntry[]
  verificationPending: boolean
  lastVerification?: LastVerification
  blockers: string[]
  evictedFileCount?: number
  evictedCommandCount?: number
}

/** 计划解析/序列化配置 */
export interface PlanTrackerOptions {
  minSteps?: number
  maxSteps?: number
}

/** 默认最少步骤数 */
export const DEFAULT_MIN_STEPS = 2

/** 默认最多步骤数 */
export const DEFAULT_MAX_STEPS = 8

const WRITE_TOOLS = new Set(["write_file", "edit", "NotebookEdit"])
const READ_TOOLS = new Set(["read_file"])
const SHELL_TOOLS = new Set(["bash"])

/** 集合上限防止内存泄漏 */
const MAX_COMMANDS_RUN = 200
const MAX_CHANGED_FILES = 500
const MAX_BLOCKERS = 100

/** 多步骤任务关键词启发式 */
const PLAN_HINTS = [
  /\b(refactor|migrate|rewrite|reorganize)\b/i,
  /\b(implement|build|create)\b.*\b(feature|module|service|api|app|system|project)\b/i,
  /\bstep\s*(by|-)?\s*step\b/i,
  /\b(multiple|several|all)\b.*\b(files?|tests?|functions?|endpoints?)\b/i,
  /\bend.to.end\b/i,
]

/**
 * 判断用户消息是否应创建 TaskLedger（复杂 edit/debug/refactor/test 任务）。
 */
export function shouldCreateLedger(userMessage: string): boolean {
  if (typeof userMessage !== "string" || userMessage.length === 0) return false
  if (process.env.COVALO_TASK_LEDGER === "false") return false
  if (process.env.COVALO_TASK_LEDGER === "true") return true

  if (userMessage.length > 300) return true
  if (PLAN_HINTS.some(p => p.test(userMessage))) return true

  if (userMessage.length > 150) {
    const sentences = userMessage.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 10)
    if (sentences.length >= 3) return true
  }

  return false
}

/**
 * 从模型文本中确定性解析编号/无序计划步骤（不调用 LLM）。
 */
export function parsePlanSteps(
  text: string,
  options: PlanTrackerOptions = {},
): PlanStep[] | null {
  const minSteps = options.minSteps ?? DEFAULT_MIN_STEPS
  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS

  if (typeof text !== "string" || text.length === 0) return null

  const clean = text.replace(/```[\w]*\n?|\n?```/g, "").replace(/\*\*/g, "")

  let body = clean
  const headerMatch = clean.match(/(?:^|\n)(?:plan|steps?|approach):?\s*\n([\s\S]+?)(?=\n\n[A-Z]|$)/i)
  if (headerMatch) body = headerMatch[1]

  const lines = body.split("\n").map(l => l.trim()).filter(Boolean)

  const numbered: string[] = []
  for (const line of lines) {
    const m = line.match(/^(\d{1,2})[.\)\-:]\s+(.+)$/)
    if (m) numbered.push(m[2].trim())
    else if (numbered.length > 0 && /^[a-z]/i.test(line) && !/[:.]$/.test(line) && line.length < 80) {
      numbered[numbered.length - 1] += " " + line
    }
  }
  if (numbered.length >= minSteps) {
    return trimPlanSteps(numbered, maxSteps)
  }

  const bulleted: string[] = []
  for (const line of lines) {
    const m = line.match(/^[-*•]\s+(.+)$/)
    if (m) bulleted.push(m[1].trim())
  }
  if (bulleted.length >= minSteps) {
    return trimPlanSteps(bulleted, maxSteps)
  }

  return null
}

function trimPlanSteps(steps: string[], maxSteps: number): PlanStep[] {
  return steps
    .map(s => (s.length > 200 ? `${s.slice(0, 200)}…` : s))
    .slice(0, maxSteps)
    .map((text, index) => ({
      id: `step-${index + 1}`,
      text,
      status: index === 0 ? "active" as const : "pending" as const,
    }))
}

/**
 * 将计划步骤序列化为 PLAN: 块（确定性，可 round-trip）。
 */
export function serializePlan(steps: PlanStep[]): string {
  if (steps.length === 0) return ""
  const lines = steps.map((step, index) => `${index + 1}. ${step.text}`)
  return `PLAN:\n${lines.join("\n")}`
}

/**
 * 将 TaskLedger 格式化为可变上下文注入片段。
 */
export function formatLedgerForContext(ledger: TaskLedger, locale?: PromptLocale): string {
  const parts: string[] = []
  const isZh = (locale ?? getPromptLocale()) === "zh-CN"

  parts.push(isZh ? `## 任务目标\n${ledger.goal.trim()}` : `## TASK GOAL\n${ledger.goal.trim()}`)

  if (ledger.plan.length > 0) {
    parts.push(formatPlanForContext(ledger.plan))
  }

  if (ledger.changedFiles.length > 0) {
    const listed = ledger.changedFiles.slice(0, 12)
    const more = ledger.changedFiles.length > 12
      ? isZh ? `\n- … 以及其他 ${ledger.changedFiles.length - 12} 个文件`
            : `\n- … and ${ledger.changedFiles.length - 12} more`
      : ""
    parts.push(`${isZh ? "修改的文件" : "CHANGED FILES"} (${ledger.changedFiles.length}):\n${listed.map(f => `- ${f}`).join("\n")}${more}`)
  }

  if (ledger.verificationPending) {
    parts.push(isZh
      ? "验证：待验证——在声明完成前先运行测试/类型检查/构建"
      : "VERIFICATION: pending — run tests/build/typecheck before claiming completion.")
  } else if (ledger.lastVerification) {
    const v = ledger.lastVerification
    parts.push(`${isZh ? "上次验证" : "LAST VERIFICATION"}: 退出码 ${v.exitCode} — ${v.summary}\n${isZh ? "命令" : "Command"}: ${v.command}`)
  }

  if (ledger.blockers.length > 0) {
    parts.push(`${isZh ? "阻塞项" : "BLOCKERS"}:\n${ledger.blockers.map(b => `- ${b}`).join("\n")}`)
  }

  const evictedFileCount = ledger.evictedFileCount ?? 0
  if (evictedFileCount > 0) {
    parts.push(isZh
      ? `更早的变更：${evictedFileCount} 个文件变更未在本 ledger 视图显示。`
      : `EARLIER CHANGES: ${evictedFileCount} file changes omitted from this ledger view.`)
  }

  return isZh ? `\n\n## 任务上下文\n${parts.join("\n\n")}` : `\n\n${parts.join("\n\n")}`
}

/**
 * 将计划步骤渲染为 ACTIVE PLAN 锚点文本。
 */
export function formatPlanForContext(steps: PlanStep[], locale?: PromptLocale): string {
  if (steps.length === 0) return ""
  const isZh = (locale ?? getPromptLocale()) === "zh-CN"

  const total = steps.length
  const doneCount = steps.filter(s => s.status === "done").length
  const allDone = doneCount >= total
  const activeIndex = steps.findIndex(s => s.status === "active")
  const cur = allDone ? total : (activeIndex >= 0 ? activeIndex + 1 : 1)

  let out = allDone
    ? isZh ? `\n\n## 已完成计划（共 ${total} 步）` : `\n\nCOMPLETED PLAN (all ${total} steps done):`
    : isZh ? `\n\n## 当前计划（第 ${cur}/${total} 步）` : `\n\nACTIVE PLAN (step ${cur} of ${total}):`

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    let mark: string
    if (step.status === "done") mark = "✓"
    else if (!allDone && step.status === "active") mark = "→"
    else mark = " "
    out += `\n${mark} ${i + 1}. ${step.text}`
  }

  if (!allDone) {
    out += isZh
      ? `\n\n执行当前步骤（→）。完成后简要说明。`
      : `\n\nWork on the current step (→). When done, mention "step ${cur} done" or move on naturally.`
  }

  return out
}

/** 计划请求指令（注入到首轮上下文） */
export function planRequestInstruction(maxSteps = DEFAULT_MAX_STEPS, locale?: PromptLocale): string {
  const isZh = (locale ?? getPromptLocale()) === "zh-CN"
  if (isZh) {
    return `\n\n这是一个多步骤任务。在工具调用之前，先简要给出编号计划，格式如下：\n\n计划：\n1. <第一步>\n2. <第二步>\n3. <第三步>\n\n不超过 ${maxSteps} 步。\n\n重要：列出计划后立即开始执行第 1 步，不要只列计划就停止。`
  }
  return `\n\nThis is a multi-step task. Before any tool calls, briefly emit a numbered plan in this format:\n\nPLAN:\n1. <first step>\n2. <second step>\n3. <third step>\n\nKeep it to ${maxSteps} steps or fewer.\n\nIMPORTANT: After the plan, IMMEDIATELY start executing step 1 with the appropriate tool call. Do NOT stop after writing the plan.`
}

/**
 * 对命令字符串做确定性哈希（用于 commandsRun 去重统计）。
 */
export function hashCommand(command: string): string {
  return createHash("sha256").update(command.trim()).digest("hex").slice(0, 16)
}

/** 从工具参数提取路径 */
export function extractToolPath(toolName: string, args: Record<string, unknown>): string | undefined {
  if (!WRITE_TOOLS.has(toolName) && !READ_TOOLS.has(toolName)) return undefined
  const raw = args.path ?? args.filePath ?? args.file
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

/** 是否为写入类工具 */
export function isLedgerWriteTool(toolName: string): boolean {
  return WRITE_TOOLS.has(toolName)
}

/** 是否为 shell 工具 */
export function isLedgerShellTool(toolName: string): boolean {
  return SHELL_TOOLS.has(toolName)
}

/**
 * TaskLedgerTracker — 单次 submit 内的任务账本状态机。
 */
export class TaskLedgerTracker {
  private readonly options: Required<PlanTrackerOptions>
  private planIngested = false
  private activeStepIndex = 0

  goal: string
  plan: PlanStep[] = []
  changedFiles: string[] = []
  commandsRun: CommandRunEntry[] = []
  verificationPending = false
  lastVerification?: LastVerification
  blockers: string[] = []
  evictedFileCount = 0
  evictedCommandCount = 0

  constructor(
    goal: string,
    options: PlanTrackerOptions = {},
  ) {
    this.goal = goal
    this.options = {
      minSteps: options.minSteps ?? DEFAULT_MIN_STEPS,
      maxSteps: options.maxSteps ?? DEFAULT_MAX_STEPS,
    }
  }

  /** 尝试从模型响应中提取计划 */
  ingestPlanFromText(text: string): boolean {
    if (this.planIngested || this.plan.length > 0) return false
    const parsed = parsePlanSteps(text, this.options)
    if (!parsed || parsed.length < this.options.minSteps) return false
    this.plan = parsed
    this.planIngested = true
    this.activeStepIndex = 0
    return true
  }

  /** 标记指定步骤完成并推进 active 步骤 */
  completeStep(index: number): void {
    if (index < 0 || index >= this.plan.length) return
    this.plan[index].status = "done"
    while (this.activeStepIndex < this.plan.length && this.plan[this.activeStepIndex].status === "done") {
      this.activeStepIndex++
    }
    if (this.activeStepIndex < this.plan.length) {
      this.plan[this.activeStepIndex].status = "active"
    }
  }

  /** 记录工具执行结果 */
  recordToolResult(
    toolName: string,
    args: Record<string, unknown>,
    result: { isError?: boolean; content?: string; metadata?: Record<string, unknown> },
  ): void {
    const path = extractToolPath(toolName, args)
    const success = !result.isError

    if (isLedgerWriteTool(toolName) && path && success) {
      this.recordFileChange(path)
    }

    if (isLedgerShellTool(toolName)) {
      const command = typeof args.command === "string" ? args.command.trim() : ""
      if (command) {
        this.recordCommandRun(command, success, result)
      }
    }
  }

  /** 记录文件变更并标记待验证 */
  recordFileChange(filePath: string): void {
    const normalized = filePath.replace(/\\/g, "/")
    if (!this.changedFiles.includes(normalized)) {
      if (this.changedFiles.length >= MAX_CHANGED_FILES) {
        this.changedFiles.shift()
        this.evictedFileCount++
      }
      this.changedFiles.push(normalized)
    }
    this.verificationPending = true
  }

  /** 记录命令执行 */
  recordCommandRun(
    command: string,
    success: boolean,
    result: { content?: string; metadata?: Record<string, unknown> },
  ): void {
    const entry: CommandRunEntry = { commandHash: hashCommand(command), success }
    if (this.commandsRun.length >= MAX_COMMANDS_RUN) {
      this.commandsRun.shift()
      this.evictedCommandCount++
    }
    this.commandsRun.push(entry)

    if (this.isVerificationCommand(command)) {
      const exitCode = typeof result.metadata?.exitCode === "number"
        ? result.metadata.exitCode
        : (success ? 0 : 1)
      const output = result.content ?? ""
      const processed = processVerificationCommandResult(command, output, exitCode)

      this.lastVerification = { command, exitCode, summary: processed.summary }

      if (processed.passed) {
        this.verificationPending = false
        this.blockers = this.blockers.filter(b => !b.startsWith("[verification]"))
      } else {
        this.verificationPending = true
        const blocker = `[verification] ${command} failed (exit ${exitCode})`
        if (!this.blockers.includes(blocker)) {
          this.blockers.push(blocker)
        }
        if (processed.digest) {
          this.addBlocker(processed.digest.slice(0, 400))
        }
      }
    }
  }

  /** 判断命令是否像验收命令 */
  isVerificationCommand(command: string): boolean {
    return isHarnessVerificationCommand(command)
  }

  /** 添加阻塞项 */
  addBlocker(message: string): void {
    if (!this.blockers.includes(message)) {
      if (this.blockers.length >= MAX_BLOCKERS) {
        this.blockers.shift()
      }
      this.blockers.push(message)
    }
  }

  /** 清除验证待办（用户豁免时） */
  clearVerificationPending(): void {
    this.verificationPending = false
  }

  /** 导出快照 */
  snapshot(): TaskLedger {
    return {
      goal: this.goal,
      plan: this.plan.map(s => ({ ...s })),
      changedFiles: [...this.changedFiles],
      commandsRun: this.commandsRun.map(c => ({ ...c })),
      verificationPending: this.verificationPending,
      lastVerification: this.lastVerification ? { ...this.lastVerification } : undefined,
      blockers: [...this.blockers],
      evictedFileCount: this.evictedFileCount,
      evictedCommandCount: this.evictedCommandCount,
    }
  }

  /** 从快照恢复 */
  applySnapshot(snapshot: TaskLedger): void {
    this.goal = snapshot.goal
    this.plan = snapshot.plan.map(s => ({ ...s }))
    this.changedFiles = [...snapshot.changedFiles]
    this.commandsRun = snapshot.commandsRun.map(c => ({ ...c }))
    this.verificationPending = snapshot.verificationPending
    this.lastVerification = snapshot.lastVerification ? { ...snapshot.lastVerification } : undefined
    this.blockers = [...snapshot.blockers]
    this.evictedFileCount = snapshot.evictedFileCount ?? 0
    this.evictedCommandCount = snapshot.evictedCommandCount ?? 0
    this.planIngested = this.plan.length > 0
  }

  /** 格式化为上下文注入文本 */
  formatForContext(): string {
    return formatLedgerForContext(this.snapshot())
  }
}
