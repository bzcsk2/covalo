# Covalo v0.1.3 TUI 层修复实施 SPEC

**目标项目**: `bzcsk2/covalo`  
**适用版本**: `0.1.3` / 当前 `main`  
**来源**: 基于 `covalo_tui_audit_20260705.md` 的复核后修订版  
**文档性质**: 面向 coding agent 的实施规格书，不是审计报告  
**执行原则**: 只修复已验证问题；不按原报告的 P0/P1 原样排期；避免为了“理论风险”引入更复杂、更脆弱的架构。

---

## 0. 给 coding agent 的总指令

你要在 `bzcsk2/covalo` 仓库中按照本文档修复 TUI 层及其必要的 Core 支撑逻辑。

执行时遵守以下规则：

1. **先读代码再改代码**。不要只按本文档机械替换，必须确认当前文件结构、类型定义、测试框架和命令仍然一致。
2. **优先修复高确定性问题**。本文档把问题分为 `S0 必修`、`S1 应修`、`S2 改善`、`S3 不建议修或仅注释澄清`。
3. **每个修复包独立提交**。不要把权限、配置、队列、渲染性能混在一个大 patch 中。
4. **所有修复必须有测试**。如果没有现成测试框架，就新增最小单元测试；不要只靠手测。
5. **保持行为兼容**。除非本文明确要求变更，不要改变已有 TUI 命令、UI 文案、workflow 模式和 eval 模式语义。
6. **不引入重型依赖**。项目已有 `zod`，配置校验优先用现有 schema；深比较/稳定 stringify 优先本地实现。
7. **最终必须通过**：

```bash
bun run typecheck
bun test packages/core packages/tui packages/security
```

如果某些测试在当前仓库本来就失败，必须在最终报告中列明：失败命令、失败测试、是否与本次修改相关。

---

## 1. 修复优先级总表

| 优先级 | 修复包 | 必须程度 | 主要文件 | 核心目标 |
|---|---|---:|---|---|
| S0-1 | 权限回复定向化 | 必修 | `packages/core/src/engine.ts`, `packages/tui/src/bridge.tsx`, permission/question 类型相关文件 | 禁止 Worker/Supervisor/Main 之间的 permission reply 广播误消费 |
| S0-2 | `/config set` 安全化 | 必修 | `packages/tui/src/App.tsx`, `packages/tui/src/commands.ts`, `packages/core/src/config/*` | 白名单、schema 校验、敏感配置保护 |
| S1-1 | submit 队列串行化 | 应修 | `packages/tui/src/bridge.tsx` | 消除 `running/processQueue/setTimeout` 顺序竞态 |
| S1-2 | workflow delta batching | 应修 | `packages/tui/src/bridge.tsx`, `packages/tui/src/delta-batcher.ts` | workflow 流式输出节流，避免高频 UI 刷新 |
| S1-3 | workflow tool item key 稳定化 | 应修 | `packages/tui/src/bridge.tsx` | 同一 workflow turn 内重复同名工具不覆盖 UI item |
| S2-1 | TranscriptStore 裁剪保持 turn 完整性 | 改善 | `packages/tui/src/store/transcript-store.ts`, `bridge.tsx` | 长会话裁剪不破坏 user/assistant/tool 的显示关系 |
| S2-2 | OrchestrationStore terminal worker 清理策略 | 改善 | `packages/tui/src/store/orchestration-store.ts` | 不再把 `elapsedMs` 当作新旧排序依据 |
| S2-3 | `commitBridge` / `processQueue` 去 updater 副作用 | 改善 | `packages/tui/src/bridge.tsx` | 减少对 React updater 求值时机的隐式依赖 |
| S2-4 | clone/deep-equal 防御性改进 | 改善 | `transcript-store.ts`, `timeline-adapter.ts` | 避免嵌套 args 引用污染和无意义重渲染 |
| S3-1 | session select mounted guard | 可选 | `packages/tui/src/App.tsx` | 异步 session load 完成后不触碰已卸载 runtime |
| S3-2 | workflow interrupt guard 注释/轻量防御 | 可选 | `bridge.tsx`, `workflow-coordinator` | 明确中断语义，不夸大为 P1 |
| S3-3 | eval 模式路由 | 不建议改 | `workflow-mode-router.ts` | 当前语义允许 `/talk worker/supervisor`，不应按原报告强行禁止 |

---

## 2. S0-1：权限回复定向化

### 2.1 当前问题

当前 TUI 的 `respondPermission()` 会同时向主 engine、Worker engine、Supervisor engine 广播同一个用户决策：

```ts
engine.respondPermission(allow, alwaysAllow);
dualRuntime?.getWorker().getEngine().respondPermission(allow, alwaysAllow);
dualRuntime?.getSupervisor().getEngine().respondPermission(allow, alwaysAllow);
```

Core 层 `ReasonixEngine.respondPermission()` 目前只看 `pendingPermission` 是否存在，不绑定 request id。也就是说，只要某个 engine 当前有 pending permission，就可能被错误 resolve。

这和 `respondQuestion()` 不同。Question 有 `requestId`，Core 会按 `requestId` 查 pending question；权限目前缺少这个绑定。

### 2.2 目标行为

