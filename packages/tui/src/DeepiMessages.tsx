import React, { memo, useMemo, useState } from 'react';
import { Box, Text, useInput } from '@covalo/ink';
import type { ChatMessage } from '@covalo/core';
import type { AgentRole } from '@covalo/core/agent-profile/types.js';
import type { TimelineItem, ToolStatus } from './bridge.js';
import { Markdown } from './MarkdownRenderer.js';
import { Card } from './reasonix/Card.js';
import { Spinner } from './reasonix/Spinner.js';
import { FG, SURFACE, TONE } from './reasonix/tokens.js';
import { t } from './i18n/index.js';
import { useTranscriptTimeline } from './store/TranscriptContext.js';

const DEFAULT_RENDER_WINDOW = 300;

export function getVisibleTimeline<T>(timeline: T[], windowSize: number): {
  visible: T[];
  hiddenCount: number;
} {
  if (windowSize <= 0) {
    return { visible: [], hiddenCount: timeline.length };
  }
  if (timeline.length <= windowSize) {
    return { visible: timeline, hiddenCount: 0 };
  }
  return {
    visible: timeline.slice(-windowSize),
    hiddenCount: timeline.length - windowSize,
  };
}

/**
 * 角色标签样式映射。
 * worker → 青色圆点 + 青色 Worker 名；supervisor → 紫色圆点 + 紫色 Supervisor 名；
 * 未知角色 → 灰色圆点 + 灰色 AI 名。用户消息不渲染标签（由调用方判断）。
 */
interface RoleStyle {
  glyph: string;
  color: string;
  label: string;
}

function roleStyle(role?: AgentRole): RoleStyle {
  const strings = t();
  if (role === 'worker') {
    return { glyph: '\u25CF', color: TONE.ok, label: strings.roleWorker };
  }
  if (role === 'supervisor') {
    return { glyph: '\u25CF', color: TONE.accent, label: strings.roleSupervisor };
  }
  // 无角色信息（如老会话 hydration 进来的条目）：用灰色 AI 兜底，保证可读
  return { glyph: '\u25CF', color: FG.meta, label: strings.roleUnknown };
}

/**
 * RoleTag — 彩色圆点 + 彩色角色名前缀。渲染于每条角色消息的开头，
 * 让双角色时间线一眼可辨（worker 青 / supervisor 紫）。
 * 用户消息不渲染此组件（由调用方跳过）。
 */
const RoleTag = memo(function RoleTag({ role }: { role?: AgentRole }) {
  const style = roleStyle(role);
  return (
    <Text color={style.color as any} bold>
      {`${style.glyph} ${style.label}`}
    </Text>
  );
});

/** 角色名 + 分隔符，用于在已有标题文本前拼接（如 StreamingCard title） */
function roleTitle(role?: AgentRole): string {
  const style = roleStyle(role);
  return style.label;
}

interface DeepiMessagesProps {
  /** Legacy 路径传入；Store 路径省略并由 useTranscriptTimeline 订阅 */
  timeline?: TimelineItem[];
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
  const maxLines = tool.status === 'error' ? 3 : 4;
  // 多行结果在总长度合理时合并为一行（用两个空格分隔），适配终端横向布局
  // 例如 List 输出多个目录项时，可显示为 "dir1/  dir2/  file.txt"
  const sliced = lines.slice(0, maxLines).map(line => compactText(line, 60));
  const joined = sliced.join('  ');
  if (joined.length <= 100) return joined;
  // 超长时回退到首行 + 省略号
  return compactText(sliced[0], 100) + (sliced.length > 1 ? '  …' : '');
}

const UserMessage = memo(function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <Card>
      <Box flexDirection="row" backgroundColor={SURFACE.bgInput} paddingX={1} paddingY={1}>
        <Text bold color={TONE.brand}>{'> '}</Text>
        <Box flexGrow={1}>{markdownText(message.content ?? '')}</Box>
      </Box>
    </Card>
  );
});

const AssistantTextMessage = memo(function AssistantTextMessage({
  text,
  role,
  showRoleTag = true,
}: {
  text: string;
  role?: AgentRole;
  /** 连续同角色消息时设为 false 以省略重复的 RoleTag（dedup） */
  showRoleTag?: boolean;
}) {
  if (!text) return null;
  const style = roleStyle(role);
  return (
    <Box flexDirection="column" width="100%" paddingX={1} paddingY={1}>
      {showRoleTag && <Text color={style.color as any} bold>{`${style.glyph} ${style.label}`}</Text>}
      <Box flexDirection="row">
        {/* 省略 RoleTag 时缩进对齐标签宽度，避免正文左移 */}
        <Box minWidth={showRoleTag ? 2 : 6} />
        <Box flexDirection="column" flexGrow={1}>
          {markdownText(text)}
        </Box>
      </Box>
    </Box>
  );
});

