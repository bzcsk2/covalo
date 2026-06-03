import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { McpClient } from "./client.js"
import type { McpTool, McpResource } from "./client.js"
import type { DiagnosticLogger } from "./diagnostics.js"
import { noopDiagnosticLogger } from "./diagnostics.js"

interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

export interface McpLoadSummary {
  serverCount: number
  connected: number
  failed: Array<{ name: string; error: string }>
}

export class McpHost {
  private clients = new Map<string, McpClient>()
  private tools = new Map<string, { client: McpClient; tool: McpTool }>()
  private resources = new Map<string, { client: McpClient; resource: McpResource }>()
  private logger: DiagnosticLogger
  private lastLoadSummary: McpLoadSummary = { serverCount: 0, connected: 0, failed: [] }

  constructor(logger: DiagnosticLogger = noopDiagnosticLogger) {
    this.logger = logger
  }

  get allTools(): Array<{ client: string; tool: McpTool }> {
    return Array.from(this.tools.values()).map(({ client, tool }) => ({ client: client.serverName, tool }))
  }

  get allResources(): Array<{ client: string; resource: McpResource }> {
    return Array.from(this.resources.values()).map(({ client, resource }) => ({ client: client.serverName, resource }))
  }

  getStatus(): McpLoadSummary {
    return {
      serverCount: this.lastLoadSummary.serverCount,
      connected: this.clients.size,
      failed: [...this.lastLoadSummary.failed],
    }
  }

  async loadConfig(configPath?: string): Promise<McpLoadSummary> {
    const paths = configPath ? [configPath] : [
      resolve(process.cwd(), ".deepicode/mcp.json"),
    ]

    let config: McpConfig = {}
    for (const p of paths) {
      try {
        const raw = await readFile(p, "utf-8")
        config = JSON.parse(raw) as McpConfig
        break
      } catch { continue }
    }

    const auth = await readAuthStore()
    const entries = Object.entries(config.mcpServers ?? {})
    if (this.logger.isEnabled("info")) {
      this.logger.info("mcp.host.start", { serverCount: entries.length })
    }
    const failed: McpLoadSummary["failed"] = []
    await Promise.all(entries.map(([name, serverConfig]) =>
      this.connect(name, withCredential(serverConfig, auth[name]?.apiKey)).catch((error) => {
        failed.push({ name, error: error instanceof Error ? error.message : String(error) })
      })
    ))
    this.lastLoadSummary = { serverCount: entries.length, connected: entries.length - failed.length, failed }
    if (failed.length > 0 && this.logger.isEnabled("warn")) {
      this.logger.warn("mcp.load.warning", { serverCount: entries.length, failedCount: failed.length, failedServers: failed.map(f => f.name) })
    }
    return this.getStatus()
  }

  async connect(name: string, config: McpServerConfig): Promise<void> {
    if (this.clients.has(name)) return

    const startedAt = this.logger.isEnabled("info") ? Date.now() : 0
    if (this.logger.isEnabled("info")) {
      this.logger.info("mcp.server.connect.start", { mcpServer: name })
    }

    const client = new McpClient(name, this.logger)
    this.clients.set(name, client)

    try {
      await client.connect(config.command, config.args ?? [], config.env)

      // Register tools (sorted for stable prefix cache)
      const tools = (await client.listTools()).sort((a, b) => a.name.localeCompare(b.name))
      for (const tool of tools) {
        this.tools.set(`${name}:${tool.name}`, { client, tool })
      }

      // Register resources
      try {
        const resources = await client.listResources()
        for (const resource of resources) {
          this.resources.set(`${name}:${resource.uri}`, { client, resource })
        }
      } catch {
        // resources/list is optional
      }

      // Register prompts
      try {
        await client.listPrompts()
      } catch {
        // prompts/list is optional
      }

      if (this.logger.isEnabled("info")) {
        this.logger.info("mcp.server.connect.done", { mcpServer: name, durationMs: Date.now() - startedAt, toolCount: tools.length })
      }
    } catch (e) {
      if (this.logger.isEnabled("warn")) {
        this.logger.warn("mcp.server.connect.error", { mcpServer: name, durationMs: Date.now() - startedAt, errorClass: e instanceof Error ? e.name : "Unknown" })
      }
      if (this.clients.get(name) === client) {
        this.clients.delete(name)
      }
      await client.disconnect().catch(() => {})
      throw e
    }
  }

  async disconnectAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      await client.disconnect()
    }
    this.clients.clear()
    this.tools.clear()
    this.resources.clear()
  }

  async callTool(clientName: string, toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const client = this.clients.get(clientName)
    if (!client) throw new Error(`MCP client not found: ${clientName}`)
    return client.callTool(toolName, args)
  }

  async readResource(resourceUri: string): Promise<unknown> {
    for (const [, entry] of this.resources) {
      if (entry.resource.uri === resourceUri) {
        return entry.client.readResource(resourceUri)
      }
    }
    throw new Error(`Resource not found: ${resourceUri}`)
  }
}

async function readAuthStore(): Promise<Record<string, { apiKey: string }>> {
  try {
    return JSON.parse(await readFile(resolve(process.cwd(), ".deepicode/mcp-auth.json"), "utf8")) as Record<string, { apiKey: string }>
  } catch {
    return {}
  }
}

function withCredential(config: McpServerConfig, apiKey?: string): McpServerConfig {
  if (!apiKey) return config
  return {
    ...config,
    env: {
      MCP_API_KEY: apiKey,
      DEEPICODE_MCP_API_KEY: apiKey,
      ...config.env,
    },
  }
}
