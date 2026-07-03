# Covalo v0.1.3 上下文管理与内存安全实施方案 — 纠错、查证、补全版

审查日期：2026-07-03  
对象：`bzcsk2/covalo` 当前主分支代码  
来源：用户提供的《Covalo v0.1.3 — 上下文管理与内存安全审查报告 + 修复实施方案》  
结论：原方案方向有价值，但不能按原文直接交给 Agent 执行。需要删除误判项、降低部分问题优先级，并重写若干修复 spec。

---

## 0. 总体结论

原方案中真正值得优先修的是：

1. `loadSession()` 只清理 `log`，未清理 `scratch` / `summary` / 当前 submit 状态，存在跨 session 上下文残留风险。
2. `refreshLedgerContext()` 直接 `scratch.reset()`，会清掉 Supervisor 指导等非 TaskLedger scratch 内容。
3. 子引擎没有继承父引擎的 `contextPolicy`，导致 subagent 的压缩策略与父任务不一致。
4. `compact` 模式的“摘要生成”和“日志裁剪”语义没有统一，当前行为不一定是严重 bug，但设计不清晰，后续容易误修。
5. 大结果持久化的 cleanup 是 fire-and-forget，存在并发 cleanup 的一致性风险。

原方案中需要纠正的点：

1. **C2 的推荐修复不能采用**：`runSummarize()` 成功后再调用 `reduceToTarget("compress")` 会用确定性摘要覆盖 LLM 摘要，反而损害 compact 模式的设计价值。
2. **C3 的 marker 字符串过滤方案不可靠**：不能靠 `"TASK GOAL"` / `"ACTIVE PLAN"` 等文本判断来源，中文模式和文案变更都会误判。
3. **C5 的严重性被夸大**：当前 `toolSpecs` 通过 `loopOpts.toolSpecs` 独立传入，不依赖 `ImmutablePrefix.currentToolSpecs`。这是缓存状态一致性问题，不是“第二次 submit 工具定义丢失导致模型不能调用工具”的 P1 问题。
4. **C6 的根因错误**：shell 工具里的 `cd` 不会改变 Node 主进程的 `process.cwd()`。如果要修，应从“多 workspace / 启动目录不等于 workspaceRoot”的角度改，而不是说 shell `cd` 会污染 `process.cwd()`。
5. **C8 的性能风险被夸大**：500 / 200 条数组上 `shift()` 不是实际性能瓶颈。真正问题是“被淘汰历史没有摘要提示”。
6. **C11 应作为“恢复能力增强”而不是当前 bug**：现有 SessionLoader 本来只恢复消息，不恢复运行中任务状态；如果要做，需要扩展 checkpoint schema，而不是另建零散 `.ledger.json` 文件。

---

## 1. 修订后的优先级

| ID | 最终级别 | 结论 | 处理方式 |
|---|---:|---|---|
| C1 | 删除 | reasoning_content 不进入确定性摘要可以视为设计选择 | 不修 |
| C2 | P2 | compact 语义需要重构，但原修复方案错误 | 改为 `compactToTarget()` 设计 |
| C3 | P1 | `scratch.reset()` 会丢非 ledger scratch 内容 | 改成 source-aware scratch |
| C4 | P1 | `loadSession()` 未清 scratch/summary，属真实隔离问题 | 立即修 |
| C5 | P3 | prefix cache 状态不一致，但工具执行不依赖该字段 | 降级修或暂缓 |
| C6 | P3 | 根因描述错误；可做 workspaceRoot 显式化 | 低优先级 |
| C7 | P2 | cleanup 并发一致性风险成立 | 串行化 cleanup |
| C8 | P3 | `shift()` 性能风险夸大；可补淘汰计数 | 低优先级 |
| C9 | 删除 | aggressiveTruncate 已按完整 round 截断 | 不修 |
| C10 | P2 | 子引擎未继承 contextPolicy，属配置一致性问题 | 修 |
| C11 | P3 | 任务状态恢复是产品增强，不是当前恢复 bug | 进入 checkpoint schema 设计 |
| C12 | P3 | token 估算粗糙成立，但不是当前阻塞项 | 排期 |

---

## 2. 必须修改的实施方案

