# Covalo Runtime Boundary Refactor SPEC

**目标项目**: `bzcsk2/covalo`  
**适用基线**: 当前 `main`，2026-07-06 本地复核  
**文档性质**: 面向 coding agent 的实施规格书  
**核心目标**: 用绞杀式迁移收缩旧 `core`，建立清晰的 runtime/protocol 边界；每一步保持行为兼容、测试通过、可独立 review。

---

## 0. 给执行 agent 的总指令

你要在 `covalo` 仓库中执行一组渐进式重构。不要新写一个内核，不要把代码搬到长期大分支后再一次性合并。正确做法是：开一条重构主线，然后用小 PR 逐步收缩旧边界。

必须遵守：

1. **先读代码再改代码**。本文档记录的是当前复核结果，但实现前仍要确认文件结构、类型定义、测试命令没有变化。
2. **每个 PR 只解决一种边界问题**。不要在协议抽取时顺手改 prompt、工具行为、UI 文案、权限策略。
3. **先移动，再改名**。文件迁移和语义重命名分开做。
4. **保留兼容 re-export**。协议类型迁出后，`@covalo/core` 必须继续 re-export 一段时间，避免一次性改爆外部 API。
5. **每一步都必须可运行、可测试、可回滚**。
6. **不要在重构阶段新增功能**。功能变更会污染行为判断。
7. **不要把 `@covalo/protocol` 做成新的大 `core`**。只放跨包稳定契约，不放 engine runtime、provider client、eval、workflow 实现。

最终每个 PR 至少执行：

```bash
bun run typecheck
bun run test
bun run build
bun run smoke:cli
bun run pack:dry-run
```

如果某个命令在基线本来就失败，最终报告必须列出：命令、失败摘要、是否与本 PR 相关。

---

## 1. 当前架构事实

### 1.1 已确认的循环依赖

当前 `@covalo/core` 和 `@covalo/tools` 互相依赖：

- `packages/core/package.json` 依赖 `@covalo/tools`
- `packages/tools/package.json` 依赖 `@covalo/core`

除此之外，`core` 源码里还有运行时动态导入：

- `packages/core/src/engine.ts` 在 session 切换时导入 `disposeBackgroundTaskManagerFor`
- `packages/core/src/engine.ts` 在 shutdown 时导入 `disposeBackgroundTaskManagerFor`
- `packages/core/src/engine.ts` 在 effective shell policy 变化时导入 `createBashTool`

所以第一阶段不能只做类型 import 替换，还必须处理 `core -> tools` 的运行时依赖，否则 `core/package.json` 无法真正删除 `@covalo/tools`。

### 1.2 当前类型耦合点

`packages/core/src/interface.ts` 同时包含多种层级的类型：

- 工具协议：`AgentTool`, `ToolContext`, `ToolResult`, `ToolTier`, `ToolConcurrency`, `ToolProgressUpdate`
- loop/event：`LoopEvent`, `OrchestrationEventPayload`
- engine 状态：`AgentState`, `SessionStats`, `CoreEngine`
- provider client：`ChatClient`

`packages/core/src/types.ts` 包含：

- `Role`
- `ChatMessage`
- `ToolCall`
- `ToolSpec`
- `Usage`

当前 `packages/tools`、`packages/plugin`、`packages/mcp` 都从 `@covalo/core` 读取部分工具协议类型。第一阶段应优先打断这些依赖。

### 1.3 不应第一批迁出的类型

以下类型不要在第一批强行迁入 `@covalo/protocol`：

- `ChatClient`: 当前依赖 `DeepSeekStreamEvent` 和 `DeepSeekClientOptions`，这是 provider/client contract，不是纯协议。
- `LoopEvent`: 当前混有 orchestration、runtime UI、checkpoint 等事件，迁出前应先拆清事件边界。
- `SessionStats`: 当前是 engine runtime stats，可以暂留 `core`。
- `CoreEngine`, `AgentState`: 属于 core runtime facade，第一阶段不迁。
- eval、workflow、harness、checkpoint、model profile 相关类型：暂留 `core`。

---

## 2. 推荐分支策略

不要使用一个长期大分支连续重建数周。推荐：

```bash
git checkout main
git pull
git checkout -b refactor/runtime-boundary
```

