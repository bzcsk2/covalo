import { describe, expect, it } from "vitest"

import type { ToolSpec } from "../src/types.js"
import {
  TOOL_CATEGORIES,
  getRoutingMode,
  estimateToolSchemaTokens,
  shouldUseTwoStageRouting,
  inferToolCategory,
  applyDeterministicCategoryFilter,
  getCategorySelectorTool,
  getToolsForCategory,
  estimateRoutingSavings,
  parseSelectedCategory,
  resolveToolRouting,
  categoriesForToolset,
  resolveSchemaTokenBudget,
} from "../src/tool-routing/index.js"

function makeTool(name: string): ToolSpec {
  return {
    type: "function",
    function: {
      name,
      description: `Tool ${name}`,
      parameters: { type: "object", properties: {} },
    },
  }
}

const ALL_BUILTIN_TOOLS = [
  "read_file",
  "write_file",
  "edit",
  "grep",
  "bash",
  "LSP",
  "todowrite",
].map(makeTool)

describe("getRoutingMode", () => {
  it("<=16k 上下文默认 two_stage", () => {
    expect(getRoutingMode(16_384)).toBe("two_stage")
    expect(getRoutingMode(8192)).toBe("two_stage")
  })

  it(">16k 上下文默认 direct", () => {
    expect(getRoutingMode(32_768)).toBe("direct")
  })

  it("尊重 routingOverride", () => {
    expect(getRoutingMode(8192, "direct")).toBe("direct")
    expect(getRoutingMode(128_000, "two_stage")).toBe("two_stage")
  })

  it("TR-1: auto 走自动检测（小上下文 two_stage，大上下文 direct）", () => {
    expect(getRoutingMode(8192, "auto")).toBe("two_stage")
    expect(getRoutingMode(128_000, "auto")).toBe("direct")
  })
})

describe("inferToolCategory", () => {
  it("识别内置工具类别", () => {
    expect(inferToolCategory("read_file")).toBe("read")
    expect(inferToolCategory("bash")).toBe("run")
    // TR-1: 工具名已修正为真实名 LSP（原 lsp 不再存在）
    expect(inferToolCategory("LSP")).toBe("code_intel")
  })

  it("未知工具归入 full", () => {
    expect(inferToolCategory("custom_mcp_tool")).toBe("full")
  })

  it("MCP metadata 映射优先", () => {
    expect(
      inferToolCategory("custom_mcp_tool", { custom_mcp_tool: "search" }),
    ).toBe("search")
  })
})

describe("applyDeterministicCategoryFilter", () => {
  it("minimal toolset 仅保留 read/write", () => {
    const { tools, categories } = applyDeterministicCategoryFilter(ALL_BUILTIN_TOOLS, {
      toolset: "minimal",
    })
    const names = tools.map((t) => t.function.name)
    expect(names).toEqual(expect.arrayContaining(["read_file", "write_file", "edit"]))
    expect(names).not.toContain("bash")
    expect(categories).toEqual(expect.arrayContaining(["read", "write"]))
  })

  it("none toolset 返回空", () => {
    const { tools } = applyDeterministicCategoryFilter(ALL_BUILTIN_TOOLS, { toolset: "none" })
    expect(tools).toHaveLength(0)
  })

  it("selectedCategory 进一步收窄", () => {
    const { tools } = applyDeterministicCategoryFilter(ALL_BUILTIN_TOOLS, {
      toolset: "full",
      selectedCategory: "run",
    })
    expect(tools.map((t) => t.function.name)).toEqual(["bash"])
  })

  it("未知 MCP 工具在 full toolset 时保留", () => {
    const tools = [...ALL_BUILTIN_TOOLS, makeTool("mcp_unknown")]
    const filtered = applyDeterministicCategoryFilter(tools, { toolset: "full" })
    expect(filtered.tools.some((t) => t.function.name === "mcp_unknown")).toBe(true)
  })

  it("REGRESSION: category==='full' 的未知工具在 minimal 中不应放行，除非在 customToolNames 中", () => {
    // 模拟一个"忘记分类"的内置工具（category='full' 但不在 customToolNames 中）
    const tools = [...ALL_BUILTIN_TOOLS, makeTool("unlisted_builtin")]
    // minimal + 无 customToolNames：未知工具被过滤
    const { tools: filtered } = applyDeterministicCategoryFilter(tools, {
      toolset: "minimal",
    })
    expect(filtered.some((t) => t.function.name === "unlisted_builtin")).toBe(false)

    // minimal + customToolNames 包含它：放行
    const { tools: filtered2 } = applyDeterministicCategoryFilter(tools, {
      toolset: "minimal",
      customToolNames: new Set(["unlisted_builtin"]),
    })
    expect(filtered2.some((t) => t.function.name === "unlisted_builtin")).toBe(true)
  })

  it("REGRESSION: category==='full' 的自定义工具在 coding 中不应放行，除非在 customToolNames 中", () => {
    const tools = [...ALL_BUILTIN_TOOLS, makeTool("my_custom_api")]
    // coding + 无 customToolNames：过滤
    const { tools: filtered } = applyDeterministicCategoryFilter(tools, {
      toolset: "coding",
    })
    expect(filtered.some((t) => t.function.name === "my_custom_api")).toBe(false)

    // coding + customToolNames：放行
    const { tools: filtered2 } = applyDeterministicCategoryFilter(tools, {
      toolset: "coding",
      customToolNames: new Set(["my_custom_api"]),
    })
    expect(filtered2.some((t) => t.function.name === "my_custom_api")).toBe(true)
  })
})