用户看到哪个 permission prompt，就只回复那个 prompt 的来源 engine。

必须满足：

1. Worker 发起的权限请求，只能由 Worker engine 消费。
2. Supervisor 发起的权限请求，只能由 Supervisor engine 消费。
3. Main/legacy engine 发起的权限请求，只能由 main engine 消费。
4. `alwaysAllow` 只写入发起请求的 engine 的 permission rule，不得污染其他 role。
5. 并发 pending permission 时，回复 A 不得影响 B。
6. `cancel()` 可以继续作为全局中断/拒绝所有角色，但普通 `respondPermission()` 不得广播。

### 2.3 推荐设计

#### 2.3.1 Core 层引入 permission request id

在 `ReasonixEngine` 中把：

```ts
private pendingPermission: { resolve: (v: boolean) => void; toolName: string; args: Record<string, unknown> } | null = null
```

改成 request-id 化结构：

```ts
interface PendingPermissionEntry {
  id: string
  resolve: (v: boolean) => void
  toolName: string
  args: Record<string, unknown>
}

private pendingPermissions = new Map<string, PendingPermissionEntry>()
```

`requestPermission()` 必须生成稳定 id：

```ts
const id = `perm_${randomUUID()}`
this.pendingPermissions.set(id, { id, resolve, toolName, args })
```

同时，权限事件里必须包含此 id。查找当前代码中发出 `permission_ask` 的位置，确保 metadata 至少包含：

```ts
metadata: {
  requestId: id,
  sessionId: this.sessionId,
  permission: toolName,
  tool: { toolName, toolCallId },
  agentRole: role,
}
```

如果现有 `permission_ask` 事件已经有 `requestId`，则复用现有字段，但必须让它和 `pendingPermissions` 的 key 一致。

#### 2.3.2 Core 层新增按 id 回复方法

保留旧方法以兼容其他调用方，但新增明确接口：

```ts
respondPermissionForRequest(requestId: string, allow: boolean, alwaysAllow?: boolean): boolean
```

语义：

- 当前 engine 找到 `pendingPermissions.get(requestId)`：resolve 并返回 `true`
- 找不到：递归 child engines，任一 child 返回 `true` 则返回 `true`
- 全部找不到：返回 `false`
- 不得因为“存在任意 pending permission”就消费

旧的 `respondPermission(allow, alwaysAllow)` 可以保留为 legacy fallback，但 TUI 新代码不得再使用它处理普通 permission prompt。

#### 2.3.3 TUI Bridge 保存来源信息

扩展 TUI 层 permission prompt 的来源信息。不要只保存 `PermissionRequest`，至少要有：

```ts
type PermissionOriginRole = 'main' | 'worker' | 'supervisor'

interface TuiPermissionPrompt extends PermissionRequest {
  originRole: PermissionOriginRole
}
```

来源推断顺序：

1. 优先使用 `event.metadata.agentRole`
2. 如果 event 来自 `dualRuntime.sendDirect({ role })`，使用当前 `activeOutputRole`
3. fallback 为 `main`

`permission_ask` 分支必须把 `originRole` 写入 prompt。

#### 2.3.4 TUI respondPermission 改为定向

Bridge API 从：

```ts
respondPermission(reply: PermissionReply, message?: string): void
```

改成：

```ts
respondPermission(requestId: string, reply: PermissionReply, message?: string): void
```

或者：

```ts
respondPermission(prompt: Pick<TuiPermissionPrompt, 'id' | 'originRole'>, reply: PermissionReply, message?: string): void
```

推荐显式传 `requestId + originRole`，避免 closure 读旧 state：

```ts
respondPermission(requestId: string, originRole: PermissionOriginRole, reply: PermissionReply, message?: string)
```

定向逻辑：

```ts
switch (originRole) {
  case 'worker':
    dualRuntime?.getWorker().getEngine().respondPermissionForRequest(requestId, allow, alwaysAllow)
    break
  case 'supervisor':
    dualRuntime?.getSupervisor().getEngine().respondPermissionForRequest(requestId, allow, alwaysAllow)
    break
  case 'main':
  default:
    engine.respondPermissionForRequest(requestId, allow, alwaysAllow)
}
```

为了兼容无 requestId 的 legacy permission prompt，可以保留 fallback，但 fallback 必须极窄：

- 只有 `dualRuntime` 不存在时才调用 legacy `engine.respondPermission()`
- dualRuntime 存在但 prompt 无 id 时，应拒绝并显示错误，而不是广播

#### 2.3.5 更新 UI 调用点

检查并更新：

- `App.tsx` 中 `handlePermissionSelect`
- `DialogManager.tsx`
- 所有传递 `permissionPrompt` 的组件
- 相关类型导入

UI 组件必须能把 prompt id/originRole 带回 handler。

### 2.4 测试要求

新增或更新测试：

#### Core 单元测试

构造一个 `ReasonixEngine`，模拟两个 pending permission：

- `permA` 属于 worker
- `permB` 属于 supervisor

执行：

```ts
workerEngine.respondPermissionForRequest(permA, true, false)
```

断言：

- worker 的 `permA` 被 resolve
- supervisor 的 `permB` 仍 pending
- supervisor permission rule 未被修改

