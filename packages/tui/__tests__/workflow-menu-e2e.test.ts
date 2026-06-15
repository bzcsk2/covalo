/**
 * SFR-90: Workflow 菜单端到端集成测试
 *
 * 覆盖场景：
 * 1. createBridge + workflowCoordinator 接线：runWorkflow 正确处理事件流
 * 2. cancel 中断 Coordinator
 * 3. 三种模式的 routeWorkflowInput → bridge 动作一致性
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import type { WorkflowCoordinator } from '@deepreef/core/workflow-coordinator/coordinator.js';
import type { WorkflowEvent } from '@deepreef/core/workflow-coordinator/types.js';
import type { LoopEvent } from '@deepreef/core';
import { createBridge } from '../src/bridge.js';
import { routeWorkflowInput } from '../src/workflow-mode-router.js';
import type { BridgeState, TimelineItem } from '../src/bridge.js';
import type { WorkflowLifecycle } from '../src/workflow-mode-router.js';

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
  let interrupted = false;
  return {
    interrupt: () => { interrupted = true; },
    get interrupted() { return interrupted; },
    submit: function* () {},
    respondPermission: () => {},
    rejectQuestion: () => {},
    respondQuestion: () => {},
  };
}

function makeMockCoordinator() {
  const events: WorkflowEvent[] = [
    { type: 'phase_change', workflowId: 'wf-1', phase: 'supervisor_analyse', iteration: 1, timestamp: Date.now() },
    { type: 'phase_change', workflowId: 'wf-1', phase: 'worker_do', iteration: 1, timestamp: Date.now() },
    { type: 'completed', workflowId: 'wf-1', timestamp: Date.now() },
  ];
  const interruptedCalls: number[] = [];
  const startedGoals: string[] = [];
  let state: any = null;

  return {
    startWorkflow: (opts: any) => {
      startedGoals.push(opts.goal);
      state = { currentPhase: 'supervisor_analyse', iteration: 1 };
    },
    runWorkflow: async function* () {
      for (const evt of events) {
        yield evt;
      }
    },
    interrupt: () => { interruptedCalls.push(Date.now()); },
    reset: () => { state = null; },
    getState: () => state,
    startedGoals,
    interruptedCalls,
    events,
  };
}

describe('SFR-90: workflow e2e integration', () => {
  let setStateCalls: BridgeState;
  let engine: any;
  let coordinator: ReturnType<typeof makeMockCoordinator>;
  let bridge: ReturnType<typeof createBridge>;
  let phaseChanges: string[];

  beforeEach(() => {
    setStateCalls = initialState();
    engine = makeMockEngine();
    coordinator = makeMockCoordinator();
    phaseChanges = [];
    const setState = (update: any) => {
      setStateCalls = typeof update === 'function' ? update(setStateCalls) : update;
    };
    bridge = createBridge(
      engine as any,
      setState,
      undefined,
      undefined,
      undefined,
      undefined,
      coordinator as unknown as WorkflowCoordinator,
    );
  });

  afterEach(() => {
    delete process.env.DEEPCODE_DELTA_FLUSH_MS;
  });

  it('scenario 1: runWorkflow emits phase_change events through callback', async () => {
    const phases: string[] = [];
    await bridge.runWorkflow('test goal', (phase, iteration, finalStatus) => {
      if (finalStatus) {
        phases.push(`final:${finalStatus}`);
        return;
      }
      phases.push(`${phase}:${iteration}`);
    });

    expect(phases).toContain('supervisor_analyse:1');
    expect(phases).toContain('worker_do:1');
    expect(phases).toContain('final:completed');
    expect(coordinator.startedGoals).toContain('test goal');
  });

  it('scenario 2: cancel interrupts coordinator', async () => {
    bridge.cancel();

    expect(coordinator.interruptedCalls.length).toBe(1);
    expect(engine.interrupted).toBe(true);
  });

  it('scenario 3: routeWorkflowInput + bridge mode consistency', () => {
    const lifecycle: WorkflowLifecycle = { status: 'running', workflowId: 'wf-1' };
    const route = routeWorkflowInput({
      mode: 'loop',
      lifecycle,
      activeRole: 'supervisor',
      input: 'do something',
      inputKind: 'text',
    });
    expect(route.type).toBe('workflow_instruction');
    expect(route).toEqual({ type: 'workflow_instruction', content: 'do something' });
  });

  it('scenario 4: routeWorkflowInput start_workflow when lifecycle is awaiting_goal', () => {
    const route = routeWorkflowInput({
      mode: 'loop',
      lifecycle: { status: 'awaiting_goal' },
      activeRole: 'supervisor',
      input: 'my goal',
      inputKind: 'text',
    });
    expect(route.type).toBe('start_workflow');
    expect(route).toEqual({ type: 'start_workflow', goal: 'my goal' });
  });
});
