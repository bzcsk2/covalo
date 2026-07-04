import { Box, Text } from '@covalo/ink';
import { FG, TONE } from '../../reasonix/tokens.js';
import { t } from '../../i18n/index.js';
import type { WorkflowLifecycle } from '../../workflow-mode-router.js';

export type WorkflowPhase =
  | 'idle'
  | 'supervisor_analyse'
  | 'worker_do'
  | 'worker_report'
  | 'supervisor_check'
  | 'supervisor_intervene'
  | 'continue'
  | 'revise'
  | 'approve'
  | 'blocked'
  | 'ask_user'
  | 'waiting_user'
  | 'completed'
  | 'failed';

export interface WorkflowState {
  phase: WorkflowPhase;
  iteration: number;
  maxRounds: number;
  goal: string;
  supervisorStatus: 'idle' | 'analyse' | 'waiting' | 'blocked';
  workerStatus: 'idle' | 'do' | 'report' | 'waiting' | 'blocked';
}

export interface WorkflowStatusBarProps {
  workflow: WorkflowState;
  lifecycle: WorkflowLifecycle;
  activeRole?: 'worker' | 'supervisor';
  workflowMode?: 'alone' | 'subagent' | 'loop' | 'eval';
  width?: number;
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'idle': return '';
    case 'supervisor_analyse': return t().workflowPhaseAnalyse;
    case 'worker_do': return t().workflowPhaseDo;
    case 'worker_report': return t().workflowPhaseReport;
    case 'supervisor_check': return t().workflowPhaseCheck;
    case 'continue': return t().workflowPhaseContinue;
    case 'revise': return t().workflowPhaseRevise;
    case 'approve': return t().workflowPhaseApprove;
    case 'blocked': return t().workflowPhaseBlocked;
    case 'ask_user': return t().workflowPhaseAskUser;
    default: return phase;
  }
}

function lifecycleLabel(status: string): string {
  switch (status) {
    case 'idle': return '';
    case 'awaiting_goal': return t().workflowLifecycleAwaitingGoal;
    case 'running': return t().workflowLifecycleRunning;
    case 'waiting_user': return t().workflowLifecycleWaiting;
    case 'blocked': return t().workflowLifecycleBlocked;
    case 'completed': return t().workflowLifecycleCompleted;
    case 'failed': return t().workflowLifecycleFailed;
    default: return status;
  }
}

function roleStatusLabel(status: string): string {
  switch (status) {
    case 'idle': return t().workflowRoleIdle;
    case 'analyse': return t().workflowRoleAnalyse;
    case 'do': return t().workflowRoleDo;
    case 'report': return t().workflowRoleReport;
    case 'waiting': return t().workflowRoleWait;
    case 'blocked': return t().workflowRoleBlocked;
    default: return status;
  }
}

function modeLabel(mode: string): string {
  switch (mode) {
    case 'alone': return t().workflowModeAlone;
    case 'subagent': return t().workflowModeSubagent;
    case 'loop': return t().workflowModeLoop;
    case 'eval': return 'EVAL';
    default: return mode;
  }
}

const PHASE_DISPLAY: Record<string, { prefix: string; color: string }> = {
  idle: { prefix: '', color: FG.faint },
  supervisor_analyse: { prefix: '[D]', color: TONE.brand },
  worker_do: { prefix: '[W]', color: TONE.ok },
  worker_report: { prefix: '[W]', color: TONE.ok },
  supervisor_check: { prefix: '[D]', color: TONE.brand },
  continue: { prefix: '[D]', color: TONE.brand },
  revise: { prefix: '[D]', color: TONE.warn },
  approve: { prefix: '[D]', color: TONE.ok },
  blocked: { prefix: '', color: TONE.error },
  ask_user: { prefix: '', color: TONE.warn },
};

const LIFECYCLE_DISPLAY: Record<string, { color: string }> = {
  idle: { color: FG.faint },
  awaiting_goal: { color: TONE.accent },
  running: { color: TONE.brand },
  waiting_user: { color: TONE.warn },
  blocked: { color: TONE.error },
  completed: { color: TONE.ok },
  failed: { color: TONE.error },
};

const ROLE_STATUS_COLORS: Record<string, string> = {
  idle: FG.faint,
  analyse: TONE.brand,
  do: TONE.ok,
  report: TONE.ok,
  waiting: FG.sub,
  blocked: TONE.error,
};

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 3) + '...';
}

const MODE_COLORS: Record<string, string> = {
  alone: FG.faint,
  subagent: TONE.accent,
  loop: TONE.brand,
  eval: TONE.ok,
};

export function WorkflowStatusBar({
  workflow,
  lifecycle,
  activeRole,
  workflowMode = 'alone',
  width = 80,
}: WorkflowStatusBarProps) {
  const { phase, iteration, maxRounds, goal, supervisorStatus, workerStatus } = workflow;
  const modeColor = MODE_COLORS[workflowMode] ?? MODE_COLORS.alone;
  const supervisorColor = ROLE_STATUS_COLORS[supervisorStatus] ?? ROLE_STATUS_COLORS.idle;
  const workerColor = ROLE_STATUS_COLORS[workerStatus] ?? ROLE_STATUS_COLORS.idle;

  return (
    <Box width="100%" flexDirection="row" paddingX={1}>
      <Text bold color={modeColor as any}>{modeLabel(workflowMode)}</Text>
      <Text color={FG.faint}>{'  '}</Text>

      {workflowMode === 'loop' && (
        <>
          <Text color={(LIFECYCLE_DISPLAY[lifecycle.status] ?? LIFECYCLE_DISPLAY.idle).color as any}>
            {lifecycleLabel(lifecycle.status)}
          </Text>
          {lifecycle.status === 'running' && phase !== 'idle' && (
            <>
              <Text color={FG.faint}>{' '}</Text>
              <Text color={(PHASE_DISPLAY[phase] ?? PHASE_DISPLAY.idle).color as any}>
                {PHASE_DISPLAY[phase]?.prefix ? `${PHASE_DISPLAY[phase].prefix} ` : ''}{phaseLabel(phase)}
              </Text>
              <Text color={FG.sub}>{` (${iteration}/${maxRounds})`}</Text>
            </>
          )}
          {lifecycle.status === 'blocked' && (
            <Text color={TONE.error}>{` ${t().workflowRoleBlocked}`}</Text>
          )}
          <Text color={FG.faint}>{'  '}</Text>
        </>
      )}

      <Box flexDirection="row" alignItems="center">
        <Box
          backgroundColor={activeRole === 'supervisor' ? (TONE.brand as any) : undefined}
        >
          <Text bold color={activeRole === 'supervisor' ? '#000' : FG.sub}>
            Supervisor
          </Text>
        </Box>
        <Text color={supervisorColor as any}>{'/' + roleStatusLabel(supervisorStatus)}</Text>
      </Box>

      <Text color={FG.faint}>{'  '}</Text>

      <Box flexDirection="row" alignItems="center">
        <Box backgroundColor={activeRole === 'worker' ? (TONE.ok as any) : undefined}>
          <Text bold color={activeRole === 'worker' ? '#000' : FG.sub}>
            Worker
          </Text>
        </Box>
        <Text color={workerColor as any}>{'/' + roleStatusLabel(workerStatus)}</Text>
      </Box>

      {workflowMode === 'loop' && (
        <>
          <Box flexGrow={1}>
            <Text color={FG.sub}>
              {goal ? truncateText(goal, Math.max(10, width - 50)) : lifecycle.status === 'awaiting_goal' ? t().workflowAwaitingGoal : ''}
            </Text>
          </Box>
        </>
      )}
    </Box>
  );
}
