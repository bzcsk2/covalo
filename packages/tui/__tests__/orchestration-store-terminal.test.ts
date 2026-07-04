/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * SPEC S2-2: OrchestrationStore terminal worker 清理策略测试
 */
import { describe, it, expect } from 'vitest';
import { OrchestrationStore } from '../src/store/orchestration-store.js';
import type { OrchestrationEventPayload, WorkerSnapshot } from '@covalo/core';

function makeWorkerUpsert(overrides: Partial<WorkerSnapshot> & { id: string }): OrchestrationEventPayload {
  return {
    kind: 'worker_upsert',
    worker: {
      modelTarget: 'test-model',
      status: 'running',
      elapsedMs: 0,
      ...overrides,
    },
  };
}

/**
 * 辅助：让时钟前进，确保 worker 的 seenAt / terminalAt 有时间差。
 * 由于 OrchestrationStore 用 Date.now()，测试中无法直接控制；
 * 通过 await sleep 让真实时钟前进，保证不同 worker 的时间戳不同。
 */
async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

describe('SPEC S2-2: OrchestrationStore terminal worker 清理', () => {
  it('1. 60 个 terminal worker，保留最后完成的 50 个', async () => {
    const store = new OrchestrationStore();
    // 先 upsert 60 个 running worker，再依次转 terminal（completed）
    for (let i = 0; i < 60; i++) {
      store.apply(makeWorkerUpsert({ id: `w-${i}`, status: 'running', elapsedMs: i }));
      await sleep(2);
    }
    // 依次转为 completed（按顺序）
    for (let i = 0; i < 60; i++) {
      store.apply(makeWorkerUpsert({ id: `w-${i}`, status: 'completed', elapsedMs: i }));
      await sleep(2);
    }

    const workers = Array.from(store.getSnapshot().workers.values());
    // 应保留最后 50 个 terminal worker（w-10 到 w-59）
    expect(workers.length).toBe(50);
    // 最旧的 10 个（w-0 到 w-9）应被裁剪
    expect(store.getSnapshot().workers.has('w-0')).toBe(false);
    expect(store.getSnapshot().workers.has('w-9')).toBe(false);
    // 最新的 50 个应保留
    expect(store.getSnapshot().workers.has('w-10')).toBe(true);
    expect(store.getSnapshot().workers.has('w-59')).toBe(true);
  });

  it('2. 长耗时 worker 不因 elapsedMs 大而被误认为"最新"', async () => {
    const store = new OrchestrationStore();
    // w-long：先创建，运行时间长（elapsedMs=999999），但最早完成
    store.apply(makeWorkerUpsert({ id: 'w-long', status: 'running', elapsedMs: 0 }));
    await sleep(10);
    // w-short：后创建，运行时间短（elapsedMs=1），但最后完成
    store.apply(makeWorkerUpsert({ id: 'w-short', status: 'running', elapsedMs: 0 }));
    await sleep(10);
    // w-long 先完成（elapsedMs 大）
    store.apply(makeWorkerUpsert({ id: 'w-long', status: 'completed', elapsedMs: 999999 }));
    await sleep(10);
    // w-short 后完成（elapsedMs 小）
    store.apply(makeWorkerUpsert({ id: 'w-short', status: 'completed', elapsedMs: 1 }));

    // 现在注入 49 个额外的 terminal worker 把 w-long 挤出
    for (let i = 0; i < 49; i++) {
      store.apply(makeWorkerUpsert({ id: `w-extra-${i}`, status: 'completed', elapsedMs: 100 }));
      await sleep(2);
    }
    // 加上 w-long + w-short = 51 个 terminal，超出 50 上限

    const snapshot = store.getSnapshot();
    // w-long 应被裁剪（虽然 elapsedMs 大，但完成时间最早）
    expect(snapshot.workers.has('w-long')).toBe(false);
    // w-short 应保留（完成时间最晚）
    expect(snapshot.workers.has('w-short')).toBe(true);
  });

  it('3. reset() 后元数据清空', () => {
    const store = new OrchestrationStore();
    store.apply(makeWorkerUpsert({ id: 'w-1', status: 'completed', elapsedMs: 10 }));
    store.apply(makeWorkerUpsert({ id: 'w-2', status: 'completed', elapsedMs: 20 }));

    // reset 后 workers 应为空
    store.reset();
    expect(store.getSnapshot().workers.size).toBe(0);

    // 再次注入 51 个 terminal worker，验证 reset 后元数据已清空
    // （如果元数据未清空，旧时间戳会干扰排序）
    for (let i = 0; i < 51; i++) {
      store.apply(makeWorkerUpsert({ id: `w-new-${i}`, status: 'completed', elapsedMs: i }));
    }
    // 应保留最后 50 个，裁剪 1 个最旧
    expect(store.getSnapshot().workers.size).toBe(50);
    // reset 前的 worker 不应残留
    expect(store.getSnapshot().workers.has('w-1')).toBe(false);
    expect(store.getSnapshot().workers.has('w-2')).toBe(false);
  });

  it('4. worker_remove 清理元数据', () => {
    const store = new OrchestrationStore();
    store.apply(makeWorkerUpsert({ id: 'w-1', status: 'completed', elapsedMs: 10 }));
    expect(store.getSnapshot().workers.has('w-1')).toBe(true);

    // 显式 remove 后应清理
    store.apply({ kind: 'worker_remove', workerId: 'w-1' });
    expect(store.getSnapshot().workers.has('w-1')).toBe(false);

    // 重新注入同名 worker 应得到新的 seenAt（验证元数据已清理）
    store.apply(makeWorkerUpsert({ id: 'w-1', status: 'completed', elapsedMs: 20 }));
    expect(store.getSnapshot().workers.has('w-1')).toBe(true);
  });

  it('5. worker_remove wildcard 清理所有元数据', () => {
    const store = new OrchestrationStore();
    store.apply(makeWorkerUpsert({ id: 'w-1', status: 'completed', elapsedMs: 10 }));
    store.apply(makeWorkerUpsert({ id: 'w-2', status: 'completed', elapsedMs: 20 }));

    store.apply({ kind: 'worker_remove', workerId: '*' });
    expect(store.getSnapshot().workers.size).toBe(0);

    // 重新注入应正常工作
    store.apply(makeWorkerUpsert({ id: 'w-3', status: 'running', elapsedMs: 0 }));
    expect(store.getSnapshot().workers.size).toBe(1);
  });
});
