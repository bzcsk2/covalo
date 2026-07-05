import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import type { LoopEvent } from '@covalo/core';
import type { ReasonixEngine } from '@covalo/core';
import * as CoreModule from '@covalo/core';
import { createBridge, type BridgeState, type TimelineItem } from '../src/bridge.js';

/** 测试内关闭 delta 合并，避免异步 flush 导致断言竞态。 */
beforeAll(() => {
  process.env.DEEPCODE_DELTA_FLUSH_MS = '0';
});

afterAll(() => {
  delete process.env.DEEPCODE_DELTA_FLUSH_MS;
});

function initialState(): BridgeState {
  return {
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
}

function userMessages(timeline: TimelineItem[]) {
  return timeline.filter(
    (item): item is Extract<TimelineItem, { kind: 'message' }> =>
      item.kind === 'message' && item.message.role === 'user',
  );
}

function reasoningItems(timeline: TimelineItem[]) {
  return timeline.filter(
    (item): item is Extract<TimelineItem, { kind: 'reasoning' }> => item.kind === 'reasoning',
  );
}

function toolItems(timeline: TimelineItem[]) {
  return timeline.filter(
    (item): item is Extract<TimelineItem, { kind: 'tool' }> => item.kind === 'tool',
  );
}

function assistantTextItems(timeline: TimelineItem[]) {
  return timeline.filter(
    (item): item is Extract<TimelineItem, { kind: 'assistant_text' }> => item.kind === 'assistant_text',
  );
}

function stateHarness() {
  let state = initialState();
  const setState: React.Dispatch<React.SetStateAction<BridgeState>> = update => {
    state = typeof update === 'function' ? update(state) : update;
  };
  return { get state() { return state; }, setState };
}

function mockEngine(generators: Array<(text: string) => AsyncGenerator<LoopEvent>>) {
  const submitted: string[] = [];
  const permissionResponses: boolean[] = [];
  const enqueuedInstructions: string[] = [];
  let interrupted = 0;
  let isSubmitting = false;
  const pendingQueue: string[] = [];
  return {
    submitted,
    permissionResponses,
    enqueuedInstructions,
    onRespondPermission: undefined as ((allow: boolean) => void) | undefined,
    get interrupted() { return interrupted; },
    get isSubmitting() { return isSubmitting; },
    submit(text: string) {
      submitted.push(text);
      isSubmitting = true;
      const generator = generators.shift();
      if (!generator) throw new Error(`Unexpected submit: ${text}`);
      const gen = generator(text);
      // Wrap to track when done
      return (async function* () {
        try {
          yield* gen;
        } finally {
          isSubmitting = false;
          pendingQueue.length = 0;
        }
      })();
    },
    enqueueInstruction(instruction: string) {
      const trimmed = instruction.trim();
      if (!trimmed) return { status: 'ignored' as const, queueLength: pendingQueue.length };
      if (!isSubmitting) return { status: 'idle' as const, queueLength: 0 };
      if (pendingQueue.length >= 10) return { status: 'full' as const, queueLength: pendingQueue.length };
      pendingQueue.push(trimmed);
      enqueuedInstructions.push(trimmed);
      return { status: 'queued' as const, queueLength: pendingQueue.length };
    },
    respondPermission(allow: boolean) {
      permissionResponses.push(allow);
      this.onRespondPermission?.(allow);
    },
    interrupt() { interrupted++; isSubmitting = false; pendingQueue.length = 0; },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

describe('TUI bridge with TranscriptStore', () => {
  const previousStoreFlag = process.env.DEEPCODE_TUI_STORE;

  beforeAll(() => {
    process.env.DEEPCODE_TUI_STORE = '1';
    process.env.DEEPCODE_DELTA_FLUSH_MS = '0';
  });

  afterAll(() => {
    if (previousStoreFlag === undefined) delete process.env.DEEPCODE_TUI_STORE;
    else process.env.DEEPCODE_TUI_STORE = previousStoreFlag;
    delete process.env.DEEPCODE_DELTA_FLUSH_MS;
  });

  it('streams assistant deltas through the store path', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'assistant_delta', content: 'hel' };
        yield { role: 'assistant_delta', content: 'lo' };
        yield { role: 'assistant_final', content: 'hello' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    await bridge.submit('hi');

    const reader = bridge.getTranscriptReader();
    expect(reader).not.toBeNull();
    const timeline = reader!.getSnapshot();
    const assistant = timeline.filter(item => item.kind === 'assistant_text');
    expect(assistant).toHaveLength(1);
    expect(assistant[0]?.kind === 'assistant_text' && assistant[0].text).toBe('hello');
    expect(assistant[0]?.kind === 'assistant_text' && assistant[0].isStreaming).toBe(false);
  });
});

describe('TUI bridge turn state', () => {

  it('keeps final reasoning metadata when a provider emits no reasoning deltas', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'assistant_final', content: 'answer', metadata: { reasoning: 'hidden chain summary' } };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    await bridge.submit('think first');

    const reasoning = reasoningItems(harness.state.timeline);
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]?.text).toBe('hidden chain summary');
    expect(assistantTextItems(harness.state.timeline)[0]?.text).toBe('answer');
  });

  it('keeps a pure tool turn visible and associates arguments by toolCallIndex', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'tool_call_delta', toolName: 'bash', toolCallIndex: 0, content: '{"command":"pwd"}' };
        yield { role: 'assistant_final', content: '' };
        yield { role: 'tool_start', toolName: 'bash', toolCallIndex: 0 };
        yield { role: 'tool', toolName: 'bash', toolCallIndex: 0, content: '{"stdout":"/tmp\\n"}' };
        yield { role: 'tool_progress', toolName: 'bash', toolCallIndex: 0, content: 'done' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    await bridge.submit('where am I?');

    expect(userMessages(harness.state.timeline)).toHaveLength(1);
    expect(assistantTextItems(harness.state.timeline)).toHaveLength(0);
    const tools = toolItems(harness.state.timeline);
    expect(tools).toHaveLength(1);
    expect(tools[0]?.tool.args).toEqual({ command: 'pwd' });
    expect(tools[0]?.tool.status).toBe('done');
  });

  it('preserves tools when a later batch reuses toolCallIndex zero', async () => {
    const engine = mockEngine([
      async function* () {
        for (const command of ['pwd', 'ls']) {
          yield { role: 'tool_call_delta', toolName: 'bash', toolCallIndex: 0, content: JSON.stringify({ command }) };
          yield { role: 'tool_start', toolName: 'bash', toolCallIndex: 0 };
          yield { role: 'tool', toolName: 'bash', toolCallIndex: 0, content: '{"stdout":""}' };
          yield { role: 'tool_progress', toolName: 'bash', toolCallIndex: 0, content: 'done' };
        }
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    await bridge.submit('run both');

    const tools = toolItems(harness.state.timeline);
    expect(tools.map(item => item.tool.args.command)).toEqual(['pwd', 'ls']);
  });

  it('clears a repeated tool-call warning when the next reasoning event arrives', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'warning', content: 'Tool call loop detected: read_file called 3 times with identical arguments' };
        yield { role: 'warning', content: 'Keep this warning' };
        yield { role: 'reasoning_delta', content: 'Trying another approach' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    await bridge.submit('continue');

    expect(harness.state.warnings).toEqual(['Keep this warning']);
  });

  it('shows only the latest repeated tool-call warning while waiting for new activity', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'warning', content: 'Tool call loop detected: read_file called 3 times with identical arguments' };
        yield { role: 'warning', content: 'Tool call loop detected: read_file called 4 times with identical arguments' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    await bridge.submit('continue');

    expect(harness.state.warnings).toEqual([]);
  });

  it('replaces repeated tool-call warnings and clears them on the next tool call', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'warning', content: 'Tool call loop detected: read_file called 3 times with identical arguments' };
        yield { role: 'warning', content: 'Tool call loop detected: read_file called 4 times with identical arguments' };
        yield { role: 'tool_call_delta', toolName: 'search', toolCallIndex: 0, content: '{"query":"next"}' };
        yield { role: 'tool_start', toolName: 'search', toolCallIndex: 0 };
        yield { role: 'tool', toolName: 'search', toolCallIndex: 0, content: 'done' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    await bridge.submit('continue');

    expect(harness.state.warnings).toEqual([]);
  });

  it('queues a new submit until the active generator exits after cancel', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
    const engine = mockEngine([
      async function* () {
        yield { role: 'assistant_delta', content: 'partial' };
        await firstReleased;
        yield { role: 'status', content: 'interrupted' };
      },
      async function* () {
        yield { role: 'assistant_delta', content: 'second' };
        yield { role: 'assistant_final', content: 'second' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const first = bridge.submit('first');
    await waitFor(() => engine.submitted.length === 1);
    bridge.cancel();
    await bridge.submit('second');
    expect(engine.submitted).toEqual(['first']);
    expect(harness.state.messageQueue).toEqual(['second']);

    releaseFirst?.();
    await first;
    await waitFor(() => engine.submitted.length === 2 && harness.state.isLoading === false);

    expect(engine.submitted).toEqual(['first', 'second']);
    expect(userMessages(harness.state.timeline)).toHaveLength(2);
  });

  it('denies a pending permission prompt when cancelled so the generator can exit', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'permission_ask', toolName: 'bash', content: '{"command":"pwd"}' };
        await new Promise<void>(resolve => {
          engine.onRespondPermission = () => resolve();
        });
        yield { role: 'status', content: 'interrupted' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const pending = bridge.submit('run command');
    await waitFor(() => harness.state.permissionPrompt !== null);
    bridge.cancel();
    await pending;

    expect(engine.permissionResponses).toEqual([false]);
    expect(harness.state.isLoading).toBe(false);
    expect(harness.state.permissionPrompt).toBeNull();
  });

  // ─── P0 Contract Tests (bridge) ──────────────────────────────────

  it('P0-5: permission prompt cancel — promise is fulfilled, generator can exit', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'permission_ask', toolName: 'bash', content: '{"command":"rm -rf /"}' };
        await new Promise<void>(resolve => {
          engine.onRespondPermission = () => resolve();
        });
        yield { role: 'status', content: 'interrupted' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const pending = bridge.submit('dangerous command');
    await waitFor(() => harness.state.permissionPrompt !== null);
    // User cancels during permission prompt
    bridge.cancel();
    await pending;

    // Permission promise was resolved with false
    expect(engine.permissionResponses).toEqual([false]);
    // Generator exited cleanly
    expect(harness.state.isLoading).toBe(false);
  });

  it('P0-6: TUI running input goes to enqueueInstruction, not lost', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(r => { releaseFirst = r; });
    const engine = mockEngine([
      async function* () {
        yield { role: 'assistant_delta', content: 'working...' };
        yield { role: 'status', content: 'instruction_injected', metadata: { kind: 'instruction_injected', queueLength: 0, turnCount: 1 } };
        await firstReleased;
        yield { role: 'assistant_final', content: 'done with both' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    // First submit is running
    const first = bridge.submit('first message');
    await waitFor(() => engine.submitted.length === 1);

    // Second submit arrives while first is running — goes to enqueueInstruction
    bridge.submit('second message');
    expect(harness.state.messageQueue).toEqual([]);
    expect(engine.enqueuedInstructions).toEqual(['second message']);
    expect(engine.submitted).toEqual(['first message']);

    // Release first submit (which processes both messages)
    releaseFirst();
    await waitFor(() => harness.state.isLoading === false);

    // Both messages were handled in one submit via injection
    expect(engine.submitted).toEqual(['first message']);
    expect(harness.state.messageQueue).toEqual([]);
  });

  // ─── P3: Mid-session instruction routing ──────────────────────────

  it('P3-1: running + queued — input goes to engine, not messageQueue', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(r => { releaseFirst = r; });
    const engine = mockEngine([
      async function* () {
        yield { role: 'assistant_delta', content: 'working...' };
        await firstReleased;
        yield { role: 'assistant_final', content: 'done' };
        yield { role: 'done' };
      },
      async function* () {
        yield { role: 'assistant_final', content: 'follow-up response' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const first = bridge.submit('first');
    await waitFor(() => engine.submitted.length === 1);

    // Second submit while running — should go via enqueueInstruction
    bridge.submit('follow-up question');
    expect(harness.state.messageQueue).toEqual([]);
    expect(engine.enqueuedInstructions).toEqual(['follow-up question']);
    expect(harness.state.pendingInstructionCount).toBe(1);

    releaseFirst();
    await first;
    await waitFor(() => harness.state.isLoading === false);
  });

  it('P3-2: running + full — input falls back to messageQueue', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(r => { releaseFirst = r; });
    const engine = mockEngine([
      async function* () {
        yield { role: 'assistant_delta', content: 'working...' };
        await firstReleased;
        yield { role: 'assistant_final', content: 'done' };
        yield { role: 'done' };
      },
      async function* () {
        yield { role: 'assistant_final', content: 'overflow response' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const first = bridge.submit('first');
    await waitFor(() => engine.submitted.length === 1);

    // Fill the injection queue (mock allows 10)
    for (let i = 0; i < 10; i++) {
      engine.enqueueInstruction(`msg-${i}`);
    }
    // 11th should be full — falls back to messageQueue
    bridge.submit('overflow message');
    expect(harness.state.messageQueue).toEqual(['overflow message']);
    expect(harness.state.pendingInstructionCount).toBe(10);

    releaseFirst();
    await first;
  });

  it('P3-3: running + idle race — input falls back to messageQueue', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'assistant_final', content: 'quick' };
        yield { role: 'done' };
      },
      async function* () {
        yield { role: 'assistant_final', content: 'queued' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    // Submit and immediately try another — engine finishes very fast
    const first = bridge.submit('first');
    // By the time we call submit again, engine may have finished (idle)
    // The mock engine sets isSubmitting=false on generator exit
    await first;
    // Now engine is idle — enqueueInstruction returns idle, falls back to messageQueue
    bridge.submit('second');
    // Since engine is idle, it should go to messageQueue (or auto-submit via processQueue)
    await waitFor(() => engine.submitted.length === 2 || harness.state.messageQueue.length === 0);
  });

  it('P3-4: instruction_injected status updates pendingInstructionCount', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(r => { releaseFirst = r; });
    const engine = mockEngine([
      async function* () {
        yield { role: 'assistant_delta', content: 'working...' };
        await firstReleased;
        yield { role: 'status', content: 'instruction_injected', metadata: { kind: 'instruction_injected', queueLength: 0, turnCount: 1 } };
        yield { role: 'assistant_final', content: 'done' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const first = bridge.submit('first');
    await waitFor(() => engine.submitted.length === 1);

    // Manually set pendingInstructionCount to simulate a queued instruction
    harness.setState(prev => ({ ...prev, pendingInstructionCount: 1 }));
    expect(harness.state.pendingInstructionCount).toBe(1);

    releaseFirst();
    await first;
    // After instruction_injected status, count should be 0
    await waitFor(() => harness.state.pendingInstructionCount === 0);
  });

  it('P3-5: cancel still calls respondPermission(false) and interrupt()', async () => {
    const engine = mockEngine([
      async function* () {
        yield { role: 'permission_ask', toolName: 'bash', content: '{"command":"ls"}' };
        await new Promise<void>(resolve => {
          engine.onRespondPermission = () => resolve();
        });
        yield { role: 'status', content: 'interrupted' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const pending = bridge.submit('run');
    await waitFor(() => harness.state.permissionPrompt !== null);
    bridge.cancel();
    await pending;

    expect(engine.permissionResponses).toEqual([false]);
    expect(engine.interrupted).toBe(1);
  });

  it('P1-7: runEval uses dualRuntime engines for Worker and Supervisor', async () => {
    const workerSubmitted: string[] = []
    const supervisorSubmitted: string[] = []
    const workerEngine = {
      submit(text: string) { workerSubmitted.push(text); return (async function* () { yield { role: 'done' as const } })() },
      updateConfig: vi.fn(),
      interrupt: vi.fn(),
    }
    const supervisorEngine = {
      submit(text: string) { supervisorSubmitted.push(text); return (async function* () { yield { role: 'done' as const } })() },
      interrupt: vi.fn(),
    }
    const dualRuntime = {
      getWorker: () => ({ getEngine: () => workerEngine }),
      getSupervisor: () => ({ getEngine: () => supervisorEngine }),
      interruptRole: vi.fn(),
      respondPermission: vi.fn(),
    }

    const capturedApi: any[] = []
    const spy = vi.spyOn(CoreModule, 'runEval').mockImplementation(async (_opts: any, api: any) => {
      capturedApi.push(api)
      return { evalRunId: 'test', reportDir: '/tmp', leaderboard: [], runs: [] } as any
    })

    const harness = stateHarness()
    const bridge = createBridge(
      {} as ReasonixEngine,
      harness.setState,
      undefined,
      dualRuntime as any,
    )

    await bridge.runEval(
      { models: ['zen/deepseek-v4-flash-free'], cases: [{ id: 'test', prompt: 'test', taskType: 'single-file-fix', source: 'benchmark', title: 'Test', difficulty: 'easy' }], limit: 1, dryRun: false },
      { provider: 'zen', model: 'deepseek-v4-flash-free', baseUrl: '', apiKey: '' },
    )

    expect(capturedApi).toHaveLength(1)
    const api = capturedApi[0]

    // executeWorker must route to workerEngine
    await api.executeWorker({ prompt: 'worker-prompt' })
    expect(workerSubmitted).toContain('worker-prompt')
    expect(supervisorSubmitted).not.toContain('worker-prompt')

    // executeSupervisor must route to supervisorEngine
    await api.executeSupervisor({ prompt: 'supervisor-prompt' })
    expect(supervisorSubmitted).toContain('supervisor-prompt')

    // switchModel/checkApiKey pass cfg.modelTargets to resolveModelTarget for custom aliases
    const rtSpy = vi.spyOn(CoreModule, 'resolveModelTarget')
    try {
      await api.switchModel('zen/deepseek-v4-flash-free')
      expect(rtSpy.mock.calls[0][0]).toBe('zen/deepseek-v4-flash-free')
      expect(rtSpy.mock.calls[0]).toHaveLength(3)

      rtSpy.mockClear()
      api.checkApiKey('zen/deepseek-v4-flash-free')
      expect(rtSpy.mock.calls[0][0]).toBe('zen/deepseek-v4-flash-free')
      expect(rtSpy.mock.calls[0]).toHaveLength(3)
    } finally {
      rtSpy.mockRestore()
    }

    spy.mockRestore()
  })

  it('P3-6: original serial queue regression — messageQueue still works', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(r => { releaseFirst = r; });
    const engine = mockEngine([
      async function* () {
        yield { role: 'assistant_delta', content: 'working...' };
        await firstReleased;
        yield { role: 'assistant_final', content: 'done' };
        yield { role: 'done' };
      },
      async function* () {
        yield { role: 'assistant_final', content: 'queued response' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const first = bridge.submit('first');
    await waitFor(() => engine.submitted.length === 1);

    // If enqueueInstruction returns idle (engine finishes fast), falls back to messageQueue
    // Force the scenario: engine finishes before second submit
    releaseFirst();
    await first;
    // Now engine is idle
    bridge.submit('second');
    // Should be processed by processQueue (serial)
    await waitFor(() => engine.submitted.length === 2 && harness.state.isLoading === false);
    expect(engine.submitted).toEqual(['first', 'second']);
  });
});
