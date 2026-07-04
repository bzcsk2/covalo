# Covalo `/loop` 失败恢复链路修复 + Slash 命令清理 + Goal 工具化开发 Spec（修订版）

> 适用仓库：`bzcsk2/covalo`  
> 目标分支建议：`fix/loop-recovery-goal-tools`  
> 文档用途：交给 coding agent 直接开发、测试、提交 PR。  
> 任务性质：TUI 路由、Bridge 驱动、WorkflowCoordinator 状态机、Slash command、Goal 工具系统的联合修复。

---

## 0. 背景结论

当前 `/loop` 模式的问题不是单点 bug，而是“失败/阻塞/恢复”路径没有形成闭环。

已核实的核心问题包括：

1. `packages/tui/src/bridge.tsx` 的 `driveWorkflow()` 捕获异常后只写 warning，不 `onPhaseChange('failed')`，也不 rethrow，导致 App 层 `.catch()` 不触发，`workflowLifecycle.status` 可能假停留在 `running`。
2. `packages/tui/src/App.tsx` 的 `start_workflow` 失败分支使用了新生成的 `wf-${Date.now()}`，不是当前真实 `workflowId`。
3. blocked 状态的恢复策略过窄，`resumeInterruptedWorkflow()` 只允许 `"Interrupted by user"`。
4. router 提示用户 “Reset or switch mode”，但没有 `/reset` 命令。
5. `bridge.tsx` 把 `WorkflowPhase` 通过 `as any` 写入 `OrchestrationStore.loop.phase`，但该字段真实类型是 `LoopPhase`，值域不一致。
6. `maxRounds: 9` 在 TUI 中硬编码，与 core 默认配置偶然一致。
7. `resume_workflow` 重入时静默 return，没有用户反馈。
8. `waiting_user` 在 core 状态机存在，但 TUI lifecycle 没有真正接上；router 里的 `waiting_user` lifecycle 分支当前不可达或语义不清。

同时，根据新的产品要求：

- Slash 菜单需要清理。
- `/goal` 系列命令全部从菜单和 slash command 体系中移除。
- `/workflow` 命令已经无用，直接删除。
- `/goal budget` 和 `/goal no-budget` 这两个功能整体不要了，不迁移为工具。
- Goal 相关能力改为工具，由 loop 模式下的 supervisor 根据用户自然语言指令调用。
- `/loop`、`/alone`、`/subagent` 这类直接模式切换命令保留。

---

## 1. 总目标

完成后应达到以下用户体验：

1. 用户输入 `/loop` 后进入 loop 模式。
2. 用户直接输入目标，启动 supervisor + worker loop。
3. 运行中如果用户输入“暂停目标 / 修改目标 / 继续目标 / 清除目标 / 查看目标状态”等自然语言指令，系统不再走 `/goal ...` slash command，而是作为 workflow instruction 交给 supervisor；supervisor 可调用 Goal 工具完成修改。
4. workflow 内部异常必须明确进入 `failed` lifecycle，而不是假 running。
5. workflow 被用户中断或 goal paused 后，用户输入普通文本可以恢复；不可恢复 blocked 状态必须给出明确 `/reset` 指引。
6. Slash 菜单中不再出现 `/goal` 和 `/workflow`。
7. `/goal budget`、`/goal no-budget` 不再作为命令、菜单项或工具能力存在。
8. 编排状态 store 不再写入非法 phase 值。
9. CI、typecheck、相关单测全部通过。

---

## 2. 非目标

本次不要做以下事情：

1. 不要重新设计整个 WorkflowCoordinator。
2. 不要引入新的 UI 大面板。
3. 不要保留 `/goal budget` / `/goal no-budget` 的兼容入口。
4. 不要新增预算管理工具。
5. 不要把所有 GoalStore 核心字段重构掉；可保留 core 里的 legacy `tokenBudget` 字段，除非删除它不会扩大改动面。
6. 不要让 ordinary user text 在 `waiting_user` 时偷偷变成 workflow instruction；等待用户回答时要有明确交互路径。

---

## 3. 变更范围

重点文件：

```text
packages/tui/src/bridge.tsx
packages/tui/src/App.tsx
packages/tui/src/workflow-mode-router.ts
packages/tui/src/commands.ts
packages/tui/src/CommandRegistry.ts
packages/tui/src/components/workflow/WorkflowStatusBar.tsx
packages/tui/src/store/orchestration-store.ts
packages/tui/src/i18n/strings.ts
packages/tui/src/i18n/en.ts
packages/tui/src/i18n/zh-CN.ts

packages/core/src/workflow-coordinator/coordinator.ts
packages/core/src/workflow-coordinator/types.ts
packages/core/src/index.ts
packages/core/src/resolve-effective-tools.ts
packages/core/src/config/adapter.ts
packages/core/src/config/defaults.ts
packages/core/src/config/templates/default-config.toml

packages/core/src/goal/store.ts
packages/core/src/goal/types.ts
packages/core/src/goal/tools.ts
packages/core/src/goal/index.ts

packages/core/__tests__/goal-tools.test.ts
packages/core/__tests__/resolve-effective-tools.test.ts
packages/core/__tests__/config-adapter.test.ts
packages/core/__tests__/workflow-coordinator.test.ts
packages/tui/__tests__/...                  # 根据现有测试结构添加
```

如果实际仓库测试路径不同，按现有测试组织方式放置。

### 最新仓库事实校准

