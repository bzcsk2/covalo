/**
 * BranchBudgetTracker — 分支执行预算追踪器。
 *
 * 防止 Agent 在同一条策略上无限重复（同一文件反复编辑、
 * 同一命令反复重试、同一错误反复出现），从而拖死长任务。
 *
 * DRF-30：从 iceCoder 裁剪，移除 takeover / escalation bypass。
 */

import type {
  BranchBudgetSnapshot,
  RecoverySignal,
} from "../checkpoint/runtime-checkpoint.js"
import { emptyBranchBudgetSnapshot } from "../checkpoint/runtime-checkpoint.js"
import {
  canonicalBudgetPath,
  mergeBudgetPathMap,
} from "./branch-budget-path.js"
import { isHarnessVerificationCommand } from "./verification-command.js"
import { workspaceFileExists } from "./path-scope.js"
import { getPromptLocale } from "../prompt-locale.js"
import type { PromptLocale } from "../prompt-locale.js"

/** 默认预算上限 */
export const DEFAULT_BRANCH_BUDGET = {
  /** 同一文件最大编辑次数 */
  fileEditMax: 3,
  /** 同一 shell 命令最大重试次数 */
  commandRetryMax: 2,
  /** 同一诊断 / 错误签名最大重试次数 */
  errorRepeatMax: 3,
} as const

export interface BranchBudgetLimits {
  fileEditMax: number
  commandRetryMax: number
  errorRepeatMax: number
}

/** shouldBranchRecover() 的返回值 */
export interface BranchRecoverDecision {
  triggered: boolean
  reason?: string
  currentCount?: number
  limit?: number
  dimension?: "file_edit" | "command_retry" | "error_repeat"
  key?: string
}

/** Harness 工具执行前硬拦截判定。 */
export interface BranchToolBlockDecision {
  blocked: boolean
  dimension?: BranchRecoverDecision["dimension"]
  key?: string
  message?: string
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ").slice(0, 200)
}

function normalizeErrorSignature(signature: string): string {
  return signature
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z-]+/g, "<ts>")
    .replace(/:\d+:\d+/g, ":<l>:<c>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200)
}

/**
 * 分支预算追踪器：纯内存、零 LLM 成本。
 */
export class BranchBudgetTracker {
  private fileEdits = new Map<string, number>()
  private commandRetries = new Map<string, number>()
  private errorRepeats = new Map<string, number>()
  private recoverTriggers = 0
  private enabled = true
  private readonly limits: BranchBudgetLimits
  private budgetWorkspaceRoot?: string
  private _locale: PromptLocale = getPromptLocale()

  /**
   * @param limits 可选自定义上限；默认使用 DEFAULT_BRANCH_BUDGET。
   */
  constructor(limits: Partial<BranchBudgetLimits> = {}) {
    this.limits = {
      fileEditMax: limits.fileEditMax ?? DEFAULT_BRANCH_BUDGET.fileEditMax,
      commandRetryMax: limits.commandRetryMax ?? DEFAULT_BRANCH_BUDGET.commandRetryMax,
      errorRepeatMax: limits.errorRepeatMax ?? DEFAULT_BRANCH_BUDGET.errorRepeatMax,
    }
  }

  setLocale(locale: PromptLocale): void {
    this._locale = locale
  }

  getLocale(): PromptLocale {
    return this._locale
  }

  /** 绑定 workspace 并合并绝对/相对路径下的重复计数。 */
  bindWorkspaceRoot(workspaceRoot: string | undefined): void {
    if (!workspaceRoot?.trim()) return
    const root = workspaceRoot.trim()
    if (this.budgetWorkspaceRoot === root) return
    this.budgetWorkspaceRoot = root
    this.fileEdits = mergeBudgetPathMap(this.fileEdits, root)
  }

  private budgetKey(rawPath: string | undefined | null): string | undefined {
    return canonicalBudgetPath(this.budgetWorkspaceRoot, rawPath)
  }

