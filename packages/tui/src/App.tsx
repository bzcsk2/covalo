import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Box, Text, AlternateScreen, instances, SHOW_CURSOR, EXIT_ALT_SCREEN, useInput } from '@deepreef/ink';
import { writeSync } from 'node:fs';
import type { ReasonixEngine } from '@deepreef/core';
import type { ChatMessage, DeepreefConfig } from '@deepreef/core';
import { PROVIDERS, AGENTS, defaultAgentRegistry, getModelContextWindow, saveLastConfig } from '@deepreef/core';
import { createBridge, timelineFromMessages, type BridgeState } from './bridge.js';
import { DeepiMessages } from './DeepiMessages.js';
import { DeepiPromptInput, type DeepiPromptInputHandle } from './DeepiPromptInput.js';
import { StatusBar } from './StatusBar.js';
import { FullscreenLayout } from './FullscreenLayout.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { isFullscreenEnvEnabled } from './fullscreen.js';
import { ModelPicker } from './ModelPicker.js';
import { SessionPicker } from './SessionPicker.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { CommandAutocomplete } from './CommandAutocomplete.js';
import { SearchOverlay } from './SearchOverlay.js';
import { CenteredStage } from './CenteredStage.js';
import { ChoiceMenu } from './ChoiceMenu.js';
import { SkillModal } from './SkillModal.js';
import { ContextModal } from './ContextModal.js';
import { formatStatus } from './status/format.js';
import { t, setLocale } from './i18n/index.js';
import { loadTuiSettings, saveTuiSettings } from './settings.js';
import {
  buildHelpText,
  parseSlashCommand,
  validateThinkingMode,
} from './commands.js';

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
 * _cancel:       取消当前 LLM 请求
 * _interrupt:    中断引擎执行
 * _setStatusMsg: 更新状态栏提示文字
 */
