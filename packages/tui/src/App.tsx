import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Box, AlternateScreen, instances, SHOW_CURSOR, EXIT_ALT_SCREEN, useInput } from '@covalo/ink';
import type { ScrollBoxHandle } from '@covalo/ink';
import { writeSync } from 'node:fs';
import type { ReasonixEngine, LoopEvent } from '@covalo/core';
import type { ChatMessage, DeepreefConfig } from '@covalo/core';
import { PROVIDERS, AGENTS, defaultAgentRegistry, getModelContextWindow, saveLastConfig, saveRoleConfig, loadAgentProfiles, saveAgentProfiles, updateAgentProfile, selectBenchmarkCases, FREE_MODEL_TARGETS, resolveApiKey, loadRoleConfig, getCategory, getSuite, runFixedEval, saveEvalReport, DEFAULT_WORKFLOW_CONFIG } from '@covalo/core';
import { resolveHarnessStrictness, readProjectHarnessConfig, writeProjectHarnessConfig } from '@covalo/core';
import { createBridge, timelineFromMessages, WorkflowDriveError, type BridgeState } from './bridge.js';
import type { DualAgentRuntime } from '@covalo/core/dual-agent-runtime/dual-runtime.js';
import type { WorkflowCoordinator } from '@covalo/core/workflow-coordinator/coordinator.js';
import { TranscriptProvider } from './store/TranscriptContext.js';
import { BridgeRuntimeProvider } from './store/BridgeRuntimeContext.js';
import { isBridgeRuntimeSplitEnabled, isTranscriptStoreEnabled } from './store/feature.js';
import { WelcomeWhenEmpty } from './WelcomeWhenEmpty.js';
import { BridgeDeepiPromptInput, BridgeScrollAlerts, BridgeStatusBar } from './BridgeConnected.js';
import { DeepiMessages } from './DeepiMessages.js';
import type { DeepiPromptInputHandle } from './DeepiPromptInput.js';
import { routeWorkflowInput, type WorkflowLifecycle } from './workflow-mode-router.js';
import { FullscreenLayout } from './FullscreenLayout.js';
import { restoreMessageScrollAfterOverlay, useMessageScroll } from './useMessageScroll.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { isFullscreenEnvEnabled, getMouseTrackingMode } from './fullscreen.js';
import { ModelPicker } from './ModelPicker.js';
import { SessionPicker } from './SessionPicker.js';
import { CommandAutocomplete } from './CommandAutocomplete.js';
import { SearchOverlay } from './SearchOverlay.js';
import { CenteredStage } from './CenteredStage.js';
import { ChoiceMenu } from './ChoiceMenu.js';
import { SkillModal } from './SkillModal.js';
import { ContextModal } from './ContextModal.js';
import { formatStatus } from './status/format.js';
import { t, setLocale, getLocale, dicts } from './i18n/index.js';
import { loadLang } from './i18n/persist.js';
import { setPromptLocale, savePromptLocaleToDisk } from '@covalo/core';
import type { Locale } from './i18n/strings.js';
import { LocaleProvider } from './i18n/context.js';
import { loadTuiSettings, saveTuiSettings, type WorkflowMode } from './settings.js';
import { GoalStore, GoalRuntime } from '@covalo/core/goal/index.js';
import {
  buildHelpText,
  parseSlashCommand,
  validateThinkingMode,
} from './commands.js';
// TUI-GM: Gemini CLI 风格组件
import { LoadingIndicator } from './components/shared/LoadingIndicator.js';
import { AgentGroupDisplay } from './components/agents/AgentGroupDisplay.js';
import { WorkerActivityPanel } from './components/workers/WorkerActivityPanel.js';
import { DialogManager } from './components/dialogs/DialogManager.js';
import { EvalWizard } from './eval/EvalWizard.js';
// DA-R6: 双角色组件
import { WorkflowStatusBar } from './components/workflow/index.js';
import type { WorkflowPhase, WorkflowState } from './components/workflow/index.js';
// TUI-FIX-20: 编排状态存储
import { OrchestrationStore } from './store/orchestration-store.js';
// TUI-FIX-30: 编排状态 hooks
import { OrchestrationStoreProvider, useOrchestrationWorkers } from './components/orchestration/OrchestrationContext.js';
// TUI-FIX-60: 主题管理器
import { themeManager } from './theme/theme-manager.js';

// ---- 模块级中断/退出状态（由 SIGINT 处理器和 useInput \x03 处理器共享） ----

/** TUI 运行状态: 'idle' 空闲 / 'loading' 加载中 */
let tuiState: 'idle' | 'loading' = 'idle';
export function setTUIState(s: 'idle' | 'loading') { tuiState = s; }

/** 退出双击计时器: 首次 Ctrl+C 后启动，2 秒内再次按下则执行退出 */
let exitTimer: ReturnType<typeof setTimeout> | null = null;
/** 退出挂起标志: 为 true 时忽略后续中断信号 */
let exitPending = false;

/**
 * 模块级回调 —— 由 App 组件挂载时注入。
 * 模块级回调（供 doInterrupt 与 SIGINT handler 共享）。
 * 注意：这些变量在每次 App 渲染时被重新赋值，单实例 TUI 下安全。
 */
let _cancel: (() => void) | null = null;
let _interrupt: (() => void) | null = null;
let _setStatusMsg: ((m: string | null) => void) | null = null;
let _cancelEval: (() => void) | null = null;
let _evalRunningRef: (() => boolean) | null = null;

function cancelActiveEval(): boolean {
  if (!_evalRunningRef || !_evalRunningRef()) return false;
  _cancelEval?.();
  return true;
}

/**
 * 清理终端环境。
 * 依次执行：禁用鼠标跟踪 → 卸载 Ink 实例退出备用屏幕 → 排空 stdin → 分离实例并恢复 raw mode → 显示光标。
 * 此函数在退出前被调用，确保终端恢复至正常状态。
 */
function cleanupTerminal(): void {
  const inst = instances.get(process.stdout);

  // 1. Disable mouse tracking FIRST — gives terminal time to process
  //    while we're busy unmounting the React tree
  try { writeSync(1, '\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l'); } catch {}

  // 2. Full Ink unmount — renders last frame on alt buffer, exits alt screen,
  //    unsubscribes from signal-exit so it won't double-fire on process.exit
  if (inst?.isAltScreenActive) {
    try {
      inst.unmount();
    } catch {
      try { writeSync(1, EXIT_ALT_SCREEN); } catch {}
    }
  }

  // 3. Drain stdin — catches mouse/input events that arrived during tree-walk
  try { inst?.drainStdin(); } catch {}

  // 4. Mark unmounted + restore raw mode so signal-exit won't re-run unmount()
  try { inst?.detachForShutdown(); } catch {}

  // 5. Show cursor
  try { writeSync(1, SHOW_CURSOR); } catch {}
}

/**
 * 中断处理（Ctrl+C 处理器）。
 * - loading 状态：调用 _cancel 取消当前请求
 * - idle 状态：首次按下启动 2 秒退出倒计时；倒计时内再次按下则直接退出进程
 */
function doInterrupt(): void {
  if (exitPending) return;

  // Always cancel active eval first, regardless of tuiState.
  // This ensures Ctrl+C aborts eval even when the runner is between cases
  // (setup/verifier gap) and bridge isLoading is false.
  if (cancelActiveEval()) return;

  if (tuiState === 'loading') {
    _cancel?.();
    return;
  }

  // Idle: double-tap to exit
  if (exitTimer) {
    clearTimeout(exitTimer);
    exitTimer = null;
    exitPending = true;
    _interrupt?.();
    cleanupTerminal();
    process.exit(0);
  }

  exitTimer = setTimeout(() => { exitTimer = null; _setStatusMsg?.(null); }, 2000);
  _setStatusMsg?.(t().pressCtrlC);
}

const initialState: BridgeState = {
  timeline: [],
  isLoading: false,
  messageQueue: [],
  pendingInstructionCount: 0,
  tokens: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 },
  contextUsage: 0,
  warnings: [],
  error: null,
  permissionPrompt: null,
  questionPrompt: null,
  reasoningActive: false,
};

const MAX_INPUT_HISTORY = 100;

interface SkillRecord {
  name: string;
  description: string;
  content: string;
}

/**
 * 从输入文本中提取技能标签（以 # 开头的单词）。
 * @param text - 用户输入文本
 * @returns 去重后的技能名称列表
 */
function getWorkflowIdFromError(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'workflowId' in err) {
    const id = (err as { workflowId?: unknown }).workflowId
    return typeof id === 'string' ? id : undefined
  }
  return undefined
}

function extractSkillTags(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/(?:^|\s)#([A-Za-z0-9_.-]+)/g)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function parseSkillDetail(content: string): SkillRecord {
  const parsed = JSON.parse(content) as Partial<SkillRecord>;
  if (!parsed.name || !parsed.description || !parsed.content) {
    throw new Error('invalid skill payload');
  }
  return { name: parsed.name, description: parsed.description, content: parsed.content };
}

/**
 * 根据技能名称列表加载对应的技能记录。
 * 遍历名称列表，依次调用 createSkillTool 执行 load 命令获取技能内容并解析。
 * @param names - 技能名称数组
 * @returns 技能记录列表（失败项自动跳过）
 */
async function loadTaggedSkills(names: string[]): Promise<SkillRecord[]> {
  if (names.length === 0) return [];
  const { createSkillTool } = await import('@covalo/tools');
  const tool = createSkillTool();
  const loaded: SkillRecord[] = [];
  for (const name of names) {
    const output = await tool.execute({ command: 'load', query: name }, { cwd: process.cwd(), sessionId: '' });
    if (output.isError) continue;
    const content = typeof output.content === 'string' ? output.content : String(output.content ?? '');
    loaded.push(parseSkillDetail(content));
  }
  return loaded;
}

