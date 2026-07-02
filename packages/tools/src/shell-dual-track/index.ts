/**
 * Shell 双轨执行模块入口。
 */

export {
  classifyShellCommand,
  pickBackgroundHardTimeout,
  pickForegroundTimeout,
  SOFT_TIMEOUT_MS,
  HARD_TIMEOUT_DEFAULT_MS,
  HARD_TIMEOUT_LONG_MS,
  SHORT_TIMEOUT_MAX_MS,
  BG_SUMMARY_INTERVAL_MS,
} from "./shell-runtime-classifier.js"
export type { ShellClass } from "./shell-runtime-classifier.js"

export {
  BackgroundTaskManager,
  getBackgroundTaskManagerFor,
  disposeBackgroundTaskManagerFor,
  __resetBackgroundTaskManagers,
} from "./background-task-manager.js"
export type {
  BackgroundTaskStatus,
  BackgroundTaskSummary,
  OutputSinceResult,
} from "./background-task-manager.js"

export {
  matchDeniedShellPattern,
  matchSensitivePathInCommand,
  validateShellCommand,
  isDestructiveShellCommand,
} from "./shell-security.js"
export type { ShellSecurityCheckResult } from "./shell-security.js"

export { createDualTrackBashTool, sleepCommand, spawnTestShell } from "./bash-dual-track.js"
export type { DualTrackBashOptions } from "./bash-dual-track.js"
