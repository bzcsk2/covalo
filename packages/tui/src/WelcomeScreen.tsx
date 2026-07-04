import React from 'react';
import { Box, Text } from '@covalo/ink';
import { FG, TONE } from './reasonix/tokens.js';
import { t } from './i18n/index.js';
import figlet from 'figlet';

interface WelcomeScreenProps {
  model: string;
  provider: string;
  agent: string;
  thinkingMode: string;
  contextMode: string;
  skillCount: number;
  pluginCount: number;
  contentPackCount: number;
  assetCounts: { skills: number; agents: number; rules: number; commands: number; mcp: number; hooks: number };
  diagnosticCounts: { errors: number; warnings: number };
}

let COVALO_ASCII: string[] = []
try {
  COVALO_ASCII = figlet.textSync('covalo', { font: 'ANSI Regular' }).trim().split('\n')
} catch {}
// 从品牌蓝(#7c9eff)到品牌紫(#b27cff)的渐变，与落地页 --gradient 一致
const COVALO_COLORS: any[] = ['#7c9eff', '#8b8ffe', '#9a7ffd', '#a97ffc', '#b87ffb', '#c77ffa', '#d67ff9', '#e57ff8', '#f27ff7'];

function Title(): React.ReactElement {
  return (
    <Box flexDirection="column" justifyContent="center">
      {COVALO_ASCII.map((line, i) => (
        <Text key={i} bold color={COVALO_COLORS[i % COVALO_COLORS.length]}>{line}</Text>
      ))}
    </Box>
  );
}

function CheckValue({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text>
      <Text color={FG.body}>[</Text>
      <Text color={TONE.ok}>✓</Text>
      <Text color={FG.body}>] </Text>
      <Text color={TONE.ok}>{children}</Text>
    </Text>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color={TONE.warn as any}>{title}</Text>
      <Box flexDirection="column">
        {children}
      </Box>
    </Box>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="row" width="100%">
      <Text color={FG.body}>{label}</Text>
      <Box width={2} />
      <Text color={FG.body}>[</Text>
      <Text color={TONE.ok}>{value}</Text>
      <Text color={FG.body}>]</Text>
    </Box>
  );
}

function contextModeLabel(mode: string): string {
  if (mode === 'trim') return t().contextModeTrim;
  if (mode === 'compact' || mode === 'compress') return t().contextModeCompact;
  return mode;
}

export function WelcomeScreen({ model, provider, agent, thinkingMode, contextMode, skillCount, pluginCount, contentPackCount, assetCounts, diagnosticCounts }: WelcomeScreenProps): React.ReactElement {
  const thinking = thinkingMode || 'off';
  const context = contextModeLabel(contextMode);
  const agentShort = agent?.replace(/\s+Agent$/i, '') ?? agent;

  return (
    <Box flexDirection="column" width="100%" justifyContent="center" alignItems="center">
      <Box
        flexDirection="column"
        width="100%"
      >
        <Box justifyContent="center">
          <Title />
        </Box>
        <Box height={1} />
        <Box justifyContent="center">
          <Text bold color={FG.body}>{t().welcomeTagline}</Text>
        </Box>
      </Box>
      <Box height={1} />
      <Box flexDirection="row" width="100%" justifyContent="flex-end">
        <Box flexDirection="row" width="75%" justifyContent="space-between">
          <Panel title={t().welcomePanelAgent}>
            <Row label={t().welcomeThinking + ' '} value={thinking} />
            <Row label={t().welcomeContext + ' '} value={context} />
            <Row label={t().welcomeSubagent + ' '} value={agentShort} />
          </Panel>
          <Panel title={t().welcomePanelComponents}>
            <Row label={t().welcomeProvider} value={String(pluginCount)} />
            <Row label={t().welcomeSkills} value={String(skillCount)} />
            <Row label={t().welcomeMcp} value={String(assetCounts.mcp)} />
            {diagnosticCounts.warnings > 0 || diagnosticCounts.errors > 0 ? (
              <Row label={t().welcomeDiagnosticsLabel} value={t().welcomeDiagnostics(diagnosticCounts.errors, diagnosticCounts.warnings)} />
            ) : null}
          </Panel>
        </Box>
      </Box>
      <Box height={1} />
      <Box flexDirection="row">
        <Text color={FG.meta}>{t().welcomeHelpHint}</Text>
        <Text color={FG.meta}> • </Text>
        <Text color={FG.meta}>{t().welcomeLangHint}</Text>
      </Box>
    </Box>
  );
}
