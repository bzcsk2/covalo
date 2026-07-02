/**
 * Supervisor 指导回注与 Worker 继续执行 — DRF-60。
 *
 * Worker 失败 → EvidenceBundle → SupervisorAdvice → 校验 → 注入 scratch → Worker 继续。
 */

import type { ContextManager } from "../context/manager.js"
import { estimateTokens } from "../context/token-estimator.js"
import type { ChatClient } from "../interface.js"
import type { ChatMessage } from "../types.js"
import { getPromptLocale } from "../prompt-locale.js"
import type { PromptLocale } from "../prompt-locale.js"
import type { ModelTarget } from "../model-target.js"
import { createClientForTarget } from "../model-target.js"
import type { TaskLedger } from "../task-ledger.js"
import { parseSupervisorAdvice } from "./advice-schema.js"
import { SupervisorBudgetTracker } from "./budget.js"
import {
  buildEvidenceBundle,
  hashEvidenceBundle,
} from "./evidence.js"
import type { SupervisorPoolConfig } from "./pool.js"
import { selectSupervisorCandidate } from "./router.js"
import { shouldRequestSupervisor } from "./triggers.js"
import type {
  EvidenceBundle,
  EvidenceFailureEntry,
  EvidenceToolEntry,
  FailureClass,
  FailureSignatureRecord,
  SupervisorAdvice,
  SupervisorTriggerContext,
  SupervisorTriggerDecision,
} from "./types.js"
import { SUPERVISOR_ADVICE_VERSION } from "./types.js"

/** Supervisor 指导会话状态（单 submit 内追踪） */
export interface SupervisorGuidanceState {
  /** 同失败签名的请求历史 */
  failureSignatureHistory: Record<string, FailureSignatureRecord>
  /** 已请求过的 evidence hash，防止 crash/restart 后重复询问 */
  requestedEvidenceHashes: string[]
  /** 近期失败摘要（checkpoint 风格） */
  recentFailures: Array<{ signature: string; count: number; lastError?: string }>
  /** 近期工具摘要 */
  recentTools: EvidenceToolEntry[]
  /** 最近一次 EarlyStop 原因 */
  lastStopSignalReason?: string
  /** advice 后无净进展轮次 */
  stagnantRoundsAfterAdvice: number
  /** 本轮已注入 advice 次数 */
  adviceInjectionCount: number
}

/** 创建空的 Supervisor 指导状态 */
export function createSupervisorGuidanceState(): SupervisorGuidanceState {
  return {
    failureSignatureHistory: {},
    requestedEvidenceHashes: [],
    recentFailures: [],
    recentTools: [],
    stagnantRoundsAfterAdvice: 0,
    adviceInjectionCount: 0,
  }
}

/** Loop 层 Supervisor 指导配置 */
export interface SupervisorGuidanceConfig {
  pool: SupervisorPoolConfig
  budget: SupervisorBudgetTracker
  state: SupervisorGuidanceState
  /** 解析 ModelTarget */
  resolveTarget: (targetId: string) => ModelTarget | null
  /** Supervisor 是否已配置可用 */
  supervisorConfigured?: boolean
  /** 可选：自定义 ChatClient 工厂（测试注入） */
  createClient?: (target: ModelTarget) => ChatClient
  /** checkpoint 保存提示回调 */
  onCheckpointHint?: (reason: string) => void
}

/** requestSupervisorAdvice 输入 */
export interface RequestSupervisorAdviceInput {
  trigger: SupervisorTriggerDecision
  ledger: TaskLedger
  pool: SupervisorPoolConfig
  budget: SupervisorBudgetTracker
  state: SupervisorGuidanceState
  resolveTarget: (targetId: string) => ModelTarget | null
  recentFailures?: EvidenceFailureEntry[]
  recentTools?: EvidenceToolEntry[]
  failureSignature?: string
  stopSignalReason?: string
  attemptedStrategies?: string[]
  signal?: AbortSignal
  now?: number
  createClient?: (target: ModelTarget) => ChatClient
}

/** requestSupervisorAdvice 结果 */
export interface SupervisorAdviceResult {
  success: boolean
  advice?: SupervisorAdvice
  evidence?: EvidenceBundle
  evidenceHash?: string
  failureSignature?: string
  candidateId?: string
  selectionReason?: string
  error?: string
  degraded?: boolean
  checkpointHint?: boolean
  latencyMs?: number
  requiresUser?: boolean
}