### SPEC-A：修复 session 切换时的上下文隔离问题

对应原 C4。  
级别：P1。  
文件：`packages/core/src/engine.ts`

当前 `loadSession()` 只执行：

```ts
this.sessionId = sessionId
this.ctx.log.clear()
this.toolExecutor.setSessionId(sessionId)
```

应补充清理：

```ts
this.ctx.log.clear()
this.ctx.scratch.reset()
this.ctx.getSummary().clear()

this.taskLedger = undefined
this.verificationGateState = { continuationCount: 0 }
this.supervisorGuidanceState = createSupervisorGuidanceState()
this.pendingInstructionQueue = []
```

建议完整修改点：

```ts
async loadSession(sessionId: string): Promise<ChatMessage[]> {
  if (this.isSubmitting) {
    throw new Error("Cannot switch sessions while submit is active")
  }
  if (!SessionLoader.validateSessionId(sessionId)) {
    throw new Error(`Invalid session ID: ${sessionId}`)
  }

  if (this.sessionId !== sessionId) {
    try {
      const { disposeBackgroundTaskManagerFor } = await import("@covalo/tools")
      disposeBackgroundTaskManagerFor(this.sessionId)
    } catch {}
  }

  this.sessionId = sessionId

  // session boundary: clear all context zones and submit-local state
  this.ctx.log.clear()
  this.ctx.scratch.reset()
  this.ctx.getSummary().clear()
  this.taskLedger = undefined
  this.verificationGateState = { continuationCount: 0 }
  this.supervisorGuidanceState = createSupervisorGuidanceState()
  this.pendingInstructionQueue = []

  this.toolExecutor.setSessionId(sessionId)
  this.logger = this.logger.child({ sessionId })
  this.rebindSessionWriter(sessionId)

  const sessionDir = resolve(process.cwd(), ".covalo", "sessions")
  this.checkpointEngine = new CheckpointEngine(sessionDir, sessionId)

  this.branchBudgetTracker.reset()
  this.modeDecisionEngine.resetSubmittedSignals()

  this.emitOrchestration?.({
    role: "orchestration",
    orchestration: { kind: "worker_remove", workerId: "*" },
  })

  return this._loadSessionMessages(sessionId)
}
```

测试要求：

1. session A 写入 summary 和 scratch 后切到 session B，`ctx.buildMessages()` 不得包含 A 的 summary / scratch。
2. session 切换后 `taskLedger`、`verificationGateState`、`supervisorGuidanceState` 不得沿用上一 session。
3. `SessionLoader.read()` 只恢复历史消息，不能把旧 scratch 重新带入。

---

### SPEC-B：修复 `refreshLedgerContext()` 清空 Supervisor 指导的问题

对应原 C3。  
级别：P1。  
文件：
- `packages/core/src/context/scratch.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/supervisor/guided-loop.ts`

原方案用内容 marker 判断 TaskLedger 消息：

```ts
const LEDGER_MARKERS = ["TASK GOAL", "ACTIVE PLAN", "COMPLETED STEPS", "BLOCKERS"]
```

这个方案不要采用。原因：

1. 中文 prompt 下 marker 不同。
2. 文案变更会破坏过滤。
3. Supervisor 指导内容也可能包含类似词。
4. 内容分类属于语义判断，不应出现在状态管理层。

推荐改成 source-aware scratch，不污染 `ChatMessage`，也不依赖消息文本。

修改 `VolatileScratch`：

```ts
type ScratchSource = "task_ledger" | "supervisor_advice" | "pending_instruction" | "runtime"

interface ScratchEntry {
  source: ScratchSource
  message: ChatMessage
}

export class VolatileScratch {
  private entries: ScratchEntry[] = []

  append(message: ChatMessage, source: ScratchSource = "runtime"): void {
    this.entries.push({ source, message: cloneChatMessage(message) })
  }

  replaceSource(source: ScratchSource, messages: ChatMessage[]): void {
    this.entries = this.entries.filter(e => e.source !== source)
    for (const message of messages) {
      this.entries.push({ source, message: cloneChatMessage(message) })
    }
  }

  removeSource(source: ScratchSource): void {
    this.entries = this.entries.filter(e => e.source !== source)
  }

  reset(): void {
    this.entries = []
  }

  get messages(): readonly ChatMessage[] {
    return cloneChatMessages(this.entries.map(e => e.message))
  }
}
```

