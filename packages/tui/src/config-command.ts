import { z } from "zod"
import { CovaloConfigSchema, type CovaloConfig } from "@covalo/core"

/**
 * SPEC S0-2: `/config set` 安全化
 *
 * 目标：
 * - 路径白名单（只允许明显低风险项）
 * - value 类型转换 + schema 校验
 * - 敏感字段保护
 * - 不可变更新（禁止原地 mutate）
 * - 保存前全量 schema 校验
 *
 * 详见 docs/covalo_tui_fix_implementation_spec_20260705.md §3
 */

/**
 * `/config set` 结果。
 * - ok=true 时 config 为已通过校验的新配置对象，normalizedValue 为解析后的值
 * - ok=false 时 reason 为错误原因，sensitive=true 表示触发了敏感路径拒绝
 */
export type ConfigSetResult =
  | { ok: true; config: CovaloConfig; normalizedValue: unknown }
  | { ok: false; reason: string; sensitive?: boolean }

/**
 * SPEC §3.4 白名单：第一阶段只允许明显低风险项。
 * - tui.* 仅外观与确认弹窗
 * - workflow.* 仅回合数 / 错误阈值 / 协议开关
 * - goal.* 仅自动续跑 / 错误阈值
 */
const WRITABLE_CONFIG_PATHS = {
  "tui.theme": z.string().min(1),
  "tui.showGoalPanel": z.boolean(),
  "tui.showAgentCommFeed": z.boolean(),
  "tui.showTokenUsage": z.boolean(),
  "tui.showToolEvents": z.boolean(),
  "tui.compactReasoning": z.boolean(),
  "tui.confirmBeforeReplacingGoal": z.boolean(),
  "tui.confirmDangerousToolPolicy": z.boolean(),

  "workflow.maxRounds": z.number().int().positive().max(200),
  "workflow.maxConsecutiveErrors": z.number().int().positive().max(20),
  "workflow.supervisorInterventionErrorThreshold": z.number().int().positive().max(20),
  "workflow.structuredProtocol": z.boolean(),
  "workflow.requireJsonDecisions": z.boolean(),
  "workflow.legacyTextFallback": z.boolean(),
  "workflow.askUserOnBlocked": z.boolean(),
  "workflow.autoResumeAfterAskUser": z.boolean(),

  "goal.autoContinue": z.boolean(),
  "goal.maxAutoContinuations": z.number().int().nonnegative().max(200),
  "goal.maxConsecutiveBlockedTurns": z.number().int().positive().max(20),
  "goal.maxConsecutiveTurnErrors": z.number().int().positive().max(20),
} as const

/**
 * SPEC §3.4 暂时不开放的敏感路径前缀。
 * 命中即拒绝，并提示用户使用 `/config open` 手动编辑。
 */
const SENSITIVE_CONFIG_PREFIXES = [
  "tools.",
  "providers.",
  "agents.",
  "logging.redactSecrets",
  "trace.",
  "mailbox.",
  "context.",
] as const

/**
 * SPEC §3.5 value 解析规则。
 * 明确解析 true/false/数字/带引号字符串，避免 `!isNaN(Number(value))` 的粗放转换。
 */
export function parseRawConfigValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return raw
}

function isSensitivePath(path: string): boolean {
  return SENSITIVE_CONFIG_PREFIXES.some(prefix => path.startsWith(prefix))
}

/**
 * SPEC §3.3 推荐接口。
 *
 * 流程：
 * 1. 路径必须为白名单项；否则若为敏感路径则返回 sensitive 拒绝，否则返回未知路径拒绝
 * 2. 解析 rawValue（明确 true/false/number/quoted string）
 * 3. 用白名单 zod schema 校验类型与范围
 * 4. structuredClone(current) 深拷贝，禁止原地 mutate
 * 5. 应用改动到 next
 * 6. 全量 CovaloConfigSchema.safeParse(next) 校验
 * 7. 通过则返回 ok=true + 新 config
 *
 * 失败时不污染原 config（next 是深拷贝，原 current 未被修改）。
 */
export function applySafeConfigSet(
  current: CovaloConfig,
  path: string,
  rawValue: string,
): ConfigSetResult {
  // 1. 白名单校验
  const validator = (WRITABLE_CONFIG_PATHS as Record<string, z.ZodType>)[path]
  if (!validator) {
    if (isSensitivePath(path)) {
      return {
        ok: false,
        reason: `This config path is sensitive and cannot be changed from /config set. Use /config open and review the file manually.`,
        sensitive: true,
      }
    }
    return {
      ok: false,
      reason: `Unknown or non-writable config path: ${path}. Allowed paths: tui.*, workflow.*, goal.* (subset). Use /config open for full edit.`,
    }
  }

  // 2. 解析 rawValue
  const parsedValue = parseRawConfigValue(rawValue)

  // 3. 类型/范围校验
  const valueResult = validator.safeParse(parsedValue)
  if (!valueResult.success) {
    const firstIssue = valueResult.error.issues[0]
    const detail = firstIssue ? firstIssue.message : "value validation failed"
    return {
      ok: false,
      reason: `Invalid value for ${path}: ${detail} (got: ${JSON.stringify(rawValue)})`,
    }
  }
  const normalizedValue = valueResult.data

  // 4. 深拷贝当前 config，禁止原地修改
  const next = structuredCloneSafe(current)

  // 5. 应用改动 — 仅顶层 section 直接 mutate clone（不污染原 current）
  const dotIndex = path.indexOf(".")
  if (dotIndex === -1) {
    // 不应发生（白名单全部为 section.key 形式）
    return { ok: false, reason: `Invalid config path: ${path}` }
  }
  const section = path.slice(0, dotIndex) as keyof CovaloConfig
  const key = path.slice(dotIndex + 1)
  const sectionValue = next[section] as Record<string, unknown> | undefined
  if (!sectionValue || typeof sectionValue !== "object" || Array.isArray(sectionValue)) {
    return { ok: false, reason: `Section '${section}' is not an object` }
  }
  sectionValue[key] = normalizedValue

  // 6. 全量 schema 校验
  const fullResult = CovaloConfigSchema.safeParse(next)
  if (!fullResult.success) {
    const firstIssue = fullResult.error.issues[0]
    const issuePath = firstIssue?.path.join(".") ?? "(unknown)"
    const detail = firstIssue?.message ?? "schema validation failed"
    return {
      ok: false,
      reason: `Config schema validation failed at '${issuePath}': ${detail}`,
    }
  }

  // 7. 返回新 config（已通过全量校验）
  return { ok: true, config: fullResult.data, normalizedValue }
}

/**
 * 深拷贝配置对象。
 * Node 18+ 支持 structuredClone；fallback 到 JSON clone（配置对象只包含 TOML/JSON 可序列化字段）。
 */
function structuredCloneSafe<T>(value: T): T {
  if (typeof structuredClone === "function") {
    return structuredClone(value)
  }
  return JSON.parse(JSON.stringify(value)) as T
}
