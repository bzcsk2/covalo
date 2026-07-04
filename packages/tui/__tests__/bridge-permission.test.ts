/**
 * SPEC S0-1: 权限回复定向化 TUI Bridge 层单元测试
 *
 * 验证 bridge.respondPermission(requestId, originRole, reply, message)：
 * - originRole='worker' 只调用 worker engine 的 respondPermissionForRequest
 * - originRole='supervisor' 只调用 supervisor engine 的 respondPermissionForRequest
 * - originRole='main' 且无 dualRuntime 时，fallback 到 engine.respondPermission
 * - 不再广播到三个 engine
 *
 * 对照 spec docs/covalo_tui_fix_implementation_spec_20260705.md §2.4 TUI Bridge 测试
 */
import { describe, it, expect, vi } from 'vitest';
import type { LoopEvent, ReasonixEngine } from '@covalo/core';
import { createBridge, type BridgeState, type TimelineItem } from '../src/bridge.js';

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

function mockMainEngine() {
  const submitted: string[] = [];
  let interrupted = 0;
  return {
    submitted,
    get interrupted() { return interrupted; },
    submit(text: string) {
      submitted.push(text);
      return (async function* () {
        yield { role: 'done' as const };
      })();
    },
    respondPermission: vi.fn(),
    respondPermissionForRequest: vi.fn().mockReturnValue(true),
    interrupt() { interrupted++; },
    enqueueInstruction: () => ({ status: 'ignored' as const, queueLength: 0 }),
  };
}

function mockDualEngine() {
  return {
    submit(text: string) {
      return (async function* () {
        yield { role: 'done' as const };
      })();
    },
    respondPermission: vi.fn(),
    respondPermissionForRequest: vi.fn().mockReturnValue(true),
    interrupt: vi.fn(),
  };
}

function mockDualRuntime(workerEngine: ReturnType<typeof mockDualEngine>, supervisorEngine: ReturnType<typeof mockDualEngine>) {
  return {
    getWorker: () => ({ getEngine: () => workerEngine }),
    getSupervisor: () => ({ getEngine: () => supervisorEngine }),
    interruptRole: vi.fn(),
  };
}

