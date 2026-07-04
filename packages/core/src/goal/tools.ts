import type { AgentTool, ToolContext, ToolResult } from "../interface.js"
import type { GoalStore } from "./store.js"
import type { GoalStatus } from "./types.js"
import type { WorkflowCoordinator } from "../workflow-coordinator/coordinator.js"

export interface GoalToolProvider {
  getGoalStore(): GoalStore
  getThreadId(): string
  getWorkflowCoordinator?(): WorkflowCoordinator | undefined
}

function buildGoalResponse(ok: boolean, action: string, extras?: Record<string, unknown>): string {
  return JSON.stringify({ ok, action, ...extras })
}

export function createGetGoalTool(provider: GoalToolProvider): AgentTool {
  return {
    name: "get_goal",
    description: "Get the current loop goal, including objective, status, and token usage. Returns JSON with ok, action, workflowId, goal (or null), and message.",
    parameters: {
      type: "object",
      properties: {},
    },
    concurrency: "shared",
    approval: "read",
    async execute(_args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      try {
        const store = provider.getGoalStore()
        const threadId = provider.getThreadId()
        const goal = store.getGoal(threadId)
        if (!goal) {
          return {
            content: buildGoalResponse(true, "status", { workflowId: threadId, goal: null, message: "No goal set for this workflow." }),
            isError: false,
          }
        }
        return {
          content: buildGoalResponse(true, "status", {
            workflowId: threadId,
            goal: {
              goalId: goal.goalId,
              objective: goal.objective,
              status: goal.status,
              tokensUsed: goal.tokensUsed,
              timeUsedSeconds: goal.timeUsedSeconds,
            },
          }),
          isError: false,
        }
      } catch (err) {
        return { content: buildGoalResponse(false, "status", { error: `Error reading goal: ${err}` }), isError: true }
      }
    },
  }
}

const VALID_ACTIONS = ["set", "update", "pause", "resume", "clear", "complete", "block"] as const