/** injectAdviceToContext 输入 */
export interface InjectAdviceInput {
  ctx: ContextManager
  advice: SupervisorAdvice
  evidenceHash: string
  source: string
  timestamp?: number
}

/** scratch 注入元数据 */
export interface SupervisorAdviceScratchMeta {
  source: string
  timestamp: number
  evidenceHash: string
  failureClass: FailureClass
}

const MAX_RECENT_TOOLS = 20
const MAX_RECENT_FAILURES = 10

/**
 * 构建发给 Supervisor 的请求消息。
 */
export function buildSupervisorRequestMessages(evidence: EvidenceBundle, locale?: PromptLocale): ChatMessage[] {
  const isZh = (locale ?? getPromptLocale()) === "zh-CN"
  const schemaHint = isZh
    ? `请仅以符合 SupervisorAdvice v${SUPERVISOR_ADVICE_VERSION} 的有效 JSON 格式回复：
{
  "version": ${SUPERVISOR_ADVICE_VERSION},
  "diagnosis": "简要诊断",
  "failureClass": "tool_format|wrong_strategy|missing_context|verification_failure|goal_drift|provider_failure|unknown",
  "nextActions": ["操作 1", "操作 2"],
  "constraints": ["限制条件"],
  "verification": ["验证方式"],
  "confidence": 0.0-1.0,
  "shouldContinue": true,
  "requiresUser": false
}
仅提供建议，不执行工具或输出补丁。`
    : `Respond with ONLY valid JSON matching SupervisorAdvice v${SUPERVISOR_ADVICE_VERSION}:
{
  "version": ${SUPERVISOR_ADVICE_VERSION},
  "diagnosis": "brief diagnosis",
  "failureClass": "tool_format|wrong_strategy|missing_context|verification_failure|goal_drift|provider_failure|unknown",
  "nextActions": ["action 1", "action 2"],
  "constraints": ["constraint"],
  "verification": ["how to verify"],
  "confidence": 0.0-1.0,
  "shouldContinue": true,
  "requiresUser": false
}
Do not execute tools or emit patches. Advice only.`

  return [
    {
      role: "system",
      content: isZh
        ? "你是编码 Agent 的 Supervisor 顾问。分析有限的证据并仅返回结构化 JSON 建议。"
        : "You are a Supervisor advisor for a coding agent. Analyze bounded evidence and return structured JSON advice only.",
    },
    {
      role: "user",
      content: `${schemaHint}\n\nEvidenceBundle:\n${JSON.stringify(evidence, null, 2)}`,
    },
  ]
}

/**
 * 将 SupervisorAdvice 格式化为 scratch 注入文本（含来源、时间、evidence hash）。
 */
export function formatSupervisorAdviceForScratch(
  advice: SupervisorAdvice,
  meta: SupervisorAdviceScratchMeta,
  locale?: PromptLocale,
): string {
  const isZh = (locale ?? getPromptLocale()) === "zh-CN"
  const lines: string[] = isZh
    ? [
        "[Supervisor 建议]",
        `来源: ${meta.source}`,
        `时间: ${meta.timestamp}`,
        `证据哈希: ${meta.evidenceHash}`,
        `失败类别: ${meta.failureClass}`,
        "",
        `诊断: ${advice.diagnosis}`,
        "",
        "建议的下一步操作:",
        ...advice.nextActions.map((a, i) => `${i + 1}. ${a}`),
        "",
        "执行前简要说明选择哪一步及理由。",
      ]
    : [
        "[SUPERVISOR ADVICE]",
        `source: ${meta.source}`,
        `timestamp: ${meta.timestamp}`,
        `evidence_hash: ${meta.evidenceHash}`,
        `failure_class: ${meta.failureClass}`,
        "",
        `Diagnosis: ${advice.diagnosis}`,
        "",
        "Suggested next actions:",
        ...advice.nextActions.map((a, i) => `${i + 1}. ${a}`),
        "",
        "Before executing, briefly state which next action you choose and why.",
      ]

  if (advice.constraints.length > 0) {
    lines.push("", isZh ? "限制条件:" : "Constraints:", ...advice.constraints.map(c => `- ${c}`))
  }
  if (advice.verification.length > 0) {
    lines.push("", isZh ? "验证:" : "Verification:", ...advice.verification.map(v => `- ${v}`))
  }
  if (advice.requiresUser) {
    lines.push("", isZh
      ? "注意: Supervisor 标记 requiresUser=true — 如遇阻塞请等待用户输入。"
      : "Note: Supervisor flagged requiresUser=true — pause for user if blocked.")
  }

  return lines.join("\n")
}