`refactor/runtime-boundary` 只作为重构主线。每个阶段从它切小分支：

```bash
git checkout -b refactor/protocol-boundary
git checkout -b refactor/core-tools-runtime-decoupling
git checkout -b refactor/cli-bootstrap
git checkout -b refactor/engine-runtime-services
git checkout -b refactor/loop-policies
git checkout -b refactor/tui-controllers
```

每个小分支独立测试、独立 review，合回 `refactor/runtime-boundary`。重构主线稳定后再逐步合回 `main`。

---

## 3. 总体 PR 拆分

| PR | 名称 | 目标 | 行为变化 |
|---|---|---|---|
| PR-1 | Protocol Boundary | 新增 `@covalo/protocol`，迁出稳定协议类型，`tools/plugin/mcp` 改依赖 protocol | 无 |
| PR-2 | Core Tools Runtime Decoupling | 移除 `core` 对 `@covalo/tools` 的运行时动态导入 | 无 |
| PR-3 | CLI Bootstrap Split | 拆分 `packages/cli/src/tui.ts` 的装配逻辑 | 无 |
| PR-4 | Engine Runtime Services | 将 `ReasonixEngine` 内部状态拆成 runtime services，public API 不变 | 无 |
| PR-5 | Loop Policy Pipeline | 把 `runLoop` 中的策略拆成 policy pipeline | 无或极小 |
| PR-6 | TUI Controllers | 瘦身 `App.tsx` 和 `bridge.tsx` | 无 |

PR-1 和 PR-2 可以连续做，但不要合成一个巨大 PR。PR-1 先解决下游包对 `core` 类型的依赖；PR-2 再解决 `core` 对具体工具实现的运行时依赖。

---

## 4. PR-1：Protocol Boundary

### 4.1 目标

新增底层包：

```text
packages/protocol
  package.json
  src/index.ts
  src/messages.ts
  src/tools.ts
  src/question.ts
  src/subagent.ts
```

目标依赖方向：

```text
@covalo/protocol
  ↑
  ├─ @covalo/core
  ├─ @covalo/tools
  ├─ @covalo/plugin
  └─ @covalo/mcp
```

完成后：

- `packages/tools` 不再依赖 `@covalo/core`
- `packages/plugin` 中只需要工具协议的模块不再依赖 `@covalo/core`
- `packages/mcp` 中只需要工具协议的模块不再依赖 `@covalo/core`
- `@covalo/core` 继续 re-export 被迁出的类型，保持兼容

### 4.2 迁移类型清单

第一批只迁这些类型：

```text
Role
ChatMessage
ToolCall
ToolSpec
Usage

ToolTier
ToolConcurrency
AgentTool
ToolContext
ToolProgressUpdate
ToolResult

QuestionOption
QuestionInfo
QuestionAnswer

SubagentRunOptions
SubagentRunResult
SubagentRunUsage
```

说明：

- `ToolContext.askUser` 需要 `QuestionInfo/QuestionAnswer`，所以 question 基础类型一起迁。
- `ToolContext.spawnSubagent` 需要 `SubagentRunOptions/SubagentRunResult`，所以 subagent run contract 一起迁。
- 不迁 `QuestionRequest`，因为它是 core question service 的 runtime request，不是工具协议必需类型。
- 不迁 `SubagentDefinition`、`SubagentRunStoreEntry`，因为它们偏 core runtime/registry。

### 4.3 新包 package.json

创建 `packages/protocol/package.json`：

```json
{
  "name": "@covalo/protocol",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    },
    "./*": {
      "types": "./src/*.ts",
      "import": "./src/*.ts"
    }
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {}
}
```

### 4.4 tsconfig paths

更新根 `tsconfig.json`：

```json
"@covalo/protocol": ["./packages/protocol/src/index.ts"],
"@covalo/protocol/*": ["./packages/protocol/src/*"]
```

### 4.5 文件内容边界

`packages/protocol/src/messages.ts`：

- `Role`
- `ChatMessage`
- `ToolCall`
- `ToolSpec`
- `Usage`

`packages/protocol/src/question.ts`：

- `QuestionOption`
- `QuestionInfo`
- `QuestionAnswer`

`packages/protocol/src/subagent.ts`：

