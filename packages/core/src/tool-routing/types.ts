/**
 * 两阶段工具路由类型定义
 *
 * DRF-70: 从 SmallCode two_stage_router.js 适配
 */

import type { ToolsetSize } from "../model-profile/types.js"
import type { ToolSpec } from "../types.js"

/** 工具类别 */
export type ToolCategory = "read" | "write" | "search" | "run" | "plan" | "code_intel" | "full"

/**
 * 路由模式：
 * - direct：一次暴露全部工具
 * - two_stage：先选类别再注入子集
 * - auto：由 shouldUseTwoStageRouting 基于 contextWindow/schemaTokens/sizeClass 自动决策
 *
 * 注意："auto" 是输入值，由 loop 传给 resolveToolRouting；
 * ToolRoutingDecision.mode 输出只会是 "direct" 或 "two_stage"。
 */
export type ToolRoutingMode = "direct" | "two_stage" | "auto"

/** 两阶段路由阶段 */
export type ToolRoutingStage = "deterministic" | "category_select" | "category_tools" | "direct"

/** 路由决策结果 */
export interface ToolRoutingDecision {
  /** 实际注入 LLM 的工具 schema */
  tools: ToolSpec[]
  /** 当前路由模式 */
  mode: ToolRoutingMode
  /** 当前阶段 */
  stage: ToolRoutingStage
  /** 确定性过滤后的类别（若有） */
  category?: ToolCategory
  /** 估算 schema token 数 */
  estimatedSchemaTokens: number
  /** 是否因 schema 预算触发了 two_stage */
  schemaBudgetExceeded: boolean
}

/** 路由输入上下文 */
export interface ToolRoutingContext {
  /** 全部可用工具 schema */
  allTools: ToolSpec[]
  /** 模型上下文窗口（token） */
  contextWindow: number
  /** 模型尺寸分类 */
  sizeClass?: "small" | "medium" | "large" | "unknown"
  /** Harness 工具集规模（确定性过滤） */
  toolset?: ToolsetSize
  /** 外部类别提示（如上一轮 select_category 结果） */
  selectedCategory?: ToolCategory
  /** MCP/动态工具名 -> 类别映射 */
  toolCategoryMap?: Record<string, ToolCategory>
  /** 环境或配置覆盖：direct | two_stage | auto（auto 走自动检测） */
  routingOverride?: ToolRoutingMode
  /** schema token 预算（默认按 contextWindow 比例推算） */
  schemaTokenBudget?: number
  /** 当前是否处于 category_select 阶段（Stage 1 已返回类别） */
  awaitingCategorySelection?: boolean
}

/** 类别元数据 */
export interface ToolCategoryDef {
  /** 类别描述（Stage 1 注入） */
  description: string
  /** 该类别包含的内置工具名 */
  tools: readonly string[]
}
