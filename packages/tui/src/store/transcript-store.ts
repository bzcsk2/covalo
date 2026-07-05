import type { ChatMessage, AgentRole } from '@covalo/core';
import type { TimelineItem, ToolStatus } from '../bridge.js';
import { mergeTimelineEntries } from './hydration-merge.js';

/**
 * 带可选 role 字段的条目（用于内部读取/写入 role 属性时绕过联合类型窄化）。
 */
type TimelineEntryWithRole = TimelineItem & { role?: AgentRole };

/**
 * 只读快照，供 adapter / useSyncExternalStore 消费。
 */
export interface TranscriptSnapshot {
  readonly order: readonly string[];
  readonly version: number;
}

export interface TranscriptStoreStats {
  orderLength: number;
  entriesSize: number;
  liveTouchedSize: number;
  entryRevisionSize: number;
  version: number;
}

export interface TranscriptTrimOptions {
  maxEntries: number;
  preserveTailEntries: number;
}

const DEFAULT_TRIM_OPTIONS: TranscriptTrimOptions = {
  maxEntries: 1200,
  preserveTailEntries: 300,
};

/**
 * 规范化 transcript 存储：按 id 索引 + 有序 order，流式文本就地追加。
 */
export class TranscriptStore {
  private order: string[] = [];
  private readonly entries = new Map<string, TimelineItem>();
  private readonly liveTouchedIds = new Set<string>();
  private readonly entryRevision = new Map<string, number>();
  private version = 0;
  private readonly listeners = new Set<() => void>();
  private trimOptions: TranscriptTrimOptions = { ...DEFAULT_TRIM_OPTIONS };

  /**
   * SPEC S2-1: 覆盖裁剪选项，便于测试或生产调优。
   * 设置后会立即触发一次裁剪。
   */
  setTrimOptions(options: Partial<TranscriptTrimOptions>): void {
    this.trimOptions = { ...this.trimOptions, ...options };
    this.trimToLimitInternal(this.trimOptions);
    this.bump();
  }

  /**
   * @returns 当前版本号（每次变更 +1）
   */
  getVersion(): number {
    return this.version;
  }

  /**
   * @returns 数据规模指标
   */
  getStats(): TranscriptStoreStats {
    return {
      orderLength: this.order.length,
      entriesSize: this.entries.size,
      liveTouchedSize: this.liveTouchedIds.size,
      entryRevisionSize: this.entryRevision.size,
      version: this.version,
    };
  }

  /**
   * @returns 有序条目 id 与版本
   */
  getSnapshot(): TranscriptSnapshot {
    return { order: this.order, version: this.version };
  }

  /**
   * 订阅 store 变更（供 useSyncExternalStore 使用）。
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * @returns 当前条目数量
   */
  getEntryCount(): number {
    return this.order.length;
  }

  /**
   * 用 timeline 全量替换内部状态（非 hydration 场景）。
   */
  replaceAll(items: TimelineItem[]): void {
    this.order = items.map(item => item.id);
    this.entries.clear();
    this.liveTouchedIds.clear();
    this.entryRevision.clear();
    for (const item of items) {
      this.entries.set(item.id, cloneTimelineItem(item));
      this.entryRevision.set(item.id, 0);
    }
    this.bumpAfterMutation();
  }

  /**
   * Session hydration 合并：保留 live 期间写入的 part，拒绝陈旧空文本覆盖。
   */
  mergeHydration(incoming: TimelineItem[]): void {
    const local = this.toTimelineItems();
    const merged = mergeTimelineEntries(local, incoming, this.liveTouchedIds);
    this.order = merged.map(item => item.id);
    this.entries.clear();
    for (const item of merged) {
      this.entries.set(item.id, cloneTimelineItem(item));
      if (!this.entryRevision.has(item.id)) {
        this.entryRevision.set(item.id, 0);
      }
    }
    this.bumpAfterMutation();
  }

  /**
   * @returns 指定 part 的 revision（live 事件单调递增）
   */
  getPartRevision(partId: string): number {
    return this.entryRevision.get(partId) ?? 0;
  }

  /**
   * @returns 是否曾有 live 流式写入
   */
  hasLiveTouchedEntries(): boolean {
    return this.liveTouchedIds.size > 0;
  }

  /**
   * 导出有序 timeline（内部可变条目，仅供 adapter 读取）。
   */
  toTimelineItems(): TimelineItem[] {
    return this.order.map(id => this.entries.get(id)!);
  }

  private markLiveTouch(id: string): void {
    this.liveTouchedIds.add(id);
    this.entryRevision.set(id, (this.entryRevision.get(id) ?? 0) + 1);
  }

  /**
   * 追加任意角色消息条目。
   * SPEC S2-1: turnId 可选，用于裁剪时按完整 turn 分组。
   * SPEC S2-4: 用 cloneJsonLike 深拷贝 message 嵌套字段，避免调用方后续 mutate 污染 store。
   */
  appendMessage(id: string, message: ChatMessage, role?: AgentRole, turnId?: string): void {
    const entry: TimelineItem = { id, kind: 'message', message: cloneJsonLike(message), role, turnId };
    this.order.push(id);
    this.entries.set(id, entry);
    this.markLiveTouch(id);
    this.bumpAfterMutation();
  }

