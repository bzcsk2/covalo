import type { ChatMessage, ReasonixEngine, QuestionRequest, PermissionRequest, PermissionReply, LoopEvent } from '@covalo/core';

/**
 * SPEC S0-1: permission 请求来源角色。
 * - main: 单 engine 模式（无 dualRuntime）
 * - worker / supervisor: dualRuntime 模式下对应角色 engine 发起
 */
export type PermissionOriginRole = 'main' | 'worker' | 'supervisor';

/**
 * SPEC S0-1: TUI 层 permission prompt 扩展 originRole，
 * 用于定向 respondPermissionForRequest()，避免广播误消费。
 */
export interface TuiPermissionPrompt extends PermissionRequest {
  originRole: PermissionOriginRole;
}
import type { AgentRole } from '@covalo/core/agent-profile/types.js';
import type { WorkflowMode } from '@covalo/core/dual-agent-runtime/types.js';
import type { DualAgentRuntime } from '@covalo/core/dual-agent-runtime/dual-runtime.js';
import type { WorkflowCoordinator } from '@covalo/core/workflow-coordinator/coordinator.js';
import type { WorkflowEvent } from '@covalo/core/workflow-coordinator/types.js';
import type { EvalRunOptions, EvalRunProgress, EvalRunResult } from '@covalo/core';
import { PROVIDERS, resolveApiKey, getApiKeyEnvVar, resolveModelTarget, loadConfig, runEval as runCoreEval } from '@covalo/core';
import { setTUIState } from './App.js';
import { DeltaBatcher, resolveDeltaFlushMs } from './delta-batcher.js';
import { t } from './i18n/index.js';
import {
  isTranscriptStoreEnabled,
  isBridgeRuntimeSplitEnabled,
  TranscriptStore,
  TranscriptReader,
  transcriptToTimeline,
  BridgeRuntime,
} from './store/index.js';

const MAX_WARNINGS = 100;
const MAX_MESSAGE_QUEUE = 50;

function appendBoundedQueue(queue: string[], text: string): string[] {
  if (queue.length >= MAX_MESSAGE_QUEUE) {
    return [...queue.slice(1), text];
  }
  return [...queue, text];
}

/**
 * SPEC S1-1: 闭包级 submit 队列项。
 * 不再依赖 React state messageQueue 作为队列真源；messageQueue 仅作为 UI 镜像。
 */
interface QueuedSubmit {
  text: string
  isQueueResubmit: boolean
  role?: AgentRole
  mode: WorkflowMode
  options?: { displayText?: string; signal?: AbortSignal; observeInput?: boolean; collectFinalText?: boolean }
}

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
  | { id: string; kind: 'message'; message: ChatMessage; role?: AgentRole; turnId?: string }
  | { id: string; kind: 'assistant_text'; roundId: string; text: string; isStreaming: boolean; startTs: number; role?: AgentRole; turnId?: string }
  | { id: string; kind: 'reasoning'; roundId: string; text: string; isStreaming: boolean; startTs: number; role?: AgentRole; turnId?: string }
  | { id: string; kind: 'tool'; roundId: string; tool: ToolStatus; role?: AgentRole; turnId?: string };

export class WorkflowDriveError extends Error {
  workflowId?: string

