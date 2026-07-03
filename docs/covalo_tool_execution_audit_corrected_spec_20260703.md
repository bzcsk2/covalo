# Covalo v0.1.3 工具执行与权限系统审计纠错版 SPEC

**生成日期**: 2026-07-03  
**审查对象**: `covalo_tool_execution_audit_20260703.md`  
**仓库**: `bzcsk2/covalo`  
**目标**: 对原审计报告进行查证、纠错、补全，并形成可直接交给 coding agent 执行的修复规格文档。

---

## 0. 总体结论

原报告对 Covalo 工具执行系统的总体判断基本正确：工具调用解析、并发执行、SSRF 防护、salvage 截断阻断等机制已有较好基础；主要风险集中在 **权限默认值过宽**、**参数修复过度信任**、**Workflow 嵌套工具绕过完整执行管线**、**WebBrowser 重定向链 SSRF 检查不完整**、以及 **截断参数副作用映射 fail-open**。

但原报告存在几处需要纠正：

1. **T1 不应列 P1**。Hook 异常已有 fail-safe deny 和 error observer；问题主要是用户侧反馈不够明确，属于 P3/P2 观测性问题。
2. **T3 判断正确，但修复建议应更硬**。`storm` 单 KV pair 修复也应视为 `partial`，否则会把低置信度正则提取当成完整参数。
3. **T4 的“并发复用”表述不准确**。JS 单线程同步解析不是主要风险；真正应修的是 `COMPACT_TOOL_SUMMARY_RE.test()` 对 global regex 的状态性使用。
4. **T6 基本不成立**。Pass 7 的 `escapeRegExp` 与 `\s+` 组合本身没有明显 bug，且有唯一匹配保护。保留回归测试即可，不进入修复主线。
5. **T8 已被源码注释明确标为未实装**，不是隐藏 bug；需要的是运行时/文档约束，避免用户误以为 bubble 已生效。
6. **新增 T15**：`Workflow` 通过 `ctx.invokeTool()` 嵌套调用工具时，没有走完整的 `StreamingToolExecutor` 安全管线；在当前代码中这是比原报告大多数 P2 更重要的漏洞面。

---

## 1. 纠错后的优先级表

| 编号 | 原级别 | 修正级别 | 结论 | 处理 |
|---|---:|---:|---|---|
| T1 Hook 异常反馈 | P1 | P3 | 有 fail-safe 和日志 observer；用户反馈弱 | 可选修 |
| T2 write/edit 默认 allow | P1 | P1 | 成立，且与前次安全审计一致 | 必修 |
| T3 storm 单 KV 修复 | P1 | P1 | 成立；单 KV 也应视为 partial | 必修 |
| T4 global regex 复用 | P2 | P2 | 表述需改；`test()` + `g` 是实质问题 | 必修，小改 |
| T5 compact summary regex | P2 | P3 | 低风险展示清理问题 | 可选测试 |
| T6 fuzzy-edit Pass 7 | P2 | 不修 | 现有唯一匹配保护足够 | 仅补测试 |
| T7 action certificate medium block | P2 | P2 | 成立；medium 不应一律 block | 二期修 |
| T8 subagent bubble 未实装 | P2 | P3/P2 | 已有注释；若用户可配置则需显式 warning | 二期修 |
| T9 ReadTracker 二次放行 | P2 | P3 | 有意设计；缺审计日志 | 可选修 |
| T10 JSON lookahead 200 | P3 | P3 | 低风险召回问题 | 可选修 |
| T11 WebBrowser redirect follow | P3 | P1 | 原报告低估；navigate 链路应逐跳 SSRF 检查 | 必修 |
| T12 hook pending Set | P3 | P3 | 极低概率 | 不进主线 |
| T13 TOOL_SIDE_EFFECTS fail-open | P3 | P1 | 原报告低估；当前大量内置工具未映射 | 必修 |
| T14 unsettledIndices 空实现 | P3 | P3 | 成立但低风险 | 可选修 |
| T15 Workflow 嵌套工具绕过安全管线 | 新增 | P1 | 成立；必须补 | 必修 |

---