  /**
   * 追加用户消息条目。
   */
  appendUser(id: string, content: string, role?: AgentRole, turnId?: string): void {
    this.appendMessage(id, { role: 'user', content }, role, turnId);
  }

  /**
   * 确保流式 text / reasoning 条目存在。
   * SPEC S2-1: turnId 可选，用于裁剪时按完整 turn 分组。
   */
  ensureTextPart(
    id: string,
    kind: 'assistant_text' | 'reasoning',
    roundId: string,
    startTs: number,
    role?: AgentRole,
    turnId?: string,
  ): void {
    if (this.entries.has(id)) {
      // 已存在但缺 role/turnId（例如 hydration 合并进来的旧条目）：补齐
      const existing = this.entries.get(id)!;
      let mutated = false;
      if (role && !(existing as TimelineEntryWithRole).role) {
        (existing as TimelineEntryWithRole).role = role;
        mutated = true;
      }
      if (turnId && !(existing as { turnId?: string }).turnId) {
        (existing as { turnId?: string }).turnId = turnId;
        mutated = true;
      }
      if (mutated) {
        this.markLiveTouch(id);
        this.bumpAfterMutation();
      }
      return;
    }

    const entry: TimelineItem = {
      id,
      kind,
      roundId,
      text: '',
      isStreaming: true,
      startTs,
      role,
      turnId,
    };

    if (kind === 'assistant_text') {
      const insertBefore = this.order.findIndex(existingId => {
        const existing = this.entries.get(existingId);
        return Boolean(
          existing
          && 'roundId' in existing
          && existing.roundId === roundId
          && existing.kind === 'tool',
        );
      });
      if (insertBefore === -1) {
        this.order.push(id);
      } else {
        this.order.splice(insertBefore, 0, id);
      }
    } else {
      this.order.push(id);
    }

    this.entries.set(id, entry);
    this.markLiveTouch(id);
    this.bumpAfterMutation();
  }

  /**
   * O(1) 追加流式文本 chunk，不复制 order 数组。
   */
  appendPartDelta(partId: string, chunk: string): boolean {
    const entry = this.entries.get(partId);
    if (!entry || (entry.kind !== 'assistant_text' && entry.kind !== 'reasoning')) {
      return false;
    }
    entry.text += chunk;
    this.markLiveTouch(partId);
    this.bump();
    return true;
  }

  /**
   * 覆盖流式 part 全文（如 assistant_final）。
   */
  setTextPart(partId: string, text: string, isStreaming: boolean): void {
    const entry = this.entries.get(partId);
    if (!entry || (entry.kind !== 'assistant_text' && entry.kind !== 'reasoning')) {
      return;
    }
    entry.text = text;
    entry.isStreaming = isStreaming;
    this.markLiveTouch(partId);
    this.bump();
  }

  /**
   * 标记 part 流式结束。
   */
  finalizePart(partId: string): void {
    const entry = this.entries.get(partId);
    if (!entry || (entry.kind !== 'assistant_text' && entry.kind !== 'reasoning')) {
      return;
    }
    entry.isStreaming = false;
    this.markLiveTouch(partId);
    this.bump();
  }

  /**
   * upsert 助手正文（含 assistant 在 reasoning/tool 之前的插入规则）。
   */
  upsertAssistantText(item: Extract<TimelineItem, { kind: 'assistant_text' }>): void {
    const existing = this.entries.get(item.id);
    if (existing) {
      this.entries.set(item.id, { ...item, text: item.text });
      this.markLiveTouch(item.id);
      this.bumpAfterMutation();
      return;
    }

    const insertBefore = this.order.findIndex(existingId => {
      const candidate = this.entries.get(existingId);
      return Boolean(
        candidate
        && 'roundId' in candidate
        && candidate.roundId === item.roundId
        && candidate.kind === 'tool',
      );
    });

    if (insertBefore === -1) {
      this.order.push(item.id);
    } else {
      this.order.splice(insertBefore, 0, item.id);
    }
    this.entries.set(item.id, cloneTimelineItem(item));
    this.markLiveTouch(item.id);
    this.bumpAfterMutation();
  }

  /**
   * upsert reasoning 条目。
   */
  upsertReasoning(item: Extract<TimelineItem, { kind: 'reasoning' }>): void {
    const existing = this.entries.get(item.id);
    if (existing) {
      this.entries.set(item.id, { ...item, text: item.text });
    } else {
      this.order.push(item.id);
      this.entries.set(item.id, cloneTimelineItem(item));
    }
    this.markLiveTouch(item.id);
    this.bumpAfterMutation();
  }

