/**
 * SFR-50: 纯函数模式路由器
 *
 * 根据 workflowMode、当前 lifecycle、activeRole 和输入类型，
 * 输出唯一明确的动作，不再在 React 回调中散落模式判断。
 */

export type WorkflowMode = 'alone' | 'subagent' | 'loop' | 'eval'
export type AgentRole = 'worker' | 'supervisor'

export type WorkflowLifecycle =
  | { status: 'idle' }
  | { status: 'awaiting_goal' }
  | { status: 'running'; workflowId: string }
  | { status: 'waiting_user'; workflowId: string }
  | { status: 'blocked'; workflowId: string; reason?: string }
  | { status: 'completed'; workflowId: string }
  | { status: 'failed'; workflowId: string; reason?: string }

export type InputKind = 'command' | 'text'

export type WorkflowRouteAction =
  | { type: 'direct'; role: AgentRole; mode: 'alone' }
  | { type: 'supervisor_task'; mode: 'subagent' }
  | { type: 'start_workflow'; goal: string }
  | { type: 'resume_workflow'; instruction: string }
  | { type: 'workflow_instruction'; content: string }
  | { type: 'reject'; reason: string }

export interface RouteWorkflowInputOpts {
  mode: WorkflowMode
  lifecycle: WorkflowLifecycle
  activeRole: AgentRole
  input: string
  inputKind: InputKind
}

/**
 * 根据当前模式和状态，路由一条用户输入。
 *
 * 规则（见 Supervisor能力退化修复方案.md 3.1）：
 * - alone: 发送给 activeRole
 * - subagent: 固定发送给 Supervisor
 * - loop 空闲/终态: 进入 awaiting_goal；下一条非命令输入触发 start_workflow
 * - loop running: 非命令输入作为 workflow_instruction
 * - 斜杠命令永远按命令处理
 */
function isResumableBlockedReason(reason?: string): boolean {
  return reason === 'Interrupted by user'
    || reason === 'Goal is paused'
    || reason === 'User rejected question'
}

export function routeWorkflowInput(opts: RouteWorkflowInputOpts): WorkflowRouteAction {
  const { mode, lifecycle, activeRole, input, inputKind } = opts

  // 斜杠命令永远按命令处理
  if (inputKind === 'command') {
    return { type: 'direct', role: activeRole, mode: 'alone' }
  }

  switch (mode) {
    case 'alone':
      return { type: 'direct', role: activeRole, mode: 'alone' }

    case 'subagent':
      return { type: 'supervisor_task', mode: 'subagent' }

    case 'eval':
      return { type: 'direct', role: activeRole, mode: 'alone' }

    case 'loop': {
      switch (lifecycle.status) {
        case 'idle':
        case 'awaiting_goal':
        case 'completed':
        case 'failed':
          return { type: 'start_workflow', goal: input }
        case 'running':
          return { type: 'workflow_instruction', content: input }
        case 'waiting_user':
          return { type: 'reject', reason: 'Workflow is waiting for your answer in the prompt.' }
        case 'blocked':
          if (isResumableBlockedReason(lifecycle.reason)) {
            return { type: 'resume_workflow', instruction: input }
          }
          return { type: 'reject', reason: 'Workflow is blocked and cannot resume automatically. Use /reset to start a new loop.' }
      }
    }
  }
}
