/**
 * ModelProfile 与 HarnessProfile 类型定义
 *
 * DRF-11: 从 SmallCode profiles.js 和 profiles/*.toml 适配
 * Source: smallcode/src/model/profiles.js (MIT)
 */

/** 模型尺寸分类 */
export type ModelSizeClass = "small" | "medium" | "large" | "unknown"

/** 工具调用格式 */
export type ToolFormat = "native" | "hermes" | "json" | "xml" | "text"

/** 可靠性等级 */
export type ReliabilityLevel = "low" | "medium" | "high"

/**
 * 模型能力画像
 */
export interface ModelProfile {
  id: string
  match: string[]
  sizeClass: ModelSizeClass
  contextWindow: number
  maxOutputTokens: number
  toolFormat: ToolFormat
  toolCallReliability: ReliabilityLevel
  jsonReliability: ReliabilityLevel
  strengths: string[]
  weaknesses: string[]
  defaultHarness: string
}

/** Harness 治理模式 */
export type HarnessMode = "free" | "adaptive" | "forced" | "strict"

/** 工具集规模 */
export type ToolsetSize = "none" | "minimal" | "coding" | "full"

/** Supervisor 策略 */
export type SupervisorPolicy = "off" | "on-failure" | "strict"

/** Shell 执行策略 */
export type ShellPolicy = "foreground" | "dual-track"

/**
 * 运行时治理画像
 */
export interface HarnessProfile {
  id: string
  mode: HarnessMode
  toolset: ToolsetSize
  maxParallelTools: number
  maxTurns: number
  requireReadBeforeWrite: boolean
  enableTextToolSalvage: boolean
  enableBranchBudget: boolean
  requireVerificationBeforeFinal: boolean
  shellPolicy: ShellPolicy
  supervisorPolicy: SupervisorPolicy
}

/** 项目级 profile 覆盖配置 */
export interface ModelProfileConfig {
  modelProfiles?: Record<string, Partial<ModelProfile>>
  harnessProfiles?: Record<string, Partial<HarnessProfile>>
}

// ---- ADV-HAR-01: Harness 三档严格度 ----

/** Harness 三档严格度 */
export type HarnessStrictness = "strict" | "normal" | "loose"

/** 严格度配置来源 */
export type StrictnessSource = "session" | "project" | "model-profile" | "default"

/** 结构化最终策略（替代散落的布尔字段） */
export interface EffectiveHarnessPolicy {
  strictness: HarnessStrictness
  source: StrictnessSource

  toolset: ToolsetSize
  maxParallelTools: number
  maxTurns: number

  readBeforeWrite: "block" | "warn" | "off"
  textToolSalvage: "always" | "on-native-failure" | "off"
  branchBudget: "enforce" | "recover" | "observe"
  checkpoint: "frequent" | "safe-point" | "minimal"
  verification: "block" | "require-or-waive" | "warn"
  earlyStop: "aggressive" | "standard" | "critical-only"
  toolRouting: "two-stage" | "auto" | "direct"
  executionMode: "forced" | "adaptive" | "free"
  shellPolicy: "dual-track-conservative" | "dual-track"
  supervisorPolicy: "on-failure" | "critical-only" | "off"
}

/** 项目级 harness 配置（.covalo/harness.json） */
export interface ProjectHarnessConfig {
  strictness?: HarnessStrictness
  modelOverrides?: Record<string, HarnessStrictness>
}
