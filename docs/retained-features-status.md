# 搁置功能状态说明

最后更新：2026-07-03。

本文件说明 Covalo 中存在但**未接入生产路径**或**默认禁用**的功能模块。这些功能保留代码是出于未来路线图考虑，但当前不影响正常运行。本文档对应 `docs/unintegrated_code_audit_20260703.md` §3.12 的搁置项。

## 概览

| 功能 | 状态 | 严重度 | 处理方式 |
|------|------|--------|----------|
| Mailbox 自动化工作流 | 代码存在，默认禁用 | 🟡 中 | 文档化，保留 |
| GoalRuntime | 类已定义，从未实例化 | 🟡 中 | 文档化，保留 |
| Sandbox 主路径 | 仅 eval 路径接入 | 🟡 中 | 文档化，保留 |

---

## 1. Mailbox 自动化工作流（默认禁用）

### 现状

`WorkflowCoordinator` 支持 `useMailboxWorkflow` 选项，启用后 Supervisor 与 Worker 之间通过 `Mailbox` 异步收发消息，而非通过 coordinator state 同步传递 plan/report。

**默认禁用**：`useMailboxWorkflow` 在 [coordinator.ts:69](../packages/core/src/workflow-coordinator/coordinator.ts) 中默认为 `false`。当前所有生产调用点都不传入此选项，因此 Mailbox 路径虽然代码完整，但从不执行。

### 涉及代码

| 文件 | 作用 |
|------|------|
| [packages/core/src/workflow-coordinator/coordinator.ts](../packages/core/src/workflow-coordinator/coordinator.ts) | `useMailboxWorkflow` 分支（line 442, 454, 506, 518） |
| [packages/core/src/agent-comm/](../packages/core/src/agent-comm/) | `Mailbox` 和 `AgentCommController` 实现 |

### 启用条件

Mailbox workflow 在以下场景可考虑启用：

- 需要异步解耦 Supervisor 和 Worker 的通信
- 需要消息持久化和重放
- 需要多 Worker 并发处理不同 task

启用方式：构造 `WorkflowCoordinator` 时传入 `useMailboxWorkflow: true` 和 `mailbox` 实例。但**当前没有生产代码这样做**，启用前需要验证：

1. `AgentCommController` 的生命周期管理
2. Mailbox 消息的清理机制
3. 与 `WorkflowCoordinator` 状态机的一致性

### 保留原因

- 代码完整且经过测试，删除会造成未来重新实现的成本
- 异步消息传递是未来多 Worker 架构的基础
- 默认禁用不影响生产路径的稳定性和性能

---

## 2. GoalRuntime（未实例化）

### 现状

`GoalRuntime` 类在 [goal/runtime.ts:16](../packages/core/src/goal/runtime.ts) 中定义，提供 goal 自动续跑、token budget 限制和错误恢复能力。但该类**从未在生产代码中实例化**，仅在测试文件 [goal-runtime.test.ts](../packages/core/__tests__/goal-runtime.test.ts) 中使用。

### 设计意图

`GoalRuntime` 的设计目标是：

- **自动续跑**：当 engine 进入 idle 状态时，检查是否有 active goal，若有则自动触发下一轮 workflow
- **Token budget 限制**：当 goal 的 token 使用量超过预算时，设置 `budget_limited` 状态并发送 budget limit 提示
- **错误恢复**：跟踪连续错误次数，超过阈值时停止续跑

### 涉及代码

| 文件 | 作用 |
|------|------|
| [packages/core/src/goal/runtime.ts](../packages/core/src/goal/runtime.ts) | `GoalRuntime` 类定义 |
| [packages/core/src/goal/store.ts](../packages/core/src/goal/store.ts) | `GoalStore` — goal 持久化（**已接入生产**） |
| [packages/core/src/goal/steering.ts](../packages/core/src/goal/steering.ts) | budget/usage limit 提示构建（**已接入生产**） |

### 未接入原因

