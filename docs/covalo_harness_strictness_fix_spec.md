# Covalo Harness Strictness 修复实施规格书

> 适用仓库：`bzcsk2/covalo`  
> 适用基线：PR #39 合并后的 `main`  
> 原始审计报告：`covalo_harness_strictness_audit_20260705.md`  
> 文档目的：把 Harness 严格度审计报告改写为可直接交给 coding agent 执行的详细修复 spec。  
> 重要原则：不照搬原报告的 P0/P1 分级；按实际代码风险、修复成本和运行时收益重新排序。

---

## 0. 总体判断

Covalo 的 Harness 三档严格度系统已经具备完整的**策略声明层**：

- `strict`
- `normal`
- `loose`

三档都会映射为 `EffectiveHarnessPolicy`，字段覆盖工具集、并行度、最大轮数、读前写、文本工具抢救、分支预算、checkpoint、验证、早停、工具路由、执行模式、shell 策略、supervisor 策略等。

当前核心问题不是“系统不可用”，而是：

> **Harness policy 的声明矩阵比实际 runtime enforcement 更完整。部分字段已经声明，但没有真正接入 engine / loop / executor / checkpoint / shell runtime。**

直接后果：

1. 用户对 `strict` 档的安全和稳定性有过高预期。
2. `loose` 档仍可能执行不应执行的治理逻辑。
3. 小模型、本地模型没有真正获得最小工具集和并行限制。
4. 跨 session 切换时可能继承上一个 session 的 strictness。
5. 新旧 harness 系统并存，长期维护容易误用旧字段。

本 spec 将修复项重新划分为三组：

- **Phase 1：必须修复的 runtime enforcement 缺口。**
- **Phase 2：策略语义一致性修复。**
- **Phase 3：迁移清理与文档项。**

---

## 1. 执行约束

### 1.1 coding agent 必须遵守

- 不要一次性重构整个 Engine / Loop。
- 不要改变三档策略矩阵本身，除非本 spec 明确要求。
- 不要删除旧 `HarnessProfile`，除非已有兼容迁移测试。
- 每个 runtime enforcement 修复必须有测试。
- 不要用 skip 掩盖测试失败。
- 不要让 strict/normal/loose 在执行中途动态突变；严格度应在每次 `submit()` 开始时固化。
- 不要把 `loose` 变成完全无治理；只关闭本 spec 明确要求关闭的行为。
- 不要让工具 schema 可见性和工具执行权限失配：如果路由不注入某工具，该工具也不应被允许执行，除非是内部协议工具如 `select_category`。

### 1.2 推荐 PR 拆分

#### PR-A：Harness policy runtime enforcement

覆盖：

- FIX-H1：`toolset` 接入工具路由。
- FIX-H2：`textToolSalvage` 按 policy 生效。
- FIX-H3：`loadSession()` 清理跨 session strictness/policy 残留。
- FIX-H4：`maxParallelTools` 接入 executor。

#### PR-B：Checkpoint / Shell 策略语义

覆盖：

- FIX-H5：`checkpoint` 字段真正控制 checkpoint persist frequency。
- FIX-H6：实现或收敛 `dual-track-conservative` shell 策略。

#### PR-C：迁移清理与文档

覆盖：

- CLEAN-H1：新旧 `effectivePolicy` / `harnessProfile` 迁移说明和 fallback 限缩。
- DOC-H1：`setHarnessStrictness()` 生效时机文档。
- DOC-H2：`branchBudget: "recover"` 语义说明。
- DOC-H3：`modelOverrides` 子串匹配说明。
- DOC-H4：`BoundedRepairLoop` 实验状态说明。

---

## 2. 当前问题重新分级

| 原报告编号 | 原始判断 | 本 spec 判断 | 新优先级 |
|---|---|---|---|
| P0-H1 | `toolset` 未传递到路由 | 事实正确，影响 strict/normal 工具可见性 | P1-high |
| P0-H2 | `maxParallelTools` 未消费 | 事实正确，影响小模型稳定性 | P1-high |
| P0-H3 | `textToolSalvage` 未按策略分支 | 事实正确，loose `off` 未生效 | P1 |
| P0-H4 | `checkpoint` 字段未消费 | 主判断正确，细节略有误 | P1/P2 |
| P0-H5 | shell conservative 无差异 | 事实正确，strict shell 承诺未落地 | P1 |
| P1-H1 | `loadSession()` 不清 strictness/policy | 事实正确，跨会话隔离问题 | P1-high |
| P1-H2 | submit 中途切换不生效 | 事实正确，但是合理设计 | P3-doc |
| P1-H3 | 新旧 harness 字段冲突 | 部分正确，主要是维护债务 | P2 |
| P1-H4 | loose direct 在小窗口可能浪费 token | 产品策略，不是 bug | P3 |
| P1-H5 | branchBudget recover 语义含糊 | 判断客观，需文档说明 | P2-doc |
| P2-H5 | `BoundedRepairLoop` 未集成 | 基本正确，属实验模块状态问题 | P2/P3 |

