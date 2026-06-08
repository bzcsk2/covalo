import React, { memo, useMemo, useState } from 'react';
import { Box, Text, useInput } from '@deepicode/ink';
import type { ChatMessage } from '@deepicode/core';
import type { TimelineItem, ToolStatus } from './bridge.js';
import { Markdown } from './MarkdownRenderer.js';
import { Card } from './reasonix/Card.js';
import { StreamingCard } from './reasonix/StreamingCard.js';
import { FG, SURFACE, TONE } from './reasonix/tokens.js';
import { t } from './i18n/index.js';

interface DeepiMessagesProps {
  timeline: TimelineItem[];
  scrollRef?: React.RefObject<any>;
}

function markdownText(text: string): React.ReactNode {
  if (!text) return null;
  return <Markdown text={text} />;
}

function summarizeJsonValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .slice(0, 5)
      .map(item => summarizeJsonValue(item))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined && item !== null)
      .slice(0, 6);
    return entries
      .map(([key, item]) => {
        const summary = summarizeJsonValue(item);
        return summary ? `${key}: ${summary}` : key;
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function formatToolOutput(tool: ToolStatus): string {
  let parsed: unknown = null;
  try { parsed = JSON.parse(tool.output); } catch {}

  if (tool.name === 'bash' || tool.name === 'shell' || tool.name === 'shell_exec') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return tool.output;
    const record = parsed as Record<string, unknown>;
    const stdout = String(record.stdout ?? '');
    const stderr = String(record.stderr ?? '');
    return stdout + (stderr.trim() ? `\n${stderr}` : '');
  }

  if (tool.name === 'list_dir' && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const items = (parsed as Record<string, unknown>).items as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(items)) {
      return items.map(item => item.type === 'dir' ? `${String(item.name ?? '')}/` : String(item.name ?? '')).join('\n');
    }
  }

  if (!parsed) return tool.output;
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return summarizeJsonValue(parsed);
  const record = parsed as Record<string, unknown>;
  const msg = record.message ?? record.error ?? record.content;
  if (typeof msg === 'string') return msg;
  return summarizeJsonValue(parsed);
}

function displayToolName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'bash' || lower === 'shell' || lower === 'shell_exec') return 'Bash';
  if (lower === 'read_file' || lower === 'read') return 'Read';
  if (lower === 'write_file' || lower === 'create_file' || lower === 'write') return 'Write';
  if (lower === 'edit' || lower === 'apply_patch') return 'Edit';
  if (lower === 'list_dir' || lower === 'ls') return 'List';
  if (lower === 'grep' || lower === 'glob' || lower === 'websearch' || lower === 'web_search') return 'Search';
  if (lower === 'webfetch' || lower === 'web_fetch') return 'Fetch';
  if (lower === 'skill') return 'Skill';
  if (lower === 'agenttool' || lower === 'taskcreate') return 'Task';
  return name;
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

function compactText(value: string, max = 90): string {
  const singleLine = value.replace(/\s+/g, ' ').trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

function formatToolUseSummary(tool: ToolStatus): string {
  const name = tool.name.toLowerCase();
  const args = tool.args;

  if (name === 'bash' || name === 'shell' || name === 'shell_exec') {
    return compactText(firstString(args, ['command', 'cmd', 'script']) ?? '');
  }
  if (name === 'read_file' || name === 'write_file' || name === 'create_file' || name === 'edit') {
    return compactText(firstString(args, ['path', 'file_path', 'filename']) ?? '');
  }
  if (name === 'list_dir') {
    return compactText(firstString(args, ['path', 'dir', 'directory']) ?? '.');
  }
  if (name === 'grep' || name === 'glob') {
    const pattern = firstString(args, ['pattern', 'query']) ?? '';
    const path = firstString(args, ['path', 'include', 'glob']) ?? '';
    return compactText([pattern && `"${pattern}"`, path].filter(Boolean).join(' in '));
  }
  if (name === 'webfetch' || name === 'web_fetch') {
    return compactText(firstString(args, ['url']) ?? '');
  }
  if (name === 'websearch' || name === 'web_search') {
    return compactText(firstString(args, ['query', 'q']) ?? '');
  }
  if (name === 'skill') {
    const command = firstString(args, ['command']) ?? '';
    const query = firstString(args, ['query', 'name']) ?? '';
    return compactText([command, query].filter(Boolean).join(' '));
  }
  if (name === 'agenttool' || name === 'taskcreate') {
    return compactText(firstString(args, ['description', 'task', 'prompt']) ?? '');
  }

  const preferred = firstString(args, ['path', 'file_path', 'command', 'query', 'pattern', 'url', 'name', 'description']);
  if (preferred) return compactText(preferred);
  const keys = Object.keys(args);
  return keys.length > 0 ? compactText(keys.join(', ')) : '';
}

function formatToolResultSummary(tool: ToolStatus): string {
  const output = formatToolOutput(tool).trim();
  if (!output) return tool.status === 'error' ? 'Error' : 'Done';
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return tool.status === 'error' ? 'Error' : 'Done';
  const maxLines = tool.status === 'error' ? 3 : 2;
  return lines.slice(0, maxLines).map(line => compactText(line, 120)).join('\n');
}

const UserMessage = memo(function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <Card>
      <Box flexDirection="row" backgroundColor={SURFACE.bgInput} paddingX={1} paddingY={1}>
        <Text bold color={TONE.brand}>{'\u276F '}</Text>
        <Box flexGrow={1}>{markdownText(message.content ?? '')}</Box>
      </Box>
    </Card>
  );
});

