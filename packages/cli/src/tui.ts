import { stdin as input, stdout as output, stderr as errorOutput } from "node:process"
import { readFileSync, writeSync } from "node:fs"
import { resolve } from "node:path"
import { loadConfig, loadRoleConfig, getModelContextWindow, ReasonixEngine, SessionLoader, defaultAgentRegistry } from "@deepreef/core"
import { buildSystemPrompt } from "@deepreef/core"
import { DualAgentRuntime } from "@deepreef/core/dual-agent-runtime/dual-runtime.js"
import { WorkflowCoordinator } from "@deepreef/core/workflow-coordinator/coordinator.js"
import { QuestionService } from "@deepreef/core/question/service.js"
import { createDefaultTools, clearReadTracker, normalizePlatform, resolveShellBackend, createAgentToolTool, createAskUserQuestionTool, createReadFileTool, createGrepTool, createListDirTool, createTodoWriteTool } from "@deepreef/tools"
import { McpHost, createListMcpResourcesTool, createReadMcpResourceTool, createMcpAuthTool, createListMcpToolsTool, createCallMcpToolTool, setMcpHost } from "@deepreef/mcp"
import { PluginRuntime, pluginToolsToAgentTools } from "@deepreef/plugin"
import type { ToolCallHooks } from "@deepreef/security"
// P1-4: Memory is dynamically imported when enabled to avoid loading when DEEPREEF_MEMORY=false
import React from "react"
import { wrappedRender as render } from "@deepreef/ink"
import { App, createFrameMetricsHandler } from "@deepreef/tui"