## 2. Phase 1：必须优先修复的 SPEC

### SPEC-T2 — PermissionEngine 默认权限改为交互安全

#### 问题

`PermissionEngine` 当前默认策略为：

```ts
exec: "ask",
write: "allow",
edit: "allow",
read: "allow",
```

这会导致 `write_file`、`edit`、`NotebookEdit` 等写入类工具默认无需用户确认。即使上层有 read-before-write 或工具路由限制，这仍是权限层的 fail-open 默认值。

#### 目标

将权限引擎的默认值改成安全基线：

```ts
read: "allow",
write: "ask",
edit: "ask",
exec: "ask"
```

如果确实需要 headless/自动化模式，由引擎或配置显式调用 `setDefaultDecision()` 放宽，而不是在 `PermissionEngine` 内部默认放宽。

#### 修改文件

- `packages/security/src/permission.ts`
- `packages/core/src/engine.ts`
- 相关配置测试文件

#### 实施步骤

1. 修改 `PermissionEngine.defaultDecisionByTier`：

```ts
private defaultDecisionByTier: Record<string, PermissionDecision> = {
  exec: "ask",
  write: "ask",
  edit: "ask",
  read: "allow",
}
```

2. 在 `ReasonixEngine` 构造函数中新增权限默认值配置方法：

```ts
private configurePermissionDefaults(): void {
  const policy = this.config.tools?.approvalPolicy ?? "on-request"

  // 安全默认：读允许，写/编辑/执行询问
  this.permissionEngine.setDefaultDecision("read", "allow")
  this.permissionEngine.setDefaultDecision("write", "ask")
  this.permissionEngine.setDefaultDecision("edit", "ask")
  this.permissionEngine.setDefaultDecision("exec", "ask")

  // 明确无审批模式，才放宽写/编辑/执行。
  if (policy === "never") {
    this.permissionEngine.setDefaultDecision("write", "allow")
    this.permissionEngine.setDefaultDecision("edit", "allow")
    this.permissionEngine.setDefaultDecision("exec", "allow")
  }

  // always：连 read 也走 ask；适合极端审计模式。
  if (policy === "always") {
    this.permissionEngine.setDefaultDecision("read", "ask")
  }
}
```

3. 在构造函数中 `this.permissionEngine = new PermissionEngine()` 后调用：

```ts
this.configurePermissionDefaults()
```

4. 在 `updateConfig()` 中，如果 `partial.tools` 或 `partial.tools.approvalPolicy` 变化，也重新调用：

```ts
if (partial.tools?.approvalPolicy !== undefined) {
  this.configurePermissionDefaults()
}
```

#### 验收标准

- 默认情况下，`write_file`、`edit`、`NotebookEdit` 会触发 `permission_ask`。
- `approvalPolicy: "never"` 时，写入类工具允许无确认执行。
- `approvalPolicy: "always"` 时，read 工具也会触发确认。
- deny rule 仍优先于 allow/default。
- allow rule 仍优先于 default ask。

---

### SPEC-T3 — 禁止 storm 单 KV 修复直接执行

#### 问题

`repairToolArguments()` 的 `storm()` 阶段是最后兜底正则修复。当前多 KV pair 会标记 `partial: true` 并被 `parseToolCallArgs()` 拒绝，但单 KV pair 会被视为完整参数。这种低置信度正则提取不应直接执行，尤其是写入/执行类工具。

#### 目标

所有 `storm` 阶段修复结果都视为 `partial`，默认拒绝执行。未来如需恢复，可做工具 schema 白名单校验，但第一阶段应 fail-closed。

#### 修改文件

- `packages/core/src/context/repair.ts`
- `packages/core/src/executor-helpers.ts`
- 相关测试文件

#### 实施步骤

1. 修改 `repairToolArguments()`：

```ts
const s3 = storm(raw)
if (s3.success) {
  return {
    success: true,
    args: s3.args,
    method: "storm",
    partial: true,
  }
}
```

2. 保持 `parseToolCallArgs()` 现有拒绝逻辑不变：

