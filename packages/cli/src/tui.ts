import { stdin as input, stdout as output, stderr as errorOutput } from "node:process"
import { readFileSync, writeSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig, loadRoleConfig, getModelContextWindow, ReasonixEngine, SessionLoader, defaultAgentRegistry, loadAgentProfiles, getAgentProfile, resolveApiKey, ConfigManager, setGlobalConfigManager } from "@covalo/core"
import { buildSystemPrompt, loadPromptLocaleFromDisk, setPromptLocale, getPromptLocale } from "@covalo/core"
import { DualAgentRuntime } from "@covalo/core/dual-agent-runtime/dual-runtime.js"
import { WorkflowCoordinator } from "@covalo/core/workflow-coordinator/coordinator.js"
import { QuestionService } from "@covalo/core/question/service.js"
import { GoalStore } from "@covalo/core/goal/store.js"
import { Mailbox } from "@covalo/core/agent-comm/mailbox.js"
import { AgentScoreStore } from "@covalo/core/scoring/index.js"
import { createGoalTools } from "@covalo/core/goal/tools.js"
import { createMailboxTools } from "@covalo/core/agent-comm/tools.js"
import { createDefaultTools, clearReadTracker, normalizePlatform, resolveShellBackend, createAgentToolTool, createAskUserQuestionTool, createReadFileTool, createGrepTool, createListDirTool, createTodoWriteTool } from "@covalo/tools"
import { LspClientPool } from "@covalo/tools"
import { McpHost, createListMcpResourcesTool, createReadMcpResourceTool, createMcpAuthTool, createListMcpToolsTool, createCallMcpToolTool, setMcpHost } from "@covalo/mcp"
import { PluginRuntime, pluginToolsToAgentTools } from "@covalo/plugin"
import type { ToolCallHooks } from "@covalo/security"
// P1-4: Memory is dynamically imported when enabled to avoid loading when COVALO_MEMORY=false
import React from "react"
import { wrappedRender as render } from "@covalo/ink"
import { App, createFrameMetricsHandler } from "@covalo/tui"



