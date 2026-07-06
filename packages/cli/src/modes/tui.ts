import { writeSync } from "node:fs"
import { loadRoleConfig, getModelContextWindow, ReasonixEngine, loadAgentProfiles, getAgentProfile, resolveApiKey } from "@covalo/core"
import { DualAgentRuntime } from "@covalo/core/dual-agent-runtime/dual-runtime.js"
import { WorkflowCoordinator } from "@covalo/core/workflow-coordinator/coordinator.js"
import { QuestionService } from "@covalo/core/question/service.js"
import { GoalStore } from "@covalo/core/goal/store.js"
import { Mailbox } from "@covalo/core/agent-comm/mailbox.js"
import { AgentScoreStore } from "@covalo/core/scoring/index.js"
import { createGoalTools } from "@covalo/core/goal/tools.js"
import { createMailboxTools } from "@covalo/core/agent-comm/tools.js"
import { clearReadTracker, createAgentToolTool, createAskUserQuestionTool, createReadFileTool, createGrepTool, createListDirTool, createTodoWriteTool } from "@covalo/tools"
import type { CovaloRuntime } from "../runtime/create-covalo-runtime.js"
import React from "react"
import { wrappedRender as render } from "@covalo/ink"
import { App, createFrameMetricsHandler } from "@covalo/tui"