describe("getToolsForCategory", () => {
  it("按类别过滤", () => {
    const readTools = getToolsForCategory("read", ALL_BUILTIN_TOOLS)
    expect(readTools.map((t) => t.function.name)).toEqual(["read_file"])
  })

  it("full 返回全部", () => {
    expect(getToolsForCategory("full", ALL_BUILTIN_TOOLS)).toHaveLength(ALL_BUILTIN_TOOLS.length)
  })
})

describe("shouldUseTwoStageRouting", () => {
  it("小上下文强制 two_stage", () => {
    expect(
      shouldUseTwoStageRouting({ contextWindow: 8192, schemaTokens: 100 }),
    ).toBe(true)
  })

  it("大上下文小模型 schema 超预算时 two_stage", () => {
    const budget = resolveSchemaTokenBudget(32_768)
    expect(
      shouldUseTwoStageRouting({
        contextWindow: 32_768,
        schemaTokens: budget + 1,
        sizeClass: "small",
      }),
    ).toBe(true)
  })

  it("大上下文 medium 模型不超预算时 direct", () => {
    expect(
      shouldUseTwoStageRouting({
        contextWindow: 32_768,
        schemaTokens: 100,
        sizeClass: "medium",
      }),
    ).toBe(false)
  })
})

describe("resolveToolRouting", () => {
  it("大上下文 full toolset 走 direct", () => {
    const decision = resolveToolRouting({
      allTools: ALL_BUILTIN_TOOLS,
      contextWindow: 128_000,
      toolset: "full",
      sizeClass: "large",
    })
    expect(decision.mode).toBe("direct")
    expect(decision.stage).toBe("direct")
    expect(decision.tools.length).toBeGreaterThan(1)
  })

  it("小上下文 two_stage 先注入 select_category", () => {
    const decision = resolveToolRouting({
      allTools: ALL_BUILTIN_TOOLS,
      contextWindow: 8192,
      toolset: "full",
    })
    expect(decision.mode).toBe("two_stage")
    expect(decision.tools).toHaveLength(1)
    expect(decision.tools[0].function.name).toBe("select_category")
  })

  it("选定类别后注入该类别工具", () => {
    const decision = resolveToolRouting({
      allTools: ALL_BUILTIN_TOOLS,
      contextWindow: 8192,
      toolset: "full",
      selectedCategory: "read",
    })
    expect(decision.stage).toBe("category_tools")
    expect(decision.tools.map((t) => t.function.name)).toEqual(["read_file"])
  })

  it("minimal toolset 确定性过滤后再 two_stage", () => {
    const decision = resolveToolRouting({
      allTools: ALL_BUILTIN_TOOLS,
      contextWindow: 8192,
      toolset: "minimal",
    })
    expect(decision.mode).toBe("two_stage")
    const selector = decision.tools[0]
    const enumValues = (selector.function.parameters as { properties: { category: { enum: string[] } } })
      .properties.category.enum
    expect(enumValues).toEqual(expect.arrayContaining(["read", "write"]))
    expect(enumValues).not.toContain("run")
  })

  it("TR-1: routingOverride=auto 小上下文走 two_stage", () => {
    const decision = resolveToolRouting({
      allTools: ALL_BUILTIN_TOOLS,
      contextWindow: 8192,
      toolset: "full",
      routingOverride: "auto",
    })
    expect(decision.mode).toBe("two_stage")
    expect(decision.tools).toHaveLength(1)
    expect(decision.tools[0].function.name).toBe("select_category")
  })

  it("TR-1: routingOverride=auto 大上下文走 direct", () => {
    const decision = resolveToolRouting({
      allTools: ALL_BUILTIN_TOOLS,
      contextWindow: 128_000,
      toolset: "full",
      sizeClass: "large",
      routingOverride: "auto",
    })
    expect(decision.mode).toBe("direct")
    expect(decision.tools.length).toBeGreaterThan(1)
  })

  it("TR-1: selectedCategory 存在且不设 awaitingCategorySelection → 进入 Stage 2 (category_tools)", () => {
    // 审核反馈：原先 loop.ts 设置 awaitingCategorySelection=true 导致
    // router 永远重新注入 select_category，进不了 Stage 2。
    // 修正后 loop.ts 不设置 awaitingCategorySelection，router 应进入 Stage 2。
    const decision = resolveToolRouting({
      allTools: ALL_BUILTIN_TOOLS,
      contextWindow: 8192,
      toolset: "full",
      routingOverride: "two_stage",
      selectedCategory: "read",
      // 故意不设置 awaitingCategorySelection（即 undefined）
    })
    expect(decision.mode).toBe("two_stage")
    expect(decision.stage).toBe("category_tools")
    // Stage 2 工具集不应包含 select_category
    expect(decision.tools.some(t => t.function.name === "select_category")).toBe(false)
    // 应包含 read 类工具
    expect(decision.tools.some(t => t.function.name === "read_file")).toBe(true)
  })

  it("REGRESSION: resolveToolRouting 使用 ctx.customToolNames 在 direct 模式放行自定义工具", () => {
    const tools = [...ALL_BUILTIN_TOOLS, makeTool("custom_db_query")]
    // large context + routingOverride=direct + minimal + customToolNames
    // → 直接模式，custom_db_query 因在 customToolNames 中得以放行
    const decision = resolveToolRouting({
      allTools: tools,
      contextWindow: 128_000,
      toolset: "minimal",
      sizeClass: "large",
      routingOverride: "direct",
      customToolNames: new Set(["custom_db_query"]),
    })
    expect(decision.mode).toBe("direct")
    expect(decision.tools.some((t) => t.function.name === "custom_db_query")).toBe(true)
  })

  it("REGRESSION: resolveToolRouting 无 customToolNames 时 category==='full' 的未知工具在 direct minimal 中被过滤", () => {
    const tools = [...ALL_BUILTIN_TOOLS, makeTool("unlisted_builtin")]
    // large context + direct + minimal + 无 customToolNames → unknown 工具被过滤
    const decision = resolveToolRouting({
      allTools: tools,
      contextWindow: 128_000,
      toolset: "minimal",
      sizeClass: "large",
      routingOverride: "direct",
    })
    expect(decision.mode).toBe("direct")
    expect(decision.tools.some((t) => t.function.name === "unlisted_builtin")).toBe(false)
  })

  it("REGRESSION: resolveToolRouting full toolset 时所有工具都放行（即使不在 customToolNames）", () => {
    const tools = [...ALL_BUILTIN_TOOLS, makeTool("weird_tool")]
    const decision = resolveToolRouting({
      allTools: tools,
      contextWindow: 128_000,
      toolset: "full",
      sizeClass: "large",
      routingOverride: "direct",
    })
    expect(decision.mode).toBe("direct")
    expect(decision.tools.some((t) => t.function.name === "weird_tool")).toBe(true)
  })

  it("TR-1: selectedCategory 存在但 awaitingCategorySelection=true → 重新进入 category_select", () => {
    // 验证 router 语义：awaitingCategorySelection=true 表示需要重新选择
    const decision = resolveToolRouting({
      allTools: ALL_BUILTIN_TOOLS,
      contextWindow: 8192,
      toolset: "full",
      routingOverride: "two_stage",
      selectedCategory: "read",
      awaitingCategorySelection: true,
    })
    expect(decision.stage).toBe("category_select")
    expect(decision.tools.some(t => t.function.name === "select_category")).toBe(true)
  })
})