#### TUI Bridge 测试

构造 fake `dualRuntime`：

1. Worker 发出 permission_ask
2. Supervisor 同时存在 pending permission
3. TUI 回复 Worker prompt
4. 断言只调用 worker engine 的 `respondPermissionForRequest`

#### 回归测试

- 无 dualRuntime 的 legacy 单 engine permission 仍能工作
- `alwaysAllow` 只影响 origin engine
- `cancel()` 仍能中断所有角色

### 2.5 验收标准

- `bridge.tsx` 中普通 `respondPermission` 路径不再调用三个 engine 广播。
- Core 层 permission pending 不再是单个 nullable slot。
- 权限 prompt 带 request id 和 originRole。
- 测试覆盖 Worker/Supervisor 并发 pending 场景。
- `bun run typecheck` 通过。

---

## 3. S0-2：`/config set` 安全化

### 3.1 当前问题

当前 `/config <section>.<key> <value>` 逻辑只做简单类型推断，然后直接写入 config 对象并保存。它没有：

- 路径白名单
- schema 校验
- 敏感字段保护
- 不可变更新
- 深层路径解析约束

这会导致用户或模型诱导执行命令后，写坏配置、降低安全策略、打开 trace 泄露等。

注意：当前实现只按第一个 `.` 切分，不是任意深层写入器。因此原报告中“直接 `/config provider.apiKey` 替换 provider key”的例子不严谨。但安全风险仍成立，因为顶层 section 的直接字段足以改变工具安全策略。

### 3.2 目标行为

`/config set` 必须只允许少量安全配置项。敏感配置项不得直接 set，必须引导用户使用 `/config open` 手动编辑，或者后续专门设计二次确认 UI。

### 3.3 推荐实现

新增文件：

```text
packages/tui/src/config-command.ts
```

职责：

- 解析 config path
- 白名单校验
- value 类型转换
- zod/schema 校验
- 返回可保存的新 config

推荐接口：

```ts
export interface ConfigSetResult {
  ok: true
  config: CovaloConfig
  normalizedValue: unknown
} | {
  ok: false
  reason: string
  sensitive?: boolean
}

export function applySafeConfigSet(
  current: CovaloConfig,
  path: string,
  rawValue: string,
): ConfigSetResult
```

### 3.4 白名单

第一阶段只允许明显低风险项：

```ts
const WRITABLE_CONFIG_PATHS = {
  'tui.theme': z.string().min(1),
  'tui.showGoalPanel': z.boolean(),
  'tui.showAgentCommFeed': z.boolean(),
  'tui.showTokenUsage': z.boolean(),
  'tui.showToolEvents': z.boolean(),
  'tui.compactReasoning': z.boolean(),
  'tui.confirmBeforeReplacingGoal': z.boolean(),
  'tui.confirmDangerousToolPolicy': z.boolean(),

  'workflow.maxRounds': z.number().int().positive().max(200),
  'workflow.maxConsecutiveErrors': z.number().int().positive().max(20),
  'workflow.supervisorInterventionErrorThreshold': z.number().int().positive().max(20),
  'workflow.structuredProtocol': z.boolean(),
  'workflow.requireJsonDecisions': z.boolean(),
  'workflow.legacyTextFallback': z.boolean(),
  'workflow.askUserOnBlocked': z.boolean(),
  'workflow.autoResumeAfterAskUser': z.boolean(),

  'goal.autoContinue': z.boolean(),
  'goal.maxAutoContinuations': z.number().int().nonnegative().max(200),
  'goal.maxConsecutiveBlockedTurns': z.number().int().positive().max(20),
  'goal.maxConsecutiveTurnErrors': z.number().int().positive().max(20),
}
```

暂时不要开放：

```text
tools.approvalPolicy
tools.sandbox
tools.dangerousToolsEnabled
tools.strictMode
tools.runtimeGuard.reviewPolicy
tools.supervisor.*
tools.worker.*
providers.*
agents.*
logging.redactSecrets
trace.includePrompts
trace.includeToolArgs
trace.includeToolResults
trace.includeModelOutputs
mailbox.*
context.*
```

这些路径属于安全/隐私/模型行为敏感项。第一阶段直接拒绝：

```text
This config path is sensitive and cannot be changed from /config set. Use /config open and review the file manually.
```

### 3.5 value 解析规则

不要继续用 `!isNaN(Number(value))` 粗暴转换。实现明确解析：

```ts
function parseRawConfigValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  return raw
}
```

对每个白名单路径用对应 validator 校验。

### 3.6 保存前必须全量 schema 校验

应用改动后必须调用现有 `parseConfig(nextConfig)` 或 `CovaloConfigSchema.safeParse(nextConfig)`。

如果校验失败：

- 不保存
- 显示错误
- 原 config 不得被原地污染

### 3.7 禁止原地修改

不要再这样写：

```ts
(sectionValue as Record<string, unknown>)[key] = parsed;
configManager.update(config, 'tui');
```

必须 deep clone 当前 config：

```ts
const next = structuredClone(current)
```

Node 18 支持 `structuredClone`。如果要兼容测试环境，可以 fallback 到 JSON clone，但要说明配置对象只包含 JSON/TOML 可序列化字段。