/**
 * 将 SupervisorAdvice 注入 ctx.scratch（带来源、时间戳与 evidence hash）。
 *
 * @returns 注入的完整文本
 */
export function injectAdviceToContext(input: InjectAdviceInput): string {
  const timestamp = input.timestamp ?? Date.now()
  const content = formatSupervisorAdviceForScratch(input.advice, {
    source: input.source,
    timestamp,
    evidenceHash: input.evidenceHash,
    failureClass: input.advice.failureClass,
  })
  input.ctx.scratch.append({ role: "user", content })
  return content
}

/**
 * 记录工具结果到 Supervisor 指导状态（用于 EvidenceBundle）。
 */
export function recordSupervisorToolEvidence(
  state: SupervisorGuidanceState,
  toolName: string,
  success: boolean,
  summary: string,
): void {
  state.recentTools.push({
    name: toolName,
    success,
    summary: summary.slice(0, 200),
  })
  if (state.recentTools.length > MAX_RECENT_TOOLS) {
    state.recentTools = state.recentTools.slice(-MAX_RECENT_TOOLS)
  }
}

/**
 * 记录失败签名到 Supervisor 指导状态。
 */
export function recordSupervisorFailureEvidence(
  state: SupervisorGuidanceState,
  signature: string,
  errorMessage?: string,
): void {
  const existing = state.recentFailures.find(f => f.signature === signature)
  if (existing) {
    existing.count += 1
    if (errorMessage) existing.lastError = errorMessage.slice(0, 200)
  } else {
    state.recentFailures.push({
      signature,
      count: 1,
      lastError: errorMessage?.slice(0, 200),
    })
  }
  if (state.recentFailures.length > MAX_RECENT_FAILURES) {
    state.recentFailures = state.recentFailures.slice(-MAX_RECENT_FAILURES)
  }
}

/**
 * 更新 failure signature 历史（请求成功后）。
 */
export function recordSupervisorRequestHistory(
  state: SupervisorGuidanceState,
  failureSignature: string,
  evidenceHash: string,
): void {
  const prev = state.failureSignatureHistory[failureSignature]
  state.failureSignatureHistory[failureSignature] = {
    count: (prev?.count ?? 0) + 1,
    lastEvidenceHash: evidenceHash,
  }
  if (!state.requestedEvidenceHashes.includes(evidenceHash)) {
    state.requestedEvidenceHashes.push(evidenceHash)
  }
}

/**
 * 从 Supervisor 流式响应收集完整文本。
 */
