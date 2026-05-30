import React from 'react';
import { Box, Text } from '@deepicode/ink';
import type { ChatMessage } from '@deepicode/core';
import type { ToolStatus } from './bridge.js';

interface DeepiMessagesProps {
  messages: ChatMessage[];
  activeTools: Map<string, ToolStatus>;
  isLoading: boolean;
  streamingText: string | null;
  reasoningText?: string | null;
  scrollRef?: React.RefObject<any>;
}

let keyCounter = 0;

const TRUNCATE_LEN = 200;

export function DeepiMessages({ messages, activeTools, isLoading, streamingText, reasoningText }: DeepiMessagesProps) {
  return (
    <Box flexDirection="column" width="100%" paddingX={1}>
      {messages.map((msg, i) => {
        // Stable key: role+index avoids unmount/remount during streaming
        const key = msg.role + i;
        const isLast = i === messages.length - 1;
        return (
          <Box key={key} flexDirection="column" marginBottom={1}>
            {msg.role === 'user' && (
              <Box flexDirection="column">
                <Text dimColor>{'> '}{msg.content}</Text>
              </Box>
            )}
            {msg.role === 'assistant' && (
              <Box flexDirection="column">
                {isLast && streamingText !== null ? (
                  <Text>{streamingText}<Text color="success">▊</Text></Text>
                ) : (
                  <Text>{msg.content ?? ''}</Text>
                )}
                {msg.tool_calls && msg.tool_calls.length > 0 && (
                  <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                    {msg.tool_calls.map((tc: any, j: number) => (
                      <Box key={j}>
                        <Text dimColor>  [{tc.function.name}]</Text>
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            )}
            {msg.role === 'tool' && (
              <Box paddingLeft={2}>
                <Text color="warning">  ⏺ [{msg.name ?? 'tool'}]</Text>
                <Text dimColor> {msg.content ? (msg.content.length > TRUNCATE_LEN ? msg.content.slice(0, TRUNCATE_LEN) + '...' : msg.content) : ''}</Text>
              </Box>
            )}
          </Box>
        );
      })}
      {reasoningText && (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Text dimColor color="warning">  reasoning: {reasoningText}</Text>
        </Box>
      )}
      {isLoading && activeTools.size > 0 && (
        <Box flexDirection="column" paddingLeft={1} marginTop={1}>
          {Array.from(activeTools.entries()).map(([key, tool]) => (
            <Box key={key}>
              <Text>{tool.status === 'running' ? '⏺' : tool.status === 'done' ? '✓' : '✗'} [{tool.name}]</Text>
            </Box>
          ))}
        </Box>
      )}
      {isLoading && streamingText === null && activeTools.size === 0 && (
        <Box>
          <Text color="success">⠋ 思考中...</Text>
        </Box>
      )}
    </Box>
  );
}
