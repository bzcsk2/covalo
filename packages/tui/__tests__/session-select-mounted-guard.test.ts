/**
 * SPEC S3-1: session select mounted guard 测试。
 *
 * App.tsx 的 handleSessionSelect 在加载 supervisor session 时是 fire-and-forget，
 * 必须保证 promise 完成后若组件已卸载，则不进行任何 setState。
 *
 * 由于 handleSessionSelect 是 App.tsx 内部的 useCallback，无法直接单元测试，
 * 这里通过 mock 一个最小化的"同模式"实现，验证：
 * 1. mountedRef.current=false 时 .then() 短路，不执行副作用
 * 2. mountedRef.current=true 时 .then() 正常执行
 * 3. fire-and-forget + catch 不会抛出未捕获异常
 */
import { describe, expect, it, vi } from 'vitest';

interface DualRuntimeLike {
  loadSupervisorSession(sessionId: string): Promise<unknown>;
}

interface MountedRefLike {
  current: boolean;
}

/**
 * 复现 App.tsx 中 handleSessionSelect 对 dualRuntime 的处理模式。
 */
async function handleSelectPattern(
  sessionId: string,
  dualRuntime: DualRuntimeLike | null,
  mountedRef: MountedRefLike,
  onThenSideEffect: () => void,
): Promise<void> {
  if (dualRuntime) {
    void dualRuntime
      .loadSupervisorSession(sessionId)
      .then(() => {
        if (!mountedRef.current) return;
        onThenSideEffect();
      })
      .catch(() => {});
  }
}

describe('S3-1: session select mounted guard', () => {
  it('does not invoke side effect when component unmounts before resolve', async () => {
    const mountedRef: MountedRefLike = { current: true };
    let resolveFn: (() => void) | null = null;
    const loadPromise = new Promise(resolve => {
      resolveFn = resolve;
    });
    const dualRuntime: DualRuntimeLike = {
      loadSupervisorSession: () => loadPromise,
    };
    const sideEffect = vi.fn();

    await handleSelectPattern('sess-1', dualRuntime, mountedRef, sideEffect);
    // 卸载组件
    mountedRef.current = false;
    // resolve promise
    resolveFn!();
    // 等待微任务队列刷新
    await Promise.resolve();
    await Promise.resolve();

    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('invokes side effect when component is still mounted at resolve', async () => {
    const mountedRef: MountedRefLike = { current: true };
    let resolveFn: (() => void) | null = null;
    const loadPromise = new Promise(resolve => {
      resolveFn = resolve;
    });
    const dualRuntime: DualRuntimeLike = {
      loadSupervisorSession: () => loadPromise,
    };
    const sideEffect = vi.fn();

    await handleSelectPattern('sess-1', dualRuntime, mountedRef, sideEffect);
    // 仍然 mounted
    resolveFn!();
    await Promise.resolve();
    await Promise.resolve();

    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it('does not throw when dualRuntime is null', async () => {
    const mountedRef: MountedRefLike = { current: true };
    const sideEffect = vi.fn();
    await expect(
      handleSelectPattern('sess-1', null, mountedRef, sideEffect),
    ).resolves.toBeUndefined();
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('catches loadSupervisorSession rejection without throwing (fire-and-forget)', async () => {
    const mountedRef: MountedRefLike = { current: true };
    const dualRuntime: DualRuntimeLike = {
      loadSupervisorSession: () => Promise.reject(new Error('boom')),
    };
    const sideEffect = vi.fn();

    // 不应抛出
    await expect(
      handleSelectPattern('sess-1', dualRuntime, mountedRef, sideEffect),
    ).resolves.toBeUndefined();
    // 等待微任务
    await Promise.resolve();
    await Promise.resolve();
    // 拒绝路径不走 .then()，所以 sideEffect 不应被调用
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it('passes sessionId through to loadSupervisorSession', async () => {
    const mountedRef: MountedRefLike = { current: true };
    const receivedIds: string[] = [];
    const dualRuntime: DualRuntimeLike = {
      loadSupervisorSession: (id: string) => {
        receivedIds.push(id);
        return Promise.resolve();
      },
    };
    const sideEffect = vi.fn();

    await handleSelectPattern('sess-abc-123', dualRuntime, mountedRef, sideEffect);
    await Promise.resolve();
    await Promise.resolve();

    expect(receivedIds).toEqual(['sess-abc-123']);
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });
});