### 3.8 `App.tsx` 集成

`App.tsx` 的 `/config` 分支保留 open/reload/show section 行为，只替换 set 分支：

```ts
const result = applySafeConfigSet(configManager.get(), command.path, command.value)

if (!result.ok) {
  appendMessage({ role: 'assistant', content: t().configError(result.reason) })
  return
}

configManager.update(result.config, 'tui')
await configManager.saveProjectConfig()
appendMessage({ role: 'assistant', content: t().configSet(command.path, String(result.normalizedValue)) })
```

如果 `ConfigManager.update()` 仍然 merge 旧 config，注意不要传完整 config 导致奇怪 merge。可以新增：

```ts
replace(config: CovaloConfig, source: 'tui' | 'cli'): void
```

或者在 manager 内部添加安全保存方法：

```ts
updateValidated(nextConfig: CovaloConfig, source: 'tui' | 'cli'): void
```

### 3.9 测试要求

新增测试文件，例如：

```text
packages/tui/src/__tests__/config-command.test.ts
```

测试：

1. 允许 `/config tui.showTokenUsage false`
2. 允许 `/config workflow.maxRounds 10`
3. 拒绝 `/config tools.sandbox danger-full-access`
4. 拒绝 `/config tools.approvalPolicy never`
5. 拒绝 `/config logging.redactSecrets false`
6. 拒绝未知路径
7. 拒绝类型错误，如 `/config workflow.maxRounds abc`
8. 拒绝范围错误，如 `/config workflow.maxRounds 100000`
9. 保存前 schema 校验失败时不污染原 config

### 3.10 验收标准

- `/config set` 不再能修改安全敏感字段。
- 所有允许修改项都有类型和范围约束。
- 保存前有全量 schema 校验。
- 不再原地 mutate `configManager.get()` 返回对象。
- 测试覆盖允许、拒绝、类型错误、schema 错误。

---

## 4. S1-1：submit 队列串行化

### 4.1 当前问题

`submitInternal()` 只用 `running` 判断是否有请求在执行。`processQueue()` 从 React state 中取出一个 message 后，用 `setTimeout(..., 0)` 延迟提交。

在 `running = false` 和 setTimeout 实际提交之间，新用户输入可能直接启动，插到队列项之前，造成输入顺序不确定。

原报告对“`beforeSubmit` 之前 running 未置 true”的解释是错的；当前代码是在 `beforeSubmit` 之前设置 `running = true`。但队列竞态本身仍成立。

### 4.2 目标行为

1. 同一 bridge 实例内，普通 submit 必须串行。
2. FIFO 顺序必须稳定。
3. 当前正在运行时的新输入，如果 core engine 接受 mid-session instruction，则走 `engine.enqueueInstruction()`；否则进入 bridge FIFO 队列。
4. 当 bridge 已经准备重放队列项时，新输入不得抢跑。
5. UI 中 `messageQueue` / `pendingInstructionCount` 只是状态展示，不应作为调度真实来源。

### 4.3 推荐设计

引入闭包级队列，不要依赖 React state 作为队列真源：

```ts
interface QueuedSubmit {
  text: string
  role?: AgentRole
  mode: WorkflowMode
  displayText?: string
  observeInput?: boolean
}

const submitQueue: QueuedSubmit[] = []
let running = false
let draining = false
```

所有 submit 入口统一：

```ts
async function submit(text, isQueueResubmit, role, mode) {
  return enqueueOrRun({ text, role, mode })
}
```

调度逻辑：

```ts
function enqueueOrRun(item: QueuedSubmit): Promise<void> {
  if (running || draining) {
    enqueue(item)
    return Promise.resolve()
  }
  return runExclusive(item)
}

async function runExclusive(item: QueuedSubmit): Promise<void> {
  if (running) {
    enqueue(item)
    return
  }

  running = true
  try {
    await submitInternalCore(item)
  } finally {
    running = false
    drainQueue()
  }
}

function drainQueue(): void {
  if (running || draining) return
  draining = true
  queueMicrotask(async () => {
    try {
      while (!running && submitQueue.length > 0) {
        const next = submitQueue.shift()!
        mirrorQueueState()
        await runExclusive(next)
      }
    } finally {
      draining = false
      if (!running && submitQueue.length > 0) drainQueue()
    }
  })
}
```

不要在 `setTimeout` 窗口里把 `processingQueue` 先置 false 再 submit。

### 4.4 与 engine.enqueueInstruction 的关系

当前代码在 `running` 时会先尝试：

```ts
const result = engine.enqueueInstruction(text)
```

这个语义可以保留，但要明确：

- `running === true` 且 `engine.enqueueInstruction()` 返回 `queued`：不进入 bridge queue。
- 返回 `full` 或 `idle`：进入 bridge FIFO queue。
- `draining === true` 时，不要调用 `engine.enqueueInstruction()` 抢跑，因为这时正在排队重放 UI 层消息。直接 append 到 bridge queue。

### 4.5 测试要求

新增 bridge scheduler 单元测试，或把调度逻辑抽成可测试 helper。

测试场景：