  /**
   * 记录一次文件编辑。
   * @returns 当前累计编辑次数
   */
  recordFileEdit(path: string | undefined | null): number {
    if (!this.enabled) return 0
    const key = this.budgetKey(path)
    if (!key) return 0
    const next = (this.fileEdits.get(key) ?? 0) + 1
    this.fileEdits.set(key, next)
    return next
  }

  /**
   * 仅在 run_command 执行失败时累加同一规范化命令的失败次数。
   */
  recordFailedCommandAttempt(command: string | undefined | null): number {
    if (!this.enabled) return 0
    if (!command) return 0
    const key = normalizeCommand(command)
    const next = (this.commandRetries.get(key) ?? 0) + 1
    this.commandRetries.set(key, next)
    return next
  }

  /**
   * 记录一次错误签名。
   * @returns 同签名累计出现次数
   */
  recordError(signature: string | undefined | null): number {
    if (!this.enabled) return 0
    if (!signature) return 0
    const key = normalizeErrorSignature(signature)
    const next = (this.errorRepeats.get(key) ?? 0) + 1
    this.errorRepeats.set(key, next)
    return next
  }

  /** 工具执行前判定：同一文件已达编辑上限 → 拒绝下一次 write/edit。 */
  wouldBlockFileEdit(path: string | undefined | null): boolean {
    if (!this.enabled || !path) return false
    const key = this.budgetKey(path)
    if (!key) return false
    return (this.fileEdits.get(key) ?? 0) >= this.limits.fileEditMax
  }

  /** 工具执行前判定：同一命令失败重试达上限 → 拒绝再次 run_command。 */
  wouldBlockCommandRetry(command: string | undefined | null): boolean {
    if (!this.enabled || !command) return false
    const key = normalizeCommand(command)
    return (this.commandRetries.get(key) ?? 0) >= this.limits.commandRetryMax
  }

  /**
   * 统一工具拦截入口（write/edit 与 run_command）。
   * blocked=true 时不应执行工具，直接把 message 作为 tool_result 回给模型。
   */
  checkToolBlock(
    toolName: string,
    args: Record<string, unknown>,
    extractPath: (name: string, a: Record<string, unknown>) => string | undefined,
    extractCommand: (a: Record<string, unknown>) => string | undefined,
    context?: { workspaceRoot?: string },
  ): BranchToolBlockDecision {
    if (!this.enabled) return { blocked: false }

    const path = extractPath(toolName, args)
    const fileKey = path ? this.budgetKey(path) : undefined
    if (fileKey && (this.fileEdits.get(fileKey) ?? 0) >= this.limits.fileEditMax) {
      const count = this.fileEdits.get(fileKey) ?? 0
      const workspaceRoot = context?.workspaceRoot ?? this.budgetWorkspaceRoot
      const fileExists = workspaceRoot && path ? workspaceFileExists(workspaceRoot, path) : true
      return {
        blocked: true,
        dimension: "file_edit",
        key: fileKey,
        message: this.buildFileEditBlockMessage(fileKey, count, fileExists),
      }
    }

    if (toolName === "run_command") {
      const command = extractCommand(args)
      if (command) {
        const cmdKey = normalizeCommand(command)
        if ((this.commandRetries.get(cmdKey) ?? 0) >= this.limits.commandRetryMax) {
          const count = this.commandRetries.get(cmdKey) ?? 0
          return {
            blocked: true,
            dimension: "command_retry",
            key: command,
            message: this.buildCommandBlockMessage(command, count),
          }
        }
      }
    }

    return { blocked: false }
  }

