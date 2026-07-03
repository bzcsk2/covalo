# Covalo 项目"代码存在但未接入"功能审查与修复方案

**审计日期**：2026-07-03
**再审核日期**：2026-07-03
**审计范围**：`packages/core/`、`packages/cli/`、`packages/tui/`、`packages/plugin/`、`packages/tools/`、`packages/memory/`、`packages/security/`
**审计方法**：代码静态分析 + Grep 调用链验证 + 实例化点核查
**审计目标**：找出所有"代码已实现、有测试覆盖，但未被运行时主路径调用"的功能模块，并给出详细修复方案

---

## 一、总体结论

文档的主判断**大体成立**：Covalo 当前确实存在一批"实现了、导出了、有测试或预留痕迹，但主运行路径没有闭环接入"的模块。文档列出的 14 项、其中 11 项给出修复方案，和当前代码状态基本对得上。

按性质重新分档（区别于单纯按严重度）：

### 1.1 真实高优先级问题（3 项，必须修闭环）

| 项 | 性质 |
|----|------|
| Two-stage tool routing 不闭环 | 真 bug，auto 默认策略被静默降级为 direct |
| WorkflowCoordinator ask_user 回复链不闭环 | 真 bug，supervisor 决策 ask_user 后无法真正回复 |
| Subagent 执行逻辑双实现，生产路径丢失 target 独立模型能力 | 真 bug，SubagentRunner 支持 target 解析，engine.spawnSubagent 共享父级 client |

### 1.2 可以清理但不紧急（6–8 项）

| 项 | 性质 |
|----|------|
| PermissionService 未接入 | 死代码，但删除属于 API 破坏，需 deprecate 或先确认无外部依赖 |
| DualSession / DualSessionStore | 被 DualAgentRuntime 替代，确认无外部 API 依赖后可删 |
| governance/task-state.ts | 与 task-ledger.ts 并行实现，可删或保留为实验函数 |
| Config adapter 部分函数 | 6 个函数无生产调用方，可删 |
| Pricing 未使用函数 | USD_TO_CNY / calculateCostCNY / getPricing 可删或保留 |
| Memory bridge lifecycle 方法 | 不建议直接删 onPreToolUse，更适合标记为未接入能力 |
| 若干散落死代码 | executeEccHookCommand / LspManager 等，逐个处理 |

### 1.3 不应简单判为 bug（4 项，属于产品策略或未完成路线）

| 项 | 性质 |
|----|------|
| Supervisor 候选池默认禁用 | 设计意图（ADV-HAR-04），用户显式配置 `.covalo/supervisor-pool.json` 启用 |
| Mailbox workflow 默认禁用 | 产品策略，启用会改变 coordinator 状态机行为 |
| GoalRuntime 未实例化 | 未完成路线，auto-continuation 需与 TUI idle 回调深度集成 |
| Sandbox 主路径未接入 | 产品安全策略，常规任务是否需要 sandbox 需评估性能影响 |

### 1.4 处理范围

本报告对以下 11 个项给出详细修复方案：

- 🔴 Two-stage tool routing 流程不闭环（重写方案）
- 🔴 WorkflowCoordinator QuestionService 回复链（重写方案）
- 🔴 SubagentRunner 重复实现 + engine.spawnSubagent target/client 缺失（先迁移后删除）
- 🟡 PermissionService 完全未接入（双路径：删除或 deprecate）
- 🟡 DualSession / DualSessionStore
- 🟢 governance/task-state.ts
- 🟢 Config adapter 未使用函数
- 🟢 Memory bridge lifecycle 方法（onPreToolUse 标记 experimental）
- 🟢 Pricing 未使用函数
- 🟢 其他死代码
- 🟢 Supervisor 候选池（文档化处理）

**搁置不处理（3 项）**：
- 🟡 GoalRuntime（未实例化）
- 🟡 Sandbox（主路径未接入）
- 🟡 Mailbox 自动化工作流（默认禁用）

---

## 二、逐项核验结果

| 文档项 | 是否存在 | 修复建议是否合理 | 再审核判断 |
|--------|:-------:|----------------|-----------|
| SubagentRunner 重复实现 | 存在 | 部分合理 | 应先合并 target/client 能力，再删 |
| Two-stage routing 不闭环 | 存在 | 方向对，但方案不完整 | 必须修，且要改类型和虚拟工具处理 |
| PermissionService 未接入 | 存在 | 可以删，但会破坏 core export | 可删或先 deprecate |
| DualSession / DualSessionStore | 存在 | 基本合理 | 若确认无外部 API 依赖，可删 |
| GoalRuntime 未实例化 | 存在 | 搁置合理 | 不应现在删 |
| Sandbox 主路径未接入 | 未完整核验 | 搁置合理 | 属于产品安全策略 |
| Supervisor 候选池默认禁用 | 存在，但不是 bug | 文档化合理 | 保留 |
| Mailbox workflow 默认禁用 | 存在，但不是 bug | 搁置合理 | 保留 |
| QuestionService reply 链 | 存在 | 方向对，但方案有 bug | 必须修，不能按文档代码直接改 |
| governance/task-state.ts 未接入 | 存在 | 基本合理 | 可删或保留为实验函数 |
| Config adapter 未使用函数 | 存在 | 合理 | 可删 |
| Memory bridge lifecycle 未调用 | 存在 | 不建议直接删 | 更适合标记为未接入能力 |
| Pricing 未使用函数 | 存在 | 合理 | 可删或保留 |
| 其他死代码 | 多数存在 | 逐个处理 | 不要批量删除 |

---

## 三、按功能域分组详情与修复方案

### 3.1 🔴 Two-Stage Tool Routing（流程不闭环，真 bug）

| 项 | 详情 |
|----|------|
| **未接入代码** | Two-stage 流程的 Stage 1→Stage 2 转换 |
| **性质** | 核心功能闭环缺失（真 bug） |
| **严重度** | 🔴 高 |

#### 现象

