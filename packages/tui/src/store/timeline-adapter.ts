import type { TimelineItem } from '../bridge.js';
import type { TranscriptStore } from './transcript-store.js';

/**
 * SPEC S2-4: 稳定序列化 JSON-like 值，按 key 排序输出。
 * 用于比较 args / message 嵌套字段是否相等，避免裸 JSON.stringify 因 key 顺序不同而误判。
 * 导出供测试直接调用。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * 比较条目内容是否一致（用于结构共享缓存）。
 * SPEC S2-4: 用 stableStringify 比较 args，避免 key 顺序差异导致无意义重渲染。
 */
function timelineEntryEquals(a: TimelineItem, b: TimelineItem): boolean {
  if (a.id !== b.id || a.kind !== b.kind) return false;
  // role 必须一致（含同为 undefined）
  if ((a as { role?: unknown }).role !== (b as { role?: unknown }).role) return false;
  // SPEC S2-1: turnId 必须一致（含同为 undefined）
  if ((a as { turnId?: unknown }).turnId !== (b as { turnId?: unknown }).turnId) return false;

  switch (a.kind) {
    case 'message':
      return b.kind === 'message'
        && a.message.role === b.message.role
        && a.message.content === b.message.content
        && stableStringify(a.message) === stableStringify(b.message);
    case 'assistant_text':
    case 'reasoning':
      return (b.kind === 'assistant_text' || b.kind === 'reasoning')
        && a.roundId === b.roundId
        && a.text === b.text
        && a.isStreaming === b.isStreaming
        && a.startTs === b.startTs;
    case 'tool':
      return b.kind === 'tool'
        && a.roundId === b.roundId
        && a.tool.key === b.tool.key
        && a.tool.name === b.tool.name
        && a.tool.status === b.tool.status
        && a.tool.output === b.tool.output
        && a.tool.startedAt === b.tool.startedAt
        && a.tool.elapsedMs === b.tool.elapsedMs
        && stableStringify(a.tool.args) === stableStringify(b.tool.args);
  }
}

/**
 * 将 TranscriptStore 投影为 `TimelineItem[]`，未变更条目复用缓存引用。
 */
export function transcriptToTimeline(
  store: TranscriptStore,
  cache: Map<string, TimelineItem>,
): TimelineItem[] {
  const items = store.toTimelineItems();
  const activeIds = new Set<string>();

  const projected = items.map(item => {
    activeIds.add(item.id);
    const cached = cache.get(item.id);
    if (cached && timelineEntryEquals(cached, item)) {
      return cached;
    }
    const snapshot = cloneForReact(item);
    cache.set(item.id, snapshot);
    return snapshot;
  });

  for (const id of cache.keys()) {
    if (!activeIds.has(id)) cache.delete(id);
  }

  return projected;
}

/**
 * SPEC S2-4: 深拷贝 JSON-like 值。
 * 优先 structuredClone（深拷贝），fallback 到 JSON.parse(JSON.stringify())。
 * 导出供测试直接调用。
 */
export function cloneJsonLike<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // structuredClone 不支持函数/Symbol 等，fallback 到 JSON
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * SPEC S2-4: 深拷贝条目给 React 使用，避免嵌套 args/message 引用污染。
 */
function cloneForReact(item: TimelineItem): TimelineItem {
  switch (item.kind) {
    case 'message':
      return { ...item, message: cloneJsonLike(item.message) };
    case 'assistant_text':
    case 'reasoning':
      return { ...item, text: item.text };
    case 'tool':
      return { ...item, tool: { ...item.tool, args: cloneJsonLike(item.tool.args) } };
  }
}