1. A 正在运行，B 输入，engine 接受 B 为 mid-session instruction。
2. A 正在运行，B 输入，engine queue full，B 进入 bridge queue。
3. A 完成后，B 已被安排 drain；在 drain submit 前输入 C，最终执行顺序必须是 B → C。
4. 快速连续输入 10 条，执行顺序稳定。
5. abort/cancel 后队列仍能继续处理或按预期清空。

### 4.6 验收标准

- 不再存在 `running=false` 后 `setTimeout` 让新输入抢跑的窗口。
- 队列真实状态不依赖 React updater 内变量赋值。
- 测试覆盖 drain 窗口插入新消息的顺序。

---

## 5. S1-2：workflow delta batching

### 5.1 当前问题

普通 direct submit 使用 `DeltaBatcher` 合并高频 `assistant_delta` / `reasoning_delta`。workflow 路径中，`driveWorkflow()` 对每个 delta 都直接写 store 或 setState，导致 workflow 模式下 UI 刷新过于频繁。

这不是资源泄漏问题，而是性能和 TUI 流畅度问题。

### 5.2 目标行为

workflow 路径与 direct submit 路径一致：

- delta 事件只更新内存累积变量
- UI 刷新通过 `DeltaBatcher.schedule()`
- assistant_final / reasoning final / phase_change / finally 中 `flushNow()`
- phase/turn 切换时 `cancel()` 或 `flushNow()`，避免旧 timer 写入新 turn

### 5.3 推荐实现

在 `driveWorkflow()` 内创建：

```ts
const workflowBatcher = new DeltaBatcher(resolveDeltaFlushMs(), flushWorkflowStreamingUI)
```

实现 `flushWorkflowStreamingUI()`：

```ts
const flushWorkflowStreamingUI = () => {
  if (!wfTurnId) return

  if (wfAssistantId && assistantText) {
    // transcriptStore: ensureTextPart + setTextPart/append? 
    // legacy: upsertWorkflowItem assistant_text isStreaming true
  }

  if (wfReasoningId && reasoningText) {
    // 同上
  }
}
```

处理规则：

- `assistant_delta`: append `assistantText`，ensure id，`workflowBatcher.schedule()`
- `reasoning_delta`: append `reasoningText`，ensure id，`workflowBatcher.schedule()`
- `assistant_final`: `workflowBatcher.flushNow()` 后写 final 状态
- `status === tools_completed`: `workflowBatcher.flushNow()` 后 finalize turn
- `phase_change`: `workflowBatcher.flushNow()` 后 finalize previous turn
- `finally`: `workflowBatcher.flushNow()`，再 finalize

注意：如果 `flushNow()` 的 `onFlush` 会写 `isStreaming: true`，那么 final 逻辑必须在 flush 之后覆盖 `isStreaming: false`。

### 5.4 测试要求

1. 模拟 100 个 workflow `assistant_delta`，断言 UI 写入次数明显少于 100。
2. `assistant_final` 后最终文本完整且 `isStreaming=false`。
3. phase 切换时不会把前一 turn 的 timer 写入后一 turn。
4. `DEEPCODE_DELTA_FLUSH_MS=0` 时仍立即刷新，便于测试。

### 5.5 验收标准

- workflow delta 不再每 chunk 触发 `publishTimeline()`。
- final 文本完整。
- turn/phase 切换无串写。

---

## 6. S1-3：workflow tool item key 稳定化

### 6.1 当前问题

direct submit 路径对工具 key 加了 `toolSequence`，避免同 index/同名工具覆盖。workflow 路径只使用：

```ts
const key = fallbackToolKey(loopEvent.toolCallIndex, loopEvent.toolName)
```

如果 provider 不提供 `toolCallIndex`，同一 workflow turn 内重复调用同名工具会复用同一 key，导致 UI item 被覆盖。

### 6.2 目标行为

同一 workflow turn 内，每个 `tool_start` 都生成唯一 key；后续 `tool_progress` / `tool` / `error` 能回到对应 key。

### 6.3 推荐实现

在 `driveWorkflow()` 的 turn 状态中加入：

```ts
let wfToolSequence = 0
let wfActiveToolKeys = new Map<number, string>()
let wfFallbackToolNameKeys = new Map<string, string[]>()
```

`startWorkflowTurn()` 重置这些状态。

`tool_start`：

```ts
const base = fallbackToolKey(loopEvent.toolCallIndex, loopEvent.toolName)
const key = `${base}_${++wfToolSequence}`

if (loopEvent.toolCallIndex !== undefined) {
  wfActiveToolKeys.set(loopEvent.toolCallIndex, key)
} else {
  const name = loopEvent.toolName ?? 'unknown'
  const list = wfFallbackToolNameKeys.get(name) ?? []
  list.push(key)
  wfFallbackToolNameKeys.set(name, list)
}
```

`tool_progress` / `tool`：

```ts
function resolveWorkflowToolKey(index?: number, name?: string): string {
  if (index !== undefined) {
    return wfActiveToolKeys.get(index) ?? fallbackToolKey(index, name)
  }

  const list = wfFallbackToolNameKeys.get(name ?? 'unknown')
  return list?.[list.length - 1] ?? fallbackToolKey(undefined, name)
}
```

