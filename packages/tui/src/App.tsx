import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Box, Text, AlternateScreen, instances, SHOW_CURSOR, EXIT_ALT_SCREEN, useInput } from '@deepicode/ink';
import { writeSync } from 'node:fs';
import type { ReasonixEngine } from '@deepicode/core';
import type { ChatMessage, DeepicodeConfig } from '@deepicode/core';
import { PROVIDERS, AGENTS, saveLastConfig } from '@deepicode/core';
import { createBridge, timelineFromMessages, type BridgeState } from './bridge.js';
import { DeepiMessages } from './DeepiMessages.js';
import { DeepiPromptInput } from './DeepiPromptInput.js';
import { StatusBar } from './StatusBar.js';
import { FullscreenLayout } from './FullscreenLayout.js';
import { isFullscreenEnvEnabled } from './fullscreen.js';
import { ModelPicker } from './ModelPicker.js';
import { SessionPicker } from './SessionPicker.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { CommandAutocomplete } from './CommandAutocomplete.js';
import { SearchOverlay } from './SearchOverlay.js';
import { t, setLocale, toggleLocale, getLocale } from './i18n/index.js';

// ---- Module-level interrupt state (shared by SIGINT handler + useInput \x03 handler) ----

let tuiState: 'idle' | 'loading' = 'idle';
export function setTUIState(s: 'idle' | 'loading') { tuiState = s; }

let exitTimer: ReturnType<typeof setTimeout> | null = null;
let exitPending = false;

// Module-level callbacks set by the App component on mount
let _cancel: (() => void) | null = null;
let _interrupt: (() => void) | null = null;
let _setStatusMsg: ((m: string | null) => void) | null = null;

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
};

export function getProviderLabel(provider: string): string {
  const info = PROVIDERS[provider];
  return info ? info.label : provider;
}

interface AppProps {
  engine: ReasonixEngine;
  config: DeepicodeConfig;
}

