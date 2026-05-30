import type { AgentTool } from "../../core/src/interface.js"
import { safeStringify } from "../../tools/src/safe-stringify.js"
import { getMcpHost } from "./mcp-host-global.js"

export function createReadMcpResourceTool(): AgentTool {
  return {
    name: "ReadMcpResource",
    description: "Read content from an MCP resource by its URI.",
    parameters: {
      type: "object",
      properties: {
        uri: { type: "string", description: "The URI of the MCP resource to read." },
      },
      required: ["uri"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args) {
      if (typeof args.uri !== "string" || !args.uri) {
        return { content: safeStringify({ error: "uri is required" }), isError: true }
      }
      try {
        const host = getMcpHost()
        if (!host) {
          return { content: safeStringify({ error: "MCP host not initialized" }), isError: true }
        }
        const result = await host.readResource(args.uri)
        return {
          content: safeStringify({ uri: args.uri, content: result }),
          isError: false,
        }
      } catch (e) {
        return { content: safeStringify({ error: `ReadResource error: ${e instanceof Error ? e.message : String(e)}` }), isError: true }
      }
    },
  }
}
