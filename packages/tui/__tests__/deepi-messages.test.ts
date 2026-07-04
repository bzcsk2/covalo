import { describe, expect, it } from 'vitest';
import { formatToolResultDetailLines, formatToolResultInlineSummary, getVisibleTimeline } from '../src/DeepiMessages.js';
import type { ToolStatus } from '../src/store/types.js';

/** 构造最小 ToolStatus，省去每次手写全部字段 */
function mkTool(partial: Partial<ToolStatus> & Pick<ToolStatus, 'name' | 'output' | 'status'>): ToolStatus {
  return {
    key: 'test-key',
    args: {},
    startedAt: 0,
    elapsedMs: 100,
    ...partial,
  };
}

describe('getVisibleTimeline', () => {
  it('returns full timeline when within window size', () => {
    const timeline = [1, 2, 3];
    const result = getVisibleTimeline(timeline, 5);
    expect(result.visible).toBe(timeline);
    expect(result.hiddenCount).toBe(0);
  });

  it('slices tail when timeline exceeds window size', () => {
    const timeline = [1, 2, 3, 4, 5];
    const result = getVisibleTimeline(timeline, 3);
    expect(result.visible).toEqual([3, 4, 5]);
    expect(result.hiddenCount).toBe(2);
    // reference is different
    expect(result.visible).not.toBe(timeline);
  });

  it('returns empty visible for empty timeline', () => {
    const result = getVisibleTimeline([], 10);
    expect(result.visible).toEqual([]);
    expect(result.hiddenCount).toBe(0);
  });

  it('handles timeline length equal to window size', () => {
    const timeline = ['a', 'b', 'c'];
    const result = getVisibleTimeline(timeline, 3);
    expect(result.visible).toBe(timeline);
    expect(result.hiddenCount).toBe(0);
  });

  it('works with zero window size', () => {
    const timeline = [1, 2];
    const result = getVisibleTimeline(timeline, 0);
    expect(result.visible).toEqual([]);
    expect(result.hiddenCount).toBe(2);
  });
});

describe('formatToolResultInlineSummary', () => {
  it('list_dir 多项输出：折叠态下合并为单行（用两个空格分隔）', () => {
    // 模拟 list_dir 返回多个目录项的 JSON 输出
    const output = JSON.stringify({
      items: [
        { name: 'node_modules', type: 'dir' },
        { name: 'package.json', type: 'file' },
        { name: 'dist', type: 'dir' },
      ],
    });
    const tool = mkTool({ name: 'list_dir', output, status: 'done' });
    const summary = formatToolResultInlineSummary(tool);
    // 期望三个目录项合并为一行
    expect(summary).toBe('node_modules/  package.json  dist/');
    expect(summary.includes('\n')).toBe(false);
  });

  it('bash 多行 stdout：折叠态下合并为单行', () => {
    const output = JSON.stringify({
      stdout: 'line1\nline2\nline3',
      stderr: '',
    });
    const tool = mkTool({ name: 'bash', output, status: 'done' });
    const summary = formatToolResultInlineSummary(tool);
    expect(summary).toBe('line1  line2  line3');
    expect(summary.includes('\n')).toBe(false);
  });

  it('超长输出：折叠态回退到首行 + 省略号', () => {
    const longLine = 'a'.repeat(120);
    const output = JSON.stringify({
      stdout: `${longLine}\nsecond\nthird`,
      stderr: '',
    });
    const tool = mkTool({ name: 'bash', output, status: 'done' });
    const summary = formatToolResultInlineSummary(tool);
    // 应包含省略号且不换行
    expect(summary.includes('…')).toBe(true);
    expect(summary.includes('\n')).toBe(false);
  });

  it('空输出：done 状态返回 Done，error 状态返回 Error', () => {
    expect(formatToolResultInlineSummary(mkTool({ name: 'bash', output: '', status: 'done' }))).toBe('Done');
    expect(formatToolResultInlineSummary(mkTool({ name: 'bash', output: '', status: 'error' }))).toBe('Error');
  });

  it('running 且无输出时返回空字符串（不显示 → Done）', () => {
    const summary = formatToolResultInlineSummary(mkTool({ name: 'bash', output: '', status: 'running' }));
    expect(summary).toBe('');
  });
});

describe('formatToolResultDetailLines', () => {
  it('list_dir 多项输出：展开态保留原始多行结构', () => {
    const output = JSON.stringify({
      items: [
        { name: 'node_modules', type: 'dir' },
        { name: 'package.json', type: 'file' },
        { name: 'dist', type: 'dir' },
        { name: 'src', type: 'dir' },
      ],
    });
    const tool = mkTool({ name: 'list_dir', output, status: 'done' });
    const lines = formatToolResultDetailLines(tool);
    // 应保留 4 行，不合并
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe('node_modules/');
    expect(lines[1]).toBe('package.json');
    expect(lines[2]).toBe('dist/');
    expect(lines[3]).toBe('src/');
  });

  it('bash 多行 stdout：展开态保留多行', () => {
    const output = JSON.stringify({
      stdout: 'line1\nline2\nline3\nline4',
      stderr: '',
    });
    const tool = mkTool({ name: 'bash', output, status: 'done' });
    const lines = formatToolResultDetailLines(tool);
    expect(lines.length).toBe(4);
    expect(lines[0]).toBe('line1');
    expect(lines[3]).toBe('line4');
  });

  it('error 状态：保留更多上下文行（最多 8 行）', () => {
    const output = JSON.stringify({
      stdout: '',
      stderr: 'err1\nerr2\nerr3\nerr4\nerr5\nerr6\nerr7\nerr8\nerr9\nerr10',
    });
    const tool = mkTool({ name: 'bash', output, status: 'error' });
    const lines = formatToolResultDetailLines(tool);
    // 应保留 8 行（错误状态 maxLines=8）
    expect(lines.length).toBe(8);
    expect(lines[0]).toBe('err1');
    expect(lines[7]).toBe('err8');
  });

  it('done 状态：正常保留最多 6 行', () => {
    const output = JSON.stringify({
      items: Array.from({ length: 10 }, (_, i) => ({ name: `item${i}`, type: 'file' })),
    });
    const tool = mkTool({ name: 'list_dir', output, status: 'done' });
    const lines = formatToolResultDetailLines(tool);
    expect(lines.length).toBe(6);
    expect(lines[0]).toBe('item0');
    expect(lines[5]).toBe('item5');
  });

  it('空输出：error 返回 ["Error"]，done 返回 []', () => {
    expect(formatToolResultDetailLines(mkTool({ name: 'bash', output: '', status: 'error' }))).toEqual(['Error']);
    expect(formatToolResultDetailLines(mkTool({ name: 'bash', output: '', status: 'done' }))).toEqual([]);
  });
});
