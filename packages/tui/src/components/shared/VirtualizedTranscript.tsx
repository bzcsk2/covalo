/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * VirtualizedTranscript — efficient rendering for long chat transcripts.
 * Borrows design ideas from gemini-cli VirtualizedList (anchor, dynamic height, visible-only rendering).
 */

import React, { useState, useRef, useMemo, useCallback, useEffect } from 'react';
import { Box, Text, useInput } from '@deepreef/ink';
import { getSemanticColors } from '../../theme/semantic-colors.js';
import { t } from '../../i18n/index.js';

export interface TranscriptItem {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp?: number;
  isStreaming?: boolean;
}

export interface VirtualizedTranscriptProps {
  items: TranscriptItem[];
  terminalWidth: number;
  terminalHeight: number;
  isAutoScroll?: boolean;
  onItemPress?: (item: TranscriptItem) => void;
  renderItem?: (item: TranscriptItem, index: number) => React.ReactNode;
}

const BUFFER_SIZE = 50;

const ROLE_ICONS: Record<string, string> = {
  user: '›',
  assistant: '✦',
  system: '◆',
  tool: '⊕',
};

export function VirtualizedTranscript({
  items,
  terminalWidth,
  terminalHeight,
  isAutoScroll = true,
  onItemPress,
  renderItem,
}: VirtualizedTranscriptProps): React.JSX.Element {
  const theme = getSemanticColors();
  const [scrollOffset, setScrollOffset] = useState(0);
  const [userHasScrolledUp, setUserHasScrolledUp] = useState(false);
  const prevItemCountRef = useRef(items.length);

  // Auto-scroll to bottom when new items arrive
  useEffect(() => {
    if (items.length > prevItemCountRef.current && isAutoScroll && !userHasScrolledUp) {
      setScrollOffset(Math.max(0, items.length - terminalHeight + 2));
    }
    prevItemCountRef.current = items.length;
  }, [items.length, terminalHeight, isAutoScroll, userHasScrolledUp]);

  // Keyboard navigation
  useInput((input, key) => {
    if (key.upArrow) {
      setUserHasScrolledUp(true);
      setScrollOffset((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setScrollOffset((prev) => {
        const next = Math.min(items.length - terminalHeight + 2, prev + 1);
        if (next >= items.length - terminalHeight + 2) {
          setUserHasScrolledUp(false);
        }
        return next;
      });
    } else if (key.pageUp) {
      setUserHasScrolledUp(true);
      setScrollOffset((prev) => Math.max(0, prev - terminalHeight));
    } else if (key.pageDown) {
      setScrollOffset((prev) => {
        const next = Math.min(items.length - terminalHeight + 2, prev + terminalHeight);
        if (next >= items.length - terminalHeight + 2) {
          setUserHasScrolledUp(false);
        }
        return next;
      });
    } else if (key.ctrl && input === 'g') {
      // Jump to bottom
      setUserHasScrolledUp(false);
      setScrollOffset(Math.max(0, items.length - terminalHeight + 2));
    }
  });

  // Compute visible range
  const visibleRange = useMemo(() => {
    const maxVisible = terminalHeight - 2; // reserve for scroll indicator
    const start = Math.max(0, scrollOffset - BUFFER_SIZE);
    const end = Math.min(items.length, scrollOffset + maxVisible + BUFFER_SIZE);
    return { start, end, maxVisible };
  }, [scrollOffset, items.length, terminalHeight]);

  const visibleItems = useMemo(() => {
    return items.slice(visibleRange.start, visibleRange.end);
  }, [items, visibleRange.start, visibleRange.end]);

  const maxScrollOffset = Math.max(0, items.length - visibleRange.maxVisible);
  const scrollPercent = maxScrollOffset > 0 ? scrollOffset / maxScrollOffset : 1;

  const defaultRenderItem = useCallback((item: TranscriptItem, _index: number): React.ReactNode => {
    const icon = ROLE_ICONS[item.role] ?? '·';
    const roleColor = item.role === 'user'
      ? theme.text.link
      : item.role === 'assistant'
        ? theme.text.primary
        : item.role === 'tool'
          ? theme.ui.symbol
          : theme.text.secondary;

    return (
      <Box key={item.id} flexDirection="row" width={terminalWidth}>
        <Text color={roleColor as any} bold>{icon} </Text>
        <Text color={(item.role === 'user' ? theme.text.link : theme.text.primary) as any}>
          {item.content}
        </Text>
      </Box>
    );
  }, [theme, terminalWidth]);

  const renderFn = renderItem ?? defaultRenderItem;

  return (
    <Box flexDirection="column" height={terminalHeight} width={terminalWidth}>
      {visibleItems.map((item, i) => {
        const actualIndex = visibleRange.start + i;
        return (
          <Box key={item.id}>
            {renderFn(item, actualIndex)}
          </Box>
        );
      })}

      {/* Scroll indicator */}
      {items.length > visibleRange.maxVisible && (
        <Box justifyContent="flex-end">
          <Text color={theme.text.secondary as any}>
            {userHasScrolledUp ? t().virtualizedScrollToBottom : ''}
            {` ${scrollPercent < 1 ? `${Math.round(scrollPercent * 100)}%` : t().virtualizedBottom}`}
          </Text>
        </Box>
      )}

      {items.length === 0 && (
        <Text color={theme.text.secondary as any}>{t().virtualizedNoMessages}</Text>
      )}
    </Box>
  );
}