```ts
if (repairResult.partial) {
  return { ok: false, error: `Invalid JSON arguments for tool ${toolName}: partial repair is unsafe` }
}
```

3. 为以下场景添加测试：

- 输入：`foo "path": "src/a.ts" bar`  
  预期：`parseToolCallArgs()` 返回 `ok: false`
- 多 KV pair 仍返回 `ok: false`
- `scavenge` 能成功修好的合法 JSON 仍允许执行
- `truncate` 能成功修好的完整对象仍按原逻辑执行，但仍受 `shouldBlockSalvagedTruncatedWrite()` 约束

#### 验收标准

- 任何 `method: "storm"` 的修复都不会进入工具执行。
- 正常 JSON 和高置信度 scavenge/truncate 修复不受影响。
- 错误信息明确包含 `partial repair is unsafe`。

---

### SPEC-T13 — TOOL_SIDE_EFFECTS 改为 fail-closed，并补齐内置工具映射

#### 问题

`TOOL_SIDE_EFFECTS` 当前未列出的工具默认返回 `"none"`。这对截断参数恢复来说是危险的 fail-open：一旦新增写入/网络/执行类工具但忘记登记，就可能允许截断参数执行。

当前 `createDefaultTools()` 中至少存在这些未被正确映射的内置工具：

- `bash`
- `WebFetch`
- `WebSearch`
- `Skill`
- `TaskCreate` / `TaskUpdate` / `TaskStop`
- `AskUserQuestion`
- `PlanMode`
- `Sleep`
- `PushNotification`
- `Monitor`
- `WebBrowser`
- `Worktree`
- `Cron`
- `Workflow`
- `AgentTool`
- `SendMessage`
- `Lsp`

此外，现有映射中使用了小写 `web_fetch`，但真实工具名是 `WebFetch`；使用了 `shell`/`run_command`，但真实 shell 工具是 `bash`。

#### 目标

1. 未知工具默认视为 `"external"`，即截断 salvage 参数默认不执行。
2. 补齐 Covalo 内置工具名映射。
3. 对动态/MCP 工具默认 fail-closed。

#### 修改文件

- `packages/core/src/tool-arguments/truncation-recovery.ts`
- `packages/tools/src/index.ts` 相关测试

#### 推荐映射

```ts
export const TOOL_SIDE_EFFECTS: Record<string, ToolSideEffect> = {
  // Workspace
  write_file: "workspace",
  edit: "workspace",
  NotebookEdit: "workspace",
  Worktree: "workspace",

  // Process / execution
  bash: "process",
  Workflow: "process",
  Cron: "process",

  // Network / browser
  WebFetch: "network",
  WebSearch: "network",
  WebBrowser: "network",
  PushNotification: "external",
  SendMessage: "external",

  // External orchestration
  AgentTool: "external",
  Skill: "external",
  Monitor: "external",

  // Task state / local metadata mutation
  TaskCreate: "workspace",
  TaskUpdate: "workspace",
  TaskList: "none",
  TaskGet: "none",
  TaskStop: "workspace",
  PlanMode: "workspace",

  // Read-only / query
  read_file: "none",
  list_dir: "none",
  grep: "none",
  glob: "none",
  AskUserQuestion: "none",
  Lsp: "none",

  // Legacy aliases
  run_command: "process",
  shell: "process",
  web_fetch: "network",
  web_search: "network",
  subagent: "external",
  mcp_tool: "external",
}
```

4. 修改默认值：

```ts
export function getToolSideEffect(toolName: string): ToolSideEffect {
  return TOOL_SIDE_EFFECTS[toolName] ?? "external"
}
```

#### 验收标准

- 未知工具 + salvaged truncated args → blocked。
- `bash` + salvaged truncated args → blocked。
- `WebFetch` / `WebBrowser` + salvaged truncated args → blocked。
- `read_file` / `grep` / `glob` + salvaged truncated args 可继续执行。
- 大小写真实工具名与映射一致。

---

### SPEC-T15 — Workflow 嵌套工具调用必须走安全管线或显式禁止 ask-tier 嵌套执行

#### 问题

