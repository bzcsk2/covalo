import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { WorkflowCoordinator } from '@covalo/core/workflow-coordinator/coordinator.js';
import type { WorkflowEvent } from '@covalo/core/workflow-coordinator/types.js';
import type { LoopEvent } from '@covalo/core';
import { createBridge } from '../src/bridge.js';
import type { BridgeState } from '../src/bridge.js';

/**
 * SPEC S1-2 §5.4 测试要求：workflow delta batching
 *
 * 1. 模拟 100 个 workflow assistant_delta，断言最终只产生 1 个 assistant_text item。
 * 2. assistant_final 后最终文本完整且 isStreaming=false。
 * 3. phase 切换时不会把前一 turn 的 timer 写入后一 turn。
 * 4. DEEPCODE_DELTA_FLUSH_MS=0 时仍立即刷新，便于测试。
 */

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

function makeMockEngine() {
  return {
    interrupt: () => {},
    submit: function* () {},
    respondPermission: () => {},
    rejectQuestion: () => {},
    respondQuestion: () => {},
  };
}

/**
 * Mock coordinator：模拟真实行为 ——
 * - startWorkflow 时初始化 state 为 supervisor_analyse
 * - 发射 completed/failed/blocked 后 isFinished() 返回 true
 * - getState() 返回当前 phase（避免 Phase G 误判可继续）
 */
function makeMockCoordinator(events: Array<WorkflowEvent | LoopEvent>) {
  let runCount = 0;
  let finished = false;
  let state: { currentPhase: string; iteration: number; workflowId: string } | null = null;
  const goalStore = { getGoal: () => ({ status: finished ? 'completed' : 'active' }) };

  return {
    startWorkflow: () => {
      state = { currentPhase: 'supervisor_analyse', iteration: 1, workflowId: 'wf-1' };
      finished = false;
    },
    runWorkflow: async function* () {
      runCount += 1;
      for (const evt of events) {
        const wfEvt = evt as WorkflowEvent;
        if (wfEvt.type === 'completed' || wfEvt.type === 'failed') {
          finished = true;
          state = { currentPhase: wfEvt.type, iteration: 1, workflowId: 'wf-1' };
        } else if (wfEvt.type === 'phase_change' && wfEvt.phase) {
          state = { currentPhase: wfEvt.phase, iteration: wfEvt.iteration ?? 1, workflowId: wfEvt.workflowId ?? 'wf-1' };
        }
        yield evt;
      }
    },
    interrupt: () => {},
    resumeInterruptedWorkflow: () => {},
    resumeBlockedWorkflow: () => {},
    reset: () => { runCount = 0; finished = false; state = null; },
    getState: () => state,
    isFinished: () => finished,
    // SPEC S3-2: mock 提供 isInterrupted() 以匹配真实 WorkflowCoordinator API
    isInterrupted: () => false,
    getGoalStore: () => goalStore,
    get runCount() { return runCount; },
  };
}

