import type { AgentTool, ToolSpec } from "@covalo/protocol"

export class ToolRegistry {
  private tools = new Map<string, AgentTool>()

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`)
    }
    this.tools.set(tool.name, tool)
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name)
  }

  list(): AgentTool[] {
    return [...this.tools.values()]
  }

  toToolSpecs(): ToolSpec[] {
    return this.list().map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }
}