修改 TaskLedger 注入：

```ts
private injectTaskLedgerContext(ledger: TaskLedgerTracker | undefined, includePlanRequest = false): void {
  if (!ledger) return

  const messages: ChatMessage[] = []
  if (includePlanRequest) {
    messages.push({ role: "user", content: planRequestInstruction() })
  }
  messages.push({ role: "user", content: ledger.formatForContext() })

  this.ctx.scratch.replaceSource("task_ledger", messages)
}
```

修改 `refreshLedgerContext`：

```ts
refreshLedgerContext: () => {
  this.injectTaskLedgerContext(this.taskLedger)
}
```

修改 Supervisor advice 注入：

```ts
input.ctx.scratch.append({ role: "user", content }, "supervisor_advice")
```

测试要求：

1. scratch 中同时存在 `task_ledger` 与 `supervisor_advice`，刷新 ledger 后 supervisor advice 必须保留。
2. ledger 刷新不得复制出多份 TaskLedger。
3. `startTurn()` 仍可清空整个 scratch，保持原有“每 submit 周期重建 scratch”的语义。
4. 中文模式下测试必须通过，不能依赖英文 marker。

---

### SPEC-C：子引擎继承父引擎 contextPolicy

对应原 C10。  
级别：P2。  
文件：`packages/core/src/engine.ts`

在 `spawnSubagent()` 中创建 child 后立刻继承父级 context policy：

```ts
const child = new ReasonixEngine(
  childConfig,
  undefined,
  undefined,
  childClient,
  this.logger.child({ delegate: true, subagentType: def.name }),
)

await child.setContextPolicy(this.getContextPolicy())

this.activeChildEngines.add(child)
```

注意事项：

1. `setContextPolicy()` 是 async，必须 `await`。
2. 这一步应放在 `child.submit()` 之前。
3. 如果未来 context policy 分为“全局持久配置”和“本轮临时配置”，应继承本轮 effective policy，而不是重新从 `ContextPolicyStore` 加载默认值。

测试要求：

1. 父引擎设置 `mode = "compact"` 后 spawn subagent，子引擎 `getContextPolicy().mode` 必须为 `"compact"`。
2. 父引擎设置自定义 `triggerRatio` / `targetRatio` 后，子引擎继承相同值。
3. 子引擎独立修改 context policy 不应反向污染父引擎。

---

## 3. 需要重写的实施方案

### SPEC-D：重写 compact 模式，不采用原 C2 的 `compress` 修复

对应原 C2。  
级别：P2。  
文件：
- `packages/core/src/context/manager.ts`
- `packages/core/src/engine.ts`

原方案建议：

```ts
if (success) {
  result = this.ctx.reduceToTarget("compress", this.contextPolicy.targetRatio)
}
```

不要采用。当前 `reduceToTarget("compress")` 会执行：

```ts
const summaryContent = this.createSummaryContent(removed)
this.summary.replace(summaryContent)
```

这会把 `runSummarize()` 刚生成的 LLM 摘要覆盖成确定性摘要。也就是说，原方案名义上修复“compact 双重截断”，实际会让 compact 退化成 deterministic compress。

正确修复方向：新增专门的 compact reduce 方法，让“选择被摘要的旧消息”和“裁剪 log”在同一个函数里完成。

推荐新增方法：