`Workflow` 工具通过 `ctx.invokeTool(step.tool, stepArgs)` 调用子工具。当前 `createToolContext().invokeTool` 直接调用 `handler.execute()`，没有走完整的 `StreamingToolExecutor` 安全管线：

缺失项包括：

- 参数 JSON parse/repair/salvage 统一路径
- `shouldBlockSalvagedTruncatedWrite()`
- read-before-write guard
- before/after hook
- result persistence
- action certificate gate
- UI permission ask 流
- tool_start / tool_progress / tool_done 标准事件

更关键的是，当前逻辑对 `Workflow` 特判：

```ts
if (permission?.decision === "ask" && stack[0] !== "Workflow") {
  return makeToolError(`Nested tool requires direct confirmation and was not executed: ${name}`)
}
```

这意味着：只要顶层 `Workflow` 被确认，内部 ask-tier 工具可直接执行。若内部步骤包含 `bash` 危险命令或写入工具，将绕过 action certificate 与 read-before-write 等保护。

#### 目标

第一阶段采用安全修复：**禁止 Workflow 内部执行 ask-tier 或 deny-tier 工具**。Workflow 只允许执行已明确 allow 的无副作用工具，或由未来专门的 workflow preflight 审批机制接管。

#### 修改文件

- `packages/core/src/streaming-executor.ts`
- `packages/tools/src/workflow.ts`
- 相关测试

#### 实施步骤

1. 删除 Workflow 特判：

```ts
// 修改前
if (permission?.decision === "ask" && stack[0] !== "Workflow") {
  return makeToolError(`Nested tool requires direct confirmation and was not executed: ${name}`)
}

// 修改后
if (permission?.decision === "ask") {
  return makeToolError(`Nested tool requires direct confirmation and was not executed: ${name}`)
}
```

2. 为 nested invocation 增加最低限度的 read-before-write 检查：

```ts
if (this.readTracker) {
  const filePath = extractFilePath(name, args)
  if (filePath && isWriteTool(name)) {
    const guard = this.readTracker.checkWrite(filePath, this.cwd)
    if (!guard.ok) {
      return makeToolError(guard.reason ?? "Write guard: read file first")
    }
  }
}
```

3. 对 nested bash 加 action certificate gate，或在第一阶段直接禁止 nested bash：

```ts
if (name === "bash" || name === "shell" || name === "exec") {
  return makeToolError(`Nested execution tool is not allowed inside Workflow: ${name}`)
}
```

4. 在 `Workflow` 工具描述中明确第一阶段限制：

```ts
description: "Execute safe multi-step workflows. Nested write/exec tools that require confirmation are not executed inside Workflow; run them as top-level tool calls instead."
```

#### 长期方案

如果产品确实需要 Workflow 执行写入/exec：

- 新增 `workflowPreflight(steps)`。
- 对所有步骤做风险分类、文件写入列表、命令风险列表。
- 一次性向用户展示完整 execution plan。
- 用户批准后生成 workflow certificate。
- 仍然对每个内部步骤执行 read-before-write、action certificate、hooks 与 result persistence。

#### 验收标准

- 默认配置下，Workflow 内部 `bash` 不执行。
- 默认配置下，Workflow 内部 `write_file` / `edit` 不执行，返回“requires direct confirmation”。
- Workflow 内部 `read_file` / `grep` / `glob` 可执行。
- T2 修改后，Workflow 不再绕过 write/edit/exec 的 ask 默认值。
- 回归测试覆盖“Workflow 内嵌危险 bash 不执行”。

---

### SPEC-T11 — WebBrowser navigate 改为逐跳重定向 SSRF 检查

#### 问题

`WebFetch` 已使用 `redirect: "manual"` 并逐跳验证重定向目标；`WebBrowser` 的 `navigate` 分支使用 `fetch(url, { redirect: "follow" })`，只检查初始 URL 和最终 URL。这样中间跳转到内网地址时，请求已经发生，SSRF 防护滞后。

Playwright runner 对 `click` / `fill` / `extract` / `screenshot` 分支有 `context.route("**/*", ...)` 防护，但 `navigate` 分支不是走 runner，而是主进程 fetch，因此需要单独修。