当前仓库里 Goal 工具已经存在于 `packages/core/src/goal/tools.ts`，并导出：

- `get_goal`
- `update_goal`

不要新增 `packages/tools/src/goal.ts` 作为第二套工具实现。应在 core 现有 Goal 工具体系上扩展能力，并同步更新 `packages/core/src/goal/index.ts`、工具过滤策略与相关测试。

截至本 spec 修订时，最新源码仍保留以下旧行为，开发时按本文修复：

- `packages/tui/src/commands.ts` 仍解析 `/workflow` 和 `/goal` 系列命令。
- `packages/tui/src/CommandRegistry.ts` 仍展示 `/workflow` 和 `/goal` 系列命令。
- `packages/tui/src/workflow-mode-router.ts` 仍把 `waiting_user` 普通文本路由为 `workflow_instruction`，blocked 仍只恢复 `"Interrupted by user"`。
- `packages/tui/src/bridge.tsx` 的 `driveWorkflow()` 仍吞异常，且 `resumeInterruptedWorkflow()` / `startWorkflow()` 调用在统一 `try/catch` 之前。
- `packages/tui/src/bridge.tsx` 仍通过 `as any` 把 workflow phase 写进 `LoopPhase`。
- `packages/tui/src/App.tsx` 仍有 `maxRounds: 9`，`start_workflow` catch 仍使用 `wf-${Date.now()}`。
- `packages/core/src/goal/tools.ts` 的 `update_goal` 仍只支持 `status=complete|blocked`。
- `packages/core/src/resolve-effective-tools.ts` 的 supervisor loop phase 白名单仍没有暴露 `update_goal`。

---

## 4. 优先级

按以下顺序开发，避免“修好一个 bug 激活另一个 bug”。

### P0：必须先修

1. `driveWorkflow()` 异常上抛 + failed lifecycle。
2. `start_workflow` catch 使用真实 workflowId。
3. 新增 `/reset`。
4. blocked 恢复链路：新增通用 resume 方法，支持 user interrupted / goal paused / question rejected 等可恢复原因。
5. Goal slash command 移除 + Goal 工具化。
6. `/goal budget` / `/goal no-budget` 功能完全移除，不作为命令，也不作为工具。

### P1：同 PR 内建议完成

7. `WorkflowPhase` → `LoopPhase` 显式映射，移除 `as any`。
8. `maxRounds` 引用 coordinator config 或 `DEFAULT_WORKFLOW_CONFIG`。
9. `resume_workflow` 重入提示。
10. `waiting_user` lifecycle 正确接入或明确移除不可达状态。建议接入。

---

## 5. 详细设计

---

# 5.1 修复 `driveWorkflow()` 异常吞掉问题

## 当前问题

`bridge.tsx` 中 `driveWorkflow()` 的 catch 目前只做 warning：

```ts
catch (err) {
  commitBridge(prev => ({
    ...prev,
    warnings: [...prev.warnings, `Workflow error: ${(err as Error).message ?? String(err)}`].slice(-MAX_WARNINGS),
  }));
}
```

这会导致：

- App 层 `.catch()` 不触发。
- `workflowLifecycle.status` 可能停留在 `running`。
- 用户后续输入被 router 当成 `workflow_instruction`，塞进已经停止的 workflow。

## 目标行为

当 `workflowCoordinator.runWorkflow()` 抛出异常时：

1. Bridge 写 warning。
2. Bridge 通知 `onPhaseChange(..., 'failed', reason)`。
3. Bridge 抛出结构化错误，让 App 的 `.catch()` 触发。
4. App 使用真实 workflowId 更新 lifecycle 为 `failed`。
5. `workflowRunningRef.current` 在 finally 里恢复为 false。

同样适用于 `startWorkflow()` / `resumeBlockedWorkflow()` 这类 drive 前置步骤。当前代码中 `resumeInterruptedWorkflow()` 调用在 `try` 之前，恢复失败时会绕开统一 failed lifecycle；实现时必须把 start/resume 初始化也纳入同一个 `try/catch/finally`，或用同一错误处理 helper 包住。

## 建议实现

在 `bridge.tsx` 中新增错误类：

```ts
export class WorkflowDriveError extends Error {
  workflowId?: string

  constructor(message: string, options?: { workflowId?: string; cause?: unknown }) {
    super(message)
    this.name = 'WorkflowDriveError'
    this.workflowId = options?.workflowId
    if (options?.cause !== undefined) {
      ;(this as Error & { cause?: unknown }).cause = options.cause
    }
  }
}
```

