import type { AgentTool } from "@covalo/core"

import { ToolRegistry } from "./registry.js"
import { createReadFileTool } from "./file-ops.js"
import { createBashTool } from "./shell-exec.js"
import {
  createDualTrackBashTool,
  classifyShellCommand,
  pickBackgroundHardTimeout,
  pickForegroundTimeout,
  BackgroundTaskManager,
  getBackgroundTaskManagerFor,
  disposeBackgroundTaskManagerFor,
  __resetBackgroundTaskManagers,
  SOFT_TIMEOUT_MS,
  HARD_TIMEOUT_DEFAULT_MS,
  HARD_TIMEOUT_LONG_MS,
  SHORT_TIMEOUT_MAX_MS,
} from "./shell-dual-track/index.js"
import { createEditTool } from "./edit.js"
import { createWriteFileTool } from "./write-file.js"
import { createListDirTool } from "./list-dir.js"
import { createGrepTool } from "./grep.js"
import { createTodoWriteTool } from "./todowrite.js"
import { createGlobTool } from "./glob.js"
import { createWebFetchTool } from "./web-fetch.js"
import { createWebSearchTool } from "./web-search.js"
import { createSkillTool } from "./skills/index.js"
import type { SkillDef } from "./skills/index.js"
import { createNotebookEditTool } from "./notebook-edit.js"
import { createSleepTool } from "./sleep.js"
import { createPushNotificationTool } from "./push-notification.js"
import { createMonitorTool } from "./monitor.js"
import { TaskManager } from "./task-manager.js"
import type { TaskItem } from "./task-manager.js"
import { createTaskCreateTool } from "./task-create.js"
import { createTaskUpdateTool } from "./task-update.js"
import { createTaskListTool } from "./task-list.js"
import { createTaskGetTool } from "./task-get.js"
import { createTaskStopTool } from "./task-stop.js"
import { createAskUserQuestionTool } from "./ask-user.js"
import { createPlanModeTool } from "./plan-mode.js"
import { createWebBrowserTool } from "./web-browser.js"
import { createWorktreeTool } from "./worktree.js"
import { createCronTool } from "./cron.js"
import { createWorkflowTool } from "./workflow.js"
import { createAgentToolTool } from "./agent-tool.js"
import { createSendMessageTool } from "./send-message.js"
import { createLspTool } from "./lsp.js"
import { LspClientPool } from "./lsp/client-pool.js"
import { safeStringify, hasBinaryEncoding } from "./safe-stringify.js"
import { clearReadTracker } from "./stale-read.js"
import { getPlatformCapabilities, normalizePlatform } from "./platform/capabilities.js"
import { clearShellBackendCache, resolveShellBackend, setShellBackendLogger } from "./platform/shell-backend.js"
import { terminateProcessTree } from "./platform/process-tree.js"

export {
  ToolRegistry,
  createReadFileTool,
  createBashTool,
  createDualTrackBashTool,
  classifyShellCommand,
  pickBackgroundHardTimeout,
  pickForegroundTimeout,
  BackgroundTaskManager,
  getBackgroundTaskManagerFor,
  disposeBackgroundTaskManagerFor,
  __resetBackgroundTaskManagers,
  SOFT_TIMEOUT_MS,
  HARD_TIMEOUT_DEFAULT_MS,
  HARD_TIMEOUT_LONG_MS,
  SHORT_TIMEOUT_MAX_MS,
  createEditTool,
  createWriteFileTool,
  createListDirTool,
  createGrepTool,
  createTodoWriteTool,
  createGlobTool,
  createWebFetchTool,
  createWebSearchTool,
  createSkillTool,
  createNotebookEditTool,
  createSleepTool,
  createPushNotificationTool,
  createMonitorTool,
  TaskManager,
  createTaskCreateTool,
  createTaskUpdateTool,
  createTaskListTool,
  createTaskGetTool,
  createTaskStopTool,
  createAskUserQuestionTool,
  createPlanModeTool,
  createWebBrowserTool,
  createWorktreeTool,
  createCronTool,
  createWorkflowTool,
  createAgentToolTool,
  createSendMessageTool,
  createLspTool,
  LspClientPool,
  safeStringify,
  hasBinaryEncoding,
  clearReadTracker,
  getPlatformCapabilities,
  normalizePlatform,
  clearShellBackendCache,
  resolveShellBackend,
  setShellBackendLogger,
  terminateProcessTree,
}
export type { TaskItem }
export type { SkillDef } from "./skills/index.js"

/**
 * CL-41: Factory function that creates the default built-in tool set.
 * Preserves construction order (matches system prompt tool spec ordering).
 * MCP dynamic tools are registered separately by the CLI/host.
 *
 * ADV-HAR-03: Accepts optional shellPolicy to enable dual-track bash tool.
 */
export interface ToolServices {
  lspPool?: LspClientPool
}

export function createDefaultTools(
  skillDirs?: string[],
  preloadedSkills?: SkillDef[],
  shellPolicy?: "dual-track-conservative" | "dual-track",
  services?: ToolServices,
): AgentTool[] {
  const useDualTrack = shellPolicy === "dual-track" || shellPolicy === "dual-track-conservative"
  return [
    createReadFileTool(),
    createBashTool({
      dualTrack: useDualTrack,
      conservative: shellPolicy === "dual-track-conservative",
    }),
    createEditTool(),
    createWriteFileTool(),
    createListDirTool(),
    createGrepTool(),
    createTodoWriteTool(),
    createGlobTool(),
    createWebFetchTool(),
    createWebSearchTool(),
    createSkillTool({ skillDirs, preloadedSkills }),
    createTaskCreateTool(),
    createTaskUpdateTool(),
    createTaskListTool(),
    createTaskGetTool(),
    createTaskStopTool(),
    createAskUserQuestionTool(),
    createPlanModeTool(),
    createNotebookEditTool(),
    createSleepTool(),
    createPushNotificationTool(),
    createMonitorTool(),
    createWebBrowserTool(),
    createWorktreeTool(),
    createCronTool(),
    createWorkflowTool(),
    createAgentToolTool(),
    createSendMessageTool(),
    createLspTool(services?.lspPool),
  ]
}