  constructor(message: string, options?: { workflowId?: string; cause?: unknown }) {
    super(message)
    this.name = 'WorkflowDriveError'
    this.workflowId = options?.workflowId
    if (options?.cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}

export interface BridgeState {
  timeline: TimelineItem[];
  isLoading: boolean;
  messageQueue: string[];
  pendingInstructionCount: number;
  tokens: { input: number; output: number; cacheHit: number; cacheMiss: number };
  contextUsage: number;
  warnings: string[];
  error: string | null;
  permissionPrompt: TuiPermissionPrompt | null;
  questionPrompt: QuestionRequest | null;
  reasoningActive: boolean;
}

function historyRoundId(index: number): string {
  return `history-${index}-${crypto.randomUUID()}`;
}

export function timelineFromMessages(messages: ChatMessage[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  // SPEC S2-1 §7.4: 历史 session hydration 保守分组 ——
  // user message 开启新 turn group；assistant/tool 归入最近 user group；
  // 若无最近 group 则自成一组。裁剪时按 turn 整体保留/删除。
  let currentTurnId: string | null = null;
  messages.forEach((message, index) => {
    const id = `message-${index}-${crypto.randomUUID()}`;
    if (message.role === 'user') {
      // user message 开启新 turn group
      currentTurnId = `history-turn-${index}-${crypto.randomUUID()}`;
      items.push({ id, kind: 'message', message, turnId: currentTurnId });
      return;
    }
    if (message.role === 'assistant') {
      const roundId = historyRoundId(index);
      // 归入最近 user turn；若无则自成一组
      const turnId = currentTurnId ?? `history-turn-${index}-${crypto.randomUUID()}`;
      if (message.content) {
        items.push({
          id: `${id}-assistant`,
          kind: 'assistant_text',
          roundId,
          text: message.content,
          isStreaming: false,
          startTs: Date.now(),
          turnId,
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
          turnId,
        });
      }
      return;
    }
    // tool / system / other message：归入最近 user turn；若无则自成一组
    const turnId = currentTurnId ?? `history-turn-${index}-${crypto.randomUUID()}`;
    items.push({ id, kind: 'message', message, turnId });
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

function applyAssistantToTimeline(
  items: TimelineItem[],
  item: Extract<TimelineItem, { kind: 'assistant_text' }>,
): TimelineItem[] {
  const index = items.findIndex(existing => existing.id === item.id);
  if (index !== -1) {
    const next = [...items];
    next[index] = item;
    return next;
  }

  const firstTool = items.findIndex(existing =>
    'roundId' in existing
    && existing.roundId === item.roundId
    && existing.kind === 'tool',
  );
  if (firstTool === -1) return [...items, item];

  const next = [...items];
  next.splice(firstTool, 0, item);
  return next;
}

function applyReasoningToTimeline(
  items: TimelineItem[],
  item: Extract<TimelineItem, { kind: 'reasoning' }>,
): TimelineItem[] {
  const index = items.findIndex(existing => existing.id === item.id);
  if (index !== -1) {
    const next = [...items];
    next[index] = item;
    return next;
  }
  return [...items, item];
}

function isToolLoopNotice(message: string): boolean {
  return message.startsWith('Tool call loop detected:')
    || message.startsWith('Tool call loop stopped:')
    || message.startsWith('Stopped repeated tool-call loop:');
}

type TuiLoopPhase = 'observe' | 'plan' | 'act' | 'verify' | 'reflect' | 'retry' | 'paused' | 'done' | 'failed'

function workflowPhaseToLoopPhase(phase: string): TuiLoopPhase {
  switch (phase) {
    case 'idle':
      return 'observe'
    case 'supervisor_analyse':
      return 'plan'
    case 'worker_do':
      return 'act'
    case 'worker_report':
      return 'verify'
    case 'supervisor_check':
      return 'reflect'
    case 'supervisor_intervene':
      return 'retry'
    case 'waiting_user':
    case 'blocked':
      return 'paused'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return 'observe'
  }
}

export function createBridge(
  engine: ReasonixEngine,
  setState: React.Dispatch<React.SetStateAction<BridgeState>>,
  onUserInput?: (text: string) => void,
  beforeSubmit?: () => Promise<void>,
  orchestrationStore?: import('./store/orchestration-store.js').OrchestrationStore,
  dualRuntime?: DualAgentRuntime,
  workflowCoordinator?: WorkflowCoordinator,
): {
  submit: (text: string, isQueueResubmit?: boolean, role?: AgentRole, mode?: WorkflowMode) => Promise<void>;
  submitAndCollect: (
    text: string,
    role?: AgentRole,
    mode?: WorkflowMode,
    options?: { displayText?: string; signal?: AbortSignal; observeInput?: boolean },
  ) => Promise<string>;
  cancel: () => void;
  respondPermission: (requestId: string, originRole: PermissionOriginRole, reply: PermissionReply, message?: string) => void;
  respondQuestion: (requestId: string, answers: string[][]) => void;
  rejectQuestion: (requestId: string) => void;
  /** Run a workflow goal through the WorkflowCoordinator */
  runWorkflow: (goal: string, onPhaseChange?: (phase: string, iteration: number, finalStatus?: string, reason?: string) => void, workflowId?: string) => Promise<void>;
  /** Resume a workflow that was blocked by a user interrupt */
  resumeWorkflow: (instruction: string, onPhaseChange?: (phase: string, iteration: number, finalStatus?: string, reason?: string) => void) => Promise<void>;
  /** Add a user instruction for the next Supervisor analysis turn */
  addWorkflowInstruction: (instruction: string) => void;
  /** Store 路径下用 timeline 全量同步 transcript（session 恢复等） */
  replaceTranscript: (items: TimelineItem[]) => void;
  /** 追加一条消息到 transcript（系统提示 / 模型切换等） */
  appendTimelineMessage: (message: ChatMessage) => void;
  /** Store 路径下的 React 订阅 reader */
  getTranscriptReader: () => TranscriptReader | null;
  /** 拆分后的 bridge 运行时 store */
  getBridgeRuntime: () => BridgeRuntime | null;
  /** 重置拆分后的 bridge 运行时（session 切换） */
  resetBridgeRuntime: () => void;
  /** Run multi-model evaluation */
  runEval: (options: EvalRunOptions, currentWorkerConfig: { provider: string; model: string; baseUrl: string; apiKey: string }, onProgress?: (progress: EvalRunProgress) => void) => Promise<EvalRunResult>;
} {
  // SPEC S1-1: 闭包级调度状态。不再依赖 React state 作为队列真源。
  // - running: 是否有请求正在执行 submitInternalCore
  // - draining: 是否正在排空 submitQueue（避免新输入抢跑 drain 中的下一个 item）
  // - submitQueue: FIFO 真源；messageQueue (React state) 仅作为 UI 镜像
  let running = false;
  let draining = false;
  const submitQueue: QueuedSubmit[] = [];
  let activeRequest = 0;
  const transcriptStore = isTranscriptStoreEnabled() ? new TranscriptStore() : null;
  const transcriptReader = transcriptStore ? new TranscriptReader(transcriptStore) : null;
  const bridgeRuntime = isBridgeRuntimeSplitEnabled() ? new BridgeRuntime() : null;

  /**
   * 提交 bridge 状态变更；拆分模式下写入子 store 并跳过 React bridgeState 更新。
   * ADV-BUG-04: 副作用移出 updater，保持 updater 纯函数。
   */
  const commitBridge = (updater: (prev: BridgeState) => Partial<BridgeState>): void => {
    let patch: Partial<BridgeState> | undefined;
    setState(prev => {
      patch = updater(prev);
      if (bridgeRuntime && transcriptStore) {
        return prev;
      }
      return { ...prev, ...patch };
    });
    // ADV-BUG-04: 副作用在 updater 外执行，避免 React 严格模式 double-invoke
    if (bridgeRuntime && transcriptStore && patch) {
      bridgeRuntime.applyPatch(patch);
    }
  };

  const publishTimeline = (patch?: (prev: BridgeState) => Partial<BridgeState>) => {
    if (transcriptStore) {
      if (patch) commitBridge(patch);
      return;
    }

    if (patch) {
      commitBridge(patch);
      return;
    }

    commitBridge(() => ({}));
  };

  const hydrateStoreFromTimeline = (items: TimelineItem[]) => {
    if (!transcriptStore || !transcriptReader) return;
    transcriptStore.replaceAll(items);
    transcriptReader.invalidate();
  };

  const replaceTranscript = (items: TimelineItem[]) => {
    if (!transcriptStore) return;
    if (transcriptStore.hasLiveTouchedEntries()) {
      transcriptStore.mergeHydration(items);
    } else {
      hydrateStoreFromTimeline(items);
    }
    transcriptReader?.invalidate();
  };

  const appendTimelineMessage = (message: ChatMessage) => {
    if (transcriptStore) {
      transcriptStore.appendMessage(`message-${crypto.randomUUID()}`, message);
      return;
    }
    setState(prev => ({
      ...prev,
      timeline: [
        ...prev.timeline,
        { id: `message-${crypto.randomUUID()}`, kind: 'message', message },
      ],
    }));
  };

  const updateTimeline = (mutate: (items: TimelineItem[]) => TimelineItem[]) => {
    if (transcriptStore) {
      transcriptStore.replaceAll(mutate(transcriptStore.toTimelineItems()));
      transcriptReader?.invalidate();
      publishTimeline();
      return;
    }
    setState(prev => ({ ...prev, timeline: mutate(prev.timeline) }));
  };

  const clearToolLoopNotices = () => {
    commitBridge(prev => {
      const warnings = prev.warnings.filter(warning => !isToolLoopNotice(warning));
      const error = prev.error && isToolLoopNotice(prev.error) ? null : prev.error;
      if (warnings.length === prev.warnings.length && error === prev.error) return {};
      return { warnings, error };
    });
  };

  const upsertItem = (item: TimelineItem, update?: (existing: TimelineItem) => TimelineItem) => {
    if (transcriptStore) {
      transcriptStore.upsertItem(item, update);
      publishTimeline();
      return;
    }
    updateTimeline(items => {
      const index = items.findIndex(existing => existing.id === item.id);
      if (index === -1) return [...items, item];
      const next = [...items];
      next[index] = update ? update(next[index]!) : item;
      return next;
    });
  };

  const upsertAssistantText = (item: Extract<TimelineItem, { kind: 'assistant_text' }>) => {
    if (transcriptStore) {
      transcriptStore.upsertAssistantText(item);
      publishTimeline();
      return;
    }
    updateTimeline(items => applyAssistantToTimeline(items, item));
  };

  /**
   * SPEC S1-1 + S2-3: 闭包级 submit 队列调度。
   *
   * 替代旧 processQueue() —— 旧实现依赖 React setState updater 内部给外部变量赋值
   * (nextMessage) 抽取队列项，并使用 setTimeout(...,0) 延迟 submit，导致 running=false
   * 与实际 submit 之间存在新输入抢跑窗口。
   *
   * 新实现：
   * - submitQueue 作为 FIFO 真源（不依赖 React state.messageQueue）
   * - running/draining 双标志，避免 drain 中新输入抢跑
   * - drainQueue 使用 queueMicrotask（无 setTimeout 窗口）
   * - mid-session instruction 在 enqueueOrRun 中处理，不进入 submitInternalCore 的 running 分支
   */

  /**
   * 将闭包级 submitQueue 镜像到 React state.messageQueue，仅用于 UI 显示。
   * SPEC S1-1 §4.2.5: UI messageQueue/pendingInstructionCount 只是状态展示。
   */
  const mirrorQueueState = () => {
    const snapshot = submitQueue.map(item => item.text);
    commitBridge(() => ({ messageQueue: snapshot }));
  };

  /**
   * 入口：决定立即执行还是入队。
   * - running=true 时：尝试 engine.enqueueInstruction (mid-session)；成功则不入队
   * - running/draining=true 时 engine 不可用：进入 bridge FIFO
   * - 否则：立即 runExclusive
   */
  const enqueueOrRun = (item: QueuedSubmit): Promise<void> => {
    if (running || draining) {
      // running 状态下尝试让 engine 处理为 mid-session instruction
      if (running && !draining) {
        const result = engine.enqueueInstruction(item.text);
        if (result.status === 'ignored') return Promise.resolve();
        // P0-2: Observe on first successful acceptance
        if (!item.isQueueResubmit && item.options?.observeInput !== false) {
          onUserInput?.(item.text);
        }
        if (result.status === 'queued') {
          commitBridge(() => ({ pendingInstructionCount: result.queueLength }));
          return Promise.resolve();
        }
        // 'full' → engine 内部队列已满，更新 pendingInstructionCount 后入 bridge FIFO
        if (result.status === 'full') {
          commitBridge(() => ({ pendingInstructionCount: result.queueLength }));
        }
        // 'full' 或 'idle' → 进入 bridge FIFO
      }
      submitQueue.push(item);
      if (submitQueue.length > MAX_MESSAGE_QUEUE) submitQueue.shift();
      mirrorQueueState();
      return Promise.resolve();
    }
    return runExclusive(item);
  };

  /**
   * 串行执行单个 submit。running=true 期间不允许其它 submit 并行。
   * 完成后清空 running 并触发 drainQueue 排空剩余队列。
   */
  const runExclusive = async (item: QueuedSubmit): Promise<void> => {
    if (running) {
      submitQueue.push(item);
      if (submitQueue.length > MAX_MESSAGE_QUEUE) submitQueue.shift();
      mirrorQueueState();
      return;
    }
    running = true;
    try {
      await submitInternalCore(item);
    } finally {
      running = false;
      drainQueue();
    }
  };

  /**
   * 排空 submitQueue。使用 queueMicrotask 而非 setTimeout，避免抢跑窗口。
   * draining 标志防止 drain 中新输入再次触发 drain。
   */
  const drainQueue = (): void => {
    if (running || draining) return;
    draining = true;
    queueMicrotask(async () => {
      try {
        while (!running && submitQueue.length > 0) {
          const next = submitQueue.shift()!;
          mirrorQueueState();
          await runExclusive(next);
        }
      } finally {
        draining = false;
        // 队列在 drain 期间可能再次被填充，递归触发
        if (!running && submitQueue.length > 0) drainQueue();
      }
    });
  };

  /**
   * SPEC S1-1: submitInternalCore 接收 QueuedSubmit 而非散乱参数。
   * - 不再处理 running 分支（mid-session instruction 已在 enqueueOrRun 中处理）
   * - 不再原地 running=true（由 runExclusive 控制）
   */
  const submitInternalCore = async (item: QueuedSubmit): Promise<string> => {
    const { text, isQueueResubmit, role, mode, options } = item;

    // P0-2: Observe fresh user input (not queue re-submissions)
    if (!isQueueResubmit && options?.observeInput !== false) {
      onUserInput?.(text);
    }

    const requestId = ++activeRequest;
    const submitRole: AgentRole | undefined = role;
    const displayedText = options?.displayText ?? text;
    let activeOutputRole: AgentRole | undefined = submitRole;
    // SPEC S2-1: 本次 submit 的 turnId，关联 user message + assistant/reasoning/tool，
    // 让 TranscriptStore 裁剪时按完整 turn 整体保留/删除。
    const submitTurnId = `submit-turn-${requestId}-${crypto.randomUUID()}`;
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
    let assistantStartTs = 0;
    let reasoningStartTs = 0;

    const flushStreamingUI = () => {
      if (transcriptStore) {
        publishTimeline(prev => ({
          reasoningActive: reasoningId && reasoningText ? true : prev.reasoningActive,
        }));
        return;
      }

      setState(prev => {
        let timeline = prev.timeline;
        let reasoningActive = prev.reasoningActive;

        if (assistantId && assistantText) {
          timeline = applyAssistantToTimeline(timeline, {
            id: assistantId,
            kind: 'assistant_text',
            roundId,
            text: assistantText,
            isStreaming: true,
            startTs: assistantStartTs,
            role: activeOutputRole,
            turnId: submitTurnId,
          });
        }

        if (reasoningId && reasoningText) {
          reasoningActive = true;
          timeline = applyReasoningToTimeline(timeline, {
            id: reasoningId,
            kind: 'reasoning',
            roundId,
            text: reasoningText,
            isStreaming: true,
            startTs: reasoningStartTs,
            role: activeOutputRole,
            turnId: submitTurnId,
          });
        }

        if (timeline === prev.timeline && reasoningActive === prev.reasoningActive) {
          return prev;
        }
        const patch = { timeline, reasoningActive };
        bridgeRuntime?.applyPatch(patch);
        return { ...prev, ...patch };
      });
    };

    const streamBatcher = new DeltaBatcher(resolveDeltaFlushMs(), flushStreamingUI);

    const startRound = () => {
      streamBatcher.cancel();
      roundNumber += 1;
      roundId = `turn-${requestId}-round-${roundNumber}-${crypto.randomUUID()}`;
      assistantId = null;
      reasoningId = null;
      assistantText = '';
      reasoningText = '';
      assistantStartTs = 0;
      reasoningStartTs = 0;
      toolCallArgs.clear();
      activeToolKeys.clear();
      toolItemIds.clear();
      toolOutputs.clear();
      toolSequence = 0;
    };

    const finalizeRound = () => {
      streamBatcher.flushNow();
      if (assistantId) {
        const id = assistantId;
        if (transcriptStore) {
          if (assistantText) {
            transcriptStore.ensureTextPart(id, 'assistant_text', roundId, assistantStartTs || Date.now(), activeOutputRole, submitTurnId);
            transcriptStore.setTextPart(id, assistantText, false);
          }
          transcriptStore.finalizePart(id);
        } else {
          upsertItem({
            id,
            kind: 'assistant_text',
            roundId,
            text: assistantText,
            isStreaming: false,
            startTs: assistantStartTs || Date.now(),
            role: activeOutputRole,
            turnId: submitTurnId,
          }, existing => existing.kind === 'assistant_text'
            ? { ...existing, text: assistantText, isStreaming: false }
            : existing);
        }
      }
      if (reasoningId) {
        const id = reasoningId;
        if (transcriptStore) {
          if (reasoningText) {
            transcriptStore.ensureTextPart(id, 'reasoning', roundId, reasoningStartTs || Date.now(), activeOutputRole, submitTurnId);
            transcriptStore.setTextPart(id, reasoningText, false);
          }
          transcriptStore.finalizePart(id);
        } else {
          upsertItem({
            id,
            kind: 'reasoning',
            roundId,
            text: reasoningText,
            isStreaming: false,
            startTs: reasoningStartTs || Date.now(),
            role: activeOutputRole,
            turnId: submitTurnId,
          }, existing => existing.kind === 'reasoning'
            ? { ...existing, text: reasoningText, isStreaming: false }
            : existing);
        }
      }
      if (transcriptStore) publishTimeline();
    };

    const ensureAssistant = () => {
      if (!assistantId) {
        assistantId = `${roundId}-assistant`;
        assistantStartTs = Date.now();
      }
      return assistantId;
    };

    const ensureReasoning = () => {
      if (!reasoningId) {
        reasoningId = `${roundId}-reasoning`;
        reasoningStartTs = Date.now();
      }
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
      const mergedTool = { ...fallback, ...cleanPatch };

      if (transcriptStore) {
        transcriptStore.upsertTool(itemId, roundId, mergedTool, existing => ({
          ...existing,
          ...cleanPatch,
          elapsedMs: patch.elapsedMs ?? (patch.status && patch.status !== 'running'
            ? now - existing.startedAt
            : existing.elapsedMs),
        }), activeOutputRole, submitTurnId);
        publishTimeline();
        return;
      }

      upsertItem({
        id: itemId,
        kind: 'tool',
        roundId,
        tool: mergedTool,
        role: activeOutputRole,
        turnId: submitTurnId,
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
    setState(prev => {
      const userItem: TimelineItem = {
        id: `user-${requestId}-${crypto.randomUUID()}`,
        kind: 'message',
        message: { role: 'user', content: displayedText },
        role: submitRole,
        turnId: submitTurnId,
      };

      if (transcriptStore) {
        if (transcriptStore.getEntryCount() === 0 && prev.timeline.length > 0) {
          hydrateStoreFromTimeline(prev.timeline);
        }
        transcriptStore.appendUser(userItem.id, displayedText, submitRole, submitTurnId);
        bridgeRuntime?.applyPatch({
          isLoading: true,
          error: null,
          warnings: [],
          permissionPrompt: null,
        });
        return bridgeRuntime ? prev : {
          ...prev,
          isLoading: true,
          error: null,
          warnings: [],
          permissionPrompt: null,
        };
      }

      return {
        ...prev,
        isLoading: true,
        error: null,
        warnings: [],
        permissionPrompt: null,
        timeline: [...prev.timeline, userItem],
      };
    });

    let abortHandler: (() => void) | undefined;
    try {
      await beforeSubmit?.();
      // WF-FIX-10: Route through DualAgentRuntime when available
      abortHandler = () => {
        if (dualRuntime && submitRole) {
          dualRuntime.interruptRole(submitRole);
        } else {
          engine.interrupt();
        }
      };
      options?.signal?.addEventListener('abort', abortHandler);
      const eventStream = dualRuntime && submitRole
        ? dualRuntime.sendDirect({ role: submitRole, input: text, mode })
        : engine.submit(text, undefined, submitRole, mode);
      for await (const event of eventStream) {
        if (requestId !== activeRequest) continue;
        if (options?.signal?.aborted) {
          break;
        }
        const eventRole = event.metadata?.agentRole === 'worker' || event.metadata?.agentRole === 'supervisor'
          ? event.metadata.agentRole as AgentRole
          : submitRole;
        if (eventRole !== activeOutputRole) {
          finalizeRound();
          activeOutputRole = eventRole;
          startRound();
        }

        switch (event.role) {
          case 'assistant_delta': {
            const chunk = event.content ?? '';
            assistantText += chunk;
            const id = ensureAssistant();
            if (transcriptStore) {
              transcriptStore.ensureTextPart(id, 'assistant_text', roundId, assistantStartTs, activeOutputRole, submitTurnId);
              transcriptStore.appendPartDelta(id, chunk);
              streamBatcher.schedule();
            } else {
              streamBatcher.schedule();
            }
            break;
          }

          case 'assistant_final': {
            streamBatcher.flushNow();
            if (event.content) assistantText = event.content;
            const metadataReasoning = event.metadata?.reasoning;
            if (typeof metadataReasoning === 'string' && metadataReasoning.length > 0) {
              reasoningText = metadataReasoning;
            }
            if (assistantText) {
              const id = ensureAssistant();
              if (transcriptStore) {
                transcriptStore.ensureTextPart(id, 'assistant_text', roundId, assistantStartTs || Date.now(), activeOutputRole, submitTurnId);
                transcriptStore.setTextPart(id, assistantText, false);
              } else {
                upsertAssistantText({
                  id,
                  kind: 'assistant_text',
                  roundId,
                  text: assistantText,
                  isStreaming: false,
                  startTs: assistantStartTs || Date.now(),
                  role: activeOutputRole,
                  turnId: submitTurnId,
                });
              }
            }
            if (reasoningText) {
              const id = ensureReasoning();
              const item = {
                id,
                kind: 'reasoning' as const,
                roundId,
                text: reasoningText,
                isStreaming: false,
                startTs: reasoningStartTs || Date.now(),
                role: activeOutputRole,
                turnId: submitTurnId,
              };
              if (transcriptStore) {
                transcriptStore.upsertReasoning(item);
              } else {
                upsertItem(item);
              }
            }
            if (transcriptStore) publishTimeline();
            break;
          }

          case 'reasoning_delta': {
            clearToolLoopNotices();
            const chunk = event.content ?? '';
            reasoningText += chunk;
            const id = ensureReasoning();
            if (transcriptStore) {
              transcriptStore.ensureTextPart(id, 'reasoning', roundId, reasoningStartTs, activeOutputRole, submitTurnId);
              transcriptStore.appendPartDelta(id, chunk);
              streamBatcher.schedule();
            } else {
              upsertItem({
                id,
                kind: 'reasoning',
                roundId,
                text: reasoningText,
                isStreaming: true,
                startTs: reasoningStartTs,
                role: activeOutputRole,
                turnId: submitTurnId,
              });
              commitBridge(() => ({ reasoningActive: true }));
            }
            break;
          }

          case 'tool_call_delta':
            clearToolLoopNotices();
            if (event.toolCallIndex !== undefined && event.content) {
              toolCallArgs.set(event.toolCallIndex, event.content);
            }
            break;

          case 'tool_start': {
            clearToolLoopNotices();
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
            clearToolLoopNotices();
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
              const errorText = event.content ?? t().unknownError;
              if (!isToolLoopNotice(errorText) && event.metadata?.reason !== 'toolCallLoop') {
                commitBridge(() => ({ error: errorText }));
              }
            }
            break;

          case 'usage': {
            const addInput = typeof event.metadata?.input === 'number' ? event.metadata.input : 0;
            const addOutput = typeof event.metadata?.output === 'number' ? event.metadata.output : 0;
            const addCacheHit = typeof event.metadata?.cacheHit === 'number' ? event.metadata.cacheHit : 0;
            const addCacheMiss = typeof event.metadata?.cacheMiss === 'number' ? event.metadata.cacheMiss : 0;
            commitBridge(prev => ({
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

          case 'warning': {
            const warning = event.content ?? t().unknownWarning;
            if (isToolLoopNotice(warning)) break;
            commitBridge(prev => ({
              warnings: [...prev.warnings, warning].slice(-MAX_WARNINGS),
            }));
            break;
          }

          case 'status':
            if (event.metadata?.kind === 'instruction_injected') {
              const queueLen = typeof event.metadata.queueLength === 'number' ? event.metadata.queueLength : 0;
              commitBridge(() => ({ pendingInstructionCount: queueLen }));
            } else if (event.content === 'tools_completed') {
              finalizeRound();
              startRound();
            }
            break;

          case 'permission_ask': {
            // SPEC S0-1: 推断 originRole 用于定向 respondPermissionForRequest()
            const originRole: PermissionOriginRole = dualRuntime
              ? (activeOutputRole === 'supervisor' ? 'supervisor' : 'worker')
              : 'main';
            // Parse permission request from event metadata
            const requestId = event.metadata?.requestId as string | undefined;
            const sessionId = event.metadata?.sessionId as string | undefined;
            const permission = event.metadata?.permission as string | undefined;
            const patterns = event.metadata?.patterns as string[] | undefined;
            const always = event.metadata?.always as string[] | undefined;
            const metadata = event.metadata?.metadata as Record<string, unknown> | undefined;
            const tool = event.metadata?.tool as { toolCallId: string; toolName: string } | undefined;
            const parentSessionId = event.metadata?.parentSessionId as string | undefined;

            if (requestId && sessionId && permission) {
              const permissionRequest: TuiPermissionPrompt = {
                id: requestId,
                sessionId,
                permission,
                patterns: patterns ?? [],
                always: always ?? [],
                metadata: metadata ?? {},
                tool: tool ?? { toolCallId: '', toolName: event.toolName ?? 'unknown' },
                parentSessionId,
                originRole,
              };
              commitBridge(() => ({ permissionPrompt: permissionRequest }));
            } else {
              // Fallback for legacy permission events (无 requestId)
              let args: Record<string, unknown> = {};
              try { args = JSON.parse(event.content ?? '{}'); } catch {}
              const fallbackRequest: TuiPermissionPrompt = {
                id: `perm_${Date.now().toString(36)}`,
                sessionId: '',
                permission: event.toolName ?? 'unknown',
                patterns: [],
                always: [],
                metadata: args,
                tool: { toolCallId: '', toolName: event.toolName ?? 'unknown' },
                originRole,
              };
              commitBridge(() => ({ permissionPrompt: fallbackRequest }));
            }
            break;
          }

          case 'question_ask': {
            // Parse question request from event metadata
            const requestId = event.metadata?.requestId as string | undefined;
            const sessionId = event.metadata?.sessionId as string | undefined;
            const questions = event.metadata?.questions as Array<{
              question: string;
              header: string;
              options: Array<{ label: string; description: string }>;
              multiple?: boolean;
              custom?: boolean;
            }> | undefined;
            if (requestId && sessionId && questions) {
              const questionRequest: QuestionRequest = { id: requestId, sessionId, questions };
              commitBridge(() => ({ questionPrompt: questionRequest }));
            }
            break;
          }

          case 'question_replied': {
            commitBridge(() => ({ questionPrompt: null }));
            break;
          }

          case 'question_rejected': {
            commitBridge(() => ({ questionPrompt: null }));
            break;
          }

          case 'done':
            break;

          case 'orchestration':
            if (event.orchestration && orchestrationStore) {
              orchestrationStore.apply(event.orchestration);
            }
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
        commitBridge(() => ({ error: msg }));
      }
    } finally {
      if (abortHandler) {
        options?.signal?.removeEventListener('abort', abortHandler);
      }
      if (requestId === activeRequest) {
        streamBatcher.flushNow();
        finalizeRound();
        setTUIState('idle');
        commitBridge(() => ({
          isLoading: false,
          permissionPrompt: null,
          reasoningActive: false,
        }));
      }
      // SPEC S1-1: running 标志由 runExclusive 在 finally 中重置；这里只触发 drainQueue
    }
    return assistantText.trim();
  };

  /**
   * SPEC S1-1: submit 入口 —— 通过 enqueueOrRun 调度，不再直接调用 submitInternalCore。
   * 这确保 running/draining 期间的新输入会被正确排队而非抢跑。
   */
  const submit = async (text: string, isQueueResubmit = false, role?: AgentRole, mode: WorkflowMode = 'alone') => {
    await enqueueOrRun({ text, isQueueResubmit, role, mode });
  };

  const submitAndCollect = async (
    text: string,
    role?: AgentRole,
    mode: WorkflowMode = 'alone',
    options?: { displayText?: string; signal?: AbortSignal; observeInput?: boolean },
  ): Promise<string> => {
    // SPEC S1-1: submitAndCollect 用于 dualRuntime 子 engine 输出收集，不走 bridge 队列，
    // 直接调用 submitInternalCore（不经过 enqueueOrRun）
    return submitInternalCore({ text, isQueueResubmit: false, role, mode, options: { ...options, collectFinalText: true } });
  };

  const cancel = () => {
    // Reject any pending permission
    commitBridge(prev => {
      if (prev.permissionPrompt) {
        engine.respondPermission(false);
      }
      if (prev.questionPrompt) {
        engine.rejectQuestion(prev.questionPrompt.id);
      }
      return { permissionPrompt: null, questionPrompt: null };
    });
    // Abort running eval if any
    evalAbortController?.abort();
    evalAbortController = null;
    // WF-FIX-10: Interrupt both roles when DualAgentRuntime is active
    if (dualRuntime) {
      dualRuntime.getWorker().getEngine().respondPermission(false);
      dualRuntime.getSupervisor().getEngine().respondPermission(false);
      dualRuntime.interruptRole('worker');
      dualRuntime.interruptRole('supervisor');
    }
    // SFR-70: 中断正在运行的 Workflow
    workflowCoordinator?.interrupt();
    engine.interrupt();
    // SPEC S1-1: 清空闭包级 submitQueue 并镜像到 UI（cancel 视为放弃所有 pending 输入）
    submitQueue.length = 0;
    mirrorQueueState();
  };

  /**
   * SPEC S0-1: 定向响应权限请求。
   * - 根据 originRole 路由到发起请求的 engine，避免广播误消费。
   * - 仅当 dualRuntime 不存在时（legacy 单 engine 模式），fallback 到 engine.respondPermission()。
   * - dualRuntime 存在但未匹配到 pending 时，记录 warning 但不广播。
   */
  const respondPermission = (requestId: string, originRole: PermissionOriginRole, reply: PermissionReply, _message?: string) => {
    const allow = reply === 'once' || reply === 'always';
    const alwaysAllow = reply === 'always';
    let handled = false;
    switch (originRole) {
      case 'worker':
        handled = dualRuntime?.getWorker().getEngine().respondPermissionForRequest(requestId, allow, alwaysAllow) ?? false;
        break;
      case 'supervisor':
        handled = dualRuntime?.getSupervisor().getEngine().respondPermissionForRequest(requestId, allow, alwaysAllow) ?? false;
        break;
      case 'main':
      default:
        if (!dualRuntime) {
          // Legacy 单 engine 模式：fallback 到 respondPermission，消费任意 pending
          engine.respondPermission(allow, alwaysAllow);
          handled = true;
        } else {
          handled = engine.respondPermissionForRequest(requestId, allow, alwaysAllow);
        }
        break;
    }
    if (!handled && dualRuntime) {
      // SPEC S0-1: dualRuntime 存在但未匹配到 pending — 不广播，记录 warning
      // （理论上 cancel 已经清理，这里只是防御性日志）
      // eslint-disable-next-line no-console
      console.warn(`[bridge] respondPermission: no pending permission found for requestId=${requestId} originRole=${originRole}`);
    }
    commitBridge(() => ({ permissionPrompt: null }));
  };

  const respondQuestion = (requestId: string, answers: string[][]) => {
    engine.respondQuestion(requestId, answers);
    dualRuntime?.getWorker().getEngine().respondQuestion(requestId, answers);
    dualRuntime?.getSupervisor().getEngine().respondQuestion(requestId, answers);
    // WF-1: 同时转发给 workflowCoordinator，回复 supervisor 的 ask_user 问题
    workflowCoordinator?.replyWorkflowQuestion(requestId, answers);
    commitBridge(() => ({ questionPrompt: null }));
  };

  const rejectQuestion = (requestId: string) => {
    engine.rejectQuestion(requestId);
    dualRuntime?.getWorker().getEngine().rejectQuestion(requestId);
    dualRuntime?.getSupervisor().getEngine().rejectQuestion(requestId);
    // WF-1: 同时转发给 workflowCoordinator
    workflowCoordinator?.rejectWorkflowQuestion(requestId);
    commitBridge(() => ({ questionPrompt: null }));
  };

  /** WF-FIX-20: Run a workflow goal through the WorkflowCoordinator */
  const driveWorkflow = async (
    goal: string | null,
    onPhaseChange?: (phase: string, iteration: number, finalStatus?: string, reason?: string) => void,
    resumeInstruction?: string,
    workflowId?: string,
  ) => {
    if (!workflowCoordinator) {
      await submit(resumeInstruction ?? goal ?? '', false, 'supervisor');
      return;
    }

    // SFR-70: 标记 loading 使 Ctrl+C 能取消 Workflow
    setTUIState('loading');
    commitBridge(() => ({
      isLoading: true,
      error: null,
      warnings: [],
      permissionPrompt: null,
    }));

    let activeRole: AgentRole = 'supervisor';
    let wfPhaseId = '';
    let wfPhaseTs = 0;
    let wfTurnSeq = 0;
    let wfTurnId = '';
    let wfTurnTs = 0;
    let wfAssistantId: string | null = null;
    let wfReasoningId: string | null = null;
    let toolItemIds = new Map<string, string>();
    let toolCallArgs = new Map<number, string>();
    let toolOutputs = new Map<string, string>();
    // SPEC S1-3: workflow tool item key 稳定化状态。
    // - wfToolSequence: 同一 workflow turn 内的工具递增计数，保证每个 tool_start 生成唯一 key
    // - wfActiveToolKeys: toolCallIndex → key，用于 progress/tool 事件回到对应 item
    // - wfFallbackToolNameKeys: toolName → keys[]，用于无 toolCallIndex 时的回退查找
    // - wfToolStatusByKey: key → status，用于 resolveWorkflowToolKey 优先选择 running 的同名 key
    let wfToolSequence = 0;
    let wfActiveToolKeys = new Map<number, string>();
    let wfFallbackToolNameKeys = new Map<string, string[]>();
    let wfToolStatusByKey = new Map<string, ToolStatus['status']>();
    let assistantText = '';
    let reasoningText = '';

    /**
     * SPEC S1-2: workflow delta batching flush 实现。
     * - 只在 batcher 触发时写入 transcriptStore / upsertWorkflowItem
     * - 避免 workflow 模式下每个 delta chunk 触发 publishTimeline() 导致 UI 卡顿
     */
    const flushWorkflowStreamingUI = () => {
      if (!wfTurnId) return;

      if (wfAssistantId && assistantText) {
        if (transcriptStore) {
          transcriptStore.ensureTextPart(wfAssistantId, 'assistant_text', wfTurnId, wfTurnTs, activeRole, wfTurnId);
          transcriptStore.setTextPart(wfAssistantId, assistantText, true);
          publishTimeline();
        } else {
          upsertWorkflowItem({ id: wfAssistantId, kind: 'assistant_text', roundId: wfTurnId, text: assistantText, isStreaming: true, startTs: wfTurnTs, role: activeRole, turnId: wfTurnId });
        }
      }

      if (wfReasoningId && reasoningText) {
        if (transcriptStore) {
          transcriptStore.ensureTextPart(wfReasoningId, 'reasoning', wfTurnId, wfTurnTs, activeRole, wfTurnId);
          transcriptStore.setTextPart(wfReasoningId, reasoningText, true);
          publishTimeline();
        } else {
          upsertWorkflowItem({ id: wfReasoningId, kind: 'reasoning', roundId: wfTurnId, text: reasoningText, isStreaming: true, startTs: wfTurnTs, role: activeRole, turnId: wfTurnId });
        }
      }
    };

    // SPEC S1-2: workflow delta batcher，节流 assistant_delta / reasoning_delta 的 UI 刷新
    const workflowBatcher = new DeltaBatcher(resolveDeltaFlushMs(), flushWorkflowStreamingUI);

    const startWorkflowTurn = () => {
      // SPEC S1-2: 注意 —— 不在此处调 workflowBatcher.flushNow()。
      // 所有调用 startWorkflowTurn 的地方（phase_change / tools_completed / finally）
      // 都已先 flushNow()，再 finalizeWorkflowTurn()，再 startWorkflowTurn()。
      // 此处若再 flushNow，会因 activeRole 已切换而把旧 turn 的 delta 写入新 role。
      wfTurnSeq += 1;
      wfTurnId = `${wfPhaseId}-turn-${wfTurnSeq}-${crypto.randomUUID()}`;
      wfTurnTs = Date.now();
      wfAssistantId = null;
      wfReasoningId = null;
      assistantText = '';
      reasoningText = '';
      toolItemIds = new Map<string, string>();
      toolCallArgs = new Map<number, string>();
      toolOutputs = new Map<string, string>();
      // SPEC S1-3: 重置 workflow tool key 状态，确保新 turn 内的 key 不串到旧 turn
      wfToolSequence = 0;
      wfActiveToolKeys = new Map<number, string>();
      wfFallbackToolNameKeys = new Map<string, string[]>();
      wfToolStatusByKey = new Map<string, ToolStatus['status']>();
    };

    const startWorkflowPhase = () => {
      wfPhaseId = `wf-phase-${crypto.randomUUID()}`;
      wfPhaseTs = Date.now();
      wfTurnSeq = 0;
      startWorkflowTurn();
    };

    const ensureWorkflowTurn = () => {
      if (!wfPhaseId) {
        wfPhaseId = `wf-phase-${crypto.randomUUID()}`;
        wfPhaseTs = Date.now();
        wfTurnSeq = 0;
      }
      if (!wfTurnId) {
        startWorkflowTurn();
      }
    };

    const ensureWorkflowAssistantId = () => {
      ensureWorkflowTurn();
      if (!wfAssistantId) {
        wfAssistantId = `${wfTurnId}-assistant`;
      }
      return wfAssistantId;
    };

    const ensureWorkflowReasoningId = () => {
      ensureWorkflowTurn();
      if (!wfReasoningId) {
        wfReasoningId = `${wfTurnId}-reasoning`;
      }
      return wfReasoningId;
    };

    /**
     * SPEC S1-3: 为 tool_start 生成唯一 key 并登记到 wfActiveToolKeys / wfFallbackToolNameKeys。
     * 同一 workflow turn 内每个 tool_start 都得到独立 key，避免同名工具覆盖 UI item。
     */
    const registerWorkflowToolStart = (index: number | undefined, name: string | undefined): string => {
      const base = fallbackToolKey(index, name);
      const key = `${base}_${++wfToolSequence}`;
      if (index !== undefined) {
        wfActiveToolKeys.set(index, key);
      } else {
        const toolName = name ?? 'unknown';
        const list = wfFallbackToolNameKeys.get(toolName) ?? [];
        list.push(key);
        wfFallbackToolNameKeys.set(toolName, list);
      }
      return key;
    };

    /**
     * SPEC S1-3: 由 progress / tool 事件回查对应的 key。
     * - 有 toolCallIndex → 查 wfActiveToolKeys
     * - 无 toolCallIndex → 查 wfFallbackToolNameKeys，优先返回最近一个 status === 'running' 的同名 key；
     *   若无 running 则返回最新一个 key（避免把已完成工具误更新）
     */
    const resolveWorkflowToolKey = (index: number | undefined, name: string | undefined): string => {
      if (index !== undefined) {
        return wfActiveToolKeys.get(index) ?? fallbackToolKey(index, name);
      }
      const toolName = name ?? 'unknown';
      const list = wfFallbackToolNameKeys.get(toolName);
      if (!list || list.length === 0) return fallbackToolKey(undefined, name);
      // 优先选择最近一个 running 的 key；否则回退到最后一个（最近登记的）
      for (let i = list.length - 1; i >= 0; i--) {
        const candidateKey = list[i]!;
        if (wfToolStatusByKey.get(candidateKey) === 'running') {
          return candidateKey;
        }
      }
      return list[list.length - 1]!;
    };

    const upsertWorkflowTextItem = (
      item: TimelineItem & { kind: 'assistant_text' | 'reasoning' },
    ) => {
      if (transcriptStore) {
        if (item.kind === 'assistant_text') {
          transcriptStore.upsertAssistantText(item);
        } else {
          transcriptStore.upsertReasoning(item);
        }
        publishTimeline();
        return;
      }
      upsertWorkflowItem(item);
    };

    const finalizeWorkflowTurn = () => {
      if (!wfTurnId) return;

      if (wfAssistantId) {
        if (assistantText) {
          upsertWorkflowTextItem({
            id: wfAssistantId,
            kind: 'assistant_text',
            roundId: wfTurnId,
            text: assistantText,
            isStreaming: false,
            startTs: wfTurnTs,
            role: activeRole,
            turnId: wfTurnId,
          });
        } else if (transcriptStore) {
          transcriptStore.finalizePart(wfAssistantId);
          publishTimeline();
        }
      }

      if (wfReasoningId) {
        if (reasoningText) {
          upsertWorkflowTextItem({
            id: wfReasoningId,
            kind: 'reasoning',
            roundId: wfTurnId,
            text: reasoningText,
            isStreaming: false,
            startTs: wfTurnTs,
            role: activeRole,
            turnId: wfTurnId,
          });
        } else if (transcriptStore) {
          transcriptStore.finalizePart(wfReasoningId);
          publishTimeline();
        }
      }
    };

    const upsertWorkflowItem = (item: TimelineItem) => {
      commitBridge(prev => {
        const index = prev.timeline.findIndex(existing => existing.id === item.id);
        if (index === -1) return { timeline: [...prev.timeline, item] };
        const timeline = [...prev.timeline];
        timeline[index] = item;
        return { timeline };
      });
    };

    const upsertWorkflowTool = (key: string, patch: Partial<ToolStatus>) => {
      const itemId = toolItemIds.get(key) ?? `wf-${key}-${crypto.randomUUID()}`;
      toolItemIds.set(key, itemId);
      const tool: ToolStatus = {
        key,
        name: patch.name ?? key.replace(/_\d+$/, ''),
        status: patch.status ?? 'running',
        args: patch.args ?? {},
        output: patch.output ?? '',
        startedAt: patch.startedAt ?? Date.now(),
        elapsedMs: patch.elapsedMs,
      };
      // SPEC S1-3: 维护 key → status 映射，供 resolveWorkflowToolKey 优先选择 running 同名 key。
      // 仅在 patch.status 显式存在时更新，避免 output-only patch 把已 done 的工具重置为 running。
      if (patch.status) wfToolStatusByKey.set(key, patch.status);
      else if (!wfToolStatusByKey.has(key)) wfToolStatusByKey.set(key, tool.status);
      if (transcriptStore) {
        transcriptStore.upsertTool(itemId, wfTurnId, tool, current => ({ ...current, ...patch }), activeRole, wfTurnId);
        publishTimeline();
      } else {
        commitBridge(prev => {
          const current = prev.timeline.find(item => item.id === itemId);
          const merged = current?.kind === 'tool' ? { ...current.tool, ...patch } : tool;
          const item: TimelineItem = { id: itemId, kind: 'tool', roundId: wfTurnId, tool: merged, role: activeRole, turnId: wfTurnId };
          const index = prev.timeline.findIndex(entry => entry.id === itemId);
          if (index === -1) return { timeline: [...prev.timeline, item] };
          const timeline = [...prev.timeline];
          timeline[index] = item;
          return { timeline };
        });
      }
    };

    try {
      if (resumeInstruction !== undefined) {
        workflowCoordinator.resumeBlockedWorkflow(resumeInstruction)
      } else {
        if (workflowCoordinator.getState()) {
          workflowCoordinator.reset();
        }
        workflowCoordinator.startWorkflow({ goal: goal!, workflowId });
      }
      // Phase G: 主动重跑直到 goal 终结
      // TUI-level 防御性 guard（WorkflowCoordinator 已有 maxRounds，此处提供额外保险）
      // SPEC S3-2: 同时检查 workflowCoordinator.isInterrupted()，
      // 避免 Ctrl+C 后还继续发起新的 workflow run。
      const MAX_CONTINUATION_CYCLES = 50;
      let continuationCycles = 0;
      let prevSig = '';
      let runAgain = true;
      while (runAgain && !workflowCoordinator.isInterrupted()) {
        runAgain = false;
        continuationCycles++;
        if (continuationCycles > MAX_CONTINUATION_CYCLES) {
          commitBridge(prev => ({
            ...prev,
            warnings: [...prev.warnings, t().workflowContinuationGuard].slice(-MAX_WARNINGS),
          }));
          break;
        }
        for await (const rawEvent of workflowCoordinator.runWorkflow()) {
        const hasType = (rawEvent as any).type !== undefined;
        const hasRole = (rawEvent as any).role !== undefined;

        if (hasType) {
          const wfEvent = rawEvent as unknown as WorkflowEvent;

            if (wfEvent.type === 'phase_change' && wfEvent.phase && wfEvent.iteration != null) {
            // SPEC S1-2: phase 切换前 flush batcher，避免前一 turn 的 timer 写入新 turn
            workflowBatcher.flushNow();
            finalizeWorkflowTurn();
            activeRole = wfEvent.phase === 'worker_do' || wfEvent.phase === 'worker_report' ? 'worker' : 'supervisor';
            onPhaseChange?.(wfEvent.phase, wfEvent.iteration);
            if (orchestrationStore) {
              orchestrationStore.apply({
                kind: 'loop_transition',
                transition: {
                  from: orchestrationStore.getSnapshot().loop.phase ?? 'observe',
                  to: workflowPhaseToLoopPhase(wfEvent.phase),
                  attempt: wfEvent.iteration,
                  timestamp: Date.now(),
                },
              });
            }
            startWorkflowPhase();
          }
          if (wfEvent.type === 'completed') {
            onPhaseChange?.('completed', 0, 'completed');
          } else if (wfEvent.type === 'failed') {
            onPhaseChange?.('failed', 0, 'failed', wfEvent.reason);
          } else if (wfEvent.type === 'blocked') {
            onPhaseChange?.('blocked', 0, 'blocked', wfEvent.reason);
          } else if (wfEvent.type === 'ask_user' && wfEvent.requestId && wfEvent.question) {
            // WF-1: 把 ask_user 事件写入 questionPrompt，触发 App 渲染问题 UI。
            // requestId 与 QuestionService pending map 一致（由 coordinator.runWaitingUser 传入），
            // 用户回答后 respondQuestion 会转发到 workflowCoordinator.replyWorkflowQuestion。
            commitBridge(() => ({
              questionPrompt: {
                id: wfEvent.requestId!,
                sessionId: wfEvent.workflowId,
                questions: [{
                  question: wfEvent.question!,
                  header: 'Workflow needs input',
                  options: [],
                }],
              },
            }));
          }
        } else if (hasRole) {
          const loopEvent = rawEvent as unknown as LoopEvent;
          switch (loopEvent.role) {
            case 'assistant_delta': {
              ensureWorkflowTurn();
              const chunk = loopEvent.content ?? '';
              assistantText += chunk;
              // SPEC S1-2: 仅 ensure id + schedule batcher，不再每个 chunk 触发 publishTimeline()
              ensureWorkflowAssistantId();
              workflowBatcher.schedule();
              break;
            }
            case 'assistant_final': {
              ensureWorkflowTurn();
              // SPEC S1-2: final 前先 flush batcher，避免 isStreaming=true 覆盖 final 状态
              workflowBatcher.flushNow();
              if (loopEvent.content) assistantText = loopEvent.content;
              const metadataReasoning = loopEvent.metadata?.reasoning;
              if (typeof metadataReasoning === 'string' && metadataReasoning.length > 0) reasoningText = metadataReasoning;
              if (assistantText) {
                const id = ensureWorkflowAssistantId();
                upsertWorkflowTextItem({ id, kind: 'assistant_text', roundId: wfTurnId, text: assistantText, isStreaming: false, startTs: wfTurnTs, role: activeRole, turnId: wfTurnId });
              }
              if (reasoningText) {
                const id = ensureWorkflowReasoningId();
                upsertWorkflowTextItem({ id, kind: 'reasoning', roundId: wfTurnId, text: reasoningText, isStreaming: false, startTs: wfTurnTs, role: activeRole, turnId: wfTurnId });
              }
              break;
            }
            case 'reasoning_delta': {
              ensureWorkflowTurn();
              const chunk = loopEvent.content ?? '';
              reasoningText += chunk;
              // SPEC S1-2: 仅 ensure id + schedule batcher，不再每个 chunk 触发 publishTimeline()
              ensureWorkflowReasoningId();
              workflowBatcher.schedule();
              break;
            }
            case 'tool_call_delta':
              ensureWorkflowTurn();
              if (loopEvent.toolCallIndex !== undefined && loopEvent.content) {
                toolCallArgs.set(loopEvent.toolCallIndex, loopEvent.content);
              }
              break;
            case 'tool_start': {
              ensureWorkflowTurn();
              // SPEC S1-3: 用 registerWorkflowToolStart 生成唯一 key，避免同名工具覆盖
              const key = registerWorkflowToolStart(loopEvent.toolCallIndex, loopEvent.toolName);
              upsertWorkflowTool(key, {
                name: loopEvent.toolName ?? 'unknown',
                status: 'running',
                args: parseArgs(loopEvent.toolCallIndex === undefined ? undefined : toolCallArgs.get(loopEvent.toolCallIndex)),
                output: '',
                startedAt: Date.now(),
              });
              break;
            }
            case 'tool_progress': {
              ensureWorkflowTurn();
              // SPEC S1-3: 用 resolveWorkflowToolKey 回查对应 key
              const key = resolveWorkflowToolKey(loopEvent.toolCallIndex, loopEvent.toolName);
              if (loopEvent.content === 'done') {
                upsertWorkflowTool(key, { status: 'done' });
              } else if (loopEvent.content && loopEvent.content !== 'running') {
                const previous = toolOutputs.get(key) ?? '';
                const output = previous + (previous ? '\n' : '') + loopEvent.content;
                toolOutputs.set(key, output);
                upsertWorkflowTool(key, { output });
              }
              break;
            }
            case 'tool': {
              ensureWorkflowTurn();
              // SPEC S1-3: 用 resolveWorkflowToolKey 回查对应 key
              const key = resolveWorkflowToolKey(loopEvent.toolCallIndex, loopEvent.toolName);
              upsertWorkflowTool(key, {
                name: loopEvent.toolName ?? 'tool',
                status: loopEvent.severity === 'error' ? 'error' : 'done',
                output: loopEvent.content ?? '',
              });
              break;
            }
            case 'error': {
              const message = loopEvent.content ?? 'Unknown error';
              if (!isToolLoopNotice(message) && loopEvent.metadata?.reason !== 'toolCallLoop') {
                console.warn(`[tool:error] ${message}`);
              }
              break;
            }
            case 'warning': {
              const warning = loopEvent.content ?? 'Warning';
              if (isToolLoopNotice(warning)) break;
              commitBridge(prev => ({
                warnings: [...prev.warnings, warning].slice(-MAX_WARNINGS),
              }));
              break;
            }
            case 'status':
              if (loopEvent.content === 'tools_completed') {
                // SPEC S1-2: turn 结束前 flush batcher，确保 final delta 已写入
                workflowBatcher.flushNow();
                finalizeWorkflowTurn();
                startWorkflowTurn();
              }
              break;
            case 'done':
              break;
            case 'usage': {
              const addInput = typeof loopEvent.metadata?.input === 'number' ? loopEvent.metadata.input : 0;
              const addOutput = typeof loopEvent.metadata?.output === 'number' ? loopEvent.metadata.output : 0;
              commitBridge(prev => ({
                tokens: { ...prev.tokens, input: prev.tokens.input + addInput, output: prev.tokens.output + addOutput },
                contextUsage: addInput,
              }));
              break;
            }
            case 'permission_ask': {
              // SPEC S0-1: 推断 originRole 用于定向 respondPermissionForRequest()
              const originRole: PermissionOriginRole = dualRuntime
                ? (activeRole === 'supervisor' ? 'supervisor' : 'worker')
                : 'main';
              const requestId = loopEvent.metadata?.requestId as string | undefined;
              const sessionId = loopEvent.metadata?.sessionId as string | undefined;
              const permission = loopEvent.metadata?.permission as string | undefined;
              if (requestId && sessionId && permission) {
                commitBridge(() => ({
                  permissionPrompt: {
                    id: requestId,
                    sessionId,
                    permission,
                    patterns: loopEvent.metadata?.patterns as string[] ?? [],
                    always: loopEvent.metadata?.always as string[] ?? [],
                    metadata: loopEvent.metadata?.metadata as Record<string, unknown> ?? {},
                    tool: loopEvent.metadata?.tool as { toolCallId: string; toolName: string } ?? { toolCallId: '', toolName: loopEvent.toolName ?? 'unknown' },
                    parentSessionId: loopEvent.metadata?.parentSessionId as string | undefined,
                    originRole,
                  },
                }));
              }
              break;
            }
            case 'question_ask': {
              const requestId = loopEvent.metadata?.requestId as string | undefined;
              const sessionId = loopEvent.metadata?.sessionId as string | undefined;
              const questions = loopEvent.metadata?.questions as QuestionRequest['questions'] | undefined;
              if (requestId && sessionId && questions) {
                commitBridge(() => ({ questionPrompt: { id: requestId, sessionId, questions } }));
              }
              break;
            }
            case 'question_replied':
            case 'question_rejected':
              commitBridge(() => ({ questionPrompt: null }));
              break;
            case 'orchestration':
              if (loopEvent.orchestration && orchestrationStore) orchestrationStore.apply(loopEvent.orchestration);
              break;
          }
        }
      }
        // Phase G: 检查 goal 状态决定是否继续下一轮
        const coordState = workflowCoordinator.getState();
        if (coordState && !workflowCoordinator.isFinished()) {
          const store = workflowCoordinator.getGoalStore?.();
          if (store) {
            const goal = store.getGoal(coordState.workflowId);
            const canStartFromPhase =
              coordState.currentPhase === "idle" ||
              coordState.currentPhase === "supervisor_analyse";
            if (goal && goal.status === "active" && canStartFromPhase) {
              // 检测无进展循环（相同的 wfId + phase + iteration + goal status）
              const sig = `${coordState.workflowId}|${coordState.currentPhase}|${coordState.iteration}|${goal.status}`;
              if (sig === prevSig) {
                commitBridge(prev => ({
                  ...prev,
                  warnings: [...prev.warnings, t().workflowStuckGuard].slice(-MAX_WARNINGS),
                }));
                break;
              }
              prevSig = sig;
              runAgain = true;
            }
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const failedWorkflowId = workflowCoordinator.getState()?.workflowId ?? workflowId

      commitBridge(prev => ({
        ...prev,
        warnings: [...prev.warnings, `Workflow error: ${message}`].slice(-MAX_WARNINGS),
      }))

      onPhaseChange?.('failed', workflowCoordinator.getState()?.iteration ?? 0, 'failed', message)

      throw new WorkflowDriveError(message, {
        workflowId: failedWorkflowId,
        cause: err,
      })
    } finally {
      // SPEC S1-2: finally 中 flush batcher，确保中断时 pending delta 仍被写入
      workflowBatcher.flushNow();
      workflowBatcher.cancel();
      finalizeWorkflowTurn();
      // SFR-70: 确保 always 恢复 idle，即使中断或异常
      setTUIState('idle');
      commitBridge(() => ({
        isLoading: false,
        permissionPrompt: null,
        reasoningActive: false,
      }));
    }
  };

  const runWorkflow = (
    goal: string,
    onPhaseChange?: (phase: string, iteration: number, finalStatus?: string, reason?: string) => void,
    workflowId?: string,
  ) => driveWorkflow(goal, onPhaseChange, undefined, workflowId);

  const resumeWorkflow = (
    instruction: string,
    onPhaseChange?: (phase: string, iteration: number, finalStatus?: string, reason?: string) => void,
  ) => driveWorkflow(null, onPhaseChange, instruction);

  const addWorkflowInstruction = (instruction: string) => {
    workflowCoordinator?.addUserInstruction(instruction);
  };

  let evalAbortController: AbortController | null = null

  const runEval = async (
    options: EvalRunOptions,
    currentWorkerConfig: { provider: string; model: string; baseUrl: string; apiKey: string },
    onProgress?: (progress: EvalRunProgress) => void,
  ): Promise<EvalRunResult> => {
    const abortController = new AbortController()
    evalAbortController = abortController

    // Resolve engines: Worker and Supervisor may be separate when dualRuntime is active
    const workerEngine = dualRuntime ? dualRuntime.getWorker().getEngine() : engine
    const supervisorEngine = dualRuntime ? dualRuntime.getSupervisor().getEngine() : engine

    const submitAndCollect = async (
      targetEngine: ReasonixEngine,
      text: string,
      signal?: AbortSignal,
    ): Promise<{ text: string; durationMs: number }> => {
      const startTime = Date.now()
      let result = ''
      for await (const event of targetEngine.submit(text)) {
        if (signal?.aborted) {
          targetEngine.interrupt()
          break
        }
        if (event.role === 'assistant_final' && event.content) {
          result = event.content
        }
        if (event.role === 'done') break
      }
      return { text: result, durationMs: Date.now() - startTime }
    }

    const checkApiKey = (modelTarget: string): string | null => {
      // Try alias resolution first (includes .covalo/model-targets.json custom aliases)
      const cfg = loadConfig()
      const resolved = resolveModelTarget(modelTarget, cfg, cfg.modelTargets)
      if (resolved) {
        if (resolved.keyless || !PROVIDERS[resolved.provider]?.requiresKey) return null
        const { value: apiKey } = resolveApiKey(resolved.provider)
        if (!apiKey) return `missing API key for ${resolved.provider} (set ${getApiKeyEnvVar(resolved.provider)})`
        return null
      }
      const parts = modelTarget.split('/')
      const provider = parts[0]
      const providerInfo = PROVIDERS[provider]
      if (!providerInfo) return `unknown provider: ${provider}`
      if (providerInfo.requiresKey) {
        const { value: apiKey } = resolveApiKey(provider)
        if (!apiKey) return `missing API key for ${provider} (set ${getApiKeyEnvVar(provider)})`
      }
      return null
    }

    const switchModel = async (modelTarget: string): Promise<void> => {
      // Try alias resolution first (includes .covalo/model-targets.json custom aliases)
      const cfg = loadConfig()
      const resolved = resolveModelTarget(modelTarget, cfg, cfg.modelTargets)
      if (resolved) {
        workerEngine.updateConfig({
          provider: resolved.provider,
          model: resolved.model,
          apiKey: resolved.apiKey ?? '',
          baseUrl: resolved.baseUrl,
          contextWindow: resolved.contextWindow,
        })
        await new Promise(r => setTimeout(r, 100))
        return
      }
      const parts = modelTarget.split('/')
      const provider = parts[0]
      const model = parts.slice(1).join('/')
      const providerInfo = PROVIDERS[provider]
      if (!providerInfo) throw new Error(`unknown provider: ${provider}`)
      const { value: apiKey } = resolveApiKey(provider)
      const baseUrl = providerInfo?.baseUrl ?? ''
      const contextWindow = providerInfo?.contextWindow
      workerEngine.updateConfig({ provider, model, apiKey, baseUrl, contextWindow })
      await new Promise(r => setTimeout(r, 100))
    }

    const restoreModel = async (): Promise<void> => {
      const { value: apiKey } = resolveApiKey(currentWorkerConfig.provider)
      const baseUrl = currentWorkerConfig.baseUrl || (PROVIDERS[currentWorkerConfig.provider]?.baseUrl ?? '')
      const contextWindow = PROVIDERS[currentWorkerConfig.provider]?.contextWindow
      workerEngine.updateConfig({
        provider: currentWorkerConfig.provider,
        model: currentWorkerConfig.model,
        apiKey,
        baseUrl,
        contextWindow,
      })
    }

    const executeWorker = async (params: { prompt: string; signal?: AbortSignal }) => {
      const { text: raw, durationMs } = await submitAndCollect(workerEngine, params.prompt, params.signal)
      return { text: raw, toolCalls: 0, toolFailures: 0, durationMs }
    }

    const executeSupervisor = async (params: { prompt: string; signal?: AbortSignal }) => {
      const { text, durationMs } = await submitAndCollect(supervisorEngine, params.prompt, params.signal)
      return { text, durationMs }
    }

    return runCoreEval(
      options,
      {
        switchModel,
        restoreModel,
        executeWorker,
        executeSupervisor,
        checkApiKey,
        abortSignal: abortController.signal,
      },
      onProgress,
    )
  }

  return {
    submit,
    submitAndCollect,
    cancel,
    respondPermission,
    respondQuestion,
    rejectQuestion,
    runWorkflow,
    resumeWorkflow,
    addWorkflowInstruction,
    replaceTranscript,
    appendTimelineMessage,
    getTranscriptReader: () => transcriptReader,
    getBridgeRuntime: () => bridgeRuntime,
    resetBridgeRuntime: () => bridgeRuntime?.reset(),
    runEval,
  };
}