  buildFileEditBlockMessage(
    path: string,
    currentCount: number,
    fileExists = true,
  ): string {
    const isZh = this._locale === "zh-CN"
    if (!fileExists) {
      return isZh
        ? `[BranchBudget/Blocked] 工具未执行：${path} 编辑计数 ${currentCount} 次（上限 ${this.limits.fileEditMax}），但磁盘上不存在该文件。用 write_file 写入完整文件以创建。`
        : `[BranchBudget/Blocked] Not executed: ${path} edit count ${currentCount}/${this.limits.fileEditMax}, but file does not exist on disk. Use write_file to create it.`
    }
    return isZh
      ? `[BranchBudget/Blocked] 工具未执行：${path} 已编辑 ${currentCount} 次（上限 ${this.limits.fileEditMax}）。先读取失败的测试输出，仅修复验证所需内容。在读取失败测试并记录预期/实际行为之前不要重写此文件。`
      : `[BranchBudget/Blocked] Not executed: ${path} edited ${currentCount}/${this.limits.fileEditMax}. Read failing test output first; fix only what verification requires. Do not rewrite this file again until you have read the failing test and documented expected vs actual behavior.`
  }

  buildCommandBlockMessage(command: string, failedAttempts: number): string {
    const isZh = this._locale === "zh-CN"
    const short = command.length > 200 ? command.slice(0, 200) + "…" : command
    if (isZh) {
      return `[BranchBudget/Blocked] 工具未执行：该命令已失败 ${failedAttempts} 次（拦截阈值 ${this.limits.commandRetryMax}）。\n命令: ${short}\n先读取失败输出中引用的源码/测试，分析错误后再改代码；不要原样重试。`
    }
    return `[BranchBudget/Blocked] Not executed: command failed ${failedAttempts}/${this.limits.commandRetryMax}.\nCommand: ${short}\nRead source/test files referenced in failure output first; do not rerun the same command.`
  }

  /**
   * 判定是否需要触发分支恢复信号。
   * 任意一个维度超过 limit 即视为需要恢复。
   */
  shouldBranchRecover(): BranchRecoverDecision {
    if (!this.enabled) return { triggered: false }
    const fileOver = this.findOverLimit(this.fileEdits, this.limits.fileEditMax)
    if (fileOver) {
      return {
        triggered: true,
        dimension: "file_edit",
        key: fileOver.key,
        currentCount: fileOver.count,
        limit: this.limits.fileEditMax,
        reason: this._locale === "zh-CN"
          ? `同一文件 ${fileOver.key} 已编辑 ${fileOver.count} 次（上限 ${this.limits.fileEditMax}）`
          : `File ${fileOver.key} edited ${fileOver.count} times (limit ${this.limits.fileEditMax})`,
      }
    }
    const cmdOver = this.findOverLimit(this.commandRetries, this.limits.commandRetryMax)
    if (cmdOver) {
      return {
        triggered: true,
        dimension: "command_retry",
        key: cmdOver.key,
        currentCount: cmdOver.count,
        limit: this.limits.commandRetryMax,
        reason: this._locale === "zh-CN"
          ? `同一命令失败后已累积 ${cmdOver.count} 次（上限 ${this.limits.commandRetryMax}）`
          : `Command failed ${cmdOver.count} times (limit ${this.limits.commandRetryMax})`,
      }
    }
    const errOver = this.findOverLimit(this.errorRepeats, this.limits.errorRepeatMax)
    if (errOver) {
      return {
        triggered: true,
        dimension: "error_repeat",
        key: errOver.key,
        currentCount: errOver.count,
        limit: this.limits.errorRepeatMax,
        reason: this._locale === "zh-CN"
          ? `同一错误重复出现 ${errOver.count} 次（上限 ${this.limits.errorRepeatMax}）`
          : `Same error repeated ${errOver.count} times (limit ${this.limits.errorRepeatMax})`,
      }
    }
    return { triggered: false }
  }

