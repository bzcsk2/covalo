import type { AgentConfig } from "./interface.js"

export interface AgentDefinition {
  name: string
  label: string
  model?: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
  toolNames?: string[]
}

export const AGENTS: Record<string, AgentDefinition> = {
  build: {
    name: "build",
    label: "Build Agent",
    systemPrompt: `You are a full-stack engineering agent with access to a complete toolset.
You can read, write, edit files, run bash commands, search code, and manage tasks.
Always verify your changes — re-read files after editing when needed.`,
    toolNames: ["bash", "read_file", "write_file", "edit", "list_dir", "grep", "todowrite", "glob", "WebFetch", "WebSearch", "Skill", "ListMcpResources", "ReadMcpResource", "McpAuth"],
  },
  plan: {
    name: "plan",
    label: "Plan Agent",
    systemPrompt: `You are a planning agent with read-only access.
You can read files, search code, list directories, and manage tasks — but you can NOT modify files or run commands.
Focus on analysis, planning, and providing actionable recommendations for the Build Agent.`,
    toolNames: ["read_file", "list_dir", "grep", "todowrite"],
  },
}

export function getAgent(name: string): AgentDefinition {
  return AGENTS[name] ?? AGENTS.build
}

export function agentConfigFor(name: string, overrides?: Partial<AgentConfig>): AgentConfig {
  const def = getAgent(name)
  return {
    name: def.name,
    model: overrides?.model,
    temperature: overrides?.temperature,
    maxTokens: overrides?.maxTokens,
    systemPrompt: overrides?.systemPrompt ?? def.systemPrompt,
    toolNames: overrides?.toolNames ?? def.toolNames,
  }
}