export async function runTuiMode(runtime: CovaloRuntime): Promise<void> {
  const status = runtime.pluginRuntime.getStatus()
  const pluginCount = status.loadedPlugins.length
  const contentPackCount = status.contentPacks.length
  const assetCounts = status.assets
  const diagnosticCounts = {
    errors: status.diagnostics.filter(d => d.startsWith("[error]")).length,
    warnings: status.diagnostics.filter(d => d.startsWith("[warn]")).length,
  }

  const workerRoleCfg = loadRoleConfig("worker")
  const supervisorRoleCfg = loadRoleConfig("supervisor")

  const agentProfiles = loadAgentProfiles()
  const workerProfile = getAgentProfile(agentProfiles, "worker")
  const supervisorProfile = getAgentProfile(agentProfiles, "supervisor")

  if (workerRoleCfg && (workerRoleCfg.model !== runtime.config.model || workerRoleCfg.provider !== (runtime.config.provider ?? "zen"))) {
    runtime.engine.updateConfig({
      provider: workerRoleCfg.provider,
      model: workerRoleCfg.model,
      baseUrl: workerRoleCfg.baseUrl,
      contextWindow: getModelContextWindow(workerRoleCfg.provider, workerRoleCfg.model),
    })
  }

  runtime.engine.setThinkingMode(workerProfile.thinking)

  const supervisorConfig: typeof runtime.config = supervisorRoleCfg
    ? {
        ...runtime.config,
        provider: supervisorRoleCfg.provider,
        model: supervisorRoleCfg.model,
        baseUrl: supervisorRoleCfg.baseUrl,
        contextWindow: getModelContextWindow(supervisorRoleCfg.provider, supervisorRoleCfg.model),
      }
    : runtime.config
  const supervisorEngine = new ReasonixEngine(supervisorConfig, clearReadTracker, undefined, undefined, undefined, { toolRuntimeHooks: runtime.toolRuntimeHooks })
  supervisorEngine.setSystemPrompt(runtime.rebuildBaseSystemPrompt())
  supervisorEngine.setThinkingMode(supervisorProfile.thinking)

  for (const tool of runtime.engine.getRegisteredTools()) supervisorEngine.registerTool(tool)
  supervisorEngine.registerTool(createAgentToolTool())
  supervisorEngine.registerTool(createAskUserQuestionTool())
  supervisorEngine.registerTool(createReadFileTool())
  supervisorEngine.registerTool(createGrepTool())
  supervisorEngine.registerTool(createListDirTool())
  supervisorEngine.registerTool(createTodoWriteTool())

  const workerEffectiveModel = workerRoleCfg?.model ?? runtime.config.model
  const workerEffectiveProvider = workerRoleCfg?.provider ?? runtime.config.provider
  const workerEffectiveBaseUrl = workerRoleCfg?.baseUrl ?? runtime.config.baseUrl

  const { value: workerApiKey } = resolveApiKey(workerEffectiveProvider ?? "zen")
  const { value: supervisorApiKey } = resolveApiKey(supervisorConfig.provider ?? "zen")

  const dualRuntime = new DualAgentRuntime({
    workerClient: runtime.engine as unknown as import("@covalo/core").ChatClient,
    supervisorClient: supervisorEngine as unknown as import("@covalo/core").ChatClient,
    workerSystemPrompt: runtime.rebuildBaseSystemPrompt(),
    supervisorSystemPrompt: runtime.rebuildBaseSystemPrompt(),
    config: {
      maxWorkflowRounds: 9,
      workerModelTarget: workerEffectiveModel,
      supervisorModelTarget: supervisorConfig.model,
      workerThinking: workerProfile.thinking,
      supervisorThinking: supervisorProfile.thinking,
    },
    workerConfig: {
      apiKey: workerApiKey,
      baseUrl: workerEffectiveBaseUrl,
      model: workerEffectiveModel,
      maxTokens: runtime.config.maxTokens,
      temperature: workerProfile.temperature ?? runtime.config.temperature,
      provider: workerEffectiveProvider,
    },
    supervisorConfig: {
      apiKey: supervisorApiKey,
      baseUrl: supervisorConfig.baseUrl,
      model: supervisorConfig.model,
      maxTokens: supervisorConfig.maxTokens ?? runtime.config.maxTokens,
      temperature: supervisorProfile.temperature ?? runtime.config.temperature,
      provider: supervisorConfig.provider,
    },
    workerEngine: runtime.engine,
    supervisorEngine: supervisorEngine,
  })

  process.stderr.write(`[covalo] Worker:  model=${workerEffectiveModel}  thinking=${workerProfile.thinking}\n`)
  process.stderr.write(`[covalo] Supervisor:  model=${supervisorConfig.model}  thinking=${supervisorProfile.thinking}  tools=6\n`)

  const questionService = new QuestionService()
  const originalAsk = questionService.ask.bind(questionService)
  questionService.ask = async (input) => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Question ask timed out")), 30000)
    )
    return Promise.race([originalAsk(input), timeout])
  }

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

  for (const tool of createGoalTools({
    getGoalStore: () => workflowCoordinator.getGoalStore()!,
    getThreadId: () => workflowCoordinator.getCurrentThreadId(),
  })) runtime.engine.registerTool(tool)

  for (const tool of createMailboxTools({
    getController: () => workflowCoordinator.getCurrentAgentComm(),
  }, "worker")) runtime.engine.registerTool(tool)

  for (const tool of createMailboxTools({
    getController: () => workflowCoordinator.getCurrentAgentComm(),
  }, "supervisor")) supervisorEngine.registerTool(tool)

  for (const tool of createGoalTools({
    getGoalStore: () => workflowCoordinator.getGoalStore()!,
    getThreadId: () => workflowCoordinator.getCurrentThreadId(),
  })) supervisorEngine.registerTool(tool)

  try {
    const { waitUntilExit } = await render(
      React.createElement(App, { engine: runtime.engine, config: runtime.config, pluginCount, contentPackCount, assetCounts, diagnosticCounts, dualRuntime, workflowCoordinator, onPromptLocaleChange: (locale: "zh-CN" | "en") => {
        const newPrompt = runtime.rebuildBaseSystemPrompt(locale)
        runtime.engine.setSystemPrompt(newPrompt)
        dualRuntime.getSupervisor().getEngine().setSystemPrompt(newPrompt)
      } }),
      { exitOnCtrlC: false, onFrame: createFrameMetricsHandler() },
    );
    await waitUntilExit();
  } finally {
    try { writeSync(1, '\x1b[?1049l'); } catch {}
    try { writeSync(1, '\x1b[?25h'); } catch {}
  }
}