---

## 3. Phase 1：必须修复的 runtime enforcement 缺口

---

### FIX-H1：让 `EffectiveHarnessPolicy.toolset` 真正进入工具路由

**优先级**：P1-high  
**类型**：runtime enforcement / 工具可见性  
**文件**：

- `packages/core/src/loop.ts`
- `packages/core/src/tool-routing/two-stage-router.ts`
- `packages/core/src/tool-routing/types.ts`
- 建议新增或扩展：`packages/core/__tests__/harness-runtime-policy.test.ts`

#### 背景

当前三档策略中：

```ts
strict.toolset = "minimal"
normal.toolset = "coding"
loose.toolset = "full"
```

`resolveToolRouting()` 已经支持 `ctx.toolset`，并能按 `TOOLSET_CATEGORIES` 做确定性过滤：

```ts
minimal -> read/write
coding  -> read/write/search/run
full    -> read/write/search/run/plan/code_intel
```

但 `loop.ts` 构造 `routingCtx` 时未传 `effectivePolicy.toolset`，导致 `resolveToolRouting()` 内部默认回退到 `"full"`。

#### 目标行为

- strict 模式下，Stage 0 deterministic filter 只允许 `read` / `write` 类别。
- normal 模式下，只允许 `read` / `write` / `search` / `run` 类别。
- loose 模式下允许全部类别。
- two-stage 的 Stage 1 `select_category` 枚举值也应受 toolset 限制。
- 如果模型试图调用未注入 / 不允许的工具，应返回 `tool_not_allowed`，不能真实执行。

#### 实施方案

在 `loop.ts` 构造 `routingCtx` 时增加：

```ts
toolset: effectivePolicy?.toolset,
```

示例：

```ts
const routingCtx = {
  allTools: toolSpecs,
  contextWindow: ctx.getContextWindow(),
  routingOverride: routingMode,
  selectedCategory,
  toolset: effectivePolicy?.toolset,
}
```

确认 `ToolRoutingContext` 已有 `toolset?: ToolsetSize` 字段；如果已有，不需要改类型。

#### 关键注意

`resolveToolRouting()` 返回的 `routedTools` 是传给 LLM 的工具 schema。工具执行阶段还需要防止模型调用不可见工具。

当前 `engine.ts` 传入：

```ts
allowedToolNames: effectiveMode === "loop"
  ? new Set(toolSpecs.map(spec => spec.function.name))
  : undefined
```

这只基于原始 `toolSpecs`，而不是 `routedTools`。如果模型通过历史上下文、错误恢复或恶意输出调用未注入工具，executor 仍可能允许执行。

因此需要在 `loop.ts` 内部为每一轮根据 `routedTools` 构造本轮 allowed set，并传给 executor：

```ts
const effectiveAllowedToolNames = routedTools
  ? new Set(routedTools.map(spec => spec.function.name))
  : allowedToolNames
```

传给：

```ts
toolExecutor.run(toolCalls, signal, appendToolResult, traceContext, effectiveAllowedToolNames)
```

处理 `select_category` 前不要用 `effectiveAllowedToolNames` 拦截它，因为它由 loop 内部拦截。

#### 测试要求

1. **strict toolset minimal**
   - 构造 read/write/search/run/plan/code_intel 六类工具。
   - `effectivePolicy.toolset = "minimal"`。
   - 调用 `resolveToolRouting()` 或跑一轮 `runLoop()`。
   - 断言 routed tools 只含 read/write，或 Stage 1 enum 只含 read/write。

2. **normal toolset coding**
   - 断言 plan/code_intel 不可见。

3. **loose toolset full**
   - 断言所有类别可见。

4. **未注入工具不能执行**
   - strict 模式下模拟模型直接请求 `AgentTool` 或 `LSP`。
   - 断言返回 `tool_not_allowed`，不执行真实工具。

5. **select_category 不被误拦截**
   - two-stage 下 `select_category` 能被 loop 处理，而不是 executor 拒绝。

#### 验收标准

