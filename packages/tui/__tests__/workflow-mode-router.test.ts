/**
 * SFR-50 / SFR-90: WorkflowModeRouter 纯函数测试
 *
 * 验证 routeWorkflowInput 在所有 mode + lifecycle 组合下的正确路由。
 */
import { describe, it, expect } from 'bun:test';
import { routeWorkflowInput } from '../src/workflow-mode-router.js';
import type { WorkflowLifecycle } from '../src/workflow-mode-router.js';

function aloneOpts(overrides?: Partial<Parameters<typeof routeWorkflowInput>[0]>) {
  return { mode: 'alone' as const, lifecycle: { status: 'idle' } as WorkflowLifecycle, activeRole: 'supervisor' as const, input: 'hello', inputKind: 'text' as const, ...overrides };
}

function subagentOpts(overrides?: Partial<Parameters<typeof routeWorkflowInput>[0]>) {
  return { mode: 'subagent' as const, lifecycle: { status: 'idle' } as WorkflowLifecycle, activeRole: 'supervisor' as const, input: 'hello', inputKind: 'text' as const, ...overrides };
}

function loopOpts(lifecycle: WorkflowLifecycle, overrides?: Partial<Parameters<typeof routeWorkflowInput>[0]>) {
  return { mode: 'loop' as const, lifecycle, activeRole: 'supervisor' as const, input: 'do something', inputKind: 'text' as const, ...overrides };
}

describe('routeWorkflowInput', () => {
  describe('alone mode', () => {
    it('routes text to activeRole', () => {
      const r = routeWorkflowInput(aloneOpts({ activeRole: 'supervisor' }));
      expect(r).toEqual({ type: 'direct', role: 'supervisor', mode: 'alone' });
    });

    it('routes commands as direct', () => {
      const r = routeWorkflowInput(aloneOpts({ input: '/help', inputKind: 'command' }));
      expect(r).toEqual({ type: 'direct', role: 'supervisor', mode: 'alone' });
    });

    it('routes text to worker when activeRole is worker', () => {
      const r = routeWorkflowInput(aloneOpts({ activeRole: 'worker' }));
      expect(r).toEqual({ type: 'direct', role: 'worker', mode: 'alone' });
    });
  });

  describe('subagent mode', () => {
    it('routes text to supervisor', () => {
      const r = routeWorkflowInput(subagentOpts());
      expect(r).toEqual({ type: 'supervisor_task', mode: 'subagent' });
    });

    it('routes commands as direct (not supervisor_task)', () => {
      const r = routeWorkflowInput(subagentOpts({ input: '/help', inputKind: 'command' }));
      expect(r).toEqual({ type: 'direct', role: 'supervisor', mode: 'alone' });
    });
  });

  describe('loop mode', () => {
    it('routes text as start_workflow when lifecycle is idle', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'idle' }));
      expect(r).toEqual({ type: 'start_workflow', goal: 'do something' });
    });

    it('routes text as start_workflow when lifecycle is awaiting_goal', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'awaiting_goal' }));
      expect(r).toEqual({ type: 'start_workflow', goal: 'do something' });
    });

    it('routes text as start_workflow when lifecycle is completed', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'completed', workflowId: 'wf-1' }));
      expect(r).toEqual({ type: 'start_workflow', goal: 'do something' });
    });

    it('routes text as start_workflow when lifecycle is failed', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'failed', workflowId: 'wf-1' }));
      expect(r).toEqual({ type: 'start_workflow', goal: 'do something' });
    });

    it('routes text as workflow_instruction when lifecycle is running', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'running', workflowId: 'wf-1' }));
      expect(r).toEqual({ type: 'workflow_instruction', content: 'do something' });
    });

    it('rejects text when lifecycle is waiting_user (prompt already shown)', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'waiting_user', workflowId: 'wf-1' }));
      expect(r).toEqual({ type: 'reject', reason: 'Workflow is waiting for your answer in the prompt.' });
    });

    it('routes text as resume_workflow when blocked due to user interruption', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'blocked', workflowId: 'wf-1', reason: 'Interrupted by user' }));
      expect(r).toEqual({ type: 'resume_workflow', instruction: 'do something' });
    });

    it('routes text as resume_workflow when blocked because goal is paused', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'blocked', workflowId: 'wf-1', reason: 'Goal is paused' }));
      expect(r).toEqual({ type: 'resume_workflow', instruction: 'do something' });
    });

    it('routes text as resume_workflow when blocked because user rejected question', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'blocked', workflowId: 'wf-1', reason: 'User rejected question' }));
      expect(r).toEqual({ type: 'resume_workflow', instruction: 'do something' });
    });

    it('rejects text when lifecycle is blocked for another reason', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'blocked', workflowId: 'wf-1' }));
      expect(r).toEqual({ type: 'reject', reason: expect.stringContaining('/reset') });
    });

    it('overrides with command direct regardless of lifecycle', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'running', workflowId: 'wf-1' }, { input: '/list', inputKind: 'command' }));
      expect(r).toEqual({ type: 'direct', role: 'supervisor', mode: 'alone' });
    });
  });

  describe('eval mode', () => {
    it('routes text to activeRole when activeRole is worker', () => {
      const r = routeWorkflowInput({ mode: 'eval', lifecycle: { status: 'idle' }, activeRole: 'worker', input: 'hello', inputKind: 'text' });
      expect(r).toEqual({ type: 'direct', role: 'worker', mode: 'alone' });
    });

    it('routes text to activeRole when activeRole is supervisor', () => {
      const r = routeWorkflowInput({ mode: 'eval', lifecycle: { status: 'idle' }, activeRole: 'supervisor', input: 'hello', inputKind: 'text' });
      expect(r).toEqual({ type: 'direct', role: 'supervisor', mode: 'alone' });
    });

    it('routes commands as direct', () => {
      const r = routeWorkflowInput({ mode: 'eval', lifecycle: { status: 'idle' }, activeRole: 'worker', input: '/help', inputKind: 'command' });
      expect(r).toEqual({ type: 'direct', role: 'worker', mode: 'alone' });
    });
  });

  describe('commands in any mode', () => {
    it('routes /help as direct in subagent mode', () => {
      const r = routeWorkflowInput(subagentOpts({ input: '/help', inputKind: 'command' }));
      expect(r).toEqual({ type: 'direct', role: 'supervisor', mode: 'alone' });
    });

    it('routes /help as direct in loop running mode', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'running', workflowId: 'wf-1' }, { input: '/help', inputKind: 'command' }));
      expect(r).toEqual({ type: 'direct', role: 'supervisor', mode: 'alone' });
    });

    it('routes /help as direct in loop blocked mode', () => {
      const r = routeWorkflowInput(loopOpts({ status: 'blocked', workflowId: 'wf-1' }, { input: '/help', inputKind: 'command' }));
      expect(r).toEqual({ type: 'direct', role: 'supervisor', mode: 'alone' });
    });
  });
});