如果无 index 且同名工具并发执行，无法完全准确区分 progress 属于哪一个。此时至少不要覆盖已完成工具：优先选择最近一个 `status === 'running'` 的同名 key。可以在 `upsertWorkflowTool()` 或辅助 map 中维护 status。

### 6.4 测试要求

1. 同一 workflow turn 内两个 `bash` tool_start 且无 `toolCallIndex`，最终 timeline 有两个 tool item。
2. 有 `toolCallIndex` 时 progress/final 能更新对应 item。
3. phase/turn 切换后 key map 清空，不串到下一 turn。

### 6.5 验收标准

- workflow 工具 UI 不再因同名工具重复调用而覆盖。
- direct submit 路径行为不变。

---

## 7. S2-1：TranscriptStore 裁剪保持 turn 完整性

### 7.1 当前问题

`TranscriptStore` 裁剪时：

- `assistant_text` / `reasoning` / `tool` 有 `roundId`，按 round 分组
- `message` 没有 `roundId`，按单条 entry 分组
- `message` 永远可裁剪

这会导致长会话中 user message 被单独删除，而其后的 assistant/tool round 仍保留，显示关系被破坏。

这不是“正在 streaming 条目会被删除”。真正 streaming/running 的条目已有保护。问题是历史 turn 结构不完整。

### 7.2 目标行为

裁剪必须按完整 turn/round 进行。一个 turn 的 user message、assistant text、reasoning、tool call、tool result 应作为整体裁剪或整体保留。

### 7.3 推荐设计

#### 方案 A：扩展 TimelineItem message 支持 roundId/turnId

把类型从：

```ts
| { id: string; kind: 'message'; message: ChatMessage; role?: AgentRole }
```

改成：

```ts
| { id: string; kind: 'message'; message: ChatMessage; role?: AgentRole; roundId?: string; turnId?: string }
```

写入 live user message 时使用当前 `roundId` 或新建 `turnId`：

```ts
const turnId = `turn-${requestId}-${crypto.randomUUID()}`
userItem.turnId = turnId
assistant/tool/reasoning 同 turnId
```

`getTrimGroupId()`：

```ts
if ('turnId' in entry && entry.turnId) return `turn:${entry.turnId}`
if ('roundId' in entry && entry.roundId) return `round:${entry.roundId}`
return `entry:${id}`
```

#### 方案 B：不改 TimelineItem 类型，维护内部 group map

在 `TranscriptStore` 内部维护：

```ts
private entryGroupIds = new Map<string, string>()
```

每次 append/upsert 时传入 groupId。此方案对外类型影响小，但调用点改动更多。

### 7.4 历史 session hydration

`timelineFromMessages()` 当前从 messages 恢复 timeline 时不能准确知道原始 turn 边界。可以采用保守分组：

- user message 开启新 group
- assistant message 归入最近 user group
- tool message 归入最近 assistant/user group
- 如果没有最近 group，则自成 group

不要追求完全还原历史，只要裁剪时不把相邻上下文拆得更碎。

### 7.5 测试要求

1. 构造超过 `maxEntries` 的多 turn transcript，裁剪后不出现“assistant 保留但对应 user 被裁掉”的情况。
2. running tool 所在 turn 不被裁剪。
3. streaming assistant 所在 turn 不被裁剪。
4. hydration 后仍能按近似 turn group 裁剪。

### 7.6 验收标准

- 裁剪单位不再是孤立 message。
- streaming/running 保护仍保留。
- 不显著增加内存占用。

---

## 8. S2-2：OrchestrationStore terminal worker 清理策略

### 8.1 当前问题

当前代码把 terminal workers 按 `elapsedMs` 降序排序，并注释称“newest first”。这是错误的。`elapsedMs` 是运行时长，不是创建时间或完成时间。

### 8.2 目标行为

超过 `MAX_TERMINAL_WORKERS` 时，删除最旧的 terminal worker，而不是运行时间最短/最长的 worker。

### 8.3 推荐实现

在 `OrchestrationStore` 内部维护元数据：

```ts
private workerSeenAt = new Map<string, number>()
private workerTerminalAt = new Map<string, number>()
```

在 `worker_upsert` 时：

```ts
if (!this.workerSeenAt.has(id)) this.workerSeenAt.set(id, Date.now())

if (isTerminal(worker.status) && !this.workerTerminalAt.has(id)) {
  this.workerTerminalAt.set(id, Date.now())
}
```

清理时按：

```ts
terminalAt ?? seenAt ?? 0
```

升序删除最旧。

在 `worker_remove` 和 `reset()` 时清理 map。

### 8.4 测试要求

1. 60 个 terminal worker，保留最后完成的 50 个。
2. 长耗时 worker 不因为 `elapsedMs` 大而被误认为“最新”。
3. `reset()` 后元数据清空。

### 8.5 验收标准

- 不再按 `elapsedMs` 判断新旧。
- 注释与实际逻辑一致。

---

## 9. S2-3：`commitBridge` / `processQueue` 去 updater 副作用

### 9.1 当前问题

`commitBridge()` 依赖 React `setState` updater 内部给外部变量 `patch` 赋值，然后在 updater 外执行 `bridgeRuntime.applyPatch(patch)`。`processQueue()` 也在 updater 内给 `nextMessage` 赋值。