describe("TOOL_CATEGORIES 工具名一致性", () => {
  it("TR-1: plan 类别包含真实工具名（todowrite/Question/PlanMode/AgentTool）", () => {
    // 审核反馈：原 TOOL_CATEGORIES.plan 写的是 todo_write/ask_user_question/
    // plan_mode/agent_tool，与真实工具名不一致，导致 two-stage 启用后
    // 这些工具被过滤掉。
    const planTools = TOOL_CATEGORIES.plan.tools
    expect(planTools).toContain("todowrite")
    expect(planTools).toContain("Question")
    expect(planTools).toContain("PlanMode")
    expect(planTools).toContain("AgentTool")
    // 不应包含错误的旧名
    expect(planTools).not.toContain("todo_write")
    expect(planTools).not.toContain("ask_user_question")
    expect(planTools).not.toContain("plan_mode")
    expect(planTools).not.toContain("agent_tool")
  })

  it("TR-1: code_intel 类别使用 LSP（不是 lsp）", () => {
    expect(TOOL_CATEGORIES.code_intel.tools).toContain("LSP")
    expect(TOOL_CATEGORIES.code_intel.tools).not.toContain("lsp")
  })

  it("TR-1: run 类别使用 PascalCase 真实名（Monitor/Cron/Workflow/Worktree/PushNotification）", () => {
    const runTools = TOOL_CATEGORIES.run.tools
    expect(runTools).toContain("Monitor")
    expect(runTools).toContain("Cron")
    expect(runTools).toContain("Workflow")
    expect(runTools).toContain("Worktree")
    expect(runTools).toContain("PushNotification")
    expect(runTools).not.toContain("monitor")
    expect(runTools).not.toContain("cron")
    expect(runTools).not.toContain("workflow")
    expect(runTools).not.toContain("worktree")
    expect(runTools).not.toContain("push_notification")
  })
})

