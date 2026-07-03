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
  "lsp",
  "todo_write",
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
    expect(inferToolCategory("lsp")).toBe("code_intel")
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
