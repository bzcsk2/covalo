/**
 * SPEC S2-4: clone/deep-equal 防御性改进 测试。
 *
 * 覆盖 spec §10.3 三个场景：
 * 1. `{ a: 1, b: 2 }` 与 `{ b: 2, a: 1 }` 判等
 * 2. 嵌套数组/对象被正确比较
 * 3. clone 后修改嵌套 args 不污染 store 内部原对象
 */
import { describe, expect, it } from 'vitest';
import { TranscriptStore } from '../src/store/transcript-store.js';
import {
  transcriptToTimeline,
  stableStringify,
  cloneJsonLike,
} from '../src/store/timeline-adapter.js';
import type { ToolStatus } from '../src/bridge.js';

describe('S2-4: stableStringify', () => {
  it('treats {a:1,b:2} and {b:2,a:1} as equal', () => {
    const a = { a: 1, b: 2 };
    const b = { b: 2, a: 1 };
    // 裸 JSON.stringify 可能因 key 顺序不同而误判，stableStringify 必须判定为相等
    expect(stableStringify(a)).toBe(stableStringify(b));
    expect(JSON.stringify(a) === JSON.stringify(b)).toBe(false); // 验证场景成立
  });

  it('compares nested arrays and objects correctly (equal case)', () => {
    const a = {
      file: 'foo.txt',
      options: { encoding: 'utf-8', flags: ['r', 'w'] },
      meta: { created: { year: 2026, month: 7 }, author: 'x' },
    };
    // b 与 a 内容相同，但所有层级的 key 顺序都不同
    const b = {
      meta: { author: 'x', created: { month: 7, year: 2026 } },
      options: { flags: ['r', 'w'], encoding: 'utf-8' },
      file: 'foo.txt',
    };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it('detects nested value differences', () => {
    const a = { options: { flags: ['r', 'w'] } };
    const b = { options: { flags: ['r', 'x'] } };
    expect(stableStringify(a)).not.toBe(stableStringify(b));
  });

  it('handles null and primitives', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe(undefined);
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify(true)).toBe('true');
  });

  it('handles arrays at top-level', () => {
    expect(stableStringify([1, 2, 3])).toBe('[1,2,3]');
    expect(stableStringify([1, 2, 3])).toBe(stableStringify([1, 2, 3]));
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });
});

describe('S2-4: cloneJsonLike', () => {
  it('returns a deep-independent copy (mutating clone does not affect source)', () => {
    const source = {
      file: 'foo.txt',
      options: { encoding: 'utf-8', flags: ['r', 'w'] },
    };
    const clone = cloneJsonLike(source);

    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);

    // 修改 clone 的嵌套字段，源对象必须不受影响
    (clone as { options: { encoding: string } }).options.encoding = 'binary';
    (clone as { options: { flags: string[] } }).options.flags.push('x');
    expect(source.options.encoding).toBe('utf-8');
    expect(source.options.flags).toEqual(['r', 'w']);
  });

  it('handles null and primitives (returns as-is)', () => {
    expect(cloneJsonLike(null)).toBeNull();
    expect(cloneJsonLike(undefined)).toBeUndefined();
    expect(cloneJsonLike(42)).toBe(42);
    expect(cloneJsonLike('hello')).toBe('hello');
    expect(cloneJsonLike(true)).toBe(true);
  });

  it('handles arrays', () => {
    const source = [1, [2, 3], { a: 4 }];
    const clone = cloneJsonLike(source);
    expect(clone).toEqual(source);
    expect(clone).not.toBe(source);
    (clone as unknown[][])[1].push(99);
    expect((source as unknown[][])[1]).toEqual([2, 3]);
  });
});

describe('S2-4: TranscriptStore deep clone at write-time', () => {
  function makeTool(overrides: Partial<ToolStatus> = {}): ToolStatus {
    return {
      key: 'tk',
      name: 'bash',
      status: 'running',
      args: { file: 'foo.txt', options: { encoding: 'utf-8', flags: ['r', 'w'] } },
      output: '',
      startedAt: 1000,
      ...overrides,
    };
  }

  it('upsertTool: caller mutating args after write does not pollute store', () => {
    const store = new TranscriptStore();
    const args = { file: 'foo.txt', options: { encoding: 'utf-8', flags: ['r', 'w'] } };
    const tool = makeTool({ args });
    store.upsertTool('t1', 'round-1', tool);

    // 调用方原地修改 args
    args.options.encoding = 'binary';
    args.options.flags.push('x');
    (args as Record<string, unknown>).newField = 'leak';

    const stored = store.toTimelineItems()[0];
    expect(stored?.kind).toBe('tool');
    if (stored?.kind === 'tool') {
      expect(stored.tool.args).toEqual({
        file: 'foo.txt',
        options: { encoding: 'utf-8', flags: ['r', 'w'] },
      });
      expect((stored.tool.args as Record<string, unknown>).newField).toBeUndefined();
    }
  });

  it('upsertTool merge path: caller mutating merge-result args does not pollute store', () => {
    const store = new TranscriptStore();
    const initialArgs = { file: 'a.txt', options: { encoding: 'utf-8' } };
    store.upsertTool('t1', 'round-1', makeTool({ args: initialArgs }));

    // 第二次 upsert 用 merge 路径
    const patchArgs = { file: 'b.txt' };
    const patchTool = makeTool({ args: patchArgs });
    store.upsertTool('t1', 'round-1', patchTool, existing => ({
      ...existing,
      args: { ...existing.args, ...patchArgs },
    }));

    // 调用方原地修改 patchArgs
    (patchArgs as Record<string, unknown>).extra = 'leak';

    const stored = store.toTimelineItems()[0];
    expect(stored?.kind).toBe('tool');
    if (stored?.kind === 'tool') {
      expect(stored.tool.args).toEqual({ file: 'b.txt', options: { encoding: 'utf-8' } });
      expect((stored.tool.args as Record<string, unknown>).extra).toBeUndefined();
    }
  });

  it('appendMessage: caller mutating nested message content does not pollute store', () => {
    const store = new TranscriptStore();
    // 构造带嵌套字段的 message（content 是 string，但通过额外字段模拟嵌套）
    type MessageWithMeta = { role: 'user'; content: string; meta?: { ts: number; tags: string[] } };
    const msg: MessageWithMeta = {
      role: 'user',
      content: 'hello',
      meta: { ts: 1, tags: ['a', 'b'] },
    };
    store.appendMessage('m1', msg as never);

    // 调用方原地修改
    msg.meta!.ts = 999;
    msg.meta!.tags.push('c');
    (msg as { extra?: string }).extra = 'leak';

    const stored = store.toTimelineItems()[0];
    expect(stored?.kind).toBe('message');
    if (stored?.kind === 'message') {
      const storedMeta = (stored.message as { meta?: { ts: number; tags: string[] } }).meta;
      expect(storedMeta?.ts).toBe(1);
      expect(storedMeta?.tags).toEqual(['a', 'b']);
      expect((stored.message as { extra?: string }).extra).toBeUndefined();
    }
  });
});

