/**
 * 两阶段工具路由器
 *
 * DRF-70: 从 SmallCode two_stage_router.js 适配
 * Source: smallcode/src/tools/two_stage_router.js (MIT)
 *
 * Stage 0（确定性）：按 HarnessProfile.toolset 与类别映射过滤，不额外调用 LLM
 * Stage 1（two_stage）：仅注入 select_category 轻量工具
 * Stage 2（two_stage）：注入所选类别的完整 tool schema
 */

import type { ToolsetSize } from "../model-profile/types.js"
import type { ToolSpec } from "../types.js"
import type {
  ToolCategory,
  ToolCategoryDef,
  ToolRoutingContext,
  ToolRoutingDecision,
  ToolRoutingMode,
  ToolRoutingStage,
} from "./types.js"

/** 16k 及以下上下文默认启用 two_stage */
export const TWO_STAGE_CONTEXT_THRESHOLD = 16_384

/** 小模型 schema 占上下文比例上限（超出则 two_stage） */
export const DEFAULT_SCHEMA_BUDGET_RATIO = 0.12

/** 绝对 schema token 预算下限 */
export const MIN_SCHEMA_TOKEN_BUDGET = 512

/**
 * Deepreef 内置工具类别表
 *
 * 工具名必须与 createDefaultTools() 注册的真实工具 name 一致，
 * 否则 two-stage 路由会把不存在的工具名过滤掉，导致模型选了正确
 * 类别但工具不可用。参考 packages/tools/src/index.ts。
 */
export const TOOL_CATEGORIES: Record<Exclude<ToolCategory, "full">, ToolCategoryDef> = {
  read: {
    description: "读取文件、列目录、glob 匹配",
    tools: ["read_file", "list_dir", "glob"],
  },
  write: {
    description: "创建/编辑/重写文件",
    tools: ["write_file", "edit", "NotebookEdit"],
  },
  search: {
    description: "正则搜索、网页检索与抓取",
    tools: ["grep", "WebSearch", "web_search", "WebFetch", "WebBrowser"],
  },
  run: {
    description: "执行 shell 命令、后台任务与工作流",
    tools: [
      "bash",
      "Sleep",
      "Monitor",
      "Cron",
      "Workflow",
      "Worktree",
      "PushNotification",
    ],
  },
  plan: {
    description: "任务计划、Todo、用户问答与子 Agent",
    tools: [
      "todowrite",
      "TaskCreate",
      "TaskUpdate",
      "TaskList",
      "TaskGet",
      "TaskStop",
      "Question",
      "PlanMode",
      "AgentTool",
      "SendMessage",
      "Skill",
    ],
  },
  code_intel: {
    description: "LSP 符号查询与代码智能",
    tools: ["LSP"],
  },
}

/** toolset 规模 -> 允许的类别 */
const TOOLSET_CATEGORIES: Record<ToolsetSize, readonly ToolCategory[]> = {
  none: [],
  minimal: ["read", "write"],
  coding: ["read", "write", "search", "run"],
  full: ["read", "write", "search", "run", "plan", "code_intel"],
}

const ALL_CATEGORY_KEYS = Object.keys(TOOL_CATEGORIES) as Exclude<ToolCategory, "full">[]

/**
 * 根据上下文窗口与环境覆盖决定路由模式
 *
 * @param contextWindow - 模型上下文长度（token）
 * @param routingOverride - 配置或环境覆盖
 */
export function getRoutingMode(
  contextWindow: number,
  routingOverride?: ToolRoutingMode,
): ToolRoutingMode {
  if (routingOverride === "direct") return "direct"
  if (routingOverride === "two_stage") return "two_stage"
  return contextWindow <= TWO_STAGE_CONTEXT_THRESHOLD ? "two_stage" : "direct"
}

/**
 * 估算 tool schema 占用的 token 数（字符数 / 4 启发式）
 */
export function estimateToolSchemaTokens(tools: ToolSpec[]): number {
  if (tools.length === 0) return 0
  return Math.ceil(JSON.stringify(tools).length / 4)
}

/**
 * 计算 schema token 预算
 */
