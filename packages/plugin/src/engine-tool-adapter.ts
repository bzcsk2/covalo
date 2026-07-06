import type { AgentTool } from "@covalo/protocol"
import type { PluginTool } from "./tool-adapter.js"
import { executePluginTool } from "./tool-adapter.js"

export function pluginToolToAgentTool(tool: PluginTool): AgentTool {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    concurrency: "exclusive",
    approval: "write",
    execute: async (args, ctx) => {
      try {
        const result = await executePluginTool(tool, args as Record<string, unknown>)
        return { content: result, isError: false }
      } catch (e) {
        return { content: e instanceof Error ? e.message : String(e), isError: true }
      }
    },
  }
}

export function pluginToolsToAgentTools(tools: PluginTool[]): AgentTool[] {
  return tools.map(pluginToolToAgentTool)
}