在 `driveWorkflow()` catch 中：

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err)
  const failedWorkflowId = workflowCoordinator.getState()?.workflowId ?? workflowId

  commitBridge(prev => ({
    ...prev,
    warnings: [...prev.warnings, `Workflow error: ${message}`].slice(-MAX_WARNINGS),
  }))

  onPhaseChange?.('failed', workflowCoordinator.getState()?.iteration ?? 0, 'failed', message)

  throw new WorkflowDriveError(message, {
    workflowId: failedWorkflowId,
    cause: err,
  })
} finally {
  finalizeWorkflowTurn()
  setTUIState('idle')
  commitBridge(() => ({
    isLoading: false,
    permissionPrompt: null,
    reasoningActive: false,
  }))
}
```

注意：

- 不要只 `onPhaseChange('failed')` 而不 rethrow。
- 不要只 rethrow 而不 onPhaseChange。
- 如果 coordinator 已经通过 event 正常发出 `failed`，不会进入这个 catch；这里只处理抛异常路径。

---

# 5.2 修复 App 层 workflowId 错配

## 当前问题

`start_workflow` catch 中使用了错误 ID：

```ts
setWorkflowLifecycle({
  status: 'failed',
  workflowId: 'wf-' + Date.now(),
  reason: (err as Error).message,
})
```

## 目标行为

必须使用当前真实 workflowId：

- start workflow：使用 `const workflowId = sessionId`。
- resume workflow：使用 lifecycle 中已有 workflowId。
- 如果错误是 `WorkflowDriveError`，优先使用 `err.workflowId`。

## 建议实现

在 `App.tsx` 中引入：

```ts
import { createBridge, timelineFromMessages, type BridgeState, WorkflowDriveError } from './bridge.js'
```

或如果不想导出类，也可使用结构化 duck typing：

```ts
function getWorkflowIdFromError(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'workflowId' in err) {
    const id = (err as { workflowId?: unknown }).workflowId
    return typeof id === 'string' ? id : undefined
  }
  return undefined
}
```

`start_workflow` catch 改为：

```ts
}).catch((err: unknown) => {
  const reason = err instanceof Error ? err.message : String(err)
  const failedWorkflowId = getWorkflowIdFromError(err) ?? workflowId
  setWorkflowLifecycle({ status: 'failed', workflowId: failedWorkflowId, reason })
}).finally(() => {
  workflowRunningRef.current = false
})
```

`resume_workflow` catch 也使用相同逻辑：

```ts
}).catch((err: unknown) => {
  const reason = err instanceof Error ? err.message : String(err)
  const failedWorkflowId = getWorkflowIdFromError(err) ?? workflowId
  setWorkflowLifecycle({ status: 'failed', workflowId: failedWorkflowId, reason })
}).finally(() => {
  workflowRunningRef.current = false
})
```

---

# 5.3 新增 `/reset`，并修正 blocked 提示

## 当前问题

router 提示：

```text
Workflow is blocked. Reset or switch mode to continue.
```

但没有 `/reset` 命令。

## 目标行为

新增 `/reset` 命令，用于清理当前 loop workflow 状态。

## commands.ts 改动

`SlashCommand` 增加：

```ts
| { name: "reset" }
```

parser 增加：

```ts
if (trimmed === "/reset") return { name: "reset" }
```

## CommandRegistry / help / i18n 改动

`packages/tui/src/CommandRegistry.ts` 增加：

```ts
{ name: '/reset', descKey: 'cmdReset' }
```

`packages/tui/src/i18n/strings.ts` 增加：

```ts
cmdReset: string
workflowResetLoop: string
workflowReset: string
```

`en.ts` / `zh-CN.ts` 补对应文案。

`buildHelpText()` 中也要展示 `/reset`，并删除 `/workflow`、`/goal` 相关行。

## App.tsx 改动

在 command handler 中增加：

```ts
if (command?.name === 'reset') {
  workflowCoordinatorRef.current?.interrupt()
  workflowCoordinatorRef.current?.reset()
  dualRuntimeRef.current?.reset()

  workflowRunningRef.current = false

  if (workflowMode === 'loop') {
    setWorkflowLifecycle({ status: 'awaiting_goal' })
  } else {
    setWorkflowLifecycle({ status: 'idle' })
  }

  setWorkflowState(prev => ({
    ...prev,
    phase: 'idle',
    goal: '',
    iteration: 0,
    supervisorStatus: 'idle',
    workerStatus: 'idle',
  }))

  appendMessage({
    role: 'assistant' as const,
    content: workflowMode === 'loop'
      ? 'Workflow reset. Enter a new goal to start loop mode.'
      : 'Workflow state reset.',
  })
  return
}
```

## Router 文案调整

把 blocked reject 文案改为：

```ts
return {
  type: 'reject',
  reason: 'Workflow is blocked and cannot resume automatically. Use /reset to start a new loop.',
}
```

如果 blocked reason 可恢复，则不 reject，见下一节。

---

# 5.4 扩展 WorkflowCoordinator blocked 恢复能力

## 当前问题

`resumeInterruptedWorkflow()` 只允许：

```ts
currentPhase === "blocked" && blockedReason === "Interrupted by user"
```

这使很多 blocked 状态没有恢复通道。

## 目标行为

保留现有 `resumeInterruptedWorkflow()`，但新增更通用方法：

```ts
resumeBlockedWorkflow(instruction?: string): WorkflowLoopState
```

它支持可恢复 blocked reason：

- `"Interrupted by user"`
- `"Goal is paused"`
- `"User rejected question"`
- 可选：其他明确可恢复的人为中断原因。

不要自动恢复：

- `"Max rounds reached"`，除非同时增加 maxRounds 或新开 workflow。
- `"Goal is budget_limited"`，因为本次产品要求已经移除 budget/no-budget 功能。
- `"Goal is usage_limited"`，除非已有明确用量恢复机制。
- 模型/运行时配置错误，例如 `"No runtime configured"`，应失败而不是 blocked resume。
- supervisor/worker 结构性失败，需要重新启动或 `/reset`。

## 建议实现

在 `WorkflowCoordinator` 中新增：

```ts
private isResumableBlockedReason(reason?: string): boolean {
  return reason === "Interrupted by user"
    || reason === "Goal is paused"
    || reason === "User rejected question"
}
```

新增方法：

```ts
resumeBlockedWorkflow(instruction = ""): WorkflowLoopState {
  if (!this.state) {
    throw new Error("No workflow in progress")
  }

  if (this.state.currentPhase !== "blocked") {
    throw new Error(`Workflow is not blocked; current phase is ${this.state.currentPhase}`)
  }

  if (!this.isResumableBlockedReason(this.state.blockedReason)) {
    throw new Error(`Workflow cannot be resumed from blocked reason: ${this.state.blockedReason ?? "unknown"}`)
  }

  this.pendingEvents = []
  this.state.resumeInstruction = instruction.trim() || undefined
  this.state.blockedReason = undefined

  if (this.state.blockedReason === "Interrupted by user") {
    this.state.iteration = Math.max(0, this.state.iteration - 1)
  }

  const result = this.transition("supervisor_analyse")
  if (!result.success) {
    throw new Error(result.error)
  }

  return this.getState()!
}
```

注意：上面示例里在清空 `blockedReason` 前需要先保存原 reason，否则 interrupted 分支判断会失效。正确写法：

```ts
const reason = this.state.blockedReason
...
this.state.blockedReason = undefined