#### 修改文件

- `packages/tools/src/web-browser.ts`
- 可选：`packages/tools/src/web-fetch.ts` 导出复用的 redirect/SSRF helper

#### 实施步骤

1. 在 `web-browser.ts` 新增 `fetchWithManualRedirects()`：

```ts
const MAX_BROWSER_REDIRECTS = 5

async function fetchWithManualRedirects(
  rawUrl: string,
  signal: AbortSignal,
): Promise<Response | { error: string }> {
  let currentUrl = rawUrl

  for (let i = 0; i <= MAX_BROWSER_REDIRECTS; i++) {
    const urlErr = await validateRemoteUrl(currentUrl)
    if (urlErr) return { error: urlErr }

    const resp = await fetch(currentUrl, { signal, redirect: "manual" })

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location")
      if (!location) return { error: `Redirect without Location header: ${resp.status}` }

      const nextUrl = new URL(location, currentUrl).toString()
      const nextErr = await validateRemoteUrl(nextUrl)
      if (nextErr) return { error: `Redirect target blocked: ${nextErr}` }

      currentUrl = nextUrl
      continue
    }

    return resp
  }

  return { error: `Too many redirects (max ${MAX_BROWSER_REDIRECTS})` }
}
```

2. 替换 navigate 分支：

```ts
const result = await fetchWithManualRedirects(url, signal)
if ("error" in result) {
  return { content: safeStringify({ error: result.error }), isError: true }
}
const resp = result
```

3. 返回内容中使用最终 URL：

```ts
return { content: safeStringify({ content, code: resp.status, url: resp.url || finalUrl }), isError: false }
```

4. 为以下情况添加测试：

- 外部 URL 302 到 `http://127.0.0.1`
- 外部 URL 302 到 `http://169.254.169.254`
- 外部 URL 相对跳转到另一个外部 URL
- 超过最大重定向数

#### 验收标准

- `WebBrowser.navigate` 与 `WebFetch` 具备同等逐跳 SSRF 防护。
- 初始、每一跳、最终 URL 均做协议、凭据、私网 IP/DNS 检查。
- 私网中间跳转不会发起第二跳请求。

---

## 3. Phase 2：建议修复 SPEC

### SPEC-T7 — action certificate 中 medium 风险不应无条件 block

#### 问题

当前 `executeToolResult()` 对 `bash` / `shell` / `exec` 的 medium/high 风险命令一律阻塞。由于 exec 工具在前置权限层通常已经触发过用户确认，这会导致“用户已确认，但运行时仍硬拦截”的体验冲突。并且被阻塞的命令记录为 `cancelled`，审计语义不准确。

#### 目标

- `high`：默认 block，除非将来有显式 human dangerous approval。
- `medium`：记录 action certificate，但不自动 block；必要时走 permission ask。
- blocked 结果使用 `blocked_by_policy` 或 `prevented`，不要使用 `cancelled`。

#### 修改文件

- `packages/core/src/harness-evolution/packets/action-certificate.ts`
- `packages/core/src/streaming-executor.ts`

#### 实施步骤

1. 扩展 `OutcomeStatus`：

```ts
export type OutcomeStatus = "ok" | "failed" | "cancelled" | "blocked_by_policy"
```

2. 修改 block 分支：

```ts
const outcome = {
  status: "blocked_by_policy" as const,
  exitCode: -1,
  durationMs: 0,
}
```

3. 调整风险处理：

```ts
if (risk === "high") {
  // block
}

if (risk === "medium") {
  // create certificate but allow execution after existing permission flow
}
```

4. 中风险命令执行后补全 certificate outcome：

```ts
const outcome = {
  status: result.isError ? "failed" : "ok",
  exitCode: typeof result.metadata?.exitCode === "number" ? result.metadata.exitCode : undefined,
  durationMs,
}
```

#### 验收标准

- `npm run lint` 不再被 action certificate 无条件 block。
- `rm -rf /` 仍被 block。
- blocked certificate outcome 不再是 `cancelled`。

---

### SPEC-T8 — subagent bubble 模式显式降级或拒绝配置