describe('SPEC S0-1: bridge.respondPermission(requestId, originRole, reply)', () => {
  it('originRole=worker 时只调用 worker engine 的 respondPermissionForRequest', () => {
    const mainEngine = mockMainEngine();
    const workerEngine = mockDualEngine();
    const supervisorEngine = mockDualEngine();
    const dualRuntime = mockDualRuntime(workerEngine, supervisorEngine);
    const harness = stateHarness();

    const bridge = createBridge(
      mainEngine as unknown as ReasonixEngine,
      harness.setState,
      undefined, undefined, undefined,
      dualRuntime as any,
    );

    bridge.respondPermission('perm_test_worker_1', 'worker', 'once');

    // Worker engine 的 respondPermissionForRequest 应被调用，参数为 (requestId, true, false)
    expect(workerEngine.respondPermissionForRequest).toHaveBeenCalledWith('perm_test_worker_1', true, false);
    // Supervisor 和 main 不应被调用
    expect(supervisorEngine.respondPermissionForRequest).not.toHaveBeenCalled();
    expect(mainEngine.respondPermission).not.toHaveBeenCalled();
    expect(mainEngine.respondPermissionForRequest).not.toHaveBeenCalled();
    // permissionPrompt 应被清空
    expect(harness.state.permissionPrompt).toBeNull();
  });

  it('originRole=supervisor 时只调用 supervisor engine 的 respondPermissionForRequest', () => {
    const mainEngine = mockMainEngine();
    const workerEngine = mockDualEngine();
    const supervisorEngine = mockDualEngine();
    const dualRuntime = mockDualRuntime(workerEngine, supervisorEngine);
    const harness = stateHarness();

    const bridge = createBridge(
      mainEngine as unknown as ReasonixEngine,
      harness.setState,
      undefined, undefined, undefined,
      dualRuntime as any,
    );

    bridge.respondPermission('perm_test_sup_1', 'supervisor', 'always');

    expect(supervisorEngine.respondPermissionForRequest).toHaveBeenCalledWith('perm_test_sup_1', true, true);
    expect(workerEngine.respondPermissionForRequest).not.toHaveBeenCalled();
    expect(mainEngine.respondPermission).not.toHaveBeenCalled();
  });

  it('originRole=main 且 dualRuntime 存在时调用 main engine 的 respondPermissionForRequest', () => {
    const mainEngine = mockMainEngine();
    const workerEngine = mockDualEngine();
    const supervisorEngine = mockDualEngine();
    const dualRuntime = mockDualRuntime(workerEngine, supervisorEngine);
    const harness = stateHarness();

    const bridge = createBridge(
      mainEngine as unknown as ReasonixEngine,
      harness.setState,
      undefined, undefined, undefined,
      dualRuntime as any,
    );

    bridge.respondPermission('perm_test_main_1', 'main', 'once');

    expect(mainEngine.respondPermissionForRequest).toHaveBeenCalledWith('perm_test_main_1', true, false);
    // 不应广播到 worker/supervisor
    expect(workerEngine.respondPermissionForRequest).not.toHaveBeenCalled();
    expect(supervisorEngine.respondPermissionForRequest).not.toHaveBeenCalled();
    // 不应调用 legacy respondPermission
    expect(mainEngine.respondPermission).not.toHaveBeenCalled();
  });

  it('legacy 单 engine 模式（无 dualRuntime）fallback 到 engine.respondPermission', () => {
    const mainEngine = mockMainEngine();
    const harness = stateHarness();

    const bridge = createBridge(
      mainEngine as unknown as ReasonixEngine,
      harness.setState,
    );

    bridge.respondPermission('perm_legacy_1', 'main', 'once');

    // 应调用 legacy respondPermission（消费任意 pending）
    expect(mainEngine.respondPermission).toHaveBeenCalledWith(true, false);
    // 不应调用 respondPermissionForRequest（因为走 legacy fallback 分支）
    expect(mainEngine.respondPermissionForRequest).not.toHaveBeenCalled();
  });

  it('reply=reject 时 allow=false，调用定向 engine', () => {
    const mainEngine = mockMainEngine();
    const workerEngine = mockDualEngine();
    const supervisorEngine = mockDualEngine();
    const dualRuntime = mockDualRuntime(workerEngine, supervisorEngine);
    const harness = stateHarness();

    const bridge = createBridge(
      mainEngine as unknown as ReasonixEngine,
      harness.setState,
      undefined, undefined, undefined,
      dualRuntime as any,
    );

    bridge.respondPermission('perm_reject_1', 'worker', 'reject');

    expect(workerEngine.respondPermissionForRequest).toHaveBeenCalledWith('perm_reject_1', false, false);
  });

  it('worker engine 未匹配 pending 时，不广播到其他 engine（不污染）', () => {
    const mainEngine = mockMainEngine();
    const workerEngine = mockDualEngine();
    // worker 返回 false（未找到 pending）
    workerEngine.respondPermissionForRequest.mockReturnValue(false);
    const supervisorEngine = mockDualEngine();
    const dualRuntime = mockDualRuntime(workerEngine, supervisorEngine);
    const harness = stateHarness();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const bridge = createBridge(
      mainEngine as unknown as ReasonixEngine,
      harness.setState,
      undefined, undefined, undefined,
      dualRuntime as any,
    );

    bridge.respondPermission('perm_unmatched_1', 'worker', 'once');

    expect(workerEngine.respondPermissionForRequest).toHaveBeenCalledWith('perm_unmatched_1', true, false);
    // 关键：未匹配也不应广播到其他 engine
    expect(supervisorEngine.respondPermissionForRequest).not.toHaveBeenCalled();
    expect(mainEngine.respondPermissionForRequest).not.toHaveBeenCalled();
    expect(mainEngine.respondPermission).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