- `SubagentRunOptions`
- `SubagentRunResult`
- `SubagentRunUsage`

`packages/protocol/src/tools.ts`：

- `ToolTier`
- `ToolConcurrency`
- `AgentTool`
- `ToolContext`
- `ToolProgressUpdate`
- `ToolResult`

`ToolContext` 不得 import `core`。它只能 import `QuestionInfo/QuestionAnswer` 和 `SubagentRunOptions/SubagentRunResult` from `@covalo/protocol` local files.

`packages/protocol/src/index.ts` re-export 全部协议类型。

### 4.6 core 兼容层

更新 `packages/core/src/types.ts`：

- 从 `@covalo/protocol` re-export `Role/ChatMessage/ToolCall/ToolSpec/Usage`
- 不再本地维护重复定义，避免定义漂移

更新 `packages/core/src/interface.ts`：

- 从 `@covalo/protocol` import/re-export 工具协议类型
- 保留 `LoopEvent`, `SessionStats`, `CoreEngine`, `AgentState`, `ChatClient` 在 core
- 确保 `@covalo/core` 仍然能导出旧 API 名称

推荐形态：

```ts
export type {
  AgentTool,
  ToolContext,
  ToolResult,
  ToolProgressUpdate,
  ToolTier,
  ToolConcurrency,
} from "@covalo/protocol"
```

如果本文件内部需要使用这些类型，再单独 `import type`。

### 4.7 tools import 替换

将 `packages/tools/src/**/*.ts` 中的以下导入：

```ts
import type { AgentTool } from "@covalo/core"
import type { AgentTool, ToolContext, ToolProgressUpdate } from "@covalo/core"
import type { ToolSpec } from "@covalo/core"
import type { QuestionInfo } from "@covalo/core"
```

替换为：

```ts
import type {
  AgentTool,
  ToolContext,
  ToolProgressUpdate,
  ToolSpec,
  QuestionInfo,
} from "@covalo/protocol"
```

不要改工具执行行为。

更新 `packages/tools/package.json`：

- 删除 `@covalo/core`
- 增加 `@covalo/protocol`

### 4.8 plugin import 替换

只替换纯工具协议类型：

- `packages/plugin/src/tool-adapter.ts`
- `packages/plugin/src/engine-tool-adapter.ts`
- `packages/plugin/src/runtime.ts` 中的 `ToolSpec`

如果某个文件还需要 `AgentDefinition` 等 core 类型，暂时保留 `@covalo/core`，不要为了清依赖强行迁移 agent profile/domain 类型。

原则：

- `ToolSpec`, `AgentTool`, `ToolResult`, `ToolContext` -> `@covalo/protocol`
- `AgentDefinition` 等 agent/content-pack runtime 类型 -> 暂留 `@covalo/core`

### 4.9 mcp import 替换

将 `packages/mcp/src/*` 中的 `AgentTool` 改从 `@covalo/protocol` 导入。

注意：`packages/mcp` 当前还从 `@covalo/tools` 使用：

- `safeStringify`
- `terminateProcessTree`
- `normalizePlatform`

这些不是 PR-1 的目标。PR-1 不要求 `mcp` 删除 `@covalo/tools`。

### 4.10 PR-1 验收

必须满足：

```bash
rg -n "import type \\{.*AgentTool|import type \\{.*ToolSpec|from ['\"]@covalo/core['\"]" packages/tools/src
```

结果中不应再出现 `packages/tools/src` 从 `@covalo/core` 导入工具协议类型。

同时：

```bash
bun run typecheck
bun run test
bun run build
bun run smoke:cli
bun run pack:dry-run
```

`packages/tools/package.json` 不再依赖 `@covalo/core`。

---

## 5. PR-2：Core Tools Runtime Decoupling

### 5.1 目标

移除 `packages/core` 对 `@covalo/tools` 的运行时依赖。完成后：

- `packages/core/package.json` 删除 `@covalo/tools`
- `core/src/engine.ts` 不再 `import("@covalo/tools")`
- 具体工具生命周期由 CLI/runtime 装配层注入，而不是 core 反向知道 tools

### 5.2 当前阻塞点

`ReasonixEngine` 当前在三个地方动态导入 tools：

1. session 切换时 dispose background task manager
2. shutdown 时 dispose background task manager
3. effective shell policy 为 dual-track 时创建新的 bash tool