这类写法脆弱，因为它依赖 React updater 的同步求值时机；在 StrictMode 或未来 React 行为变化下会变得难以推理。

### 9.2 目标行为

BridgeRuntime 路径不应通过 React updater 计算 patch。应有明确的 state snapshot 来源。

### 9.3 推荐低风险改法

短期可以不大改架构，但要做到：

1. `processQueue` 不再通过 React updater 抽取队列项，改用闭包级 queue。
2. `commitBridge` 在 split runtime 启用时，不再依赖 React state 作为唯一 prev 来源。

如果要继续保留 `commitBridge(updater)`，可以维护：

```ts
let bridgeStateSnapshot: BridgeState = initialBridgeState
```

每次 commit：

```ts
const patch = updater(bridgeStateSnapshot)
bridgeStateSnapshot = { ...bridgeStateSnapshot, ...patch }

if (bridgeRuntime && transcriptStore) {
  bridgeRuntime.applyPatch(patch)
  setState(prev => prev)
} else {
  setState(prev => ({ ...prev, ...patch }))
}
```

但要注意 legacy path 仍需以 React prev 为准，避免 snapshot 和 React state 分裂。更稳妥的是把 queue 修掉后，把 commitBridge 留到后续重构。

### 9.4 测试要求

- StrictMode 下不会重复 dequeue。
- bridgeRuntime split enabled 时，patch 只 apply 一次。
- legacy path 行为不变。

### 9.5 验收标准

- 队列调度不再依赖 updater 内赋值。
- `commitBridge` 相关注释说明 remaining risk 或已重构消除 risk。

---

## 10. S2-4：clone/deep-equal 防御性改进

### 10.1 `cloneTimelineItem` 深拷贝 args

当前：

```ts
args: { ...item.tool.args }
```

只能浅拷贝。

推荐：

```ts
function cloneJsonLike<T>(value: T): T {
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value)) as T
}
```

用于：

- `tool.args`
- `message` 中可能存在的嵌套字段，如 `tool_calls`、metadata 等

### 10.2 `timelineEntryEquals` 稳定比较 args

不要用裸 `JSON.stringify`。实现本地 stable stringify：

```ts
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
```

或实现 `deepEqualJsonLike(a, b)`。

### 10.3 测试要求

1. `{ a: 1, b: 2 }` 与 `{ b: 2, a: 1 }` 判等。
2. 嵌套数组/对象被正确比较。
3. clone 后修改嵌套 args 不污染 store 内部原对象。

---

## 11. S3-1：session select mounted guard

### 11.1 当前问题

`handleSessionSelect()` 在加载主 engine session 后检查 `mountedRef`，但 `dualRuntime.loadSupervisorSession(sessionId)` 以 fire-and-forget 方式执行，没有 mounted guard。

### 11.2 推荐修复

低风险写法：

```ts
if (dualRuntime) {
  void dualRuntime.loadSupervisorSession(sessionId).then(() => {
    if (!mountedRef.current) return
  }).catch(() => {})
}
```

如果后续需要在 load 完后 setState，必须放在 mounted guard 后。

也可以选择：

```ts
if (dualRuntime && mountedRef.current) {
  await dualRuntime.loadSupervisorSession(sessionId).catch(() => [])
  if (!mountedRef.current) return
}
```

但这会让 session 切换等待 supervisor load，可能影响交互速度。第一阶段建议保持 fire-and-forget，只加注释和 guard。

### 11.3 验收标准

- 卸载后异步 completion 不会 setState。
- 不改变 session picker UX。

---

## 12. S3-2：workflow interrupt guard

### 12.1 复核结论

原报告认为 `while (runAgain)` 缺少中断检查，会导致 Ctrl+C 后最多继续 50 轮。这个判断偏重。Core `WorkflowCoordinator.runWorkflow()` 在 abort 后会进入 `blocked: "Interrupted by user"`，而 TUI 的 continuation 条件只允许 `idle/supervisor_analyse` 继续。

### 12.2 可选防御

如果要加防御，优先新增只读方法：

```ts
isInterrupted(): boolean {
  return this.abortController?.signal.aborted ?? false
}
```

TUI 中：

```ts
while (runAgain && !workflowCoordinator.isInterrupted()) {
  ...
}
```

但这不是 P1 必修项。不要为此重构 workflow 状态机。

### 12.3 验收标准

- Ctrl+C 后 workflow 进入 blocked/interrupted 或 idle，不继续发起新 run。
- 不破坏 `resumeWorkflow()`。

---

## 13. S3-3：eval 模式路由不要按原报告修改

### 13.1 结论

`eval` 模式下普通文本路由到当前 activeRole 是当前产品语义的一部分。`/eval` 文案明确提示用户可以用 `/talk worker` 或 `/talk supervisor` 选择会话目标。

因此不要按原报告建议“eval 模式下非命令输入全部 reject”。

### 13.2 可做的低风险改进

只加注释或测试，明确当前语义：

```ts
case 'eval':
  // Eval mode still allows direct conversation with selected role.
  // Fixed eval execution is controlled by /eval-start and /eval-cancel.
  return { type: 'direct', role: activeRole, mode: 'alone' }
```

新增 router test，防止未来误改。

---

## 14. 不再作为修复项的问题

