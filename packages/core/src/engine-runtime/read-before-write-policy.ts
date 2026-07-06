import { ReadTracker } from "../read-before-write.js"
import type { StreamingToolExecutor } from "../streaming-executor.js"

export type ReadBeforeWriteMode = "block" | "warn" | "off"

/**
 * ADV-HAR-05: 根据 effectivePolicy.readBeforeWrite 配置 ReadTracker。
 *
 * "block" → 启用 + 硬拦截（strict: true）
 * "warn"  → 启用 + 仅警告（strict: false）
 * "off" / undefined → 不追踪
 */
export function configureReadBeforeWrite(
  toolExecutor: StreamingToolExecutor,
  mode: ReadBeforeWriteMode | undefined,
): void {
  if (mode === "block") {
    toolExecutor.setReadTracker(new ReadTracker({ strict: true }))
  } else if (mode === "warn") {
    toolExecutor.setReadTracker(new ReadTracker({ strict: false }))
  } else {
    toolExecutor.setReadTracker(undefined)
  }
}