let _cancel: (() => void) | null = null;
let _interrupt: (() => void) | null = null;
let _setStatusMsg: ((m: string | null) => void) | null = null;

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
  thinkingMode: 'off',
  effectiveThinkingMode: undefined,
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
  const { createSkillTool } = await import('@deepreef/tools');
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
export function App({ engine, config, pluginCount = 0, contentPackCount = 0, assetCounts, diagnosticCounts, onUserInput }: AppProps) {
  const persistedSettings = useMemo(() => loadTuiSettings(), []);
  const persistedThinkingMode = persistedSettings.thinkingMode && !validateThinkingMode(persistedSettings.thinkingMode)
    ? persistedSettings.thinkingMode
    : undefined;
  const persistedAgent = persistedSettings.agent && (AGENTS[persistedSettings.agent] || defaultAgentRegistry.get(persistedSettings.agent))
    ? persistedSettings.agent
    : undefined;
  const [bridgeState, setBridgeState] = useState<BridgeState>(() => ({
    ...initialState,
    thinkingMode: persistedThinkingMode ?? engine.getThinkingMode?.() ?? 'off',
  }));
  const bridge = useMemo(() => createBridge(engine, setBridgeState, onUserInput), [engine, onUserInput]);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const contextTotal = engine.getContextWindow?.() ?? config.contextWindow ?? 128_000;
  const engineRef = useRef(engine);
  const mountedRef = useRef(true);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const appendMessage = useCallback((message: ChatMessage) => {
    setBridgeState(prev => ({
      ...prev,
      timeline: [...prev.timeline, {
        id: `message-${crypto.randomUUID()}`,
        kind: 'message',
        message,
      }],
    }));
  }, []);

  // Wire module-level callbacks for doInterrupt()
  _cancel = () => bridgeRef.current.cancel();
  _interrupt = () => engineRef.current.interrupt();
  _setStatusMsg = setStatusMessage;

  // SIGINT handler (Linux: Ctrl+C generates signal, not character)
  useEffect(() => {
    process.on('SIGINT', doInterrupt);
    return () => { process.off('SIGINT', doInterrupt); };
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

  /** 取消当前 LLM 请求 */
  const handleCancel = useCallback(() => {
    bridgeRef.current.cancel();
  }, []);
  const scrollRef = useRef<any>(null);
  const promptInputRef = useRef<DeepiPromptInputHandle>(null);

  const [activeProvider, setActiveProvider] = useState(config.provider ?? 'zen'); // 当前选中的 LLM 提供商
  const [activeModel, setActiveModel] = useState(config.model);                  // 当前选中的模型名称
  const [inputText, setInputText] = useState('');                                // 用户输入框当前文本
  const [showAutocomplete, setShowAutocomplete] = useState(false);               // 是否显示命令自动补全面板
  const [showModelPicker, setShowModelPicker] = useState(false);                 // 是否显示模型选择器覆盖层
  const [showSessionPicker, setShowSessionPicker] = useState(false);             // 是否显示会话选择器覆盖层
  const [showAgentMenu, setShowAgentMenu] = useState(false);                     // 是否显示 Agent 切换菜单覆盖层
  const [showLangMenu, setShowLangMenu] = useState(false);                       // 是否显示语言切换菜单覆盖层
  const [showThinkingMenu, setShowThinkingMenu] = useState(false);               // 是否显示推理档位选择菜单覆盖层
  const [showSkillModal, setShowSkillModal] = useState(false);                   // 是否显示技能管理弹窗覆盖层
  const [showContextModal, setShowContextModal] = useState(false);               // 是否显示上下文策略管理弹窗覆盖层
  const [showSearch, setShowSearch] = useState(false);                           // 是否显示搜索覆盖层（Ctrl+F 触发）
  const [activeAgent, setActiveAgent] = useState(persistedAgent ?? engine.getAgentName?.() ?? 'build'); // 当前 Agent 名称
  const [activeSkills, setActiveSkills] = useState(persistedSettings.activeSkills ?? engine.getActiveSkills?.() ?? []); // 当前已启用的技能列表
  const [inputHistory, setInputHistory] = useState<string[]>([]);                // 输入历史记录（最多 MAX_INPUT_HISTORY 条）
  const [inputInjection, setInputInjection] = useState<{ id: number; text: string } | undefined>(undefined); // 外部注入到输入框的文本
  const [contextPolicy, setContextPolicy] = useState(engine.getContextPolicy()); // 当前上下文策略

  useEffect(() => {
    if (persistedAgent) {
      engineRef.current.switchAgent(persistedAgent);
    }
    if (persistedThinkingMode) {
      engineRef.current.setThinkingMode(persistedThinkingMode as any);
    }
    if (persistedSettings.activeSkills) {
      engineRef.current.setActiveSkills(persistedSettings.activeSkills);
    }
  }, [persistedAgent, persistedSettings.activeSkills, persistedThinkingMode]);

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
          appendMessage({ role: 'assistant' as const, content: `Failed to load status: ${msg}` });
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
          appendMessage({ role: 'assistant' as const, content: `${error}\nCurrent: ${bridgeState.thinkingMode}` });
          return;
        }
        engineRef.current.setThinkingMode(command.mode as any);
        saveTuiSettings({ thinkingMode: command.mode });
        setBridgeState(prev => ({ ...prev, thinkingMode: command.mode, effectiveThinkingMode: undefined, reasoningActive: false }));
        appendMessage({ role: 'assistant' as const, content: `Thinking mode set to: ${command.mode}` });
        return;
      }
      setShowThinkingMenu(true);
      return;
    }
    if (command?.name === 'lang') {
      setShowLangMenu(true);
      return;
    }
    const taggedSkillNames = extractSkillTags(submitted);
    if (taggedSkillNames.length === 0) {
      bridge.submit(submitted);
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
      try {
        await bridge.submit(submitted);
      } finally {
        engineRef.current.setActiveSkills(previousSkills);
      }
    })();
  }, [activeAgent, appendMessage, bridge]);

  /** Agent 切换回调：调用引擎切换 Agent 并更新显示名称 */
  const handleAgentChoose = useCallback((next: string) => {
    const label = engineRef.current.switchAgent(next);
    setActiveAgent(next);
    saveTuiSettings({ agent: next });
    setShowAgentMenu(false);
    appendMessage({ role: 'assistant' as const, content: t().switchedTo(label) });
  }, [appendMessage]);

  /** 语言切换回调：设置界面语言 */
  const handleLangChoose = useCallback((next: string) => {
    setLocale(next as any);
    setShowLangMenu(false);
    appendMessage({ role: 'assistant' as const, content: t().switchedLang(next) });
  }, [appendMessage]);

  /** 推理档位选择回调：更新引擎和 bridge 的 thinkingMode */
  const handleThinkingChoose = useCallback((mode: string) => {
    const error = validateThinkingMode(mode);
    if (error) {
      appendMessage({ role: 'assistant' as const, content: `${error}\nCurrent: ${bridgeState.thinkingMode}` });
      return;
    }
    engineRef.current.setThinkingMode(mode as any);
    saveTuiSettings({ thinkingMode: mode });
    setBridgeState(prev => ({ ...prev, thinkingMode: mode, effectiveThinkingMode: undefined, reasoningActive: false }));
    setShowThinkingMenu(false);
    appendMessage({ role: 'assistant' as const, content: `Thinking mode set to: ${mode}` });
  }, [appendMessage, bridgeState.thinkingMode]);

  /** 模型选择回调：更新引擎配置并保存至持久化存储 */
  const handleModelSelect = useCallback((sel: { provider: string; model: string; apiKey: string; baseUrl: string }) => {
    const contextWindow = getModelContextWindow(sel.provider, sel.model);
    engineRef.current.updateConfig({
      provider: sel.provider,
      model: sel.model,
      apiKey: sel.apiKey,
      baseUrl: sel.baseUrl,
      contextWindow,
    });
    setActiveProvider(sel.provider);
    setActiveModel(sel.model);
    saveLastConfig({ provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl });
    setShowModelPicker(false);
    appendMessage({ role: 'assistant' as const, content: t().switchedModel(PROVIDERS[sel.provider]?.label ?? sel.provider, sel.model) });
  }, [appendMessage]);

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
    // Reset bridge state with recovered messages
    setBridgeState({
      ...initialState,
      timeline: timelineFromMessages(msgs),
    });
    appendMessage({ role: 'assistant' as const, content: t().resumedSession(sessionId.slice(0, 8), msgs.length) });
  }, [appendMessage]);

  /** 会话选择取消回调：关闭选择器覆盖层 */
  const handleSessionCancel = useCallback(() => {
    setShowSessionPicker(false);
  }, []);

  /** 权限请求回调：向引擎传递用户的允许/拒绝决策 */
  const handlePermissionSelect = useCallback((allow: boolean, alwaysAllow?: boolean) => {
    engineRef.current.respondPermission(allow, alwaysAllow);
    setBridgeState(prev => ({ ...prev, permissionPrompt: null }));
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
        { value: "build", label: "Build Agent", description: "完整读写工具" },
        { value: "plan", label: "Plan Agent", description: "只读分析" },
      )
    }
    return (
      <ChoiceMenu
        title="Agent"
        subtitle="选择切换目标"
        items={agentItems}
        onChoose={handleAgentChoose}
        onCancel={() => setShowAgentMenu(false)}
      />
    );
  }

  // ---- 覆盖层：语言切换菜单（当 showLangMenu 为 true 时显示） ----
  if (showLangMenu) {
    return (
      <ChoiceMenu
        title="Language"
        subtitle="选择界面语言"
        items={[
          { value: "zh-CN", label: "中文", description: "切换到中文界面" },
          { value: "en", label: "English", description: "switch to English" },
        ]}
        onChoose={handleLangChoose}
        onCancel={() => setShowLangMenu(false)}
      />
    );
  }

  // ---- 覆盖层：推理档位选择菜单（当 showThinkingMenu 为 true 时显示） ----
  if (showThinkingMenu) {
    return (
      <ChoiceMenu
        title="Thinking"
        subtitle="选择推理档位"
        items={[
          { value: "auto", label: "auto", description: "auto switching (AS0-AS6)" },
          { value: "off", label: "off", description: "disable reasoning" },
          { value: "open", label: "open", description: "enable reasoning" },
          { value: "high", label: "high", description: "strong reasoning (DeepSeek)" },
        ]}
        onChoose={handleThinkingChoose}
        onCancel={() => setShowThinkingMenu(false)}
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
  const scrollableContent = (
    <>
      <SearchOverlay
        timeline={bridgeState.timeline}
        isOpen={showSearch}
        onClose={() => setShowSearch(false)}
      />
      <DeepiMessages
        timeline={bridgeState.timeline}
        scrollRef={scrollRef}
      />
      {bridgeState.timeline.length === 0 && !bridgeState.isLoading && !bridgeState.error ? (
        <WelcomeScreen
          model={activeModel}
          provider={providerLabel}
          agent={AGENTS[activeAgent]?.label ?? defaultAgentRegistry.get(activeAgent)?.label ?? activeAgent}
          thinkingMode={bridgeState.thinkingMode}
          contextMode={contextPolicy.mode}
          skillCount={activeSkills.length}
          pluginCount={pluginCount}
          contentPackCount={contentPackCount}
          assetCounts={assetCounts ?? { skills: 0, agents: 0, rules: 0, commands: 0, mcp: 0, hooks: 0 }}
          diagnosticCounts={diagnosticCounts ?? { errors: 0, warnings: 0 }}
        />
      ) : null}
      {bridgeState.warnings.map((w, i) => (
        <Box key={i} paddingX={1}>
          <Text color="warning">⚠ {w}</Text>
        </Box>
      ))}
      {bridgeState.error && (
        <Box paddingX={1} marginTop={1}>
          <Text color="error">✗ {bridgeState.error}</Text>
        </Box>
      )}
      {bridgeState.permissionPrompt && (
        <PermissionPrompt
          toolName={bridgeState.permissionPrompt.toolName}
          args={bridgeState.permissionPrompt.args}
          onSelect={handlePermissionSelect}
        />
      )}
    </>
  );

  // ---- 底部区域（固定定位）：命令自动补全、输入框、状态栏 ----
  const bottomContent = (
    <Box flexDirection="column" width="100%">
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
      <DeepiPromptInput
        ref={promptInputRef}
        onSubmit={handleSubmit}
        history={inputHistory}
        injectedText={inputInjection}
        onChange={(text) => {
          setInputText(text);
          setShowAutocomplete(text.startsWith('/') && !text.includes(' '));
        }}
        isLoading={bridgeState.isLoading}
        disabled={!!bridgeState.permissionPrompt}
        queueCount={bridgeState.messageQueue.length}
        onCancel={handleCancel}
        suppressHistory={showAutocomplete}
        suppressSubmit={showAutocomplete}
      />
      <StatusBar
        model={bridgeState.routedModel ?? activeModel}
        provider={providerLabel}
        agent={AGENTS[activeAgent]?.label ?? defaultAgentRegistry.get(activeAgent)?.label ?? activeAgent}
        inputTokens={bridgeState.tokens.input}
        outputTokens={bridgeState.tokens.output}
        cacheHitTokens={bridgeState.tokens.cacheHit}
        cacheMissTokens={bridgeState.tokens.cacheMiss}
        contextUsed={bridgeState.contextUsage}
        contextTotal={contextTotal}
        pendingInstructionCount={bridgeState.pendingInstructionCount}
        statusMessage={bridgeState.routedModelDetail ? `${bridgeState.routedModel} ${bridgeState.routedModelDetail}` : statusMessage}
        thinkingMode={bridgeState.thinkingMode}
        effectiveThinkingMode={bridgeState.effectiveThinkingMode}
        reasoningActive={bridgeState.reasoningActive}
        tier={engine.getTier?.()?.label}
        cwd={process.cwd()}
      />
    </Box>
  );

  if (isFullscreenEnvEnabled()) {
    return (
      <AlternateScreen>
        <FullscreenLayout
          scrollRef={scrollRef}
          scrollable={scrollableContent}
          bottom={bottomContent}
        />
      </AlternateScreen>
    );
  }

  return (
    <>
      {scrollableContent}
      {bottomContent}
    </>
  );
}