export function getProviderLabel(provider: string): string {
  const info = PROVIDERS[provider];
  return info ? info.label : provider;
}

interface AppProps {
  engine: ReasonixEngine;
  config: DeepreefConfig;
  pluginCount?: number;
  contentPackCount?: number;
  assetCounts?: { skills: number; agents: number; rules: number; commands: number; mcp: number; hooks: number };
  diagnosticCounts?: { errors: number; warnings: number };
  onUserInput?: (text: string) => void;
  beforeSubmit?: () => Promise<void>;
  dualRuntime?: DualAgentRuntime;
  workflowCoordinator?: WorkflowCoordinator;
  onPromptLocaleChange?: (locale: "zh-CN" | "en") => void;
}

/**
 * App —— 终端用户界面的根组件。
 *
 * 职责：
 * - 管理 Bridge（与 LLM 引擎通信的桥梁）生命周期
 * - 维护全部 UI 状态（消息时间线、模型选择、技能、Agent、语言等）
 * - 处理键盘输入（Ctrl+C 中断、Ctrl+F 搜索、提交消息、斜杠命令等）
 * - 根据状态变量切换显示覆盖层（模型选择器 / 会话选择器 / Agent 菜单等）
 * - 组合主内容区 (scrollableContent) 与底部输入区 (bottomContent)
 *
 * @param engine - ReasonixEngine 实例，驱动 LLM 通信
 * @param config - DeepreefConfig 配置对象（provider / model / contextWindow 等）
 */
/**
 * 内部组件：从 OrchestrationStore 读取 Worker 数据并渲染 AgentGroupDisplay。
 */
function AgentGroupDisplayFromStore({ terminalWidth }: { terminalWidth: number }) {
  const workers = useOrchestrationWorkers();
  if (workers.length === 0) return null;
  return (
    <AgentGroupDisplay
      workers={workers}
      terminalWidth={terminalWidth}
    />
  );
}

