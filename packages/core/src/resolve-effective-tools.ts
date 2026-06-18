import type { AgentTool } from "./interface.js"
import type { ToolSpec } from "./types.js"
import type { AgentRole } from "./agent-profile/types.js"
import type { WorkflowMode } from "./dual-agent-runtime/types.js"
import type { WorkflowPhase } from "./workflow-coordinator/types.js"

const SUPERVISOR_TOOLS_SUBAGENT = new Set([
  "AgentTool",
  "AskUserQuestion",
  "read_file",
  "grep",
  "list_dir",
  "todowrite",
])

const SUPERVISOR_TOOLS_ALONE = new Set([
  "AskUserQuestion",
  "read_file",
  "grep",
  "list_dir",
  "todowrite",
])

const LOOP_ORCHESTRATION_TOOLS = new Set([
  "get_goal",
  "update_goal",
  "send_message",
  "followup_task",
  "read_mailbox",
])

const SUPERVISOR_LOOP_ANALYSE_TOOLS = new Set([
  "get_goal",
  "list_dir",
])

const SUPERVISOR_LOOP_CHECK_TOOLS = new Set([
  "get_goal",
  "list_dir",
  "read_file",
  "grep",
])

const SUPERVISOR_LOOP_INTERVENE_TOOLS = new Set([
  "get_goal",
])

const SUPERVISOR_LOOP_DEFAULT_TOOLS = new Set([
  "get_goal",
])

export interface ResolveEffectiveToolsOpts {
  registeredTools: Map<string, AgentTool>
  role: AgentRole
  mode: WorkflowMode
  agentToolNames?: string[]
  workflowPhase?: WorkflowPhase
}

export interface ResolveEffectiveToolsResult {
  tools: ToolSpec[]
  filteredCount: number
  filteredReason?: string
}

function supervisorLoopToolsForPhase(phase: WorkflowPhase | undefined): Set<string> {
  switch (phase) {
    case "supervisor_analyse":
      return SUPERVISOR_LOOP_ANALYSE_TOOLS
    case "supervisor_check":
      return SUPERVISOR_LOOP_CHECK_TOOLS
    case "supervisor_intervene":
      return SUPERVISOR_LOOP_INTERVENE_TOOLS
    default:
      return SUPERVISOR_LOOP_DEFAULT_TOOLS
  }
}

export function resolveEffectiveTools(opts: ResolveEffectiveToolsOpts): ResolveEffectiveToolsResult {
  const { registeredTools, role, mode, agentToolNames, workflowPhase } = opts
  const toolSpecs: ToolSpec[] = []
  let filteredCount = 0
  let filteredReason: string | undefined

  for (const tool of registeredTools.values()) {
    const name = tool.name

    // Loop is coordinator-orchestrated: Supervisor tools are scoped by
    // workflow phase so analyse never gets read_file/grep (which would cause
    // infinite self-exploration instead of transitioning to worker_do).
    if (role === "supervisor" && mode === "loop") {
      const allowedTools = supervisorLoopToolsForPhase(workflowPhase)
      if (allowedTools.has(name)) {
        toolSpecs.push(toSpec(tool))
        continue
      }
      filteredCount++
      if (!filteredReason) {
        filteredReason = workflowPhase
          ? `supervisor loop phase ${workflowPhase}: phase-scoped tools only`
          : "supervisor loop mode: default governance tools only"
      }
      continue
    }

    // Worker loop gets only configured engineering tools. Goal/mailbox tools are
    // driven by WorkflowCoordinator so the fixed phase order stays intact.
    if (role === "worker" && mode === "loop") {
      if (LOOP_ORCHESTRATION_TOOLS.has(name)) {
        filteredCount++
        if (!filteredReason) filteredReason = "worker loop mode: goal/mailbox tools are coordinator-managed"
        continue
      }
      // For engineering tools, check agentToolNames
      if (agentToolNames !== undefined) {
        if (agentToolNames.length === 0) {
          filteredCount++
          if (!filteredReason) filteredReason = "agent config toolNames is empty array"
          continue
        }
        if (!agentToolNames.includes(name)) {
          filteredCount++
          continue
        }
      }
      toolSpecs.push(toSpec(tool))
      continue
    }

    // Worker non-loop: delegate to agentToolNames if specified
    if (role === "worker" && mode !== "loop") {
      if (agentToolNames !== undefined) {
        if (agentToolNames.length === 0) {
          filteredCount++
          if (!filteredReason) filteredReason = "agent config toolNames is empty array"
          continue
        }
        if (!agentToolNames.includes(name)) {
          filteredCount++
          continue
        }
      }
      toolSpecs.push(toSpec(tool))
      continue
    }

    // Supervisor alone/subagent
    if (role === "supervisor") {
      if (mode === "alone" && !SUPERVISOR_TOOLS_ALONE.has(name)) {
        filteredCount++
        if (!filteredReason) filteredReason = "supervisor alone mode: restricted toolset"
        continue
      }
      if (mode === "subagent" && !SUPERVISOR_TOOLS_SUBAGENT.has(name)) {
        filteredCount++
        if (!filteredReason) filteredReason = "supervisor subagent mode: restricted toolset"
        continue
      }
    }

    // Default: allow through agentToolNames if set
    if (agentToolNames !== undefined) {
      if (agentToolNames.length === 0) {
        filteredCount++
        if (!filteredReason) filteredReason = "agent config toolNames is empty array"
        continue
      }
      if (!agentToolNames.includes(name)) {
        filteredCount++
        continue
      }
    }

    toolSpecs.push(toSpec(tool))
  }

  return { tools: toolSpecs, filteredCount, filteredReason }
}

function toSpec(tool: AgentTool): ToolSpec {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }
}
