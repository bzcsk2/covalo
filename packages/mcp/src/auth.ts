import type { AgentTool } from "../../core/src/interface.js"
import { safeStringify } from "../../tools/src/safe-stringify.js"

export function createMcpAuthTool(): AgentTool {
  return {
    name: "McpAuth",
    description: "Manage MCP authentication. Use this to add or update API keys and tokens for MCP server connections.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The auth action: 'set' to store a credential, 'list' to show configured servers.",
          enum: ["set", "list"],
        },
        server: { type: "string", description: "Server name for 'set' action." },
        api_key: { type: "string", description: "API key for 'set' action." },
      },
      required: ["action"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args) {
      const action = args.action
      if (typeof action !== "string") {
        return { content: safeStringify({ error: "action must be a string" }), isError: true }
      }

      switch (action) {
        case "set": {
          if (typeof args.server !== "string" || typeof args.api_key !== "string") {
            return { content: safeStringify({ error: "server and api_key are required for set" }), isError: true }
          }
          // In a real implementation, store in encrypted config
          return {
            content: safeStringify({ status: "stored", server: args.server }),
            isError: false,
          }
        }
        case "list": {
          return {
            content: safeStringify({ configured: [] }),
            isError: false,
          }
        }
        default:
          return { content: safeStringify({ error: `Unknown action: ${action}` }), isError: true }
      }
    },
  }
}
