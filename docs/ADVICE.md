请修改 Deepreef 的 workflow 工具权限系统，解决 supervisor_analyse 阶段 Supervisor 自己反复规划/探索、不进入 worker_do 的问题。

核心目标：

1. `resolveEffectiveTools()` 必须从 `role + mode` 过滤升级为 `role + mode + workflowPhase` 过滤。
2. `supervisor_analyse` 阶段禁止 Supervisor 拿到会诱导深度探索/执行的工具，尤其禁止 `read_file`、`grep`、`bash`、`edit`、`write_file`、`apply_patch`、`AgentTool`、mailbox 工具。
3. `supervisor_check` 阶段才允许 Supervisor 使用 `read_file` / `grep` 做验证。
4. Worker 阶段工具权限保持原样，不要误伤 Worker 执行能力。
5. 不要在 TUI bridge 层靠字符串判断绕过。这个问题属于 core 层工具权限模型，不是 TUI 渲染问题。

一、当前问题

当前 `packages/core/src/resolve-effective-tools.ts` 里，Supervisor loop 工具是统一集合：

```ts
const SUPERVISOR_LOOP_TOOLS = new Set([
  "get_goal",
  "update_goal",
  "list_dir",
  "read_file",
  "grep",
])
```

这意味着 Supervisor 在 `supervisor_analyse`、`supervisor_check`、`supervisor_intervene` 阶段拿到的是同一组工具。

这会导致：

```text
supervisor_analyse
  -> Supervisor 拿到 read_file / grep
  -> Supervisor 自己开始搜索、读取、验证
  -> runLoop 工具调用完成后继续下一轮 LLM turn
  -> Supervisor 继续探索
  -> runSupervisorAnalyse() 不返回
  -> transition("worker_do") 不执行
  -> Worker 不被调动
```

必须让 Supervisor 在不同 workflow phase 拿到不同工具。

二、修改 Workflow phase 类型传递

文件：

```text
packages/core/src/resolve-effective-tools.ts
```

新增类型导入：

```ts
import type { WorkflowPhase } from "./workflow-coordinator/types.js"
```

把 `ResolveEffectiveToolsOpts` 改为：

```ts
export interface ResolveEffectiveToolsOpts {
  registeredTools: Map<string, AgentTool>
  role: AgentRole
  mode: WorkflowMode
  agentToolNames?: string[]
  workflowPhase?: WorkflowPhase
}
```

三、拆分 Supervisor loop 工具集合

在 `resolve-effective-tools.ts` 中替换原来的 `SUPERVISOR_LOOP_TOOLS`。

建议采用保守策略：

```ts
const SUPERVISOR_LOOP_ANALYSE_TOOLS = new Set([
  "get_goal",
  // 可选：如果确实需要看项目顶层结构，保留 list_dir。
  // 如果仍然观察到 Supervisor 在 plan 阶段循环，把 list_dir 也移除。
  "list_dir",
])

const SUPERVISOR_LOOP_CHECK_TOOLS = new Set([
  "get_goal",
  "list_dir",
  "read_file",
  "grep",
])

const SUPERVISOR_LOOP_INTERVENE_TOOLS = new Set([
  "get_goal",
])

const SUPERVISOR_LOOP_DEFAULT_TOOLS = new Set([
  "get_goal",
])
```

注意：

* 不要把 `update_goal` 放进 `supervisor_analyse`。
* 默认也不建议把 `update_goal` 放进 `supervisor_check`，因为 workflow coordinator 已经在解析 approve 后更新 goal 状态。
* 如果项目中确实依赖模型主动调用 `update_goal`，也只能放到 `supervisor_check`，不要放到 `supervisor_analyse`。

四、增加 phase-aware helper

在 `resolve-effective-tools.ts` 中新增：

```ts
function supervisorLoopToolsForPhase(phase: WorkflowPhase | undefined): Set<string> {
  switch (phase) {
    case "supervisor_analyse":
      return SUPERVISOR_LOOP_ANALYSE_TOOLS
    case "supervisor_check":
      return SUPERVISOR_LOOP_CHECK_TOOLS
    case "supervisor_intervene":
      return SUPERVISOR_LOOP_INTERVENE_TOOLS
    default:
      return SUPERVISOR_LOOP_DEFAULT_TOOLS
  }
}
```

五、修改 resolveEffectiveTools 的 supervisor loop 分支

找到当前逻辑：