export function createUpdateGoalTool(provider: GoalToolProvider): AgentTool {
  return {
    name: "update_goal",
    description: "Update the current loop workflow goal. Use this only as the supervisor in loop mode when the user asks to set, update, pause, resume, clear, complete, or block the goal. Do not use this tool for token budgets; budget management is intentionally unsupported.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...VALID_ACTIONS],
          description: "The action to perform. set=create/replace goal, update=modify objective, pause=set paused, resume=set active, clear=delete goal, complete=mark complete, block=mark blocked.",
        },
        objective: {
          type: "string",
          description: "Goal objective (required for set/update).",
        },
        instruction: {
          type: "string",
          description: "Resume instruction (used when resuming a paused workflow).",
        },
        status: {
          type: "string",
          enum: ["complete", "blocked"],
          description: "Legacy parameter: set status directly (equivalent to action=complete or action=block).",
        },
        reason: {
          type: "string",
          description: "Reason for blocking (used when action is 'block' or status is 'blocked').",
        },
      },
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      try {
        const store = provider.getGoalStore()
        const threadId = provider.getThreadId()

        const rawAction = args.action ? String(args.action) : undefined
        const action = rawAction && (VALID_ACTIONS as readonly string[]).includes(rawAction)
          ? rawAction as typeof VALID_ACTIONS[number]
          : undefined
        const status = args.status ? String(args.status) : undefined
        const objective = args.objective ? String(args.objective) : undefined
        const instruction = args.instruction ? String(args.instruction) : undefined
        const reason = args.reason ? String(args.reason) : undefined

        // Determine effective action from status param
        const effectiveAction = action ?? (status === "complete" ? "complete" : status === "blocked" ? "block" : undefined)

        if (!effectiveAction) {
          return { content: buildGoalResponse(false, "unknown", { error: 'Must provide action (set|update|pause|resume|clear|complete|block) or status (complete|blocked).' }), isError: true }
        }

        const goal = store.getGoal(threadId)

        switch (effectiveAction) {
          case "set": {
            if (!objective) {
              return { content: buildGoalResponse(false, "set", { error: "objective required for set action." }), isError: true }
            }
            try {
              store.createGoal(threadId, objective)
            } catch {
              store.replaceGoal(threadId, objective)
            }
            const created = store.getGoal(threadId)
            return {
              content: buildGoalResponse(true, "set", {
                workflowId: threadId,
                goal: { objective: created?.objective, status: created?.status },
                message: "Goal set.",
              }),
              isError: false,
            }
          }

          case "update": {
            if (!goal) {
              return { content: buildGoalResponse(false, "update", { error: "No active goal for current workflow." }), isError: true }
            }
            if (!objective) {
              return { content: buildGoalResponse(false, "update", { error: "objective required for update action." }), isError: true }
            }
            store.updateGoal(threadId, { objective, expectedGoalId: goal.goalId })
            const updated = store.getGoal(threadId)
            return {
              content: buildGoalResponse(true, "update", {
                workflowId: threadId,
                goal: { objective: updated?.objective, status: updated?.status },
                message: "Goal objective updated.",
              }),
              isError: false,
            }
          }

          case "pause": {
            if (!goal) {
              return { content: buildGoalResponse(false, "pause", { error: "No active goal for current workflow." }), isError: true }
            }
            store.systemSetStatus(threadId, "paused")
            return {
              content: buildGoalResponse(true, "pause", {
                workflowId: threadId,
                goal: { objective: goal.objective, status: "paused" },
                message: "Goal paused.",
              }),
              isError: false,
            }
          }

          case "resume": {
            if (!goal) {
              return { content: buildGoalResponse(false, "resume", { error: "No active goal for current workflow." }), isError: true }
            }
            store.systemSetStatus(threadId, "active")
            const coordinator = provider.getWorkflowCoordinator?.()
            if (coordinator) {
              const coordState = coordinator.getState()
              if (coordState?.currentPhase === "blocked" && coordState?.blockedReason === "Goal is paused") {
                try {
                  coordinator.resumeBlockedWorkflow(instruction ?? "")
                } catch {
                  // Goal status already active, resume not strictly required
                }
              }
            }
            return {
              content: buildGoalResponse(true, "resume", {
                workflowId: threadId,
                goal: { objective: goal.objective, status: "active" },
                message: "Goal resumed.",
              }),
              isError: false,
            }
          }

          case "clear": {
            if (!goal) {
              return { content: buildGoalResponse(false, "clear", { error: "No active goal for current workflow." }), isError: true }
            }
            store.clearGoal(threadId)
            return {
              content: buildGoalResponse(true, "clear", {
                workflowId: threadId,
                message: "Goal cleared.",
              }),
              isError: false,
            }
          }

          case "complete": {
            if (!goal) {
              return { content: buildGoalResponse(false, "complete", { error: "No active goal for current workflow." }), isError: true }
            }
            store.updateGoal(threadId, { status: "complete", expectedGoalId: goal.goalId })
            return {
              content: buildGoalResponse(true, "complete", {
                workflowId: threadId,
                goal: { objective: goal.objective, status: "complete" },
                message: "Goal completed.",
              }),
              isError: false,
            }
          }

          case "block": {
            if (!goal) {
              return { content: buildGoalResponse(false, "block", { error: "No active goal for current workflow." }), isError: true }
            }
            store.updateGoal(threadId, { status: "blocked", expectedGoalId: goal.goalId })
            return {
              content: buildGoalResponse(true, "block", {
                workflowId: threadId,
                goal: { objective: goal.objective, status: "blocked" },
                message: reason ? `Goal blocked: ${reason}` : "Goal blocked.",
              }),
              isError: false,
            }
          }

          default:
            return { content: buildGoalResponse(false, "unknown", { error: `Unknown action: ${action}` }), isError: true }
        }
      } catch (err) {
        return { content: buildGoalResponse(false, "error", { error: `Error updating goal: ${err}` }), isError: true }
      }
    },
  }
}

export function createGoalTools(provider: GoalToolProvider): AgentTool[] {
  return [createGetGoalTool(provider), createUpdateGoalTool(provider)]
}