export function App({ engine, config, pluginCount = 0, contentPackCount = 0, assetCounts, diagnosticCounts, onUserInput, beforeSubmit, dualRuntime, workflowCoordinator, onPromptLocaleChange }: AppProps) {
  // TUI-FIX-20: 编排状态存储（引擎生命周期内持久）
  const [orchestrationStore] = useState(() => new OrchestrationStore());

  // TUI-FIX-20: 连接引擎编排事件发射器
  useEffect(() => {
    engine.setOnOrchestrationEvent?.((event) => {
      if (event.orchestration) {
        orchestrationStore.apply(event.orchestration);
      }
    });
    return () => {
      engine.setOnOrchestrationEvent?.(() => {});
    };
  }, [engine, orchestrationStore]);

  const persistedSettings = useMemo(() => loadTuiSettings(), []);

  // TUI-FIX-60: 启动时恢复已持久化的主题
  useEffect(() => {
    if (persistedSettings.theme) {
      themeManager.setActiveTheme(persistedSettings.theme);
    }
  }, [persistedSettings.theme]);
  const persistedThinkingMode = persistedSettings.thinkingMode && !validateThinkingMode(persistedSettings.thinkingMode)
    ? persistedSettings.thinkingMode
    : undefined;
  const persistedAgent = persistedSettings.agent && (AGENTS[persistedSettings.agent] || defaultAgentRegistry.get(persistedSettings.agent))
    ? persistedSettings.agent
    : undefined;
  // per-role agent 身份绑定：从 agents.json 读取，缺省回退到 role 同名（worker/supervisor）
  const [agentProfiles, setAgentProfiles] = useState(() => loadAgentProfiles());
  const [thinkingMode, setThinkingMode] = useState(persistedThinkingMode ?? 'off');

  // TUI-FIX: 将 TUI 的 thinkingMode 传递给 Engine，控制 DeepSeek API thinking 参数
  useEffect(() => {
    engineRef.current.setThinkingMode?.(thinkingMode as 'off' | 'open' | 'high');
  }, [thinkingMode]);
  const [bridgeState, setBridgeState] = useState<BridgeState>(() => ({ ...initialState }));
  const bridge = useMemo(() => createBridge(engine, setBridgeState, onUserInput, beforeSubmit, orchestrationStore, dualRuntime, workflowCoordinator), [engine, onUserInput, beforeSubmit, orchestrationStore, dualRuntime, workflowCoordinator]);
  const transcriptReader = useMemo(() => bridge.getTranscriptReader(), [bridge]);
  const bridgeRuntime = useMemo(() => bridge.getBridgeRuntime(), [bridge]);
  const bridgeSplit = isBridgeRuntimeSplitEnabled();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const contextTotal = engine.getContextWindow?.() ?? config.contextWindow ?? 128_000;
  const engineRef = useRef(engine);
  const dualRuntimeRef = useRef(dualRuntime);
  dualRuntimeRef.current = dualRuntime;
  const workflowCoordinatorRef = useRef(workflowCoordinator);
  workflowCoordinatorRef.current = workflowCoordinator;
  const mountedRef = useRef(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const appendMessage = useCallback((message: ChatMessage) => {
    bridgeRef.current.appendTimelineMessage(message);
  }, []);

  // 模块级回调在每次渲染更新（单实例 TUI 安全）。SIGINT handler 使用独立 ref 避免闭包陈旧。
  _cancel = () => bridgeRef.current.cancel();
  _interrupt = () => engineRef.current.interrupt();
  _setStatusMsg = setStatusMessage;
  _evalRunningRef = () => evalAbortRef.current !== null;
  _cancelEval = () => {
    if (evalAbortRef.current) {
      evalAbortRef.current.abort();
      bridgeRef.current.cancel();
      evalAbortRef.current = null;
    }
  };

  const sigCancelRef = useRef<(() => void) | null>(null);
  const sigInterruptRef = useRef<(() => void) | null>(null);
  const sigSetMsgRef = useRef<((m: string | null) => void) | null>(null);
  sigCancelRef.current = _cancel;
  sigInterruptRef.current = _interrupt;
  sigSetMsgRef.current = setStatusMessage;

  // SIGINT handler（使用 ref 读取最新值，降低严格模式风险）
  useEffect(() => {
    const handler = () => {
      if (exitPending) return;

      // Always cancel active eval first; SIGINT can fire when eval is between cases
      // and tuiState is 'idle', so we cannot rely on the loading check below.
      if (cancelActiveEval()) return;

      const cancel = sigCancelRef.current;
      const interrupt = sigInterruptRef.current;
      const setMsg = sigSetMsgRef.current;

      if (tuiState === 'loading') {
        cancel?.();
        return;
      }
      if (exitTimer) {
        clearTimeout(exitTimer);
        exitTimer = null;
        exitPending = true;
        interrupt?.();
        cleanupTerminal();
        process.exit(0);
      }
      exitTimer = setTimeout(() => { exitTimer = null; setMsg?.(null); }, 2000);
      setMsg?.(t().pressCtrlC);
    };
    process.on('SIGINT', handler);
    return () => { process.off('SIGINT', handler); };
  }, []);

  // Track mounted state
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // \x03 character handler (raw mode working properly — Ctrl+C arrives as character)
  useInput((input, key) => {
    if (input === '\x03' || (key.ctrl && input === 'c')) {
      doInterrupt();
    }
    if (key.ctrl && input === 'f') {
      setShowSearch(prev => !prev);
    }
  });

  /** 取消当前 LLM 请求或正在运行的评测 */
  const handleCancel = useCallback(() => {
    cancelActiveEval();
    bridgeRef.current.cancel();
  }, []);
  const scrollRef = useRef<ScrollBoxHandle | null>(null);
  const promptInputRef = useRef<DeepiPromptInputHandle>(null);

  // per-role 模型配置：worker / supervisor 各持一份 provider/model。
  // activeModel/activeProvider 改为从 roleConfig[activeRole] 派生（见 activeRole 定义之后）。
  const [roleConfig, setRoleConfig] = useState<Record<'worker' | 'supervisor', { provider: string; model: string; baseUrl: string }>>(() => {
    const persistedW = loadRoleConfig('worker')
    const persistedS = loadRoleConfig('supervisor')
    return {
      worker: persistedW ? { provider: persistedW.provider, model: persistedW.model, baseUrl: persistedW.baseUrl ?? '' } : { provider: config.provider ?? 'zen', model: config.model, baseUrl: config.baseUrl ?? '' },
      supervisor: persistedS ? { provider: persistedS.provider, model: persistedS.model, baseUrl: persistedS.baseUrl ?? '' } : { provider: config.provider ?? 'zen', model: config.model, baseUrl: config.baseUrl ?? '' },
    }
  });
  const roleConfigRef = useRef(roleConfig);
  roleConfigRef.current = roleConfig;
  const [inputText, setInputText] = useState('');                                // 用户输入框当前文本
  const [showAutocomplete, setShowAutocomplete] = useState(false);               // 是否显示命令自动补全面板
  const [showModelPicker, setShowModelPicker] = useState(false);                 // 是否显示模型选择器覆盖层
  const [showSessionPicker, setShowSessionPicker] = useState(false);             // 是否显示会话选择器覆盖层
  const [showAgentMenu, setShowAgentMenu] = useState(false);                     // 是否显示 Agent 切换菜单覆盖层
  const [showLangMenu, setShowLangMenu] = useState(false);                       // 是否显示语言切换菜单覆盖层
  const [showThinkingMenu, setShowThinkingMenu] = useState(false);               // 是否显示推理档位选择菜单覆盖层
  const [showSkillModal, setShowSkillModal] = useState(false);                   // 是否显示技能管理弹窗覆盖层
  const [showContextModal, setShowContextModal] = useState(false);               // 是否显示上下文策略管理弹窗覆盖层
  const [showHarnessMenu, setShowHarnessMenu] = useState(false);                 // 是否显示 Harness 严格度选择菜单
  const [showSearch, setShowSearch] = useState(false);                           // 是否显示搜索覆盖层（Ctrl+F 触发）
  const [showWorkflowMenu, setShowWorkflowMenu] = useState(false);
  const [showEvalWizard, setShowEvalWizard] = useState(false);
  // Eval state for live EvalRunPanel display
  const [evalState, setEvalState] = useState<{ running: boolean; categoryId: string; suiteId: string; environmentId: string; latestEvent: import('@covalo/core').EvalProgressEvent | null }>({
    running: false, categoryId: '', suiteId: '', environmentId: '', latestEvent: null,
  });
  // ADV-HAR-01: Harness 三档严格度状态
  const initialStrictness = useMemo(() => {
    const projectConfig = readProjectHarnessConfig();
    const resolved = resolveHarnessStrictness({
      projectConfig,
      modelName: config.model,
    });
    return resolved;
  }, [config.model]);
  const [harnessStrictness, setHarnessStrictness] = useState<'strict' | 'normal' | 'loose'>(initialStrictness.strictness);
  const [harnessSource, setHarnessSource] = useState(initialStrictness.source);
  const harnessStrictnessRef = useRef(harnessStrictness);
  harnessStrictnessRef.current = harnessStrictness;
  const harnessSourceRef = useRef(harnessSource);
  harnessSourceRef.current = harnessSource;
  const modalBlocksScroll = showSearch
    || showModelPicker
    || showSessionPicker
    || showAgentMenu
    || showLangMenu
    || showThinkingMenu
    || showSkillModal
    || showContextModal
    || showHarnessMenu
    || showWorkflowMenu
    || showAutocomplete
    || showEvalWizard;
  useMessageScroll(scrollRef, !modalBlocksScroll);
  // per-role agent 身份：worker / supervisor 各持一份绑定。activeAgent 由 activeRole 派生（见下）。
  const [agentByRole, setAgentByRole] = useState<Record<'worker' | 'supervisor', string>>({
    worker: agentProfiles.worker?.agent ?? 'worker',
    supervisor: agentProfiles.supervisor?.agent ?? 'supervisor',
  });
  const [activeSkills, setActiveSkills] = useState(persistedSettings.activeSkills ?? engine.getActiveSkills?.() ?? []); // 当前已启用的技能列表
  const [inputHistory, setInputHistory] = useState<string[]>([]);                // 输入历史记录（最多 MAX_INPUT_HISTORY 条）
  const [inputInjection, setInputInjection] = useState<{ id: number; text: string } | undefined>(undefined); // 外部注入到输入框的文本
  const [contextPolicy, setContextPolicy] = useState(engine.getContextPolicy()); // 当前上下文策略
  // TUI-FIX-40: Worker 详情面板状态
  const [showWorkerDetail, setShowWorkerDetail] = useState(false);
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | undefined>();

  // P0: 语言状态（React state，确保整棵 TUI 重渲染）
  const [locale, setLocaleState] = useState<Locale>(() => loadLang() ?? 'zh-CN');

  // DA-R6: 双角色状态管理
  // AgentRole 原由 DualTabSystem 导出，组件移除后内联于此（底部 WorkflowStatusBar
  // 自行内联同名联合类型，不依赖此处）。
  type AgentRole = 'worker' | 'supervisor';
  const [activeRole, setActiveRole] = useState<AgentRole>('worker');

  // 当前 role 的模型/提供商：从 roleConfig 按 activeRole 派生，Tab 切换时自动跟随
  const activeProvider = roleConfig[activeRole].provider;
  const activeModel = roleConfig[activeRole].model;
  // 当前 role 绑定的 agent 身份名：Tab 切换时状态栏/菜单自动跟随
  const activeAgent = agentByRole[activeRole];

  // DA-R6: Workflow 状态
  const [workflowState, setWorkflowState] = useState<WorkflowState>({
    phase: 'idle',
    iteration: 0,
    maxRounds: DEFAULT_WORKFLOW_CONFIG.maxRounds,
    goal: '',
    supervisorStatus: 'idle',
    workerStatus: 'idle',
  });
  // 工作流模式：alone（单 agent）/ subagent（supervisor 自主调度）/ loop（固定双角色编排）
  // 从 ui-settings.json 恢复上次选择，缺省 alone。
  const [workflowMode, setWorkflowMode] = useState<WorkflowMode>(persistedSettings.workflowMode ?? 'alone');
  // SFR-50: 统一 lifecycle 状态取代 pendingWorkflowGoal 布尔值
  const [workflowLifecycle, setWorkflowLifecycle] = useState<WorkflowLifecycle>({ status: 'idle' });
  const workflowLifecycleRef = useRef(workflowLifecycle);
  workflowLifecycleRef.current = workflowLifecycle;
  // SFR-70: 跟踪并发 Workflow，防止重复启动
  const workflowRunningRef = useRef(false);
  const restoreScrollAfterWorkflowMenuRef = useRef(false);

  useEffect(() => {
    if (showWorkflowMenu || !restoreScrollAfterWorkflowMenuRef.current) return;
    restoreScrollAfterWorkflowMenuRef.current = false;
    restoreMessageScrollAfterOverlay(scrollRef);
  }, [showWorkflowMenu]);

  // Fixed eval: 跟踪 evalAbortRef 供 /eval-cancel 使用
  const evalAbortRef = useRef<AbortController | null>(null);
  const startFixedEval = useCallback(async (categoryId: string, suiteId: string, environmentId?: string) => {
    const { resolveEvalEnvironment } = await import('@covalo/core/sandbox/types.js');
    const env = resolveEvalEnvironment(environmentId ?? '');
    const category = getCategory(categoryId as any);
    const suite = getSuite(categoryId as any, suiteId as any, env as any);
    if (!category || !suite) {
      appendMessage({ role: 'assistant' as const, content: `Invalid eval target: ${categoryId}/${suiteId} for env=${env}` });
      return;
    }
    if (evalAbortRef.current) {
      appendMessage({ role: 'assistant' as const, content: 'An eval is already running. Use /eval-cancel to stop it.' });
      return;
    }
    const abortController = new AbortController();
    evalAbortRef.current = abortController;
    setEvalState({ running: true, categoryId, suiteId, environmentId: env, latestEvent: null });
    appendMessage({
      role: 'assistant' as const,
      content: `Starting eval: ${category.title} · ${suite.title} · env=${env} (${suite.cases.length} cases)`,
    });

    try {
      const report = await runFixedEval({
        categoryId: category.id,
        suiteId: suite.id,
        environmentId: env as any,
        abortSignal: abortController.signal,
        executeWorker: async (prompt: string) => {
          return bridgeRef.current.submitAndCollect(prompt, 'worker', 'alone', {
            displayText: `[eval/worker] ${category.title} · ${suite.title}`,
            signal: abortController.signal,
            observeInput: false,
          });
        },
        executeSupervisor: async (prompt: string) => {
          return bridgeRef.current.submitAndCollect(prompt, 'supervisor', 'alone', {
            displayText: `[eval/supervisor] ${category.title} · ${suite.title}`,
            signal: abortController.signal,
            observeInput: false,
          });
        },
        onProgress: (event) => {
          setEvalState(prev => ({ ...prev, latestEvent: event }));
          if (event.type === 'case-start') {
            appendMessage({
              role: 'assistant' as const,
              content: `[${(event.completedCases ?? 0) + 1}/${event.totalCases ?? '?'}] Running ${event.caseId} — ${event.title ?? ''}`,
            });
            return;
          }
          if (event.type === 'case-end' || event.type === 'infra-error') {
            if (event.result) {
              appendMessage({
                role: 'assistant' as const,
                content: `${event.result.caseId}: ${event.result.verdict.toUpperCase()} score=${event.result.score?.finalScore.toFixed(1) ?? 'N/A'}`,
              });
            } else if (event.error) {
              appendMessage({
                role: 'assistant' as const,
                content: `${event.caseId}: ERROR ${event.error}`,
              });
            }
          }
          if (event.type === 'preflight' && event.preflight && !event.preflight.allFound) {
            appendMessage({
              role: 'assistant' as const,
              content: `⚠ Preflight: missing tools — ${event.preflight.checks.filter(c => !c.found).map(c => c.name).join(', ')}`,
            });
          }
        },
      });
      const { reportDir } = await saveEvalReport(report);
      appendMessage({
        role: 'assistant' as const,
        content: `Eval complete: passed=${report.suiteSummary.passed} failed=${report.suiteSummary.failed} score=${report.overallScore.toFixed(2)}\nReport: ${reportDir}`,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      appendMessage({
        role: 'assistant' as const,
        content: msg.includes('aborted') ? 'Eval cancelled.' : `Eval error: ${msg}`,
      });
    } finally {
      if (evalAbortRef.current === abortController) {
        evalAbortRef.current = null;
      }
      setEvalState({ running: false, categoryId, suiteId, environmentId: env, latestEvent: null });
    }
  }, [appendMessage]);

  // DA-R6: 检查是否有覆盖层阻止 Tab 切换
  const isOverlayActive = showAutocomplete
    || showModelPicker
    || showSessionPicker
    || showAgentMenu
    || showLangMenu
    || showThinkingMenu
    || showSkillModal
    || showContextModal
    || showHarnessMenu
    || showWorkflowMenu
    || !!bridgeState.permissionPrompt
    || !!bridgeState.questionPrompt;

  // DA-R6: Tab 键切换输入目标（Worker ↔ Supervisor）。原由 DualTabSystem 组件
  // 通过 useInput 注册，组件移除后挪至此处保留交互；视觉指示改由底部
  // WorkflowStatusBar 承担。覆盖层激活时不响应，与原组件 disabled 行为一致。
  useInput((input, key) => {
    if (isOverlayActive) return;
    if (key.tab) {
      setActiveRole(prev => (prev === 'worker' ? 'supervisor' : 'worker'));
    }
  });

  // 启动 seeding：为两个 role 的 engine 各自 switchAgent 到其绑定的 agent 身份。
  // worker engine = engineRef.current（App props 传入的主 engine）；supervisor engine
  // 通过 dualRuntime.getSupervisor().getEngine() 获取（dual 模式下存在）。
  // persistedAgent（旧 ui-settings.json 的全局 agent）作为 worker 的兼容回退。
  useEffect(() => {
    const workerAgent = agentProfiles.worker?.agent || persistedAgent || 'worker';
    const supAgent = agentProfiles.supervisor?.agent || 'supervisor';
    engineRef.current.switchAgent(workerAgent);
    if (dualRuntime) {
      dualRuntime.getSupervisor().getEngine().switchAgent(supAgent);
    }
    if (persistedSettings.activeSkills) {
      engineRef.current.setActiveSkills(persistedSettings.activeSkills);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    void engineRef.current.getContextPolicyAsync().then(policy => {
      if (!cancelled) {
        setContextPolicy(policy);
      }
    });
    return () => { cancelled = true; };
  }, []);

  /** 提交处理：解析用户输入，执行斜杠命令或通过 bridge 发送消息 */
  const handleSubmit = useCallback((text: string) => {
    const submitted = text.trim();
    if (submitted) {
      setInputHistory(prev => [
        submitted,
        ...prev.filter(item => item !== submitted),
      ].slice(0, MAX_INPUT_HISTORY));
    }
    setShowAutocomplete(false);
    const command = parseSlashCommand(submitted);
    if (command?.name === 'exit') {
      exitPending = true;
      engineRef.current.interrupt();
      appendMessage({ role: 'assistant' as const, content: t().shuttingDown });
      cleanupTerminal();
      process.exit(0);
    }
    if (command?.name === 'help') {
      appendMessage({
        role: 'assistant' as const,
        content: buildHelpText(activeAgent, t()),
      });
      return;
    }
    if (command?.name === 'status') {
      void (async () => {
        try {
          const snapshot = await engineRef.current.getStatusSnapshot();
          appendMessage({ role: 'assistant' as const, content: formatStatus(snapshot) });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          appendMessage({ role: 'assistant' as const, content: `${t().failedLoadStatus}: ${msg}` });
        }
      })();
      return;
    }
    if (command?.name === 'model') {
      setShowModelPicker(true);
      return;
    }
    if (command?.name === 'sessions') {
      setShowSessionPicker(true);
      return;
    }
    if (command?.name === 'skill') {
      setShowSkillModal(true);
      return;
    }
    if (command?.name === 'context') {
      setShowContextModal(true);
      return;
    }
    if (command?.name === 'agent') {
      setShowAgentMenu(true);
      return;
    }
    if (command?.name === 'thinking') {
      if (command.mode) {
        const error = validateThinkingMode(command.mode);
        if (error) {
          appendMessage({ role: 'assistant' as const, content: `${error}\n${t().thinkingModeCurrent(thinkingMode)}` });
          return;
        }
        saveTuiSettings({ thinkingMode: command.mode });
        setThinkingMode(command.mode);
        setBridgeState(prev => ({ ...prev, reasoningActive: false }));
        appendMessage({ role: 'assistant' as const, content: t().thinkingModeSet(command.mode) });
        return;
      }
      setShowThinkingMenu(true);
      return;
    }
    if (command?.name === 'lang') {
      setShowLangMenu(true);
      return;
    }
    if (command?.name === 'harness') {
      if (command.subcommand === 'status') {
        appendMessage({
          role: 'assistant' as const,
          content: t().harnessStatus(harnessStrictnessRef.current, harnessSourceRef.current),
        });
        return;
      }
      if (command.subcommand === 'strict' || command.subcommand === 'normal' || command.subcommand === 'loose') {
        setHarnessStrictness(command.subcommand);
        setHarnessSource('session');
        engineRef.current.setHarnessStrictness(command.subcommand);
        appendMessage({
          role: 'assistant' as const,
          content: t().harnessSetSession(command.subcommand),
        });
        return;
      }
      if (command.subcommand === 'project') {
        const valid: Array<'strict' | 'normal' | 'loose'> = ['strict', 'normal', 'loose']
        const val = command.arg as 'strict' | 'normal' | 'loose' | undefined
        if (!val || !valid.includes(val)) {
          appendMessage({
            role: 'assistant' as const,
            content: t().harnessProjectUsage,
          });
          return;
        }
        writeProjectHarnessConfig({ strictness: val });
        setHarnessStrictness(val);
        setHarnessSource('project');
        engineRef.current.setHarnessStrictness(val);
        appendMessage({
          role: 'assistant' as const,
          content: t().harnessSetProject(val),
        });
        return;
      }
      // Harness evolution subcommands: route to CLI (capture output)
      if (['doctor', 'mine', 'propose', 'validate', 'promote', 'history', 'rollback'].includes(command.subcommand ?? '')) {
        appendMessage({
          role: 'assistant' as const,
          content: '这个命令在 CLI 下更合适。请在终端中运行:\n  covalo harness ' + command.subcommand + (command.arg ? ' ' + command.arg : ''),
        });
        return;
      }
      setShowHarnessMenu(true);
      return;
    }
    // TUI-FIX-60: /theme 命令 — 列出并切换主题（持久化）
    if (command?.name === 'theme') {
      if (command.themeName) {
        const success = themeManager.setActiveTheme(command.themeName);
        if (success) {
          saveTuiSettings({ theme: command.themeName });
          appendMessage({
            role: 'assistant' as const,
            content: `Theme switched to: ${command.themeName}`,
          });
        } else {
          appendMessage({
            role: 'assistant' as const,
            content: `Unknown theme: ${command.themeName}. Use /theme to list available themes.`,
          });
        }
      } else {
        const themes = themeManager.getAvailableThemes();
        const active = themeManager.getActiveTheme();
        const themeList = themes.map(t =>
          t.name === active.name ? `  * ${t.name} (${t.type})` : `    ${t.name} (${t.type})`
        ).join('\n');
        appendMessage({
          role: 'assistant' as const,
          content: `Available themes:\n${themeList}\n\nActive: ${active.name}\nUsage: /theme <name>`,
        });
      }
      return;
    }
    // /reset 命令 — 重置当前 workflow 状态
    if (command?.name === 'reset') {
      workflowCoordinatorRef.current?.interrupt()
      workflowCoordinatorRef.current?.reset()
      dualRuntimeRef.current?.reset()

      workflowRunningRef.current = false

      if (workflowMode === 'loop') {
        setWorkflowLifecycle({ status: 'awaiting_goal' })
      } else {
        setWorkflowLifecycle({ status: 'idle' })
      }

      setWorkflowState(prev => ({
        ...prev,
        phase: 'idle',
        goal: '',
        iteration: 0,
        supervisorStatus: 'idle',
        workerStatus: 'idle',
      }))

      appendMessage({
        role: 'assistant' as const,
        content: workflowMode === 'loop'
          ? t().workflowResetLoop
          : t().workflowReset,
      })
      return
    }
    // /alone /subagent /loop — quick mode switch aliases
    if (command?.name === 'alone' || command?.name === 'subagent' || command?.name === 'loop') {
      if (workflowMode === 'loop' && command.name !== 'loop') {
        workflowCoordinatorRef.current?.interrupt();
        workflowCoordinatorRef.current?.reset();
        dualRuntimeRef.current?.reset();
      }
      setWorkflowMode(command.name);
      saveTuiSettings({ workflowMode: command.name });
      if (command.name === 'loop') {
        setWorkflowLifecycle({ status: 'awaiting_goal' });
        setWorkflowState(prev => ({ ...prev, phase: 'idle', goal: '', iteration: 0, supervisorStatus: 'idle', workerStatus: 'idle' }));
      } else {
        setWorkflowLifecycle({ status: 'idle' });
        setWorkflowState(prev => ({ ...prev, phase: 'idle', goal: '', iteration: 0, supervisorStatus: 'idle', workerStatus: 'idle' }));
      }
      appendMessage({ role: 'assistant' as const, content: `Mode switched to: ${command.name}` });
      return;
    }
    // /eval 命令 — 模式切换（无 flags）或旧版多模型自动测评（--legacy / --models）
    if (command?.name === 'eval') {
      if (!command.legacy && !command.models && !command.cases) {
        setWorkflowMode('eval')
        saveTuiSettings({ workflowMode: 'eval' })
        setWorkflowLifecycle({ status: 'idle' })
        setWorkflowState(prev => ({ ...prev, phase: 'idle', goal: '', iteration: 0, supervisorStatus: 'idle', workerStatus: 'idle' }))
        appendMessage({
          role: 'assistant' as const,
          content: 'Eval mode active. Use /cases to select a test suite. Use /talk worker or /talk supervisor to choose conversation target. Use /eval-cancel or double Esc/Ctrl+C to abort a running eval.',
        })
        return
      }

      const defaultModels = (() => {
        const rc = roleConfigRef.current
        const workerTarget = `${rc.worker.provider}/${rc.worker.model}`
        const freeTargets = FREE_MODEL_TARGETS.map(t => `${t.provider}/${t.model}`)
        return [workerTarget, ...freeTargets.filter(t => t !== workerTarget)]
      })()
      const models = command.models ?? defaultModels
      const caseTags = command.cases ?? ['smoke', 'easy']
      const limit = command.limit ?? 3
      const dryRun = command.dryRun ?? false
      const selectedCases: import('@covalo/core').AgentBenchmarkCase[] = selectBenchmarkCases(caseTags)
      const effectiveLimit = dryRun ? (limit > 0 ? limit : selectedCases.length) : (limit > 0 ? limit : selectedCases.length)
      const finalCases = selectedCases.slice(0, effectiveLimit)
      const totalRuns = models.length * finalCases.length

      if (dryRun) {
        const lines = [
          t().evalDryRunHeader,
          `  models: ${models.join(', ')}`,
          `  cases: ${finalCases.map(c => c.id).join(', ')}`,
          `  totalRuns: ${totalRuns}`,
        ]
        appendMessage({ role: 'assistant' as const, content: lines.join('\n') })
        return
      }

      if (totalRuns === 0) {
        appendMessage({ role: 'assistant' as const, content: t().evalNoModels })
        return
      }

      setTUIState('loading')
      const rc = roleConfigRef.current
      const supervisorTarget = `${rc.supervisor.provider}/${rc.supervisor.model}`
      const { value: workerApiKey } = resolveApiKey(rc.worker.provider)
      const workerConfig = {
        provider: rc.worker.provider,
        model: rc.worker.model,
        baseUrl: rc.worker.baseUrl || config.baseUrl || '',
        apiKey: workerApiKey ?? '',
      }
      appendMessage({ role: 'assistant' as const, content: t().evalStarted(models.length, finalCases.length, totalRuns) })

      bridgeRef.current.runEval(
        { models, cases: finalCases, limit: effectiveLimit, dryRun: false, supervisorModelTarget: supervisorTarget },
        workerConfig,
        (progress) => {
          if (progress.status === 'running' && progress.caseId !== 'setup') {
            const msg = t().evalProgress(progress.index ?? 0, progress.total ?? 0, progress.workerModelTarget ?? '', progress.caseId ?? '')
            appendMessage({ role: 'assistant' as const, content: msg })
          } else if (progress.status === 'skipped') {
            const msg = t().evalSkipped(progress.index ?? 0, progress.total ?? 0, progress.workerModelTarget ?? '', progress.caseId ?? '', progress.reason ?? '')
            appendMessage({ role: 'assistant' as const, content: msg })
          } else if ((progress.status === 'passed' || progress.status === 'failed') && progress.score) {
            const msg = t().evalProgress(progress.index ?? 0, progress.total ?? 0, progress.workerModelTarget ?? '', progress.caseId ?? '', progress.score.overallScore, progress.score.grade)
            appendMessage({ role: 'assistant' as const, content: msg })
          }
        },
      ).then((result) => {
        const leaderboardLines = result.leaderboard.map((entry, i) =>
          `  ${i + 1}. ${entry.workerModelTarget} score=${entry.averageScore.toFixed(1)} verification=${(entry.verificationPassRate * 100).toFixed(0)}% runs=${entry.runs}`,
        )
        const msg = [
          t().evalComplete(result.evalRunId),
          '',
          t().evalLeaderboardHeader,
          ...leaderboardLines,
          '',
          t().evalReportPath(result.reportDir),
        ].join('\n')
        appendMessage({ role: 'assistant' as const, content: msg })
      }).catch((err: unknown) => {
        appendMessage({ role: 'assistant' as const, content: `Eval error: ${err instanceof Error ? err.message : String(err)}` })
      }).finally(() => {
        setTUIState('idle')
      })
      return
    }
    // /eval-start — 固定评测模式：运行指定 category/suite
    if (command?.name === 'eval-start') {
      setWorkflowMode('eval');
      void startFixedEval(command.category, command.suite, command.env)
      return
    }
    // /eval-cancel — 取消固定评测（复用 cancelActiveEval，确保与 Ctrl+C/双 Esc 一致）
    if (command?.name === 'eval-cancel') {
      if (cancelActiveEval()) {
        appendMessage({ role: 'assistant' as const, content: 'Eval cancelled.' })
      } else {
        appendMessage({ role: 'assistant' as const, content: 'No eval is currently running.' })
      }
      return
    }
    // /cases — 打开评测用例选择器
    if (command?.name === 'cases') {
      if (workflowMode !== 'eval') {
        setWorkflowMode('eval')
        saveTuiSettings({ workflowMode: 'eval' })
        setWorkflowLifecycle({ status: 'idle' })
        setWorkflowState(prev => ({ ...prev, phase: 'idle', goal: '', iteration: 0, supervisorStatus: 'idle', workerStatus: 'idle' }))
      }
      setShowEvalWizard(true)
      return
    }
    // DA-R6: /talk 命令 — 切换输入目标角色
    if (command?.name === 'talk') {
      if (command.role) {
        setActiveRole(command.role);
        appendMessage({
          role: 'assistant' as const,
          content: t().inputTargetSwitched(command.role),
        });
      } else {
        // Toggle between worker and supervisor
        const newRole = activeRole === 'worker' ? 'supervisor' : 'worker';
        setActiveRole(newRole);
        appendMessage({
          role: 'assistant' as const,
          content: t().inputTargetSwitched(newRole),
        });
      }
      return;
    }
    // /config 命令 — 配置管理
    if (command?.name === 'config') {
      void (async () => {
        const { ConfigManager } = await import('@covalo/core');
        const configManager = await ConfigManager.create({ cwd: process.cwd() });
        const configPath = configManager.getProjectConfigPath();

        if (command.subcommand === 'open') {
          appendMessage({ role: 'assistant' as const, content: t().configOpen(configPath) });
          // 打开编辑器 — 使用 spawnSync 而非 execSync 防止 shell 注入
          const { spawnSync } = await import('child_process');
          const editorEnv = process.env.EDITOR || 'vi';
          const editorParts = editorEnv.split(/\s+/);
          const editorCmd = editorParts[0]!;
          const editorArgs = [...editorParts.slice(1), configPath];
          try {
            spawnSync(editorCmd, editorArgs, { stdio: 'inherit' });
            // 编辑后重新加载
            await configManager.reload();
            appendMessage({ role: 'assistant' as const, content: t().configReloaded });
          } catch {
            appendMessage({ role: 'assistant' as const, content: t().configError('Failed to open editor') });
          }
        } else if (command.subcommand === 'reload') {
          await configManager.reload();
          appendMessage({ role: 'assistant' as const, content: t().configReloaded });
        } else if (command.subcommand === 'set' && command.path && command.value) {
          // 解析路径: workflow.max_rounds -> { section: 'workflow', key: 'max_rounds' }
          const dotIndex = command.path.indexOf('.');
          if (dotIndex === -1) {
            appendMessage({ role: 'assistant' as const, content: t().configError('Invalid format. Use: /config <section>.<key> <value>') });
          } else {
            const section = command.path.slice(0, dotIndex);
            const key = command.path.slice(dotIndex + 1);
            const value = command.value;
            try {
              const config = configManager.get();
              const sectionValue = config[section as keyof typeof config];
              if (sectionValue === undefined || sectionValue === null) {
                appendMessage({ role: 'assistant' as const, content: t().configError(`Unknown section: ${section}`) });
              } else if (typeof sectionValue !== 'object' || Array.isArray(sectionValue)) {
                appendMessage({ role: 'assistant' as const, content: t().configError(`Section '${section}' is not an object`) });
              } else {
                // 类型转换
                let parsed: unknown = value;
                if (value === 'true') parsed = true;
                else if (value === 'false') parsed = false;
                else if (!isNaN(Number(value))) parsed = Number(value);
                
                (sectionValue as Record<string, unknown>)[key] = parsed;
                configManager.update(config, 'tui');
                await configManager.saveProjectConfig();
                appendMessage({ role: 'assistant' as const, content: t().configSet(command.path, value) });
              }
            } catch (e) {
              appendMessage({ role: 'assistant' as const, content: t().configError(String(e)) });
            }
          }
        } else if (command.path) {
          // 显示某个 section 的配置
          const config = configManager.get();
          const sectionValue = config[command.path as keyof typeof config];
          if (sectionValue !== undefined && sectionValue !== null) {
            appendMessage({ 
              role: 'assistant' as const, 
              content: t().configAll(JSON.stringify(sectionValue, null, 2))
            });
          } else {
            appendMessage({ role: 'assistant' as const, content: t().configError(`Unknown section: ${command.path}`) });
          }
        } else {
          // /config — 显示当前配置文件路径
          appendMessage({ role: 'assistant' as const, content: t().configCurrent(configPath) });
        }
      })();
      return;
    }
    // /goal 已移除 - goal 管理现在由 supervisor 工具完成
    // /workflow 已移除 - 使用 /alone /subagent /loop /eval 直接切换

    // Unknown slash command rejection
    if (submitted.startsWith('/') && !command) {
      appendMessage({
        role: 'assistant' as const,
        content: `Unknown command: ${submitted.trim()}`,
      })
      return
    }

    // SFR-50: 使用统一模式路由器
    const inputKind = command ? 'command' : 'text';
    const lifecycle = workflowLifecycleRef.current;
    const route = routeWorkflowInput({ mode: workflowMode, lifecycle, activeRole, input: submitted, inputKind });

    switch (route.type) {
      case 'direct': {
        const taggedSkillNames = extractSkillTags(submitted);
        if (taggedSkillNames.length === 0) {
          scrollRef.current?.scrollToBottom();
          bridge.submit(submitted, false, route.role, route.mode);
          return;
        }
        void (async () => {
          const previousSkills = engineRef.current.getActiveSkills();
          const taggedSkills = await loadTaggedSkills(taggedSkillNames);
          const merged = [
            ...previousSkills.filter(skill => !taggedSkills.some(tagged => tagged.name === skill.name)),
            ...taggedSkills,
          ];
          engineRef.current.setActiveSkills(merged);
          scrollRef.current?.scrollToBottom();
          try {
            await bridge.submit(submitted, false, route.role, route.mode);
          } finally {
            engineRef.current.setActiveSkills(previousSkills);
          }
        })();
        return;
      }
      case 'supervisor_task': {
        // subagent 模式：固定发给 Supervisor
        scrollRef.current?.scrollToBottom();
        bridge.submit(submitted, false, 'supervisor', route.mode);
        return;
      }
      case 'start_workflow': {
        const goal = route.goal;
        // SFR-70: 防止在 Workflow 运行时重复启动
        if (workflowRunningRef.current) {
          appendMessage({
            role: 'assistant' as const,
            content: t().workflowAlreadyRunning,
          });
          return;
        }
        workflowRunningRef.current = true;
        // Phase B: loop start = goal creation
        const goalStore = new GoalStore();
        const sessionId = engineRef.current.getSessionId();
        try { goalStore.createGoal(sessionId, goal); } catch { goalStore.replaceGoal(sessionId, goal); }
        const workflowId = sessionId;
        setWorkflowLifecycle({ status: 'running', workflowId });
        const workflowMaxRounds =
          workflowCoordinatorRef.current?.getConfig().maxRounds
          ?? DEFAULT_WORKFLOW_CONFIG.maxRounds
        setWorkflowState({
          phase: 'supervisor_analyse',
          iteration: 1,
          maxRounds: workflowMaxRounds,
          goal,
          supervisorStatus: 'analyse',
          workerStatus: 'idle',
        });
        scrollRef.current?.scrollToBottom();
        bridge.runWorkflow(goal, (phase: string, iteration: number, finalStatus?: string, reason?: string) => {
          if (finalStatus) {
            setWorkflowLifecycle({ status: finalStatus as WorkflowLifecycle['status'], workflowId, reason } as WorkflowLifecycle);
            return;
          }
          if (phase === 'waiting_user') {
            setWorkflowLifecycle({ status: 'waiting_user', workflowId })
          } else if (workflowLifecycleRef.current.status === 'waiting_user') {
            setWorkflowLifecycle({ status: 'running', workflowId })
          }
          const phaseMap: Record<string, { supervisor: WorkflowState['supervisorStatus']; worker: WorkflowState['workerStatus'] }> = {
            supervisor_analyse: { supervisor: 'analyse', worker: 'idle' },
            supervisor_check: { supervisor: 'analyse', worker: 'idle' },
            supervisor_intervene: { supervisor: 'analyse', worker: 'do' },
            worker_do: { supervisor: 'analyse', worker: 'do' },
            worker_report: { supervisor: 'waiting', worker: 'report' },
            waiting_user: { supervisor: 'waiting', worker: 'idle' },
            blocked: { supervisor: 'blocked', worker: 'blocked' },
          };
          const mapped = phaseMap[phase] ?? { supervisor: 'idle' as const, worker: 'idle' as const };
          setWorkflowState(prev => ({
            ...prev,
            phase: phase as WorkflowPhase,
            iteration,
            supervisorStatus: mapped.supervisor,
            workerStatus: mapped.worker,
          }));
        }, workflowId).catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err)
          const failedWorkflowId = getWorkflowIdFromError(err) ?? workflowId
          setWorkflowLifecycle({ status: 'failed', workflowId: failedWorkflowId, reason })
        }).finally(() => {
          workflowRunningRef.current = false;
        });
        return;
      }
      case 'resume_workflow': {
        if (workflowRunningRef.current) {
          appendMessage({
            role: 'assistant' as const,
            content: t().workflowAlreadyRunning,
          })
          return;
        }
        const workflowId = lifecycle.status === 'blocked' ? lifecycle.workflowId : `wf-${Date.now()}`;
        workflowRunningRef.current = true;
        setWorkflowLifecycle({ status: 'running', workflowId });
        scrollRef.current?.scrollToBottom();
        bridge.resumeWorkflow(route.instruction, (phase: string, iteration: number, finalStatus?: string, reason?: string) => {
          if (finalStatus) {
            setWorkflowLifecycle({ status: finalStatus as WorkflowLifecycle['status'], workflowId, reason } as WorkflowLifecycle);
            return;
          }
          if (phase === 'waiting_user') {
            setWorkflowLifecycle({ status: 'waiting_user', workflowId })
          } else if (workflowLifecycleRef.current.status === 'waiting_user') {
            setWorkflowLifecycle({ status: 'running', workflowId })
          }
          const phaseMap: Record<string, { supervisor: WorkflowState['supervisorStatus']; worker: WorkflowState['workerStatus'] }> = {
            supervisor_analyse: { supervisor: 'analyse', worker: 'idle' },
            supervisor_check: { supervisor: 'analyse', worker: 'idle' },
            supervisor_intervene: { supervisor: 'analyse', worker: 'do' },
            worker_do: { supervisor: 'analyse', worker: 'do' },
            worker_report: { supervisor: 'waiting', worker: 'report' },
            waiting_user: { supervisor: 'waiting', worker: 'idle' },
            blocked: { supervisor: 'blocked', worker: 'blocked' },
          };
          const mapped = phaseMap[phase] ?? { supervisor: 'idle' as const, worker: 'idle' as const };
          setWorkflowState(prev => ({
            ...prev,
            phase: phase as WorkflowPhase,
            iteration,
            supervisorStatus: mapped.supervisor,
            workerStatus: mapped.worker,
          }));
        }).catch((err: unknown) => {
          const reason = err instanceof Error ? err.message : String(err)
          const failedWorkflowId = getWorkflowIdFromError(err) ?? workflowId
          setWorkflowLifecycle({ status: 'failed', workflowId: failedWorkflowId, reason })
        }).finally(() => {
          workflowRunningRef.current = false;
        });
        return;
      }
      case 'workflow_instruction': {
        bridge.addWorkflowInstruction(route.content);
        appendMessage({
          role: 'assistant' as const,
          content: t().workflowInstructionQueued(route.content),
        });
        return;
      }
      case 'reject': {
        appendMessage({
          role: 'assistant' as const,
          content: route.reason,
        });
        return;
      }
    }
  }, [activeAgent, activeRole, appendMessage, bridge, thinkingMode, workflowMode]);

  /** Agent 切换回调：针对当前 activeRole 绑定。对相应 engine 调 switchAgent，并持久化到 agents.json */
  const handleAgentChoose = useCallback((next: string) => {
    // 目标 engine：supervisor role 且 dualRuntime 可用时取 supervisor engine，否则 worker engine
    const targetEngine = (activeRole === 'supervisor' && dualRuntime)
      ? dualRuntime.getSupervisor().getEngine()
      : engineRef.current;
    const label = targetEngine.switchAgent(next);
    // 只更新当前 role 的绑定状态（另一 role 不受影响）
    setAgentByRole(prev => ({ ...prev, [activeRole]: next }));
    // 持久化 per-role agent 绑定到 agents.json
    const updated = updateAgentProfile(agentProfiles, activeRole, { agent: next });
    setAgentProfiles(updated);
    saveAgentProfiles(updated);
    setShowAgentMenu(false);
    const roleLabel = activeRole === 'supervisor' ? ' [supervisor]' : ' [worker]';
    appendMessage({ role: 'assistant' as const, content: `${t().switchedTo(label)}${roleLabel}` });
  }, [appendMessage, activeRole, dualRuntime, agentProfiles]);

  /** 语言切换回调：同步 TUI locale + core prompt locale + 持久化 */
  const handleLangChoose = useCallback((next: string) => {
    const nextLocale = next as Locale;
    setLocale(nextLocale);
    setLocaleState(nextLocale);
    // Sync core prompt locale
    const coreLocale = nextLocale === 'zh-CN' ? 'zh-CN' : 'en';
    setPromptLocale(coreLocale);
    savePromptLocaleToDisk(coreLocale);
    setShowLangMenu(false);
    appendMessage({ role: 'assistant' as const, content: dicts[nextLocale].switchedLang(next) });
    // Rebuild both engines' base system prompts via callback
    onPromptLocaleChange?.(coreLocale);
  }, [appendMessage, onPromptLocaleChange]);

  /** 推理档位选择回调：更新本地 thinkingMode 并清除 reasoningActive */
  const handleThinkingChoose = useCallback((mode: string) => {
    const error = validateThinkingMode(mode);
    if (error) {
      appendMessage({ role: 'assistant' as const, content: `${error}\nCurrent: ${thinkingMode}` });
      return;
    }
    saveTuiSettings({ thinkingMode: mode });
    setThinkingMode(mode);
    setBridgeState(prev => ({ ...prev, reasoningActive: false }));
    setShowThinkingMenu(false);
    appendMessage({ role: 'assistant' as const, content: `Thinking mode set to: ${mode}` });
  }, [appendMessage, thinkingMode]);

  /** 模型选择回调：按当前 activeRole 更新对应引擎配置并持久化（per-role） */
  const handleModelSelect = useCallback((sel: { provider: string; model: string; apiKey: string; baseUrl: string }) => {
    const contextWindow = getModelContextWindow(sel.provider, sel.model);
    // 目标引擎：supervisor role 且 dualRuntime 可用时取 supervisor engine，否则 worker engine
    const targetEngine = (activeRole === 'supervisor' && dualRuntime)
      ? dualRuntime.getSupervisor().getEngine()
      : engineRef.current;
    targetEngine.updateConfig({
      provider: sel.provider,
      model: sel.model,
      apiKey: sel.apiKey,
      baseUrl: sel.baseUrl,
      contextWindow,
    });
    // 只更新当前 role 的配置状态（另一 role 不受影响）
    setRoleConfig(prev => ({ ...prev, [activeRole]: { provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl } }));
    // per-role 持久化（role-config.json）；同时写 last-config.json 作为全局 fallback
    saveRoleConfig(activeRole, { provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl });
    saveLastConfig({ provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl });
    setShowModelPicker(false);
    const roleLabel = activeRole === 'supervisor' ? ' [supervisor]' : '';
    appendMessage({ role: 'assistant' as const, content: `${t().switchedModel(PROVIDERS[sel.provider]?.label ?? sel.provider, sel.model)}${roleLabel}` });
  }, [appendMessage, activeRole, dualRuntime]);

  /** 模型选择取消回调：关闭选择器覆盖层 */
  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false);
  }, []);

  /** 会话选择回调：加载指定会话的消息并重置 bridge 状态 */
  const handleSessionSelect = useCallback(async (sessionId: string) => {
    setShowSessionPicker(false);
    // Load session messages into the current engine
    const msgs = await engineRef.current.loadSession(sessionId);
    // Guard against post-unmount setState
    if (!mountedRef.current) return;
    // WF-FIX-60: Also load session on supervisor engine for dual-runtime consistency
    if (dualRuntime) {
      dualRuntime.loadSupervisorSession(sessionId).catch(() => {});
    }
    const recoveredTimeline = timelineFromMessages(msgs);
    setBridgeState({
      ...initialState,
      ...(isTranscriptStoreEnabled() ? {} : { timeline: recoveredTimeline }),
    });
    bridgeRef.current.resetBridgeRuntime();
    bridgeRef.current.replaceTranscript(recoveredTimeline);
    // TUI-FIX-20: 重置编排状态
    orchestrationStore.reset();
    appendMessage({ role: 'assistant' as const, content: t().resumedSession(sessionId.slice(0, 8), msgs.length) });
  }, [appendMessage, orchestrationStore, dualRuntime]);

  /** 会话选择取消回调：关闭选择器覆盖层 */
  const handleSessionCancel = useCallback(() => {
    setShowSessionPicker(false);
  }, []);

  /** 权限请求回调：向引擎传递用户的允许/拒绝决策 */
  const handlePermissionSelect = useCallback((reply: 'once' | 'always' | 'reject', message?: string) => {
    bridgeRef.current.respondPermission(reply, message);
  }, []);

  const handleQuestionReply = useCallback((requestId: string, answers: string[][]) => {
    bridgeRef.current.respondQuestion(requestId, answers);
  }, []);

  const handleQuestionReject = useCallback((requestId: string) => {
    bridgeRef.current.rejectQuestion(requestId);
  }, []);

  const providerLabel = getProviderLabel(activeProvider);

  // ---- 覆盖层：模型选择器（当 showModelPicker 为 true 时显示） ----
  if (showModelPicker) {
    return (
      <CenteredStage width={88}>
        <ModelPicker
          currentProvider={activeProvider}
          currentModel={activeModel}
          onSelect={handleModelSelect}
          onCancel={handleModelCancel}
        />
      </CenteredStage>
    );
  }

  // ---- 覆盖层：会话恢复选择器（当 showSessionPicker 为 true 时显示） ----
  if (showSessionPicker) {
    return (
      <CenteredStage width={92}>
        <SessionPicker
          onSelect={handleSessionSelect}
          onCancel={handleSessionCancel}
        />
      </CenteredStage>
    );
  }

  // ---- 覆盖层：Agent 切换菜单（当 showAgentMenu 为 true 时显示） ----
  if (showAgentMenu) {
    const agentItems = defaultAgentRegistry.list().map((a: { name: string; label: string; systemPrompt?: string }) => ({
      value: a.name,
      label: a.label,
      description: a.systemPrompt ? a.systemPrompt.slice(0, 80).replace(/\n/g, " ") : "",
    }))
    if (agentItems.length === 0) {
      agentItems.push(
        { value: "worker", label: "Worker", description: t().harnessStrictDesc },
        { value: "supervisor", label: "Supervisor", description: t().harnessNormalDesc },
      )
    }
    return (
      <ChoiceMenu
        title={t().agentMenuTitle(activeRole)}
        subtitle={t().agentMenuSubtitle(activeRole)}
        items={agentItems}
        onChoose={handleAgentChoose}
        onCancel={() => setShowAgentMenu(false)}
      />
    );
  }

  // ---- 覆盖层：语言切换菜单（当 showLangMenu 为 true 时显示） ----
  if (showLangMenu) {
    const langItems = [
      { value: "zh-CN" as const, label: "中文", description: dicts['zh-CN'].welcomeLangHint },
      { value: "en" as const, label: "English", description: dicts['en'].welcomeLangHint },
    ]
    const lang = locale;
    return (
      <ChoiceMenu
        title="Language"
        subtitle={lang === 'zh-CN' ? '选择界面语言' : 'Select interface language'}
        items={langItems.map(i => ({ value: i.value, label: i.label, description: i.description }))}
        onChoose={handleLangChoose}
        onCancel={() => setShowLangMenu(false)}
      />
    );
  }

  // ---- 覆盖层：推理档位选择菜单（当 showThinkingMenu 为 true 时显示） ----
  const thinkingDescs = locale === 'zh-CN'
    ? ['关闭推理', '开启推理', '强推理 (DeepSeek)']
    : ['disable reasoning', 'enable reasoning', 'strong reasoning (DeepSeek)'];
  if (showThinkingMenu) {
    return (
      <ChoiceMenu
        title="Thinking"
        subtitle={locale === 'zh-CN' ? '选择推理档位' : 'Select thinking mode'}
        items={[
          { value: "off", label: "off", description: thinkingDescs[0] },
          { value: "open", label: "open", description: thinkingDescs[1] },
          { value: "high", label: "high", description: thinkingDescs[2] },
        ]}
        onChoose={handleThinkingChoose}
        onCancel={() => setShowThinkingMenu(false)}
      />
    );
  }

  // ---- 覆盖层：Harness 严格度选择菜单（当 showHarnessMenu 为 true 时显示） ----
  if (showHarnessMenu) {
    return (
      <ChoiceMenu
        title="Harness strictness"
        subtitle={locale === 'zh-CN' ? `当前：${harnessStrictness} (${harnessSource})\n自下次提交起生效` : `Current: ${harnessStrictness} (${harnessSource})\nApplies from: next submission`}
        items={[
          { value: "strict", label: "strict", description: t().harnessStrictDesc },
          { value: "normal", label: "normal", description: t().harnessNormalDesc },
          { value: "loose", label: "loose", description: t().harnessLooseDesc },
        ]}
        onChoose={(value) => {
          const strictness = value as 'strict' | 'normal' | 'loose';
          setHarnessStrictness(strictness);
          setHarnessSource('session');
          engineRef.current.setHarnessStrictness(strictness);
          setShowHarnessMenu(false);
          appendMessage({
            role: 'assistant' as const,
            content: t().harnessSetTo(strictness),
          });
        }}
        onCancel={() => setShowHarnessMenu(false)}
        footer={t().harnessFooter}
      />
    );
  }

  // ---- 覆盖层：Eval 评测向导（当 showEvalWizard 为 true 时显示） ----
  if (showEvalWizard) {
    return (
      <EvalWizard
        onDone={() => {
          setShowEvalWizard(false);
        }}
        onStart={(categoryId: string, suiteId: string, environmentId) => {
          setShowEvalWizard(false);
          void startFixedEval(categoryId, suiteId, environmentId);
        }}
      />
    );
  }

    // ---- 覆盖层：工作流模式选择菜单（当 showWorkflowMenu 为 true 时显示） ----
  const wfRunningSuffix = workflowLifecycle.status === 'running' ? t().workflowInterruptRunning : '';
  if (showWorkflowMenu) {
    return (
      <ChoiceMenu
        title="Workflow / Mode"
        subtitle={locale === 'zh-CN' ? `当前：${workflowMode}\n模式切换后立即生效` : `Current: ${workflowMode}`}
        items={[
          { value: "alone", label: "alone", description: t().workflowMenuAlone(wfRunningSuffix) },
          { value: "subagent", label: "subagent", description: t().workflowMenuSubagent(wfRunningSuffix) },
          { value: "loop", label: "loop", description: t().workflowMenuLoop(wfRunningSuffix) },
          { value: "eval", label: "eval  ⭐", description: "Enter eval mode; use /cases to choose tests" },
        ]}
        onChoose={(value) => {
          const mode = value as WorkflowMode;
          if (mode === 'eval') {
            setWorkflowMode('eval')
            saveTuiSettings({ workflowMode: 'eval' })
            setWorkflowLifecycle({ status: 'idle' })
            setWorkflowState(prev => ({ ...prev, phase: 'idle', goal: '', iteration: 0, supervisorStatus: 'idle', workerStatus: 'idle' }))
            setShowWorkflowMenu(false);
            appendMessage({
              role: 'assistant' as const,
              content: 'Eval mode active. Use /cases to select a test suite.',
            });
            return;
          }
          restoreScrollAfterWorkflowMenuRef.current = true;
          if (workflowMode === 'loop' && mode !== 'loop') {
            workflowCoordinator?.interrupt();
            workflowCoordinator?.reset();
            dualRuntime?.reset();
          }
          setWorkflowMode(mode);
          saveTuiSettings({ workflowMode: mode });
          setShowWorkflowMenu(false);
          if (mode === 'loop') {
            setWorkflowLifecycle({ status: 'awaiting_goal' });
            setWorkflowState(prev => ({ ...prev, phase: 'idle', goal: '', iteration: 0, supervisorStatus: 'idle', workerStatus: 'idle' }));
            appendMessage({
              role: 'assistant' as const,
              content: t().workflowLoopStarted,
            });
          } else {
            setWorkflowLifecycle({ status: 'idle' });
            setWorkflowState(prev => ({ ...prev, phase: 'idle', goal: '', iteration: 0, supervisorStatus: 'idle', workerStatus: 'idle' }));
            appendMessage({
              role: 'assistant' as const,
              content: t().workflowModeChanged(mode),
            });
          }
        }}
        onCancel={() => {
          restoreScrollAfterWorkflowMenuRef.current = true;
          setShowWorkflowMenu(false);
        }}
      />
    );
  }

  // ---- 覆盖层：技能管理弹窗（当 showSkillModal 为 true 时显示） ----
  if (showSkillModal) {
    return (
      <SkillModal
        activeSkills={activeSkills}
        onChange={(skills) => {
          setActiveSkills(skills);
          engineRef.current.setActiveSkills(skills);
          saveTuiSettings({ activeSkills: skills });
        }}
        onInsertSkill={(skillName) => {
          const text = `#${skillName} `;
          setInputInjection(prev => ({ id: (prev?.id ?? 0) + 1, text }));
          setInputText(text);
          setShowSkillModal(false);
        }}
        onClose={() => setShowSkillModal(false)}
      />
    );
  }

  // ---- 覆盖层：上下文策略管理弹窗（当 showContextModal 为 true 时显示） ----
  if (showContextModal) {
    return (
      <ContextModal
        policy={contextPolicy}
        loadStatus={() => engineRef.current.getContextPolicyStatus()}
        onPolicyChange={async (policy) => {
          await engineRef.current.setContextPolicy(policy);
          setContextPolicy(engineRef.current.getContextPolicy());
        }}
        onRunReduction={() => engineRef.current.runContextReduction()}
        onClose={() => setShowContextModal(false)}
      />
    );
  }

  // ---- 主内容区（可滚动区域）：消息时间线、搜索结果、欢迎屏、警告/错误提示、权限请求弹窗 ----
  const timelineProp = isTranscriptStoreEnabled() ? undefined : bridgeState.timeline;
  const scrollableContent = (
    <>
      <SearchOverlay
        timeline={timelineProp}
        isOpen={showSearch}
        onClose={() => setShowSearch(false)}
      />
      {/* TUI-FIX-40: Agent 活动组（展开时显示详细进度） */}
      <AgentGroupDisplayFromStore terminalWidth={process.stdout.columns ?? 80} />
      {/* DA-R6: 双角色 Tab 指示器已移除；Tab 切换交互保留（见 useInput），
          当前角色由底部 WorkflowStatusBar 显示 */}
      <DeepiMessages
        timeline={timelineProp}
        scrollRef={scrollRef}
      />
      {/* TUI-GM: Loading 指示器（Gemini CLI 风格） */}
      <LoadingIndicator
        streamingState={bridgeSplit ? 'idle' : bridgeState.isLoading ? 'responding' : 'idle'}
      />
      <WelcomeWhenEmpty
        legacyEmpty={bridgeState.timeline.length === 0}
        isLoading={bridgeSplit ? undefined : bridgeState.isLoading}
        error={bridgeSplit ? undefined : bridgeState.error}
      >
        <WelcomeScreen
          model={activeModel}
          provider={providerLabel}
          agent={AGENTS[activeAgent]?.label ?? defaultAgentRegistry.get(activeAgent)?.label ?? activeAgent}
          thinkingMode={thinkingMode}
          contextMode={contextPolicy.mode}
          skillCount={activeSkills.length}
          pluginCount={pluginCount}
          contentPackCount={contentPackCount}
          assetCounts={assetCounts ?? { skills: 0, agents: 0, rules: 0, commands: 0, mcp: 0, hooks: 0 }}
          diagnosticCounts={diagnosticCounts ?? { errors: 0, warnings: 0 }}
        />
      </WelcomeWhenEmpty>
      {/* TUI-FIX-50: DialogManager 集中管理权限和追问弹窗 */}
      <DialogManager
        permissionRequest={bridgeSplit ? null : bridgeState.permissionPrompt}
        questionRequest={bridgeSplit ? null : bridgeState.questionPrompt}
        onPermissionReply={handlePermissionSelect}
        onQuestionReply={handleQuestionReply}
        onQuestionReject={handleQuestionReject}
        terminalWidth={process.stdout.columns ?? 80}
      />
      <BridgeScrollAlerts
        onPermissionSelect={handlePermissionSelect}
        onQuestionReply={handleQuestionReply}
        onQuestionReject={handleQuestionReject}
        legacy={bridgeSplit ? undefined : {
          warnings: bridgeState.warnings,
          error: bridgeState.error,
          permissionPrompt: null,  // handled by DialogManager
          questionPrompt: null,    // handled by DialogManager
        }}
      />
    </>
  );

  // ---- 底部区域（固定定位）：Workflow 状态栏、命令自动补全、输入框、状态栏 ----
  const bottomContent = (
    <Box flexDirection="column" width="100%">
      {/* DA-R6: Workflow 状态栏 - 固定在输入框正上方 */}
    <WorkflowStatusBar
      workflow={workflowState}
      lifecycle={workflowLifecycle}
      activeRole={activeRole}
      workflowMode={workflowMode}
      width={process.stdout.columns ?? 80}
    />
      {showAutocomplete && (
        <CommandAutocomplete
          query={inputText}
          onSubmit={(cmd) => {
            promptInputRef.current?.writeText('');
            setInputText('');
            setShowAutocomplete(false);
            handleSubmit(cmd);
          }}
          onComplete={(cmd) => {
            promptInputRef.current?.writeText(cmd + ' ');
            setShowAutocomplete(false);
          }}
          onClose={() => setShowAutocomplete(false)}
        />
      )}
      <BridgeDeepiPromptInput
        ref={promptInputRef}
        onSubmit={handleSubmit}
        history={inputHistory}
        injectedText={inputInjection}
        onChange={(text) => {
          setInputText(text);
          setShowAutocomplete(text.startsWith('/') && !text.includes(' '));
        }}
        onCancel={handleCancel}
        suppressHistory={showAutocomplete}
        suppressSubmit={showAutocomplete}
        legacy={bridgeSplit ? undefined : {
          isLoading: bridgeState.isLoading,
          disabled: !!bridgeState.permissionPrompt || !!bridgeState.questionPrompt,
          queueCount: bridgeState.messageQueue.length,
        }}
      />
      <BridgeStatusBar
        model={activeModel}
        provider={providerLabel}
        agent={AGENTS[activeAgent]?.label ?? defaultAgentRegistry.get(activeAgent)?.label ?? activeAgent}
        contextTotal={contextTotal}
        statusMessage={statusMessage}
        thinkingMode={thinkingMode}
        cwd={process.cwd()}
        legacy={bridgeSplit ? undefined : {
          inputTokens: bridgeState.tokens.input,
          outputTokens: bridgeState.tokens.output,
          cacheHitTokens: bridgeState.tokens.cacheHit,
          cacheMissTokens: bridgeState.tokens.cacheMiss,
          contextUsed: bridgeState.contextUsage,
          pendingInstructionCount: bridgeState.pendingInstructionCount,
          reasoningActive: bridgeState.reasoningActive,
        }}
      />
    </Box>
  );

  const appContent = (inner: React.ReactNode) => (
    <LocaleProvider locale={locale} onLocaleChange={setLocaleState}>
      {inner}
    </LocaleProvider>
  );

  if (isFullscreenEnvEnabled()) {
    return appContent(
      <BridgeRuntimeProvider runtime={bridgeRuntime}>
        <TranscriptProvider reader={transcriptReader}>
          <OrchestrationStoreProvider store={orchestrationStore}>
          {/* Alternate Screen 没有原生 scrollback；鼠标跟踪用于驱动消息区 ScrollBox。
              默认 wheel-only（滚轮滚动历史，不拦截终端文本选择）。 */}
          <AlternateScreen mouseTracking={getMouseTrackingMode() === 'off' ? false : getMouseTrackingMode() === 'wheel' ? 'wheel' : true}>
            <FullscreenLayout
              scrollRef={scrollRef}
              scrollable={scrollableContent}
              bottom={bottomContent}
            />
          </AlternateScreen>
          </OrchestrationStoreProvider>
        </TranscriptProvider>
      </BridgeRuntimeProvider>
    );
  }

  return appContent(
    <BridgeRuntimeProvider runtime={bridgeRuntime}>
      <TranscriptProvider reader={transcriptReader}>
        <OrchestrationStoreProvider store={orchestrationStore}>
        {scrollableContent}
        {bottomContent}
        </OrchestrationStoreProvider>
      </TranscriptProvider>
    </BridgeRuntimeProvider>
  );
}