```ts
async compactToTarget(targetRatio: number, signal?: AbortSignal): Promise<ContextReductionResult> {
  const targetTokens = Math.max(1, Math.floor(this.contextWindow * targetRatio))
  const beforeTokens = estimateTokens(this.buildMessages())

  if (beforeTokens <= targetTokens) {
    return {
      mode: "compress",
      beforeTokens,
      afterTokens: beforeTokens,
      targetTokens,
      removedMessages: 0,
      summaryTokens: estimateTokens(this.summary.getMessages()),
    }
  }

  const originalLog = [...this.log.messages]
  const protectedStart = this.lastRoundStart(originalLog)
  const protectedTail = protectedStart >= 0 ? originalLog.slice(protectedStart) : []
  let current = protectedStart >= 0 ? originalLog.slice(0, protectedStart) : [...originalLog]
  const removed: ChatMessage[] = []

  const estimateWith = (candidate: ChatMessage[]) =>
    estimateTokens([
      ...this.prefix.messages,
      ...this.summary.getMessages(),
      ...candidate,
      ...protectedTail,
      ...this.scratch.messages,
    ])

  while (current.length > 0 && estimateWith(current) > targetTokens) {
    const end = this.firstRoundEnd(current)
    removed.push(...current.slice(0, end))
    current = current.slice(end)
  }

  if (removed.length > 0 && this.summarizer) {
    const result = await this.summarizer.summarize({
      messages: removed,
      currentSummary: this.summary.getRawContent(),
      targetTokens,
    }, signal)

    if (result.summary) {
      this.summary.replace(result.summary)
    } else {
      this.summary.replace(this.createSummaryContent(removed))
    }
  } else if (removed.length > 0) {
    this.summary.replace(this.createSummaryContent(removed))
  }

  // 摘要写入后如果仍超预算，只继续裁剪 log，不能再覆盖 summary。
  const estimateFinal = (candidate: ChatMessage[]) =>
    estimateTokens([
      ...this.prefix.messages,
      ...this.summary.getMessages(),
      ...candidate,
      ...protectedTail,
      ...this.scratch.messages,
    ])

  while (current.length > 0 && estimateFinal(current) > targetTokens) {
    const end = this.firstRoundEnd(current)
    current = current.slice(end)
  }

  this.log.replaceAll([...current, ...protectedTail])
  const afterTokens = estimateTokens(this.buildMessages())

  return {
    mode: "compress",
    beforeTokens,
    afterTokens,
    targetTokens,
    removedMessages: removed.length,
    summaryTokens: estimateTokens(this.summary.getMessages()),
  }
}
```

然后 `engine.ts` 中 compact 分支改为：

```ts
if (this.contextPolicy.mode === "compact") {
  result = await this.ctx.compactToTarget(
    this.contextPolicy.targetRatio,
    abortController.signal,
  )
  this.logger.info("context.reduction.compact", { ...result })
} else {
  result = this.ctx.reduceToTarget("trim", this.contextPolicy.targetRatio)
}
```

设计要点：

1. summarizer 只摘要即将移出 log 的旧消息，不摘要受保护的最近一轮。
2. LLM 摘要成功后不得再用 `createSummaryContent()` 覆盖。
3. 如果 LLM 摘要失败，才 fallback 到 deterministic summary。
4. 如果 summary 本身过大导致仍超预算，只继续裁剪 log；不要清空 summary，除非进入 fatal fallback。
5. 返回值需要保留 `removedMessages`、`summaryTokens`，便于回归测试。

测试要求：

1. mock summarizer 返回 `"LLM_SUMMARY"`，执行 compact 后 summary 必须包含 `"LLM_SUMMARY"`。
2. compact 后 `log` 不得包含已摘要的旧轮次。
3. 最近一轮 user round 必须保留。
4. summarizer 失败时应 fallback 到 deterministic summary，而不是直接 trim 丢弃。
5. 不得调用 `reduceToTarget("compress")` 作为 compact 成功路径。

---

### SPEC-E：修正 result-persistence 的 workspaceRoot 方案

对应原 C6。  
级别：P3。  
文件：
- `packages/core/src/result-persistence.ts`
- `packages/core/src/executor-helpers.ts`
- `packages/core/src/streaming-executor.ts`
- `packages/core/src/engine.ts`

原方案说：“shell 工具执行 `cd` 会导致 `process.cwd()` 变化”。这是错误根因。shell 工具运行在子进程内，子进程 `cd` 不会改变 Node 主进程的 `process.cwd()`。

但 `result-persistence.ts` 直接使用 `process.cwd()` 仍有设计问题：

1. 同一 Node 进程内多个 workspace 会共享 cwd。
2. 如果 CLI 从非项目根启动，结果目录会写到启动目录。
3. 该模块没有显式接收 workspaceRoot，不利于测试。

不要采用原方案的模块级 `cachedWorkspaceRoot`。模块级缓存会在多 workspace / 多 engine 场景中把第一个 workspace 固化，后续 engine 写错目录。