if (reason === "Interrupted by user") {
  this.state.iteration = Math.max(0, this.state.iteration - 1)
}
```

旧方法兼容：

```ts
resumeInterruptedWorkflow(instruction: string): WorkflowLoopState {
  if (this.state?.blockedReason !== "Interrupted by user") {
    throw new Error("Only a workflow interrupted by the user can be resumed")
  }
  return this.resumeBlockedWorkflow(instruction)
}
```

---

# 5.5 App/Router 的 blocked 恢复策略

## Router 目标行为

`workflow-mode-router.ts` 中：

```ts
case 'blocked':
  if (isResumableBlockedReason(lifecycle.reason)) {
    return { type: 'resume_workflow', instruction: input }
  }
  return { type: 'reject', reason: 'Workflow is blocked and cannot resume automatically. Use /reset to start a new loop.' }
```

TUI 侧也要有同样的 reason 判断函数，或者从 core 导出共享判断。

建议本地简单实现：

```ts
function isResumableBlockedReason(reason?: string): boolean {
  return reason === 'Interrupted by user'
    || reason === 'Goal is paused'
    || reason === 'User rejected question'
}
```

## App resume_workflow 目标行为

当前重入静默 return，应改为：

```ts
if (workflowRunningRef.current) {
  appendMessage({
    role: 'assistant' as const,
    content: t().workflowAlreadyRunning,
  })
  return
}
```

`bridge.resumeWorkflow()` 内部应调用 `resumeBlockedWorkflow()` 而不是 `resumeInterruptedWorkflow()`。

在 `bridge.tsx`：

```ts
if (resumeInstruction !== undefined) {
  workflowCoordinator.resumeBlockedWorkflow(resumeInstruction)
} else {
  ...
}
```

如果暂时保留旧方法名，则至少实现为兼容转发。

---

# 5.6 Slash 菜单和 command parser 清理

## 新要求

移除：

- `/goal`
- `/goal edit`
- `/goal pause`
- `/goal resume`
- `/goal clear`
- `/goal budget`
- `/goal no-budget`
- `/workflow`

保留：

- `/loop`
- `/alone`
- `/subagent`
- `/reset`
- 其他现有命令不受影响。

## commands.ts 改动

从 `SlashCommand` union 删除：

```ts
| { name: "workflow" }
| { name: "goal"; ... }
```

删除 parser 中：

```ts
if (trimmed === "/workflow" || trimmed.startsWith("/workflow")) {
  return { name: "workflow" }
}
```

删除 parser 中整个：

```ts
if (trimmed.startsWith("/goal")) { ... }
```

新增 `/reset` 见 5.3。

## App.tsx 改动

删除或停用：

```ts
if (command?.name === 'workflow') { ... }
```

删除整个 `/goal` command handler：

```ts
if (command?.name === 'goal') { ... }
```

特别注意：

- 不要保留 `/goal budget` / `/goal no-budget` 的隐藏分支。
- 不要让 `/goal xxx` 被误当成 objective；它应成为 unknown command 或普通 direct command rejected，取决于现有 parser 未识别 slash 的处理策略。
- slash autocomplete / help 菜单中必须移除 `/goal` 和 `/workflow`。

当前 App 的路由会根据 `command ? 'command' : 'text'` 判断输入类型。如果删除 parser 后 `parseSlashCommand("/goal") === null`，必须在进入 `routeWorkflowInput()` 前增加未知 slash command 拒绝逻辑，例如：

```ts
if (submitted.trim().startsWith("/") && !command) {
  appendMessage({ role: "assistant", content: `Unknown command: ${submitted.trim()}` })
  return
}
```

否则 `/goal ...` 会在 loop `awaiting_goal` / `failed` 状态下被误当成新目标。

## Help / autocomplete / i18n

搜索以下关键词并清理：

```text
/goal
goal budget
goal no-budget
/workflow
workflow menu
goalUsage
goalBudgetSet
goalBudgetRemoved
```

要求：

- Slash 菜单不显示 `/goal`。
- Slash 菜单不显示 `/workflow`。
- `CommandRegistry.ts` 不包含 `/goal`、`/goal edit`、`/goal pause`、`/goal resume`、`/goal clear`、`/goal budget`、`/goal no-budget`、`/workflow`。
- `CommandRegistry.ts` 包含 `/reset`。
- `/help` 中不显示 `/goal` 和 `/workflow`。
- `/help` 中显示 `/reset`。
- 如果 i18n 中仅这些命令使用的字符串不再引用，可以删除。
- 如果 Goal 工具仍使用部分字符串，不要误删工具需要的文案。

---

# 5.7 Goal 功能工具化

## 新产品语义

Goal 不再由用户直接 slash command 操作。  
Goal 相关动作变成工具，由 loop 模式下的 supervisor 根据用户自然语言指令调用。

示例：

用户在 loop 运行中输入：

```text
暂停这个目标，先不要继续执行
```

router 将其作为 `workflow_instruction` 放入 coordinator：

```ts
bridge.addWorkflowInstruction(...)
```

下一轮 supervisor 看到指令后，可调用 Goal 工具：

```json
{
  "action": "pause"
}
```

再由 coordinator 因 goal status 变为 paused 而进入 blocked。

用户之后输入：

```text
继续执行，目标不变
```

router 识别当前 blocked reason 是 `Goal is paused`，触发 `resume_workflow`，coordinator 回到 `supervisor_analyse`。

## 当前实现基础

当前实现已经有：

```text
packages/core/src/goal/tools.ts
packages/core/src/goal/index.ts
packages/core/__tests__/goal-tools.test.ts
```

现有工具：

- `get_goal`：读取当前 thread/workflow goal。
- `update_goal`：当前只允许 `status=complete|blocked`。

本次不要在 `packages/tools` 下另起一套 Goal 工具。应扩展 `packages/core/src/goal/tools.ts`，保留现有导出路径，避免破坏 core/TUI 已经注册和过滤工具的方式。

## 推荐工具形态

保留两个工具：

1. `get_goal`：只读，返回当前 goal 状态。
2. `update_goal`：写工具，承担 set/update/pause/resume/clear/complete/block。

不要新增名为 `goal` 的第三个工具，除非实现时发现注册系统必须按 action 分离。当前仓库已有 `update_goal` hard deny / allow 测试和策略，用扩展 `update_goal` 的方式改动最小。

## `get_goal`

`get_goal` 保持 read tier，但输出应统一为可解析 JSON：

无 goal：

```json
{
  "ok": true,
  "action": "status",
  "workflowId": "xxx",
  "goal": null,
  "message": "No goal set for this workflow."
}
```

有 goal：

```json
{
  "ok": true,
  "action": "status",
  "workflowId": "xxx",
  "goal": {
    "goalId": "xxx",
    "objective": "...",
    "status": "active",
    "tokensUsed": 0,
    "timeUsedSeconds": 0
  }
}
```

## `update_goal`

工具参数：

```ts
{
  action?: "set" | "update" | "pause" | "resume" | "clear" | "complete" | "block",
  objective?: string,
  instruction?: string,
  status?: "complete" | "blocked",
  reason?: string
}
```

字段语义：

- `action=set`：如果没有 goal，创建 goal；如果已有 goal，替换 goal。
- `action=update`：修改当前 goal objective，保留已有 `goalId`；如果 `GoalStore.updateGoal()` 已支持 objective，应优先使用它，不要手动读 JSON 后再 replace。
- `action=pause`：`goalStore.systemSetStatus(threadId, "paused")`。
- `action=resume`：`goalStore.systemSetStatus(threadId, "active")`。如果 coordinator 当前 blocked 且 reason 是 `Goal is paused`，同时调用 `resumeBlockedWorkflow(instruction)`。
- `action=clear`：`goalStore.clearGoal(threadId)`。若 workflow 正在运行，返回 warning：goal cleared; workflow should be reset or will stop on next continuation check。
- `action=complete`：使用 `goalStore.updateGoal(threadId, { status: "complete", expectedGoalId })`。
- `action=block`：使用 `goalStore.updateGoal(threadId, { status: "blocked", expectedGoalId })`。
- 兼容旧参数：如果没有 `action` 但传入 `status=complete|blocked`，等价于 `action=complete|block`。这可以降低现有测试和 prompt 的迁移风险。

不要包含：

```ts
"budget"
"no_budget"
"set_budget"
"remove_budget"
```

## 工具权限

- `get_goal`：read tier。
- `update_goal`：write tier。

## 工具上下文

工具必须使用当前 workflow/session 的 threadId：

优先级：

1. workflowCoordinator.getState()?.workflowId
2. engine.getSessionId()
3. tool context 中已有 session/thread id

不要从 cwd、环境变量或随机 UUID 推导 threadId。

现有 `GoalToolProvider` 只有：

```ts
getGoalStore(): GoalStore
getThreadId(): string
```

为支持 `action=resume` 恢复 paused workflow，建议扩展为可选能力：

```ts
getWorkflowCoordinator?(): WorkflowCoordinator | undefined
```

`update_goal` 内部只有在 provider 提供 coordinator 且当前 state 是 `blocked` / `Goal is paused` 时才调用 `resumeBlockedWorkflow()`；否则只恢复 goal status。

## 工具输出

所有 action 返回 JSON 字符串，便于 supervisor 读取：

```json
{
  "ok": true,
  "action": "pause",
  "workflowId": "xxx",
  "goal": {
    "objective": "...",
    "status": "paused"
  },
  "message": "Goal paused."
}
```

失败：

```json
{
  "ok": false,
  "action": "resume",
  "error": "No active goal for current workflow."
}
```

## 工具注册

需要确认当前工具注册机制。目标是：

- loop 模式 supervisor 可调用 `get_goal` 和需要的 `update_goal`。
- worker 不应默认负责 goal 管理，除非架构已有共享工具池且无法按 role 区分。
- 如果无法按 role 限制，工具 description 必须强调：仅 supervisor 应调用写工具管理 loop goal。

当前仓库的关键过滤点是：

```text
packages/core/src/resolve-effective-tools.ts
packages/core/src/config/adapter.ts
packages/core/src/config/defaults.ts
packages/core/src/config/templates/default-config.toml
```

需要同步修改：

- `resolve-effective-tools.ts` 的 supervisor loop phase 白名单。`update_goal` 至少应在 `supervisor_analyse` 可用，因为运行中用户自然语言指令会注入下一次 analyse prompt；建议在 `supervisor_check` 也可用，便于显式 complete/block。
- worker loop 仍不得使用 goal 写工具。若保留工具名 `update_goal`，当前 worker hard deny 可以继续覆盖；若新增其他 goal 写工具名，必须加入 worker hard deny 和 `LOOP_ORCHESTRATION_TOOLS`。
- 默认配置不要把 supervisor loop 的 goal 写工具 deny 掉。

工具 description 示例：

```text
Update the current loop workflow goal. Use this only as the supervisor in loop mode when the user asks to set, update, pause, resume, clear, complete, or block the goal. Do not use this tool for token budgets; budget management is intentionally unsupported.
```

---

# 5.8 移除 `/goal budget` 和 `/goal no-budget`

## 要求

这两个功能整个不要：

- 不在 slash menu。
- 不在 parser。
- 不在 App command handler。
- 不在 Goal 工具。
- 不在 help 文案。
- 不在测试中作为用户入口。
- 不新增替代工具。

## Core 兼容策略

`GoalStore` 里的 `tokenBudget` 字段和 `budget_limited` 状态可以暂时保留，避免扩大破坏面。  
但新 UI/工具不再暴露它们。

`WorkflowCoordinator` 对 `Goal is budget_limited` 的处理建议：

- 视为不可自动恢复 blocked reason。
- 用户看到提示后使用 `/reset` 开新 loop。
- 不再提示 `/goal budget`。

---

# 5.9 Orchestration phase 映射修复

## 当前问题

`bridge.tsx` 中：

```ts
from: (orchestrationStore.getSnapshot().loop.phase as any) ?? 'observe',
to: wfEvent.phase as any,
```

这会把 `supervisor_analyse` 等非法值写入 `LoopPhase`。

## 目标行为

增加显式映射函数，移除 `as any`。

建议放在 `bridge.tsx` 或单独 util：

```ts
type TuiLoopPhase = 'observe' | 'plan' | 'act' | 'verify' | 'reflect' | 'retry' | 'paused' | 'done' | 'failed'