```ts
if (role === "supervisor" && mode === "loop") {
  if (SUPERVISOR_LOOP_TOOLS.has(name)) {
    toolSpecs.push(toSpec(tool))
    continue
  }
  filteredCount++
  if (!filteredReason) filteredReason = "supervisor loop mode: governance tools only"
  continue
}
```

改为：

```ts
if (role === "supervisor" && mode === "loop") {
  const allowedSupervisorTools = supervisorLoopToolsForPhase(workflowPhase)

  if (allowedSupervisorTools.has(name)) {
    toolSpecs.push(toSpec(tool))
    continue
  }

  filteredCount++
  if (!filteredReason) {
    filteredReason = workflowPhase
      ? `supervisor loop phase ${workflowPhase}: phase-scoped tools only`
      : "supervisor loop mode: default governance tools only"
  }
  continue
}
```

六、把 workflowPhase 从 engine.submit 传到 resolveEffectiveTools

文件：

```text
packages/core/src/engine.ts
```

新增导入：

```ts
import type { WorkflowPhase } from "./workflow-coordinator/types.js"
```

把 `submit` 签名从类似：

```ts
async *submit(
  userInput: string,
  agentConfig?: AgentConfig,
  role?: "worker" | "supervisor",
  mode?: WorkflowMode,
): AsyncGenerator<LoopEvent> {
```

改成：

```ts
async *submit(
  userInput: string,
  agentConfig?: AgentConfig,
  role?: "worker" | "supervisor",
  mode?: WorkflowMode,
  workflowPhase?: WorkflowPhase,
): AsyncGenerator<LoopEvent> {
```

然后在 `resolveEffectiveTools()` 调用处补上：

```ts
const { tools: toolSpecs, filteredCount, filteredReason } = resolveEffectiveTools({
  registeredTools: this.tools,
  role: effectiveRole,
  mode: effectiveMode,
  agentToolNames: ac.toolNames,
  workflowPhase,
})
```

七、把 workflowPhase 从 AgentRuntime 传到 Engine

文件：

```text
packages/core/src/dual-agent-runtime/runtime.ts
```

当前大概是：

```ts
async *submit(input: string, mode?: WorkflowMode): AsyncGenerator<LoopEvent> {
  ...
  const ctx: SubmitContext = { role: this.role, mode: mode ?? "alone" }
  for await (const event of this.engine.submit(input, undefined, ctx.role, ctx.mode)) {
    yield event
  }
}
```

改成：

```ts
import type { WorkflowPhase } from "../workflow-coordinator/types.js"
```

然后改签名：

```ts
async *submit(
  input: string,
  mode?: WorkflowMode,
  workflowPhase?: WorkflowPhase,
): AsyncGenerator<LoopEvent> {
  if (this.status === "running") {
    throw new Error(`Agent ${this.role} is already running`)
  }

  this.status = "running"
  this.startTime = Date.now()
  this.currentTask = input

  try {
    const ctx: SubmitContext = { role: this.role, mode: mode ?? "alone" }
    for await (const event of this.engine.submit(input, undefined, ctx.role, ctx.mode, workflowPhase)) {
      yield event
    }
    this.status = "completed"
  } catch (error) {
    this.status = "failed"
    yield {
      role: "error",
      content: error instanceof Error ? error.message : String(error),
    }
  } finally {
    this.currentTask = undefined
  }
}
```

八、在 WorkflowCoordinator 各阶段传入 phase

文件：

```text
packages/core/src/workflow-coordinator/coordinator.ts
```

修改 `runSupervisorAnalyse()`：

```ts
for await (const event of this.runtime!.getSupervisor().submit(
  supervisorInput,
  "loop",
  "supervisor_analyse",
)) {
  yield event as any
  if (event.role === "error") errorMessage = event.content ?? "Supervisor analysis failed"
}
```

修改 `runWorkerDo()`：

```ts
for await (const event of this.runtime!.getWorker().submit(
  workerInput,
  "loop",
  "worker_do",
)) {
  yield event as any
  if (event.role === "error") {
    hasError = true
    errorCount++
  }
}
```

修改 `runWorkerReport()`：

```ts
for await (const event of this.runtime!.getWorker().submit(
  workerInput,
  "loop",
  "worker_report",
)) {
  yield event as any
}
```

修改 `runSupervisorCheck()`：

```ts
for await (const event of this.runtime!.getSupervisor().submit(
  supervisorInput,
  "loop",
  "supervisor_check",
)) {
  yield event as any
}
```

修改 `runSupervisorIntervene()`：

```ts
for await (const event of this.runtime!.getSupervisor().submit(
  supervisorInput,
  "loop",
  "supervisor_intervene",
)) {
  yield event as any
}
```

