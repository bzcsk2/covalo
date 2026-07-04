import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { WorkflowCoordinator } from '@covalo/core/workflow-coordinator/coordinator.js';
import type { WorkflowEvent } from '@covalo/core/workflow-coordinator/types.js';
import type { LoopEvent } from '@covalo/core';
import { createBridge } from '../src/bridge.js';
import type { BridgeState } from '../src/bridge.js';

/**
 * SPEC S1-3 §6.4 测试要求：workflow tool item key 稳定化
 *
 * 1. 同一 workflow turn 内两个 bash tool_start 且无 toolCallIndex，最终 timeline 有两个 tool item。
 * 2. 有 toolCallIndex 时 progress/final 能更新对应 item。
 * 3. phase/turn 切换后 key map 清空，不串到下一 turn。
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
 * 与 bridge-workflow-batching.test.ts 一致的真实行为 mock：
 * - startWorkflow 时初始化 state 为 supervisor_analyse
 * - 发射 completed/failed 后 isFinished() 返回 true
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

describe('SPEC S1-3: workflow tool item key 稳定化', () => {
  let setStateCalls: BridgeState;
  let setState: (update: any) => void;
  let originalFlushMs: string | undefined;

  beforeAll(() => {
    originalFlushMs = process.env.DEEPCODE_DELTA_FLUSH_MS;
    process.env.DEEPCODE_DELTA_FLUSH_MS = '0';
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

  it('1. 同一 turn 内两个 bash tool_start 且无 toolCallIndex → timeline 有两个 tool item', async () => {
    const events: Array<WorkflowEvent | LoopEvent> = [
      { type: 'phase_change', workflowId: 'wf-1', phase: 'supervisor_analyse', iteration: 1, timestamp: Date.now() },
      // 第一个 bash（无 toolCallIndex）
      { role: 'tool_start', toolName: 'bash' },
      { role: 'tool', toolName: 'bash', content: '{"stdout":"first"}' },
      // 第二个 bash（无 toolCallIndex，同名）
      { role: 'tool_start', toolName: 'bash' },
      { role: 'tool', toolName: 'bash', content: '{"stdout":"second"}' },
      { type: 'completed', workflowId: 'wf-1', timestamp: Date.now() },
    ];

    const bridge = makeBridge(events);
    await bridge.runWorkflow('test goal');

    const tools = setStateCalls.timeline.filter(item => item.kind === 'tool');
    // 关键断言：两个同名工具不被覆盖，timeline 有两个 tool item
    expect(tools.length).toBe(2);
    expect(tools[0]?.tool.output).toBe('{"stdout":"first"}');
    expect(tools[1]?.tool.output).toBe('{"stdout":"second"}');
  });

  it('2. 有 toolCallIndex 时 progress/final 能更新对应 item', async () => {
    const events: Array<WorkflowEvent | LoopEvent> = [
      { type: 'phase_change', workflowId: 'wf-1', phase: 'supervisor_analyse', iteration: 1, timestamp: Date.now() },
      // 两个并发工具，使用不同的 toolCallIndex
      { role: 'tool_start', toolName: 'bash', toolCallIndex: 0 },
      { role: 'tool_start', toolName: 'grep', toolCallIndex: 1 },
      { role: 'tool_progress', toolName: 'bash', toolCallIndex: 0, content: 'working' },
      { role: 'tool', toolName: 'bash', toolCallIndex: 0, content: 'done-bash' },
      { role: 'tool', toolName: 'grep', toolCallIndex: 1, content: 'done-grep' },
      { type: 'completed', workflowId: 'wf-1', timestamp: Date.now() },
    ];

    const bridge = makeBridge(events);
    await bridge.runWorkflow('test goal');

    const tools = setStateCalls.timeline.filter(item => item.kind === 'tool');
    expect(tools.length).toBe(2);
    const bashTool = tools.find(t => t.kind === 'tool' && t.tool.name === 'bash');
    const grepTool = tools.find(t => t.kind === 'tool' && t.tool.name === 'grep');
    expect(bashTool?.tool.output).toContain('done-bash');
    expect(grepTool?.tool.output).toBe('done-grep');
  });

  it('3. phase/turn 切换后 key map 清空，不串到下一 turn', async () => {
    const events: Array<WorkflowEvent | LoopEvent> = [
      // 第一个 turn（supervisor_analyse phase）
      { type: 'phase_change', workflowId: 'wf-1', phase: 'supervisor_analyse', iteration: 1, timestamp: Date.now() },
      { role: 'tool_start', toolName: 'bash' },  // turn 1: tool_bash_1
      { role: 'tool', toolName: 'bash', content: 'turn-1-bash' },
      // phase 切换到 worker_do —— 触发 finalizeWorkflowTurn + startWorkflowTurn（key map 重置）
      { type: 'phase_change', workflowId: 'wf-1', phase: 'worker_do', iteration: 1, timestamp: Date.now() },
      // 第二个 turn 的同名 bash —— 应得到新 key tool_bash_1（因 wfToolSequence 从 0 重置）
      { role: 'tool_start', toolName: 'bash' },
      { role: 'tool', toolName: 'bash', content: 'turn-2-bash' },
      { type: 'completed', workflowId: 'wf-1', timestamp: Date.now() },
    ];

    const bridge = makeBridge(events);
    await bridge.runWorkflow('test goal');

    const tools = setStateCalls.timeline.filter(item => item.kind === 'tool');
    // 两个 turn 各一个 bash，共 2 个 tool item，且输出不串写
    expect(tools.length).toBe(2);
    const outputs = tools.map(t => (t.kind === 'tool' ? t.tool.output : ''));
    expect(outputs).toContain('turn-1-bash');
    expect(outputs).toContain('turn-2-bash');
  });
});