- strict 与 normal 的工具可见性真实不同。
- routed tool schema 与执行 allowed set 一致。
- 不破坏 loose/direct 模式。
- 不破坏 two-stage category selection。

---

### FIX-H2：让 `textToolSalvage` 按 policy 生效

**优先级**：P1  
**类型**：runtime enforcement / 模型输出解析  
**文件**：

- `packages/core/src/loop.ts`
- `packages/core/src/tool-calls/text-salvage.ts`
- 建议新增：`packages/core/__tests__/harness-text-salvage-policy.test.ts`

#### 背景

当前三档声明：

```ts
strict.textToolSalvage = "always"
normal.textToolSalvage = "on-native-failure"
loose.textToolSalvage = "off"
```

但 `loop.ts` 当前只要满足：

```ts
reason === "stop"
toolCalls.length === 0
fullContent.trim()
```

就会调用 `salvageTextToolCallsInResponse()`，完全不读取 `effectivePolicy.textToolSalvage`。

#### 目标行为

- `strict / always`：保持现有行为，只要正文中有可抢救工具调用就抢救。
- `normal / on-native-failure`：当前阶段可先等价为“允许文本抢救”，但必须留 TODO 标注 native parse error 尚未接入。
- `loose / off`：完全禁用 text tool salvage。模型文本应作为普通 assistant_final，不应被强制转为 tool call。

#### 最小实施方案

在 `loop.ts` salvage 位置加入 policy gate：

```ts
const salvageMode = effectivePolicy?.textToolSalvage ?? "on-native-failure"
const allowTextToolSalvage =
  salvageMode === "always" || salvageMode === "on-native-failure"

if (
  allowTextToolSalvage
  && reason === "stop"
  && toolCalls.length === 0
  && fullContent.trim()
) {
  const salvaged = salvageTextToolCallsInResponse(...)
}
```

并加注释：

```ts
// TODO: "on-native-failure" currently means "fallback when no native tool_calls were produced".
// Provider-level native parse error telemetry is not yet available.
```

#### 不允许的实现

不要为了实现 `on-native-failure` 而臆造 `hadNativeParseError`。除非 provider stream 明确暴露 parse error，否则不能伪造状态。

#### 测试要求

1. **loose/off 不 salvage**
   - 模型返回文本中包含嵌入工具调用。
   - `effectivePolicy.textToolSalvage = "off"`。
   - 断言没有 tool execution，assistant_final 保留文本。

2. **strict/always salvage**
   - 同样输入。
   - `effectivePolicy.textToolSalvage = "always"`。
   - 断言 tool call 被 salvage 并执行。

3. **normal/on-native-failure 当前兼容行为**
   - 断言仍会 salvage。
   - 测试名明确说明当前语义是 fallback-on-no-native-tool-calls。

#### 验收标准

- loose 模式真正关闭文本工具抢救。
- strict 保持原先兼容行为。
- normal 行为有测试锁定和 TODO 说明。

---

### FIX-H3：`loadSession()` 清理 `sessionStrictness` 和 `effectivePolicy`

**优先级**：P1-high  
**类型**：跨会话隔离  
**文件**：

- `packages/core/src/engine.ts`
- 测试：建议新增或扩展 engine session 相关测试

#### 背景

当前 `ReasonixEngine` 持有：

```ts
private sessionStrictness?: HarnessStrictness
private effectivePolicy: EffectiveHarnessPolicy | null = null
```

`setHarnessStrictness()` 会设置 session 级 strictness。`getHarnessStrictness()` 会返回：

```ts
effectivePolicy?.strictness ?? sessionStrictness ?? "normal"
```

但是 `loadSession()` 不清理这两个字段。结果：

- 会话 A 设置 strict。
- 切到会话 B。
- B 的第一次 submit 会继承 A 的 `sessionStrictness`。
- `getEffectivePolicy()` 在 loadSession 后也可能返回上一会话 submit 的旧快照。

#### 目标行为

- `loadSession()` 是 session boundary。
- 切换 session 后，session-level strictness 不应跨 session 继承。
- 切换 session 后，`effectivePolicy` 旧快照应清空。
- 下次 submit 应重新按优先级解析：
  1. 新 session 显式 strictness
  2. 项目配置
  3. model override
  4. model profile/default

#### 实施方案

在 `loadSession()` 清理状态处加入：

```ts
this.sessionStrictness = undefined
this.effectivePolicy = null
```

推荐放在：

```ts
this.sessionId = sessionId
this.ctx.log.clear()
this.ctx.clearTransientState()
```

之后或之前均可，但必须在 `_loadSessionMessages()` 前。