describe('SPEC S1-2: workflow delta batching', () => {
  let setStateCalls: BridgeState;
  let setState: (update: any) => void;
  let originalFlushMs: string | undefined;

  beforeAll(() => {
    originalFlushMs = process.env.DEEPCODE_DELTA_FLUSH_MS;
  });

  afterAll(() => {
    if (originalFlushMs === undefined) delete process.env.DEEPCODE_DELTA_FLUSH_MS;
    else process.env.DEEPCODE_DELTA_FLUSH_MS = originalFlushMs;
  });

  beforeEach(() => {
    setStateCalls = initialState();
    setState = (update: any) => {
      setStateCalls = typeof update === 'function' ? update(setStateCalls) : update;
    };
  });

  function makeBridge(events: Array<WorkflowEvent | LoopEvent>) {
    const engine = makeMockEngine();
    const coordinator = makeMockCoordinator(events);
    return createBridge(
      engine as any,
      setState as any,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator as unknown as WorkflowCoordinator,
    );
  }

  it('1. 100 个 workflow assistant_delta → 最终只产生 1 个 assistant_text item', async () => {
    // 用 DEEPCODE_DELTA_FLUSH_MS=50 让 batching 真正生效
    process.env.DEEPCODE_DELTA_FLUSH_MS = '50';

    const events: Array<WorkflowEvent | LoopEvent> = [
      { type: 'phase_change', workflowId: 'wf-1', phase: 'supervisor_analyse', iteration: 1, timestamp: Date.now() },
    ];
    // 100 个 assistant_delta
    for (let i = 0; i < 100; i++) {
      events.push({ role: 'assistant_delta', content: 'x' });
    }
    // assistant_final 终结
    events.push({ role: 'assistant_final', content: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' });
    events.push({ type: 'completed', workflowId: 'wf-1', timestamp: Date.now() });

    const bridge = makeBridge(events);
    await bridge.runWorkflow('test goal');

    // 最终 timeline 应该只有 1 个 assistant_text item（100 个 delta 被合并写入同一个 id）
    const assistantTexts = setStateCalls.timeline.filter(item => item.kind === 'assistant_text');
    expect(assistantTexts.length).toBe(1);
    // 合并后写入次数 < 100（batcher 每 50ms 一次，100 个 delta 至多触发 2-3 次 flush + final 1 次）
    // 我们不直接断言写入次数，但通过验证最终 item 只有一个来间接验证合并正确
  });

  it('2. assistant_final 后文本完整且 isStreaming=false', async () => {
    process.env.DEEPCODE_DELTA_FLUSH_MS = '50';

    const finalText = 'final content';
    const events: Array<WorkflowEvent | LoopEvent> = [
      { type: 'phase_change', workflowId: 'wf-1', phase: 'supervisor_analyse', iteration: 1, timestamp: Date.now() },
      { role: 'assistant_delta', content: 'partial ' },
      { role: 'assistant_final', content: finalText },
      { type: 'completed', workflowId: 'wf-1', timestamp: Date.now() },
    ];

    const bridge = makeBridge(events);
    await bridge.runWorkflow('test goal');

    const assistantTexts = setStateCalls.timeline.filter(item => item.kind === 'assistant_text');
    expect(assistantTexts.length).toBe(1);
    // assistant_final 的 content 覆盖了累积的 delta
    expect(assistantTexts[0]?.text).toBe(finalText);
    expect(assistantTexts[0]?.isStreaming).toBe(false);
  });

  it('3. phase 切换不会把前一 turn 的 timer 写入后一 turn', async () => {
    process.env.DEEPCODE_DELTA_FLUSH_MS = '50';

    const events: Array<WorkflowEvent | LoopEvent> = [
      { type: 'phase_change', workflowId: 'wf-1', phase: 'supervisor_analyse', iteration: 1, timestamp: Date.now() },
      { role: 'assistant_delta', content: 'sup ' },
      { role: 'assistant_final', content: 'sup plan' },
      { type: 'phase_change', workflowId: 'wf-1', phase: 'worker_do', iteration: 1, timestamp: Date.now() },
      { role: 'assistant_delta', content: 'worker ' },
      { role: 'assistant_final', content: 'worker result' },
      { type: 'completed', workflowId: 'wf-1', timestamp: Date.now() },
    ];

    const bridge = makeBridge(events);
    await bridge.runWorkflow('test goal');

    const assistantTexts = setStateCalls.timeline.filter(item => item.kind === 'assistant_text');
    // 两个 phase 应该有两个 assistant_text item，且文本不串写
    expect(assistantTexts.length).toBe(2);
    const texts = assistantTexts.map(item => item.text);
    expect(texts).toContain('sup plan');
    expect(texts).toContain('worker result');
    // 验证 role 正确（不串写）
    const supItem = assistantTexts.find(item => item.text === 'sup plan');
    const workerItem = assistantTexts.find(item => item.text === 'worker result');
    expect(supItem?.role).toBe('supervisor');
    expect(workerItem?.role).toBe('worker');
  });

  it('4. DEEPCODE_DELTA_FLUSH_MS=0 时立即刷新', async () => {
    process.env.DEEPCODE_DELTA_FLUSH_MS = '0';

    const events: Array<WorkflowEvent | LoopEvent> = [
      { type: 'phase_change', workflowId: 'wf-1', phase: 'supervisor_analyse', iteration: 1, timestamp: Date.now() },
      { role: 'assistant_delta', content: 'a' },
      { role: 'assistant_delta', content: 'b' },
      { role: 'assistant_delta', content: 'c' },
      { role: 'assistant_final', content: 'abc' },
      { type: 'completed', workflowId: 'wf-1', timestamp: Date.now() },
    ];

    const bridge = makeBridge(events);
    await bridge.runWorkflow('test goal');

    const assistantTexts = setStateCalls.timeline.filter(item => item.kind === 'assistant_text');
    expect(assistantTexts.length).toBe(1);
    expect(assistantTexts[0]?.text).toBe('abc');
    expect(assistantTexts[0]?.isStreaming).toBe(false);
  });
});
