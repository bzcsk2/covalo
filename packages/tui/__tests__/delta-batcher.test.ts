import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { DeltaBatcher, resolveDeltaFlushMs } from '../src/delta-batcher.js';

describe('DeltaBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.DEEPCODE_DELTA_FLUSH_MS;
  });

  it('merges rapid schedules into a single flush', () => {
    const onFlush = vi.fn();
    const batcher = new DeltaBatcher(16, onFlush);

    batcher.schedule();
    batcher.schedule();
    batcher.schedule();
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(16);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('flushNow runs immediately and clears pending timer', () => {
    const onFlush = vi.fn();
    const batcher = new DeltaBatcher(16, onFlush);

    batcher.schedule();
    batcher.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(32);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('uses immediate flush when flushMs is 0', () => {
    const onFlush = vi.fn();
    const batcher = new DeltaBatcher(0, onFlush);

    batcher.schedule();
    batcher.schedule();
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it('cancel clears pending timer and prevents flush', () => {
    const onFlush = vi.fn();
    const batcher = new DeltaBatcher(16, onFlush);

    batcher.schedule();
    batcher.cancel();
    vi.advanceTimersByTime(16);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it('cancel is safe when no timer is pending', () => {
    const batcher = new DeltaBatcher(16, vi.fn());
    expect(() => batcher.cancel()).not.toThrow();
  });

  it('cancel then reschedule starts a new timer', () => {
    const onFlush = vi.fn();
    const batcher = new DeltaBatcher(16, onFlush);

    batcher.schedule();
    batcher.cancel();
    batcher.schedule();
    vi.advanceTimersByTime(8);
    expect(onFlush).not.toHaveBeenCalled();
    vi.advanceTimersByTime(8);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('flushNow when no timer is pending still calls onFlush', () => {
    const onFlush = vi.fn();
    const batcher = new DeltaBatcher(16, onFlush);

    batcher.flushNow();
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it('cancel at flushMs=0 is safe (no-op)', () => {
    const onFlush = vi.fn();
    const batcher = new DeltaBatcher(0, onFlush);
    expect(() => batcher.cancel()).not.toThrow();
  });
});

describe('resolveDeltaFlushMs', () => {
  afterEach(() => {
    delete process.env.DEEPCODE_DELTA_FLUSH_MS;
  });

  it('defaults to 16ms', () => {
    expect(resolveDeltaFlushMs()).toBe(16);
  });

  it('returns 0 when env disables batching', () => {
    process.env.DEEPCODE_DELTA_FLUSH_MS = '0';
    expect(resolveDeltaFlushMs()).toBe(0);
  });
});