function printHelp(): void {
  output.write(`covalo

Usage:
  covalo
  echo "你好" | covalo

Commands:
  /exit, /bye    exit the interactive session
  /help          show this help
`)
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp()
    return
  }

  const sessionIdx = process.argv.indexOf("--session")
  const sessionId = (sessionIdx >= 0 && sessionIdx + 1 < process.argv.length) ? process.argv[sessionIdx + 1] : undefined
  
  // Initialize new ConfigManager
  const configManager = await ConfigManager.create({ cwd: process.cwd() })
  setGlobalConfigManager(configManager)
  
  // Load legacy config for backward compatibility
  const config = loadConfig()

  // Initialize MCP host in background — don't block startup
  const mcpHost = new McpHost()
  setMcpHost(mcpHost)
  let mcpLoadPromise = mcpHost.loadConfig().then((summary) => {
    if (summary.failed.length > 0) {
      errorOutput.write(`[covalo] MCP loaded with ${summary.failed.length}/${summary.serverCount} server failure(s)\n`)
    }
  }).catch((error) => {
    errorOutput.write(`[covalo] MCP config load failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })

  const engine = sessionId
    ? await ReasonixEngine.recover(config, sessionId)
    : new ReasonixEngine(config, clearReadTracker)
  SessionLoader.cleanup().catch(() => {})
  const platform = normalizePlatform()
  const shellBackend = await resolveShellBackend(platform)
  // Load persisted prompt locale at startup
  const promptLocale = loadPromptLocaleFromDisk(process.cwd()) ?? "zh-CN"
  setPromptLocale(promptLocale)
  let currentPromptLocale: import("@covalo/core").PromptLocale = promptLocale
  let pluginRulesPrompt = ""
  let memoryContextPrompt = ""

  function rebuildBaseSystemPrompt(locale = currentPromptLocale): string {
    currentPromptLocale = locale
    return [
      buildSystemPrompt(process.cwd(), {
        osPlatform: platform,
        shellBackend: `${shellBackend.id} (${shellBackend.executable})`,
        locale,
      }),
      pluginRulesPrompt,
      memoryContextPrompt,
    ].filter(Boolean).join("\n\n")
  }

  let baseSystemPrompt = rebuildBaseSystemPrompt(promptLocale)

  // Phase 2: LSP 持久化连接池 — session 级生命周期，与 engine 同寿
  const lspPool = new LspClientPool()
  lspPool.startIdleSweep()

  // Render-first startup: plugins/default tools are loaded in the background.
  // The TUI accepts input immediately; the first submit waits for this promise.
  const pluginRuntime = new PluginRuntime({ hookManager: engine.hookManager })
  engine.setSystemPrompt(baseSystemPrompt)

  // MCP tools are lightweight proxies and can be registered before connections load.
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
      // Preserve a usable agent even when plugin discovery fails.
      for (const tool of createDefaultTools([], [], undefined, { lspPool })) engine.registerTool(tool)
    }
  })

  // Memory is fully background-loaded and never gates the first model request.
  let memoryService: import("@covalo/memory").MemoryService | undefined
  let memoryBridge: import("@covalo/memory").DeepreefMemoryBridge | undefined
  let memoryHookAdapter: ToolCallHooks | undefined
  const enableMemory = process.env.COVALO_MEMORY !== "false"
  const memoryReady = deferTask(async () => {
    if (!enableMemory) return
    try {
      const memory = await import("@covalo/memory")
      // P1-2: Config from env vars with sensible defaults
      const memoryAutoObserve = process.env.COVALO_MEMORY_AUTO_OBSERVE !== "false"
      const memoryInjectContext = process.env.COVALO_MEMORY_INJECT_CONTEXT !== "false"
      const memoryAdvanced = process.env.COVALO_MEMORY_ADVANCED === "true"

      memoryService = new memory.MemoryService({
        autoObserve: memoryAutoObserve,
        injectContext: memoryInjectContext,
        advancedTools: memoryAdvanced,
        enableGraph: process.env.COVALO_MEMORY_GRAPH === "true",
        enableConsolidation: process.env.COVALO_MEMORY_CONSOLIDATE === "true",
        enableReflect: process.env.COVALO_MEMORY_REFLECT === "true",
        enableSlots: process.env.COVALO_MEMORY_SLOTS === "true",
      })
      await memoryService.start()
      memoryBridge = new memory.DeepreefMemoryBridge(memoryService, { autoObserve: memoryAutoObserve, injectContext: memoryInjectContext })

      // P1-1: Session lifecycle — call onSessionStart after service is ready
      await memoryBridge.onSessionStart(engine.getSessionId()).catch(() => {})

      // P0-1: Inject initial memory context into system prompt, then re-set on engine
      if (memoryInjectContext) {
        // Apply memory context after plugin rules so concurrent prompt updates cannot overwrite it.
        await pluginReady
        const memContext = await memoryService.trigger("mem::context", {
          sessionId: engine.getSessionId(),
          project: process.cwd(),
          maxChars: 2000,
        }).catch(() => null)
        if (memContext && typeof memContext === "object" && "context" in memContext) {
          const ctx = (memContext as { context: string }).context
          if (ctx) memoryContextPrompt = `<covalo-memory-context>\n${ctx}\n</covalo-memory-context>`
        }
        // P0-1: Re-set system prompt after memory context is appended
        baseSystemPrompt = rebuildBaseSystemPrompt()
        engine.setSystemPrompt(baseSystemPrompt)
      }

      // Wire bridge hooks into engine's HookManager
      // P0-2: onLoopEvent only handles generation complete (done event)
      const hookAdapter: ToolCallHooks = {
        afterToolCall: async (toolName: string, result: { content: string; isError: boolean }) => {
          if (result.isError) {
            await memoryBridge?.onPostToolFailure(engine.getSessionId(), toolName, result.content).catch(() => {})
          } else {
            await memoryBridge?.onPostToolUse(engine.getSessionId(), toolName, result).catch(() => {})
          }
        },
        onLoopEvent: async (event: Record<string, unknown>) => {
          // P1-1: Wire onGenerationComplete for the done event
          if (event.role === "done") {
            await memoryBridge?.onGenerationComplete(engine.getSessionId()).catch(() => {})
          }
        },
      }
      // P1-1: Save reference for cleanup on exit
      memoryHookAdapter = hookAdapter
      engine.hookManager.addHooks(hookAdapter)

      // P1-3: Register memory_migrate tool + P0-3 fix via dynamic import
      engine.registerTool(memory.createMemoryRecallTool(memoryService))
      engine.registerTool(memory.createMemorySaveTool(memoryService))
      engine.registerTool(memory.createMemorySmartSearchTool(memoryService))
      engine.registerTool(memory.createMemoryForgetTool(memoryService))
      engine.registerTool(memory.createMemoryTimelineTool(memoryService))
      engine.registerTool(memory.createMemoryStatusTool(memoryService))
      engine.registerTool(memory.createMemoryMigrateTool())

      process.stderr.write(`[covalo] Memory initialized\n`)
    } catch (e) {
      process.stderr.write(`[covalo] Memory init skipped: ${e instanceof Error ? e.message : String(e)}\n`)
      memoryService = undefined
      memoryBridge = undefined
    }
  })

  try {
    // TUI: 非 TTY 进入 pipe 模式
    if (!input.isTTY) {
      await Promise.all([pluginReady, memoryReady])
      await runPipeMode(engine, memoryBridge)
      return
    }

    // WF-FIX-10: Create supervisor engine and wire DualAgentRuntime
    await Promise.all([pluginReady, memoryReady])

    // per-role 模型配置：优先读取持久化的 role-config.json，缺省回退到全局 config。
    // worker 引擎即传入的 engine（已按 config 创建），其模型在 App 的 /model 命令里
    // 会通过 updateConfig 热更新；supervisor 引擎在此按其 role config 独立创建。
    const workerRoleCfg = loadRoleConfig("worker")
    const supervisorRoleCfg = loadRoleConfig("supervisor")

    // SFR-40: 加载 Agent Profile（agents.json），用于 thinking/温度等角色级配置
    const agentProfiles = loadAgentProfiles()
    const workerProfile = getAgentProfile(agentProfiles, "worker")
    const supervisorProfile = getAgentProfile(agentProfiles, "supervisor")

    // 若 worker 持久化了不同的 provider/model/baseUrl，热更新 worker 引擎使其生效
    if (workerRoleCfg && (workerRoleCfg.model !== config.model || workerRoleCfg.provider !== (config.provider ?? "zen"))) {
      engine.updateConfig({
        provider: workerRoleCfg.provider,
        model: workerRoleCfg.model,
        baseUrl: workerRoleCfg.baseUrl,
        contextWindow: getModelContextWindow(workerRoleCfg.provider, workerRoleCfg.model),
      })
    }

    // SFR-40: 应用 Worker Profile 的 thinking 模式
    engine.setThinkingMode(workerProfile.thinking)

    // supervisor 引擎：用 supervisor role config（若有）覆盖，否则与全局 config 一致
    const supervisorConfig: typeof config = supervisorRoleCfg
      ? {
          ...config,
          provider: supervisorRoleCfg.provider,
          model: supervisorRoleCfg.model,
          baseUrl: supervisorRoleCfg.baseUrl,
          contextWindow: getModelContextWindow(supervisorRoleCfg.provider, supervisorRoleCfg.model),
        }
      : config
    const supervisorEngine = new ReasonixEngine(supervisorConfig, clearReadTracker)
    supervisorEngine.setSystemPrompt(rebuildBaseSystemPrompt())
    // SFR-40: 应用 Supervisor Profile 的 thinking 模式（与 Worker 独立）
    supervisorEngine.setThinkingMode(supervisorProfile.thinking)

    // Supervisor 自身可见工具仍由 resolveEffectiveTools 限制；底层注册完整工具表，
    // 以便 AgentTool 派出的独立 Worker 子 engine 能继承执行工具。
    for (const tool of engine.getRegisteredTools()) supervisorEngine.registerTool(tool)
    supervisorEngine.registerTool(createAgentToolTool())
    supervisorEngine.registerTool(createAskUserQuestionTool())
    supervisorEngine.registerTool(createReadFileTool())
    supervisorEngine.registerTool(createGrepTool())
    supervisorEngine.registerTool(createListDirTool())
    supervisorEngine.registerTool(createTodoWriteTool())

    // worker/supervisor 的 config 块：反映各自实际生效的 provider/model/baseUrl
    const workerEffectiveModel = workerRoleCfg?.model ?? config.model
    const workerEffectiveProvider = workerRoleCfg?.provider ?? config.provider
    const workerEffectiveBaseUrl = workerRoleCfg?.baseUrl ?? config.baseUrl

    // Stage B: 各自 provider 的 API Key 分别解析
    const { value: workerApiKey } = resolveApiKey(workerEffectiveProvider ?? "zen")
    const { value: supervisorApiKey } = resolveApiKey(supervisorConfig.provider ?? "zen")

    const dualRuntime = new DualAgentRuntime({
      workerClient: engine as unknown as import("@covalo/core").ChatClient,
      supervisorClient: supervisorEngine as unknown as import("@covalo/core").ChatClient,
      workerSystemPrompt: baseSystemPrompt,
      supervisorSystemPrompt: baseSystemPrompt,
      config: {
        maxWorkflowRounds: 9,
        workerModelTarget: workerEffectiveModel,
        supervisorModelTarget: supervisorConfig.model,
        // SFR-40: 使用 Profile 中的 thinking 值而非硬编码 'off'
        workerThinking: workerProfile.thinking,
        supervisorThinking: supervisorProfile.thinking,
      },
      workerConfig: {
        apiKey: workerApiKey,
        baseUrl: workerEffectiveBaseUrl,
        model: workerEffectiveModel,
        maxTokens: config.maxTokens,
        temperature: workerProfile.temperature ?? config.temperature,
        provider: workerEffectiveProvider,
      },
      supervisorConfig: {
        apiKey: supervisorApiKey,
        baseUrl: supervisorConfig.baseUrl,
        model: supervisorConfig.model,
        maxTokens: supervisorConfig.maxTokens ?? config.maxTokens,
        temperature: supervisorProfile.temperature ?? config.temperature,
        provider: supervisorConfig.provider,
      },
      workerEngine: engine,
      supervisorEngine: supervisorEngine,
    })

    // SFR-40: 启动时输出角色配置诊断
    process.stderr.write(`[covalo] Worker:  model=${workerEffectiveModel}  thinking=${workerProfile.thinking}\n`)
    process.stderr.write(`[covalo] Supervisor:  model=${supervisorConfig.model}  thinking=${supervisorProfile.thinking}  tools=6\n`)

    // WF-FIX-40: QuestionService with timeout wrapper to prevent indefinite blocking
    const questionService = new QuestionService()
    const originalAsk = questionService.ask.bind(questionService)
    questionService.ask = async (input) => {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Question ask timed out")), 30000)
      )
      return Promise.race([originalAsk(input), timeout])
    }

    // SFR-60: Coordinator 阶段事件写入标准输出和进程诊断日志
    const goalStore = new GoalStore()
    const mailbox = new Mailbox()
    const scoreStore = new AgentScoreStore()
    const workflowCoordinator = new WorkflowCoordinator({
      runtime: dualRuntime,
      questionService,
      goalStore,
      mailbox,
      scoreStore,
      onEvent: (event) => {
        if (event.type === 'phase_change' || event.type === 'blocked' || event.type === 'completed' || event.type === 'failed') {
          process.stderr.write(`[workflow] ${event.type} phase=${event.phase ?? ''} iteration=${event.iteration ?? 0}\n`)
        }
      },
    })

    // Phase D+H: 注册动态 governance 工具（不固定 threadId/controller）
    for (const tool of createGoalTools({
      getGoalStore: () => workflowCoordinator.getGoalStore()!,
      getThreadId: () => workflowCoordinator.getCurrentThreadId(),
    })) engine.registerTool(tool)

    for (const tool of createMailboxTools({
      getController: () => workflowCoordinator.getCurrentAgentComm(),
    }, "worker")) engine.registerTool(tool)

    for (const tool of createMailboxTools({
      getController: () => workflowCoordinator.getCurrentAgentComm(),
    }, "supervisor")) supervisorEngine.registerTool(tool)

    for (const tool of createGoalTools({
      getGoalStore: () => workflowCoordinator.getGoalStore()!,
      getThreadId: () => workflowCoordinator.getCurrentThreadId(),
    })) supervisorEngine.registerTool(tool)

    await runTUIMode(
      engine,
      config,
      pluginRuntime,
      mcpConfigCount,
      () => memoryBridge,
      () => pluginReady,
      memoryReady,
      dualRuntime,
      workflowCoordinator,
      { os: platform, shell: shellBackend.id, shellBackend: `${shellBackend.id} (${shellBackend.executable})` },
      rebuildBaseSystemPrompt,
    )
  } finally {
    await Promise.allSettled([pluginReady, memoryReady])
    // P3-3: Drain all pending hook observations before cleanup
    // (engine's void runOnLoopEvent is fire-and-forget; drain waits for all in-flight hooks)
    await engine.hookManager.drain().catch(() => {})
    // Phase C: Stop memory subsystem before engine (best-effort)
    await memoryBridge?.onSessionEnd(engine.getSessionId()).catch(() => {})
    // P1-1: Remove hook adapter to avoid duplicate observations on restart
    if (memoryHookAdapter) {
      engine.hookManager.removeHooks(memoryHookAdapter)
    }
    await memoryService?.stop().catch(() => {})
    // LIFE-01: close engine (tokenizer worker, logger, session writer)
    await engine.shutdown()
    // P3: plugin runtime 现在是 async dispose，会派发 onShutdown hooks
    await pluginRuntime.dispose()
    // Wait for background MCP load to settle before disconnecting (best-effort, 2s cap)
    await Promise.race([mcpLoadPromise, new Promise<void>(r => setTimeout(r, 2000))])
    await mcpHost.disconnectAll()
    // Phase 2: dispose LSP pool — shutdown all server processes
    await lspPool.disposeAll().catch(() => {})
  }
}

async function runPipeMode(engine: ReasonixEngine, memoryBridge?: import("@covalo/memory").DeepreefMemoryBridge): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(Buffer.from(chunk))
  const prompt = Buffer.concat(chunks).toString("utf8").trim()
  if (!prompt) return
  // P0-2: Observe user prompt at the real entry point (before engine.submit)
  if (memoryBridge) {
    await memoryBridge.onPromptSubmit(engine.getSessionId(), prompt).catch(() => {})
  }
  for await (const event of engine.submit(prompt)) {
    switch (event.role) {
      case "assistant_delta":
        output.write(event.content ?? "")
        break
      case "assistant_final":
        output.write("\n")
        break
      case "reasoning_delta":
        break
      case "tool_call_delta":
        break
      case "tool_start":
        output.write(`\n[tool] ${event.toolName ?? "unknown"} ...\n`)
        break
      case "tool_progress":
        break
      case "tool": {
        const c = event.content ?? ""
        try { const p = JSON.parse(c) as Record<string,unknown>; output.write(JSON.stringify(p, null, 2) + "\n") }
        catch { output.write(c + "\n") }
        break
      }
      case "status":
        if (event.content && event.content !== "tools_completed" && event.content !== "interrupted") {
          output.write(`\n# ${event.content}\n`)
        }
        break
      case "warning":
        errorOutput.write(`\nwarning: ${event.content ?? ""}\n`)
        break
      case "error":
        errorOutput.write(`\nerror: ${event.content ?? ""}\n`)
        break
      case "done":
        break
    }
  }
}

