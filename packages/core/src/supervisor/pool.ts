/**
 * Supervisor 候选池 — 显式配置、能力目录与默认目录。
 *
 * DRF-51：Supervisor 候选必须由用户显式配置为具体 provider/model target；
 * 不得使用虚拟自动路由 target。
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

import { z } from "zod"

/** Supervisor 成本类别 */
export type SupervisorCostClass = "free" | "free-tier" | "paid"

/** Supervisor 候选能力描述 */
export interface SupervisorCapabilities {
  /** 是否支持结构化 JSON 输出 */
  structuredJson: boolean
  /** 是否支持 reasoning 文本 */
  reasoningText: boolean
  /** 单次 evidence 输入 token 上限 */
  maxEvidenceTokens: number
}

/** Supervisor 候选条目 */
export interface SupervisorCandidate {
  /** 候选唯一 ID */
  id: string
  /** ModelTarget ID（如 supervisor.zen-free） */
  target: string
  /** 基础优先级，越高越优先 */
  priority: number
  /** 能力目录 */
  capabilities: SupervisorCapabilities
  /** 成本类别 */
  costClass: SupervisorCostClass
  /** 是否启用 */
  enabled: boolean
}

/** Supervisor 池配置 */
export interface SupervisorPoolConfig {
  candidates: SupervisorCandidate[]
}

/** 配置文件路径 */
export const SUPERVISOR_POOL_FILE = ".covalo/supervisor-pool.json"

const capabilitiesSchema = z.object({
  structuredJson: z.boolean(),
  reasoningText: z.boolean(),
  maxEvidenceTokens: z.number().int().positive(),
})

const candidateSchema = z.object({
  id: z.string().min(1),
  target: z.string().min(1),
  priority: z.number(),
  capabilities: capabilitiesSchema,
  costClass: z.enum(["free", "free-tier", "paid"]),
  enabled: z.boolean(),
})

const poolConfigSchema = z.object({
  candidates: z.array(candidateSchema).min(1),
})

/**
 * 默认 Supervisor 候选池。
 * ADV-HAR-04: 所有候选默认禁用，用户必须显式配置 .covalo/supervisor-pool.json 才能启用。
 * 未配置时不发起任何 Supervisor 网络请求。
 */
export const DEFAULT_SUPERVISOR_POOL: SupervisorPoolConfig = {
  candidates: [
    {
      id: "zen-deepseek",
      target: "supervisor.zen-free",
      priority: 100,
      capabilities: {
        structuredJson: true,
        reasoningText: true,
        maxEvidenceTokens: 8192,
      },
      costClass: "free",
      enabled: false,
    },
    {
      id: "zen-mimo",
      target: "supervisor.mimo-free",
      priority: 90,
      capabilities: {
        structuredJson: true,
        reasoningText: true,
        maxEvidenceTokens: 8192,
      },
      costClass: "free",
      enabled: false,
    },
    {
      id: "stepfun-3.5",
      target: "supervisor.stepfun",
      priority: 50,
      capabilities: {
        structuredJson: false,
        reasoningText: true,
        maxEvidenceTokens: 8192,
      },
      costClass: "free-tier",
      enabled: false,
    },
  ],
}

/**
 * 校验并规范化 Supervisor 池配置。
 *
 * @param value - 原始 JSON 对象
 * @returns 校验结果
 */
export function parseSupervisorPoolConfig(
  value: unknown,
): { ok: true; config: SupervisorPoolConfig } | { ok: false; error: string } {
  const parsed = poolConfigSchema.safeParse(value)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.message }
  }
  return { ok: true, config: parsed.data }
}

/**
 * 按 ID 合并用户配置与默认池。
 * 用户文件中同 ID 条目覆盖默认条目；默认中未覆盖的条目保留。
 *
 * @param defaults - 默认池
 * @param overrides - 用户覆盖
 */
export function mergeSupervisorPool(
  defaults: SupervisorPoolConfig,
  overrides: SupervisorPoolConfig,
): SupervisorPoolConfig {
  const byId = new Map<string, SupervisorCandidate>()
  for (const candidate of defaults.candidates) {
    byId.set(candidate.id, candidate)
  }
  for (const candidate of overrides.candidates) {
    byId.set(candidate.id, candidate)
  }
  return { candidates: Array.from(byId.values()) }
}

/**
 * 从 `.covalo/supervisor-pool.json` 加载 Supervisor 池。
 * ADV-HAR-04: 文件不存在时返回空池（无候选），用户必须显式配置才能启用 Supervisor。
 *
 * @param cwd - 工作目录，默认 process.cwd()
 */
export function loadSupervisorPool(cwd: string = process.cwd()): SupervisorPoolConfig {
  const filePath = resolve(cwd, SUPERVISOR_POOL_FILE)
  if (!existsSync(filePath)) {
    return { candidates: [] }
  }

  try {
    const raw = readFileSync(filePath, "utf8")
    const parsed = parseSupervisorPoolConfig(JSON.parse(raw))
    if (!parsed.ok) {
      return { candidates: [] }
    }
    return mergeSupervisorPool(DEFAULT_SUPERVISOR_POOL, parsed.config)
  } catch {
    return { candidates: [] }
  }
}

// Phase 2.2: getEnabledSupervisorCandidates 已删除（仅测试使用，无生产调用方）。
// 调用方可直接用 pool.candidates.filter(c => c.enabled) 替代。
// 详见 docs/unintegrated_code_audit_20260703.md §3.10f。
