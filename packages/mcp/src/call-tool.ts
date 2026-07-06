import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "@covalo/tools"
import { getMcpHost } from "./mcp-host-global.js"

export function createCallMcpToolTool(): AgentTool {
  return {
    name: "CallMcpTool",
    description: "Call a tool exposed by a connected MCP server. Use ListMcpTools first to inspect available tools and their input schema.",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string", description: "Connected MCP server name." },
        tool: { type: "string", description: "MCP tool name." },
        arguments: { type: "object", description: "Arguments passed to the MCP tool." },
      },
      required: ["server", "tool"],
    },
    concurrency: "exclusive",
    approval: "exec",
    async execute(args) {
      if (typeof args.server !== "string" || !args.server.trim() || typeof args.tool !== "string" || !args.tool.trim()) {
        return { content: safeStringify({ error: "server and tool are required" }), isError: true }
      }
      const host = getMcpHost()
      if (!host) return { content: safeStringify({ error: "MCP host not initialized" }), isError: true }
      try {
        const toolArgs = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
          ? args.arguments as Record<string, unknown>
          : {}
        return { content: safeStringify(await host.callTool(args.server, args.tool, toolArgs)), isError: false }
      } catch (e) {
        return { content: safeStringify({ error: `MCP tool call failed: ${e instanceof Error ? e.message : String(e)}` }), isError: true }
      }
    },
  }
}
