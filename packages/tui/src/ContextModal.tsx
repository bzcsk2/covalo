import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from '@deepreef/ink';
import type { ContextPolicy, ContextPolicyStatus, ContextReductionResult } from '@deepreef/core';
import { ModalShell } from './ModalShell.js';
import { FG, TONE } from './reasonix/tokens.js';
import { t } from './i18n/index.js';

interface ContextModalProps {
  policy: ContextPolicy;
  loadStatus: () => Promise<ContextPolicyStatus>;
  onPolicyChange: (policy: Partial<ContextPolicy>) => void | Promise<void>;
  onRunReduction: () => Promise<ContextReductionResult>;
  onClose: () => void;
}

type Row = 'mode' | 'trigger' | 'target' | 'run';
const ROWS: Row[] = ['mode', 'trigger', 'target', 'run'];

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function tokens(value: number): string {
  return value.toLocaleString('en-US');
}

function clampRatio(value: number): number {
  return Math.max(0.05, Math.min(0.95, Math.round(value * 100) / 100));
}

export function ContextModal({ policy, loadStatus, onPolicyChange, onRunReduction, onClose }: ContextModalProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [current, setCurrent] = useState<ContextPolicy>(policy);
  const [status, setStatus] = useState<ContextPolicyStatus | null>(null);
  const [message, setMessage] = useState(t().contextLoading);
  const [busy, setBusy] = useState(false);

  const selectedRow = ROWS[selectedIdx] ?? 'mode';
  const subtitle = useMemo(() => {
    if (!status) return message;
    return `used ${pct(status.ratio)} (${tokens(status.totalTokens)} / ${tokens(status.window)} tokens)`;
  }, [message, status]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const next = await loadStatus();
        if (!alive) return;
        setStatus(next);
        setCurrent(next.policy);
        setMessage(t().contextLoaded);
      } catch (error) {
        if (alive) setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { alive = false; };
  }, [loadStatus]);

  async function savePatch(patch: Partial<ContextPolicy>): Promise<void> {
    const next = { ...current, ...patch };
    if (next.targetRatio >= next.triggerRatio) {
      next.targetRatio = Math.max(0.05, next.triggerRatio - 0.05);
    }
    setCurrent(next);
    await onPolicyChange(patch);
    try {
      const refreshed = await loadStatus();
      setStatus(refreshed);
      setCurrent(refreshed.policy);
      setMessage(t().contextSaved);
    } catch {
      setMessage(t().contextSaved);
    }
  }

  async function runNow(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage(t().contextReducing);
    try {
      const result = await onRunReduction();
      setMessage(t().contextRunResult(result.mode, tokens(result.beforeTokens), tokens(result.afterTokens), result.removedMessages));
      const refreshed = await loadStatus();
      setStatus(refreshed);
      setCurrent(refreshed.policy);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useInput((_input, key) => {
    if (key.escape || (key.ctrl && _input === 'c')) {
      onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx(prev => (prev - 1 + ROWS.length) % ROWS.length);
      return;
    }
    if (key.downArrow) {
      setSelectedIdx(prev => (prev + 1) % ROWS.length);
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const delta = key.rightArrow ? 0.05 : -0.05;
      if (selectedRow === 'trigger') {
        void savePatch({ triggerRatio: clampRatio(current.triggerRatio + delta) });
      } else if (selectedRow === 'target') {
        void savePatch({ targetRatio: clampRatio(current.targetRatio + delta) });
      }
      return;
    }
    if (key.return) {
      if (selectedRow === 'mode') {
        void savePatch({ mode: current.mode === 'trim' ? 'compact' : 'trim' });
      } else if (selectedRow === 'run') {
        void runNow();
      }
    }
  });

  const rows = [
    { key: 'mode', label: t().contextModeRowLabel, value: current.mode, description: t().contextModeDescription },
    { key: 'trigger', label: t().contextTriggerRowLabel, value: pct(current.triggerRatio), description: t().contextTriggerDescription(status ? tokens(status.triggerTokens) : '-') },
    { key: 'target', label: t().contextTargetRowLabel, value: pct(current.targetRatio), description: t().contextTargetDescription(status ? tokens(status.targetTokens) : '-') },
    { key: 'run', label: t().contextRunRowLabel, value: busy ? 'busy' : 'ready', description: t().contextRunDescription },
  ] as const;

  return (
    <ModalShell title="/context" subtitle={subtitle} onCancel={onClose} width={88}>
      <Box flexDirection="column" gap={1}>
        {rows.map((row, index) => {
          const selected = index === selectedIdx;
          return (
            <Box key={row.key} flexDirection="row">
              <Text color={selected ? TONE.brand : FG.faint}>{selected ? '❯ ' : '  '}</Text>
              <Box width={14}>
                <Text bold={selected} color={selected ? TONE.brand : FG.body}>{row.label}</Text>
              </Box>
              <Box width={12}>
                <Text color={selected ? TONE.brand : FG.strong}>{row.value}</Text>
              </Box>
              <Text color={FG.faint}>{row.description}</Text>
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text color={FG.faint}>{t().contextFooterHint}</Text>
        </Box>
        <Text color={FG.sub}>{message}</Text>
      </Box>
    </ModalShell>
  );
}