`GoalRuntime` 需要在 TUI/CLI 的 engine idle 回调中实例化并调用 `onEngineIdle()` 和 `continueGoal()`。当前 TUI 的 [App.tsx](../packages/tui/src/App.tsx) 没有创建 `GoalRuntime` 实例，engine idle 时不会自动续跑 goal。

### 接入步骤（未来）

1. 在 TUI 初始化时创建 `GoalRuntime` 实例，注入 `GoalStore` 和 `WorkflowCoordinator`
2. 在 engine idle 事件回调中调用 `runtime.onEngineIdle(threadId)`
3. 若返回 `true`，调用 `runtime.continueGoal(threadId)` 并消费产生的 `WorkflowEvent`
4. 配置 `GoalRuntimeConfig`（`maxAutoContinuations` / `maxConsecutiveTurnErrors`）

### 保留原因

- `GoalStore` 和 `steering.ts` 已接入生产，`GoalRuntime` 是它们之上的薄层编排
- 自动续跑是 goal 导向工作流的核心能力，未来路线图会接入
- 代码经过测试，删除会丢失经过验证的逻辑

---

## 3. Sandbox 主路径（仅 eval 接入）

### 现状

Covalo 提供两个 Sandbox provider：

- **`BwrapProvider`** — 基于 bubblewrap 的 OS 级沙箱（Linux）
- **`SoftWorkspaceProvider`** — 软工作空间（目录隔离，无 OS 级强制）

这两个 provider **仅在 `covalo eval` 命令路径中初始化和使用**。常规 CLI/TUI 模式下不初始化任何 sandbox provider，工具调用直接在主机环境执行。

### 涉及代码

| 文件 | 作用 |
|------|------|
| [packages/core/src/sandbox/provider-registry.ts](../packages/core/src/sandbox/provider-registry.ts) | provider 注册和检测 |
| [packages/core/src/sandbox/bwrap.ts](../packages/core/src/sandbox/bwrap.ts) | bubblewrap provider |
| [packages/core/src/sandbox/soft-workspace.ts](../packages/core/src/sandbox/soft-workspace.ts) | 软工作空间 provider |
| [packages/core/src/sandbox/exec.ts](../packages/core/src/sandbox/exec.ts) | sandbox 内执行命令 |
| [packages/cli/src/commands/eval.ts](../packages/cli/src/commands/eval.ts) | eval 命令（**唯一接入点**） |

### 未接入原因

Sandbox 主路径接入属于**产品安全策略决策**，而非实现遗漏：

- **性能考虑**：sandbox 初始化和命令代理有开销，不适合所有用户场景
- **平台差异**：`bwrap` 仅 Linux 可用，Windows/macOS 需要不同方案
- **用户选择**：部分用户在受控环境中运行 Covalo，不需要额外 sandbox
- **依赖外部工具**：`bwrap` 需要系统安装，postinstall 脚本会尝试下载但可能失败

### 启用条件（未来）

如果要在常规 CLI/TUI 模式下启用 sandbox，需要：

1. 在 `cli/tui.ts` 初始化时调用 `initDefaultProviders()`
2. 配置 `BashTool` / `ExecTool` 使用 `execInSandbox()` 而非直接 `child_process.exec`
3. 提供配置选项让用户选择 sandbox 模式（`none` / `soft-workspace` / `bwrap`）
4. 处理 Windows/macOS 的降级路径（fallback 到 `soft-workspace` 或禁用）

### 保留原因

- eval 路径已证明 sandbox 实现可用
- `SoftWorkspaceProvider` 可跨平台，未来可作为默认 sandbox
- 删除会丢失经过 eval 验证的沙箱能力

---

## 相关文档

- [Supervisor 候选池配置](./supervisor-configuration.md) — Supervisor 默认禁用机制说明
- [未接入代码审计报告](./unintegrated_code_audit_20260703.md) — 完整的未接入功能审计（含已处理的 Phase 1/2 项）
- [Self-harness 审计报告](./self_harness_audit_20260703.md) — `harness-evolution/` 模块的接入状态审计