这三个点本质上都是“工具 runtime lifecycle/service”，不应由 core 直接导入具体工具包。

### 5.3 推荐设计：ToolRuntimeHooks

在 `packages/core/src/engine.ts` 或独立文件 `packages/core/src/tool-runtime-hooks.ts` 中定义：

```ts
import type { AgentTool } from "@covalo/protocol"

export interface ToolRuntimeHooks {
  disposeSessionTools?: (sessionId: string) => void | Promise<void>
  createShellToolForPolicy?: (policy: "dual-track" | "dual-track-conservative") => AgentTool | Promise<AgentTool>
}
```

给 `ReasonixEngine` 增加可选 hooks：

```ts
export interface ReasonixEngineOptions {
  toolRuntimeHooks?: ToolRuntimeHooks
}
```

如果当前 constructor 已有参数，保持向后兼容，优先采用可选对象扩展，不要破坏现有调用点。

必须保持这些路径可用：

```ts
new ReasonixEngine(config, clearReadTracker)
ReasonixEngine.recover(config, sessionId)
```

可以采用重载或第三个/第四个可选参数，但要避免让调用点含义混乱。推荐最终形态：

```ts
new ReasonixEngine(config, clearReadTracker, sessionId, { toolRuntimeHooks })
```

若现有第三参已经是 `sessionId`，不要改变其语义。

### 5.4 CLI 注入 hooks

在 `packages/cli/src/tui.ts` 中创建 hooks：

```ts
const toolRuntimeHooks = {
  disposeSessionTools: disposeBackgroundTaskManagerFor,
  createShellToolForPolicy: (policy) => createBashTool({
    dualTrack: true,
    conservative: policy === "dual-track-conservative",
  }),
}
```

创建或 recover engine 时传入 hooks。

注意：`ReasonixEngine.recover()` 也要能接收 hooks，否则恢复 session 的 engine 仍无法处理 shutdown/session switch lifecycle。

### 5.5 engine fallback 行为

替换原动态导入逻辑：

```ts
await this.toolRuntimeHooks?.disposeSessionTools?.(this.sessionId)
```

如果 hook 不存在：

- 不抛错
- 记录 debug/warn 只在 logger 开启时执行
- 保持 best-effort 语义

替换 bash 重建逻辑：

```ts
const shellTool = await this.toolRuntimeHooks?.createShellToolForPolicy?.(this.effectivePolicy.shellPolicy)
if (shellTool) this.tools.set("bash", shellTool)
```

如果 hook 不存在：

- 保留当前已注册 bash tool
- 不抛错
- 记录 debug/warn

### 5.6 PR-2 验收

必须满足：

```bash
rg -n "@covalo/tools" packages/core/src packages/core/package.json
```

结果为空。

同时：

```bash
bun run typecheck
bun run test
bun run build
bun run smoke:cli
bun run pack:dry-run
```

补充测试建议：

- core 单元测试：构造带 fake `disposeSessionTools` hook 的 engine，调用 `loadSession()` 后确认旧 session id 被 dispose。
- core 单元测试：构造带 fake `createShellToolForPolicy` hook 的 engine，在 effective policy 为 dual-track 时确认 `bash` 被替换。
- CLI smoke：`node ./dist/index.js --help`。

---

## 6. PR-3：CLI Bootstrap Split

### 6.1 目标

拆分 `packages/cli/src/tui.ts` 的装配逻辑，不改业务行为。

当前 `tui.ts` 同时负责：

- config/global config manager
- MCP host
- engine 创建与 session recover
- shell backend/platform
- prompt locale
- plugin runtime
- default tools
- goal/mailbox tools
- LSP pool
- dual runtime
- workflow coordinator
- pipe mode
- TUI render
- shutdown/lifecycle

目标是把入口文件收敛成清晰的装配流程。

### 6.2 目标目录

```text
packages/cli/src/bootstrap/config.ts
packages/cli/src/bootstrap/mcp.ts
packages/cli/src/bootstrap/plugins.ts
packages/cli/src/bootstrap/tools.ts
packages/cli/src/bootstrap/tool-runtime-hooks.ts
packages/cli/src/bootstrap/dual-runtime.ts
packages/cli/src/bootstrap/workflow.ts
packages/cli/src/bootstrap/lifecycle.ts
packages/cli/src/runtime/create-covalo-runtime.ts
packages/cli/src/modes/pipe.ts
packages/cli/src/modes/tui.ts
```