  /**
   * upsert 工具条目。
   * SPEC S2-1: turnId 可选，用于裁剪时按完整 turn 分组。
   * SPEC S2-4: 新建条目时用 cloneJsonLike 深拷贝 tool.args，避免调用方后续 mutate 污染 store。
   */
  upsertTool(
    id: string,
    roundId: string,
    tool: ToolStatus,
    merge?: (existing: ToolStatus) => ToolStatus,
    role?: AgentRole,
    turnId?: string,
  ): void {
    const existing = this.entries.get(id);
    if (existing?.kind === 'tool') {
      const next = merge ? merge(existing.tool) : { ...existing.tool, ...tool };
      // SPEC S2-4: 始终深拷贝 args，无论 merge 还是浅合并路径
      existing.tool = { ...next, args: cloneJsonLike(next.args) };
      // 补齐 role/turnId（hydration 合并进来的旧条目可能缺失）
      if (role && !existing.role) (existing as TimelineEntryWithRole).role = role;
      if (turnId && !(existing as { turnId?: string }).turnId) {
        (existing as { turnId?: string }).turnId = turnId;
      }
      this.markLiveTouch(id);
      this.bumpAfterMutation();
      return;
    }

    this.order.push(id);
    this.entries.set(id, {
      id,
      kind: 'tool',
      roundId,
      tool: { ...tool, args: cloneJsonLike(tool.args) },
      role,
      turnId,
    });
    this.markLiveTouch(id);
    this.bumpAfterMutation();
  }

  /**
   * 通用 upsert（非 assistant 插入规则场景）。
   */
  upsertItem(item: TimelineItem, update?: (existing: TimelineItem) => TimelineItem): void {
    const existing = this.entries.get(item.id);
    if (!existing) {
      this.order.push(item.id);
      this.entries.set(item.id, cloneTimelineItem(item));
      this.bumpAfterMutation();
      return;
    }
    this.entries.set(item.id, update ? update(existing) : cloneTimelineItem(item));
    this.bumpAfterMutation();
  }

  private canTrimEntry(entry: TimelineItem): boolean {
    switch (entry.kind) {
      case 'assistant_text':
      case 'reasoning':
        return entry.isStreaming !== true;
      case 'tool':
        return entry.tool.status !== 'running';
      case 'message':
        return true;
    }
  }

  private getTrimGroupId(id: string, entry: TimelineItem | undefined): string {
    if (!entry) return `missing:${id}`;
    // SPEC S2-1: 优先按 turnId 分组，让整个 turn（user + assistant + tool）整体裁剪/保留
    const turnId = (entry as { turnId?: string }).turnId;
    if (turnId) return `turn:${turnId}`;
    if ('roundId' in entry) return `round:${entry.roundId}`;
    return `entry:${id}`;
  }

  private canTrimGroup(ids: string[]): boolean {
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry && !this.canTrimEntry(entry)) return false;
    }
    return true;
  }

  private trimToLimitInternal(options: TranscriptTrimOptions): number {
    const { maxEntries, preserveTailEntries } = options;
    if (maxEntries <= 0) return 0;
    if (this.order.length <= maxEntries) return 0;

    const preserveTail = Math.max(0, Math.min(preserveTailEntries, this.order.length));
    const hardCutoffIndex = Math.max(0, this.order.length - preserveTail);

    const groups: Array<{ ids: string[] }> = [];
    const groupById = new Map<string, { ids: string[] }>();

    for (let i = 0; i < hardCutoffIndex; i++) {
      const id = this.order[i];
      const groupId = this.getTrimGroupId(id, this.entries.get(id));
      let group = groupById.get(groupId);
      if (!group) {
        group = { ids: [] };
        groupById.set(groupId, group);
        groups.push(group);
      }
      group.ids.push(id);
    }

    const removableIds: string[] = [];

    for (const group of groups) {
      if (!this.canTrimGroup(group.ids)) continue;
      const wouldRemove = removableIds.length + group.ids.length;
      if (this.order.length - wouldRemove <= maxEntries) {
        removableIds.push(...group.ids);
        break;
      }
      removableIds.push(...group.ids);
    }

    if (removableIds.length === 0) return 0;

    const removeSet = new Set(removableIds);
    this.order = this.order.filter(id => !removeSet.has(id));
    for (const id of removeSet) {
      this.entries.delete(id);
      this.liveTouchedIds.delete(id);
      this.entryRevision.delete(id);
    }
    return removeSet.size;
  }

  private bumpAfterMutation(): void {
    this.trimToLimitInternal(this.trimOptions);
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * SPEC S2-4: 深拷贝 JSON-like 值（args / message 嵌套字段）。
 * 优先用 structuredClone（深拷贝），fallback 到 JSON.parse(JSON.stringify)。
 */
function cloneJsonLike<T>(value: T): T {
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
 * 克隆 timeline 条目，避免外部修改污染 store。
 * SPEC S2-4: 深拷贝 tool.args 和 message 嵌套字段，避免浅拷贝导致引用污染。
 */
function cloneTimelineItem(item: TimelineItem): TimelineItem {
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
