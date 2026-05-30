import type { McpHost } from "./host.js"

const MCP_HOST_KEY = Symbol("mcpHost")

export function setMcpHost(host: McpHost): void {
  ;(globalThis as Record<symbol, unknown>)[MCP_HOST_KEY] = host
}

export function getMcpHost(): McpHost | undefined {
  return (globalThis as Record<symbol, unknown>)[MCP_HOST_KEY] as McpHost | undefined
}
