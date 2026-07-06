import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "@covalo/tools"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"

type AuthStore = Record<string, { apiKey: string; updatedAt: number }>

export function createMcpAuthTool(): AgentTool {
  return {
    name: "McpAuth",
    description: "Manage MCP authentication. Use this to add or update API keys and tokens for MCP server connections.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The auth action: 'set' to store a credential, 'delete' to remove one, or 'list' to show configured servers.",
          enum: ["set", "delete", "list"],
        },
        server: { type: "string", description: "Server name for 'set' action." },
        api_key: { type: "string", description: "API key for 'set' action." },
      },
      required: ["action"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args, ctx) {
      const action = args.action
      if (typeof action !== "string") {
        return { content: safeStringify({ error: "action must be a string" }), isError: true }
      }

      switch (action) {
        case "set": {
          if (typeof args.server !== "string" || !args.server.trim() || typeof args.api_key !== "string" || !args.api_key.trim()) {
            return { content: safeStringify({ error: "server and api_key are required for set" }), isError: true }
          }
          const filePath = authFile(ctx.cwd)
          const store = await readStore(filePath)
          store[args.server.trim()] = { apiKey: args.api_key, updatedAt: Date.now() }
          await writeStore(filePath, store)
          return {
            content: safeStringify({ status: "stored", server: args.server.trim() }),
            isError: false,
          }
        }
        case "delete": {
          if (typeof args.server !== "string" || !args.server.trim()) {
            return { content: safeStringify({ error: "server is required for delete" }), isError: true }
          }
          const filePath = authFile(ctx.cwd)
          const store = await readStore(filePath)
          const removed = delete store[args.server.trim()]
          await writeStore(filePath, store)
          return { content: safeStringify({ status: removed ? "deleted" : "not_found", server: args.server.trim() }), isError: false }
        }
        case "list": {
          const store = await readStore(authFile(ctx.cwd))
          return {
            content: safeStringify({
              configured: Object.entries(store).map(([server, value]) => ({ server, apiKey: mask(value.apiKey), updatedAt: value.updatedAt })),
            }),
            isError: false,
          }
        }
        default:
          return { content: safeStringify({ error: `Unknown action: ${action}` }), isError: true }
      }
    },
  }
}

function authFile(cwd?: string): string {
  return resolve(cwd ?? process.cwd(), ".covalo", "mcp-auth.json")
}

async function readStore(filePath: string): Promise<AuthStore> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as AuthStore : {}
  } catch {
    return {}
  }
}

async function writeStore(filePath: string, store: AuthStore): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  if (process.platform !== "win32") await chmod(filePath, 0o600)
}

function mask(value: string): string {
  return value.length <= 8 ? "********" : `${value.slice(0, 4)}...${value.slice(-4)}`
}