#### 测试要求

1. **sessionStrictness 不跨 session**
   - 创建 engine。
   - `setHarnessStrictness("strict")`。
   - `loadSession(sessionB)`。
   - 断言 `getHarnessStrictness()` 不再返回 strict，除非项目配置另有 strict。

2. **effectivePolicy 清空**
   - 先执行一次 submit 或通过测试入口设置 effectivePolicy。
   - `loadSession(sessionB)`。
   - 断言 `getEffectivePolicy() === null`。

3. **下次 submit 重新解析**
   - session B 下执行 submit。
   - 断言 policy source/strictness 按当前项目配置或默认值解析。

#### 验收标准

- loadSession 后无旧 session strictness 残留。
- 不影响 checkpoint/session log 恢复。
- 不影响 taskLedger / verificationGate 既有清理行为。

---

### FIX-H4：接入 `maxParallelTools`

**优先级**：P1-high  
**类型**：runtime enforcement / 工具执行并发  
**文件**：

- `packages/core/src/loop.ts`
- `packages/core/src/streaming-executor.ts`
- 建议新增：`packages/core/__tests__/harness-max-parallel-tools.test.ts`

#### 背景

三档声明：

```ts
strict.maxParallelTools = 2
normal.maxParallelTools = 3
loose.maxParallelTools = 5
```

但当前 `StreamingToolExecutor` 对 `shared` 工具会收集到 `sharedBatch`，再一次性 `Promise.allSettled(pending)`，没有 harness 并发上限。

exclusive 工具当前天然串行，主要需要限制的是 shared batch。

#### 目标行为

- strict 最多同时执行 2 个 shared 工具。
- normal 最多同时执行 3 个 shared 工具。
- loose 最多同时执行 5 个 shared 工具。
- exclusive 工具继续串行。
- permission check 仍可先批量完成，但实际 execute 阶段必须限流。
- event 输出顺序保持 deterministic，即仍按 tool call index 输出最终结果。

#### 实施方案

给 `StreamingToolExecutor.run()` 增加可选参数：

```ts
maxParallelTools?: number
```

调用位置：

```ts
toolExecutor.run(
  toolCalls,
  signal,
  appendToolResult,
  traceContext,
  effectiveAllowedToolNames,
  effectivePolicy?.maxParallelTools,
)
```

如果担心 positional args 继续膨胀，可以改为 options object：

```ts
interface ToolRunOptions {
  traceContext?: Record<string, unknown>
  allowedToolNames?: ReadonlySet<string>
  maxParallelTools?: number
}
```

但这会改更多调用点。若当前 PR 追求小改，positional arg 可接受。

#### 并发限制实现

不要引入新依赖。实现一个简单 worker pool：

```ts
async function runLimited<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length)
  let next = 0

  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i], i) }
      } catch (reason) {
        results[i] = { status: "rejected", reason }
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    () => worker(),
  )

  await Promise.all(workers)
  return results
}
```

注意：

- 单个工具内部异常仍应转为 error result。
- 不要让一个工具 reject 终止整个 batch。
- 保持最终 `settled_results.sort((a, b) => a.index - b.index)`。

#### 测试要求

1. **strict limit 2**
   - 构造 5 个 shared mock tools。
   - 每个工具进入时递增 active counter，退出时递减。
   - 断言最大 active 不超过 2。

2. **normal limit 3**
   - 同上，断言不超过 3。

3. **loose limit 5**
   - 同上，断言不超过 5。

4. **exclusive 不并发**
   - 现有 exclusive 工具继续串行。

5. **结果顺序稳定**
   - 模拟不同耗时工具。
   - 断言最终 tool events 按原 toolCall index 输出。

#### 验收标准

- maxParallelTools 对 shared batch 生效。
- 不破坏 permission ask/deny 流程。
- 不破坏工具结果 append。
- 不引入未处理 Promise rejection。

---

## 4. Phase 2：策略语义一致性修复

---

### FIX-H5：让 `checkpoint` 字段真正控制落盘频率

**优先级**：P1/P2  
**类型**：checkpoint 策略一致性  
**文件**：

- `packages/core/src/checkpoint/checkpoint-engine.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/loop.ts`
- checkpoint 测试文件

#### 背景

三档声明：

```ts
strict.checkpoint = "frequent"
normal.checkpoint = "safe-point"
loose.checkpoint = "minimal"
```

当前 `CheckpointEngine.shouldPersistOnTrigger()` 不读取该字段，而是读取：

