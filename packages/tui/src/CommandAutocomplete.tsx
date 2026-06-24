/**
 * CommandAutocomplete — 命令自动补全弹窗（/ 命令输入）
 *
 * 功能：当用户在输入框中键入 "/" 时，根据已输入的内容实时过滤并展示匹配的命令列表。
 * 支持键盘上下键选择、回车提交命令、Tab 自动补全当前选中命令、Esc 关闭弹窗。
 * 若无匹配命令则不渲染任何内容。
 *
 * @param query - 用户当前已输入的命令前缀（不含 "/"）
 * @param onSubmit - 用户按回车确认命令时的回调，传入完整命令名
 * @param onComplete - 用户按 Tab 自动补全时的回调，传入完整命令名
 * @param onClose - 用户按 Esc 关闭弹窗时的回调
 */
import { Box, Text, useInput } from '@deepreef/ink';
import React, { useState, useMemo } from 'react';
import { filterCommands, type SlashCommand } from './CommandRegistry.js';
import { TONE, FG } from './reasonix/tokens.js';
import { t } from './i18n/index.js';

interface CommandAutocompleteProps {
  query: string;
  onSubmit: (command: string) => void;
  onComplete: (command: string) => void;
  onClose: () => void;
}

export function CommandAutocomplete({ query, onSubmit, onComplete, onClose }: CommandAutocompleteProps): React.ReactElement | null {
  /** 当前选中的命令在 matches 列表中的索引 */
  const [selectedIdx, setSelectedIdx] = useState(0);
  /** 根据 query 实时过滤出的匹配命令列表 */
  const matches = useMemo(() => filterCommands(query, t), [query]);

  useInput((_input, key) => {
    if (matches.length === 0) {
      if (key.escape) onClose();
      return;
    }
    if (key.upArrow) {
      setSelectedIdx(prev => (prev - 1 + matches.length) % matches.length);
    } else if (key.downArrow) {
      setSelectedIdx(prev => (prev + 1) % matches.length);
    } else if (key.return) {
      const cmd = matches[selectedIdx];
      if (cmd) onSubmit(cmd.name);
    } else if (key.tab) {
      const cmd = matches[selectedIdx];
      if (cmd) onComplete(cmd.name);
    } else if (key.escape) {
      onClose();
    }
  });

  if (matches.length === 0) return null;

  return (
    // 主容器：纵向排列，圆角边框，brand 色边框，paddingX=1，底部间距 1
    <Box flexDirection="column" borderStyle="round" borderColor={TONE.brand} paddingX={1} marginBottom={1}>
      {matches.map((cmd, i) => (
        <Box key={cmd.name} flexDirection="row">
          {/* 选中项以 brand 色高亮显示 > 指示符和命令名 */}
          <Text color={i === selectedIdx ? TONE.brand : undefined}>
            {i === selectedIdx ? '> ' : '  '}
          </Text>
          <Text bold={i === selectedIdx} color={i === selectedIdx ? TONE.brand : undefined}>
            {cmd.name}
          </Text>
          {/* faint 色展示命令描述，弱化辅助信息 */}
          <Text color={FG.faint}> {cmd.description}</Text>
        </Box>
      ))}
      <Box marginTop={1}>
        {/* dimColor 降低底部操作提示的视觉权重 */}
        <Text dimColor>{t().cmdAutocompleteHint}</Text>
      </Box>
    </Box>
  );
}