九、同步调整 Supervisor loop system prompt

文件：

```text
packages/core/src/engine.ts
```

当前 `role === "supervisor" && mode === "loop"` 的 system prompt 是统一的，里面同时写了 analyse 和 check 的规则。这会让模型在 plan 阶段仍然以为自己可以做很多事。

把 supervisor loop prompt 拆成 phase-specific。

新增 helper，放在 engine.ts 里合适位置：

```ts
function buildSupervisorLoopModePrompt(workflowPhase?: WorkflowPhase): string {
  if (workflowPhase === "supervisor_analyse") {
    return `## Loop Mode — Supervisor Analyse

You are the Supervisor in the planning phase.

The WorkflowCoordinator owns execution order:
supervisor_analyse -> worker_do -> worker_report -> supervisor_check.

Your current job:
- Create a concrete plan for the Worker.
- Do not execute the plan yourself.
- Do not inspect implementation files.
- Do not verify code.
- Do not perform Worker tasks.
- Do not call read_file, grep, bash, edit, write, apply_patch, AgentTool, mailbox, or dispatch tools.
- If tools are available, use at most get_goal and list_dir for shallow orientation.
- After producing the plan, stop. The coordinator will pass your plan to the Worker.

Return a structured plan with:
- objective
- concrete Worker steps
- constraints
- risks
- expected evidence / verification criteria`
  }

  if (workflowPhase === "supervisor_check") {
    return `## Loop Mode — Supervisor Check

You are the Supervisor in the review phase.

Your current job:
- Review the Worker report.
- Verify the Worker output against the plan and goal.
- You may use read_file and grep to inspect evidence.
- Do not perform Worker tasks yourself.
- Do not edit files.
- Do not run implementation steps.
- Decide one of: continue, revise, approve, ask_user, or blocked.

Do not approve unless you provide a requirement-by-requirement completion audit with concrete evidence.`
  }

  if (workflowPhase === "supervisor_intervene") {
    return `## Loop Mode — Supervisor Intervention

You are giving brief mid-workflow guidance to the Worker.

Your current job:
- Diagnose the Worker blocker.
- Provide concise guidance.
- Do not perform Worker tasks yourself.
- Do not approve or complete the workflow.
- Do not edit files.
- Use no tools unless strictly necessary.`
  }

  return `## Loop Mode — Supervisor

You are the Supervisor for the active loop goal.

The WorkflowCoordinator owns execution order:
supervisor_analyse -> worker_do -> worker_report -> supervisor_check.

Follow the current workflow phase. Do not perform Worker tasks yourself.`
}
```

然后把原来的：

```ts
role === "supervisor" && mode === "loop"
  ? `## Loop Mode — Supervisor ...`
```

替换为：

```ts
role === "supervisor" && mode === "loop"
  ? buildSupervisorLoopModePrompt(workflowPhase)
```

十、可选但建议：plan 阶段进一步限制 maxTurns

仅靠移除 `read_file/grep` 通常够用，但如果模型仍然反复 `list_dir`，建议给 `supervisor_analyse` 加硬限制。

在 `engine.ts` 生成 `loopOpts` 前增加：

```ts
const phaseMaxTurns =
  role === "supervisor" && mode === "loop" && workflowPhase === "supervisor_analyse"
    ? 2
    : role === "supervisor" && mode === "loop" && workflowPhase === "supervisor_intervene"
      ? 1
      : this.effectivePolicy?.maxTurns
