import { randomUUID } from "node:crypto"
import { PermissionEngine, HookManager } from "@covalo/security"
import { StreamingToolExecutor } from "../streaming-executor.js"
import type { AgentTool, CoreEngine } from "../interface.js"

export class EngineToolRuntime {
  tools: Map<string, AgentTool> = new Map()
  toolExecutor!: StreamingToolExecutor
  permissionEngine = new PermissionEngine()
  hookManager = new HookManager()
  pendingPermissions = new Map<string, {
    id: string;
    resolve: (v: boolean) => void;
    toolName: string;
    args: Record<string, unknown>;
  }>()

  registerTool(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  getRegisteredTools(): AgentTool[] {
    return [...this.tools.values()]
  }

  configurePermissionDefaults(config: { tools?: { approvalPolicy?: string; strictMode?: boolean } }): void {
    const toolsConfig = (config as unknown as Record<string, unknown>).tools as { approvalPolicy?: string; strictMode?: boolean } | undefined
    const policy = toolsConfig?.approvalPolicy ?? "on-request"
    const strictMode = toolsConfig?.strictMode ?? false

    this.permissionEngine.setStrictMode(strictMode)
    this.permissionEngine.setDefaultDecision("read", "allow")
    this.permissionEngine.setDefaultDecision("write", "ask")
    this.permissionEngine.setDefaultDecision("edit", "ask")
    this.permissionEngine.setDefaultDecision("exec", "ask")

    if (policy === "never") {
      this.permissionEngine.setDefaultDecision("write", "allow")
      this.permissionEngine.setDefaultDecision("edit", "allow")
      this.permissionEngine.setDefaultDecision("exec", "allow")
    }

    if (policy === "always") {
      this.permissionEngine.setDefaultDecision("read", "ask")
    }
  }

  requestPermission = (toolName: string, args: Record<string, unknown>): { requestId: string; promise: Promise<boolean> } => {
    const requestId = `perm_${randomUUID()}`
    const promise = new Promise<boolean>(resolve => {
      this.pendingPermissions.set(requestId, { id: requestId, resolve, toolName, args })
    })
    return { requestId, promise }
  }

  respondPermissionForRequest(requestId: string, allow: boolean, alwaysAllow?: boolean, activeChildEngines?: Set<CoreEngine>): boolean {
    const entry = this.pendingPermissions.get(requestId)
    if (entry) {
      if (allow && alwaysAllow) {
        this.permissionEngine.addAllowRule({ toolName: entry.toolName })
      }
      this.pendingPermissions.delete(requestId)
      entry.resolve(allow)
      return true
    }
    if (activeChildEngines) {
      for (const child of activeChildEngines) {
        if (child.respondPermissionForRequest(requestId, allow, alwaysAllow)) return true
      }
    }
    return false
  }

  respondPermission(allow: boolean, alwaysAllow?: boolean, activeChildEngines?: Set<CoreEngine>): void {
    const firstKey = this.pendingPermissions.keys().next().value
    if (firstKey) {
      const entry = this.pendingPermissions.get(firstKey)!
      if (allow && alwaysAllow) {
        this.permissionEngine.addAllowRule({ toolName: entry.toolName })
      }
      this.pendingPermissions.delete(firstKey)
      entry.resolve(allow)
      return
    }
    if (activeChildEngines) {
      for (const child of activeChildEngines) child.respondPermission(allow, alwaysAllow)
    }
  }

  setToolSessionId(sessionId: string): void {
    this.toolExecutor.setSessionId(sessionId)
  }

  setToolReadTracker(tracker: import("../read-before-write.js").ReadTracker | undefined): void {
    this.toolExecutor.setReadTracker(tracker)
  }
}
