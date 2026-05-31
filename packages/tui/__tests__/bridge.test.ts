import { describe, expect, it } from 'vitest';
import type { LoopEvent } from '../../core/src/interface.js';
import type { ReasonixEngine } from '../../core/src/engine.js';
import { createBridge, type BridgeState } from '../src/bridge.js';

function initialState(): BridgeState {
  return {
    timeline: [],
    isLoading: false,
    messageQueue: [],
    tokens: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 },
    contextUsage: 0,
    warnings: [],
    error: null,
    permissionPrompt: null,
  };
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
  let interrupted = 0;
  return {
    submitted,
    permissionResponses,
    onRespondPermission: undefined as ((allow: boolean) => void) | undefined,
    get interrupted() { return interrupted; },
    submit(text: string) {
      submitted.push(text);
      const generator = generators.shift();
      if (!generator) throw new Error(`Unexpected submit: ${text}`);
      return generator(text);
    },
    respondPermission(allow: boolean) {
      permissionResponses.push(allow);
      this.onRespondPermission?.(allow);
    },
    interrupt() { interrupted++; },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

describe('TUI bridge turn state', () => {
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

    const item = harness.state.timeline[0];
    expect(item?.kind).toBe('turn');
    if (item?.kind !== 'turn') throw new Error('Expected turn');
    expect(item.turn.assistantText).toBe('');
    expect(item.turn.tools).toHaveLength(1);
    expect(item.turn.tools[0]?.args).toEqual({ command: 'pwd' });
    expect(item.turn.tools[0]?.status).toBe('done');
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

    const item = harness.state.timeline[0];
    if (item?.kind !== 'turn') throw new Error('Expected turn');
    expect(item.turn.tools.map(tool => tool.args.command)).toEqual(['pwd', 'ls']);
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
    expect(harness.state.timeline).toHaveLength(2);
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
});
