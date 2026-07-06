import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "@covalo/tools"
import { getMcpHost } from "./mcp-host-global.js"

export function createListMcpToolsTool(): AgentTool {
  return {
    name: "ListMcpTools",
    description: "List tools discovered from connected MCP servers.",
    parameters: { type: "object", properties: {}, required: [] },
    concurrency: "shared",
    approval: "read",
    async execute() {
      const host = getMcpHost()
      if (!host) return { content: safeStringify({ error: "MCP host not initialized" }), isError: true }
      const tools = host.allTools.map(({ client, tool }) => ({
        server: client,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }))
      return { content: safeStringify({ count: tools.length, tools }), isError: false }
    },
  }
}