async function runTUIMode(
  engine: ReasonixEngine,
  config: ReturnType<typeof loadConfig>,
  pluginRuntime: PluginRuntime,
  mcpConfigCount: number = 0,
  getMemoryBridge?: () => import("@covalo/memory").DeepreefMemoryBridge | undefined,
  beforeSubmit?: () => Promise<void>,
  memoryReady?: Promise<void>,
  dualRuntime?: DualAgentRuntime,
  workflowCoordinator?: WorkflowCoordinator,
  platformInfo?: { os: string; shell: string; shellBackend: string },
  rebuildBaseSystemPrompt?: (locale?: import("@covalo/core").PromptLocale) => string,
): Promise<void> {
  const status = pluginRuntime.getStatus()
  const pluginCount = status.loadedPlugins.length
  const contentPackCount = status.contentPacks.length
  const assetCounts = status.assets
  // Count error/warning diagnostics
  const diagnosticCounts = {
    errors: status.diagnostics.filter(d => d.startsWith("[error]")).length,
    warnings: status.diagnostics.filter(d => d.startsWith("[warn]")).length,
  }
  // P0-2: Provide onUserInput callback so bridge can observe user prompts at the real entry point
  const onUserInput = (text: string) => {
    void (memoryReady ?? Promise.resolve()).then(() =>
      getMemoryBridge?.()?.onPromptSubmit(engine.getSessionId(), text),
    ).catch(() => {})
  }

  try {
    const { waitUntilExit } = await render(
      React.createElement(App, { engine, config, pluginCount, contentPackCount, assetCounts, diagnosticCounts, onUserInput, beforeSubmit, dualRuntime, workflowCoordinator, onPromptLocaleChange: (locale: "zh-CN" | "en") => {
        const newPrompt = rebuildBaseSystemPrompt?.(locale) ?? buildSystemPrompt(process.cwd(), {
          osPlatform: platformInfo?.os ?? "linux",
          shellBackend: platformInfo?.shellBackend ?? "",
          locale,
        })
        engine.setSystemPrompt(newPrompt)
        if (dualRuntime) {
          dualRuntime.getSupervisor().getEngine().setSystemPrompt(newPrompt)
        }
      } }),
      { exitOnCtrlC: false, onFrame: createFrameMetricsHandler() },
    );
    await waitUntilExit();
  } finally {
    try { writeSync(1, '\x1b[?1049l'); } catch {}
    try { writeSync(1, '\x1b[?25h'); } catch {}
  }
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

function deferTask<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<void>(resolve => setTimeout(resolve, 0)).then(task)
}

main()
  .then(() => {
    // LIFE-01: Bun's fetch() keep-alive connections prevent natural process exit.
    // All resources are already closed in the finally block above.
    process.exit(0)
  })
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