正确方案：给 `ResultPersistenceConfig` 增加 `baseDir`。

```ts
export interface ResultPersistenceConfig {
  maxResultSizeChars?: number
  previewChars?: number
  sessionQuotaBytes?: number
  maxFilesPerSession?: number
  baseDir?: string
}
```

在 `maybePersistResult()` 内：

```ts
const root = config?.baseDir ?? process.cwd()
const dir = join(root, ".covalo", "results", sanitizeId(sessionId))
```

在 `ReasonixEngine` 构造函数中：

```ts
const workspaceRoot = process.cwd()

const persistConfig: ResultPersistenceConfig = {
  sessionQuotaBytes: 50 * 1024 * 1024,
  maxResultSizeChars: 200_000,
  previewChars: 2_000,
  maxFilesPerSession: 200,
  baseDir: workspaceRoot,
}
```

后续如果 `DeepreefConfig` 增加 `workspaceRoot` 字段，应改为：

```ts
baseDir: config.workspaceRoot ?? process.cwd()
```

测试要求：

1. `baseDir` 设置为临时目录时，持久化结果必须写入该目录下 `.covalo/results`。
2. 多个 `maybePersistResult()` 调用传入不同 `baseDir` 时，不得互相污染。
3. 不要增加模块级全局 root 缓存。

---

### SPEC-F：串行化 result cleanup，但不阻塞主路径

对应原 C7。  
级别：P2。  
文件：`packages/core/src/result-persistence.ts`

原方案的问题：如果已有 cleanup 在运行，`await existing` 后直接 return，可能导致后续新文件没有被清理，依赖下一轮自然触发。

推荐方案：per-dir cleanup queue + dirty flag。

```ts
const cleanupState = new Map<string, { running: boolean; dirty: boolean }>()

function scheduleCleanup(
  dir: string,
  maxFiles: number,
  sessionId: string,
  logger: RuntimeLogger,
): void {
  const state = cleanupState.get(dir) ?? { running: false, dirty: false }
  state.dirty = true
  cleanupState.set(dir, state)

  if (state.running) return

  state.running = true

  void (async () => {
    try {
      while (state.dirty) {
        state.dirty = false
        await cleanupOldFiles(dir, maxFiles, sessionId, logger)
      }
    } catch (e) {
      if (logger.isEnabled("warn")) {
        logger.warn("tool.result.cleanup_schedule_error", {
          error: e instanceof Error ? e.message : String(e),
        })
      }
    } finally {
      state.running = false
      if (!state.dirty) cleanupState.delete(dir)
    }
  })()
}
```

替换原调用：

```ts
scheduleCleanup(dir, maxFiles, sessionId, logger)
```

测试要求：

1. 并发触发 10 次持久化，只应有一个 cleanup worker 运行。
2. cleanup 运行期间又新增文件，应通过 dirty flag 再跑一轮。
3. cleanup 失败不得影响工具结果返回。
4. 删除文件后 `sessionByteUsage` 不得变成负数。

---

## 4. 低优先级修正项

### SPEC-G：prefix.build 缓存一致性问题降级处理

对应原 C5。  
级别：P3。  
文件：`packages/core/src/engine.ts`

当前确实存在：

1. submit 前半段先 `this.ctx.prefix.build(systemPrompt)`。
2. 之后计算 `toolSpecs` 和 `cacheKey`。
3. 如果 `cacheKey` 命中，则不会再 `prefix.build(systemPrompt, toolSpecs)`。

但是这不等价于“工具定义从模型请求里丢失”，因为 `toolSpecs` 会通过 `LoopOptions.toolSpecs` 直接传入 loop。`ImmutablePrefix.messages` 本身也只返回 system message，不返回 tool specs。

建议不要作为 P1 修。可选修复：

```ts
const prefixSystemPromptKey = systemPrompt
if (this.ctx.prefix.messages.length === 0 || this.lastSystemPromptKey !== prefixSystemPromptKey) {
  this.ctx.prefix.build(systemPrompt)
  this.lastSystemPromptKey = prefixSystemPromptKey
}
```

更好的长期方案：