function workflowPhaseToLoopPhase(phase: string): TuiLoopPhase {
  switch (phase) {
    case 'idle':
      return 'observe'
    case 'supervisor_analyse':
      return 'plan'
    case 'worker_do':
      return 'act'
    case 'worker_report':
      return 'verify'
    case 'supervisor_check':
      return 'reflect'
    case 'supervisor_intervene':
      return 'retry'
    case 'waiting_user':
    case 'blocked':
      return 'paused'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    default:
      return 'observe'
  }
}
```

使用：

```ts
const from = orchestrationStore.getSnapshot().loop.phase
const to = workflowPhaseToLoopPhase(wfEvent.phase)

orchestrationStore.apply({
  kind: 'loop_transition',
  transition: {
    from,
    to,
    attempt: wfEvent.iteration,
    timestamp: Date.now(),
  },
})
```

`LoopPhase` 类型最好从 `orchestration-store.ts` 或 core type 统一导入，不要复制多个不一致 union。

---

# 5.10 `maxRounds` 去硬编码

## 当前问题

TUI 两处 `maxRounds: 9` 硬编码。

## 目标行为

优先使用 coordinator config：

```ts
const workflowMaxRounds =
  workflowCoordinatorRef.current?.getConfig().maxRounds
  ?? DEFAULT_WORKFLOW_CONFIG.maxRounds