```ts
FREE_PERSIST_TRIGGERS
forcedPolicyActive && FORCED_EXTRA_TRIGGERS
```

`forcedPolicyActive` 又由 `executionMode` 间接控制。

#### 目标行为

`checkpoint` 应成为显式策略：

| checkpoint | 目标行为 |
|---|---|
| frequent | 所有关键 trigger 都落盘，包括 step_completed、verification_started、tool_failed、verification_failed、compaction、final_draft |
| safe-point | safe point 与重要失败落盘：step_completed、tool_failed、verification_failed、compaction、final_draft |
| minimal | 只在 tool_failed、final_draft 落盘 |

建议：`manual` 永远落盘，因为手动触发通常是显式要求。

#### 实施方案

在 `CheckpointEngine` 增加字段：

```ts
private checkpointPolicy: "frequent" | "safe-point" | "minimal" = "safe-point"

setCheckpointPolicy(policy: "frequent" | "safe-point" | "minimal"): void {
  this.checkpointPolicy = policy
}
```

修改：

```ts
shouldPersistOnTrigger(trigger: CheckpointSaveTrigger): boolean {
  if (trigger === "manual") return true

  if (this.checkpointPolicy === "frequent") {
    return true
  }

  if (this.checkpointPolicy === "minimal") {
    return trigger === "tool_failed" || trigger === "final_draft"
  }

  // safe-point
  return (
    trigger === "step_completed"
    || trigger === "tool_failed"
    || trigger === "verification_failed"
    || trigger === "compaction"
    || trigger === "final_draft"
  )
}
```

然后在 `engine.ts` 每次解析 `effectivePolicy` 后设置：

```ts
this.checkpointEngine.setCheckpointPolicy(this.effectivePolicy.checkpoint)
```

#### forcedPolicyActive 如何处理

保留 `forcedPolicyActive`，但不再让它控制 persist frequency。它仍可表示当前 execution segment 状态，减少本轮改动。

#### 测试要求

1. **frequent**
   - 所有关键 trigger 返回 true。

2. **safe-point**
   - `step_completed` true。
   - `tool_failed` true。
   - `verification_failed` true。
   - `final_draft` true。

3. **minimal**
   - `tool_failed` true。
   - `final_draft` true。
   - `compaction` false。
   - `verification_failed` false。
   - `step_completed` false.

4. **engine submit 设置 policy**
   - strict submit 后 checkpoint engine policy = frequent。
   - loose submit 后 policy = minimal。

#### 验收标准

- `checkpoint` 字段不再是声明空转。
- executionMode 与 checkpoint frequency 解耦。
- 现有 checkpoint 恢复逻辑不受影响。

---

### FIX-H6：实现或收敛 `dual-track-conservative` shell 策略

**优先级**：P1  
**类型**：shell 策略语义  
**文件**：

- `packages/core/src/engine.ts`
- `packages/tools/src/index.ts`
- `packages/tools/src/shell-exec.ts`
- `packages/tools/src/shell-dual-track/bash-dual-track.ts`
- shell 相关测试

#### 背景

strict 声明：

```ts
shellPolicy = "dual-track-conservative"
```

normal/loose 声明：

```ts
shellPolicy = "dual-track"
```

但当前两者都只是：

```ts
createBashTool({ dualTrack: true })
```

`createBashTool()` 没有 conservative 参数。

#### 目标选择

这里必须先做产品决策，有两个可接受方案。

### 方案 A：真正实现 conservative

`dual-track-conservative` 相比 `dual-track` 至少有一个可测试差异：

1. 禁止显式 `background: true` 执行 destructive 命令。
2. 对 `auto` 命令更短 soft timeout。
3. 对 foreground 默认 timeout 更短。
4. 对高风险但未命中 deny 的命令返回 ask/warn。
5. 禁止某些 shell pattern 在 foreground 直接执行。

建议最小实现：

```ts
createBashTool({ dualTrack: true, conservative: true })
```

类型：

```ts
export interface BashToolOptions {
  dualTrack?: boolean
  conservative?: boolean
}
```

传到：

```ts
createDualTrackBashTool({ conservative: options.conservative })
```

`DualTrackBashOptions`：

```ts
export interface DualTrackBashOptions {
  name?: string
  conservative?: boolean
}
```

在 conservative 模式下：

- `pickForegroundTimeout()` 的默认 timeout cap 降低。
- `auto` soft escalation 时间降低。
- 对 destructive command，即使用户传 `background: true`，仍强制 foreground 或拒绝。
- description 中说明 conservative behavior。

#### 测试要求

