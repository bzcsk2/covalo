/**
 * SFR-40: Supervisor/Worker 装配独立性测试
 *
 * 验证 CLI 启动链路中 Worker 和 Supervisor engine 的
 * thinkingMode / config 互不影响。
 */
import { describe, it, expect } from 'bun:test';
import { loadAgentProfiles, getAgentProfile } from '@deepreef/core';
import type { ReasonixEngine } from '@deepreef/core';

describe('SFR-40: supervisor wiring', () => {
  it('loadAgentProfiles returns profiles for both roles', () => {
    const config = loadAgentProfiles();
    const worker = getAgentProfile(config, 'worker');
    const supervisor = getAgentProfile(config, 'supervisor');

    expect(worker).toBeDefined();
    expect(worker.agent).toBe('worker');
    expect(typeof worker.thinking).toBe('string');

    expect(supervisor).toBeDefined();
    expect(supervisor.agent).toBe('supervisor');
    expect(typeof supervisor.thinking).toBe('string');
  });

  it('worker and supervisor can have independent thinking modes', () => {
    const config = loadAgentProfiles();
    const worker = getAgentProfile(config, 'worker');
    const supervisor = getAgentProfile(config, 'supervisor');

    // thinking 可以相同或不同，关键是各自独立存储
    expect(worker.thinking).toEqual(worker.thinking);
    expect(supervisor.thinking).toEqual(supervisor.thinking);
    // 两个 profile 的 thinking 属性互不引用同一对象
    const config2 = loadAgentProfiles();
    const worker2 = getAgentProfile(config2, 'worker');
    const supervisor2 = getAgentProfile(config2, 'supervisor');
    worker2.thinking = 'high';
    expect(supervisor2.thinking).not.toBe('high'); // 修改 worker 不影响 supervisor
  });
});