以下原报告条目不应作为当前修复任务：

### 14.1 “DeltaBatcher finally 外未清理导致 timer 泄漏”

普通 submit 路径 `flushNow()` 会 clear timer；`startRound()` 也会 cancel。没有充分证据证明这是实际泄漏。保留 workflow batching 性能修复即可。

### 14.2 “Workflow 中断后会继续 50 轮”

当前 Core 层 abort 会进入 blocked；TUI continuation 条件通常不会继续。可加轻量 guard，但不要作为高优先级 bug。

### 14.3 “eval 模式必须拒绝普通文本”

这是假设性产品要求，不是当前代码 bug。

---

## 15. 建议提交拆分

### Commit 1：permission request id + 定向回复

范围：

- Core permission pending map
- `respondPermissionForRequest`
- permission ask metadata
- TUI prompt originRole
- TUI handler 定向
- tests

提交信息建议：

```text
fix(tui): route permission replies to originating engine
```

### Commit 2：safe `/config set`

范围：

- 新增 `config-command.ts`
- App config set 分支替换
- config command tests

提交信息建议：

```text
fix(tui): validate and whitelist config set command
```

### Commit 3：submit scheduler FIFO

范围：

- bridge submit queue refactor
- queue tests

提交信息建议：

```text
fix(tui): serialize bridge submit queue
```

### Commit 4：workflow streaming batching + tool keys

范围：

- workflow DeltaBatcher
- workflow tool key sequence
- tests

提交信息建议：

```text
perf(tui): batch workflow streaming updates
fix(tui): keep workflow tool items unique
```

如果仓库要求一个 commit 一个主题，则拆成两个 commit。

### Commit 5：store cleanup improvements

范围：

- TranscriptStore group trim
- OrchestrationStore terminalAt
- stable deep compare / clone

提交信息建议：

```text
fix(tui): preserve transcript groups during trimming
fix(tui): prune terminal workers by terminal time
chore(tui): stabilize timeline arg comparison
```

---

## 16. 最终验收清单

交付前逐项检查：

### 安全

- [ ] Worker permission reply 不会触发 Supervisor pending permission
- [ ] Supervisor permission reply 不会触发 Worker pending permission
- [ ] `alwaysAllow` 只写入 origin engine
- [ ] `/config set tools.sandbox danger-full-access` 被拒绝
- [ ] `/config set tools.approvalPolicy never` 被拒绝
- [ ] `/config set logging.redactSecrets false` 被拒绝
- [ ] `/config set trace.includePrompts true` 被拒绝

### 正确性

- [ ] 快速连续 submit 不乱序
- [ ] queued message drain 时新输入不会抢跑
- [ ] workflow 中重复同名工具不会覆盖 UI item
- [ ] session 切换后 transcript/store/runtime 状态一致
- [ ] cancel 后 workflow 不继续自动开新 run

### 性能

- [ ] workflow `assistant_delta` 高频流式输出被 batch
- [ ] direct submit 流式输出行为不退化
- [ ] timeline adapter 不因 args key 顺序不同触发无意义重渲染

### 长会话

- [ ] TranscriptStore 裁剪不删除 running/streaming turn
- [ ] 裁剪后不出现明显孤立 assistant/tool 显示
- [ ] OrchestrationStore terminal worker 上限仍生效

### 命令

- [ ] `bun run typecheck`
- [ ] `bun test packages/core packages/tui packages/security`
- [ ] 如有 targeted tests，也必须通过

---

## 17. 给 agent 的最终执行提示词

可以把下面这段直接交给 coding agent：

```text
你现在修复 bzcsk2/covalo 的 TUI/Core 边界问题。请严格按 docs/covalo_tui_fix_implementation_spec_20260705.md 执行，不要按旧审计报告的 P0/P1 原样处理。

第一阶段只做 S0-1 和 S0-2：
1. 权限回复定向化：Core permission pending 必须 request-id 化；TUI permission prompt 必须记录 originRole；respondPermission 不得再广播给 main/worker/supervisor 三个 engine。
2. /config set 安全化：新增白名单、类型校验、schema 校验和敏感路径拒绝；禁止原地 mutate config。

每个阶段完成后运行：
bun run typecheck
bun test packages/core packages/tui packages/security

如果测试失败，先判断是否由本次修改引入。不要掩盖失败，不要删除测试来通过。最终输出包括：修改文件列表、关键设计说明、测试结果、未完成项。
```

---

## 18. 修订后的客观结论

原审计报告有真实发现，但严重度偏激。最终处理口径如下：

- **保留最高优先级**：权限广播，因为 Core 权限 pending 无 requestId，确实可能跨 engine 误消费。
- **保留高优先级但降级**：`/config set`，风险真实，但不是任意深层 provider apiKey 注入。
- **保留为正确性修复**：submit 队列竞态，原报告触发解释错误，但顺序风险成立。
- **保留为性能修复**：workflow delta batching。
- **保留为长会话/维护性改善**：TranscriptStore 裁剪、OrchestrationStore 清理、deep clone/deep equal。
- **不作为 bug 修复**：eval 模式普通文本路由。
- **不夸大**：workflow interrupt 50 轮问题和 DeltaBatcher timer 泄漏。