1. strict 下 `createBashTool()` 收到 conservative=true。
2. conservative 模式 timeout 与 normal dual-track 不同。
3. destructive 命令不能 background。
4. 普通 safe command 仍可执行。

### 方案 B：删除虚假差异

如果暂时不想实现 conservative，则必须收敛策略声明：

- 把 strict 的 `shellPolicy` 改为 `"dual-track"`。
- 或保留枚举但文档明确它当前 alias 到 `"dual-track"`。

不建议长期保留“名字不同、行为完全相同”的策略字段。

#### 推荐

优先方案 A。如果时间紧，先方案 B，但必须在 policy 注释里写清楚：

```ts
// dual-track-conservative currently aliases to dual-track; reserved for future stricter shell runtime.
```

#### 验收标准

- strict shell 策略不再虚假承诺。
- 测试能证明 conservative 与普通 dual-track 的差异，或文档明确 alias。

---

## 5. Phase 3：迁移清理与文档项

---

### CLEAN-H1：限制旧 `HarnessProfile` fallback 的影响范围

**优先级**：P2  
**类型**：迁移债务  
**文件**：

- `packages/core/src/engine.ts`
- `packages/core/src/model-profile/*`

#### 背景

当前同时存在：

- 新系统：`EffectiveHarnessPolicy`
- 旧系统：`HarnessProfile`

二者字段含义和值域不同，例如：

- 新 normal `maxTurns = 50`
- 旧 `local-medium-forced.maxTurns = 40`
- 旧系统有 `toolset = none`
- 新三档没有 none
- shell/supervisor 枚举也不一致

当前 engine 仍解析：

```ts
const harnessProfile = resolveDefaultHarness(modelName, isLocal)
```

虽然大多数字段已改用 `effectivePolicy`，但 fallback 存在会增加误读风险。

#### 目标行为

- 新 runtime 路径优先且明确使用 `effectivePolicy`。
- 旧 `HarnessProfile` 只作为兼容 fallback，并且注释说明。
- 不再新增对 `harnessProfile` 字段的消费点。
- 如果某字段已经能由 `effectivePolicy` 表达，禁止回退旧字段。

#### 实施建议

把 fallback 收敛为显式函数：

```ts
const legacyHarnessProfile = resolveDefaultHarness(modelName, isLocal)
```

并加注释：

```ts
// Legacy fallback only. Do not use for new runtime policy decisions.
```

对于：

```ts
requireVerificationBeforeFinal:
  (this.effectivePolicy?.verification === "block"
    || this.effectivePolicy?.verification === "require-or-waive")
  ?? harnessProfile.requireVerificationBeforeFinal
```

由于左侧永远是 boolean，不会走 `?? harnessProfile...`。可直接改为：

```ts
requireVerificationBeforeFinal:
  this.effectivePolicy?.verification === "block"
  || this.effectivePolicy?.verification === "require-or-waive"
```

#### 测试要求

- strict/normal/loose verification 规则均按 effectivePolicy 生效。
- 删除 fallback 后测试不变。

---

### DOC-H1：说明 `setHarnessStrictness()` 生效时机

**优先级**：P3  
**类型**：文档 / JSDoc  
**文件**：

- `packages/core/src/engine.ts`
- 用户文档或 CLI 文档中对应 `/harness` 命令说明

#### 目标说明

`setHarnessStrictness()` 不应在当前 submit 中途生效。它应在下一次 submit 开始时生效。

修改 JSDoc：

```ts
/**
 * 设置会话级 Harness 严格度。
 *
 * 生效时机：
 * - 如果当前没有 submit 正在运行，则下一次 submit 开始时生效。
 * - 如果当前 submit 正在运行，不会改变本次 loop 的工具集、路由、验证或 checkpoint 策略。
 *   新严格度会在下一次 submit 开始时重新解析并固化。
 *
 * 这是有意设计：避免同一次 loop 中途发生工具集/权限/路由突变。
 *
 * @deprecated 使用 AgentProfile 中的 harness 配置代替
 */
setHarnessStrictness(strictness: HarnessStrictness): void
```

---

### DOC-H2：说明 `branchBudget: "recover"` 的真实语义

**优先级**：P2-doc  
**类型**：文档 / 命名清晰度  
**文件**：

- `packages/core/src/harness/policy.ts`
- `packages/core/src/governance/branch-budget.ts`
- 文档中 harness strictness 说明

#### 当前真实语义

- `enforce`：硬拦截重复失败工具。
- `recover`：不拦截当前工具调用，但记录分支预算计数；超限后提交 `recovery_pending` 信号，推动 adaptive mode 进入 forced/recovery。
- `observe`：不启用分支预算。

