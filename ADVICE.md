# Deepicode 后续开发建议

最后更新：2026-06-04（AGENT-90 P0 ✅）

本文只保留后续 Agent 仍需要执行的专项指导。已完成能力以 [DONE.md](DONE.md) 为准；待办入口以 [TODO.md](TODO.md) 为准；CI 与平台兼容性排查按 [CI-Compatibility-Fix-Guide.md](CI-Compatibility-Fix-Guide.md) 执行。

当前包含专项：

- `AGENT-90`：✅ P0 已完成（详见 [DONE.md 第 10 节](DONE.md#-10-subagent-系统agent-90-p0)），本文保留 P1/P2 参考规划。
- `CTX-70`：Context 文档和验收。
- `FG-*`：基于 `Find_ground_Report.md` 的隐性兜底治理剩余项。

---

## 1. AGENT-90：Plan/Build 主状态与临时 Subagent 架构

> ✅ **P0 第一阶段已完成**，详见 [DONE.md 第 10 节](DONE.md#-10-subagent-系统agent-90-p0)。
> 以下保留 P1（Fork）/ P2（Background）规划参考，以及已验证的测试计划和关闭条件。

优先级：`P0`

目标：

- 主 Agent 只有两种用户可见工作状态：`Plan` 和 `Build`。
- `Plan` 是主 Agent 的只读分析状态，只能回答、读文件、搜索、列目录、写 todo，不允许改代码、写文件、执行会改变系统状态的命令。
- `Build` 是主 Agent 的执行状态，可以改代码、写文件、运行需要审批的命令。
- `Subagent` 不是第三种主状态，而是由主 Agent 通过 `AgentTool` 临时生成的子代理。子代理可以是命名角色，也可以是 fork worker；它有独立会话、工具边界、最大轮次、输出汇总和生命周期事件。
- 参考 `/vol4/Agent/best-claude-code` 的 AgentTool 设计，但不要照搬所有后台 daemon、remote agent、team swarm 能力。Deepicode 第一阶段先实现本地临时子代理。

### 1.1 当前 deepicode 事实

已有基础：

- `packages/core/src/agent.ts` 已有 `build` 和 `plan` 两个 agent definition。
- `packages/tui/src/App.tsx` 已有 `/agent` 切换 UI。
- `packages/tools/src/agent-tool.ts` 已有 `AgentTool`，参数为 `task / agent_type / files`。
- `packages/core/src/engine.ts` 已有 `delegateTask()`，会创建 child `ReasonixEngine`。
- `delegateTask()` 当前会排除 `AgentTool`，并对 `approval === "exec"` 的工具加 deny rule，避免后台子代理直接跑 exec。

主要差距：

- `agent` 概念被混用：主状态、工具执行者、子代理类型都叫 agent，后续维护容易误改。
- 当前 `AgentTool` 只能选 `build / plan`，不能表达 `Explore`、`reviewer`、`general-purpose`、`fork` 等临时子代理角色。
- 当前子代理是同步返回字符串，没有稳定的 task id、状态、后台通知、输出文件、进度事件或恢复入口。
- 当前 `Plan` 的只读边界主要靠 tool list，不够系统化。还需要在 permission 层 fail-closed。
- 当前子代理没有 `maxTurns`、模型继承、system prompt 覆盖、工具 allow/deny、是否继承父上下文等配置。

### 1.2 Claude Code 参考点

只参考这些能力：

- `/vol4/Agent/best-claude-code/docs/agent/sub-agents.mdx`
  - 区分命名子 Agent、AgentTool fork、slash command fork、内部 `runForkedAgent()`。
  - `AgentTool` 参数包含 `description`、`prompt`、`subagent_type`、`model`、`run_in_background`、`isolation`、`cwd` 等。
  - 普通命名子 Agent 从零上下文启动；fork 子 Agent 继承父级上下文。
- `/vol4/Agent/best-claude-code/docs/extensibility/custom-agents.mdx`
  - Agent definition 支持 `name / description / tools / disallowedTools / model / maxTurns / permissionMode / background / skills / hooks`。
  - Agent definitions 可以来自 built-in、plugin、项目目录，按优先级合并。
- `/vol4/Agent/best-claude-code/docs/features/fork-subagent.md`
  - fork worker 继承父级 system prompt、消息历史、工具定义和模型。
  - fork worker 必须有递归防护，不能再次 spawn sub-agent。
  - fork worker 的权限请求要冒泡到父级交互端，或在没有交互端时 fail-fast。
- `/vol4/Agent/best-claude-code/packages/builtin-tools/src/tools/AgentTool/prompt.ts`
  - 工具提示里要明确：普通 Agent 从零上下文开始，prompt 必须包含完整背景；fork 继承上下文，prompt 应写成 directive。
  - 后台 Agent 完成后通知主 Agent；主 Agent 不能猜测后台结果。
- `/vol4/Agent/best-claude-code/packages/builtin-tools/src/tools/AgentTool/built-in/planAgent.ts`
  - Plan/Explore 这类只读 Agent 必须在 system prompt 和工具层双重禁止写入。

不要第一阶段照搬：

- team swarm、teammate idle、远程 CCR、daemon attach、agent memory、agent color、复杂任务面板。
- `worktree` 隔离可以预留 schema，但不要作为 AGENT-90 第一阶段的必须交付，除非用户单独要求。

### 1.3 命名和边界

建议重命名概念，避免继续混淆：

- `MainMode`：主 Agent 的用户可见状态，枚举为 `"plan" | "build"`。
- `SubagentDefinition`：可被 `AgentTool` 临时启动的子代理定义。
- `SubagentRun`：一次子代理运行实例，包含 `id / status / definitionName / prompt / transcript / result / createdAt / finishedAt`。
- `AgentTool`：启动子代理的工具。它不是主状态切换工具。

主状态 API：

```ts
type MainMode = "plan" | "build"

interface MainModeDefinition {
  name: MainMode
  label: string
  systemPrompt: string
  toolNames: string[]
  permissionProfile: "readonly" | "build"
}
```

子代理 API：

```ts
type SubagentPermissionMode = "readonly" | "acceptEdits" | "bubble" | "denyExec"

interface SubagentDefinition {
  name: string
  description: string
  tools?: string[]
  disallowedTools?: string[]
  model?: "inherit" | string
  maxTurns?: number
  permissionMode: SubagentPermissionMode
  background?: boolean
  inheritContext?: boolean
  systemPrompt: string
}

interface SubagentRunOptions {
  description: string
  prompt: string
  subagentType?: string
  model?: "inherit" | string
  runInBackground?: boolean
  files?: string[]
}
```

### 1.4 主 Agent Plan/Build 实施方案

1. 把 `packages/core/src/agent.ts` 从通用 `AGENTS` 语义收敛为主状态定义，或新增 `main-mode.ts` 并逐步迁移。

2. `Plan` 的只读边界必须双保险：
   - `toolNames` 只包含 `read_file`、`list_dir`、`grep`、`glob`、`WebFetch`、`WebSearch`、`Skill`、`TaskList/TaskGet/TodoWrite` 这类读或计划工具。
   - permission 层对 `write` 和 `exec` tier 默认 deny。即使某个写工具被错误加入 Plan tool list，也必须执行失败。

3. `Build` 保持完整工具集，但仍遵守现有 permission ask/allow/deny 流程。

4. `/agent` 可以继续作为模式切换入口，但 UI 文案建议改为 `/mode` 或把显示文案改成 `Plan mode / Build mode`，减少和 subagent 混淆。为了兼容，`/agent` 可以保留 alias。

5. `Plan` 不能自动进入 `Build`。如需从计划转执行，必须满足以下任一条件：
   - 用户显式 `/agent` 或 `/mode` 切换到 Build。
   - 新增类似 `PlanMode` 的工具返回“计划已完成，等待用户批准切换 Build”，TUI 展示确认。

6. 测试必须覆盖：
   - Plan 模式无法调用 `write_file / edit / bash / notebook_edit`。
   - Plan 模式即使通过错误注册拿到写工具，也会被 permission profile 拦截。
   - Build 模式仍可按现有权限确认流程执行写入和 exec。
   - `/agent` 或新 `/mode` 切换后 engine 的 tool schema 与 status bar 同步变化。

### 1.5 Subagent 第一阶段实施方案

第一阶段先实现“本地临时命名子代理 + 同步返回”。这是对当前 `delegateTask()` 的升级，不做后台 UI。

建议文件：

- `packages/core/src/subagent/definition.ts`
- `packages/core/src/subagent/registry.ts`
- `packages/core/src/subagent/run.ts`
- `packages/core/src/subagent/fork-context.ts`
- `packages/tools/src/agent-tool.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/streaming-executor.ts`

内置子代理：

```ts
const BUILTIN_SUBAGENTS: SubagentDefinition[] = [
  {
    name: "general-purpose",
    description: "General task worker for implementation or investigation",
    tools: ["*"],
    disallowedTools: ["AgentTool"],
    model: "inherit",
    maxTurns: 20,
    permissionMode: "denyExec",
    inheritContext: false,
    systemPrompt: "...",
  },
  {
    name: "Explore",
    description: "Fast read-only code search and repository exploration",
    tools: ["read_file", "list_dir", "grep", "glob", "WebFetch", "WebSearch"],
    disallowedTools: ["AgentTool", "write_file", "edit", "bash", "NotebookEdit"],
    model: "inherit",
    maxTurns: 8,
    permissionMode: "readonly",
    inheritContext: false,
    systemPrompt: "READ-ONLY exploration prompt...",
  },
  {
    name: "Plan",
    description: "Read-only software planning specialist",
    tools: ["read_file", "list_dir", "grep", "glob", "todowrite"],
    disallowedTools: ["AgentTool", "write_file", "edit", "bash", "NotebookEdit"],
    model: "inherit",
    maxTurns: 12,
    permissionMode: "readonly",
    inheritContext: false,
    systemPrompt: "READ-ONLY planning prompt...",
  },
]
```

`AgentTool` schema 建议改为：

```ts
{
  description: string,       // 3-5 个词，用于日志/UI
  prompt: string,            // 给子代理的完整任务
  subagent_type?: string,    // 缺省走 general-purpose 或 fork gate
  model?: string,            // 可选，inherit 或具体模型
  run_in_background?: boolean, // 第一阶段可接受但返回 unsupported，第二阶段实现
  files?: string[],          // 兼容当前实现
}
```

兼容策略：

- 旧参数 `task` 暂时保留，内部映射为 `prompt`。
- 旧参数 `agent_type: "build" | "plan"` 暂时映射：
  - `build` -> `general-purpose`
  - `plan` -> `Plan`
- 新 prompt 中不要再鼓励使用 `agent_type`。

运行流程：

```text
AgentTool.execute(args, ctx)
  -> validate prompt/description
  -> ctx.spawnSubagent(options)
  -> SubagentRegistry.resolve(subagent_type ?? "general-purpose")
  -> filter tools by tools/disallowedTools
  -> create child ReasonixEngine
  -> set child metadata: parentSessionId, subagentRunId, subagentType
  -> inject child systemPrompt
  -> submit child prompt
  -> collect assistant_final / assistant_delta / error
  -> return structured JSON result
```

返回格式：

```json
{
  "status": "completed",
  "id": "subagent_xxx",
  "subagent_type": "Plan",
  "description": "review auth flow",
  "result": "...",
  "files": ["packages/core/src/engine.ts"],
  "usage": { "promptTokens": 0, "completionTokens": 0 },
  "warnings": []
}
```

### 1.6 Fork 子代理第二阶段方案

第二阶段再实现 fork。fork 的语义：

- `subagent_type` 省略，并且 `FEATURE_FORK_SUBAGENT=1` 或 deepicode 配置开启时，走 fork。
- fork 继承父级 system prompt、当前可见消息历史、模型和工具 schema。
- fork 的 prompt 是 directive，不需要重复背景。
- fork 禁止递归 spawn：child 的 `ToolContext` 不提供 `spawnSubagent`，并且工具池移除 `AgentTool`。
- fork 权限模式为 `bubble`。如果父级有交互 channel，则子代理权限请求通过父级 TUI 展示；如果没有，直接 deny 并返回清晰错误。

Deepicode 第一版 fork 可以先做同步，不强制后台：

```text
AgentTool({ prompt: "...", fork: true })
  -> clone parent context snapshot
  -> append fork directive
  -> child.submit(...)
  -> return result
```

注意：

- 不要直接共享父 `ContextManager` 实例，必须 snapshot clone，避免 child 写入污染父上下文。
- 必须过滤未完成 tool call，避免构造非法消息链。
- fork child 的日志要带 `delegate: true`、`subagentType: "fork"`、`parentSessionId`。
- fork 结果默认只回给主 Agent，不直接展示给用户。主 Agent 负责综合回答。

### 1.7 后台子代理第三阶段方案

第三阶段实现 `run_in_background`，不要提前把 UI 和持久化做复杂。

最小后台模型：

- `SubagentRunStore`：内存 Map，保存 running/completed/failed/cancelled。
- `AgentTool(run_in_background: true)` 立即返回：

```json
{
  "status": "async_launched",
  "id": "subagent_xxx",
  "description": "review auth flow"
}
```

- child 完成后生成一个主对话可消费的 `tool_notification` 或 synthetic user message：

```xml
<task-notification id="subagent_xxx" status="completed">
...
</task-notification>
```

- 主 Agent 收到通知后才能总结结果。未收到结果前不能猜测。
- TUI 第一版只需在 status 或 message list 里显示后台任务完成通知，不需要完整任务面板。

### 1.8 权限规则

必须 fail-closed：

- `readonly`：只允许 read tier 工具。写和 exec 全部 deny。
- `denyExec`：允许 read/write，但 exec deny。适合后台 general-purpose 本地子代理。
- `acceptEdits`：允许 read/write，exec 仍走父级 ask 或 deny，具体由主 permission policy 控制。
- `bubble`：子代理请求权限时转发到父级交互端。没有父级交互端则 deny。

子代理永远默认禁止：

- 调用 `AgentTool` 生成嵌套子代理，除非后续明确支持并有深度限制。
- 修改权限配置文件来绕过规则。
- 在 readonly 模式下通过 `bash` 写文件、重定向、`rm`、`mv`、`cp`、`touch`、`git add`、`git commit`。

`Plan` 和 `Explore` prompt 中必须写明 READ-ONLY，但 prompt 不是安全边界。真正边界在 tool filter 和 permission engine。

### 1.9 Prompt 规范

`AgentTool` 的 description 要明确告诉主模型：

- 普通子代理从零上下文开始，必须在 `prompt` 中写完整背景、目标、文件路径、已知约束、期望输出。
- 不要写“根据你的发现去修复”这种把理解外包给子代理的 prompt。主 Agent 必须先理解，再分派具体任务。
- 只读任务使用 `Explore` 或 `Plan`。
- 需要改文件的任务使用 `general-purpose` 或后续自定义 build 类子代理。
- 子代理结果默认不可直接给用户看，主 Agent 要综合后回复。
- 并发启动多个子代理时，必须一次性发出多个 tool call；不要 sleep/poll。

### 1.10 测试计划

新增或扩展测试：

- `packages/tools/__tests__/agent-tool.test.ts`
  - `task` 兼容 `prompt`。
  - `agent_type` 兼容映射到新 `subagent_type`。
  - 未知 `subagent_type` 返回 tool error，不静默 fallback。
  - `description` 缺省时从 prompt 生成或返回 warning，规则必须固定。

- `packages/core/__tests__/subagent-registry.test.ts`
  - built-in definitions 加载。
  - tools/disallowedTools 过滤。
  - duplicate definition 优先级。

- `packages/core/__tests__/subagent-permission.test.ts`
  - readonly 子代理不能写文件。
  - denyExec 子代理不能跑 bash。
  - AgentTool 在 child 中不可用。

- `packages/core/__tests__/subagent-run.test.ts`
  - child engine shutdown 在成功/失败时都会执行。
  - maxTurns 生效。
  - child 输出和 error 能结构化返回。
  - parent context 不被 child 污染。

- `packages/tui/__tests__/commands.test.ts`
  - `/agent` 或 `/mode` 文案和切换仍工作。
  - status bar 显示 `Plan` 或 `Build`，不要显示临时 subagent。

建议验收命令：

```bash
bun test packages/tools/__tests__/workflow-agent-send-lsp.test.ts
bun test packages/core/__tests__/agent.test.ts
bun test packages/core/__tests__/engine-tools.test.ts
bun test packages/tui/__tests__/commands.test.ts
bun run typecheck
```

### 1.11 分阶段关闭条件

P0 第一阶段关闭条件：

- 主 Agent `Plan/Build` 边界明确，Plan 写/exec fail-closed。
- `AgentTool` 支持 `description / prompt / subagent_type / files`，旧参数兼容。
- 内置 `general-purpose / Explore / Plan` 子代理可用。
- 子代理有独立 child engine、独立 system prompt、工具过滤、maxTurns、结构化返回。
- 子代理不能嵌套调用 `AgentTool`。
- 相关单元测试和 typecheck 通过。

P1 第二阶段关闭条件：

- fork 子代理支持上下文继承和递归防护。
- fork 不污染父 context。
- fork 权限 bubble 或无交互 deny 行为明确。

P2 第三阶段关闭条件：

- `run_in_background` 可用。
- 有最小任务状态、完成通知和取消能力。
- 主 Agent 不会在后台结果未完成时虚构结果。

---

## 2. Context 当前事实

- `ContextPolicy`、`ContextPolicyStore`、summary 区域、`ContextSummarizer` 接口、engine 自动触发、真实 `LLMSummarizer` 都已经实现。
- `/context` 菜单已经实现并接入真实 engine policy：
  - `trim / compact` 切换。
  - `triggerRatio` / `targetRatio` 调整。
  - 当前 context 用量显示。
  - `Run now` 立即触发 reduction。
- `compact` 是用户界面名称；engine 内部会把 `compact` 映射到底层 compress/reduction 流程。
- 策略持久化文件是 `.deepicode/context.json`，不要合并进主配置。
- 本轮已修复 reset 后 `/` 菜单恢复不完整导致的类型错误和菜单交互错误。

---

## 3. Context 不要重做的内容

后续 Agent 不要重写以下内容：

- 不要重写 `ContextManager` 的三段式结构：`ImmutablePrefix + AppendOnlyLog + VolatileScratch`。
- 不要把 `/context` 菜单改成全屏。
- 不要把 compact 逻辑写进 TUI。
- 不要把 summarizer 做成普通工具。
- 不要覆盖历史 JSONL 原始消息。
- 不要把动态 MCP schema 或 plugin schema 混进 context prefix。

如果发现这些能力“不工作”，先写最小复现测试，再修具体 bug，不要按新方案推倒重来。

---

## 4. CTX-70：文档和验收

优先级：`P1`

目标：

- 把 Context 压缩专项从“代码完成”推进到“可交付验收”。
- 确认 `70% -> 30%` 的 trim 和 compact 在真实 TUI/CLI 场景中都能工作。
- 把验收结果写入 `DONE.md`，把仍需人工或平台环境验证的内容留在 `TODO.md`。

执行步骤：

1. 阅读当前实现：
   - `packages/core/src/context/policy.ts`
   - `packages/core/src/context/policy-store.ts`
   - `packages/core/src/context/summary.ts`
   - `packages/core/src/context/summarizer.ts`
   - `packages/core/src/context/manager.ts`
   - `packages/core/src/engine.ts`
   - `packages/tui/src/ContextModal.tsx`
   - `packages/tui/src/App.tsx`

2. 补充用户文档：
   - 在 `README.md` 增加 `/context` 使用说明。
   - 说明 `trim` 是机械裁剪。
   - 说明 `compact` 会调用模型生成 summary，失败会 fallback 到 trim。
   - 说明默认策略是 `70% -> 30%`。

3. 自动化验证：
   - 运行 context 相关目标测试。
   - 运行 typecheck。
   - 运行全量测试前确认没有外部服务依赖或已 mock。

建议命令：

```bash
bun test packages/core/__tests__/context-policy.test.ts
bun test packages/core/__tests__/context-summary.test.ts
bun test packages/core/__tests__/engine-context-policy.test.ts
bun test packages/core/__tests__/context-summarizer.test.ts
bun test packages/tui/__tests__/commands.test.ts
bun run typecheck
```

4. 人工验收：
   - 启动 TUI。
   - 输入 `/context`。
   - 选择 `trim`，设置 `70% -> 30%`，执行 `Run now`。
   - 用长会话把上下文推到 trigger 附近，确认 reduction 后接近 target。
   - 切换 `compact`，重复验证，确认 summary 出现在上下文中。
   - 模拟 summarizer 失败，确认 fallback trim，不中断用户提交。
   - 退出并重启，确认 `.deepicode/context.json` 策略仍然生效。

关闭条件：

- 上述目标测试通过。
- `bun run typecheck` 通过。
- 人工验收结果写入 `DONE.md`。
- `TODO.md` 中删除 `CTX-70` 或只保留明确无法自动化的人工验收项。

---

## 5. FG 专项状态

本轮已完成：

- `FG-20`：TokenizerPool fallback 可感知化。
- `FG-30`：SessionLoader detailed read。
- `FG-40`：工具参数 JSON 解析失败 fail-fast。
- `FG-50`：edit fuzzy fallback 显式 warning。
- `FG-70`：MCP load summary 和 CLI 用户可见提示。

仍需后续处理：

- `FG-10`：形成正式兜底行为分类文档或代码规范。
- `FG-60`：临时文件清理和低风险 best-effort 路径的日志收尾。

---

## 6. FG 剩余实施建议

### FG-10：兜底行为分类和可观测性基线

优先级：`P1`

目标：

- 建立项目内统一规则：哪些 fallback 允许，哪些必须 fail-fast，哪些必须返回 warning。
- 先补观测，不先做破坏性 API 改动。

剩余实施范围：

- `packages/core/src/result-persistence.ts`
- `packages/core/src/runtime-logger.ts`
- `packages/tools/src/hash-edit.ts`
- `packages/tools/src/notebook-edit.ts`

建议实现：

1. 新增一份轻量内部文档或代码注释规范，分类为：
   - `recoverable_fallback`：允许继续，但必须可观测。
   - `best_effort_persistence`：不阻塞主流程，但必须记录失败和计数。
   - `invalid_model_output`：不能继续执行真实工具，必须返回 tool error。
   - `optional_capability_missing`：例如 MCP resources/prompts，可 debug 记录即可。

2. RuntimeLogger 事件命名保持统一，不记录正文和敏感参数。以下事件已在代码路径中使用或预留：
   - `fallback.tokenizer`：已实现。
   - `mcp.load.warning`：已实现。
   - `tool.args.invalid_json`：已实现。
   - `edit.fuzzy_fallback`：结果 warning 已实现，runtime log 可后续补。
   - `session.writer.flush_error`：writer status 已实现，事件名可后续补。

3. 不要把所有 `.catch(() => {})` 机械替换成 warn。
   - 测试清理的 `rm(...).catch(() => {})` 不需要产品日志。
   - `reader.cancel()` / `resp.body.cancel()` 失败属于资源释放低风险路径，可 debug 或保持不报。
   - `unlink(tmpPath)` 清理临时文件失败要记录，但不能覆盖原始编辑错误。

验收：

```bash
bun run typecheck
bun test packages/core/__tests__/session.test.ts
bun test packages/mcp/__tests__/mcp-host.test.ts
```

### FG-50 后续：评估 edit strict mode

优先级：`P3`

当前已经完成第一步：fuzzy fallback 保留原行为，并在返回 JSON 中增加 `warning: "exact_match_failed_used_fuzzy"`。

后续如需 strict mode：

- 工具参数新增 `fuzzy_match?: boolean`。
- 默认值是否改为 `false` 需要单独评估，不要在第一版改。
- 如果引入 strict mode，system prompt / tool description 必须同步说明。

### FG-60：best-effort 持久化和临时文件清理告警

优先级：`P2`

范围：

- `AsyncSessionWriter`
- `hash-edit.ts`
- `notebook-edit.ts`
- `runtime-logger.ts`
- `result-persistence.ts`

建议：

- `AsyncSessionWriter.getStatus()` 已实现；后续可把该状态接入 `/status`。
- flush 失败保留 best-effort，不抛到 submit 主流程；后续可补 `session.writer.flush_error` 事件名。
- `chmod(tmpPath)` 失败：记录 warning，继续执行。
- `unlink(tmpPath)` 失败：记录 warning，不能覆盖原始错误。
- runtime logger 清理旧日志失败可 debug，不需要 P1/P2。

---

## 7. 对 Find_ground_Report.md 的逐项采纳状态

| 报告项 | 结论 | 调整后优先级 | 处理意见 |
|--------|------|--------------|----------|
| TokenizerPool fallback | 基本成立，但不应 P0 阻断发布 | 已完成 | 保留 fallback，已补 diagnostics/log，并修 pending task 用空消息估算的问题 |
| SessionLoader `[]` | 成立，但不能直接破坏旧 API | 已完成 | 已新增 detailed API，旧 API 保持兼容 |
| AsyncSessionWriter catch | 部分成立 | 部分完成 | 已有 debug append_error，已补 status/lastError；事件接入可后续补 |
| Hook event catch | 报告不准确 | P3 | HookManager 已有 error observer；最多补测试确认 |
| DeepSeek body missing | 报告过度 | P3 | 已 yield error；重点是 loop 是否消费 error，不是 client fail-fast |
| StreamingToolExecutor args `{}` | 成立且重要 | 已完成 | 已改为 fail-fast 并回写 tool error |
| hash-edit chmod/unlink | 部分成立，严重级别偏高 | P2 | 补日志，不改变主流程 |
| edit fuzzy fallback | 成立但不宜马上关闭 | 部分完成 | 已补 warning；runtime log/strict mode 后续评估 |
| grep rg->grep fallback | 合理兼容 | P3 | 可 debug 记录，不是 bug |
| MCP connectAll | 部分成立 | 已完成 | 保持部分可用，已补 summary/status 和 CLI 提示 |
| 测试 cleanup catch | 不采纳 | - | 测试清理 `rm(...force).catch` 不是产品假阳性核心问题 |

---

## 8. 本轮修复记录

本轮已完成但尚未提交的恢复修复：

- `/status`、`/context` 加回 slash command 解析、命令注册和 i18n 文案。
- `CommandAutocomplete`：Enter 直接执行命令，Tab 只补全到输入框。
- `DeepiPromptInput`：支持外部输入历史、`injectedText`、`suppressSubmit`，避免 autocomplete 与输入框抢 Enter/↑↓。
- `SkillModal`：恢复 52 个 skill 列表式二级菜单，Space 启用/禁用，Enter 插入 `#skill `。
- `ContextModal`：恢复真实 policy 菜单，支持 `trim/compact`、比例调整和 `Run now`。
- Core 类型缺口：补回 `AppendOnlyLog.replaceAll()`，补齐 `LoopOptions.config.provider?`。
- Plugin runtime 类型缺口：统一记录 config/load/tool 三类 plugin error。

本轮已实际运行：

```bash
bun run typecheck
bun test packages/tui
```

完整 `bun test` 本轮按用户要求中断，不把本轮完整测试作为已完成结论。