const AssistantThinkingMessage = memo(function AssistantThinkingMessage({
  text,
  isStreaming,
  startTs,
  expanded,
  role,
  showRoleTag = true,
}: {
  text: string;
  isStreaming: boolean;
  startTs: number;
  expanded: boolean;
  role?: AgentRole;
  /** 连续同角色消息时设为 false 以省略重复的 RoleTag（dedup） */
  showRoleTag?: boolean;
}) {
  if (!text) return null;

  // Collapsed preview (finalized only)
  if (!isStreaming && !expanded) {
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    return (
      <Box flexDirection="column" width="100%" paddingX={1}>
        {showRoleTag && <RoleTag role={role} />}
        <Box flexDirection="row" paddingLeft={showRoleTag ? 0 : 4}>
          <Text color={TONE.warn as any} bold dimColor>{`  ${'\u2234'} ${t().thinking}`}</Text>
          {preview ? <Text dimColor>{` ${preview}${text.length > preview.length ? '…' : ''}`}</Text> : null}
          <Text dimColor>{` ${t().ctrlO}`}</Text>
        </Box>
      </Box>
    );
  }

  // Unified expanded/streaming layout with consistent padding
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      {showRoleTag && <RoleTag role={role} />}
      <Box flexDirection="row" paddingLeft={showRoleTag ? 0 : 4}>
        <Text color={TONE.warn as any} bold dimColor>{`  ${'\u2234'} ${t().thinking}`}</Text>
        {isStreaming ? <Spinner kind="braille" color={TONE.brand} /> : <Text dimColor>{t().ctrlO}</Text>}
      </Box>
      <Box paddingLeft={2}>
        <Markdown text={text} />
        {isStreaming ? <Text color={TONE.ok as any}>{'\u258A'}</Text> : null}
      </Box>
    </Box>
  );
});

