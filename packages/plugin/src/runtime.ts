import { readPluginConfig, type PluginConfigItem } from "./config.js"
import { loadPlugins, type PluginLoaded, type PluginLoadError } from "./loader.js"
import { extractToolsFromPlugins, pluginToolsToToolSpecs, type PluginTool, type PluginToolResult } from "./tool-adapter.js"
import { PluginHookRegistry } from "./hook-adapter.js"
import type { HookManager } from "@deepicode/security"
import type { ToolSpec } from "@deepicode/core"
import { resolve } from "node:path"

export interface PluginRuntimeOptions {
  workspaceRoot?: string
  configPath?: string
  hookManager?: HookManager
  hookTimeoutMs?: number
}

export interface PluginRuntimeStatus {
  initialized: boolean
  loadedPlugins: string[]
  tools: string[]
  hooks: string[]
  errors: PluginLoadError[]
}

export class PluginRuntime {
  private initialized = false
  private loadedPlugins: PluginLoaded[] = []
  private pluginTools: PluginTool[] = []
  private hookRegistry = new PluginHookRegistry()
  private errors: PluginLoadError[] = []
  private options: PluginRuntimeOptions

  constructor(options: PluginRuntimeOptions = {}) {
    this.options = options
  }

  async init(): Promise<void> {
    if (this.initialized) return

    const workspaceRoot = this.options.workspaceRoot ?? process.cwd()
    const configPath = this.options.configPath ?? resolve(workspaceRoot, ".deepicode", "plugins.json")

    const configResult = readPluginConfig(configPath)
    if (configResult.errors.length > 0) {
      this.errors.push(...configResult.errors)
    }

    if (configResult.items.length > 0) {
      const loadResult = await loadPlugins(configResult.items)
      this.loadedPlugins = loadResult.loaded
      this.errors.push(...loadResult.errors)

      const toolsResult = extractToolsFromPlugins(this.loadedPlugins)
      this.pluginTools = toolsResult.tools
      this.errors.push(...toolsResult.errors)

      if (this.options.hookManager) {
        for (const plugin of this.loadedPlugins) {
          this.hookRegistry.register(plugin, this.options.hookManager, this.options.hookTimeoutMs)
        }
      }
    }

    this.initialized = true
  }

  getToolSpecs(): ToolSpec[] {
    return pluginToolsToToolSpecs(this.pluginTools)
  }

  getTools(): PluginTool[] {
    return this.pluginTools
  }

  getTool(name: string): PluginTool | undefined {
    return this.pluginTools.find((t) => t.name === name)
  }

  getStatus(): PluginRuntimeStatus {
    return {
      initialized: this.initialized,
      loadedPlugins: this.loadedPlugins.map((p) => p.mod.id),
      tools: this.pluginTools.map((t) => t.name),
      hooks: this.hookRegistry.getRegisteredIds(),
      errors: this.errors,
    }
  }

  dispose(): void {
    if (this.options.hookManager) {
      this.hookRegistry.dispose(this.options.hookManager)
    }
    this.loadedPlugins = []
    this.pluginTools = []
    this.errors = []
    this.initialized = false
  }
}

export function createPluginRuntime(options?: PluginRuntimeOptions): PluginRuntime {
  return new PluginRuntime(options)
}
