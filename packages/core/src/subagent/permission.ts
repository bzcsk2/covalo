/**
 * Subagent permission system — adapted from OpenCode (MIT License).
 * Source: packages/opencode/src/agent/subagent-permissions.ts
 *
 * Handles permission inheritance from parent to child agents,
 * and the bubble mechanism for requesting parent approval.
 *
 * Phase 2.2: deriveSubagentPermissions 和 createBubbleRequest 已删除
 * （bubble 协议未实装，无任何调用方）。
 * 详见 docs/unintegrated_code_audit_20260703.md §3.10e。
 * 保留：getToolTier / SubagentPermissionCheck / checkSubagentPermission
 * （被 subagent runtime 使用）。
 */

import type { SubagentPermissionMode } from "./types.js"

/* ── Tool Tier Classification ── */

const WRITE_TOOLS = new Set(["write_file", "edit", "NotebookEdit", "patch"])
const EXEC_TOOLS = new Set(["bash", "exec"])

export function getToolTier(toolName: string): "read" | "write" | "exec" {
  if (EXEC_TOOLS.has(toolName)) return "exec"
  if (WRITE_TOOLS.has(toolName)) return "write"
  return "read"
}

/* ── Permission Check Result ── */

export interface SubagentPermissionCheck {
  allowed: boolean
  reason?: string
  /** If true, the request should be bubbled to the parent */
  bubble?: boolean
}

/**
 * Check if a subagent is allowed to use a tool based on its permission mode.
 */
export function checkSubagentPermission(
  toolName: string,
  permissionMode: SubagentPermissionMode,
): SubagentPermissionCheck {
  switch (permissionMode) {
    case "readonly": {
      const tier = getToolTier(toolName)
      if (tier === "write" || tier === "exec") {
        return { allowed: false, reason: `Subagent in readonly mode cannot use tool: ${toolName}` }
      }
      return { allowed: true }
    }

    case "denyExec": {
      const tier = getToolTier(toolName)
      if (tier === "exec") {
        return { allowed: false, reason: `Subagent in denyExec mode cannot run exec tool: ${toolName}` }
      }
      return { allowed: true }
    }

    case "acceptEdits": {
      const tier = getToolTier(toolName)
      if (tier === "exec") {
        // exec still needs approval via bubble
        return { allowed: false, bubble: true, reason: `Subagent in acceptEdits mode needs parent approval for exec: ${toolName}` }
      }
      return { allowed: true }
    }

    case "bubble": {
      // All tools need parent approval
      return { allowed: false, bubble: true, reason: `Subagent in bubble mode needs parent approval for: ${toolName}` }
    }

    default:
      return { allowed: false, reason: `Unknown permission mode: ${permissionMode}` }
  }
}