```

App 顶部从 core 导入：

```ts
import { DEFAULT_WORKFLOW_CONFIG } from '@covalo/core'
```

替换：

```ts
maxRounds: 9
```

为：

```ts
maxRounds: workflowMaxRounds
```

注意：

- 初始 state 可以用 `DEFAULT_WORKFLOW_CONFIG.maxRounds`。
- 启动 workflow 时应使用当前 coordinator config。

---

# 5.11 `waiting_user` lifecycle 处理

## 当前问题

Core 有 `waiting_user` phase，但 TUI lifecycle 没有真正进入 `waiting_user`。

## 目标行为

当 workflow 进入 waiting_user 时：

1. lifecycle 设置为 `waiting_user`。
2. question prompt 显示。
3. 普通输入不要被当成 workflow_instruction 偷偷塞入队列。
4. 用户应通过 question prompt 回答；如未来要支持主输入框回答，必须显式路由到 `replyWorkflowQuestion()`。

## bridge.tsx / App.tsx

推荐在 App 的 phase handler 中处理：

```ts
if (phase === 'waiting_user') {
  setWorkflowLifecycle({ status: 'waiting_user', workflowId })
  return
}
```

如果后续收到普通 phase_change 恢复到 `supervisor_analyse` / `worker_do` 等，则再设回 running：

```ts
if (!finalStatus && workflowLifecycleRef.current.status === 'waiting_user') {
  setWorkflowLifecycle({ status: 'running', workflowId })
}
```

## router

`waiting_user` 不应继续返回 `workflow_instruction`。改为：

```ts
case 'waiting_user':
  return {
    type: 'reject',
    reason: 'Workflow is waiting for your answer in the prompt.',
  }