1. 明确 `ImmutablePrefix` 是否真的需要保存 `currentToolSpecs`。
2. 如果只是为了 cache fingerprint，应把 fingerprint 逻辑移动到 engine 层。
3. 如果用于 provider prefix-cache，则 token budget 也应考虑工具 schema 大小，否则 budget 估算仍不完整。

---

### SPEC-H：TaskLedger 淘汰计数，而不是环形缓冲重构

对应原 C8。  
级别：P3。  
文件：`packages/core/src/task-ledger.ts`

不建议把这项写成“性能修复”。数组上限 500 / 200，`shift()` 不是主要成本。

可接受的轻量增强：

```ts
private evictedFileCount = 0
private evictedCommandCount = 0
```

在淘汰时计数：

```ts
if (this.changedFiles.length >= MAX_CHANGED_FILES) {
  this.changedFiles.shift()
  this.evictedFileCount++
}
```

在 `formatLedgerForContext()` 输出：

```ts
if (ledger.evictedFileCount > 0) {
  parts.push(`EARLIER CHANGES: ${ledger.evictedFileCount} file changes omitted from this ledger view.`)
}
```

需要同步扩展 `TaskLedger` snapshot：

```ts
export interface TaskLedger {
  goal: string
  plan: PlanStep[]
  changedFiles: string[]
  commandsRun: CommandRunEntry[]
  verificationPending: boolean
  lastVerification?: LastVerification
  blockers: string[]
  evictedFileCount?: number
  evictedCommandCount?: number
}
```

---

### SPEC-I：Session 恢复 TaskLedger 应进入 checkpoint schema，而不是独立散落文件

对应原 C11。  
级别：P3 / 产品增强。  
文件：
- `packages/core/src/checkpoint/runtime-checkpoint.ts`
- `packages/core/src/checkpoint/checkpoint-engine.ts`
- `packages/core/src/loop.ts`
- `packages/core/src/engine.ts`

不要采用原方案中的独立 `.ledger.json` + `writeFileSync`。原因：

1. Covalo 已经有 checkpoint 系统。
2. 另建文件会产生 session messages、checkpoint、ledger 三套状态源。
3. 同步 IO 不适合放在 loop safe point。
4. `.ledger.json` 与 checkpoint 可能写入不一致，恢复时更难判断谁是权威。

推荐扩展 `RuntimeCheckpointV2`：

```ts
import type { TaskLedger } from "../task-ledger.js"
import type { VerificationGateState } from "../governance/verification-gate.js"

export interface RuntimeCheckpointV2 {
  runtimeVersion: typeof RUNTIME_CHECKPOINT_VERSION
  currentStepId?: string
  currentStepTitle?: string
  branchBudget: BranchBudgetSnapshot
  recentTools: ToolHistoryEntry[]
  recentFailures: FailureHistoryEntry[]
  verificationPending: boolean
  verificationGate?: VerificationGateState
  taskLedger?: TaskLedger
  recoverySignals: RecoverySignal[]
  lastTrigger: CheckpointSaveTrigger
  lastStopReason?: StopReason
  v2UpdatedAt: string
}
```

扩展 `CheckpointSaveInput`：

```ts
taskLedger?: TaskLedger
verificationGate?: VerificationGateState
```

在 loop 的 `saveCheckpoint()` 中传入：

```ts
await checkpointEngine.save({
  trigger,
  branchBudget: branchBudgetTracker,
  taskLedger: taskLedger?.snapshot(),
  verificationGate: verificationGateState ? { ...verificationGateState } : undefined,
  ...extras,
})
```

恢复策略：

1. `loadSession()` / `recover()` 只加载 checkpoint 到 pending runtime state，不直接创建 TaskLedger。
2. 下一次 `submit()` 如果用户输入是“继续 / resume / continue”或 checkpoint 标记存在未完成任务，再创建 `TaskLedgerTracker` 并 `applySnapshot()`。
3. 如果用户输入是全新任务，不应强行恢复旧 ledger，避免把旧任务污染新任务。

这是产品能力，不是当前 P1 bug。

---

### SPEC-J：token 估算改进保留为排期项

对应原 C12。  
级别：P3。  
文件：`packages/core/src/context/token-estimator.ts`