const AssistantTextMessage = memo(function AssistantTextMessage({ text }: { text: string }) {
  if (!text) return null;
  return (
    <Box flexDirection="row" width="100%" paddingX={1} paddingY={1}>
      <Box minWidth={2}>
        <Text color={TONE.ok}>{'\u2039'}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {markdownText(text)}
      </Box>
    </Box>
  );
});

const AssistantThinkingMessage = memo(function AssistantThinkingMessage({
  text,
  isStreaming,
  startTs,
  expanded,
}: {
  text: string;
  isStreaming: boolean;
  startTs: number;
  expanded: boolean;
}) {
  if (!text) return null;
  if (isStreaming) {
    return <StreamingCard text={text} startTs={startTs} title={t().thinking} />;
  }
  if (!expanded) {
    return (
      <Box paddingX={1}>
        <Text color={TONE.warn} bold>{'\u2234'} {t().thinking}</Text>
        <Text dimColor>{t().ctrlO}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box flexDirection="row">
        <Text color={TONE.warn} bold>{'\u2234'} {t().thinking}</Text>
        <Text dimColor>{t().ctrlO}</Text>
      </Box>
      <Box paddingLeft={2}>
        <Markdown text={text} />
      </Box>
    </Box>
  );
});

const AssistantToolUseMessage = memo(function AssistantToolUseMessage({
  tool,
  expanded,
}: {
  tool: ToolStatus;
  expanded: boolean;
}) {
  const name = displayToolName(tool.name);
  const summary = formatToolUseSummary(tool);
  const result = formatToolResultSummary(tool);
  const color = tool.status === 'error' ? TONE.err : tool.status === 'running' ? TONE.brand : TONE.ok;
  const glyph = tool.status === 'running' ? '\u25CF' : tool.status === 'error' ? '\u2717' : '\u2713';

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      <Box flexDirection="row" flexWrap="wrap">
        <Text color={color}>{glyph} </Text>
        <Text bold color={color}>{name}</Text>
        {summary && <Text>({summary})</Text>}
        <Text dimColor>{tool.elapsedMs !== undefined ? ` ${(tool.elapsedMs / 1000).toFixed(1)}s` : ''}</Text>
      </Box>
      {(tool.status === 'running' || expanded || tool.status === 'error') && result && (
        <Box flexDirection="column" paddingLeft={2}>
          {result.split('\n').map((line, index) => (
            <Text key={`${tool.key}:result:${index}`} color={tool.status === 'error' ? TONE.err : FG.sub}>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
});

function ToolResultMessage({ message, expanded }: { message: ChatMessage; expanded: boolean }) {
  return (
    <AssistantToolUseMessage
      tool={{
        key: message.tool_call_id ?? `tool-${message.name ?? 'unknown'}`,
        name: message.name ?? 'tool',
        status: message.is_error ? 'error' : 'done',
        args: {},
        output: message.content ?? '',
        startedAt: Date.now(),
        elapsedMs: 0,
      }}
      expanded={expanded}
    />
  );
}

const MessageBlock = memo(function MessageBlock({
  item,
  expanded,
}: {
  item: TimelineItem;
  expanded: boolean;
}) {
  switch (item.kind) {
    case 'message':
      if (item.message.role === 'user') return <UserMessage message={item.message} />;
      if (item.message.role === 'assistant') {
        return (
          <>
            <AssistantTextMessage text={item.message.content ?? ''} />
            {item.message.reasoning_content && (
              <AssistantThinkingMessage
                text={item.message.reasoning_content}
                isStreaming={false}
                startTs={Date.now()}
                expanded={expanded}
              />
            )}
          </>
        );
      }
      if (item.message.role === 'tool') return <ToolResultMessage message={item.message} expanded={expanded} />;
      return null;

    case 'assistant_text':
      return <AssistantTextMessage text={item.text} />;

    case 'reasoning':
      return (
        <AssistantThinkingMessage
          text={item.text}
          isStreaming={item.isStreaming}
          startTs={item.startTs}
          expanded={expanded}
        />
      );

    case 'tool':
      return <AssistantToolUseMessage tool={item.tool} expanded={expanded} />;
  }
});

export function DeepiMessages({ timeline }: DeepiMessagesProps) {
  const [expanded, setExpanded] = useState(true);

  useInput((input, key) => {
    if (input === '\x0f' || (key.ctrl && input === 'o')) {
      setExpanded(prev => !prev);
    }
  });

  const renderedItems = useMemo(() =>
    timeline.map(item => <MessageBlock key={item.id} item={item} expanded={expanded} />),
    [timeline, expanded]
  );

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      {renderedItems}
      {timeline.length === 0 && (
        <Box paddingX={1}>
          <Text color={FG.faint}>{''}</Text>
        </Box>
      )}
    </Box>
  );
}