#### 问题

`checkSubagentPermission()` 会返回 `bubble: true`，但 `spawnSubagent()` 只检查 `allowed`，不处理 `bubble`。源码注释已明确“bubble 协议当前未实装”，因此不是隐藏 bug；但如果用户配置 `permissionMode: "bubble"`，实际效果是 deny，而非“向父级申请”。

#### 目标

短期：禁止用户误用。  
长期：实现 parent approval bubble。

#### 短期实施

1. 在 subagent registry 加载定义时，如果发现 `permissionMode === "bubble"`，打印/记录 warning：

```ts
bubble permission mode is not implemented; it behaves as deny. Use readonly, denyExec, or acceptEdits.
```

2. 可选：直接把 `"bubble"` 从可选配置中移除，或标为 deprecated。

3. 在 `spawnSubagent()` 中，如果 `perm.bubble` 为 true，deny reason 必须明确：

```ts
reason: `${perm.reason}. Bubble approval is not implemented; request was denied.`
```

#### 验收标准

- 用户不会误以为 bubble 会向父级申请。
- acceptEdits 中 exec 被拒绝时，错误信息明确说明 bubble 未实装。

---

### SPEC-T9 — ReadTracker warn-mode 二次放行增加审计日志

#### 问题

非 strict 模式下，未读写入第一次阻塞，第二次放行。这是有意设计，但 executor 没有记录 `withWarning` 路径。

#### 修改文件

- `packages/core/src/streaming-executor.ts`

#### 实施步骤

在 read-before-write guard 后增加：

```ts
if (guard.ok && guard.withWarning && diagnosticsEnabled) {
  logger.warn("tool.write_guard.second_attempt_allowed", {
    toolName: tc.function.name,
    filePath,
    warning: guard.withWarning,
  })
}
```

#### 验收标准

- 第二次未读写入放行时，有可审计日志。
- strict 模式行为不变。

---

### SPEC-T1 — Hook 异常返回更明确的用户反馈

#### 问题

`HookManager.runBeforeToolCall()` 捕获 hook 异常后返回 `"deny"`，引擎层最终给用户的错误可能只是通用 permission denied。engine 已配置 error observer，所以日志存在；缺的是用户侧 reason。

#### 推荐改法

不要简单把原始 stack trace 暴露给模型。增加结构化结果类型：

```ts
export type HookPermissionResult =
  | PermissionDecision
  | { decision: PermissionDecision; reason?: string }
```

`runBeforeToolCall()` 返回：

```ts
return {
  decision: "deny",
  reason: `beforeToolCall hook failed: ${e instanceof Error ? e.message : String(e)}`
}
```

`evaluatePermission()` 接收结构化结果后，把 reason 带到 `resolveDenyMessage()` 或返回结构化 PermissionOutcome。

如果改动面过大，先只增强日志，不进入 Phase 1。

---

### SPEC-T4 — 修复 global regex `test()` 状态性问题

#### 问题

`COMPACT_TOOL_SUMMARY_RE` 是 global regex，既用于 `replace`，又用于 `test()`。带 `g` 的正则调用 `test()` 会改变 `lastIndex`，连续调用时可能出现奇偶次结果不一致。

#### 修改文件

- `packages/core/src/tool-calls/text-parsers.ts`

#### 实施步骤

新增非 global regex：

```ts
const COMPACT_TOOL_SUMMARY_RE = /\[调用工具:\s*[\w.,\s-]+\]+/g
const COMPACT_TOOL_SUMMARY_PRESENT_RE = /\[调用工具:\s*[\w.,\s-]+\]+/
```

修改：

```ts
|| COMPACT_TOOL_SUMMARY_PRESENT_RE.test(content)
```

或者在 `test()` 前显式：

```ts
COMPACT_TOOL_SUMMARY_RE.lastIndex = 0
```

更推荐新增 present regex，避免后续误用。

#### 验收标准

- 连续两次调用 `containsEmbeddedToolCalls("[调用工具: bash]")` 都返回 true。
- `stripResidualToolChannelMarkup()` 行为不变。

---

## 4. Phase 3：低优先级清理