export function resolveSchemaTokenBudget(
  contextWindow: number,
  explicitBudget?: number,
): number {
  if (explicitBudget !== undefined && explicitBudget > 0) return explicitBudget
  return Math.max(
    MIN_SCHEMA_TOKEN_BUDGET,
    Math.floor(contextWindow * DEFAULT_SCHEMA_BUDGET_RATIO),
  )
}

/**
 * 是否应启用 two_stage（小上下文或 schema 超预算）
 */
export function shouldUseTwoStageRouting(input: {
  contextWindow: number
  schemaTokens: number
  sizeClass?: "small" | "medium" | "large" | "unknown"
  routingOverride?: ToolRoutingMode
  schemaTokenBudget?: number
}): boolean {
  const mode = getRoutingMode(input.contextWindow, input.routingOverride)
  if (mode === "two_stage") return true
  if (input.sizeClass === "small") {
    const budget = resolveSchemaTokenBudget(input.contextWindow, input.schemaTokenBudget)
    if (input.schemaTokens > budget) return true
  }
  return false
}

/**
 * 解析单个工具所属类别；未知 MCP 工具可通过 metadata 映射，否则归入 full
 */
export function inferToolCategory(
  toolName: string,
  toolCategoryMap?: Record<string, ToolCategory>,
): ToolCategory {
  const mapped = toolCategoryMap?.[toolName]
  if (mapped) return mapped

  for (const key of ALL_CATEGORY_KEYS) {
    if (TOOL_CATEGORIES[key].tools.includes(toolName)) return key
  }
  return "full"
}

/**
 * 确定性类别过滤：按 toolset 与可选 selectedCategory 缩小工具集，不调用 LLM
 */
export function applyDeterministicCategoryFilter(
  allTools: ToolSpec[],
  options: {
    toolset?: ToolsetSize
    selectedCategory?: ToolCategory
    toolCategoryMap?: Record<string, ToolCategory>
  } = {},
): { tools: ToolSpec[]; categories: ToolCategory[] } {
  const toolset = options.toolset ?? "full"
  const allowedCategories = new Set<ToolCategory>(TOOLSET_CATEGORIES[toolset])

  if (options.selectedCategory && options.selectedCategory !== "full") {
    allowedCategories.clear()
    allowedCategories.add(options.selectedCategory)
  }

  if (allowedCategories.size === 0) {
    return { tools: [], categories: [] }
  }

  const filtered = allTools.filter((tool) => {
    const category = inferToolCategory(tool.function.name, options.toolCategoryMap)
    if (category === "full") {
      // FIX-CUSTOM-TOOLS: 自定义工具（未在 TOOL_CATEGORIES 中注册的工具）始终放行，
      // 不受 toolset 规模过滤。strict/normal/coding/minimal toolset 不应阻止
      // registerTool() 注册的自定义工具通过。
      return true
    }
    return allowedCategories.has(category)
  })

  return {
    tools: filtered,
    categories: [...allowedCategories],
  }
}

/**
 * 获取 Stage 1 类别选择器 tool schema（轻量，约 200 token）
 */
export function getCategorySelectorTool(
  categories: readonly ToolCategory[] = ALL_CATEGORY_KEYS,
): ToolSpec {
  const selectable = categories.filter((c): c is Exclude<ToolCategory, "full"> => c !== "full")
  const enumValues = selectable.length > 0 ? selectable : ALL_CATEGORY_KEYS

  const descriptions = enumValues
    .map((key) => `${key} (${TOOL_CATEGORIES[key].description})`)
    .join("; ")

  return {
    type: "function",
    function: {
      name: "select_category",
      description: `选择下一步需要的工具类别。可选：${descriptions}`,
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: enumValues,
            description: "下一步动作所需的工具类别",
          },
        },
        required: ["category"],
      },
    },
  }
}

/**
 * 按类别过滤完整 tool schema（Stage 2）
 */
export function getToolsForCategory(
  category: ToolCategory,
  allTools: ToolSpec[],
  toolCategoryMap?: Record<string, ToolCategory>,
): ToolSpec[] {
  if (category === "full") return allTools

  const cat = TOOL_CATEGORIES[category]
  if (!cat) return allTools

  return allTools.filter((tool) => {
    const inferred = inferToolCategory(tool.function.name, toolCategoryMap)
    return inferred === category || cat.tools.includes(tool.function.name)
  })
}

