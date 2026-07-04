import { describe, expect, it } from 'vitest';
import { TranscriptStore } from '../src/store/transcript-store.js';
import type { TimelineItem } from '../src/bridge.js';

/**
 * SPEC S2-1 §7.5 测试要求：TranscriptStore 裁剪保持 turn 完整性
 *
 * 1. 构造超过 maxEntries 的多 turn transcript，裁剪后不出现"assistant 保留但对应 user 被裁掉"。
 * 2. running tool 所在 turn 不被裁剪。
 * 3. streaming assistant 所在 turn 不被裁剪。
 * 4. hydration 后仍能按近似 turn group 裁剪。
 */

function makeTurn(store: TranscriptStore, turnId: string, suffix: string): void {
  const userId = `u-${suffix}`;
  const assistantId = `a-${suffix}`;
  const reasoningId = `r-${suffix}`;
  const toolId = `t-${suffix}`;
  store.appendUser(userId, `user ${suffix}`, undefined, turnId);
  store.ensureTextPart(assistantId, 'assistant_text', `round-${suffix}`, 1000, undefined, turnId);
  store.setTextPart(assistantId, `assistant ${suffix}`, false);
  store.ensureTextPart(reasoningId, 'reasoning', `round-${suffix}`, 1000, undefined, turnId);
  store.setTextPart(reasoningId, `reasoning ${suffix}`, false);
  store.upsertTool(toolId, `round-${suffix}`, {
    key: `key-${suffix}`,
    name: 'bash',
    status: 'done',
    args: {},
    output: `out ${suffix}`,
    startedAt: 1000,
  }, undefined, undefined, turnId);
}

describe('SPEC S2-1: TranscriptStore 裁剪保持 turn 完整性', () => {
  it('1. 裁剪后不出现 assistant 保留但对应 user 被裁掉', () => {
    const store = new TranscriptStore();
    // maxEntries=10, preserveTailEntries=5：允许裁剪前 5 个 entry（即前 1 个 turn）
    store.setTrimOptions({ maxEntries: 10, preserveTailEntries: 5 });
    // 构造 3 个 turn，每个 turn 4 个 entry（user + assistant + reasoning + tool）= 12 entries
    makeTurn(store, 'turn-1', '1');
    makeTurn(store, 'turn-2', '2');
    makeTurn(store, 'turn-3', '3');
    // 12 entries > maxEntries=10，应裁剪掉第一个 turn（4 entries）

    const items = store.toTimelineItems();
    // 裁剪后应保留 turn-2 + turn-3（8 entries）
    expect(items.length).toBeLessThanOrEqual(10);
    // 关键断言：turn-2 的 user message 必须与其 assistant/tool 一起保留
    const turn2User = items.find(i => i.id === 'u-2');
    const turn2Assistant = items.find(i => i.id === 'a-2');
    const turn2Tool = items.find(i => i.id === 't-2');
    // 要么全保留，要么全裁剪
    if (turn2Assistant || turn2Tool) {
      expect(turn2User).toBeDefined();
    }
    // turn-1 应被整体裁剪（不应只裁掉 user 而保留 assistant/tool）
    const turn1User = items.find(i => i.id === 'u-1');
    const turn1Assistant = items.find(i => i.id === 'a-1');
    const turn1Tool = items.find(i => i.id === 't-1');
    // 如果 turn-1 有任何条目保留，则 user 必须也在
    if (turn1Assistant || turn1Tool) {
      expect(turn1User).toBeDefined();
    } else {
      // turn-1 整体被裁剪
      expect(turn1User).toBeUndefined();
    }
  });

  it('2. running tool 所在 turn 不被裁剪', () => {
    const store = new TranscriptStore();
    store.setTrimOptions({ maxEntries: 5, preserveTailEntries: 0 });
    // turn-1: user + assistant + reasoning + running tool（不能裁剪）
    store.appendUser('u-1', 'user 1', undefined, 'turn-1');
    store.ensureTextPart('a-1', 'assistant_text', 'round-1', 1000, undefined, 'turn-1');
    store.setTextPart('a-1', 'assistant 1', false);
    store.upsertTool('t-1', 'round-1', {
      key: 'key-1',
      name: 'bash',
      status: 'running',  // ← running，不可裁剪
      args: {},
      output: '',
      startedAt: 1000,
    }, undefined, undefined, 'turn-1');
    // turn-2: 4 个 done 条目
    makeTurn(store, 'turn-2', '2');
    // 8 entries > maxEntries=5，但 turn-1 有 running tool，不能裁剪

    const items = store.toTimelineItems();
    // turn-1 的所有条目必须保留（因有 running tool）
    expect(items.find(i => i.id === 'u-1')).toBeDefined();
    expect(items.find(i => i.id === 't-1')).toBeDefined();
  });

  it('3. streaming assistant 所在 turn 不被裁剪', () => {
    const store = new TranscriptStore();
    store.setTrimOptions({ maxEntries: 5, preserveTailEntries: 0 });
    // turn-1: user + streaming assistant（不能裁剪）
    store.appendUser('u-1', 'user 1', undefined, 'turn-1');
    store.ensureTextPart('a-1', 'assistant_text', 'round-1', 1000, undefined, 'turn-1');
    store.setTextPart('a-1', 'streaming...', true);  // ← streaming，不可裁剪
    // turn-2: 4 个 done 条目
    makeTurn(store, 'turn-2', '2');
    // 6 entries > maxEntries=5，但 turn-1 有 streaming assistant，不能裁剪

    const items = store.toTimelineItems();
    // turn-1 的所有条目必须保留
    expect(items.find(i => i.id === 'u-1')).toBeDefined();
    expect(items.find(i => i.id === 'a-1')).toBeDefined();
  });

  it('4. hydration 后仍能按近似 turn group 裁剪', () => {
    const store = new TranscriptStore();
    store.setTrimOptions({ maxEntries: 8, preserveTailEntries: 4 });
    // 模拟 hydration：通过 replaceAll 注入带 turnId 的历史条目
    const historyItems: TimelineItem[] = [];
    for (let i = 1; i <= 3; i++) {
      const turnId = `hist-turn-${i}`;
      historyItems.push({ id: `hu-${i}`, kind: 'message', message: { role: 'user', content: `u${i}` }, turnId });
      historyItems.push({ id: `ha-${i}`, kind: 'assistant_text', roundId: `round-${i}`, text: `a${i}`, isStreaming: false, startTs: 1000, turnId });
      historyItems.push({ id: `hr-${i}`, kind: 'reasoning', roundId: `round-${i}`, text: `r${i}`, isStreaming: false, startTs: 1000, turnId });
      historyItems.push({ id: `ht-${i}`, kind: 'tool', roundId: `round-${i}`, tool: { key: `k${i}`, name: 'bash', status: 'done', args: {}, output: '', startedAt: 1000 }, turnId });
    }
    store.replaceAll(historyItems);
    // 12 entries > maxEntries=8，应裁剪掉第一个 turn（4 entries）

    const items = store.toTimelineItems();
    expect(items.length).toBeLessThanOrEqual(8);
    // turn-1 应被整体裁剪
    expect(items.find(i => i.id === 'hu-1')).toBeUndefined();
    expect(items.find(i => i.id === 'ha-1')).toBeUndefined();
    expect(items.find(i => i.id === 'ht-1')).toBeUndefined();
    // turn-2 和 turn-3 保留
    expect(items.find(i => i.id === 'hu-2')).toBeDefined();
    expect(items.find(i => i.id === 'hu-3')).toBeDefined();
  });
});
