/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted from gemini-cli/packages/cli/src/ui/components/SubagentProgressDisplay.tsx
 * for Deepreef TUI.
 *
 * Changes from Gemini:
 * - Renamed "subagent" → "worker" throughout
 * - Uses Deepreef WorkerDisplayData / AgentProgressData types
 * - Tool call display: name + truncated args
 * - Activity list icons: 💭 thought, ✓/✗/⏳ tool status
 */

import React from 'react';
import { Box, Text, type HexColor } from '@deepreef/ink';
import { getSemanticColors } from '../../theme/semantic-colors.js';
import type { WorkerDisplayData, WorkerStatus, AgentActivityItem } from './AgentGroupDisplay.js';
import { t } from '../../i18n/index.js';

interface AgentProgressDisplayProps {
  worker: WorkerDisplayData;
  terminalWidth: number;
}

function getStatusIcon(status: WorkerStatus): string {
  switch (status) {
    case 'running': return '!';
    case 'completed': return '\u2713';
    case 'failed': return '\u2717';
    case 'cancelled': return '\u2717';
    case 'idle': return '\u25CB';
    case 'queued': return '\u25CB';
    case 'waiting_permission':
    case 'waiting_question':
    case 'waiting_supervisor': return '\u23F3';
    case 'starting':
    case 'verifying':
    case 'paused': return '\u25C6';
    default: return '\u25CB';
  }
}

function getStatusColor(status: WorkerStatus): HexColor {
  const theme = getSemanticColors();
  switch (status) {
    case 'running': return theme.status.running as HexColor;
    case 'completed': return theme.status.success as HexColor;
    case 'failed':
    case 'cancelled': return theme.status.error as HexColor;
    case 'waiting_permission':
    case 'waiting_question':
    case 'waiting_supervisor': return theme.status.warning as HexColor;
    default: return theme.text.secondary as HexColor;
  }
}

function getStatusLabel(status: WorkerStatus): string {
  switch (status) {
    case 'queued': return t().agentStatusQueued;
    case 'starting': return t().agentStatusStarting;
    case 'running': return t().agentStatusRunning;
    case 'waiting_permission': return t().agentStatusPermission;
    case 'waiting_question': return t().agentStatusAnswer;
    case 'waiting_supervisor': return t().agentStatusReview;
    case 'verifying': return t().agentStatusVerifying;
    case 'paused': return t().agentStatusPaused;
    case 'completed': return t().agentStatusCompleted;
    case 'failed': return t().agentStatusFailed;
    case 'cancelled': return t().agentStatusCancelled;
    case 'idle': return t().agentStatusIdle;
    default: return status;
  }
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

function renderActivityItem(item: AgentActivityItem, maxWidth: number): React.ReactNode {
  const theme = getSemanticColors();

  if (item.type === 'thought') {
    return (
      <Box key={`${item.ts}-${item.content.slice(0, 20)}`} flexDirection="row" paddingLeft={2}>
        <Text color={theme.ui.comment as HexColor}>{'\uD83D\uDCAD'} </Text>
        <Text color={theme.text.secondary as HexColor} wrap="truncate-end">
          {truncate(item.content, maxWidth - 6)}
        </Text>
      </Box>
    );
  }

  if (item.type === 'tool_call') {
    const toolIcon =
      item.status === 'completed' ? '\u2713'
      : item.status === 'error' ? '\u2717'
      : item.status === 'cancelled' ? '\u2717'
      : '\u23F3';
    const toolColor: HexColor =
      item.status === 'completed' ? theme.status.success as HexColor
      : item.status === 'error' ? theme.status.error as HexColor
      : item.status === 'cancelled' ? theme.status.error as HexColor
      : theme.status.running as HexColor;

    const label = item.toolName
      ? (item.content ? `${item.toolName}(${truncate(item.content, 30)})` : item.toolName)
      : truncate(item.content, 40);

    return (
      <Box key={`${item.ts}-${item.content.slice(0, 20)}`} flexDirection="row" paddingLeft={2}>
        <Text color={toolColor}>{toolIcon} </Text>
        <Text color={theme.text.primary as HexColor} wrap="truncate-end">
          {truncate(label, maxWidth - 6)}
        </Text>
      </Box>
    );
  }

  if (item.type === 'tool_result') {
    return (
      <Box key={`${item.ts}-${item.content.slice(0, 20)}`} flexDirection="row" paddingLeft={4}>
        <Text color={theme.text.secondary as HexColor} wrap="truncate-end">
          {truncate(item.content, maxWidth - 6)}
        </Text>
      </Box>
    );
  }

  if (item.type === 'state_change') {
    return (
      <Box key={`${item.ts}-${item.content.slice(0, 20)}`} flexDirection="row" paddingLeft={2}>
        <Text color={theme.ui.comment as HexColor}>\u25C6 </Text>
        <Text color={theme.text.secondary as HexColor} wrap="truncate-end">
          {truncate(item.content, maxWidth - 6)}
        </Text>
      </Box>
    );
  }

  return null;
}

export const AgentProgressDisplay: React.FC<AgentProgressDisplayProps> = ({
  worker,
  terminalWidth,
}) => {
  const theme = getSemanticColors();
  const icon = getStatusIcon(worker.status);
  const color = getStatusColor(worker.status);
  const label = getStatusLabel(worker.status);
  const maxWidth = terminalWidth - 4;

  return (
    <Box flexDirection="column" paddingX={1} width={terminalWidth}>
      {/* Worker header */}
      <Box flexDirection="row">
        <Text color={color as HexColor}>{icon} </Text>
        <Text bold color={theme.text.primary as HexColor}>{worker.modelName}</Text>
        <Text color={color as HexColor}> {label}</Text>
        {worker.duration && (
          <Text color={theme.text.secondary as HexColor}> {worker.duration}</Text>
        )}
      </Box>

      {/* Current task */}
      {worker.currentTask && (
        <Box flexDirection="row" paddingLeft={2}>
          <Text color={theme.text.secondary as HexColor} wrap="truncate-end">
            {truncate(worker.currentTask, maxWidth)}
          </Text>
        </Box>
      )}

      {/* Activity list */}
      {worker.progress?.activities && worker.progress.activities.length > 0 && (
        <Box flexDirection="column" paddingTop={0}>
          {worker.progress.activities.map(item =>
            renderActivityItem(item, maxWidth),
          )}
        </Box>
      )}

      {/* Result */}
      {worker.progress?.result && (
        <Box flexDirection="row" paddingLeft={2} paddingTop={0}>
          <Text color={theme.status.success as HexColor}>{'\u2713'} </Text>
          <Text color={theme.text.secondary as HexColor} wrap="truncate-end">
            {truncate(worker.progress.result, maxWidth - 4)}
          </Text>
        </Box>
      )}

      {/* Terminate reason */}
      {worker.progress?.terminateReason && (
        <Box flexDirection="row" paddingLeft={2} paddingTop={0}>
          <Text color={theme.status.error as HexColor}>{'\u2717'} </Text>
          <Text color={theme.text.secondary as HexColor} wrap="truncate-end">
            {truncate(worker.progress.terminateReason, maxWidth - 4)}
          </Text>
        </Box>
      )}
    </Box>
  );
};
