import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Box, Text, AlternateScreen, instances, SHOW_CURSOR, EXIT_ALT_SCREEN, useInput } from '@deepicode/ink';
import { writeSync } from 'node:fs';
import type { ReasonixEngine } from '@deepicode/core';
import type { DeepicodeConfig } from '@deepicode/core';
import { PROVIDERS, AGENTS, saveLastConfig } from '@deepicode/core';
import { createBridge, type BridgeState } from './bridge.js';
import { DeepiMessages } from './DeepiMessages.js';
import { DeepiPromptInput } from './DeepiPromptInput.js';
import { ToolCallBanner } from './ToolCallBanner.js';
import { Spinner } from './Spinner.js';
import { StatusBar } from './StatusBar.js';
import { FullscreenLayout } from './FullscreenLayout.js';
import { isFullscreenEnvEnabled } from './fullscreen.js';
import { ModelPicker } from './ModelPicker.js';

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
  _setStatusMsg?.('Press Ctrl+C again to exit');
}

const initialState: BridgeState = {
  messages: [],
  isLoading: false,
  streamingText: null,
  reasoningText: null,
  activeTools: new Map(),
  tokens: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 },
  contextUsage: 0,
  warnings: [],
  error: null,
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
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  // Wire module-level callbacks for doInterrupt()
  _cancel = () => bridgeRef.current.cancel();
  _interrupt = () => engineRef.current.interrupt();
  _setStatusMsg = setStatusMessage;

  // SIGINT handler (Linux: Ctrl+C generates signal, not character)
  useEffect(() => {
    process.on('SIGINT', doInterrupt);
    return () => { process.off('SIGINT', doInterrupt); };
  }, []);

  // \x03 character handler (raw mode working properly — Ctrl+C arrives as character)
  useInput((input, key) => {
    if (input === '\x03' || (key.ctrl && input === 'c')) {
      doInterrupt();
    }
  });

  const handleCancel = useCallback(() => {
    bridgeRef.current.cancel();
  }, []);
  const scrollRef = useRef<any>(null);

  const [activeProvider, setActiveProvider] = useState(config.provider ?? 'zen');
  const [activeModel, setActiveModel] = useState(config.model);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [activeAgent, setActiveAgent] = useState(engine.getAgentName?.() ?? 'build');

  const handleSubmit = useCallback((text: string) => {
    if (text === '/exit' || text === '/bye') {
      exitPending = true;
      engineRef.current.interrupt();
      setBridgeState(prev => ({
        ...prev,
        messages: [...prev.messages, { role: 'assistant' as const, content: 'Shutting down...' }],
      }));
      cleanupTerminal();
      process.exit(0);
    }
    if (text === '/help') {
      const agentList = Object.values(AGENTS).map(a => `${a.name} — ${a.label}`).join('\n');
      setBridgeState(prev => ({
        ...prev,
        messages: [...prev.messages, {
          role: 'assistant' as const,
          content: `Commands:\n  /exit, /bye  — exit\n  /help        — show this\n  /model       — switch provider/model\n  /agent       — switch agent\n  /skill       — list loaded skills\n\nAgents:\n${agentList}\n\nCurrent: ${AGENTS[activeAgent]?.label ?? activeAgent}`,
        }],
      }));
      return;
    }
    if (text === '/model') {
      setShowModelPicker(true);
      return;
    }
    if (text === '/skill') {
      import("../../tools/src/skills/index.js").then(async ({ createSkillTool }) => {
        const tool = createSkillTool()
        const result = await tool.execute({ command: "list" }, { cwd: process.cwd(), sessionId: "" })
        let msg: string
        try { const d = JSON.parse(result.content); msg = `Loaded ${d.count} skills.\n${d.skills.slice(0, 20).map((s: any) => `  ${s.name} — ${s.description}`).join("\n")}${d.count > 20 ? `\n  ... and ${d.count - 20} more` : ""}` } catch { msg = result.content }
        setBridgeState(prev => ({ ...prev, messages: [...prev.messages, { role: 'assistant' as const, content: msg }] }))
      })
      return
    }
    if (text === '/agent') {
      const next = activeAgent === 'build' ? 'plan' : 'build';
      const label = engineRef.current.switchAgent(next);
      setActiveAgent(next);
      setBridgeState(prev => ({
        ...prev,
        messages: [...prev.messages, { role: 'assistant' as const, content: `Switched to ${label}` }],
      }));
      return;
    }
    bridge.submit(text);
  }, [bridge]);

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
    setBridgeState(prev => ({
      ...prev,
      messages: [...prev.messages, { role: 'assistant' as const, content: `Switched to ${PROVIDERS[sel.provider]?.label ?? sel.provider} / ${sel.model}` }],
    }));
  }, []);

  const handleModelCancel = useCallback(() => {
    setShowModelPicker(false);
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

  const scrollableContent = (
    <>
      <DeepiMessages
        messages={bridgeState.messages}
        activeTools={bridgeState.activeTools}
        isLoading={bridgeState.isLoading}
        streamingText={bridgeState.streamingText}
        reasoningText={bridgeState.reasoningText}
        scrollRef={scrollRef}
      />
      <ToolCallBanner activeTools={bridgeState.activeTools} />
      <Spinner loading={bridgeState.isLoading} message={bridgeState.isLoading ? 'thinking...' : undefined} />
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
    </>
  );

  const bottomContent = (
    <Box flexDirection="column" width="100%">
      <DeepiPromptInput
        onSubmit={handleSubmit}
        isLoading={bridgeState.isLoading}
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
        statusMessage={statusMessage}
      />
    </Box>
  );

  if (isFullscreenEnvEnabled()) {
    return (
      <AlternateScreen mouseTracking>
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