```

除非本次同时实现主输入框回答 questionPrompt，否则不要把 waiting_user 输入塞给 workflow instruction。

## WorkflowStatusBar 类型

`packages/tui/src/components/workflow/WorkflowStatusBar.tsx` 的 `WorkflowPhase` 需要补齐：

```ts
| 'supervisor_intervene'
| 'waiting_user'
| 'completed'
| 'failed'
```

并补充 `phaseLabel()` 与 `PHASE_DISPLAY` 映射。

---

# 5.12 Goal 工具与 loop instruction 的关系

运行中用户输入普通文本时：

```ts
case 'running':
  return { type: 'workflow_instruction', content: input }
```

保留该逻辑。

这意味着：

用户说“把目标改成先修测试，不要动 UI”，App 不直接改 goal，而是：

1. `bridge.addWorkflowInstruction(...)`
2. coordinator 在下一次 `supervisor_analyse` prompt 中注入 `resumeInstruction`
3. supervisor 判断是否需要调用 `goal` 工具
4. supervisor 调用 `update_goal`
5. workflow 继续

如果当前已经 blocked 且 reason 可恢复，则普通文本不再只是 instruction，而是 resume signal：

```ts
case 'blocked':
  if (isResumableBlockedReason(lifecycle.reason)) {
    return { type: 'resume_workflow', instruction: input }
  }
```

---

## 6. 测试要求

### 6.1 commands parser 测试

新增或更新测试：

```text
parseSlashCommand("/workflow") === null
parseSlashCommand("/goal") === null
parseSlashCommand("/goal budget 1000") === null
parseSlashCommand("/goal no-budget") === null
parseSlashCommand("/reset") -> { name: "reset" }
parseSlashCommand("/loop") 仍正常
parseSlashCommand("/alone") 仍正常
parseSlashCommand("/subagent") 仍正常
```

如果当前系统对未知 slash command 不是 `null`，按现有约定断言，但必须确保它不会进入 goal/workflow command handler。

同时增加 App 或纯 helper 测试，确保未知 slash command 不会在 loop 模式被当成 goal/text：

```text
loop + awaiting_goal + "/goal fix tests" -> unknown command reject，不启动 workflow
loop + failed + "/workflow" -> unknown command reject，不启动 workflow
```

### 6.2 slash menu / help 测试

如果有 autocomplete/help snapshot：

- 不包含 `/goal`
- 不包含 `/workflow`
- 包含 `/reset`
- 包含 `/loop`

### 6.3 router 测试

覆盖：

```ts
loop + awaiting_goal + text -> start_workflow
loop + running + text -> workflow_instruction
loop + waiting_user + text -> reject
loop + blocked(reason="Interrupted by user") + text -> resume_workflow
loop + blocked(reason="Goal is paused") + text -> resume_workflow
loop + blocked(reason="Goal is budget_limited") + text -> reject
loop + failed + text -> start_workflow
```

### 6.4 bridge 异常测试

构造 fake coordinator：

- `runWorkflow()` 抛出 `Error("No runtime configured")`
- 断言：
  - `bridge.runWorkflow(...)` rejects
  - `onPhaseChange` 被调用，lifecycle failed
  - warning 被写入
  - `isLoading` 最终 false

### 6.5 App workflowId 测试

如果 App 难测，可至少抽出 helper 测试：

```ts
getWorkflowIdFromError(new WorkflowDriveError("x", { workflowId: "session-1" })) === "session-1"
```

并静态检查 `start_workflow` catch 不再使用 `wf-${Date.now()}`。

### 6.6 WorkflowCoordinator resume 测试

更新现有测试：

```text
packages/core/__tests__/workflow-coordinator.test.ts
```

覆盖：

1. interrupted blocked 可恢复。
2. paused blocked 可恢复。
3. user rejected question 可恢复。
4. budget_limited blocked 不可恢复。
5. max rounds blocked 不可恢复，除非另有显式配置。
6. resume 后 phase 为 `supervisor_analyse`。
7. resume 后 `blockedReason` 清空。
8. resumeInstruction 正确注入。

### 6.7 Goal 工具测试

覆盖：

1. `get_goal` 无 goal，返回 JSON `{ ok: true, goal: null }`。
2. `get_goal` 有 goal，返回 JSON 且包含 `goalId/objective/status`。
3. `update_goal action=set` 创建或替换 goal。
4. `update_goal action=update` 更新 goal objective，并尽量保留 `goalId`。
5. `update_goal action=pause` 设置 status paused。
6. `update_goal action=resume` 设置 status active。
7. `update_goal action=resume` 在 coordinator blocked reason 为 `Goal is paused` 时调用 `resumeBlockedWorkflow(instruction)`。
8. `update_goal action=clear` 删除 goal。
9. `update_goal action=complete` 或兼容旧参数 `status=complete` 设置 status complete。
10. `update_goal action=block` 或兼容旧参数 `status=blocked` 设置 status blocked。
11. 参数 action 为 `budget`、`no-budget`、`set_budget` 或 `remove_budget` 时 schema 不允许或返回错误。
12. 工具输出 JSON 可解析。

测试位置使用当前已有的：

```text
packages/core/__tests__/goal-tools.test.ts
```

不要新增 `packages/tools/__tests__/goal.test.ts`。

### 6.7.1 Goal 工具可见性测试

更新：

```text
packages/core/__tests__/resolve-effective-tools.test.ts
packages/core/__tests__/config-adapter.test.ts
packages/core/__tests__/supervisor-request-contract.test.ts
```

覆盖：

1. supervisor loop `supervisor_analyse` 可见 `get_goal` 和 `update_goal`。
2. supervisor loop `supervisor_check` 可见 `get_goal`，并按设计可见 `update_goal`。
3. worker loop 不可见 `update_goal`。
4. 如果新增了其他 goal 写工具名，worker loop 同样不可见。
5. engineering hard-deny 仍对 supervisor loop 生效：`bash`、`edit_file`、`apply_patch`、`write_file`、`AgentTool` 不可见。

### 6.8 Orchestration phase 映射测试

覆盖：

```ts
supervisor_analyse -> plan
worker_do -> act
worker_report -> verify
supervisor_check -> reflect
supervisor_intervene -> retry
waiting_user -> paused
blocked -> paused
completed -> done
failed -> failed
```

### 6.9 Typecheck

必须通过：

```bash
bun run typecheck
```

### 6.10 Focused tests

建议至少运行：

```bash
bun test packages/tui packages/core --timeout 30000
```

如果项目已有更精确 test targets，优先使用现有 CI 同款命令。

---

## 7. 验收标准

PR 合并前必须满足：

1. `/goal` 不再出现在 slash 菜单、help、autocomplete 中。
2. `/workflow` 不再出现在 slash 菜单、help、autocomplete 中。
3. `/reset` 可用。
4. `/loop` 仍可进入 loop 模式。
5. `/alone`、`/subagent` 仍可切换模式。
6. `/goal budget` 和 `/goal no-budget` 不再是有效功能。
7. `get_goal` / `update_goal` 可被 supervisor 在 loop 模式下按 phase 策略调用。
8. Supervisor 可通过 Goal 工具完成 status/set/update/pause/resume/clear/complete/block。
9. budget/no-budget/set_budget/remove_budget 不作为 Goal 工具 action。
10. `driveWorkflow()` 内部异常会使 lifecycle 进入 `failed`。
11. failed 后用户再次输入普通文本可以启动新 workflow。
12. paused blocked 后用户普通文本可以触发 resume。
13. budget_limited blocked 不再提示 `/goal budget`，应提示 `/reset` 或不可恢复。
14. `start_workflow` catch 使用真实 workflowId。
15. `resume_workflow` 重入时有用户提示。
16. OrchestrationStore 的 loop phase 永远是合法 `LoopPhase`。
17. TUI `WorkflowState.maxRounds` 来自 coordinator config 或 core default。
18. `waiting_user` 不再把普通文本误当 workflow instruction。
19. `bun run typecheck` 通过。
20. 相关单测通过。

---

## 8. 建议 PR 描述

```md
## 概述