async function collectSupervisorStreamText(
  client: ChatClient,
  messages: ChatMessage[],
  target: ModelTarget,
  signal?: AbortSignal,
): Promise<{ text: string; reasoning: string; error?: string }> {
  let text = ""
  let reasoning = ""
  try {
    const stream = client.chatCompletionsStream(messages, {
      apiKey: target.apiKey ?? "",
      baseUrl: target.baseUrl,
      model: target.model,
      maxTokens: target.maxTokens ?? 800,
      temperature: target.temperature ?? 0.3,
      signal,
      keyless: target.keyless ?? !target.apiKey,
    })

    for await (const event of stream) {
      if (event.type === "text_delta") {
        text += event.delta
      } else if (event.type === "reasoning_delta") {
        reasoning += event.delta
      } else if (event.type === "error") {
        return { text, reasoning, error: event.message }
      }
    }
  } catch (err) {
    return {
      text,
      reasoning,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  return { text, reasoning }
}

/**
 * 请求 SupervisorAdvice：构建证据、选择候选、调用 Supervisor 客户端并解析结果。
 */
export async function requestSupervisorAdvice(
  input: RequestSupervisorAdviceInput,
): Promise<SupervisorAdviceResult> {
  const start = Date.now()
  const failureClass = input.trigger.failureClass ?? "unknown"
  const evidence = buildEvidenceBundle({
    ledger: input.ledger,
    failureClass,
    recentFailures: input.recentFailures ?? mapRecentFailures(input.state.recentFailures),
    recentTools: input.recentTools ?? input.state.recentTools,
    attemptedStrategies: input.attemptedStrategies,
    stopSignalReason: input.stopSignalReason ?? input.state.lastStopSignalReason,
  })
  const evidenceHash = hashEvidenceBundle(evidence)
  const failureSignature = input.failureSignature
    ?? input.trigger.reason
    ?? evidence.failureClass

  if (input.state.requestedEvidenceHashes.includes(evidenceHash)) {
    return {
      success: false,
      evidence,
      evidenceHash,
      failureSignature,
      error: "同 evidence hash 已请求过 Supervisor，跳过重复询问",
      degraded: true,
      latencyMs: Date.now() - start,
    }
  }

  const messages = buildSupervisorRequestMessages(evidence)
  const evidenceTokenEstimate = estimateTokens(messages)

  const selection = selectSupervisorCandidate({
    pool: input.pool,
    budget: input.budget,
    failureSignature,
    evidenceTokenEstimate,
    requiresStructuredJson: true,
    isTargetConfigured: (targetId) => input.resolveTarget(targetId) !== null,
    now: input.now,
  })

  if (!selection.candidate) {
    return {
      success: false,
      evidence,
      evidenceHash,
      failureSignature,
      error: selection.reason,
      degraded: true,
      checkpointHint: true,
      latencyMs: Date.now() - start,
    }
  }

  const target = input.resolveTarget(selection.candidate.target)
  if (!target) {
    return {
      success: false,
      evidence,
      evidenceHash,
      failureSignature,
      candidateId: selection.candidate.id,
      error: `target ${selection.candidate.target} 无法解析`,
      degraded: true,
      checkpointHint: true,
      latencyMs: Date.now() - start,
    }
  }

  const clientFactory = input.createClient ?? createClientForTarget
  const client = clientFactory(target)
  const { text, error: streamError } = await collectSupervisorStreamText(
    client,
    messages,
    target,
    input.signal,
  )

  const latencyMs = Date.now() - start

  if (streamError) {
    input.budget.recordRequest({
      targetId: target.id,
      failureSignature,
      costClass: selection.candidate.costClass,
      inputTokens: evidenceTokenEstimate,
      outputTokens: 0,
      at: input.now ?? Date.now(),
    })
    return {
      success: false,
      evidence,
      evidenceHash,
      failureSignature,
      candidateId: selection.candidate.id,
      selectionReason: selection.reason,
      error: streamError,
      degraded: true,
      checkpointHint: true,
      latencyMs,
    }
  }

  const parsed = parseSupervisorAdvice(text)
  if (!parsed.success || !parsed.advice) {
    input.budget.recordRequest({
      targetId: target.id,
      failureSignature,
      costClass: selection.candidate.costClass,
      inputTokens: evidenceTokenEstimate,
      outputTokens: estimateTokens([{ role: "assistant", content: text }]),
      at: input.now ?? Date.now(),
    })
    return {
      success: false,
      evidence,
      evidenceHash,
      failureSignature,
      candidateId: selection.candidate.id,
      selectionReason: selection.reason,
      error: parsed.errors?.join("; ") ?? "SupervisorAdvice 解析失败",
      degraded: true,
      checkpointHint: true,
      latencyMs,
    }
  }

  const outputTokens = estimateTokens([{ role: "assistant", content: text }])
  input.budget.recordRequest({
    targetId: target.id,
    failureSignature,
    costClass: selection.candidate.costClass,
    inputTokens: evidenceTokenEstimate,
    outputTokens,
    at: input.now ?? Date.now(),
  })
  recordSupervisorRequestHistory(input.state, failureSignature, evidenceHash)
  input.state.adviceInjectionCount += 1
  input.state.stagnantRoundsAfterAdvice = 0

  return {
    success: true,
    advice: parsed.advice,
    evidence,
    evidenceHash,
    failureSignature,
    candidateId: selection.candidate.id,
    selectionReason: selection.reason,
    latencyMs,
    requiresUser: parsed.advice.requiresUser ?? false,
  }
}

function mapRecentFailures(
  entries: Array<{ signature: string; count: number; lastError?: string }>,
): EvidenceFailureEntry[] {
  return entries.map(e => ({
    signature: e.signature,
    summary: e.lastError ?? `signature ${e.signature} (${e.count}x)`,
  }))
}

/**
 * 构建 shouldRequestSupervisor 上下文（从 Loop 运行时状态）。
 */
export function buildSupervisorTriggerContext(
  state: SupervisorGuidanceState,
  extras: Partial<SupervisorTriggerContext> = {},
): SupervisorTriggerContext {
  return {
    recentFailures: state.recentFailures,
    failureSignatureHistory: state.failureSignatureHistory,
    supervisorConfigured: extras.supervisorConfigured,
    ...extras,
  }
}

/** Supervisor 降级消息（不污染 Worker 对话） */
export function buildSupervisorDegradedMessage(result: SupervisorAdviceResult, locale?: PromptLocale): string {
  const isZh = (locale ?? getPromptLocale()) === "zh-CN"
  if (result.error?.includes("已请求过")) {
    return isZh ? "Supervisor: 跳过重复 evidence，继续当前策略" : "Supervisor: skipping duplicate evidence, continuing current strategy."
  }
  const detail = result.error ?? (isZh ? "Supervisor 不可用" : "Supervisor unavailable")
  return isZh
    ? `Supervisor 降级: ${detail.slice(0, 200)}`
    : `Supervisor degraded: ${detail.slice(0, 200)}`
}

/**
 * 评估触发并请求 Supervisor 指导（供 loop 调用）。
 * 成功时注入 scratch；失败时返回降级状态事件，不抛错。
 */
export async function evaluateAndRequestSupervisorAdvice(
  config: SupervisorGuidanceConfig,
  triggerCtx: SupervisorTriggerContext,
  ledger: TaskLedger,
): Promise<{
  triggered: boolean
  injected: boolean
  result?: SupervisorAdviceResult
  trigger?: SupervisorTriggerDecision
  degradedMessage?: string
}> {
  const trigger = shouldRequestSupervisor(triggerCtx)
  if (!trigger.shouldRequest) {
    return { triggered: false, injected: false }
  }

  const result = await requestSupervisorAdvice({
    trigger,
    ledger,
    pool: config.pool,
    budget: config.budget,
    state: config.state,
    resolveTarget: config.resolveTarget,
    createClient: config.createClient,
  })

  if (!result.success) {
    if (result.checkpointHint) {
      config.onCheckpointHint?.(result.error ?? "supervisor_unavailable")
    }
    return {
      triggered: true,
      injected: false,
      result,
      trigger,
      degradedMessage: buildSupervisorDegradedMessage(result),
    }
  }

  return {
    triggered: true,
    injected: true,
    result,
    trigger,
  }
}

/**
 * 评估、请求并注入 Supervisor 指导（loop 安全点调用）。
 *
 * @param config - Supervisor 指导配置
 * @param triggerCtx - 触发上下文
 * @param ledger - 任务账本快照
 * @param ctx - 上下文管理器（注入 scratch）
 */
export async function runSupervisorGuidanceAtSafePoint(
  config: SupervisorGuidanceConfig,
  triggerCtx: SupervisorTriggerContext,
  ledger: TaskLedger,
  ctx: ContextManager,
): Promise<{
  injected: boolean
  statusContent?: string
  statusMetadata?: Record<string, unknown>
  degradedMessage?: string
  result?: SupervisorAdviceResult
  trigger?: SupervisorTriggerDecision
}> {
  const evaluation = await evaluateAndRequestSupervisorAdvice(config, triggerCtx, ledger)

  if (!evaluation.triggered) {
    return { injected: false }
  }

  if (evaluation.injected && evaluation.result?.advice && evaluation.result.evidenceHash) {
    injectAdviceToContext({
      ctx,
      advice: evaluation.result.advice,
      evidenceHash: evaluation.result.evidenceHash,
      source: evaluation.result.candidateId ?? "supervisor",
    })
    return {
      injected: true,
      statusContent: "supervisor_advice_injected",
      statusMetadata: {
        candidateId: evaluation.result.candidateId,
        evidenceHash: evaluation.result.evidenceHash,
        failureClass: evaluation.result.advice.failureClass,
        triggerReason: evaluation.trigger?.reason,
        latencyMs: evaluation.result.latencyMs,
        requiresUser: evaluation.result.requiresUser,
      },
      result: evaluation.result,
      trigger: evaluation.trigger,
    }
  }

  return {
    injected: false,
    statusContent: "supervisor_degraded",
    statusMetadata: {
      triggerReason: evaluation.trigger?.reason,
      error: evaluation.result?.error,
      checkpointHint: evaluation.result?.checkpointHint ?? false,
    },
    degradedMessage: evaluation.degradedMessage,
    result: evaluation.result,
    trigger: evaluation.trigger,
  }
}