#### 建议文档

```ts
branchBudget:
  "enforce" // hard-block repeated failing actions
  "recover" // observe counts and trigger mode recovery, but do not block current batch
  "observe" // disabled / diagnostic only
```

暂不重命名，避免配置兼容问题。

---

### DOC-H3：说明 `modelOverrides` 是子串匹配

**优先级**：P3  
**类型**：配置文档  
**文件**：

- `packages/core/src/harness/strictness.ts`
- 用户文档

#### 背景

当前：

```ts
normalizedModel.includes(pattern.toLowerCase())
```

这是子串匹配，可能误匹配，但符合简单配置的直觉。

#### 建议文档

```md
modelOverrides uses case-insensitive substring matching.

Example:
{
  "modelOverrides": {
    "qwen": "strict",
    "deepseek": "normal"
  }
}

The key "qwen" matches "qwen3-8b" and "qwen2.5-coder-14b".
Use more specific keys if needed.
```

---

### DOC-H4：标注 `BoundedRepairLoop` 的实验状态

**优先级**：P2/P3  
**类型**：实验模块状态说明  
**文件**：

- `packages/core/src/harness-evolution/repair-loop.ts`
- README 或 internal architecture doc

#### 背景

`BoundedRepairLoop` 已实现 repair round、review、incident、recovery、accept/escalate 等结构，但当前主引擎没有通过它驱动闭环。engine 只是直接创建和写入 packet。

#### 目标行为

二选一：

### 方案 A：标注 experimental / not wired

在 `repair-loop.ts` 顶部加：

```ts
/**
 * Experimental repair-loop orchestrator.
 *
 * Current status:
 * - Packet types are integrated into engine submit lifecycle.
 * - BoundedRepairLoop itself is not wired into ReasonixEngine/runLoop.
 * - Do not assume this class drives production repair behavior.
 */
```

### 方案 B：真正集成

这不是本轮建议范围。若要集成，需要单独 spec，包括：

- repair round 生命周期
- worker output 进入 review
- incident 创建条件
- recovery instruction 注入
- max repair rounds
- accept/escalate 输出

#### 验收标准

- 用户和维护者不会误以为 `BoundedRepairLoop` 已经生产接入。
- 不改变当前 packet 创建逻辑。

---

## 6. 测试总体要求

完成 Phase 1 后，至少新增以下测试文件或等价覆盖：

```text
packages/core/__tests__/harness-runtime-policy.test.ts
packages/core/__tests__/harness-text-salvage-policy.test.ts
packages/core/__tests__/harness-session-isolation.test.ts
packages/core/__tests__/harness-max-parallel-tools.test.ts
```

也可以合并到现有测试文件，但测试名必须明确对应 FIX 编号。

### 必须覆盖矩阵

| 修复项 | 必须测试 |
|---|---|
| FIX-H1 toolset | strict minimal / normal coding / loose full / unexposed tool not executable |
| FIX-H2 textToolSalvage | loose off 不 salvage / strict always salvage / normal 当前 fallback salvage |
| FIX-H3 session isolation | loadSession 清 sessionStrictness / 清 effectivePolicy / 下次 submit 重解析 |
| FIX-H4 maxParallelTools | shared 工具并发上限 / exclusive 保持串行 / 结果顺序稳定 |
| FIX-H5 checkpoint | frequent/safe-point/minimal trigger 矩阵 |
| FIX-H6 shell conservative | conservative 与 dual-track 有差异，或文档明确 alias |

---

## 7. 验收命令

coding agent 完成任一 PR 后必须运行：

```bash
bun run typecheck
bun test
```

若 full suite 存在 main 既有失败，必须额外运行 touched tests：

```bash
bun test packages/core/__tests__/harness-strictness.test.ts
bun test packages/core/__tests__/harness-runtime-policy.test.ts
bun test packages/core/__tests__/harness-text-salvage-policy.test.ts
bun test packages/core/__tests__/harness-session-isolation.test.ts
bun test packages/core/__tests__/harness-max-parallel-tools.test.ts
```

如果实现 shell conservative，还要运行：

```bash
bun test packages/tools/__tests__/shell-security.test.ts
bun test packages/tools/__tests__/*shell*.test.ts
```

---

## 8. agent 执行提示词

下面这段可以直接交给 coding agent：