### SPEC-T5 — 校验 `COMPACT_TOOL_SUMMARY_RE` 的 `\]+`

当前模式：

```ts
/\[调用工具:\s*[\w.,\s-]+\]+/g
```

`\]+` 会匹配一个或多个右中括号。风险低，主要影响展示清理。建议补测试：

- `[调用工具: bash]` 应移除。
- `[调用工具: bash]]` 应移除。
- 正常正文中 `]` 不应被过度吞掉。

若无必要，不改。

---

### SPEC-T10 — JSON tool lookahead 从 200 调整为 500

`parseJsonToolObjects()` 和 `stripLikelyToolJsonObjects()` 使用 200 字符 lookahead。可调整为常量：

```ts
const TOOL_JSON_LOOKAHEAD_CHARS = 500
```

低风险优化，不进入主线。

---

### SPEC-T14 — 删除或实装 `unsettledIndices()`

当前 `unsettledIndices()` 永远返回空数组。由于当前调用方未依赖它，低风险。建议二选一：

1. 删除接口字段。
2. 改为 `createSettleLedger(totalCount)` 并真正返回未 settle 索引。

推荐删除，减少误用。

---

### SPEC-T12 — Hook pending Set 超时保护

不是当前真实泄漏，但可做防御性增强：

```ts
const timeout = new Promise<void>((resolve) => setTimeout(resolve, 30_000))
await Promise.race([p, timeout]).finally(() => this.pending.delete(p))
```

注意：这不会中断 hook 本身，只能防止 `drain()` 永久等待。低优先级。

---

## 5. 明确不修或仅补测试

### T6 fuzzy-edit Pass 7

原报告认为 `escapeRegExp` 与 `\s+` 交互可能导致错误匹配。源码中每段已做 `escapeRegExp`，并且要求唯一匹配，否则返回 null。该实现没有明显安全问题。

仅建议补测试：

- needle 含 `function(a, b)`。
- needle 含 `foo.bar?.baz()`.
- needle 含正则特殊字符 `* + ? [ ]`.
- 多处匹配时必须返回 null。

---

## 6. 推荐执行顺序

### Phase 1：安全基线

1. `SPEC-T2` — PermissionEngine write/edit 默认 ask。
2. `SPEC-T3` — storm 单 KV 修复也标 partial。
3. `SPEC-T13` — TOOL_SIDE_EFFECTS fail-closed + 补齐内置工具。
4. `SPEC-T15` — Workflow 嵌套工具不再绕过 ask/action/read guard。
5. `SPEC-T11` — WebBrowser navigate 逐跳 SSRF 检查。

### Phase 2：语义与观测

6. `SPEC-T7` — action certificate medium risk 改为记录/ask，不直接 block。
7. `SPEC-T8` — bubble 模式显式 warning / 禁用。
8. `SPEC-T9` — ReadTracker warn-mode 二次放行记录日志。
9. `SPEC-T1` — Hook fail-safe deny 带 reason。

### Phase 3：清理

10. `SPEC-T4` — global regex test 状态性修复。
11. `SPEC-T5` / `SPEC-T10` / `SPEC-T12` / `SPEC-T14` — 低风险清理和测试。

---

## 7. 给 coding agent 的执行提示词

下面这段可以直接交给 coding agent：

