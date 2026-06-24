/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Adapted from gemini-cli/packages/cli/src/ui/components/BackgroundTaskDisplay.tsx
 * for Deepreef TUI worker activity display.
 *
 * Changes from Gemini:
 * - Displays Worker instances instead of shell processes
 * - Worker list on top, selected worker output below
 * - Keyboard navigation: up/down to select worker, Enter to focus output, Esc to unfocus
 * - Status colors mapped to Deepreef semantic tokens
 */

import React, { useState, useCallback } from 'react';
import { Box, Text, useInput, type HexColor } from '@deepreef/ink';
import { getSemanticColors } from '../../theme/semantic-colors.js';
import { t } from '../../i18n/index.js';

export interface WorkerActivityData {
  id: string;
  modelName: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'waiting';
  recentOutput: string[];
  duration: string;
  currentTask?: string;
}

export interface WorkerActivityPanelProps {
  workers: WorkerActivityData[];
  activeWorkerId?: string;
  terminalWidth: number;
  terminalHeight: number;
  isFocused?: boolean;
  onSelectWorker?: (workerId: string) => void;
  onPauseWorker?: (workerId: string) => void;
  onResumeWorker?: (workerId: string) => void;
  onCancelWorker?: (workerId: string) => void;
}

const BORDER_WIDTH = 2;
const HEADER_HEIGHT = 1;
const DIVIDER_HEIGHT = 1;
const OUTPUT_VISIBLE_LINES = 15;

function getStatusIcon(status: WorkerActivityData['status']): string {
  switch (status) {
    case 'running': return '!';
    case 'completed': return '\u2713';
    case 'failed': return '\u2717';
    case 'paused': return '\u25C6';
    case 'waiting': return '\u25CB';
    default: return '\u25CB';
  }
}

function getStatusColor(status: WorkerActivityData['status']): HexColor {
  const theme = getSemanticColors();
  switch (status) {
    case 'running': return theme.status.running as HexColor;
    case 'completed': return theme.status.success as HexColor;
    case 'failed': return theme.status.error as HexColor;
    case 'paused':
    case 'waiting': return theme.status.warning as HexColor;
    default: return theme.text.secondary as HexColor;
  }
}

function getStatusLabel(status: WorkerActivityData['status']): string {
  switch (status) {
    case 'running': return t().agentStatusRunning;
    case 'completed': return t().agentStatusCompleted;
    case 'failed': return t().agentStatusFailed;
    case 'paused': return t().agentStatusPaused;
    case 'waiting': return t().agentStatusReview;
    default: return status;
  }
}

function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return text.slice(0, maxWidth - 3) + '...';
}

