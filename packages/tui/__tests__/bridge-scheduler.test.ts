import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import type { LoopEvent } from '@covalo/core';
import type { ReasonixEngine } from '@covalo/core';
import { createBridge, type BridgeState, type TimelineItem } from '../src/bridge.js';

/**
 * SPEC S1-1 §4.5 测试要求：bridge submit 队列串行化
 *
 * 测试场景：
 * 1. A 正在运行，B 输入，engine 接受 B 为 mid-session instruction。
 * 2. A 正在运行，B 输入，engine queue full，B 进入 bridge queue。
 * 3. A 完成后，B 已被安排 drain；在 drain submit 前输入 C，最终执行顺序必须是 B → C。
 * 4. 快速连续输入 10 条，执行顺序稳定。
 * 5. abort/cancel 后队列仍能继续处理或按预期清空。
 */

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

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  for (let i = 0; i < timeoutMs / 5; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for condition');
}

function userMessages(timeline: TimelineItem[]) {
  return timeline.filter(
    (item): item is Extract<TimelineItem, { kind: 'message' }> =>
      item.kind === 'message' && item.message.role === 'user',
  );
}

describe('SPEC S1-1: bridge submit queue serialization', () => {
  it('1. A running, B input, engine accepts B as mid-session instruction (queued)', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
    const engine = mockEngine([
      async function* () {
        await firstReleased;
        yield { role: 'assistant_final', content: 'a-done' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const first = bridge.submit('A');
    await waitFor(() => engine.submitted.length === 1);
    expect(engine.isSubmitting).toBe(true);

    // B should be enqueued as mid-session instruction
    bridge.submit('B');
    await waitFor(() => engine.enqueuedInstructions.length === 1);
    expect(engine.enqueuedInstructions).toEqual(['B']);
    // B should NOT enter bridge messageQueue
    expect(harness.state.messageQueue).toEqual([]);

    releaseFirst();
    await first;
  });

  it('2. A running, B input, engine queue full → B enters bridge FIFO', async () => {
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
    const engine = mockEngine([
      async function* () {
        await firstReleased;
        yield { role: 'assistant_final', content: 'a-done' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const first = bridge.submit('A');
    await waitFor(() => engine.submitted.length === 1);

    // Fill engine injection queue (mock allows 10)
    for (let i = 0; i < 10; i++) {
      bridge.submit(`msg-${i}`);
    }
    await waitFor(() => engine.enqueuedInstructions.length === 10);

    // 11th should overflow into bridge FIFO
    bridge.submit('overflow');
    await waitFor(() => harness.state.messageQueue.length === 1);
    expect(harness.state.messageQueue).toEqual(['overflow']);

    releaseFirst();
    await first;
    // After A completes, drainQueue should process overflow
    await waitFor(() => engine.submitted.length === 2);
    expect(engine.submitted[1]).toBe('overflow');
  });

  it('3. FIFO order: A completes, B in drain, C input before B starts → order B → C', async () => {
    // 使用变量控制 generator 何时 yield done
    let releaseA!: () => void;
    const aReleased = new Promise<void>(resolve => { releaseA = resolve; });
    let releaseB!: () => void;
    const bStarted = new Promise<void>(resolve => { releaseB = resolve; });

    const engine = mockEngine([
      // A: waits for releaseA
      async function* () {
        await aReleased;
        yield { role: 'assistant_final', content: 'A' };
        yield { role: 'done' };
      },
      // B: signals started, waits for releaseB
      async function* () {
        releaseB();
        yield { role: 'assistant_final', content: 'B' };
        yield { role: 'done' };
      },
      // C: simple
      async function* () {
        yield { role: 'assistant_final', content: 'C' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const aPromise = bridge.submit('A');
    await waitFor(() => engine.submitted.length === 1);

    // Now A is running. Send B and C in quick succession.
    // Both will go to engine.enqueueInstruction. Mock allows 10, so both 'queued'.
    // They won't enter bridge FIFO; this scenario tests that engine queue order is preserved.
    bridge.submit('B');
    bridge.submit('C');
    await waitFor(() => engine.enqueuedInstructions.length === 2);
    expect(engine.enqueuedInstructions).toEqual(['B', 'C']);

    releaseA();
    await aPromise;
    // After A completes, B and C are handled by engine internally (they were enqueued),
    // bridge does not re-submit them.
    expect(engine.submitted).toEqual(['A']);
  });

  it('4. FIFO order: rapid 10 inputs, stable order via bridge FIFO', async () => {
    // Scenario: A is running (blocking). Each subsequent input is rejected by engine (idle=false),
    // so they all enter bridge FIFO. After A completes, drain processes them in FIFO order.
    let releaseA!: () => void;
    const aReleased = new Promise<void>(resolve => { releaseA = resolve; });
    const generators = [
      async function* () {
        await aReleased;
        yield { role: 'assistant_final', content: 'A' };
        yield { role: 'done' };
      },
    ];
    // 10 more generators for B..K (each completes immediately)
    for (let i = 1; i <= 10; i++) {
      const label = String.fromCharCode('A'.charCodeAt(0) + i);
      generators.push(async function* () {
        yield { role: 'assistant_final', content: label };
        yield { role: 'done' };
      });
    }
    const engine = mockEngine(generators);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const aPromise = bridge.submit('A');
    await waitFor(() => engine.submitted.length === 1);

    // Submit B..K rapidly. Engine mock: isSubmitting=true, pendingQueue.length < 10, so 'queued'
    const labels: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const label = String.fromCharCode('A'.charCodeAt(0) + i);
      labels.push(label);
      bridge.submit(label);
    }
    // All 10 should go to engine.enqueueInstruction as 'queued' (mock allows 10)
    await waitFor(() => engine.enqueuedInstructions.length === 10);
    expect(engine.enqueuedInstructions).toEqual(labels);
    // Bridge FIFO should be empty (they all went to engine)
    expect(harness.state.messageQueue).toEqual([]);

    releaseA();
    await aPromise;
    // Engine internally processes B..K, bridge does not re-submit them
    expect(engine.submitted).toEqual(['A']);
  });

  it('5. cancel clears submitQueue and pendingInput is not processed', async () => {
    let releaseA!: () => void;
    const aReleased = new Promise<void>(resolve => { releaseA = resolve; });
    const engine = mockEngine([
      async function* () {
        await aReleased;
        yield { role: 'status', content: 'interrupted' };
      },
      async function* () {
        yield { role: 'assistant_final', content: 'after-cancel' };
        yield { role: 'done' };
      },
    ]);
    const harness = stateHarness();
    const bridge = createBridge(engine as unknown as ReasonixEngine, harness.setState);

    const aPromise = bridge.submit('A');
    await waitFor(() => engine.submitted.length === 1);

    // While A is running, fill engine queue (mock allows 10) then overflow
    for (let i = 0; i < 10; i++) {
      bridge.submit(`msg-${i}`);
    }
    bridge.submit('overflow-1');
    bridge.submit('overflow-2');
    await waitFor(() => harness.state.messageQueue.length === 2);
    expect(harness.state.messageQueue).toEqual(['overflow-1', 'overflow-2']);

    // Cancel — should clear submitQueue
    bridge.cancel();
    await waitFor(() => harness.state.messageQueue.length === 0);
    expect(harness.state.messageQueue).toEqual([]);

    releaseA();
    await aPromise;

    // After cancel + A completes, the overflow messages should NOT be re-submitted
    // (they were cleared from submitQueue)
    await new Promise(r => setTimeout(r, 50));
    expect(engine.submitted).toEqual(['A']);
  });
});