const AssistantToolUseMessage = memo(function AssistantToolUseMessage({
  tool,
  expanded,
  role,
  showRoleTag = true,
}: {
  tool: ToolStatus;
  expanded: boolean;
  role?: AgentRole;
  /** 连续同角色消息时设为 false 以省略重复的 RoleTag（dedup） */
  showRoleTag?: boolean;
}) {
  const name = displayToolName(tool.name);
  const summary = formatToolUseSummary(tool);
  const result = formatToolResultSummary(tool);
  const color = tool.status === 'error' ? TONE.err : tool.status === 'running' ? TONE.brand : TONE.ok;
  const glyph = tool.status === 'running' ? '\u25CF' : tool.status === 'error' ? '\u2717' : '\u2713';

  const showResult = (tool.status === 'running' || expanded || tool.status === 'error') && result;
  const resultLines = showResult ? result!.split('\n') : [];
  // 结果内联到签名行末尾（formatToolResultSummary 已将多行合并为单行）
  const inlineResult = resultLines.length >= 1 ? resultLines[0] : null;

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      {showRoleTag && <RoleTag role={role} />}
      <Box flexDirection="row" flexWrap="wrap">
        {/* 连续同角色时缩进对齐 RoleTag 宽度，避免签名行左移 */}
        {!showRoleTag && <Text dimColor>{'    '}</Text>}
        <Text color={color as any} dimColor>{`${glyph} `}</Text>
        <Text bold color={color as any} dimColor>{name}</Text>
        {summary && <Text dimColor>{`(${summary})`}</Text>}
        <Text dimColor>{tool.elapsedMs !== undefined ? ` ${(tool.elapsedMs / 1000).toFixed(1)}s` : ''}</Text>
        {inlineResult && (
          <Text dimColor color={(tool.status === 'error' ? TONE.err : FG.meta) as any}>
            {` → ${inlineResult}`}
          </Text>
        )}
      </Box>
      {showResult && !inlineResult && resultLines.length > 1 && (
        <Box flexDirection="column" paddingLeft={4}>
          {resultLines.slice(1).map((line, index) => (
            <Text key={`${tool.key}:result:${index}`} color={(tool.status === 'error' ? TONE.err : FG.meta) as any} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
});

function ToolResultMessage({ message, expanded, role, showRoleTag = true }: { message: ChatMessage; expanded: boolean; role?: AgentRole; showRoleTag?: boolean }) {
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
      role={role}
      showRoleTag={showRoleTag}
    />
  );
}

const MessageBlock = memo(function MessageBlock({
  item,
  expanded,
  showRoleTag = true,
}: {
  item: TimelineItem;
  expanded: boolean;
  /** 连续同角色消息时设为 false 以省略重复的 RoleTag（dedup） */
  showRoleTag?: boolean;
}) {
  switch (item.kind) {
    case 'message':
      if (item.message.role === 'user') return <UserMessage message={item.message} />;
      if (item.message.role === 'assistant') {
        return (
          <>
            <AssistantTextMessage text={item.message.content ?? ''} role={item.role} showRoleTag={showRoleTag} />
            {item.message.reasoning_content && (
              <AssistantThinkingMessage
                text={item.message.reasoning_content}
                isStreaming={false}
                startTs={Date.now()}
                expanded={expanded}
                role={item.role}
                showRoleTag={showRoleTag}
              />
            )}
          </>
        );
      }
      if (item.message.role === 'tool') return <ToolResultMessage message={item.message} expanded={expanded} role={item.role} showRoleTag={showRoleTag} />;
      return null;

    case 'assistant_text':
      if (item.isStreaming) {
        const style = roleStyle(item.role);
        return (
          <Box flexDirection="column" width="100%" paddingX={1} paddingY={1}>
            {showRoleTag && <Text color={style.color as any} bold>{`${style.glyph} ${style.label}`}</Text>}
            <Box flexDirection="row" paddingLeft={showRoleTag ? 0 : 4}>
              <Box minWidth={2} />
              <Box flexDirection="column" flexGrow={1}>
                {markdownText(item.text)}
                <Text color={TONE.ok}>{'\u258A'}</Text>
              </Box>
            </Box>
          </Box>
        );
      }
      return <AssistantTextMessage text={item.text} role={item.role} showRoleTag={showRoleTag} />;

    case 'reasoning':
      return (
        <AssistantThinkingMessage
          text={item.text}
          isStreaming={item.isStreaming}
          startTs={item.startTs}
          expanded={expanded}
          role={item.role}
          showRoleTag={showRoleTag}
        />
      );

    case 'tool':
      return <AssistantToolUseMessage tool={item.tool} expanded={expanded} role={item.role} showRoleTag={showRoleTag} />;
  }
});

/**
 * DeepiMessages
 *
 * 渲染消息时间线。
 * 注意：已移除 React.memo，确保 reasoning（思考内容）流式更新能立即反映到界面。
 */
export function DeepiMessages({
  timeline: timelineProp,
  scrollRef,
}: DeepiMessagesProps) {
  const timelineFromStore = useTranscriptTimeline();
  const timeline = timelineProp ?? timelineFromStore;
  const [expanded, setExpanded] = useState(true);

  useInput((input, key) => {
    if (input === '\x0f' || (key.ctrl && input === 'o')) {
      setExpanded(prev => !prev);
    }
  });

  const { visible: visibleTimeline, hiddenCount } = useMemo(
    () => getVisibleTimeline(timeline, DEFAULT_RENDER_WINDOW),
    [timeline],
  );

  const renderedItems = useMemo(() => {
    // 连续同角色消息 dedup RoleTag：维护上一条已渲染 RoleTag 的角色，
    // 遇到 user 消息重置（下一条 assistant 重新显示 RoleTag），
    // 遇到与上一条同 role 的 assistant 消息则省略 RoleTag。
    let lastShownRole: AgentRole | undefined | null = null;
    return visibleTimeline.map(item => {
      let showRoleTag = true;
      if (item.kind === 'message' && item.message.role === 'user') {
        lastShownRole = null;
      } else {
        const currentRole = item.role;
        if (currentRole && lastShownRole === currentRole) {
          showRoleTag = false;
        } else {
          showRoleTag = true;
          lastShownRole = currentRole ?? null;
        }
      }
      return <MessageBlock key={item.id} item={item} expanded={expanded} showRoleTag={showRoleTag} />;
    });
  }, [visibleTimeline, expanded]);

  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      {hiddenCount > 0 && (
        <Box paddingX={1}>
          <Text dimColor>{`\u2026 ${hiddenCount} older items hidden for TUI performance`}</Text>
        </Box>
      )}
      {renderedItems}
      {timeline.length === 0 && (
        <Box paddingX={1}>
          <Text color={FG.faint}>{''}</Text>
        </Box>
      )}
    </Box>
  );
}