  /**
   * 生成可注入到对话的 RecoverySignal。
   * @returns 未触发时返回 null
   */
  buildRecoverySignal(decision?: BranchRecoverDecision): RecoverySignal | null {
    const d = decision ?? this.shouldBranchRecover()
    if (!d.triggered) return null
    const isZh = this._locale === "zh-CN"
    return {
      source: "branch_budget",
      message: isZh
        ? [
            "[系统/运行时警告] 当前分支预算已耗尽。",
            d.reason ? `原因: ${d.reason}` : "",
            "请立即切换策略：换工具/换路径/换参数/拆分子任务。",
            "不要原样重试同一操作。若无法继续，向用户说明具体阻塞点和已尝试的证据。",
          ].filter(Boolean).join("\n")
        : [
            "[System/Runtime Warning] Current branch budget exhausted.",
            d.reason ? `Reason: ${d.reason}` : "",
            "Switch strategy immediately: different tool, different path, different parameters, or sub-task breakdown.",
            "Do not retry the same failed operation. If you cannot proceed, explain the exact blocker and evidence tried to the user.",
          ].filter(Boolean).join("\n"),
      at: Date.now(),
      consumed: false,
    }
  }

  /** 标记一次 recovery 已触发，用于持久化与去重计数。 */
  markRecoveryTriggered(): void {
    this.recoverTriggers++
  }

  /** 由 ExecutionMode 控制启停：disabled 不清空已有计数。 */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
  }

  /** 当前是否启用记录与判定。 */
  isEnabled(): boolean {
    return this.enabled
  }

  /** 已触发的 recovery 次数 */
  get recoverTriggerCount(): number {
    return this.recoverTriggers
  }

  /** 调试 / 测试用：返回内部映射的拷贝 */
  inspect(): {
    fileEdits: Record<string, number>
    commandRetries: Record<string, number>
    errorRepeats: Record<string, number>
  } {
    return {
      fileEdits: Object.fromEntries(this.fileEdits),
      commandRetries: Object.fromEntries(this.commandRetries),
      errorRepeats: Object.fromEntries(this.errorRepeats),
    }
  }

  /** 重置全部计数（任务切换时调用） */
  reset(): void {
    this.fileEdits.clear()
    this.commandRetries.clear()
    this.errorRepeats.clear()
    this.recoverTriggers = 0
  }

  /**
   * 新用户消息 / 新 harness 工具轮 — file/command/error 三维计数归零。
   * recoverTriggers 保留（跨轮 recovery 去重用）。
   */
  resetRoundBudget(): void {
    this.fileEdits.clear()
    this.commandRetries.clear()
    this.errorRepeats.clear()
  }

  /** Segment Renewal / 续段后：清除验收命令失败计数，保留文件编辑计数。 */
  resetCommandRetriesForVerificationCommands(): void {
    for (const [key] of [...this.commandRetries.entries()]) {
      if (isHarnessVerificationCommand(key)) {
        this.commandRetries.delete(key)
      }
    }
  }

  snapshot(): BranchBudgetSnapshot {
    return {
      fileEdits: Object.fromEntries(this.fileEdits),
      commandRetries: Object.fromEntries(this.commandRetries),
      errorRepeats: Object.fromEntries(this.errorRepeats),
      recoverTriggers: this.recoverTriggers,
    }
  }

  applySnapshot(snapshot: BranchBudgetSnapshot | undefined | null): void {
    const s = snapshot ?? emptyBranchBudgetSnapshot()
    this.fileEdits = new Map(Object.entries(s.fileEdits ?? {}))
    this.commandRetries = new Map(Object.entries(s.commandRetries ?? {}))
    this.errorRepeats = new Map(Object.entries(s.errorRepeats ?? {}))
    this.recoverTriggers = s.recoverTriggers ?? 0
    if (this.budgetWorkspaceRoot) {
      this.fileEdits = mergeBudgetPathMap(this.fileEdits, this.budgetWorkspaceRoot)
    }
  }

  static fromSnapshot(
    snapshot: BranchBudgetSnapshot | undefined | null,
    limits?: Partial<BranchBudgetLimits>,
  ): BranchBudgetTracker {
    const t = new BranchBudgetTracker(limits)
    t.applySnapshot(snapshot)
    return t
  }

  private findOverLimit(
    map: Map<string, number>,
    limit: number,
  ): { key: string; count: number } | null {
    let worst: { key: string; count: number } | null = null
    for (const [key, count] of map) {
      if (count >= limit && (!worst || count > worst.count)) {
        worst = { key, count }
      }
    }
    return worst
  }
}