/**
 * 估算 two_stage 相对 direct 的 token 节省比例
 */
export function estimateRoutingSavings(allTools: ToolSpec[]): {
  directTokens: number
  twoStageTokens: number
  savingsPercent: number
} {
  const directTokens = estimateToolSchemaTokens(allTools)
  const selectorTokens = estimateToolSchemaTokens([getCategorySelectorTool()])
  const avgCategoryTokens = Math.ceil(directTokens / ALL_CATEGORY_KEYS.length)
  const twoStageTokens = selectorTokens + avgCategoryTokens
  const savingsPercent = directTokens > 0
    ? Math.round((1 - twoStageTokens / directTokens) * 100)
    : 0

  return { directTokens, twoStageTokens, savingsPercent }
}

/**
 * 解析 select_category 工具调用的类别参数
 */
export function parseSelectedCategory(argumentsJson: string): ToolCategory | undefined {
  try {
    const parsed = JSON.parse(argumentsJson) as { category?: string }
    const value = parsed.category
    if (!value) return undefined
    if (value === "full") return "full"
    if (value in TOOL_CATEGORIES) return value as Exclude<ToolCategory, "full">
    return undefined
  } catch {
    return undefined
  }
}

/**
 * 主入口：根据上下文决定注入哪些 tool schema
 */
export function resolveToolRouting(ctx: ToolRoutingContext): ToolRoutingDecision {
  const { tools: deterministicTools, categories } = applyDeterministicCategoryFilter(
    ctx.allTools,
    {
      toolset: ctx.toolset,
      selectedCategory: ctx.selectedCategory,
      toolCategoryMap: ctx.toolCategoryMap,
    },
  )

  const schemaBudget = resolveSchemaTokenBudget(ctx.contextWindow, ctx.schemaTokenBudget)
  const deterministicTokens = estimateToolSchemaTokens(deterministicTools)
  const useTwoStage = shouldUseTwoStageRouting({
    contextWindow: ctx.contextWindow,
    schemaTokens: deterministicTokens,
    sizeClass: ctx.sizeClass,
    routingOverride: ctx.routingOverride,
    schemaTokenBudget: schemaBudget,
  })

  if (!useTwoStage) {
    return {
      tools: deterministicTools,
      mode: "direct",
      stage: "direct",
      category: ctx.selectedCategory,
      estimatedSchemaTokens: deterministicTokens,
      schemaBudgetExceeded: deterministicTokens > schemaBudget,
    }
  }

  if (ctx.selectedCategory && ctx.selectedCategory !== "full" && !ctx.awaitingCategorySelection) {
    const categoryTools = getToolsForCategory(
      ctx.selectedCategory,
      deterministicTools.length > 0 ? deterministicTools : ctx.allTools,
      ctx.toolCategoryMap,
    )
    const tokens = estimateToolSchemaTokens(categoryTools)
    return {
      tools: categoryTools,
      mode: "two_stage",
      stage: "category_tools",
      category: ctx.selectedCategory,
      estimatedSchemaTokens: tokens,
      schemaBudgetExceeded: deterministicTokens > schemaBudget,
    }
  }

  const selectorCategories = categories.length > 0 ? categories : ALL_CATEGORY_KEYS
  const selectorTool = getCategorySelectorTool(selectorCategories)
  const selectorTokens = estimateToolSchemaTokens([selectorTool])

  return {
    tools: [selectorTool],
    mode: "two_stage",
    stage: ctx.awaitingCategorySelection ? "category_select" : "deterministic",
    estimatedSchemaTokens: selectorTokens,
    schemaBudgetExceeded: deterministicTokens > schemaBudget,
  }
}

/**
 * 从 HarnessProfile.toolset 推导默认类别集合
 */
export function categoriesForToolset(toolset: ToolsetSize): readonly ToolCategory[] {
  return TOOLSET_CATEGORIES[toolset]
}
