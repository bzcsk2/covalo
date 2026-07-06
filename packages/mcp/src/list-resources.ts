import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "@covalo/tools"
import { getMcpHost } from "./mcp-host-global.js"

export function createListMcpResourcesTool(): AgentTool {
  return {
    name: "ListMcpResources",
    description: "List all MCP resources discovered from connected MCP servers.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    concurrency: "shared",
    approval: "read",
    async execute() {
      try {
        const host = getMcpHost()
        if (!host) {
          return { content: safeStringify({ error: "MCP host not initialized" }), isError: true }
        }
        const resources = host.allResources
        return {
          content: safeStringify({ count: resources.length, resources }),
          isError: false,
        }
      } catch (e) {
        return { content: safeStringify({ error: `ListResources error: ${e instanceof Error ? e.message : String(e)}` }), isError: true }
      }
    },
  }
}
