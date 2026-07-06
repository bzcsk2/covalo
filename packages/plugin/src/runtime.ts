import { readFileSync } from "node:fs"
import { readPluginConfig, type PluginConfigError } from "./config.js"
import { loadPlugins, type PluginLoaded, type PluginLoadError } from "./loader.js"
import { extractToolsFromPlugins, pluginToolsToToolSpecs, type PluginTool, type PluginToolError } from "./tool-adapter.js"
import { PluginHookRegistry } from "./hook-adapter.js"
import type { HookManager, ToolCallHooks } from "@covalo/security"
import type { AgentDefinition } from "@covalo/core"
import type { ToolSpec } from "@covalo/protocol"
import { resolve, dirname, basename } from "node:path"
import { resolveContentPack } from "./content-pack/resolver.js"
import { isDirectory } from "./content-pack/discovery.js"
import { parseEccAgentMarkdown } from "./content-pack/agent-parser.js"
import { compileRules } from "./content-pack/rules-compiler.js"
import { parseEccHooks } from "./content-pack/hook-bridge.js"
import type { BridgedHook } from "./content-pack/hook-bridge.js"
import { convertCommandsToSkills } from "./content-pack/command-to-skill.js"
import type { CommandSkillEntry } from "./content-pack/command-to-skill.js"
import { createEccHookAdapter } from "./content-pack/ecc-hook-adapter.js"
import { clearEccHookState } from "./content-pack/ecc-hook-adapter.js"
import type { ResolvedContentPack, ContentPackDiagnostic, ContentPackPluginOptions, ContentAsset } from "./content-pack/types.js"

export interface PluginRuntimeOptions {
  workspaceRoot?: string
  configPath?: string
  hookManager?: HookManager
  hookTimeoutMs?: number
}

export interface PluginRuntimeStatus {
  initialized: boolean
  loadedPlugins: string[]
  contentPacks: string[]
  tools: string[]
  hooks: string[]
  assets: {
    skills: number
    agents: number
    rules: number
    commands: number
    mcp: number
    hooks: number
  }
  errors: PluginRuntimeError[]
  diagnostics: string[]
}

export type PluginRuntimeError = PluginConfigError | PluginLoadError | PluginToolError

export class PluginRuntime {
  private initialized = false
  private loadedPlugins: PluginLoaded[] = []
  private pluginTools: PluginTool[] = []
  private contentPacks: ResolvedContentPack[] = []
  private hookRegistry = new PluginHookRegistry()
  private eccHookAdapters: ToolCallHooks[] = []
  private errors: PluginRuntimeError[] = []
  private diagnostics: string[] = []
  private options: PluginRuntimeOptions

  constructor(options: PluginRuntimeOptions = {}) {
    this.options = options
  }