[loop.ts:586](file:///d:/Proj/covalo/packages/core/src/loop.ts) 的映射逻辑把所有非 `"two-stage"` 值（包括默认的 `"auto"`）当作 `"direct"` 处理：

```ts
const routingMode: ToolRoutingMode = toolRoutingMode === "two-stage" ? "two_stage" : "direct"
```

`shouldUseTwoStageRouting` 的自动检测逻辑（基于 contextWindow + schemaTokens + sizeClass）在生产中是死代码。

即使显式配置 `toolRouting: "two-stage"`，流程也不闭环：
- `select_category` 工具 schema 会通过 `getCategorySelectorTool()` 注入 LLM，但该工具在 tools 包和 engine 注册表中**无实现**
- `parseSelectedCategory` 无生产调用
- loop.ts 中无代码处理 `select_category` 的工具调用响应

#### 事实修正

> ⚠️ **再审核发现**：原文档说"`ToolRoutingMode` 类型已包含 `"auto"`"是**事实错误**。当前类型只有 `"direct" | "two_stage"`，并没有 `"auto"`。修复方案需要先扩展类型。

#### 影响

- 默认 `normal` 策略的 `toolRouting: "auto"` 实际走 direct 模式
- 显式 `"two-stage"` 会导致 LLM 调用 `select_category` 时工具执行失败

#### 验证

Grep `select_category|parseSelectedCategory|getCategorySelectorTool` 在 loop.ts 中无匹配。
Grep `createDefaultTools` 在 tools/index.ts 中确认 `select_category` 未注册。

#### 修复方案（重写）：扩展类型 + loop 内部虚拟工具

> ⚠️ **方案调整说明**：原文档建议"在 `createDefaultTools()` 注册 `select_category` 工具"**不够合理**。这样会把一个路由内部控制工具暴露给 direct 模式，模型在普通场景也可能调用它，污染工具空间。正确做法是把 `select_category` 作为 **loop 内部协议工具**，不注册到全局工具表。

**步骤 1：扩展 ToolRoutingMode 类型**

编辑 [packages/core/src/tool-routing/two-stage-router.ts](file:///d:/Proj/covalo/packages/core/src/tool-routing/two-stage-router.ts)，把类型扩展为：

```ts
// 修改前
export type ToolRoutingMode = "direct" | "two_stage"

// 修改后
export type ToolRoutingMode = "direct" | "two_stage" | "auto"
```

确认 `shouldUseTwoStageRouting` 在 `routingOverride === "auto"` 时会走自动检测逻辑（基于 contextWindow/schemaTokens/sizeClass）。

**步骤 2：修复 loop.ts 的 auto 映射**

编辑 [loop.ts:586](file:///d:/Proj/covalo/packages/core/src/loop.ts)，把 `"auto"` 走自动检测：

```ts
// 修改前
const routingMode: ToolRoutingMode = toolRoutingMode === "two-stage" ? "two_stage" : "direct"

// 修改后
// TR-1: "auto" 不再静默降级为 "direct"，而是传给 resolveToolRouting
// 由 shouldUseTwoStageRouting 基于 contextWindow/schemaTokens/sizeClass 自动决策
const routingMode: ToolRoutingMode =
  toolRoutingMode === "two-stage" ? "two_stage"
  : toolRoutingMode === "auto" ? "auto"
  : "direct"
```

**步骤 3：在 loop.ts 中保留 selectedCategory 状态**

```ts
// 在 loop 状态区添加
let selectedCategory: string | undefined
```

**步骤 4：select_category 作为 loop 内部虚拟工具处理（关键）**

> 不注册到 `createDefaultTools()`，而是由 loop 在 `resolveToolRouting` 返回 Stage 1 时动态注入 schema，并在工具调用流中拦截处理。

编辑 [loop.ts](file:///d:/Proj/covalo/packages/core/src/loop.ts)，在工具调用处理逻辑中添加 `select_category` 拦截分支：

```ts
// 推荐思路，不是直接照抄
// 1. ToolRoutingMode 扩展为 "direct" | "two_stage" | "auto"（步骤 1 已做）
// 2. loop.ts 保留 selectedCategory 变量（步骤 3 已做）
// 3. resolveToolRouting 返回 Stage 1 时，只注入虚拟 select_category schema
//    - 通过 getCategorySelectorTool() 生成 schema
//    - 不进入 StreamingToolExecutor 的常规工具注册表
// 4. 当模型调用 select_category 时，在 loop 内部拦截：
if (toolCall.function.name === "select_category") {
  const parsed = parseSelectedCategory(toolCall.function.arguments)
  if (parsed.ok) {
    selectedCategory = parsed.category
    // appendToolResult 把结果写回消息流，让 LLM 看到选择已生效
    appendToolResult(toolCall, {
      content: `Category selected: ${parsed.category}. Continuing with tools from this category.`,
      isError: false,
    })
    // break streamLoop 进入下一轮，下一轮 resolveToolRouting 会基于
    // selectedCategory 返回 Stage 2（仅注入该 category 的工具）
    break
  }
}
// 5. 不进入 StreamingToolExecutor，不注册到 createDefaultTools
```

**步骤 5：resolveToolRouting 调用时传入 selectedCategory**

```ts
const routingCtx = {
  allTools: toolSpecs,
  contextWindow: ctx.getContextWindow(),
  routingOverride: routingMode,
  selectedCategory,  // 新增：Stage 2 选择性注入
}
```

**步骤 6：验证**

```bash
# 测试 two-stage router 单元测试
bun test packages/core/__tests__/two-stage-router.test.ts

# 测试 toolRouting: "auto" 不再静默降级
# 手动验证：在 normal 策略下，context window 较小时应自动走 two-stage

# 确认 select_category 未出现在 createDefaultTools
grep -r "select_category" packages/tools/src/index.ts
# 应无输出（select_category 仅在 loop.ts 内部处理）
```

---

### 3.2 🔴 WorkflowCoordinator QuestionService 回复链（真 bug，方案重写）

| 项 | 详情 |
|----|------|
| **未接入代码** | `questionService.reply()` 在 coordinator 侧无调用方 |
| **性质** | 部分链路缺失（真 bug） |
| **严重度** | 🔴 高 |

#### 现象

[cli/tui.ts:345](file:///d:/Proj/covalo/packages/cli/src/tui.ts) 创建了一个新的 `QuestionService` 实例传给 `WorkflowCoordinator`。`runWaitingUser`（[coordinator.ts:718](file:///d:/Proj/covalo/packages/core/src/workflow-coordinator/coordinator.ts)）会调用 `questionService.ask()`，但生产代码中无任何位置调用 `.reply()` 回复该实例。

Grep `reply|rejectQuestion|respondQuestion|replyQuestion` 在 coordinator.ts 中无匹配。

#### 影响

supervisor 决策 `ask_user` 时进入 `waiting_user` 状态后，只能等 30s 超时 reject，无法真正回复。

#### 方案缺陷分析（再审核发现）

> ⚠️ **原文档方案有明显漏洞**，不能原样使用：

原文档建议：
```ts
replyWorkflowQuestion(requestId, answers) {
  this.questionService.reply({ requestId, answers })
}
```

但实际流程中：
1. `WorkflowCoordinator.handleAskUser()` 自己生成一个 `requestId`，保存到 `state.waitingUserRequestId`
2. `runWaitingUser()` 调用 `questionService.ask()` 时**没有把这个 requestId 传进去**
3. `QuestionService.ask()` 内部会重新 `createQuestionId()`，把新的 id 放入 pending map

这意味着 UI 看到的是 coordinator 自己生成的 id，而 `QuestionService` pending 里保存的是**另一个 id**。`QuestionService.reply()` 是按 pending map 的 requestId 查找的，所以大概率仍然找不到 pending question。

此外：
- 当前 bridge 的普通 `respondQuestion()` 只回复 engine、worker engine、supervisor engine，**不回复** `workflowCoordinator`
- workflow 渲染循环只处理 `phase_change / completed / failed / blocked` 等 workflow event，**没有处理** `ask_user`
- App **不应使用**原文档写的 `bridgeRef.current?.on?.("ask_user")`，因为当前 bridge 返回接口没有事件订阅器

#### 修复方案（重写）：解决 requestId 不一致 + bridge 接入

**步骤 1：让 QuestionService.ask() 支持外部传入 requestId**

编辑 [packages/core/src/question-service.ts](file:///d:/Proj/covalo/packages/core/src/question-service.ts)，给 `ask()` 增加可选的 `requestId` 参数：

```ts
async ask(
  question: string,
  options?: { requestId?: string; ... }
): Promise<QuestionAnswer[]> {
  const requestId = options?.requestId ?? createQuestionId()
  // ... 把 requestId 放入 pending map
}
```

**或者**让 `runWaitingUser()` 记录 `ask()` 返回的真实 pending id（二选一）：

```ts
// coordinator.ts runWaitingUser 内部
const askResult = await this.questionService.ask(question)
// ask() 应返回它内部生成的 requestId，coordinator 用这个 id 覆盖 state.waitingUserRequestId
this.state.waitingUserRequestId = askResult.requestId
```

**步骤 2：WorkflowCoordinator 暴露 reply/reject 方法**

编辑 [packages/core/src/workflow-coordinator/coordinator.ts](file:///d:/Proj/covalo/packages/core/src/workflow-coordinator/coordinator.ts)，添加公开方法：

```ts
/**
 * 回复 workflow 的 waiting_user 问题。
 * 由 TUI/CLI 在用户回答 supervisor 的 ask_user 后调用。
 */
replyWorkflowQuestion(requestId: string, answers: QuestionAnswer[]): void {
  if (!this.state || !this.questionService) return
  if (this.state.waitingUserRequestId !== requestId) return

  this.questionService.reply({ requestId, answers })
  // reply 成功后，runWaitingUser 的 await 会 resolve，
  // 状态机自动 transition("supervisor_analyse")
}

/**
 * 拒绝 workflow 的 waiting_user 问题。
 */
rejectWorkflowQuestion(requestId: string): void {
  if (!this.state || !this.questionService) return
  if (this.state.waitingUserRequestId !== requestId) return

  this.questionService.reject(requestId)
  // reject 后 runWaitingUser 的 await 会 reject，
  // 状态机自动 transition("blocked", "User rejected question")
}
```

**步骤 3：bridge.tsx 的 workflow event 分支处理 ask_user**

编辑 [packages/tui/src/bridge.tsx](file:///d:/Proj/covalo/packages/tui/src/bridge.tsx)，在 workflow event 渲染分支中添加 `ask_user` 处理：

```ts
// bridge.tsx workflow event 处理
switch (event.type) {
  case "phase_change":
  case "completed":
  case "failed":
  case "blocked":
    // ... 现有处理
    break
  case "ask_user":
    // 把 ask_user 事件写入 questionPrompt，触发 App 渲染问题 UI
    // 注意：使用 coordinator 暴露的真实 requestId（来自步骤 1 的修正）
    setQuestionPrompt({
      requestId: event.requestId,  // 这个 id 必须与 QuestionService pending map 一致
      question: event.question,
    })
    break
}
```

**步骤 4：respondQuestion 同时转发给 workflowCoordinator**

编辑 [packages/tui/src/bridge.tsx](file:///d:/Proj/covalo/packages/tui/src/bridge.tsx)，在 `respondQuestion()` 中添加 workflowCoordinator 转发：

```ts
function respondQuestion(requestId: string, answers: QuestionAnswer[]) {
  // 现有：回复 engine / worker engine / supervisor engine
  engine.replyQuestion(requestId, answers)
  workerEngine?.replyQuestion(requestId, answers)
  supervisorEngine?.replyQuestion(requestId, answers)

  // 新增：转发给 workflowCoordinator
  workflowCoordinator?.replyWorkflowQuestion(requestId, answers)
}

function rejectQuestion(requestId: string) {
  // 现有：拒绝 engine / worker engine / supervisor engine
  engine.rejectQuestion(requestId)
  workerEngine?.rejectQuestion(requestId)
  supervisorEngine?.rejectQuestion(requestId)

  // 新增：转发给 workflowCoordinator
  workflowCoordinator?.rejectWorkflowQuestion(requestId)
}
```

**步骤 5：App.tsx 渲染问题 UI（不使用事件订阅器）**

编辑 [packages/tui/src/App.tsx](file:///d:/Proj/covalo/packages/tui/src/App.tsx)，根据 `questionPrompt` state 渲染问题 UI：

```tsx
// App.tsx
// ❌ 不要使用：bridgeRef.current?.on?.("ask_user", ...) —— bridge 没有事件订阅器
// ✅ 正确方式：监听 bridge 写入的 questionPrompt state

{questionPrompt && (
  <QuestionDialog
    question={questionPrompt.question}
    onReply={(answer) => {
      bridgeRef.current?.respondQuestion(questionPrompt.requestId, [{ value: answer }])
      setQuestionPrompt(null)
    }}
    onReject={() => {
      bridgeRef.current?.rejectQuestion(questionPrompt.requestId)
      setQuestionPrompt(null)
    }}
  />
)}
```

**步骤 6：验证**

```bash
# 运行 workflow coordinator 测试
bun test packages/core/__tests__/workflow-coordinator.test.ts
bun test packages/core/__tests__/wf-30-question-fusion.test.ts
bun test packages/core/__tests__/wf-40-ask-user-loop.test.ts

# 新增测试：验证 requestId 一致性
# - 测试 replyWorkflowQuestion 在 requestId 匹配时能成功 reply
# - 测试 requestId 不匹配时不调用 questionService.reply
# - 测试 respondQuestion 同时转发到 workflowCoordinator
```

---

### 3.3 🔴 SubagentRunner 重复实现 + engine.spawnSubagent target/client 缺失

| 项 | 详情 |
|----|------|
| **未接入代码** | `SubagentRunner` 类（[subagent/run.ts:23](file:///d:/Proj/covalo/packages/core/src/subagent/run.ts)） |
| **性质** | 死代码（与 engine.spawnSubagent 重复实现）+ 生产路径能力缺失 |
| **严重度** | 🔴 高 |

#### 现象

`SubagentRunner` 类定义了完整的 `spawnAndRun()` 方法，但生产代码从不实例化它。[engine.ts:1466](file:///d:/Proj/covalo/packages/core/src/engine.ts) 自己实现了一个 `spawnSubagent()` 方法，内联了等价逻辑（创建 child engine、注册工具、应用 permission、执行 child.submit）。

两份实现差异：
- `SubagentRunner.spawnAndRun` 支持 `target` 解析（独立 model target）和独立 client
- `engine.spawnSubagent` 增加了 TUI orchestration 事件（worker_upsert/worker_remove）和 worker cancel/interrupt 逻辑
- **关键差异**：`engine.spawnSubagent` 虽然在 TUI worker 状态里显示 `options.target`，但实际创建 child engine 时仍传入 `this.config` 和 `this.client`，也就是**共享父级 client**，丢失了独立 target 能力

#### 影响

两份等价实现并存，维护成本倍增。**更严重的是**：直接删除 `SubagentRunner` 会丢失 target 解析能力，生产路径继续保留能力缺口。修改 subagent 行为时容易漏改其一。

#### 验证

Grep `new SubagentRunner\(` 全仓库仅命中测试文件 `__tests__/subagent-run.test.ts`。

#### 修复方案：先迁移 target/client 能力，再删除 SubagentRunner

> ⚠️ **方案调整说明**：原文档建议"直接删除 SubagentRunner"是**错误的方向**。必须先把 `SubagentRunner` 的 target 解析能力迁移到 `engine.spawnSubagent()`，然后再删除。

**步骤 1：把 SubagentRunner 的 target 解析能力迁移到 engine.spawnSubagent()**

编辑 [packages/core/src/engine.ts](file:///d:/Proj/covalo/packages/core/src/engine.ts) 的 `spawnSubagent()` 方法，参考 `SubagentRunner.spawnAndRun` 的 target 解析逻辑：

```ts
// engine.ts spawnSubagent 内部
// 修改前：共享父级 client
const child = new ReasonixEngine({
  ...this.config,
  parent: this,
  // ...
})
child.client = this.client  // ❌ 共享父级 client

// 修改后：根据 options.target / def.target 解析独立 model target
const target = options.target ?? def.target
const childConfig = { ...this.config }
if (target) {
  // 解析 target 为独立 model 配置
  childConfig.model = resolveTarget(target, this.config)
}

const child = new ReasonixEngine({
  ...childConfig,
  parent: this,
  // ...
})

// 如果 target 指定了独立 client，创建新的 client 实例
if (target?.client) {
  child.client = createClientForTarget(target)
} else {
  child.client = this.client  // 保留共享行为作为 fallback
}
```

**步骤 2：保留生产路径的 TUI orchestration、worker 状态、cancel/interrupt 逻辑**

`engine.spawnSubagent` 已有的 `worker_upsert`/`worker_remove` 事件、cancel/interrupt 逻辑**必须保留**，不要被 `SubagentRunner` 的简化逻辑覆盖。迁移时只取 target/client 解析部分。

**步骤 3：添加测试验证 target 解析能力**

新增测试，验证 `engine.spawnSubagent` 在 `options.target` / `def.target` 指定时：
- child engine 使用独立 model 配置
- child engine 不共享父级 client（当 target 指定独立 client 时）
- TUI orchestration 事件正常 emit
- cancel/interrupt 逻辑正常工作

**步骤 4：删除 SubagentRunner 类和相关 export**

迁移完成且测试通过后，删除 `SubagentRunner`：

- 删除 `packages/core/src/subagent/run.ts` 文件
- 编辑 [packages/core/src/subagent/index.ts](file:///d:/Proj/covalo/packages/core/src/subagent/index.ts) 移除 `export { SubagentRunner } from "./run.js"`
- 编辑 [packages/core/src/index.ts:426](file:///d:/Proj/covalo/packages/core/src/index.ts) 移除 `SubagentRunner` export

```ts
// packages/core/src/subagent/index.ts（修改后）
export type {
  SubagentPermissionMode,
  SubagentDefinition,
  SubagentRun,
  SubagentRunStatus,
  SubagentRunUsage,
  SubagentRunOptions,
  SubagentRunResult,
  SubagentRunStoreEntry,
} from "./types.js"

export { BUILTIN_SUBAGENTS } from "./definition.js"
export { SubagentRegistry, defaultSubagentRegistry } from "./registry.js"
export { checkSubagentPermission, getToolTier } from "./permission.js"
export type { SubagentPermissionCheck } from "./permission.js"
// SubagentRunner export 已删除
```

**步骤 5：删除 defaultSubagentRegistry（同样未接入）**

[registry.ts:55](file:///d:/Proj/covalo/packages/core/src/subagent/registry.ts) 的 `defaultSubagentRegistry` 也未接入（engine 构造函数里已经是 `new SubagentRegistry()`），一并删除。

- 编辑 `packages/core/src/subagent/registry.ts` 删除第 55 行 `export const defaultSubagentRegistry = new SubagentRegistry()`
- 编辑 `packages/core/src/subagent/index.ts` 移除 `defaultSubagentRegistry` export
- 编辑 [packages/core/src/index.ts:423](file:///d:/Proj/covalo/packages/core/src/index.ts) 移除 `defaultSubagentRegistry` export

**步骤 6：删除测试文件**

- 删除 `packages/core/__tests__/subagent-run.test.ts`（其测试目标 `SubagentRunner` 已删除）
- 把其中验证 target 解析的测试用例迁移到 `engine.spawnSubagent` 的测试套件

**步骤 7：验证**

```bash
# 确认无残留引用
grep -r "SubagentRunner" packages/ --include="*.ts" | grep -v "__tests__"
# 应无输出

# 运行相关测试（含迁移后的 target 解析测试）
bun test packages/core/__tests__/subagent-registry.test.ts
bun test packages/core/__tests__/subagent-permission.test.ts
bun test packages/core/__tests__/engine-spawn-subagent.test.ts  # 新增或扩展

# 手动验证：配置 subagent def.target，确认 child engine 使用独立 model
```

---

### 3.4 🟡 PermissionService（完全未接入，双路径处理）

| 项 | 详情 |
|----|------|
| **未接入代码** | `PermissionService` 类（[permission/service.ts](file:///d:/Proj/covalo/packages/core/src/permission/service.ts)） |
| **性质** | 整个模块未接入 |
| **严重度** | 🟡 中（删除属于 API 破坏） |

#### 现象

[executor-helpers.ts:84](file:///d:/Proj/covalo/packages/core/src/executor-helpers.ts) 声明了可选参数 `permissionService?: PermissionService`，但生产代码从不传入此参数。engine 使用的是 `@covalo/security` 包的 `PermissionEngine`（[engine.ts:287](file:///d:/Proj/covalo/packages/core/src/engine.ts) `new PermissionEngine()`）。

`streaming-executor.ts` 调用 `evaluatePermission()` 时也只传了 `permissionEngine / hookManager / requestPermission / args`，没有传 `permissionService`。

#### 影响

`PermissionService` 的 session rules、pattern matching 等功能在生产中永远不会执行。`executor-helpers.ts` 中 `permissionService` 分支（line 99-124）是死代码。

#### 验证

Grep `new PermissionService\(` 全仓库仅命中 `__tests__/permission-service.test.ts`。
[packages/core/src/index.ts](file:///d:/Proj/covalo/packages/core/src/index.ts) 仍公开导出 `PermissionService` 和相关类型。

#### 修复方案：双路径选择（根据 API 稳定性决策）

> ⚠️ **方案调整说明**：原文档建议直接删除，但 [core/index.ts](file:///d:/Proj/covalo/packages/core/src/index.ts) 仍公开导出 `PermissionService`，删除属于 API 破坏。需根据 Covalo 是否有公开稳定 API 选择路径。

**路径 A：Covalo 还没有公开稳定 API —— 直接删除**

执行原文档的删除方案：

1. 清理 `executor-helpers.ts` 的 `permissionService` 参数和相关分支（line 99-124）
2. 更新 `streaming-executor.ts` 中调用 `evaluatePermission` 的两处（line 113, 232），移除未传入的 `permissionService` 参数
3. 删除 `packages/core/src/permission/` 整个目录（service.ts、types.ts、rules.ts、patterns/、index.ts）
4. 删除 `packages/core/__tests__/permission-service.test.ts`
5. 清理 `subagent/permission.ts` 中对 `permission/types.js` 的依赖（见 3.10e）
6. 清理 `core/index.ts` 的 `PermissionService` export

**路径 B：担心外部包依赖 —— 先 deprecate，下一版移除**

1. **保留 export，标记 deprecated**：

```ts
// packages/core/src/index.ts
/** @deprecated PermissionService 未接入生产路径，将在下一版本移除。请使用 @covalo/security 的 PermissionEngine。 */
export { PermissionService } from "./permission/service.js"
```

2. **从生产路径删除分支**：清理 `executor-helpers.ts` 的 `permissionService` 参数和相关分支（line 99-124），更新 `streaming-executor.ts` 调用点
3. **保留模块文件和测试**：`permission/` 目录和 `permission-service.test.ts` 保留，但标记为 deprecated
4. **下一版本**：执行路径 A 的剩余步骤

**推荐**：如果不确定，先走路径 B，给外部依赖一个迁移窗口。

#### 验证

```bash
# 确认无残留引用（路径 A）
grep -r "PermissionService" packages/ --include="*.ts" | grep -v "__tests__"
grep -r "from.*permission/" packages/core/src/ --include="*.ts"
# 应无输出

# typecheck
bun run typecheck

# 运行权限相关测试
bun test packages/core/__tests__/executor-helpers.test.ts
```

---

### 3.5 🟡 DualSession / DualSessionStore（完全未接入）

| 项 | 详情 |
|----|------|
| **未接入代码** | `DualSession` 类、`DualSessionStore` 类（[dual-session/](file:///d:/Proj/covalo/packages/core/src/dual-session/)） |
| **性质** | 整个模块未接入（被 DualAgentRuntime 替代） |
| **严重度** | 🟡 中 |

#### 现象

生产代码走 `DualAgentRuntime`（[cli/tui.ts:307](file:///d:/Proj/covalo/packages/cli/src/tui.ts)），不使用 DualSession。`DualAgentRuntime` 接收 worker/supervisor engine、model target、thinking 配置。

#### 验证

Grep `new DualSession\(|new DualSessionStore\(` 仅命中测试文件。`wf-00-integration-baseline.test.ts:75-80` 明确记录"当前生产路径不使用 DualSession"。

#### 修复方案：确认无外部 API 依赖后删除

> ⚠️ **方案调整说明**：删除前需确认是否有外部 package import `DualSession` / `DualSessionStore`。

**步骤 1：确认无外部依赖**

```bash
# 检查是否有外部 package 依赖（不只是 monorepo 内部）
grep -r "DualSession" packages/ --include="*.ts" | grep -v "__tests__" | grep -v "dual-session/"
# 如果有 core/index.ts 的 re-export，确认是否有外部消费者
```

**步骤 2：删除模块文件**

- 删除 `packages/core/src/dual-session/` 整个目录

**步骤 3：清理 re-export**

- 编辑 `packages/core/src/index.ts` 移除 DualSession 相关 export（搜索 `dual-session` 关键词）

**步骤 4：删除测试文件**

- 删除 `packages/core/__tests__/dual-session.test.ts`
- 编辑 `packages/core/__tests__/da-r0-baseline.test.ts` 和 `da-r7-e2e.test.ts`，移除对 DualSession 的引用（这两个测试文件如果主要是测试 DualSession，可整体删除；如果包含其他 DualAgentRuntime 测试，需保留非 DualSession 部分）

**步骤 5：验证**

```bash
grep -r "DualSession" packages/ --include="*.ts" | grep -v "__tests__"
# 应无输出

bun run typecheck
```

---

### 3.6 🟢 governance/task-state.ts（完全未接入）

| 项 | 详情 |
|----|------|
| **未接入代码** | `inferTaskIntent`、`shouldCreateLedgerByIntent`、`hasExecutableSideSignal`（[governance/task-state.ts](file:///d:/Proj/covalo/packages/core/src/governance/task-state.ts)） |
| **性质** | 整个文件未接入 |
| **严重度** | 🟢 低 |

#### 现象

生产代码 [engine.ts:1022](file:///d:/Proj/covalo/packages/core/src/engine.ts) 使用的是 `task-ledger.ts` 的 `shouldCreateLedger`（不同实现），不是 `task-state.ts` 的 `shouldCreateLedgerByIntent`。

两套实现差异：
- `task-ledger.ts` 的 `shouldCreateLedger`：基于消息长度、PLAN_HINTS 正则、句子数量，支持 `COVALO_TASK_LEDGER` 环境变量
- `task-state.ts` 的 `shouldCreateLedgerByIntent`：基于 TaskIntent 分类（edit/debug/refactor/test 创建，question/inspect 不创建）

#### 修复方案：删除或保留为实验函数（二选一）

**选项 A：删除（推荐，简化系统）**

1. 删除 `packages/core/src/governance/task-state.ts`
2. 编辑 `packages/core/src/governance/index.ts`（如果存在），移除 task-state.ts 的 re-export
3. 编辑 `packages/core/src/index.ts`，移除 task-state 相关 export（搜索 `task-state`、`inferTaskIntent`、`shouldCreateLedgerByIntent`、`hasExecutableSideSignal`、`TaskIntent`）
4. 编辑 `packages/core/__tests__/task-ledger.test.ts`，移除对 `task-state.ts` 函数的测试（line 12, 142-150 引用了 `inferTaskIntent`、`shouldCreateLedgerByIntent`）

**选项 B：保留为实验函数（未来更精细的 intent classifier）**

1. 在 `task-state.ts` 顶部添加注释标记实验状态：

```ts
/**
 * @experimental task-state.ts 是从 iceCoder 移植的实验性 intent classifier。
 * 当前生产路径使用 task-ledger.ts 的 shouldCreateLedger。
 * 保留此模块作为未来更精细的 intent 分类基础。
 */
```

2. 从 `core/index.ts` 移除公开 export（避免外部依赖），仅在 `governance/index.ts` 内部 export

**验证**：

```bash
grep -r "task-state" packages/ --include="*.ts" | grep -v "__tests__"
grep -r "inferTaskIntent\|shouldCreateLedgerByIntent\|hasExecutableSideSignal" packages/ --include="*.ts"
# 选项 A：应无输出
# 选项 B：仅 governance/ 内部 export

bun test packages/core/__tests__/task-ledger.test.ts
```

---

### 3.7 🟢 Config Adapter 未使用的函数

| 项 | 详情 |
|----|------|
| **未接入代码** | `toWorkflowCoordinatorConfig`、`toGoalRuntimeConfig`、`getSupervisorToolPolicy`、`getWorkerToolPolicy`、`getMailboxConfig`、`getContextConfig`（[config/adapter.ts](file:///d:/Proj/covalo/packages/core/src/config/adapter.ts)） |
| **性质** | 6 个函数定义+导出但无生产调用方 |
| **严重度** | 🟢 低 |

#### 现象

当前 `resolve-effective-tools.ts` 只从 adapter 里 import 了 `isHardDeniedForSupervisorLoop`、`isHardDeniedForWorkerLoop`、`isToolAllowed`。

#### 修复方案：删除未使用的函数

**步骤 1：编辑 config/adapter.ts**

保留 `isHardDeniedForSupervisorLoop`、`isHardDeniedForWorkerLoop`、`isToolAllowed`（被 resolve-effective-tools.ts 使用），删除其余 6 个函数：

```ts
// packages/core/src/config/adapter.ts（修改后）
import type { CovaloConfig } from "./schema.js"

/**
 * 检查工具是否被允许
 */
export function isToolAllowed(
  config: CovaloConfig,
  role: "supervisor" | "worker",
  mode: "loop" | "subagent",
  toolName: string,
): boolean {
  const policy = config.tools[role][mode]
  if (policy.deny.includes(toolName)) return false
  if (policy.allow.length > 0) return policy.allow.includes(toolName)
  return true
}

/**
 * 检查是否是 hard deny 工具（Supervisor loop）
 */
export function isHardDeniedForSupervisorLoop(toolName: string): boolean {
  const hardDenied = ["bash", "edit_file", "apply_patch", "write_file", "AgentTool"]
  return hardDenied.includes(toolName)
}

/**
 * 检查是否是 hard deny 工具（Worker loop）
 */
export function isHardDeniedForWorkerLoop(toolName: string): boolean {
  const hardDenied = ["update_goal"]
  return hardDenied.includes(toolName)
}

// 以下函数已删除（无生产调用方）：
// - toWorkflowCoordinatorConfig
// - toGoalRuntimeConfig
// - getSupervisorToolPolicy
// - getWorkerToolPolicy
// - getMailboxConfig
// - getContextConfig
```

**步骤 2：清理 re-export**

编辑 `packages/core/src/index.ts`，移除这 6 个函数的 export。

**步骤 3：更新测试**

编辑 `packages/core/__tests__/config-adapter.test.ts`，移除对已删除函数的测试用例。

**步骤 4：验证**

```bash
bun run typecheck
bun test packages/core/__tests__/config-adapter.test.ts
```

---

### 3.8 🟢 Memory Bridge 未调用的 lifecycle 方法

| 项 | 详情 |
|----|------|
| **未接入代码** | `onPreToolUse`、`onPreCompact`、`onSubagentStart`、`onSubagentStop`（[covalo-memory-bridge.ts:47-138](file:///d:/Proj/covalo/packages/memory/src/bridge/covalo-memory-bridge.ts)） |
| **性质** | 4 个 lifecycle 方法定义但 tui.ts 从不调用 |
| **严重度** | 🟢 低 |

#### 现象

CLI 当前实际接入的是 `onSessionStart`、afterToolCall 后的 `onPostToolUse/onPostToolFailure`、以及 done event 的 `onGenerationComplete`。

#### 修复方案（调整）：标记 experimental，不直接删 onPreToolUse

> ⚠️ **方案调整说明**：原文档建议直接删除 4 个方法，但 `onPreToolUse` 包含 memory context 注入逻辑，可能是未来"工具调用前上下文增强"的设计点。**不建议直接删 `onPreToolUse`**，更适合标记为未接入能力或补接 HookManager。

**步骤 1：onPreCompact / onSubagentStart / onSubagentStop —— 删除**

这三个方法没有明显的未来设计意图，删除：

- 编辑 [packages/memory/src/bridge/covalo-memory-bridge.ts](file:///d:/Proj/covalo/packages/memory/src/bridge/covalo-memory-bridge.ts)，删除 `onPreCompact`、`onSubagentStart`、`onSubagentStop` 三个方法
- 更新 `DeepreefMemoryBridgeConfig` 或相关接口声明，移除这三个方法

**步骤 2：onPreToolUse —— 标记 experimental 并补接 HookManager（推荐）**

**选项 A：标记 experimental，保留方法**

```ts
/**
 * @experimental 未接入生产路径。
 * 设计意图：在工具调用前注入 memory context，实现"工具调用前上下文增强"。
 * 当前 HookManager 的 beforeToolCall 已有 hook 机制，未来可在此处接入。
 */
async onPreToolUse(toolName: string, args: Record<string, unknown>): Promise<void> {
  // ... 现有 memory context 注入逻辑保留
}
```

**选项 B：补接 HookManager 的 beforeToolCall**

在 CLI/TUI 初始化时，把 `onPreToolUse` 接入 HookManager：

```ts
// cli/tui.ts 初始化时
hookManager.onBeforeToolCall(async (event) => {
  await memoryBridge.onPreToolUse(event.toolName, event.args)
})
```

这样 `onPreToolUse` 会被 HookManager 的 beforeToolCall 钩子触发，不再是死代码。

**步骤 3：验证**

```bash
bun run typecheck
bun test packages/memory/__tests__/memory-fixes.test.ts

# 选项 B 额外验证：确认 HookManager beforeToolCall 触发 memory context 注入
```

---

### 3.9 🟢 Pricing 未使用的函数

| 项 | 详情 |
|----|------|
| **未接入代码** | `calculateCostCNY`、`getPricing`、`USD_TO_CNY`（[pricing.ts](file:///d:/Proj/covalo/packages/core/src/pricing.ts)） |
| **性质** | 定义但无生产调用方 |
| **严重度** | 🟢 低 |

#### 修复方案：删除未使用的函数

**步骤 1：编辑 pricing.ts**

保留 `ModelPricing` 接口、`MODEL_PRICING` 常量、`calculateCost` 函数，删除其余：

```ts
// packages/core/src/pricing.ts（修改后）
export interface ModelPricing {
  inputPer1K: number
  outputPer1K: number
  cacheReadPer1K: number
  cacheWritePer1K: number
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // ...保留现有定价表...
}

export function calculateCost(model: string, promptTokens: number, completionTokens: number, cacheHitTokens = 0, cacheMissTokens = 0): number {
  // ...保留现有实现...
}

// 以下已删除（无生产调用方）：
// - USD_TO_CNY
// - calculateCostCNY
// - getPricing
```

**步骤 2：清理 re-export**

编辑 `packages/core/src/index.ts`，移除 `calculateCostCNY`、`getPricing`、`USD_TO_CNY` 的 export（如果存在）。

**步骤 3：验证**

```bash
bun run typecheck
```

---

### 3.10 🟢 其他死代码（逐个处理，不批量删除）

#### 3.10a executeEccHookCommand

| 项 | 详情 |
|----|------|
| **未接入代码** | `executeEccHookCommand`（[hook-bridge.ts:93](file:///d:/Proj/covalo/packages/plugin/src/content-pack/hook-bridge.ts)） |
| **性质** | 死代码，被 `executeHookCommandSafe` 取代 |

**修复**：删除 `hook-bridge.ts` 中的 `executeEccHookCommand` 函数（line 93-106）。

```bash
# 验证无引用
grep -r "executeEccHookCommand" packages/ --include="*.ts" | grep -v "__tests__"
# 应无输出（仅文档和定义处）
```

#### 3.10b mergeBudgetPathSet

| 项 | 详情 |
|----|------|
| **未接入代码** | `mergeBudgetPathSet`（[branch-budget-path.ts:51](file:///d:/Proj/covalo/packages/core/src/governance/branch-budget-path.ts)） |
| **性质** | 定义并 export 但无任何调用 |

**修复**：删除 `branch-budget-path.ts` 中的 `mergeBudgetPathSet` 函数，清理 `governance/index.ts` 的 re-export。

#### 3.10c LspManager 类

| 项 | 详情 |
|----|------|
| **未接入代码** | `LspManager` 类（[tools/src/lsp/manager.ts](file:///d:/Proj/covalo/packages/tools/src/lsp/manager.ts)） |
| **性质** | 仅测试使用，生产无消费者（`createLspTool()` 直接 import `LspClient`，`server_status` 返回 "LSP manager not yet implemented"） |

**修复**：删除 `packages/tools/src/lsp/manager.ts`，编辑 `packages/tools/src/lsp/index.ts` 移除 line 32 的 `LspManager` export 和 `LspManagerStatus` type export，删除 `packages/tools/__tests__/lsp-manager.test.ts`。

```bash
# 验证无引用
grep -r "LspManager" packages/ --include="*.ts" | grep -v "__tests__"
# 应无输出
```

#### 3.10d SUPERVISOR_WORKFLOW_PROMPT

| 项 | 详情 |
|----|------|
| **未接入代码** | `SUPERVISOR_WORKFLOW_PROMPT`（[workflow-coordinator/types.ts:203](file:///d:/Proj/covalo/packages/core/src/workflow-coordinator/types.ts)） |
| **性质** | 仅 export 未使用 |

**修复**：删除 `types.ts` 中的 `SUPERVISOR_WORKFLOW_PROMPT` 常量，清理 `workflow-coordinator/index.ts` 的 re-export。

#### 3.10e deriveSubagentPermissions 和 createBubbleRequest

| 项 | 详情 |
|----|------|
| **未接入代码** | `deriveSubagentPermissions`、`createBubbleRequest`（[subagent/permission.ts:88, 165](file:///d:/Proj/covalo/packages/core/src/subagent/permission.ts)） |
| **性质** | bubble 协议未实装 |

**修复**：删除 `permission.ts` 中的 `deriveSubagentPermissions` 和 `createBubbleRequest` 函数。如果删除 `PermissionService`（3.4 路径 A）后 `PermissionRule`/`PermissionRequest` 类型不再可用，这两个函数的删除是必须的。

编辑 [subagent/permission.ts](file:///d:/Proj/covalo/packages/core/src/subagent/permission.ts)：
- 删除 line 10 的 `import type { PermissionRule, PermissionRequest } from "../permission/types.js"`
- 删除 `deriveSubagentPermissions` 函数（line 88-158）
- 删除 `createBubbleRequest` 函数（line 165-183）
- 编辑 `subagent/index.ts` 移除这两个函数的 export
- 编辑 `packages/core/src/index.ts` 移除 re-export
- 编辑 `packages/core/__tests__/subagent-permission.test.ts` 移除相关测试

#### 3.10f getEnabledSupervisorCandidates

| 项 | 详情 |
|----|------|
| **未接入代码** | `getEnabledSupervisorCandidates`（[supervisor/pool.ts:181](file:///d:/Proj/covalo/packages/core/src/supervisor/pool.ts)） |
| **性质** | 仅测试使用 |

**修复**：检查是否可以删除。如果 `loadSupervisorPool` 内部已过滤 enabled 候选，`getEnabledSupervisorCandidates` 是冗余的，可删除。编辑 `pool.ts` 移除函数，清理 re-export。

---

### 3.11 🟢 Supervisor 候选池（默认为空，文档化处理）

| 项 | 详情 |
|----|------|
| **未接入代码** | Supervisor 默认候选池所有候选 `enabled: false` |
| **性质** | 默认禁用（设计意图，不是 bug） |
| **严重度** | 🟢 低 |

#### 现象

[pool.ts:71-72](file:///d:/Proj/covalo/packages/core/src/supervisor/pool.ts) 注释明确"所有候选默认禁用，用户必须显式配置 `.covalo/supervisor-pool.json` 才能启用"。

#### 修复方案：文档化处理（不修改代码）

这是 ADV-HAR-04 的设计意图，不是 bug。无需修改代码，但应在用户文档中说明启用方法。

**步骤 1：在 docs/ 中补充 supervisor 配置文档**

创建 `docs/supervisor-configuration.md`，说明：
- 默认所有 supervisor 候选禁用
- 用户需创建 `.covalo/supervisor-pool.json` 启用
- 配置文件格式示例

**步骤 2：清理未接入的 smoke test 函数（可选）**

[smoke.ts](file:///d:/Proj/covalo/packages/core/src/supervisor/smoke.ts) 中的 `runSupervisorSmokeTest`、`runSupervisorPoolSmokeTests`、`isSupervisorSmokeEnabled` 需 `COVALO_SUPERVISOR_SMOKE=1` 才生效，生产从不调用。但它们是诊断工具，保留 export 供 CLI doctor 命令未来使用。

**结论**：保留现状，仅补充文档。

---

### 3.12 🟡 搁置项（3 项）

#### GoalRuntime（未实例化）— ⏸️ 搁置

| 项 | 详情 |
|----|------|
| **未接入代码** | `GoalRuntime` 类（[goal/runtime.ts:16](file:///d:/Proj/covalo/packages/core/src/goal/runtime.ts)） |
| **性质** | 类被 import 但从未实例化 |
| **严重度** | 🟡 中 |

**本项暂不处理，搁置。**

#### Sandbox（主路径未接入）— ⏸️ 搁置

| 项 | 详情 |
|----|------|
| **未接入代码** | Sandbox provider 在常规 CLI/TUI 模式下不生效 |
| **性质** | 仅 eval 路径接入 |
| **严重度** | 🟡 中 |

**本项暂不处理，搁置。**

#### Mailbox 自动化工作流（默认禁用）— ⏸️ 搁置

| 项 | 详情 |
|----|------|
| **未接入代码** | `useMailboxWorkflow: true` 路径（[coordinator.ts:434-519](file:///d:/Proj/covalo/packages/core/src/workflow-coordinator/coordinator.ts)） |
| **性质** | 代码存在但默认禁用 |
| **严重度** | 🟡 中 |

**本项暂不处理，搁置。**

---

## 四、按接入位置的交叉视图

下表展示"未接入项"在代码中的分布，帮助定位修复入口：

| 未接入项 | 定义位置 | 应接入位置 | 接入难度 | 处理方式 | 优先级 |
|----------|----------|------------|----------|----------|--------|
| Two-stage 流程 | tool-routing/two-stage-router.ts | loop.ts:586 + 扩展类型 + loop 内部虚拟工具 | 高 | 重写方案：扩展类型 + 虚拟工具 | P1 |
| QuestionService reply | workflow-coordinator/ | coordinator.ts + bridge.tsx + App.tsx | 中 | 重写方案：解决 requestId 不一致 | P1 |
| SubagentRunner + target/client | subagent/run.ts + engine.ts:1466 | engine.spawnSubagent 迁移 target 解析 | 中 | 先迁移后删除 | P1 |
| `PermissionService` | permission/service.ts | executor-helpers.ts 清理分支 | 中 | 删除或 deprecate | P2 |
| `DualSession` | dual-session/ | 删除或替换 DualAgentRuntime | 高 | 确认无外部依赖后删除 | P2 |
| `task-state.ts` | governance/task-state.ts | engine.ts:1022 切换实现 | 低 | 删除或保留为实验 | P2 |
| Config adapter 函数 | config/adapter.ts | cli/tui.ts 调用适配函数 | 低 | 删除函数 | P2 |
| Memory bridge lifecycle | memory/bridge/ | cli/tui.ts 补回调 或 HookManager | 低 | onPreToolUse 标记 experimental，其余删 | P2 |
| Pricing 未使用函数 | pricing.ts | — | 低 | 删除函数 | P2 |
| 其他死代码 | 多处 | — | 低 | 逐个处理 | P2 |
| ~~`GoalRuntime`~~ | ~~goal/runtime.ts~~ | ~~tui/App.tsx 实例化~~ | ~~中~~ | ⏸️ 搁置 | P3 |
| ~~Sandbox 主路径~~ | ~~sandbox/~~ | ~~cli/tui.ts 初始化 provider~~ | ~~中~~ | ⏸️ 搁置 | P3 |
| ~~Mailbox 工作流~~ | ~~coordinator.ts~~ | ~~启用 useMailboxWorkflow~~ | ~~中~~ | ⏸️ 搁置 | P3 |
| Supervisor 候选池 | supervisor/pool.ts | 文档化 | 低 | 文档化处理 | P3 |

---

## 五、修复执行计划（按优先级重排）

> ⚠️ **方案调整说明**：原文档执行顺序是"先删死代码 → 再修功能 → 最后高风险"。**这是错误的顺序**。第一优先级不应删代码，应先修闭环。否则删除 `SubagentRunner` 会丢失 target/client 能力，删除 `onPreToolUse` 会丢失未来设计点。

### Phase 1：修闭环（高优先级，不删代码先修功能）

| 序号 | 任务 | 涉及文件 | 风险 |
|------|------|----------|------|
| 1.1 | 修复 Two-stage routing（扩展类型 + loop 内部虚拟工具） | tool-routing/two-stage-router.ts, loop.ts | 高 |
| 1.2 | 修复 WorkflowCoordinator ask_user（解决 requestId 不一致 + bridge 接入） | question-service.ts, coordinator.ts, bridge.tsx, App.tsx | 中 |
| 1.3 | 迁移 SubagentRunner target/client 能力到 engine.spawnSubagent + 删除 SubagentRunner | engine.ts, subagent/run.ts, subagent/index.ts, core/index.ts | 中 |

**验证**：每个闭环修复后运行相关测试套件，确认无回归。Phase 1 完成后，3 个真 bug 闭环恢复。

### Phase 2：清理（中低风险，删除死代码）

| 序号 | 任务 | 涉及文件 | 风险 |
|------|------|----------|------|
| 2.1 | 删除或 deprecate `PermissionService`（路径 A 或 B） | permission/, executor-helpers.ts, streaming-executor.ts | 中 |
| 2.2 | 删除 `DualSession` 模块（确认无外部依赖后） | dual-session/, index.ts | 中 |
| 2.3 | 删除或保留 `task-state.ts`（选项 A 或 B） | governance/task-state.ts, index.ts | 低 |
| 2.4 | 删除 Config adapter 未使用函数 | config/adapter.ts | 低 |
| 2.5 | 删除 Pricing 未使用函数 | pricing.ts | 低 |
| 2.6 | 删除 Memory bridge 未调用方法（onPreToolUse 标记 experimental 或补接 HookManager） | covalo-memory-bridge.ts | 低 |
| 2.7 | 删除散落死代码（executeEccHookCommand / mergeBudgetPathSet / LspManager / SUPERVISOR_WORKFLOW_PROMPT / deriveSubagentPermissions / createBubbleRequest / getEnabledSupervisorCandidates） | 多处 | 低 |

**验证**：每个删除后运行 typecheck，确认无类型错误。不要把所有删除混在一个大 PR 里，逐项或分组提交。

### Phase 3：文档化保留项（不修改代码）

| 序号 | 任务 | 涉及文件 | 风险 |
|------|------|----------|------|
| 3.1 | 补充 Supervisor 配置文档 | docs/supervisor-configuration.md（新增） | 无 |
| 3.2 | Mailbox workflow 默认禁用说明 | docs/（现有文档补充） | 无 |
| 3.3 | GoalRuntime 未实例化说明 | docs/（现有文档补充） | 无 |
| 3.4 | Sandbox 主路径未接入说明 | docs/（现有文档补充） | 无 |

**验证**：文档审阅。

---

## 六、再审核最终验收意见

### 总体评价

这份文档**可以作为审计报告使用**，但**不应直接作为 patch 指南执行**。它的问题识别准确率较高，但修复方案偏"删除导向"，对运行时闭环、API 兼容、未来路线和内部协议工具的处理不够细。

### 需要重写方案的项目（2 项）

1. **Two-stage routing**：原文档方案方向对，但实现方式需要调整
   - 事实错误：`ToolRoutingMode` 当前类型只有 `"direct" | "two_stage"`，没有 `"auto"`
   - 不应注册 `select_category` 到 `createDefaultTools()`，应作为 loop 内部协议工具
   - 已在 3.1 重写方案

2. **QuestionService reply 链**：原文档方案有 bug
   - requestId 不一致问题没有解决
   - bridge 没有事件订阅器，不能使用 `bridgeRef.current?.on?.("ask_user")`
   - `respondQuestion` 没有转发到 workflowCoordinator
   - 已在 3.2 重写方案

### 需要调整方案的项目（3 项）

1. **SubagentRunner**：删除前必须把独立 target/client 能力迁移到生产 `engine.spawnSubagent()`，否则会继续保留当前生产路径的能力缺口。已在 3.3 调整方案。

2. **PermissionService**：删除属于 API 破坏，需根据 API 稳定性选择路径 A（直接删）或路径 B（先 deprecate）。已在 3.4 调整方案。

3. **Memory bridge lifecycle**：不建议直接删 `onPreToolUse`，更适合标记为 `@internal experimental` 或补接 HookManager 的 beforeToolCall。已在 3.8 调整方案。

### 准确的项目（6 项）

- DualSession 删除：基本合理，需确认无外部 API 依赖
- task-state.ts 删除：基本合理，可选保留为实验函数
- Config adapter 函数删除：合理
- Pricing 函数删除：合理
- 散落死代码删除：合理，但不要批量删除
- Supervisor 候选池文档化：正确（不是 bug）

### 执行顺序调整

原文档"先删死代码 → 再修功能 → 最后高风险"的顺序是错误的。正确顺序是：
1. **Phase 1 修闭环**（不删代码先修功能，避免丢失能力）
2. **Phase 2 清理**（删除死代码，逐项或分组提交）
3. **Phase 3 文档化**（保留项补充文档）

---

## 七、方法论说明

### 审计方法

1. **关键词搜索**：对每个功能域用 Grep 搜索主要 export 的 import 和实例化点
2. **调用链验证**：对每个"已接入"结论，验证从 cli/tui.ts → engine.ts → loop.ts 的完整调用链
3. **实例化核查**：对每个类，Grep `new ClassName\(` 全仓库，确认是否仅命中测试文件
4. **死代码识别**：对每个 export，Grep 其函数名在全仓库非测试代码中的调用点
5. **设计意图区分**：通过代码注释和设计文档区分"设计意图禁用"与"实现未完成"

### 再审核方法

1. **逐项核验**：对原文档每一项，重新 Grep 验证代码状态
2. **方案可行性分析**：对每个修复方案，分析其在当前代码结构下是否可执行
3. **API 兼容性检查**：对涉及 export 删除的方案，检查是否有外部依赖
4. **运行时闭环验证**：对声称"修闭环"的方案，追踪完整调用链是否真的闭合
5. **内部协议工具识别**：区分"普通工具"和"路由器内部协议工具"，避免污染工具空间

### 局限性

- 本审计基于代码静态分析，未运行动态 profiling
- "默认禁用"的模块（如 supervisor 候选池）在用户显式配置后可正常工作，不算 bug
- 部分模块可能通过 plugin 系统动态加载，本审计未覆盖运行时插件注入的情况
- TUI 交互层（App.tsx）的某些状态机分支未深入验证
- 再审核未对 Sandbox 主路径做完整核验，搁置处理

### 与 self_harness_audit_20260703.md 的关系

本报告是对 [self_harness_audit_20260703.md](file:///d:/Proj/covalo/docs/self_harness_audit_20260703.md) 的补充。self-harness 审计已覆盖 `harness-evolution/` 模块的接入状态，本报告覆盖其余所有模块。两份报告合起来构成项目完整的"未接入功能"全景。