```text
你要修复 Covalo v0.1.3 工具执行与权限系统的问题。请严格按以下顺序实施，不要自行扩大范围：

Phase 1:
1. 修改 packages/security/src/permission.ts：
   - PermissionEngine 默认 read=allow, write=ask, edit=ask, exec=ask。
   - 保持 deny > allow > default 的优先级。
2. 修改 packages/core/src/engine.ts：
   - 新增 configurePermissionDefaults()。
   - 根据 config.tools.approvalPolicy 调整默认权限。
   - 构造函数初始化 PermissionEngine 后调用。
   - updateConfig() 中 tools.approvalPolicy 变化时重新应用。
3. 修改 packages/core/src/context/repair.ts：
   - repairToolArguments() 中 storm 阶段所有 success 都返回 partial: true。
   - 保持 executor-helpers.ts 中 partial repair 拒绝执行逻辑。
4. 修改 packages/core/src/tool-arguments/truncation-recovery.ts：
   - getToolSideEffect() 未知工具默认 external。
   - 补齐 createDefaultTools() 中所有真实工具名的副作用映射，尤其 bash、WebFetch、WebBrowser、Workflow、AgentTool、Worktree、Cron、SendMessage、PushNotification。
5. 修改 packages/core/src/streaming-executor.ts：
   - createToolContext().invokeTool 中删除 Workflow 对 ask-tier 的特殊放行。
   - nested invokeTool 遇到 permission ask 一律返回错误。
   - nested bash/shell/exec 第一阶段直接禁止，返回明确错误。
   - nested write 工具至少执行 read-before-write guard。
6. 修改 packages/tools/src/web-browser.ts：
   - navigate 分支禁止 redirect: "follow"。
   - 改为 redirect: "manual" 并逐跳调用 validateRemoteUrl()。
   - 限制最大 redirect 5 次。
   - 每一跳均拒绝私网 IP、私网 DNS、非 http/https、带 credentials URL。

Phase 2:
7. 修改 action certificate：
   - high risk 仍 block。
   - medium risk 不再无条件 block，记录 certificate 后允许在已有 permission 流程下执行。
   - OutcomeStatus 增加 blocked_by_policy，blocked 分支不要再用 cancelled。
8. subagent bubble：
   - bubble 未实装时必须在错误信息中说明“Bubble approval is not implemented; request was denied.”
9. ReadTracker:
   - warn mode 第二次放行时记录 tool.write_guard.second_attempt_allowed。
10. Hook:
   - beforeToolCall hook 抛错时，日志和用户错误信息都能区分 hook failure 与普通 permission deny。

Phase 3:
11. text-parsers.ts:
   - 不要用带 g 的 COMPACT_TOOL_SUMMARY_RE 做 test()；新增非 global present regex。
12. unsettledIndices():
   - 删除或实装，不要保留永远返回空数组的接口。

完成后必须补测试：
- PermissionEngine 默认 write/edit/exec ask。
- approvalPolicy never 放宽。
- storm 单 KV repair 被拒绝。
- 未知工具 + salvaged truncated args 被阻断。
- bash/WebFetch/WebBrowser/Workflow 等真实工具名 sideEffect 正确。
- Workflow 内部 bash/write_file 不执行。
- WebBrowser navigate 302 到 127.0.0.1 被阻断。
- containsEmbeddedToolCalls 连续调用结果稳定。
```

---

## 8. 回归测试清单

最小测试集合：

```bash
bun test packages/security
bun test packages/core
bun test packages/tools
bun run typecheck
```

重点新增测试文件建议：

| 测试文件 | 覆盖 |
|---|---|
| `packages/security/src/permission.test.ts` | 默认权限、approvalPolicy 映射 |
| `packages/core/src/context/repair.test.ts` | storm 单 KV partial |
| `packages/core/src/tool-arguments/truncation-recovery.test.ts` | unknown/default external、真实工具名映射 |
| `packages/core/src/streaming-executor.workflow.test.ts` | Workflow nested ask-tier deny、nested bash deny |
| `packages/tools/src/web-browser.test.ts` | manual redirect SSRF |
| `packages/core/src/tool-calls/text-parsers.test.ts` | global regex test 稳定性 |

---

## 9. 最终判定

原报告整体方向正确，但优先级需要重排：

- 真正应该进入第一修复轮的不是 T1/T4/T5/T6，而是 **T2、T3、T13、T15、T11**。
- `Workflow` 嵌套调用绕过完整安全管线是原报告遗漏的关键问题。
- `TOOL_SIDE_EFFECTS` 默认 `"none"` 是截断参数保护的 fail-open 缺陷，应从 P3 提升为 P1。
- `WebBrowser.navigate` 的 redirect follow 问题不只是低优先级一致性问题，而是 SSRF 中间跳风险，应提升到 P1。
- fuzzy-edit Pass 7 和大部分 regex 清理问题可降级为测试/清理项。
