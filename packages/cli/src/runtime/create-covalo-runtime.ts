import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig, ReasonixEngine, SessionLoader, defaultAgentRegistry, ConfigManager, setGlobalConfigManager } from "@covalo/core"
import { buildSystemPrompt, loadPromptLocaleFromDisk, setPromptLocale } from "@covalo/core"
import type { PromptLocale } from "@covalo/core"
import { createDefaultTools, clearReadTracker, normalizePlatform, resolveShellBackend, disposeBackgroundTaskManagerFor, createBashTool, LspClientPool } from "@covalo/tools"
import { McpHost, createListMcpResourcesTool, createReadMcpResourceTool, createMcpAuthTool, createListMcpToolsTool, createCallMcpToolTool, setMcpHost } from "@covalo/mcp"
import { PluginRuntime, pluginToolsToAgentTools } from "@covalo/plugin"

export interface CovaloRuntime {
  config: ReturnType<typeof loadConfig>
  engine: ReasonixEngine
  mcpHost: McpHost
  mcpLoadPromise: Promise<void>
  pluginRuntime: PluginRuntime
  lspPool: LspClientPool
  promptLocale: PromptLocale
  toolRuntimeHooks: { disposeBackgroundTaskManagerFor: typeof disposeBackgroundTaskManagerFor; createBashTool: typeof createBashTool }
  rebuildBaseSystemPrompt: (locale?: PromptLocale) => string
  shutdown: () => Promise<void>
}

export interface CreateCovaloRuntimeOptions {
  cwd: string
  sessionId?: string
  errorOutput: { write(data: string): unknown }
}

function deferTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<void>(resolve => setTimeout(resolve, 0)).then(task)
}

function readConfiguredMcpCount(): number {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".covalo", "mcp.json"), "utf8")
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> }
    return Object.keys(parsed.mcpServers ?? {}).length
  } catch {
    return 0
  }
}

export async function createCovaloRuntime(options: CreateCovaloRuntimeOptions): Promise<CovaloRuntime> {
  const { cwd, sessionId, errorOutput } = options

  const configManager = await ConfigManager.create({ cwd })
  setGlobalConfigManager(configManager)
  const config = loadConfig()

  const mcpHost = new McpHost()
  setMcpHost(mcpHost)
  let mcpLoadPromise = mcpHost.loadConfig().then((summary) => {
    if (summary.failed.length > 0) {
      errorOutput.write(`[covalo] MCP loaded with ${summary.failed.length}/${summary.serverCount} server failure(s)\n`)
    }
  }).catch((error) => {
    errorOutput.write(`[covalo] MCP config load failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })

  const toolRuntimeHooks = { disposeBackgroundTaskManagerFor, createBashTool }
  const engine = sessionId
    ? await ReasonixEngine.recover(config, sessionId, { toolRuntimeHooks })
    : new ReasonixEngine(config, clearReadTracker, undefined, undefined, undefined, { toolRuntimeHooks })
  SessionLoader.cleanup().catch(() => {})

  const platform = normalizePlatform()
  const shellBackend = await resolveShellBackend(platform)

  const initialLocale = loadPromptLocaleFromDisk(cwd) ?? "zh-CN"
  setPromptLocale(initialLocale)
  let currentPromptLocale = initialLocale
  let pluginRulesPrompt = ""

  const rebuildBaseSystemPrompt = (locale = currentPromptLocale): string => {
    currentPromptLocale = locale
    return [
      buildSystemPrompt(cwd, {
        osPlatform: platform,
        shellBackend: `${shellBackend.id} (${shellBackend.executable})`,
        locale,
      }),
      pluginRulesPrompt,
    ].filter(Boolean).join("\n\n")
  }

  let baseSystemPrompt = rebuildBaseSystemPrompt(initialLocale)

  const lspPool = new LspClientPool()
  lspPool.startIdleSweep()

  const pluginRuntime = new PluginRuntime({ hookManager: engine.hookManager })
  engine.setSystemPrompt(baseSystemPrompt)

  engine.registerTool(createListMcpResourcesTool())
  engine.registerTool(createReadMcpResourceTool())
  engine.registerTool(createMcpAuthTool())
  engine.registerTool(createListMcpToolsTool())
  engine.registerTool(createCallMcpToolTool())

  let mcpConfigCount = 0
  const pluginReady = deferTask(async () => {
    try {
      await pluginRuntime.init()
      const pluginToolAgentTools = pluginToolsToAgentTools(pluginRuntime.getTools())
      const skillDirs = pluginRuntime.getSkillDirs()

      for (const agent of pluginRuntime.loadAgents()) {
        defaultAgentRegistry.register(agent)
      }

      const rulesResult = pluginRuntime.compileRules()
      if (rulesResult.systemPrompt) {
        pluginRulesPrompt = rulesResult.systemPrompt
        baseSystemPrompt = rebuildBaseSystemPrompt()
        engine.setSystemPrompt(baseSystemPrompt)
      }

      const preloadedSkills: import('@covalo/tools').SkillDef[] = []
      for (const cs of pluginRuntime.loadCommandSkills()) {
        preloadedSkills.push({ name: cs.name, description: cs.description, content: cs.content })
      }
      for (const sd of pluginRuntime.loadSkillDefs()) {
        preloadedSkills.push({ name: sd.name, description: sd.description, content: sd.content, source: sd.source })
      }
      for (const rs of rulesResult.skillRules) {
        preloadedSkills.push({ name: rs.name, description: rs.description, content: rs.content })
      }

      for (const tool of createDefaultTools(skillDirs, preloadedSkills, undefined, { lspPool })) engine.registerTool(tool)
      for (const tool of pluginToolAgentTools) engine.registerTool(tool)

      const mcpConfigs = pluginRuntime.loadMcpConfigs()
      mcpConfigCount = mcpConfigs.length
      if (mcpConfigs.length > 0) {
        mcpLoadPromise = mcpLoadPromise.then(() => mcpHost.addSources(mcpConfigs)).then((summary) => {
          if (summary.failed.length > 0) {
            errorOutput.write(`[covalo] Content pack MCP: ${summary.failed.length}/${summary.serverCount} server failure(s)\n`)
          }
        })
      }
    } catch (e) {
      errorOutput.write(`[covalo] Plugin init skipped: ${e instanceof Error ? e.message : String(e)}\n`)
      for (const tool of createDefaultTools([], [], undefined, { lspPool })) engine.registerTool(tool)
    }
  })

  await pluginReady

  return {
    config,
    engine,
    mcpHost,
    mcpLoadPromise,
    pluginRuntime,
    lspPool,
    promptLocale: initialLocale,
    toolRuntimeHooks,
    rebuildBaseSystemPrompt,
    shutdown: async () => {
      await engine.hookManager.drain().catch(() => {})
      await engine.shutdown()
      await pluginRuntime.dispose()
      await Promise.race([mcpLoadPromise, new Promise<void>(r => setTimeout(r, 2000))])
      await mcpHost.disconnectAll()
      await lspPool.disposeAll().catch(() => {})
    },
  }
}
