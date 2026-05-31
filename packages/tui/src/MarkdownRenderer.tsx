import { marked, type Token, type Tokens } from 'marked';
import React, { useMemo } from 'react';
import { Box, Text, stringWidth } from '@deepicode/ink';
import stripAnsi from 'strip-ansi';
import { configureMarked, formatToken, padAligned } from './markdown.js';

type Props = {
  children: string;
  dimColor?: boolean;
};

const MD_SYNTAX_RE = /[#*`|[>\-_~]|\n\n|^\d+\. |\n\d+\. /;
function hasMarkdownSyntax(s: string): boolean {
  return MD_SYNTAX_RE.test(s.length > 500 ? s.slice(0, 500) : s);
}

function cachedLexer(content: string): Token[] {
  if (!hasMarkdownSyntax(content)) {
    return [{
      type: 'paragraph',
      raw: content,
      text: content,
      tokens: [{ type: 'text', raw: content, text: content }],
    } as Token];
  }
  return marked.lexer(content);
}

function renderTable(tableToken: Tokens.Table): string {
  function getDisplayText(tokens: Token[] | undefined): string {
    return stripAnsi(tokens?.map(_ => formatToken(_, 0, null, null)).join('') ?? '');
  }

  const columnWidths = tableToken.header.map((header, index) => {
    let maxWidth = stringWidth(getDisplayText(header.tokens));
    for (const row of tableToken.rows) {
      const cellLength = stringWidth(getDisplayText(row[index]?.tokens));
      maxWidth = Math.max(maxWidth, cellLength);
    }
    return Math.max(maxWidth, 3);
  });

  function renderBorderLine(type: 'top' | 'middle' | 'bottom'): string {
    const [left, mid, cross, right] = {
      top: ['┌', '─', '┬', '┐'],
      middle: ['├', '─', '┼', '┤'],
      bottom: ['└', '─', '┴', '┘'],
    }[type] as [string, string, string, string];
    let line = left;
    columnWidths.forEach((width, colIndex) => {
      line += mid.repeat(width + 2);
      line += colIndex < columnWidths.length - 1 ? cross : right;
    });
    return line;
  }

  function renderRow(cells: Array<{ tokens?: Token[] }>, isHeader: boolean): string {
    let line = '│';
    cells.forEach((cell, index) => {
      const content = cell.tokens?.map(_ => formatToken(_, 0, null, null)).join('') ?? '';
      const displayText = getDisplayText(cell.tokens);
      const width = columnWidths[index]!;
      const align = isHeader ? 'center' : (tableToken.align?.[index] ?? 'left');
      line += ' ' + padAligned(content, stringWidth(displayText), width, align) + ' │';
    });
    return line;
  }

  const lines: string[] = [];
  lines.push(renderBorderLine('top'));
  lines.push(renderRow(tableToken.header, true));
  lines.push(renderBorderLine('middle'));
  tableToken.rows.forEach((row, rowIndex) => {
    lines.push(renderRow(row, false));
    if (rowIndex < tableToken.rows.length - 1) {
      lines.push(renderBorderLine('middle'));
    }
  });
  lines.push(renderBorderLine('bottom'));
  return lines.join('\n');
}

export function Markdown({ children, dimColor }: Props): React.ReactNode {
  configureMarked();

  const rendered = useMemo(() => {
    const tokens = cachedLexer(children);
    let nonTableContent = '';
    const elements: React.ReactNode[] = [];

    function flush() {
      if (nonTableContent) {
        elements.push(
          <Text key={elements.length} dimColor={dimColor} wrap="wrap">
            {nonTableContent.trim()}
          </Text>,
        );
        nonTableContent = '';
      }
    }

    for (const token of tokens) {
      if (token.type === 'table') {
        flush();
        elements.push(
          <Text key={elements.length} dimColor={dimColor}>
            {renderTable(token as Tokens.Table)}
          </Text>,
        );
      } else {
        nonTableContent += formatToken(token, 0, null, null);
      }
    }

    flush();
    return elements;
  }, [children, dimColor]);

  return (
    <Box flexDirection="column">
      {rendered}
    </Box>
  );
}