修复 `/loop` 模式失败/阻塞/恢复链路，并清理过时 slash command：

- 修复 `driveWorkflow()` 吞异常导致 lifecycle 假 running
- 修复 `start_workflow` failed 分支 workflowId 错配
- 新增 `/reset`
- 扩展 blocked workflow 的可恢复路径
- 移除 `/goal` 系列 slash command
- 移除 `/workflow`
- 移除 `/goal budget` / `/goal no-budget` 用户入口，不迁移为工具
- 扩展 core 现有 `get_goal` / `update_goal` 工具，由 supervisor 在 loop 模式下根据用户指令调用
- 修复 WorkflowPhase 写入 LoopPhase 的类型和值域错误
- 去除 TUI maxRounds 硬编码
- 修复 waiting_user lifecycle/路由语义

## 验证

- [ ] bun run typecheck
- [ ] bun test packages/tui packages/core --timeout 30000
- [ ] 手工验证 `/loop` 启动、失败、reset、goal pause/resume 工具链路
```

---

## 9. 给 coding agent 的执行提示词

你可以直接把下面这段交给 agent：

```text
你在 bzcsk2/covalo 仓库中实现本 spec。请按 P0 -> P1 顺序开发，不要扩大范围。

核心目标：
1. 修复 loop workflow 的失败/阻塞/恢复链路。
2. 清理 slash command：删除 /goal 系列和 /workflow，新增 /reset。
3. 删除 /goal budget 和 /goal no-budget 用户入口，不要把预算功能迁移为工具。
4. 将 goal 管理迁移为 supervisor 可调用的 core Goal 工具：保留 `get_goal`，扩展 `update_goal` 支持 set/update/pause/resume/clear/complete/block，不支持 budget/no-budget。
5. 修复 WorkflowPhase -> LoopPhase 的非法写入。
6. 去除 maxRounds: 9 硬编码。
7. 修复 waiting_user lifecycle/route 行为。

开发要求：
- 不要只改 UI 文案，必须补状态机闭环。
- driveWorkflow catch 必须 onPhaseChange failed 并 rethrow。
- start_workflow catch 必须使用真实 workflowId。
- paused blocked 可以 resume；budget_limited 不再通过预算命令恢复。
- /goal、/workflow 不得出现在 parser/help/autocomplete/menu 中。
- 添加必要单测，重点更新 core 的 goal-tools / resolve-effective-tools / supervisor-request-contract 测试，以及 TUI commands/router 测试。
- 最后运行 typecheck 和相关 tests，给出结果。
```
