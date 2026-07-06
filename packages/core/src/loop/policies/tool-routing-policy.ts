import type { ToolSpec } from "../../types.js"
import type { ToolCategory, ToolRoutingDecision, ToolRoutingMode } from "../../tool-routing/types.js"
import { resolveToolRouting } from "../../tool-routing/two-stage-router.js"
import type { EffectiveHarnessPolicy } from "../../harness/index.js"
import type { AgentRole } from "../../agent-profile/types.js"

export interface ResolveLoopToolRoutingInput {
  toolSpecs: ToolSpec[]
  toolRoutingMode?: "two-stage" | "auto" | "direct"
  contextWindow: number
  selectedCategory?: ToolCategory
  effectivePolicy?: EffectiveHarnessPolicy
  role?: AgentRole
  customToolNames?: Set<string>
  allowedToolNames?: ReadonlySet<string>
}

export interface ResolveLoopToolRoutingOutput {
  routedTools: ToolSpec[] | undefined
  effectiveAllowedToolNames: ReadonlySet<string> | undefined
  routingDecision: ToolRoutingDecision | undefined
}

export function resolveLoopToolRouting(input: ResolveLoopToolRoutingInput): ResolveLoopToolRoutingOutput {
  const { toolSpecs, toolRoutingMode, contextWindow, selectedCategory, effectivePolicy, role, customToolNames, allowedToolNames } = input

  if (toolSpecs.length === 0) {
    return { routedTools: undefined, effectiveAllowedToolNames: allowedToolNames, routingDecision: undefined }
  }

  const routingMode: ToolRoutingMode = toolRoutingMode === "two-stage" ? "two_stage"
    : toolRoutingMode === "auto" ? "auto"
    : "direct"

  const routingCtx = {
    allTools: toolSpecs,
    contextWindow,
    routingOverride: routingMode,
    selectedCategory,
    toolset: role === "supervisor" ? undefined : effectivePolicy?.toolset,
    customToolNames,
  }

  const routingDecision = resolveToolRouting(routingCtx)

  const routedTools = routingDecision.tools
  const effectiveAllowedToolNames = new Set(routedTools.map(spec => spec.function.name))

  return { routedTools, effectiveAllowedToolNames, routingDecision }
}