export const WorkerActivityPanel: React.FC<WorkerActivityPanelProps> = ({
  workers,
  activeWorkerId,
  terminalWidth,
  terminalHeight,
  isFocused = false,
  onSelectWorker,
  onPauseWorker,
  onResumeWorker,
  onCancelWorker,
}) => {
  const theme = getSemanticColors();
  const [selectedIndex, setSelectedIndex] = useState(() => {
    if (activeWorkerId) {
      const idx = workers.findIndex(w => w.id === activeWorkerId);
      return idx >= 0 ? idx : 0;
    }
    return 0;
  });
  const [focusedWorkerId, setFocusedWorkerId] = useState<string | undefined>(
    activeWorkerId,
  );

  const maxWorkerNameLength = Math.max(
    0,
    terminalWidth - BORDER_WIDTH - 40,
  );

  const handleKeyDown = useCallback(
    (input: string, key: { upArrow: boolean; downArrow: boolean; return: boolean; escape: boolean }) => {
      if (!isFocused) return;

      if (focusedWorkerId) {
        if (key.escape) {
          setFocusedWorkerId(undefined);
          onSelectWorker?.(workers[selectedIndex]?.id);
        }
        return;
      }

      if (key.upArrow) {
        setSelectedIndex(prev => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex(prev => Math.min(workers.length - 1, prev + 1));
      } else if (key.return) {
        const worker = workers[selectedIndex];
        if (worker) {
          setFocusedWorkerId(worker.id);
          onSelectWorker?.(worker.id);
        }
      }
    },
    [isFocused, focusedWorkerId, selectedIndex, workers, onSelectWorker],
  );

  useInput(handleKeyDown, { isActive: isFocused });

  const workerListHeight = Math.max(
    1,
    terminalHeight - HEADER_HEIGHT - DIVIDER_HEIGHT - OUTPUT_VISIBLE_LINES - 2,
  );
  const visibleWorkers = workers.slice(0, workerListHeight);

  return (
    <Box
      flexDirection="column"
      width={terminalWidth}
      height={terminalHeight}
      borderStyle="single"
      borderColor={
        focusedWorkerId
          ? (theme.status.running as HexColor)
          : isFocused
            ? (theme.ui.focus as HexColor)
            : (theme.border.default as HexColor)
      }
    >
      {/* Header */}
      <Box
        flexDirection="row"
        justifyContent="space-between"
        paddingX={1}
        borderStyle="single"
        borderBottom={true}
        borderLeft={false}
        borderRight={false}
        borderTop={false}
        borderColor={theme.border.default as HexColor}
      >
        <Text bold color={theme.text.primary as HexColor}>
          {t().workerPanelTitle}
        </Text>
        <Text color={theme.text.secondary as HexColor}>
          {t().workerPanelTotal(workers.length)}
          {focusedWorkerId ? ` ${t().workerPanelOutputFocused}` : ` ${t().workerPanelList}`}
        </Text>
      </Box>

      {/* Worker list */}
      <Box flexDirection="column" paddingX={1} height={workerListHeight + 1}>
        {visibleWorkers.length === 0 ? (
          <Text color={theme.text.secondary as HexColor}>{t().workerPanelNoActive}</Text>
        ) : (
          visibleWorkers.map((worker, index) => {
            const isSelected = index === selectedIndex;
            const icon = getStatusIcon(worker.status);
            const iconColor = getStatusColor(worker.status);
            const taskDisplay = worker.currentTask
              ? truncateText(worker.currentTask, maxWorkerNameLength)
              : worker.status === 'completed'
                ? t().workerTaskDone
                : worker.status === 'failed'
                  ? t().workerTaskError
                  : t().workerTaskIdle;

            return (
              <Box key={worker.id} flexDirection="row">
                <Text
                  color={iconColor}
                  bold={isSelected && isFocused}
                >
                  {icon}
                </Text>
                <Text
                  color={
                    isSelected && isFocused
                      ? (theme.text.primary as HexColor)
                      : (theme.text.secondary as HexColor)
                  }
                  bold={isSelected && isFocused}
                >
                  {' ' + truncateText(worker.modelName, 14)}
                </Text>
                <Text color={iconColor}>
                  {' ' + getStatusLabel(worker.status).padEnd(10)}
                </Text>
                <Text color={theme.text.secondary as HexColor}>
                  {' ' + taskDisplay.padEnd(20)}
                </Text>
                <Text color={theme.text.secondary as HexColor}>
                  {worker.duration.padStart(6)}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      {/* Divider */}
      <Box
        borderStyle="single"
        borderTop={true}
        borderBottom={true}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.border.default as HexColor}
      />

      {/* Output panel */}
      <Box flexDirection="column" paddingX={1} overflow="hidden" flexGrow={1}>
        {focusedWorkerId ? (
          (() => {
            const focusedWorker = workers.find(w => w.id === focusedWorkerId);
            if (!focusedWorker) {
              return (
                <Text color={theme.text.secondary as HexColor}>
                  {t().workerPanelNotFound}
                </Text>
              );
            }

            const outputLines = focusedWorker.recentOutput.slice(-OUTPUT_VISIBLE_LINES);
            if (outputLines.length === 0) {
              return (
                <Text color={theme.text.secondary as HexColor}>
                  {t().workerPanelNoOutput}
                </Text>
              );
            }

            return (
              <>
                <Text bold color={theme.text.primary as HexColor}>
                  {t().workerPanelOutput(focusedWorker.modelName)}
                </Text>
                {outputLines.map((line, i) => (
                  <Text key={i} wrap="truncate">
                    {line}
                  </Text>
                ))}
              </>
            );
          })()
        ) : (
          <Text color={theme.text.secondary as HexColor}>
            {t().workerPanelSelectHint}
          </Text>
        )}
      </Box>

      {/* Footer with action hints */}
      {isFocused && (
        <Box
          flexDirection="row"
          justifyContent="center"
          paddingX={1}
          borderStyle="single"
          borderTop={true}
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderColor={theme.border.default as HexColor}
        >
          <Text color={theme.text.secondary as HexColor}>
            {focusedWorkerId
              ? t().workerPanelEscBack
              : t().workerPanelNavigate}
          </Text>
        </Box>
      )}
    </Box>
  );
};