### 6.3 目标入口形态

`packages/cli/src/tui.ts` 最终应接近：

```ts
async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printHelp()
    return
  }

  const runtime = await createCovaloRuntime({
    cwd: process.cwd(),
    argv: process.argv,
    input,
    output,
    errorOutput,
  })

  if (!process.stdin.isTTY) {
    await runPipeMode(runtime)
    return
  }

  await runTuiMode(runtime)
}
```

### 6.4 拆分规则

- 只移动代码，不改逻辑。
- 每个 extracted function 必须返回明确对象，不使用隐式全局。
- 不要一次性重命名大量变量。
- 不要更改 help 文案。
- 不要更改 pipe mode 与 TUI mode 的分支条件。
- 不要更改 plugin/MCP load 的错误处理语义。

### 6.5 Runtime 类型

创建内部类型：

```ts
export interface CovaloRuntime {
  config: DeepreefConfig
  engine: ReasonixEngine
  mcpHost: McpHost
  mcpLoadPromise: Promise<void>
  pluginRuntime: PluginRuntime
  workflowCoordinator?: WorkflowCoordinator
  dualRuntime?: DualAgentRuntime
  lspPool?: LspClientPool
  promptLocale: PromptLocale
  rebuildBaseSystemPrompt: (locale?: PromptLocale) => string
  shutdown: () => Promise<void>
}
```

实际字段以当前代码为准，不要过度抽象。字段只服务 CLI/TUI 装配，不对外公开。

### 6.6 PR-3 验收

必须满足：

- `packages/cli/src/tui.ts` 行数明显下降，推荐低于 150 行。
- pipe mode 行为保持。
- TUI mode 能启动。
- `--help` 输出保持。

执行：

```bash
bun run typecheck
bun run test
bun run build
node ./dist/index.js --help
printf "hello\n" | node ./dist/index.js
```

如果 pipe smoke 需要 API key 或外部服务，不要强行联网；记录阻塞原因。

---

## 7. PR-4：Engine Runtime Services

### 7.1 目标

拆 `ReasonixEngine` 内部职责，但保持 public API 不变。

不得改变：

```ts
engine.submit()
engine.registerTool()
engine.updateConfig()
engine.recover()
engine.shutdown()
engine.respondPermission()
engine.respondQuestion()
engine.interrupt()
```

### 7.2 当前问题

`ReasonixEngine` 同时管理：

- context
- client
- tools
- session writer/loader
- permission
- hooks
- question
- subagent
- task ledger
- verification gate
- supervisor guidance
- checkpoint
- mode decision
- branch budget
- pending instruction queue
- orchestration events

这使得后续 self-harness、eval、worker pool、router、supervisor pool 都会继续挤进 engine。

### 7.3 推荐拆分

新增内部 runtime services：

```text
packages/core/src/engine-runtime/session-runtime.ts
packages/core/src/engine-runtime/tool-runtime.ts
packages/core/src/engine-runtime/governance-runtime.ts
packages/core/src/engine-runtime/supervisor-runtime.ts
packages/core/src/engine-runtime/instruction-runtime.ts
```

建议职责：

`EngineSessionRuntime`

- `sessionId`
- `sessionWriter`
- `loadSession/recover`
- `stats`
- `checkpointEngine`
- session switch lifecycle

`EngineToolRuntime`

- `tools`
- `toolExecutor`
- `permissionEngine`
- `hookManager`
- `registerTool`
- permission request/reply
- `ToolRuntimeHooks`

`EngineGovernanceRuntime`

- harness strictness
- effective policy
- branch budget
- verification gate
- mode decision
- read-before-write tracker state

`EngineSupervisorRuntime`

- supervisor guidance
- child engines/subagents
- delegated events
- orchestration event emit

`EngineInstructionRuntime`

- pending instruction queue
- enqueue/take instruction
- instruction continuation limits

### 7.4 拆分策略

不要一次性改 `submit()` 主流程。推荐顺序：