当前估算是：

```ts
const MSG_OVERHEAD = 10
const CHARS_PER_TOKEN = 4
```

可以做启发式改进，但不建议引入重量 tokenizer 依赖作为当前修复项。

轻量方案：

```ts
function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      cjk++
    } else {
      other++
    }
  }

  return Math.ceil(cjk / 1.5 + other / 4)
}
```

注意：这只是预算保护估算，不应对用户展示为真实 token 用量。

---

## 5. 删除项

以下内容不应进入实施任务：

1. **C1 作为 P0 修复项删除**：不把 `reasoning_content` 写入 summary 可以保护摘要区，避免推理内容污染长期上下文。
2. **C9 删除**：当前 `aggressiveTruncate()` 已按完整 round 移除旧消息，并有 `repairMessageStructure()` 兜底。
3. **C6 原根因删除**：shell `cd` 不会修改父进程 `process.cwd()`。
4. **C2 原修复删除**：不要在 LLM summarizer 成功后调用 `reduceToTarget("compress")`。
5. **C3 marker 过滤方案删除**：不要靠内容文本识别 scratch 来源。
6. **C11 `.ledger.json` 独立文件方案删除**：统一走 checkpoint schema。

---

## 6. 推荐实施顺序

### Phase 1：立即修复，低风险高收益

1. SPEC-A：`loadSession()` 清理 scratch / summary / 当前 submit 状态。
2. SPEC-B：source-aware scratch，修复 ledger 刷新清掉 Supervisor advice。
3. SPEC-C：子引擎继承 contextPolicy。

### Phase 2：需要设计但值得做

1. SPEC-D：重写 compact 模式。
2. SPEC-F：cleanup 串行化。
3. SPEC-E：result persistence 显式 baseDir。

### Phase 3：排期增强

1. SPEC-H：TaskLedger 淘汰计数。
2. SPEC-I：TaskLedger / VerificationGate checkpoint 恢复。
3. SPEC-J：token 估算启发式增强。
4. SPEC-G：prefix cache 一致性清理。

---

## 7. Agent 执行提示词建议

如果要交给 coding agent 执行，不要把原审计报告直接丢给它。建议使用下面的执行边界：

```text
你要修复 Covalo 上下文管理实施方案中的 Phase 1 项目，只执行以下三项：

1. 修复 engine.ts 的 loadSession session 隔离：
   - 切换 session 时清理 ctx.log、ctx.scratch、ctx.summary。
   - 同时重置 taskLedger、verificationGateState、supervisorGuidanceState、pendingInstructionQueue。
   - 不改变 SessionLoader 的历史消息读取行为。

2. 将 VolatileScratch 改为 source-aware：
   - scratch 内部保存 { source, message }。
   - append 支持 source 参数，默认 runtime。
   - 新增 replaceSource/removeSource。
   - TaskLedger 注入使用 source="task_ledger"。
   - Supervisor advice 注入使用 source="supervisor_advice"。
   - refreshLedgerContext 不得再 reset 整个 scratch，只能替换 task_ledger source。
   - 不要通过内容 marker 判断消息来源。

3. 修复 spawnSubagent 的 contextPolicy 继承：
   - child 创建后、submit 前，await child.setContextPolicy(this.getContextPolicy())。
   - 添加单元测试验证 compact/triggerRatio/targetRatio 被继承。

限制：
- 不要实现 C2 compact 重构。
- 不要修改 result-persistence。
- 不要修改 TaskLedger checkpoint 恢复。
- 不要引入新依赖。
- 不要把 ChatMessage.name 当作 scratch source。
- 所有新增测试必须覆盖中文和英文上下文注入至少一种非英文路径。
```

---

## 8. 最终判断

这份新实施方案的“问题发现”比上一份更贴近上下文管理子系统，但“修复 spec”质量不稳定。最危险的是 C2：如果按原文把 compact 成功路径改成 `reduceToTarget("compress")`，会覆盖 LLM 摘要，属于修坏。

建议先只执行 Phase 1。Phase 2 的 compact 重构需要单独做设计评审，因为它涉及摘要对象、日志裁剪、最近轮保护、预算估算四个状态的协同，不适合用 10 行补丁处理。