describe("parseSelectedCategory", () => {
  it("解析合法类别", () => {
    expect(parseSelectedCategory(JSON.stringify({ category: "read" }))).toBe("read")
  })

  it("非法 JSON 返回 undefined", () => {
    expect(parseSelectedCategory("not-json")).toBeUndefined()
  })
})

describe("estimateRoutingSavings", () => {
  it("two_stage 应低于 direct token", () => {
    const { directTokens, twoStageTokens, savingsPercent } = estimateRoutingSavings(ALL_BUILTIN_TOOLS)
    expect(directTokens).toBeGreaterThan(0)
    expect(twoStageTokens).toBeLessThan(directTokens)
    expect(savingsPercent).toBeGreaterThan(0)
  })
})

describe("categoriesForToolset", () => {
  it("coding 不含 plan", () => {
    const cats = categoriesForToolset("coding")
    expect(cats).toContain("read")
    expect(cats).not.toContain("plan")
  })
})

describe("TOOL_CATEGORIES", () => {
  it("包含六类内置定义", () => {
    expect(Object.keys(TOOL_CATEGORIES)).toHaveLength(6)
  })
})

describe("getCategorySelectorTool", () => {
  it("enum 与传入类别一致", () => {
    const tool = getCategorySelectorTool(["read", "write"])
    const params = tool.function.parameters as {
      properties: { category: { enum: string[] } }
    }
    expect(params.properties.category.enum).toEqual(["read", "write"])
  })
})

describe("estimateToolSchemaTokens", () => {
  it("空数组返回 0", () => {
    expect(estimateToolSchemaTokens([])).toBe(0)
  })
})