1. 先抽纯 state/helper，不改调用顺序。
2. 再把 session lifecycle 迁到 `EngineSessionRuntime`。
3. 再把 tool/permission runtime 迁到 `EngineToolRuntime`。
4. 最后拆 governance/supervisor。

每一步都要能单独 typecheck。

### 7.5 PR-4 验收

必须满足：

- public API 不变。
- 现有 core/tui/cli 测试通过。
- `ReasonixEngine` 行数下降，推荐至少下降 25%。
- 新 runtime services 有最小单元测试或现有测试覆盖。

执行：

```bash
bun run typecheck
bun test packages/core
bun test packages/tui
bun run build
bun run smoke:cli
```

---

## 8. PR-5：Loop Policy Pipeline

### 8.1 目标

把 `runLoop` 从策略大杂烩收缩为 core loop + policies。

当前 `LoopOptions` 已包含：

- tool routing
- verification policy
- branch budget
- checkpoint
- mode decision
- supervisor guidance
- effective harness policy
- task ledger
- early stop

这说明 `runLoop` 已经不再是纯 loop。

### 8.2 目标目录

```text
packages/core/src/loop/core-loop.ts
packages/core/src/loop/policy.ts
packages/core/src/loop/policies/tool-routing-policy.ts
packages/core/src/loop/policies/checkpoint-policy.ts
packages/core/src/loop/policies/branch-budget-policy.ts
packages/core/src/loop/policies/verification-gate-policy.ts
packages/core/src/loop/policies/supervisor-guidance-policy.ts
packages/core/src/loop/policies/execution-mode-policy.ts
packages/core/src/loop/index.ts
```

### 8.3 Policy hook contract

定义内部接口：

```ts
export interface LoopPolicy {
  name: string
  beforeTurn?(ctx: LoopPolicyContext): Promise<void> | void
  beforeModelCall?(ctx: LoopPolicyContext): Promise<void> | void
  afterModelDelta?(ctx: LoopPolicyContext, delta: unknown): Promise<void> | void
  beforeToolBatch?(ctx: LoopPolicyContext): Promise<void> | void
  afterToolResult?(ctx: LoopPolicyContext): Promise<void> | void
  beforeFinal?(ctx: LoopPolicyContext): Promise<void> | void
  afterDone?(ctx: LoopPolicyContext): Promise<void> | void
  onError?(ctx: LoopPolicyContext, error: unknown): Promise<void> | void
}
```

`LoopPolicyContext` 必须是内部类型，先不要导出给外部用户。

### 8.4 迁移顺序

不要一次性把所有策略拆完。推荐：

1. `checkpoint-policy`
2. `branch-budget-policy`
3. `verification-gate-policy`
4. `tool-routing-policy`
5. `supervisor-guidance-policy`
6. `execution-mode-policy`

每迁一个 policy，都要跑 core tests。

### 8.5 兼容层

保留原 `runLoop(opts: LoopOptions)` API。内部可以把旧 options 转换成 policies：

```ts
export async function* runLoop(opts: LoopOptions): AsyncGenerator<LoopEvent> {
  return yield* runCoreLoop({
    ...legacyLoopOptionsToCoreLoopOptions(opts),
    policies: createDefaultPoliciesFromLoopOptions(opts),
  })
}
```

外部调用点不应在 PR-5 中大改。

### 8.6 PR-5 验收

必须满足：

- `runLoop` 对外签名兼容。
- 核心行为测试通过。
- 每个 policy 有单元测试或通过现有 loop 测试覆盖。

执行：

```bash
bun run typecheck
bun test packages/core
bun run build
```

---

## 9. PR-6：TUI Controllers

### 9.1 目标

在 core/runtime 边界稳定后，瘦身 TUI。不要早于 PR-4/PR-5 做。

当前 `packages/tui/src/App.tsx` 和 `packages/tui/src/bridge.tsx` 都过厚：

- `App.tsx` 持有模型、会话、agent、语言、thinking、skill、context、harness、workflow、autocomplete、eval、worker detail 等状态。
- `bridge.tsx` 同时处理 submit queue、permission、question、workflow、transcript、eval。

### 9.2 App hooks

建议拆：