  async init(): Promise<void> {
    if (this.initialized) return

    const workspaceRoot = this.options.workspaceRoot ?? process.cwd()
    const configPath = this.options.configPath ?? resolve(workspaceRoot, ".covalo", "plugins.json")

    const configResult = readPluginConfig(configPath)
    if (configResult.errors.length > 0) {
      this.errors.push(...configResult.errors)
    }

    // Split items into runtime plugins and content-pack entries
    const runtimeItems: typeof configResult.items = []
    const contentPackItems: Array<{ spec: string; options: ContentPackPluginOptions }> = []

    for (const item of configResult.items) {
      const opts = item.options as ContentPackPluginOptions
      const type = opts.type ?? "auto"

      if (type === "content-pack" || (type === "auto" && isDirectory(item.spec))) {
        contentPackItems.push({ spec: item.spec, options: opts })
      } else {
        runtimeItems.push(item)
      }
    }

    // Load runtime plugins
    if (runtimeItems.length > 0) {
      const loadResult = await loadPlugins(runtimeItems)
      this.loadedPlugins = loadResult.loaded
      this.errors.push(...loadResult.errors)

      const toolsResult = await extractToolsFromPlugins(this.loadedPlugins)
      this.pluginTools = toolsResult.tools
      this.errors.push(...toolsResult.errors)

      if (this.options.hookManager) {
        for (const plugin of this.loadedPlugins) {
          this.hookRegistry.register(plugin, this.options.hookManager, this.options.hookTimeoutMs)
        }
      }
    }

    // Load content packs
    for (const cp of contentPackItems) {
      try {
        const resolved = resolveContentPack(cp.spec, cp.options)
        this.contentPacks.push(resolved)
        for (const d of resolved.diagnostics) {
          this.diagnostics.push(`[${d.type}] ${d.pluginId}: ${d.message}${d.detail ? " (" + d.detail + ")" : ""}`)
        }
      } catch (e) {
        this.diagnostics.push(`[error] Failed to resolve content pack ${cp.spec}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // Register ECC hooks if hookManager is available
    if (this.options.hookManager) {
      this.registerEccHooks()
    }

    this.initialized = true
  }

  getToolSpecs(): ToolSpec[] {
    return pluginToolsToToolSpecs(this.pluginTools)
  }

  private registerEccHooks(): void {
    const workspaceRoot = this.options.workspaceRoot ?? process.cwd()
    const hookManager = this.options.hookManager
    if (!hookManager) return

    for (const cp of this.contentPacks) {
      const adapter = createEccHookAdapter(cp, workspaceRoot, {
        hookManager,
        hookTimeoutMs: this.options.hookTimeoutMs,
        diagnosticCallback: (diag) => {
          this.diagnostics.push(`[${diag.type}] ${diag.pluginId}: ${diag.message}${diag.detail ? " (" + diag.detail + ")" : ""}`)
        },
      })
      if (adapter) {
        hookManager.addHooks(adapter)
        this.eccHookAdapters.push(adapter)
      }
    }
  }

  getTools(): PluginTool[] {
    return this.pluginTools
  }

  getTool(name: string): PluginTool | undefined {
    return this.pluginTools.find((t) => t.name === name)
  }

  getContentPacks(): ResolvedContentPack[] {
    return this.contentPacks
  }

  getSkillDirs(): string[] {
    // Return only non-ECC skill directories (currently none).
    // ECC skills are loaded as preloaded skills via getSkillDefs().
    // This prevents loadSkillsDirs from loading ALL skills from
    // a parent directory, bypassing selective install.
    return []
  }

  /**
   * Load ECC skills as full SkillDef objects.
   * Each skill directory's SKILL.md is parsed directly,
   * and source metadata is attached for namespace conflict resolution.
   */
  loadSkillDefs(): Array<{ name: string; description: string; content: string; source: { pluginId?: string; path: string } }> {
    const defs: Array<{ name: string; description: string; content: string; source: { pluginId?: string; path: string } }> = []
    for (const cp of this.contentPacks) {
      for (const skill of cp.assets.skills) {
        try {
          const skillFile = resolve(skill.path, "SKILL.md")
          const raw = readFileSync(skillFile, "utf8")
          const { frontmatter, body } = parseSkillFrontmatter(raw)
          const name = (frontmatter.name as string) ?? basename(skill.path)
          const desc = (frontmatter.description as string) ?? ""
          defs.push({
            name,
            description: desc || name,
            content: body,
            source: {
              pluginId: cp.name,
              path: skill.path,
            },
          })
        } catch {
          this.diagnostics.push(`[warn] Failed to load skill ${skill.id}: SKILL.md not found`)
        }
      }
    }
    return defs
  }

  getAgentAssets() {
    return this.contentPacks.flatMap((cp) => cp.assets.agents)
  }

  getRuleAssets() {
    return this.contentPacks.flatMap((cp) => cp.assets.rules)
  }

  getMcpAssets() {
    return this.contentPacks.flatMap((cp) => cp.assets.mcp)
  }

  loadAgents(): AgentDefinition[] {
    const agents: AgentDefinition[] = []
    for (const cp of this.contentPacks) {
      for (const asset of cp.assets.agents) {
        const parsed = parseEccAgentMarkdown(asset.path)
        if (parsed.agent) {
          agents.push(parsed.agent)
        }
        for (const w of parsed.warnings) {
          this.diagnostics.push(`[warn] ${w}`)
        }
      }
    }
    return agents
  }

  compileRules(): { systemPrompt: string; count: number; warnings: string[]; skillRules: CommandSkillEntry[] } {
    const allRules: ContentAsset[] = []
    const skillRules: CommandSkillEntry[] = []

    for (const cp of this.contentPacks) {
      const mode = cp.options.rules?.mode ?? "system"
      const enabled = cp.options.rules?.enabled !== false

      if (!enabled || mode === "off") continue

      if (mode === "skill") {
        // Convert rules to skills
        for (const rule of cp.assets.rules) {
          try {
            const content = readFileSync(rule.path, "utf8")
            const body = content.trim().startsWith("---")
              ? content.trim().replace(/^---\n[\s\S]*?\n---\n?/, "").trim()
              : content.trim()
            if (body) {
              skillRules.push({
                name: `ecc-rule:${rule.id}`,
                description: `Rule from ${cp.name}`,
                content: `**Source:** ${cp.name}\n\n${body}`,
              })
            }
          } catch {
            // skip unreadable rules in skill mode
          }
        }
      } else {
        // mode === "system" (default)
        allRules.push(...cp.assets.rules)
      }
    }

    if (allRules.length === 0 && skillRules.length === 0) {
      return { systemPrompt: "", count: 0, warnings: [], skillRules }
    }

    const result = compileRules(allRules)
    for (const w of result.warnings) {
      this.diagnostics.push(`[warn] ${w}`)
    }
    return {
      systemPrompt: result.systemPrompt,
      count: result.count,
      warnings: result.warnings,
      skillRules,
    }
  }

  loadCommandSkills(): CommandSkillEntry[] {
    const skills: CommandSkillEntry[] = []
    for (const cp of this.contentPacks) {
      const enabled = cp.options.commands?.enabled === true
      const mode = cp.options.commands?.mode ?? "off"

      if (!enabled || mode !== "skill") continue

      const result = convertCommandsToSkills(cp.assets.commands)
      // Add source info
      for (const s of result.skills) {
        skills.push({
          ...s,
          description: `${s.description} [${cp.name}]`,
        })
      }
      for (const w of result.warnings) {
        this.diagnostics.push(`[warn] ${w}`)
      }
    }
    return skills
  }

  loadHookConfigs(): { hooks: BridgedHook[]; warnings: string[] } {
    const all: BridgedHook[] = []
    const warnings: string[] = []
    for (const cp of this.contentPacks) {
      for (const asset of cp.assets.hooks) {
        const result = parseEccHooks(asset.path)
        all.push(...result.hooks)
        warnings.push(...result.warnings)
      }
    }
    return { hooks: all, warnings }
  }

  loadMcpConfigs(): Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }> {
    const configs: Array<{ name: string; command: string; args?: string[]; env?: Record<string, string> }> = []
    for (const cp of this.contentPacks) {
      const mcpOptions = cp.options.mcp ?? {}

      // MCP disabled by default
      if (mcpOptions.enabled !== true) {
        for (const asset of cp.assets.mcp) {
          this.diagnostics.push(`[info] MCP disabled: skipping "${asset.id}" from ${cp.name}`)
        }
        continue
      }

      for (const asset of cp.assets.mcp) {
        try {
          // Handle inline MCP configs (from plugin manifests)
          let servers: Record<string, unknown> = {}

          if (asset.path.startsWith("__inline__:")) {
            const manifestPath = asset.path.replace("__inline__:", "")
            try {
              const manifestRaw = readFileSync(manifestPath, "utf8")
              const manifestJson = JSON.parse(manifestRaw)
              if (typeof manifestJson.mcpServers === "object" && !Array.isArray(manifestJson.mcpServers)) {
                servers = manifestJson.mcpServers as Record<string, unknown>
              }
            } catch {
              this.diagnostics.push(`[warn] Failed to parse inline MCP config from ${asset.path}`)
              continue
            }
          } else {
            // Standard .mcp.json file
            const raw = readFileSync(asset.path, "utf8")
            const parsed = JSON.parse(raw)
            servers = (parsed.mcpServers ?? {}) as Record<string, unknown>
          }

          for (const [name, cfg] of Object.entries(servers)) {
            if (typeof cfg !== "object" || cfg === null) {
              this.diagnostics.push(`[warn] MCP server "${name}" in ${asset.path} is not a valid object, skipping`)
              continue
            }
            const server = cfg as Record<string, unknown>
            const command = server.command as string | undefined

            if (!command) {
              this.diagnostics.push(`[warn] MCP server "${name}" in ${asset.path} missing command, skipping`)
              continue
            }

            // === Security Checks ===

            // Check servers whitelist
            if (mcpOptions.servers && mcpOptions.servers.length > 0) {
              if (!mcpOptions.servers.includes(name)) {
                this.diagnostics.push(`[info] MCP server "${name}" not in whitelist, skipping`)
                continue
              }
            }

            // Check allowStdio — basic stdio safety
            if (mcpOptions.allowStdio === false && (command.startsWith("node ") || command.startsWith("bun ") || command.includes("/") || command.startsWith("."))) {
              this.diagnostics.push(`[info] MCP server "${name}" stdio disabled by policy, skipping`)
              continue
            }

            const args = (server.args as string[]) ?? []
            const env = (server.env as Record<string, string>) ?? {}
            const fullCmd = [command, ...args].join(" ")

            // Check allowHttp
            if (mcpOptions.allowHttp !== true) {
              if (fullCmd.includes("http://") || fullCmd.includes("https://")) {
                this.diagnostics.push(`[info] MCP server "${name}" HTTP transport disabled by policy, skipping`)
                continue
              }
            }

            // Check allowNpx
            if (mcpOptions.allowNpx !== true) {
              if (fullCmd.startsWith("npx ") || fullCmd.startsWith("npx -y ") || fullCmd.startsWith("uvx ")) {
                this.diagnostics.push(`[info] MCP server "${name}" npx/uvx transport disabled by policy, skipping`)
                continue
              }
            }

            // Check allowPlaceholderEnv
            if (mcpOptions.allowPlaceholderEnv !== true) {
              const hasPlaceholder = Object.entries(env).some(([_k, v]) => {
                if (typeof v !== "string") return false
                const upper = v.toUpperCase()
                return upper.includes("YOUR_")
                  || upper.includes("_HERE")
                  || upper.includes("PLACEHOLDER")
                  || (v.includes("<") && v.includes(">"))
                  || upper.includes("<TOKEN>") || upper.includes("<KEY>")
              })
              if (hasPlaceholder) {
                this.diagnostics.push(`[info] MCP server "${name}" has placeholder env vars, skipping`)
                continue
              }
            }

            // Also check env values for placeholder patterns
            const hasEnvPlaceholder = Object.values(env).some(v =>
              typeof v === "string" && (
                v.toUpperCase().includes("YOUR_") ||
                v.toUpperCase().includes("_HERE") ||
                v.toUpperCase().includes("PLACEHOLDER") ||
                (v.includes("<") && v.includes(">"))
              )
            )
            if (hasEnvPlaceholder && mcpOptions.allowPlaceholderEnv !== true) {
              this.diagnostics.push(`[info] MCP server "${name}" has placeholder env values, skipping`)
              continue
            }

            configs.push({ name: `${cp.name}:${name}`, command, args, env })
          }
        } catch (e) {
          this.diagnostics.push(`[warn] Failed to load MCP config ${asset.path}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }
    return configs
  }

  getStatus(): PluginRuntimeStatus {
    const assetCounts = { skills: 0, agents: 0, rules: 0, commands: 0, mcp: 0, hooks: 0 }
    for (const cp of this.contentPacks) {
      assetCounts.skills += cp.assets.skills.length
      assetCounts.agents += cp.assets.agents.length
      assetCounts.rules += cp.assets.rules.length
      assetCounts.commands += cp.assets.commands.length
      assetCounts.mcp += cp.assets.mcp.length
      assetCounts.hooks += cp.assets.hooks.length
    }

    return {
      initialized: this.initialized,
      loadedPlugins: this.loadedPlugins.map((p) => p.mod.id),
      contentPacks: this.contentPacks.map((cp) => cp.name),
      tools: this.pluginTools.map((t) => t.name),
      hooks: this.hookRegistry.getRegisteredIds(),
      assets: assetCounts,
      errors: this.errors,
      diagnostics: this.diagnostics,
    }
  }

  /**
   * P3: 统一 shutdown 编排。
   *
   * 原 dispose() 是同步的，且只移除 hooks、清状态，不触发 ECC onShutdown
   * hooks，也不调用 plugin 自身的 shutdown 回调。这导致 content pack 中
   * 声明的 SessionEnd/onShutdown 钩子永不执行，plugin 无法做异步清理。
   *
   * 现改为 async，按以下顺序编排：
   * 1. 派发 { role: "shutdown" } loop event，触发 ECC onShutdown hooks；
   * 2. drain 等待 in-flight hooks 完成；
   * 3. 调用每个 plugin 的可选 shutdown 回调（向后兼容，未实现则跳过）；
   *    注意：plugin shutdown 不依赖 hookManager 是否存在。
   * 4. 移除 ECC hook adapters、清状态、dispose hookRegistry；
   * 5. 重置内部数组。
   */
  async dispose(): Promise<void> {
    if (this.options.hookManager) {
      // 1. 派发 shutdown 事件，激活 ECC onShutdown phase
      try {
        await this.options.hookManager.runOnLoopEvent({ role: "shutdown" })
        // 2. 等待 in-flight hooks 完成
        await this.options.hookManager.drain()
      } catch {
        // best-effort: shutdown 事件失败不阻止清理
      }
    }

    // 3. 调用每个 plugin 的可选 shutdown 回调（不依赖 hookManager）
    for (const loaded of this.loadedPlugins) {
      const shutdown = (loaded.mod as { shutdown?: unknown }).shutdown
      if (typeof shutdown === "function") {
        try {
          const result = shutdown.call(loaded.mod)
          if (result instanceof Promise) {
            await result
          }
        } catch {
          // best-effort: 单个 plugin shutdown 失败不阻止其他清理
        }
      }
    }

    if (this.options.hookManager) {
      // 4. 移除 ECC hook adapters、清状态、dispose hookRegistry
      for (const adapter of this.eccHookAdapters) {
        this.options.hookManager.removeHooks(adapter)
      }
      this.eccHookAdapters = []
      for (const cp of this.contentPacks) {
        clearEccHookState(cp)
      }
      this.hookRegistry.dispose(this.options.hookManager)
    }
    // 5. 重置内部数组
    this.loadedPlugins = []
    this.pluginTools = []
    this.contentPacks = []
    this.errors = []
    this.diagnostics = []
    this.initialized = false
  }
}

export function createPluginRuntime(options?: PluginRuntimeOptions): PluginRuntime {
  return new PluginRuntime(options)
}

const SKILL_FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/

function parseSkillFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(SKILL_FRONTMATTER_RE)
  if (!match) return { frontmatter: {}, body: raw }
  const frontmatter: Record<string, unknown> = {}
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":")
    if (colon > 0) {
      const key = line.slice(0, colon).trim()
      let val: unknown = line.slice(colon + 1).trim()
      const strVal = val as string
      if (strVal.startsWith('"') && strVal.endsWith('"')) val = strVal.slice(1, -1)
      else if (strVal.startsWith("'") && strVal.endsWith("'")) val = strVal.slice(1, -1)
      else if (strVal === "true") val = true
      else if (strVal === "false") val = false
      frontmatter[key] = val
    }
  }
  return { frontmatter, body: match[2].trim() }
}