export function App({ engine, config }: AppProps) {
  const [bridgeState, setBridgeState] = useState<BridgeState>(initialState);
  const bridge = useMemo(() => createBridge(engine, setBridgeState), [engine]);
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const contextTotal = config.contextWindow ?? 128_000;
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

  const handleCancel = useCallback(() => {
    bridgeRef.current.cancel();
  }, []);
  const scrollRef = useRef<any>(null);

  const [activeProvider, setActiveProvider] = useState(config.provider ?? 'zen');
  const [activeModel, setActiveModel] = useState(config.model);
  const [inputText, setInputText] = useState('');
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [activeAgent, setActiveAgent] = useState(engine.getAgentName?.() ?? 'build');

  const handleSubmit = useCallback((text: string) => {
    setShowAutocomplete(false);
    if (text === '/exit' || text === '/bye') {
      exitPending = true;
      engineRef.current.interrupt();
      appendMessage({ role: 'assistant' as const, content: t().shuttingDown });
      cleanupTerminal();
      process.exit(0);
    }
    if (text === '/help') {
      const agentList = Object.values(AGENTS).map(a => `${a.name} — ${a.label}`).join('\n');
      const s = t();
      appendMessage({
        role: 'assistant' as const,
        content: `Commands:\n  /exit, /bye  — ${s.cmdExit}\n  /help        — ${s.cmdHelp}\n  /model       — ${s.cmdModel}\n  /sessions    — ${s.cmdSessions}\n  /agent       — ${s.cmdAgent}\n  /skill       — ${s.cmdSkill}\n  /lang        — ${s.cmdLang}\n  /thinking    — set thinking mode\n\nAgents:\n${agentList}\n\nCurrent: ${AGENTS[activeAgent]?.label ?? activeAgent}`,
      });
      return;
    }
    if (text === '/model') {
      setShowModelPicker(true);
      return;
    }
    if (text === '/sessions') {
      setShowSessionPicker(true);
      return;
    }
    if (text === '/skill') {
      import("@deepicode/tools").then(async ({ createSkillTool }) => {
        const tool = createSkillTool()
        const result = await tool.execute({ command: "list" }, { cwd: process.cwd(), sessionId: "" })
        let msg: string
        try { const d = JSON.parse(result.content); msg = `${t().loadedSkills(d.count)}${d.skills.slice(0, 20).map((s: any) => `  ${s.name} — ${s.description}`).join("\n")}${d.count > 20 ? `\n  ... and ${d.count - 20} more` : ""}` } catch { msg = result.content }
        appendMessage({ role: 'assistant' as const, content: msg })
      }).catch(e => {
        const msg = e instanceof Error ? e.message : String(e)
        appendMessage({ role: 'assistant' as const, content: t().failedLoadSkills(msg) })
      })
      return
    }
    if (text === '/agent') {
      const next = activeAgent === 'build' ? 'plan' : 'build';
      const label = engineRef.current.switchAgent(next);
      setActiveAgent(next);
      appendMessage({ role: 'assistant' as const, content: t().switchedTo(label) });
      return;
    }
    if (text.startsWith('/thinking')) {
      const parts = text.split(/\s+/);
      const mode = parts[1];
      const validModes = ['off', 'low', 'medium', 'high', 'max'];
      if (!mode || !validModes.includes(mode)) {
        appendMessage({ role: 'assistant' as const, content: `Usage: /thinking <mode>\nModes: ${validModes.join(', ')}\nCurrent: ${bridgeState.thinkingMode}` });
        return;
      }
      engineRef.current.setThinkingMode(mode as any);
      setBridgeState(prev => ({ ...prev, thinkingMode: mode }));
      appendMessage({ role: 'assistant' as const, content: `Thinking mode set to: ${mode}` });
      return;
    }
    if (text === '/lang') {
      const next = toggleLocale();
      setLocale(next);
      appendMessage({ role: 'assistant' as const, content: t().switchedLang(next) });
      return;
    }
    bridge.submit(text);
  }, [activeAgent, appendMessage, bridge]);

  const handleModelSelect = useCallback((sel: { provider: string; model: string; apiKey: string; baseUrl: string }) => {
    engineRef.current.updateConfig({
      provider: sel.provider,
      model: sel.model,
      apiKey: sel.apiKey,
      baseUrl: sel.baseUrl,
    });
    setActiveProvider(sel.provider);
    setActiveModel(sel.model);
    saveLastConfig({ provider: sel.provider, model: sel.model, baseUrl: sel.baseUrl });
    setShowModelPicker(false);
    appendMessage({ role: 'assistant' as const, content: t().switchedModel(PROVIDERS[sel.provider]?.label ?? sel.provider, sel.model) });
  }, [appendMessage]);

  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false);
  }, []);

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

  const handleSessionCancel = useCallback(() => {
    setShowSessionPicker(false);
  }, []);

  const handlePermissionSelect = useCallback((allow: boolean, alwaysAllow?: boolean) => {
    engineRef.current.respondPermission(allow, alwaysAllow);
    setBridgeState(prev => ({ ...prev, permissionPrompt: null }));
  }, []);

  const providerLabel = getProviderLabel(activeProvider);

  if (showModelPicker) {
    return (
      <Box flexDirection="column" width="100%" height="100%">
        <ModelPicker
          currentProvider={activeProvider}
          currentModel={activeModel}
          onSelect={handleModelSelect}
          onCancel={handleModelCancel}
        />
      </Box>
    );
  }

  if (showSessionPicker) {
    return (
      <Box flexDirection="column" width="100%" height="100%">
        <SessionPicker
          onSelect={handleSessionSelect}
          onCancel={handleSessionCancel}
        />
      </Box>
    );
  }

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

  const bottomContent = (
    <Box flexDirection="column" width="100%">
      {showAutocomplete && (
        <CommandAutocomplete
          query={inputText}
          onSelect={(cmd) => { setInputText(cmd + ' '); setShowAutocomplete(false); }}
          onClose={() => setShowAutocomplete(false)}
        />
      )}
      <DeepiPromptInput
        onSubmit={handleSubmit}
        onChange={(text) => {
          setInputText(text);
          setShowAutocomplete(text.startsWith('/') && !text.includes(' '));
        }}
        isLoading={bridgeState.isLoading}
        disabled={!!bridgeState.permissionPrompt}
        queueCount={bridgeState.messageQueue.length}
        onCancel={handleCancel}
      />
      <StatusBar
        model={activeModel}
        provider={providerLabel}
        agent={AGENTS[activeAgent]?.label ?? activeAgent}
        inputTokens={bridgeState.tokens.input}
        outputTokens={bridgeState.tokens.output}
        cacheHitTokens={bridgeState.tokens.cacheHit}
        cacheMissTokens={bridgeState.tokens.cacheMiss}
        contextUsed={bridgeState.contextUsage}
        contextTotal={contextTotal}
        pendingInstructionCount={bridgeState.pendingInstructionCount}
        statusMessage={statusMessage}
        thinkingMode={bridgeState.thinkingMode}
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