```text
你正在修复 bzcsk2/covalo 的 Harness strictness runtime enforcement 问题。请严格按照 docs/specs/harness-strictness-fix-spec.md 执行。

核心目标：
三档 strict / normal / loose 不应只是 policy.ts 里的声明，而要在 engine / loop / executor / checkpoint / shell runtime 中真实生效。

执行顺序：
1. 先修 FIX-H3：loadSession 清理 sessionStrictness 和 effectivePolicy。
2. 再修 FIX-H1：effectivePolicy.toolset 传入 resolveToolRouting，并保证 routed tools 与 executor allowed tools 一致。
3. 再修 FIX-H2：textToolSalvage 按 policy 生效，至少保证 loose/off 不 salvage。
4. 再修 FIX-H4：maxParallelTools 限制 shared 工具并发。
5. 再修 FIX-H5：checkpoint 字段控制 shouldPersistOnTrigger。
6. 最后处理 FIX-H6：实现 dual-track-conservative，或明确声明它当前 alias 到 dual-track。

约束：
- 每个 FIX 必须有测试。
- 不要改三档 policy 矩阵，除非处理 FIX-H6 的 alias 方案。
- 不要让 strictness 在 submit 中途立即改变当前 loop。
- 不要删除旧 HarnessProfile，除非已有兼容测试。
- 不要让模型执行未注入/未允许的工具。
- 不要伪造 provider native parse error；textToolSalvage 的 on-native-failure 精确语义可先 TODO。

完成后输出：
- 修改文件列表
- 每个 FIX 的实现说明
- 测试命令与结果
- 未处理项及原因
```

---

## 9. 建议 issue 切分

### Issue 1：Harness toolset runtime enforcement

包含：

- FIX-H1

标题建议：

```text
fix(harness): enforce EffectiveHarnessPolicy.toolset in tool routing and execution
```

### Issue 2：Harness text tool salvage policy

包含：

- FIX-H2

标题建议：

```text
fix(harness): honor textToolSalvage off/always policy in loop
```

### Issue 3：Harness session isolation

包含：

- FIX-H3

标题建议：

```text
fix(engine): clear session-level harness policy on loadSession
```

### Issue 4：Harness max parallel tools

包含：

- FIX-H4

标题建议：

```text
fix(executor): enforce maxParallelTools for shared tool batches
```

### Issue 5：Harness checkpoint frequency

包含：

- FIX-H5

标题建议：

```text
fix(checkpoint): make checkpoint frequency follow EffectiveHarnessPolicy
```

### Issue 6：Shell conservative policy

包含：

- FIX-H6

标题建议：

```text
fix(shell): implement or document dual-track-conservative policy
```

---

## 10. 最终交付标准

一个合格修复 PR 至少满足：

- `typecheck` 通过。
- touched tests 通过。
- 不引入新增 full suite 失败。
- strict/normal/loose 的 runtime 差异可通过测试证明。
- `toolset`、`textToolSalvage`、`maxParallelTools`、`checkpoint` 至少有 1 个直接测试覆盖。
- `loadSession()` 后不会保留旧 session strictness/policy。
- PR 描述明确区分：
  - 已实现的 runtime enforcement
  - 仅文档化的语义说明
  - 延后处理的迁移债务

---

## 11. 不建议本轮处理的事项

### 11.1 不建议重构整个 HarnessProfile 系统

旧 `HarnessProfile` 与新 `EffectiveHarnessPolicy` 并存确实不优雅，但不是本轮最重要的问题。先让 runtime enforcement 生效，再做旧系统迁移。

### 11.2 不建议改 loose 的 direct 策略

loose + direct 是可以成立的产品选择。小上下文窗口下 token 浪费可以通过用户选择 normal/auto 解决。本轮只需要保证 loose 的其他声明，例如 `textToolSalvage: off`，真实生效。

### 11.3 不建议强行接入 BoundedRepairLoop

`BoundedRepairLoop` 是更大的 harness-evolution 闭环问题。当前应先标注 experimental / not wired，避免误导；真正接入需要单独设计。

### 11.4 不建议实现复杂 modelOverrides 匹配语法

当前子串匹配可接受。本轮只补文档。复杂匹配规则留到配置系统重构时处理。

---

## 12. 简化版优先级清单

如果时间有限，只做以下 4 项：

1. `loadSession()` 清 `sessionStrictness` / `effectivePolicy`。
2. `toolset` 传入 routing，并把 routed tools 同步到 allowed tools。
3. `textToolSalvage: off` 真正关闭 salvage。
4. `maxParallelTools` 限制 shared batch 并发。

这 4 项完成后，Harness strictness 才能从“策略声明”变成“基本可信的 runtime policy”。

