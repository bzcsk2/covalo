/**
 * SearchOverlay — 搜索覆盖层（Ctrl+F 消息搜索）
 *
 * 功能：在消息时间线中搜索文本。从 timeline 中提取所有可搜索文本（用户消息、助手回复、思考过程、工具输出），
 * 支持实时过滤、高亮显示、上下键 / 回车遍历匹配结果、Esc 清空查询或关闭覆盖层。
 * 搜索高亮通过 useSearchHighlight hook 同步到消息列表中。
 *
 * @param timeline - 完整的时间线数据，包含所有消息和对话轮次
 * @param isOpen - 控制覆盖层是否可见
 * @param onClose - 关闭覆盖层的回调
 */
import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { Box, Text, useInput } from '@deepreef/ink';
import { useSearchHighlight } from '@deepreef/ink';
import { FG, TONE } from './reasonix/tokens.js';
import { t } from './i18n/index.js';
import type { TimelineItem } from './bridge.js';
import { useTranscriptTimeline } from './store/TranscriptContext.js';

interface SearchOverlayProps {
  /** Legacy 路径传入；Store 路径省略并由 useTranscriptTimeline 订阅 */
  timeline?: TimelineItem[];
  isOpen: boolean;
  onClose: () => void;
}

interface SearchResult {
  itemId: string;
  source: 'user' | 'assistant' | 'reasoning' | 'tool';
  text: string;
}

/**
 * collectSearchableText — 从 timeline 中提取所有可搜索的文本片段
 *
 * 遍历 timeline，区分 message 类型（直接取 content）和 turn 类型
 * （分别提取 userText / assistantText / reasoningText / tool output），
 * 每种都标注来源（source），用于后续过滤显示。
 */
function collectSearchableText(timeline: TimelineItem[]): SearchResult[] {
  const results: SearchResult[] = [];
  for (const item of timeline) {
    if (item.kind === 'message') {
      const text = item.message.content ?? '';
      if (text && item.message.role === 'user') results.push({ itemId: item.id, source: 'user', text });
      if (text && item.message.role === 'assistant') results.push({ itemId: item.id, source: 'assistant', text });
      if (text && item.message.role === 'tool') results.push({ itemId: item.id, source: 'tool', text });
    } else if (item.kind === 'assistant_text') {
      if (item.text) results.push({ itemId: item.id, source: 'assistant', text: item.text });
    } else if (item.kind === 'reasoning') {
      if (item.text) results.push({ itemId: item.id, source: 'reasoning', text: item.text });
    } else if (item.kind === 'tool') {
      if (item.tool.output) results.push({ itemId: item.id, source: 'tool', text: item.tool.output });
    }
  }
  return results;
}

/** SOURCE_LABELS — 各来源在搜索结果中的缩写标识：U=用户 / A=助手 / R=思考 / T=工具 */
const SOURCE_LABELS: Record<string, string> = {
  user: 'U',
  assistant: 'A',
  reasoning: 'R',
  tool: 'T',
};

export function SearchOverlay({ timeline: timelineProp, isOpen, onClose }: SearchOverlayProps) {
  const timelineFromStore = useTranscriptTimeline();
  const timeline = timelineProp ?? timelineFromStore;
  /** 当前搜索关键词 */
  const [query, setQuery] = useState('');
  /** 当前匹配结果的序号（用于遍历） */
  const [matchIdx, setMatchIdx] = useState(0);
  /** 调用 useSearchHighlight 将搜索关键词同步给消息列表的高亮显示 */
  const { setQuery: setHighlight } = useSearchHighlight();

  const searchResults = useMemo(() => collectSearchableText(timeline), [timeline]);

  const matchCount = useMemo(() => {
    // 无查询时返回 0；小写比较实现大小写不敏感的搜索
    if (!query) return 0;
    const lower = query.toLowerCase();
    return searchResults.filter(r => r.text.toLowerCase().includes(lower)).length;
  }, [query, searchResults]);

  useEffect(() => {
    setHighlight(query);
    setMatchIdx(0);
  }, [query, setHighlight]);

  const handleKeyDown = useCallback((input: string, key: { escape?: boolean; return?: boolean; upArrow?: boolean; downArrow?: boolean; ctrl?: boolean }) => {
    if (!isOpen) return;

    if (key.escape) {
      if (query.length > 0) {
        setQuery('');
        setHighlight('');
      } else {
        onClose();
      }
      return;
    }

    if (key.return || key.downArrow) {
      if (matchCount > 0) {
        setMatchIdx(prev => (prev + 1) % matchCount);
      }
      return;
    }

    if (key.upArrow) {
      if (matchCount > 0) {
        setMatchIdx(prev => (prev - 1 + matchCount) % matchCount);
      }
      return;
    }

    if (key.ctrl && input === 'f') {
      onClose();
      return;
    }
  }, [isOpen, query, matchCount, onClose, setHighlight]);

  useInput(handleKeyDown, { isActive: isOpen });

  if (!isOpen) return null;

  return (
    <Box
      flexDirection="column"
      width="100%"
      borderStyle="round"
      borderColor={TONE.brand}   // brand 色边框，与品牌色保持一致
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        {/* 🔍 搜索图标 + 用户输入的 query + 光标指示符 ▊ */}
        <Text color={TONE.brand}>🔍 </Text>
        <Text>{query}</Text>
        <Text color={FG.faint}>{'▊'}</Text>
        {query && (
          // 显示匹配进度 "当前/总数"，若无匹配则显示 "no match"
          <Text dimColor>  {matchCount > 0 ? `${matchIdx + 1}/${matchCount}` : t().searchNoMatch}</Text>
        )}
      </Box>
      <Box>
        <Text dimColor>{t().searchHint}</Text>
      </Box>
    </Box>
  );
}
