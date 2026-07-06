import type { AgentTool } from "./interface.js"

export type DisposeBgTaskFn = (sessionId: string) => void

export type CreateBashToolFn = (options: {
  dualTrack: boolean
  conservative: boolean
}) => AgentTool

export interface ToolRuntimeHooks {
  disposeBackgroundTaskManagerFor: DisposeBgTaskFn
  createBashTool: CreateBashToolFn
}

export interface ReasonixEngineOptions {
  toolRuntimeHooks?: ToolRuntimeHooks
}
