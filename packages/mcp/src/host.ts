import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { McpClient } from "./client.js"
import type { McpTool, McpResource } from "./client.js"

interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface McpConfig {
  mcpServers?: Record<string, McpServerConfig>
}

export class McpHost {
  private clients = new Map<string, McpClient>()
  private tools = new Map<string, { client: McpClient; tool: McpTool }>()
  private resources = new Map<string, { client: McpClient; resource: McpResource }>()

  get allTools(): Array<{ client: string; tool: McpTool }> {
    return Array.from(this.tools.values()).map(({ client, tool }) => ({ client: client.serverName, tool }))
  }

  get allResources(): Array<{ client: string; resource: McpResource }> {
    return Array.from(this.resources.values()).map(({ client, resource }) => ({ client: client.serverName, resource }))
  }

  async loadConfig(configPath?: string): Promise<void> {
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

    for (const [name, serverConfig] of Object.entries(config.mcpServers ?? {})) {
      await this.connect(name, serverConfig)
    }
  }

  async connect(name: string, config: McpServerConfig): Promise<void> {
    if (this.clients.has(name)) return

    const client = new McpClient(name)
    await client.connect(config.command, config.args ?? [], config.env)
    this.clients.set(name, client)

    // Register tools
    const tools = await client.listTools()
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