```

然后把 loopOpts 里的：

```ts
maxTurns: this.effectivePolicy?.maxTurns,
```

改成：

```ts
maxTurns: phaseMaxTurns,
```

解释：

* `supervisor_analyse` 如果允许 `list_dir`，最多 2 turns：第一轮可浅层看结构，第二轮必须输出 plan。
* 如果你选择 analyse 阶段 no-tools，则可以把 `phaseMaxTurns` 改为 1。
* `supervisor_check` 不建议限制太死，因为它可能需要 read_file / grep 验证。

十一、如果想采用 no-tools plan 阶段

如果你想让 plan 阶段完全不使用工具，把：

```ts
const SUPERVISOR_LOOP_ANALYSE_TOOLS = new Set([
  "get_goal",
  "list_dir",
])
```

改成：

```ts
const SUPERVISOR_LOOP_ANALYSE_TOOLS = new Set<string>([])
```

同时把 analyse prompt 改成：

```text
No tools are available in this phase. Produce the Worker plan from the goal, previous report, previous review, and user instruction only.
```

我建议先用：

```text
get_goal + list_dir
```

如果还循环，再改成 no-tools。

十二、不要这样修

不要在 `runSupervisorAnalyse()` 里看到 `tools_completed` 就强行 `transition("worker_do")`。

原因：

* `tools_completed` 只表示当前工具批次完成，不表示 Supervisor 已经生成 plan。
* 如果强行转 Worker，可能拿不到有效 plan。
* 正确方式是限制 Supervisor 在 analyse 阶段能调用的工具，让它自然快速 stop 并返回 plan。

不要在 TUI bridge 层过滤 Supervisor 工具事件。

原因：

* TUI 只负责显示。
* 即使 TUI 不显示，core 仍然会执行工具循环。
* 必须从 `resolveEffectiveTools()` 源头减少 Supervisor 可见工具。

不要只改 prompt，不改工具过滤。

原因：

* 本地/小模型经常不稳定，prompt 禁止不等于工具不可用。
* 工具权限必须由代码 enforce。

十三、测试方案

新增或修改测试，至少覆盖以下情况。

测试 1：Supervisor analyse 工具过滤

输入：

```ts
resolveEffectiveTools({
  registeredTools,
  role: "supervisor",
  mode: "loop",
  workflowPhase: "supervisor_analyse",
})
```

断言：

* 包含：`get_goal`
* 包含或不包含：`list_dir`，取决于你采用 shallow-plan 还是 no-tools
* 不包含：`read_file`
* 不包含：`grep`
* 不包含：`update_goal`
* 不包含：`bash`
* 不包含：`edit`
* 不包含：`write_file`
* 不包含：`AgentTool`
* 不包含：`send_message`
* 不包含：`followup_task`
* 不包含：`read_mailbox`

测试 2：Supervisor check 工具过滤

输入：

```ts
resolveEffectiveTools({
  registeredTools,
  role: "supervisor",
  mode: "loop",
  workflowPhase: "supervisor_check",
})
```

断言：

* 包含：`get_goal`
* 包含：`list_dir`
* 包含：`read_file`
* 包含：`grep`
* 不包含：`bash`
* 不包含：`edit`
* 不包含：`write_file`
* 不包含：`AgentTool`
* 不包含：`send_message`
* 不包含：`followup_task`
* 不包含：`read_mailbox`

测试 3：Worker loop 不受影响

输入：

```ts
resolveEffectiveTools({
  registeredTools,
  role: "worker",
  mode: "loop",
  workflowPhase: "worker_do",
  agentToolNames,
})
```

断言：

* Worker 的工程工具仍按 agent config 正常可用。
* goal/mailbox orchestration 工具仍被过滤。

测试 4：Coordinator phase 传递

mock `AgentRuntime.submit`，断言调用参数：

```text
runSupervisorAnalyse -> submit(input, "loop", "supervisor_analyse")
runWorkerDo -> submit(input, "loop", "worker_do")
runWorkerReport -> submit(input, "loop", "worker_report")
runSupervisorCheck -> submit(input, "loop", "supervisor_check")
runSupervisorIntervene -> submit(input, "loop", "supervisor_intervene")
```

测试 5：Plan 阶段不会拿 read_file/grep

构造一个 fake registeredTools，包含 `read_file` 和 `grep`，让 Supervisor analyse submit 走到 `resolveEffectiveTools()`，确认 toolSpecs 里没有它们。

十四、验收标准

运行：

```bash
bun run typecheck
```

再运行相关测试：

```bash
bun test
```

如果没有完整测试命令，至少运行 core 包测试和类型检查。

手工验证：

1. 启动 loop workflow。
2. 输入一个需要代码执行的目标。
3. 观察 plan 阶段：

   * Supervisor 应该快速产出 plan。
   * Supervisor 不应反复 read_file / grep。
   * Supervisor 不应自己执行 Worker 工作。
4. 观察 phase：

   * plan 完成后应进入 worker_do。
   * worker_do 中 Worker 开始实际读取/修改/验证。
5. 观察 check 阶段：

   * Supervisor 可以 read_file / grep 验证 Worker 报告。
   * Supervisor 不应 edit/write/bash。
6. 若 plan 阶段仍反复 list_dir：

   * 把 `SUPERVISOR_LOOP_ANALYSE_TOOLS` 改成空集合。
   * 把 analyse 阶段 `phaseMaxTurns` 改成 1。

十五、建议提交信息

```text
fix(core): scope supervisor loop tools by workflow phase
```
