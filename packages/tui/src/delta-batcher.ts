const DEFAULT_FLUSH_MS = 16;

/**
 * 将高频 delta 事件合并为每帧最多一次 UI 刷新（默认 16ms，与 Ink 帧节流对齐）。
 */
export class DeltaBatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param flushMs - 合并窗口（毫秒）；0 表示立即刷新
   * @param onFlush - 合并后执行的 UI 更新
   */
  constructor(
    private readonly flushMs: number,
    private readonly onFlush: () => void,
  ) {}

  /**
   * 调度一次合并刷新；若已有待处理定时器则忽略。
   */
  schedule(): void {
    if (this.flushMs === 0) {
      this.cancel();
      this.onFlush();
      return;
    }
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onFlush();
    }, this.flushMs);
  }

  /**
   * 立即刷新并取消待处理定时器。
   */
  flushNow(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.onFlush();
  }

  /**
   * 取消待处理刷新，不执行 onFlush。
   */
  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * 解析 delta 合并窗口（毫秒）。
 * `DEEPCODE_DELTA_FLUSH_MS=0` 关闭合并，便于测试或调试。
 */
export function resolveDeltaFlushMs(): number {
  const raw = process.env.DEEPCODE_DELTA_FLUSH_MS;
  if (raw === '0') return 0;
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_FLUSH_MS;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_FLUSH_MS;
}
