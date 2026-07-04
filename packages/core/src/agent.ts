import type { AgentConfig } from "./interface.js"
import { MAIN_MODES, getMainMode } from "./main-mode.js"
import type { MainMode } from "./main-mode.js"
import { defaultAgentRegistry } from "./agent-registry.js"
import type { PromptLocale } from "./prompt-locale.js"
import { getPromptLocale } from "./prompt-locale.js"

export type { MainMode } from "./main-mode.js"
export { MAIN_MODES, getMainMode } from "./main-mode.js"
export { AgentRegistry, defaultAgentRegistry } from "./agent-registry.js"

export interface AgentDefinition {
  name: string
  label: string
  model?: string
  temperature?: number
  maxTokens?: number
  systemPrompt?: string
  /** Optional bilingual alternatives. systemPrompt is the fallback. */
  systemPromptByLocale?: Partial<Record<PromptLocale, string>>
  toolNames?: string[]
}

/** Resolve agent system prompt by locale. Falls back to systemPrompt if no locale match. */
export function getAgentSystemPrompt(def: AgentDefinition, locale?: PromptLocale): string | undefined {
  const resolvedLocale = locale ?? getPromptLocale()
  if (resolvedLocale !== "zh-CN" && def.systemPromptByLocale?.en) {
    return def.systemPromptByLocale.en
  }
  if (resolvedLocale === "zh-CN" && def.systemPromptByLocale?.["zh-CN"]) {
    return def.systemPromptByLocale["zh-CN"]
  }
  return def.systemPrompt
}

// 原生 agent 身份：仅注册 worker / supervisor 两个。
defaultAgentRegistry.register({
  name: "worker",
  label: "Worker",
  systemPrompt: `You are the Worker agent — the primary execution role in a dual-agent setup.
You have access to a full engineering toolset: read, write, edit files, run bash commands,
search code, manage tasks, fetch the web, and invoke MCP tools.
Always verify your changes — re-read files after editing when needed.
When operating under a Supervisor, execute the assigned tasks faithfully and report results concisely.
Notify the Supervisor when you encounter blockers, uncertainty, or when tasks are complete.`,
  systemPromptByLocale: {
    "zh-CN": `你是 Worker Agent——双 Agent 系统中的主要执行角色。
你拥有完整的工程工具集：读写编辑文件、运行 bash 命令、搜索代码、管理任务、访问网络和调用 MCP 工具。
修改后务必验证——必要时重新读取文件确认变更结果。
在 Supervisor 指导下工作时，忠实地执行分配的任务并简洁地报告结果。
遇到阻塞、不确定或任务完成时通知 Supervisor。`,
  },
  toolNames: [...MAIN_MODES.build.toolNames],
})
defaultAgentRegistry.register({
  name: "supervisor",
  label: "Supervisor",
  systemPrompt: "You are the Supervisor agent. Analyze goals, create plans, review evidence, delegate execution, and provide guidance. Follow the active workflow mode rules.",
  systemPromptByLocale: {
    "zh-CN": "你是 Supervisor Agent。分析目标、制定计划、审查证据、委派执行并提供指导。遵循当前工作流模式规则。",
  },
  // toolNames 保持 undefined：由 resolveEffectiveTools 的 phase/mode 策略统一计算
  // （SUPERVISOR_TOOLS_ALONE / SUPERVISOR_TOOLS_SUBAGENT / supervisorLoopToolsForPhase）
  // 修复 S1-5 时曾加显式 toolNames，但破坏了 SFR-30 设计契约，已回退。
  // 工具上界防护由 resolveEffectiveTools 中的 set 集合实现，无需在 agent.ts 重复声明。
})

/** Backward-compatible static snapshot */
export const AGENTS: Record<string, AgentDefinition> = defaultAgentRegistry.snapshot()

export function getAgent(name: string): AgentDefinition {
  return defaultAgentRegistry.get(name) ?? AGENTS.worker
}

export function agentConfigFor(name: string, overrides?: Partial<AgentConfig>): AgentConfig {
  const def = getAgent(name)
  const locale = getPromptLocale()
  return {
    name: def.name,
    model: overrides?.model,
    temperature: overrides?.temperature,
    maxTokens: overrides?.maxTokens,
    systemPrompt: overrides?.systemPrompt ?? getAgentSystemPrompt(def, locale),
    toolNames: overrides?.toolNames ?? def.toolNames,
  }
}