function printHelp(): void {
  output.write(`deepreef

Usage:
  bun run packages/cli/src/index.ts
  echo "你好" | bun run packages/cli/src/index.ts

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
  const config = loadConfig()

  // Initialize MCP host in background — don't block startup
  const mcpHost = new McpHost()
  setMcpHost(mcpHost)
  let mcpLoadPromise = mcpHost.loadConfig().then((summary) => {
    if (summary.failed.length > 0) {
      errorOutput.write(`[deepreef] MCP loaded with ${summary.failed.length}/${summary.serverCount} server failure(s)\n`)
    }
  }).catch((error) => {
    errorOutput.write(`[deepreef] MCP config load failed: ${error instanceof Error ? error.message : String(error)}\n`)
  })

  const engine = sessionId
    ? await ReasonixEngine.recover(config, sessionId)
    : new ReasonixEngine(config, clearReadTracker)
  SessionLoader.cleanup().catch(() => {})
  const platform = normalizePlatform()
  const shellBackend = await resolveShellBackend(platform)
  let baseSystemPrompt = buildSystemPrompt(process.cwd(), {
    osPlatform: platform,
    shellBackend: `${shellBackend.id} (${shellBackend.executable})`,
  })

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
        baseSystemPrompt += "\n\n" + rulesResult.systemPrompt
        engine.setSystemPrompt(baseSystemPrompt)
      }

      const preloadedSkills: import('@deepreef/tools').SkillDef[] = []
      for (const cs of pluginRuntime.loadCommandSkills()) {
        preloadedSkills.push({ name: cs.name, description: cs.description, content: cs.content })
      }
      for (const sd of pluginRuntime.loadSkillDefs()) {
        preloadedSkills.push({ name: sd.name, description: sd.description, content: sd.content, source: sd.source })
      }
      for (const rs of rulesResult.skillRules) {
        preloadedSkills.push({ name: rs.name, description: rs.description, content: rs.content })
      }

      for (const tool of createDefaultTools(skillDirs, preloadedSkills)) engine.registerTool(tool)
      for (const tool of pluginToolAgentTools) engine.registerTool(tool)

      const mcpConfigs = pluginRuntime.loadMcpConfigs()
      mcpConfigCount = mcpConfigs.length
      if (mcpConfigs.length > 0) {
        mcpLoadPromise = mcpLoadPromise.then(() => mcpHost.addSources(mcpConfigs)).then((summary) => {
          if (summary.failed.length > 0) {
            errorOutput.write(`[deepreef] Content pack MCP: ${summary.failed.length}/${summary.serverCount} server failure(s)\n`)
          }
        })
      }
    } catch (e) {
      errorOutput.write(`[deepreef] Plugin init skipped: ${e instanceof Error ? e.message : String(e)}\n`)
      // Preserve a usable agent even when plugin discovery fails.
      for (const tool of createDefaultTools([], [])) engine.registerTool(tool)
    }
  })

  // Memory is fully background-loaded and never gates the first model request.
  let memoryService: import("@deepreef/memory").MemoryService | undefined
  let memoryBridge: import("@deepreef/memory").DeepreefMemoryBridge | undefined
  let memoryHookAdapter: ToolCallHooks | undefined
  const enableMemory = process.env.DEEPREEF_MEMORY !== "false"
  const memoryReady = deferTask(async () => {
    if (!enableMemory) return
    try {
      const memory = await import("@deepreef/memory")
      // P1-2: Config from env vars with sensible defaults
      const memoryAutoObserve = process.env.DEEPREEF_MEMORY_AUTO_OBSERVE !== "false"
      const memoryInjectContext = process.env.DEEPREEF_MEMORY_INJECT_CONTEXT !== "false"
      const memoryAdvanced = process.env.DEEPREEF_MEMORY_ADVANCED === "true"

      memoryService = new memory.MemoryService({
        autoObserve: memoryAutoObserve,
        injectContext: memoryInjectContext,
        advancedTools: memoryAdvanced,
        enableGraph: process.env.DEEPREEF_MEMORY_GRAPH === "true",
        enableConsolidation: process.env.DEEPREEF_MEMORY_CONSOLIDATE === "true",
        enableReflect: process.env.DEEPREEF_MEMORY_REFLECT === "true",
        enableSlots: process.env.DEEPREEF_MEMORY_SLOTS === "true",
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
          if (ctx) baseSystemPrompt += `\n\n<deepreef-memory-context>\n${ctx}\n</deepreef-memory-context>`
        }
        // P0-1: Re-set system prompt after memory context is appended
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

      process.stderr.write(`[deepreef] Memory initialized\n`)
    } catch (e) {
      process.stderr.write(`[deepreef] Memory init skipped: ${e instanceof Error ? e.message : String(e)}\n`)
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

    // 若 worker 持久化了不同的 provider/model/baseUrl，热更新 worker 引擎使其生效
    if (workerRoleCfg && (workerRoleCfg.model !== config.model || workerRoleCfg.provider !== (config.provider ?? "zen"))) {
      engine.updateConfig({
        provider: workerRoleCfg.provider,
        model: workerRoleCfg.model,
        baseUrl: workerRoleCfg.baseUrl,
        contextWindow: getModelContextWindow(workerRoleCfg.provider, workerRoleCfg.model),
      })
    }

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
    supervisorEngine.setSystemPrompt(baseSystemPrompt)

    // 给 supervisor 注册"监督规划"角色所需工具：派活（AgentTool）、求助（AskUser）、
    // 读取证据（read_file/grep/list_dir）、任务清单（todowrite）。不注册写文件/exec
    // 类工具 —— 执行应通过 AgentTool 派发给独立 worker 子 engine，避免 supervisor
    // 自己动手偏离规划职责。这样 supervisor 在普通对话中可自主调度：分析→派活→
    // 收结果→继续/修正/AskUser。/run 固定 Workflow 不受影响（它经
    // WorkflowCoordinator 直接调 dual-runtime 两个 AgentRuntime，不走工具系统）。
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

    const dualRuntime = new DualAgentRuntime({
      workerClient: engine as unknown as import("@deepreef/core").ChatClient,
      supervisorClient: supervisorEngine as unknown as import("@deepreef/core").ChatClient,
      workerSystemPrompt: baseSystemPrompt,
      supervisorSystemPrompt: baseSystemPrompt,
      config: {
        maxWorkflowRounds: 9,
        workerModelTarget: workerEffectiveModel,
        supervisorModelTarget: supervisorConfig.model,
        workerThinking: 'off' as const,
        supervisorThinking: 'off' as const,
      },
      workerConfig: {
        apiKey: config.apiKey,
        baseUrl: workerEffectiveBaseUrl,
        model: workerEffectiveModel,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        provider: workerEffectiveProvider,
      },
      supervisorConfig: {
        apiKey: config.apiKey,
        baseUrl: supervisorConfig.baseUrl,
        model: supervisorConfig.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        provider: supervisorConfig.provider,
      },
      workerEngine: engine,
      supervisorEngine: supervisorEngine,
    })

    // WF-FIX-40: QuestionService with timeout wrapper to prevent indefinite blocking
    const questionService = new QuestionService()
    const originalAsk = questionService.ask.bind(questionService)
    questionService.ask = async (input) => {
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Question ask timed out")), 30000)
      )
      return Promise.race([originalAsk(input), timeout])
    }

    const workflowCoordinator = new WorkflowCoordinator({
      runtime: dualRuntime,
      questionService,
    })

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
    pluginRuntime.dispose()
    // Wait for background MCP load to settle before disconnecting (best-effort, 2s cap)
    await Promise.race([mcpLoadPromise, new Promise<void>(r => setTimeout(r, 2000))])
    await mcpHost.disconnectAll()
  }
}

async function runPipeMode(engine: ReasonixEngine, memoryBridge?: import("@deepreef/memory").DeepreefMemoryBridge): Promise<void> {
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
  getMemoryBridge?: () => import("@deepreef/memory").DeepreefMemoryBridge | undefined,
  beforeSubmit?: () => Promise<void>,
  memoryReady?: Promise<void>,
  dualRuntime?: DualAgentRuntime,
  workflowCoordinator?: WorkflowCoordinator,
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
      React.createElement(App, { engine, config, pluginCount, contentPackCount, assetCounts, diagnosticCounts, onUserInput, beforeSubmit, dualRuntime, workflowCoordinator }),
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
    const raw = readFileSync(resolve(process.cwd(), ".deepreef", "mcp.json"), "utf8")
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