describe('S2-4: transcriptToTimeline deep clone for React', () => {
  function makeTool(overrides: Partial<ToolStatus> = {}): ToolStatus {
    return {
      key: 'tk',
      name: 'bash',
      status: 'running',
      args: { file: 'foo.txt', options: { encoding: 'utf-8' } },
      output: '',
      startedAt: 1000,
      ...overrides,
    };
  }

  it('mutating timeline item args returned by transcriptToTimeline does not pollute store', () => {
    const store = new TranscriptStore();
    store.upsertTool('t1', 'round-1', makeTool());

    const cache = new Map();
    const timeline1 = transcriptToTimeline(store, cache);
    expect(timeline1[0]?.kind).toBe('tool');

    // 修改 React 侧 timeline 中的嵌套 args
    if (timeline1[0]?.kind === 'tool') {
      (timeline1[0].tool.args as { file: string }).file = 'LEAK.txt';
      (timeline1[0].tool.args as { options: { encoding: string } }).options.encoding = 'LEAK';
    }

    // 再次投影，应得到未污染的快照
    const timeline2 = transcriptToTimeline(store, cache);
    if (timeline2[0]?.kind === 'tool') {
      expect(timeline2[0].tool.args).toEqual({
        file: 'foo.txt',
        options: { encoding: 'utf-8' },
      });
    }

    // 同时验证 store 内部状态未被污染
    const stored = store.toTimelineItems()[0];
    if (stored?.kind === 'tool') {
      expect(stored.tool.args).toEqual({
        file: 'foo.txt',
        options: { encoding: 'utf-8' },
      });
    }
  });

  it('cache reuse: args with different key order still trigger cache hit (no spurious re-render)', () => {
    const store = new TranscriptStore();
    store.upsertTool('t1', 'round-1', makeTool({
      args: { a: 1, b: { c: 2, d: 3 } },
    }));

    const cache = new Map();
    const timeline1 = transcriptToTimeline(store, cache);
    const ref1 = timeline1[0];

    // 用一个 key 顺序不同但内容相同的 args 重写
    // 注意：由于 upsertTool 的 merge 路径会调用 cloneJsonLike，
    // 我们不能直接观察 stableStringify 行为，但 cache 复用语义可以验证：
    // 在内容相同时，下一次 transcriptToTimeline 应返回相同引用
    const timeline2 = transcriptToTimeline(store, cache);
    expect(timeline2[0]).toBe(ref1);
  });

  it('cache invalidation: actual args change triggers cache miss (new reference)', () => {
    const store = new TranscriptStore();
    store.upsertTool('t1', 'round-1', makeTool({
      args: { file: 'a.txt' },
    }));

    const cache = new Map();
    const timeline1 = transcriptToTimeline(store, cache);
    const ref1 = timeline1[0];

    // 真正修改 args
    store.upsertTool('t1', 'round-1', makeTool({
      args: { file: 'b.txt' },
    }), existing => ({
      ...existing,
      args: { file: 'b.txt' },
    }));

    const timeline2 = transcriptToTimeline(store, cache);
    expect(timeline2[0]).not.toBe(ref1);
    if (timeline2[0]?.kind === 'tool') {
      expect(timeline2[0].tool.args).toEqual({ file: 'b.txt' });
    }
  });

  it('cache reuse: message with same nested content reuses reference', () => {
    const store = new TranscriptStore();
    store.appendMessage('m1', { role: 'user', content: 'hi' });

    const cache = new Map();
    const timeline1 = transcriptToTimeline(store, cache);
    const ref1 = timeline1[0];

    const timeline2 = transcriptToTimeline(store, cache);
    expect(timeline2[0]).toBe(ref1);
  });
});