```text
packages/tui/src/controllers/useOverlayState.ts
packages/tui/src/controllers/useRoleModelState.ts
packages/tui/src/controllers/useGlobalInterrupt.ts
packages/tui/src/controllers/useWorkflowUiState.ts
packages/tui/src/controllers/useEvalRunner.ts
packages/tui/src/controllers/useCommandSubmit.ts
```

### 9.3 Bridge adapters

建议拆：

```text
packages/tui/src/bridge/BridgeSubmitQueue.ts
packages/tui/src/bridge/BridgeTranscriptAdapter.ts
packages/tui/src/bridge/BridgePermissionAdapter.ts
packages/tui/src/bridge/BridgeQuestionAdapter.ts
packages/tui/src/bridge/BridgeWorkflowAdapter.ts
packages/tui/src/bridge/BridgeEvalAdapter.ts
```

### 9.4 拆分规则

- 不改 UI 文案。
- 不改 keyboard/command 行为。
- 不改 workflow mode semantics。
- 不改 eval flow。
- 不引入新状态管理库。
- 每次只抽一个 controller/adapter。

### 9.5 PR-6 验收

执行：

```bash
bun run typecheck
bun test packages/tui
bun test packages/core
bun run build
```

如果有 TUI smoke/e2e 脚本，也要运行。

---

## 10. 迁移约束和反模式

### 10.1 禁止事项

不要做：

- 不要新建 `core-v2`。
- 不要把 `engine.ts` 复制一份再慢慢改。
- 不要一次性重命名所有 `Reasonix`/`Deepreef` 历史命名。
- 不要在协议抽取时修改工具 schema。
- 不要在 loop policy 拆分时改变 early stop/verification 行为。
- 不要把 eval/workflow/harness 全部塞进 `@covalo/protocol`。
- 不要删除 `@covalo/core` 的兼容 re-export。

### 10.2 推荐原则

始终遵守：

- 协议包只表达跨包契约。
- core 保留 runtime 编排和兼容门面。
- tools 只负责具体工具实现。
- cli 负责装配。
- tui 负责界面和交互状态。
- plugin/mcp 使用协议类型，不反向依赖 core runtime。

---

## 11. 每个 PR 的 migration note 模板

每个 PR 必须在 PR 描述或 `docs/` 中记录：

```markdown
## Migration Note

### Scope

- 本 PR 改了什么边界：
- 本 PR 没有改什么：

### Compatibility

- 保留的 re-export：
- 外部 API 是否变化：
- 行为是否变化：

### Tests

```bash
bun run typecheck
bun run test
bun run build
bun run smoke:cli
bun run pack:dry-run
```

结果：

### Risk

- 最大风险：
- 回滚方式：
- 后续 PR：
```

---

## 12. 完成定义

整条 runtime boundary refactor 完成时，应满足：

```text
@covalo/protocol 不依赖任何 covalo 上层包
@covalo/tools 不依赖 @covalo/core
@covalo/core 不依赖 @covalo/tools
@covalo/plugin 的工具适配层不依赖 core runtime
@covalo/mcp 的工具定义不依赖 core runtime
CLI bootstrap 被拆成可读的装配模块
ReasonixEngine public API 保持兼容，但内部 runtime services 清晰
runLoop 对外兼容，但策略逻辑可单独测试
TUI 的 App/bridge 被拆成 controller/adapter，交互行为不变
```

依赖方向最终应接近：

```text
protocol
  ↑
  ├─ security
  ├─ tools
  ├─ mcp
  ├─ plugin
  └─ core
        ↑
        ├─ cli
        └─ tui
```

注意：实际依赖图可以因 UI/CLI 需要略有不同，但不得重新出现 `core <-> tools` 这种双向依赖。

---

## 13. 建议第一步

第一个实施分支：

```bash
git checkout -b refactor/protocol-boundary
```

只做：

1. 新增 `packages/protocol`
2. 迁移第一批稳定协议类型
3. `core` re-export 兼容
4. `tools` 改依赖 `protocol`
5. `plugin/mcp` 中纯工具协议类型改依赖 `protocol`
6. 跑完整验证

不要做：

- 不拆 engine
- 不拆 loop
- 不拆 CLI
- 不动 TUI
- 不改工具行为
- 不改 prompt

这是最稳的一刀。它不会改变用户体验，但会立刻打断最危险的类型层耦合，为后续 runtime decoupling 铺路。
