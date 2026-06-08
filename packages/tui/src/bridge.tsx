import type { ChatMessage, ReasonixEngine } from '@deepreef/core';
import { setTUIState } from './App.js';
import { t } from './i18n/index.js';

export interface ToolStatus {
  key: string;
  name: string;
  status: 'running' | 'done' | 'error';
  args: Record<string, unknown>;
  output: string;
  startedAt: number;
  elapsedMs?: number;
}

export type TimelineItem =
  | { id: string; kind: 'message'; message: ChatMessage }
  | { id: string; kind: 'assistant_text'; roundId: string; text: string; isStreaming: boolean; startTs: number }
  | { id: string; kind: 'reasoning'; roundId: string; text: string; isStreaming: boolean; startTs: number }
  | { id: string; kind: 'tool'; roundId: string; tool: ToolStatus };

export interface BridgeState {
  timeline: TimelineItem[];
  isLoading: boolean;
  messageQueue: string[];
  pendingInstructionCount: number;
  tokens: { input: number; output: number; cacheHit: number; cacheMiss: number };
  contextUsage: number;
  warnings: string[];
  error: string | null;
  permissionPrompt: { toolName: string; args: Record<string, unknown> } | null;
  thinkingMode: string;
  effectiveThinkingMode: string | undefined;
  reasoningActive: boolean;
  /** Free Auto routing: actual provider:model selected for current request */
  routedModel?: string;
  /** Free Auto routing: failover info */
  routedModelDetail?: string;
}

function historyRoundId(index: number): string {
  return `history-${index}-${crypto.randomUUID()}`;
}

export function timelineFromMessages(messages: ChatMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  messages.forEach((message, index) => {
    const id = `message-${index}-${crypto.randomUUID()}`;
    if (message.role === 'assistant') {
      const roundId = historyRoundId(index);
      if (message.content) {
        items.push({
          id: `${id}-assistant`,
          kind: 'assistant_text',
          roundId,
          text: message.content,
          isStreaming: false,
          startTs: Date.now(),
        });
      }
      if (message.reasoning_content) {
        items.push({
          id: `${id}-reasoning`,
          kind: 'reasoning',
          roundId,
          text: message.reasoning_content,
          isStreaming: false,
          startTs: Date.now(),
        });
      }
      return;
    }
    items.push({ id, kind: 'message', message });
  });
  return items;
}

function fallbackToolKey(index: number | undefined, name: string | undefined): string {
  return index === undefined ? `tool_${name ?? 'unknown'}` : `tool_${index}`;
}

function parseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function createBridge(
  engine: ReasonixEngine,
  setState: React.Dispatch<React.SetStateAction<BridgeState>>,
  onUserInput?: (text: string) => void,
): {
  submit: (text: string) => Promise<void>;
  cancel: () => void;
} {
  let running = false;
  let processingQueue = false;
  let activeRequest = 0;

  const updateTimeline = (mutate: (items: TimelineItem[]) => TimelineItem[]) => {
    setState(prev => ({ ...prev, timeline: mutate(prev.timeline) }));
  };

  const upsertItem = (item: TimelineItem, update?: (existing: TimelineItem) => TimelineItem) => {
    updateTimeline(items => {
      const index = items.findIndex(existing => existing.id === item.id);
      if (index === -1) return [...items, item];
      const next = [...items];
      next[index] = update ? update(next[index]!) : item;
      return next;
    });
  };

  const upsertAssistantText = (item: Extract<TimelineItem, { kind: 'assistant_text' }>) => {
    updateTimeline(items => {
      const index = items.findIndex(existing => existing.id === item.id);
      if (index !== -1) {
        const next = [...items];
        next[index] = item;
        return next;
      }

      const firstDetail = items.findIndex(existing =>
        'roundId' in existing
        && existing.roundId === item.roundId
        && (existing.kind === 'reasoning' || existing.kind === 'tool')
      );
      if (firstDetail === -1) return [...items, item];

      const next = [...items];
      next.splice(firstDetail, 0, item);
      return next;
    });
  };

  const processQueue = () => {
    if (running || processingQueue) return;
    processingQueue = true;
    setState(prev => {
      const [next, ...rest] = prev.messageQueue;
      if (!next) {
        processingQueue = false;
        return prev;
      }
      setTimeout(() => {
        processingQueue = false;
        void submit(next);
      }, 0);
      return { ...prev, messageQueue: rest };
    });
  };

  const submit = async (text: string) => {
    onUserInput?.(text);
    if (running) {
      const result = engine.enqueueInstruction(text);
      if (result.status === 'queued') {
        setState(prev => ({ ...prev, pendingInstructionCount: result.queueLength }));
        return;
      }
      if (result.status === 'full') {
        setState(prev => ({
          ...prev,
          pendingInstructionCount: result.queueLength,
          messageQueue: [...prev.messageQueue, text],
        }));
        return;
      }
      if (result.status === 'ignored') return;
      setState(prev => ({ ...prev, messageQueue: [...prev.messageQueue, text] }));
      return;
    }

    running = true;
    const requestId = ++activeRequest;
    let roundNumber = 0;
    let roundId = '';
    let assistantId: string | null = null;
    let reasoningId: string | null = null;
    let assistantText = '';
    let reasoningText = '';
    const toolCallArgs = new Map<number, string>();
    const activeToolKeys = new Map<number, string>();
    const toolItemIds = new Map<string, string>();
    const toolOutputs = new Map<string, string>();
    let toolSequence = 0;

    const startRound = () => {
      roundNumber += 1;
      roundId = `turn-${requestId}-round-${roundNumber}-${crypto.randomUUID()}`;
      assistantId = null;
      reasoningId = null;
      assistantText = '';
      reasoningText = '';
      toolCallArgs.clear();
      activeToolKeys.clear();
      toolItemIds.clear();
      toolOutputs.clear();
      toolSequence = 0;
    };

    const finalizeRound = () => {
      if (assistantId) {
        const id = assistantId;
        upsertItem({
          id,
          kind: 'assistant_text',
          roundId,
          text: assistantText,
          isStreaming: false,
          startTs: Date.now(),
        }, existing => existing.kind === 'assistant_text' ? { ...existing, isStreaming: false } : existing);
      }
      if (reasoningId) {
        const id = reasoningId;
        upsertItem({
          id,
          kind: 'reasoning',
          roundId,
          text: reasoningText,
          isStreaming: false,
          startTs: Date.now(),
        }, existing => existing.kind === 'reasoning' ? { ...existing, isStreaming: false } : existing);
      }
    };

    const ensureAssistant = () => {
      if (!assistantId) assistantId = `${roundId}-assistant`;
      return assistantId;
    };

    const ensureReasoning = () => {
      if (!reasoningId) reasoningId = `${roundId}-reasoning`;
      return reasoningId;
    };

    const getToolItemId = (key: string) => {
      let itemId = toolItemIds.get(key);
      if (!itemId) {
        itemId = `${roundId}-${key}`;
        toolItemIds.set(key, itemId);
      }
      return itemId;
    };

    const upsertTool = (key: string, patch: Partial<ToolStatus>) => {
      const itemId = getToolItemId(key);
      const now = Date.now();
      const rawArgs = [...toolCallArgs.values()].at(-1);
      const cleanPatch = { ...patch };
      if (!cleanPatch.name) delete cleanPatch.name;
      const fallback: ToolStatus = {
        key,
        name: patch.name ?? key.replace(/_\d+$/, ''),
        status: 'running',
        args: parseArgs(rawArgs),
        output: '',
        startedAt: now,
      };
      upsertItem({
        id: itemId,
        kind: 'tool',
        roundId,
        tool: { ...fallback, ...cleanPatch },
      }, existing => {
        if (existing.kind !== 'tool') return existing;
        return {
          ...existing,
          tool: {
            ...existing.tool,
            ...cleanPatch,
            elapsedMs: patch.elapsedMs ?? (patch.status && patch.status !== 'running' ? now - existing.tool.startedAt : existing.tool.elapsedMs),
          },
        };
      });
    };

    startRound();
    setTUIState('loading');
    setState(prev => ({
      ...prev,
      isLoading: true,
      error: null,
      warnings: [],
      permissionPrompt: null,
      timeline: [
        ...prev.timeline,
        {
          id: `user-${requestId}-${crypto.randomUUID()}`,
          kind: 'message',
          message: { role: 'user', content: text },
        },
      ],
    }));

    try {
      for await (const event of engine.submit(text)) {
        if (requestId !== activeRequest) continue;

        switch (event.role) {
          case 'assistant_delta': {
            assistantText += event.content ?? '';
            upsertAssistantText({
              id: ensureAssistant(),
              kind: 'assistant_text',
              roundId,
              text: assistantText,
              isStreaming: true,
              startTs: Date.now(),
            });
            break;
          }

          case 'assistant_final': {
            assistantText = event.content ?? assistantText;
            if (typeof event.metadata?.reasoning === 'string') {
              reasoningText = event.metadata.reasoning;
            }
            if (assistantText) {
              upsertAssistantText({
                id: ensureAssistant(),
                kind: 'assistant_text',
                roundId,
                text: assistantText,
                isStreaming: false,
                startTs: Date.now(),
              });
            }
            if (reasoningText) {
              upsertItem({
                id: ensureReasoning(),
                kind: 'reasoning',
                roundId,
                text: reasoningText,
                isStreaming: false,
                startTs: Date.now(),
              });
            }
            break;
          }

          case 'reasoning_delta': {
            reasoningText += event.content ?? '';
            setState(prev => ({ ...prev, reasoningActive: true }));
            upsertItem({
              id: ensureReasoning(),
              kind: 'reasoning',
              roundId,
              text: reasoningText,
              isStreaming: true,
              startTs: Date.now(),
            });
            break;
          }

          case 'tool_call_delta':
            if (event.toolCallIndex !== undefined && event.content) {
              toolCallArgs.set(event.toolCallIndex, event.content);
            }
            break;

          case 'tool_start': {
            const key = `${fallbackToolKey(event.toolCallIndex, event.toolName)}_${++toolSequence}`;
            if (event.toolCallIndex !== undefined) activeToolKeys.set(event.toolCallIndex, key);
            const raw = event.toolCallIndex === undefined ? undefined : toolCallArgs.get(event.toolCallIndex);
            upsertTool(key, {
              name: event.toolName ?? 'unknown',
              status: 'running',
              args: parseArgs(raw),
              output: '',
              startedAt: Date.now(),
            });
            break;
          }

          case 'tool_progress': {
            const key = event.toolCallIndex === undefined
              ? fallbackToolKey(undefined, event.toolName)
              : activeToolKeys.get(event.toolCallIndex) ?? fallbackToolKey(event.toolCallIndex, event.toolName);
            const name = event.toolName || undefined;
            if (event.content === 'done') {
              upsertTool(key, { name, status: 'done' });
              break;
            }
            if (event.content && event.content !== 'running') {
              const previous = toolOutputs.get(key) ?? '';
              const output = previous + (previous ? '\n' : '') + event.content;
              toolOutputs.set(key, output);
              upsertTool(key, {
                name,
                output,
              });
            }
            break;
          }

          case 'tool': {
            const key = event.toolCallIndex === undefined
              ? fallbackToolKey(undefined, event.toolName)
              : activeToolKeys.get(event.toolCallIndex) ?? fallbackToolKey(event.toolCallIndex, event.toolName);
            upsertTool(key, {
              name: event.toolName ?? 'tool',
              status: event.severity === 'error' ? 'error' : 'done',
              output: event.content ?? '',
            });
            toolOutputs.set(key, event.content ?? '');
            break;
          }

          case 'error':
            if (event.toolCallIndex !== undefined) {
              const key = activeToolKeys.get(event.toolCallIndex) ?? `${fallbackToolKey(event.toolCallIndex, event.toolName)}_${++toolSequence}`;
              upsertTool(key, {
                name: event.toolName ?? t().unknown,
                status: 'error',
                output: event.content ?? t().unknownError,
              });
              toolOutputs.set(key, event.content ?? t().unknownError);
            } else {
              setState(prev => ({ ...prev, error: event.content ?? t().unknownError }));
            }
            break;

          case 'usage': {
            const addInput = typeof event.metadata?.input === 'number' ? event.metadata.input : 0;
            const addOutput = typeof event.metadata?.output === 'number' ? event.metadata.output : 0;
            const addCacheHit = typeof event.metadata?.cacheHit === 'number' ? event.metadata.cacheHit : 0;
            const addCacheMiss = typeof event.metadata?.cacheMiss === 'number' ? event.metadata.cacheMiss : 0;
            setState(prev => ({
              ...prev,
              tokens: {
                input: prev.tokens.input + addInput,
                output: prev.tokens.output + addOutput,
                cacheHit: prev.tokens.cacheHit + addCacheHit,
                cacheMiss: prev.tokens.cacheMiss + addCacheMiss,
              },
              contextUsage: addInput,
            }));
            break;
          }

          case 'warning':
            setState(prev => ({ ...prev, warnings: [...prev.warnings, event.content ?? t().unknownWarning] }));
            break;

          case 'status':
            if (event.metadata?.kind === 'instruction_injected') {
              const queueLen = typeof event.metadata.queueLength === 'number' ? event.metadata.queueLength : 0;
              setState(prev => ({ ...prev, pendingInstructionCount: queueLen }));
            } else if (event.content === 'thinking_mode_switch') {
              const to = event.metadata?.to as string;
              if (to) setState(prev => ({ ...prev, effectiveThinkingMode: to }));
            } else if (event.content === 'tools_completed') {
              finalizeRound();
              startRound();
            } else if (event.content === 'free_auto_route' && event.metadata) {
              const provider = event.metadata.provider as string;
              const model = event.metadata.model as string;
              const reason = event.metadata.reason as string;
              const attempt = event.metadata.attempt as number;
              setState(prev => ({
                ...prev,
                routedModel: `${provider}/${model}`,
                routedModelDetail: reason ? `(${reason})` : undefined,
              }));
            } else if (event.content && event.content !== 'interrupted') {
              setState(prev => ({ ...prev, warnings: [...prev.warnings, event.content!] }));
            }
            break;

          case 'permission_ask': {
            let args: Record<string, unknown> = {};
            try { args = JSON.parse(event.content ?? '{}'); } catch {}
            setState(prev => ({
              ...prev,
              permissionPrompt: { toolName: event.toolName ?? 'unknown', args },
            }));
            break;
          }

          case 'done':
          case 'strategy_notify':
          case 'strategy_estimate_refined':
          case 'tier_recommendation':
            break;

          default: {
            const _exhaustiveCheck: never = event.role;
            void _exhaustiveCheck;
          }
        }
      }
    } catch (e: unknown) {
      if (requestId === activeRequest) {
        const msg = e instanceof Error ? e.message : String(e);
        setState(prev => ({ ...prev, error: msg }));
      }
    } finally {
      if (requestId === activeRequest) {
        finalizeRound();
        setTUIState('idle');
        setState(prev => ({ ...prev, isLoading: false, permissionPrompt: null, reasoningActive: false }));
      }
      running = false;
      processQueue();
    }
  };

  const cancel = () => {
    engine.respondPermission(false);
    engine.interrupt();
    setState(prev => ({ ...prev, permissionPrompt: null }));
  };

  return { submit, cancel };
}
