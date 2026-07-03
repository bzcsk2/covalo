# Covalo v0.1.3 内存与上下文管理审计纠错版 + Agent 修复 SPEC

生成日期：2026-07-03  
审查对象：`bzcsk2/covalo` 当前默认分支，`package.json` 版本 `0.1.3`  
输入报告：`covalo_memory_context_audit_20260703.md`

---

## 0. 总结结论

这份新审计报告方向总体正确：它抓住了 Covalo 当前“上下文生命周期”“长期记忆链路”“持久化层增长”三类问题。但原报告存在三个明显偏差：

1. **把一些“未接入的未来功能”定成 P0 过重。**  
   `ExperienceStore` / `OutcomeStore` 的确存在未完整接入运行时的问题，但这不是立即导致上下文污染或数据破坏的 P0。`ExperienceStore recall` 应作为架构能力补全进入 P1；`OutcomeStore` 更像观测/统计功能未接入，建议降到 P3 或标记实验模块。

2. **M5 的 reasoning_content 建议需要纠偏。**  
   机械摘要中补充 `tool_calls` 摘要是合理的；但把 `reasoning_content` 写入摘要区不建议执行。`reasoning_content` 属于模型内部推理/思考轨迹，加入摘要会带来 token 膨胀、隐私与行为漂移风险。正确方向是保留工具行为事实，不保留推理链。

3. **M4 不应修。**  
   compact 模式 “LLM summary → trim old log” 是合理流程，不是双重截断 bug。不能改成 `compress`，否则会用机械摘要覆盖 LLM 摘要。最多补注释和日志命名。

最终建议：按本文 Phase 1 → Phase 2 → Phase 3 实施。不要让 agent 直接照原报告修。

---

## 1. 核验结果总表

| 原 ID | 原级别 | 纠正级别 | 结论 | 处理方式 |
|---|---:|---:|---|---|
| M1 | P0 | **P1** | `ExperienceStore.recall()`、`formatExperienceForPrompt()` 已实现，但运行时未注入；`storeWeaknesses()` 说明存在写入侧，不是完全零代码 | 接入 trusted-only recall，带开关和上限 |
| M2 | P0 | **P3 / Deferred** | `OutcomeStore` 未实例化，属统计观测功能缺口，不是运行时安全问题 | 标记实验模块；暂不阻塞修复 |
| M3 | P1 | **P1** | `loadSession()` 只清 log，不清 scratch/summary，跨会话污染成立 | 立即修复 |
| M4 | P1 | **P3 / 注释项** | compact 成功后 trim 是正确流程；不要改成 compress | 只补注释/日志 |
| M5 | P1 | **P2** | 机械摘要只取 content，缺少 tool 行为事实；但不得加入 reasoning_content | 补 tool_calls / tool_result 摘要，禁止 reasoning |
| M6 | P1 | **P1** | `refreshLedgerContext()` 全量 `scratch.reset()` 会丢 supervisor guidance | 立即修复：scratch 支持按 name 删除 |
| M7 | P1 | **P2** | 队列有 500 条上限，不是无界增长；但按条数不按字节，messages 快照可积压 | 加字节上限和 messages coalescing |
| M8 | P1 | **P3** | “中间损坏跳过所有后续行”描述不准确；当前从末尾扫描可跳过尾部坏行 | 增补测试；暂不重写为原子日志 |
| M9 | P2 | **P2** | `CheckpointEngine.save()` 读改写无锁，低概率竞态成立 | 加实例级 save 队列 |
| M10 | P2 | **P3** | 当前策略偏保守但安全；原报告的 fake placeholder 修法不建议 | 只加回归测试，暂不改 |
| M11 | P2 | **P3** | `GoalStore` 同步 I/O 成立，但是否热路径未证实 | 后续优化，不进首轮 |
| M12 | P2 | **P2** | 若启用 recall，全量读 JSONL 会成为问题 | 与 M1 同步做防御性优化 |
| M13 | P2 | **P1** | `AgentScoreStore.append()` 先读全文件再重写，确实低效且有竞态 | 立即改为 appendFileSync |
| M14 | P3 | **P3** | SurfaceStore cache 声明未使用成立 | 可顺手修 |
| M15 | P3 | **P3** | ContextPolicyStore 无锁，但用户低频操作，风险低 | 暂缓 |
| M16 | P3 | **P3** | sessionByteUsage 进程级 Map 设计基本合理；真正问题是 cleanup 未等待 | 后续优化 |
| M17 | P3 | **P3** | Prefix fingerprint 重算有开销，但现有 engine 已有外层 cache 逻辑；另有重复 build 历史问题 | 暂缓或与 prefix-cache 修复合并 |
| A1 | 架构 | Long-term | `.covalo` 存储碎片化成立 | 长期 StorageManager |
| A2 | 架构 | **P1** | 与 M1 同一问题：记忆写入/检索链路未闭环 | Phase 1 补全 |
| A3 | 架构 | Long-term | 压缩策略缺乏中间层成立 | 长期设计，不进入本轮 |

---

## 2. Phase 1：必须优先实施

### SPEC-01：修复 loadSession 跨会话 scratch / summary 残留

**对应问题**：M3  
**优先级**：P1  
**文件**：`packages/core/src/engine.ts`  
**相关类**：`ReasonixEngine`, `ContextManager`, `ContextSummary`, `VolatileScratch`

#### 当前问题

`loadSession()` 当前只执行：

```ts
this.sessionId = sessionId
this.ctx.log.clear()
```

但 `ContextManager.buildMessages()` 会组合：

```ts
[prefix] + [summary] + [log] + [scratch]
```

因此只清 log 会让前一会话的 `summary` 和 `scratch` 继续进入新会话上下文。`scratch` 里可能有 TaskLedger / Supervisor guidance；`summary` 里可能有上一会话的压缩摘要。这是明确的跨会话上下文污染。

#### 修复要求

在 `loadSession()` 切换 session 时，清理 `scratch` 和 `summary`。

推荐最小实现：

```ts
// engine.ts loadSession()
this.sessionId = sessionId
this.ctx.log.clear()
this.ctx.scratch.reset()
this.ctx.getSummary().clear()
```

如果希望封装得更干净，给 `ContextManager` 添加方法：

```ts
// packages/core/src/context/manager.ts
clearTransientState(): void {
  this.scratch.reset()
  this.summary.clear()
}
```

然后在 `loadSession()` 中调用：

```ts
this.ctx.log.clear()
this.ctx.clearTransientState()
```

#### 注意事项

- 不要清理 `prefix`，因为基础 system prompt 和当前 agent 配置不属于会话历史。
- 不要清理 `baseSystemPrompt`。
- 可以考虑同时重置 `prefixCacheKey = ""`，但这不是本问题的必要条件；若改动 prefix cache，需要单独测试。

#### 验收标准

新增测试：

1. 向当前 engine 的 summary 写入 `SESSION_A_SUMMARY`。
2. 向 scratch 写入 `SESSION_A_SCRATCH`。
3. 调用 `loadSession("session-b")`。
4. 调用 `ctx.buildMessages()`。
5. 断言结果不包含 `SESSION_A_SUMMARY` 和 `SESSION_A_SCRATCH`。

---

### SPEC-02：修复 scratch.reset() 清空非 ledger 消息

**对应问题**：M6  
**优先级**：P1  
**文件**：

- `packages/core/src/context/scratch.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/supervisor/guided-loop.ts`

#### 当前问题

`refreshLedgerContext()` 当前逻辑：

```ts
refreshLedgerContext: () => {
  this.ctx.scratch.reset()
  this.injectTaskLedgerContext(this.taskLedger)
}
```

这会清掉所有 scratch 消息，包括 Supervisor guidance。Supervisor guidance 当前通过：

```ts
input.ctx.scratch.append({ role: "user", content })
```

写入 scratch，因此 ledger 刷新会把 guidance 清除。

#### 修复原则

不要再用全量 reset 刷新 TaskLedger。Scratch 必须支持“按来源刷新”。

#### 实施步骤

**1. 扩展 `VolatileScratch`**

```ts
// packages/core/src/context/scratch.ts
removeByName(name: string): void {
  this.entries = this.entries.filter((m) => m.name !== name)
}

replaceByName(name: string, messages: ChatMessage[]): void {
  this.removeByName(name)
  for (const msg of messages) {
    this.append({ ...msg, name })
  }
}
```

说明：`ChatMessage.name` 当前会被 clone 保留，但 DeepSeekClient 对非 tool/assistant 消息发送请求时只发送 `{ role, content }`，不会把 `name` 传给 provider。因此它适合作为本地 scratch 元数据。

**2. 给 TaskLedger 注入命名**

修改 `injectTaskLedgerContext()`：

```ts
private injectTaskLedgerContext(ledger?: TaskLedgerTracker, includePlanRequest = false): void {
  if (!ledger) return

  const messages: ChatMessage[] = []
  const formatted = ledger.formatForContext()

  if (formatted.trim()) {
    messages.push({ role: "user", content: formatted })
  }

  if (includePlanRequest && ledger.plan.length === 0) {
    messages.push({ role: "user", content: planRequestInstruction() })
  }

  this.ctx.scratch.replaceByName("task_ledger", messages)
}
```

**3. 修改 refreshLedgerContext**

```ts
refreshLedgerContext: () => {
  this.injectTaskLedgerContext(this.taskLedger)
}
```

不要再调用 `scratch.reset()`。

**4. 给 Supervisor guidance 注入命名**

修改 `injectAdviceToContext()`：

```ts
input.ctx.scratch.append({ role: "user", content, name: "supervisor_guidance" })
```

这一步不是为了刷新 guidance，而是为了后续观测和精确清理。

#### 验收标准

新增测试：

1. scratch 中先注入 `{ name: "supervisor_guidance", content: "KEEP_ME" }`。
2. TaskLedger 触发 `refreshLedgerContext()`。
3. 断言 scratch 仍包含 `KEEP_ME`。
4. 断言 scratch 中 task ledger 只有一份，不会重复叠加。

---

### SPEC-03：接入 ExperienceStore recall，但只注入 trusted 经验

**对应问题**：M1 / A2  
**优先级**：P1  
**文件**：

- `packages/core/src/engine.ts`
- `packages/core/src/harness-evolution/experience/experience-store.ts`
- `packages/core/src/harness-evolution/experience/recall-policy.ts`
- 可选：`packages/core/src/config/schema.ts`

#### 当前问题

`ExperienceStore` 已实现 append / recall，`recall-policy.ts` 已实现 `buildRecallFilter()` 和 `formatExperienceForPrompt()`，`weakness-miner.ts` 也提供 `storeWeaknesses()` 写入路径。但运行时没有在 `submit()` 或 `runLoop()` 中把 recall 结果注入上下文。

这导致系统“只记不忆”。

#### 修复原则

- 默认只注入 `trusted` 经验。
- 限制数量，默认 3 条。
- 限制年龄，默认 30 天。
- 限制 confidence，默认 >= 0.3。
- recall 失败不得阻塞 submit。
- 不注入 untrusted，除非显式配置。
- 注入到 scratch，并使用 `name: "experience_recall"` 便于清理/观测。

#### 实施步骤

**1. 改造 `ExperienceStore.recall()`：跳过坏行，避免单行损坏导致全量失败**

当前：

```ts
const all: ExperienceRecord[] = lines.map(l => JSON.parse(l) as ExperienceRecord);
```

改成：

```ts
const all: ExperienceRecord[] = []
for (const line of lines) {
  try {
    all.push(JSON.parse(line) as ExperienceRecord)
  } catch {
    continue
  }
}
```

可选增加最大读取保护：

```ts
const MAX_RECALL_LINES = 5000
const lines = content.trim().split("\n").filter(Boolean).slice(-MAX_RECALL_LINES)
```

**2. 在 engine 中新增 recall 注入方法**

```ts
private async injectExperienceRecall(): Promise<void> {
  if (process.env.COVALO_EXPERIENCE_RECALL === "false") return

  try {
    const {
      ExperienceStore,
      buildRecallFilter,
      formatExperienceForPrompt,
    } = await import("./harness-evolution/experience/index.js")

    const store = new ExperienceStore(process.cwd())
    await store.init()

    const filter = buildRecallFilter({
      // 默认策略来自 DEFAULT_RECALL_POLICY：trusted only / 30 days / limit 3 / confidence >= 0.3
    })

    const { records } = await store.recall(filter)
    if (records.length === 0) return

    const content = formatExperienceForPrompt(records, true).trim()
    if (!content) return

    this.ctx.scratch.removeByName("experience_recall")
    this.ctx.scratch.append({
      role: "system",
      name: "experience_recall",
      content: [
        "## Retrieved Trusted Experiences",
        "Use these as weak guidance. Current task instructions and repository evidence take precedence.",
        content,
      ].join("\n\n"),
    })
  } catch (e) {
    if (this.logger.isEnabled("debug")) {
      this.logger.debug("experience.recall.failed", {
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
}
```

**3. 在 submit 生命周期中调用**

调用位置：`this.ctx.startTurn()` 之后，TaskLedger 注入之前或之后均可，但必须在 `ctx.log.append({ role: "user" ... })` 前完成。

推荐：

```ts
this.ctx.startTurn()

await this.injectExperienceRecall()

if (shouldCreateLedger(userInput)) {
  this.taskLedger = new TaskLedgerTracker(userInput)
  this.injectTaskLedgerContext(this.taskLedger, true)
}
```

#### 验收标准

新增测试：

1. 没有 `.covalo/experience/experiences.jsonl` 时，submit 正常运行。
2. 有一条 `trusted` 经验时，`ctx.buildMessages()` 中包含 `Retrieved Trusted Experiences`。
3. 有一条 `untrusted` 经验时，默认不注入。
4. 经验文件包含坏 JSON 行时，submit 不抛错。
5. `refreshLedgerContext()` 后，`experience_recall` 仍存在。

---

### SPEC-04：修复 AgentScoreStore.append 的全文件重写

**对应问题**：M13  
**优先级**：P1  
**文件**：`packages/core/src/scoring/store.ts`

#### 当前问题

当前 `append()` 先读完整文件，再写完整文件：

```ts
const existing = existsSync(path) ? readFileSync(path, "utf8") : ""
writeFileSync(path, existing + line + "\n", "utf8")
```

评分文件增长后，每次 append 成本线性增加，并且存在读-改-写竞态。

#### 修复要求

改为真正 append：

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs"
```

```ts
append(score: AgentRunScore): void {
  const workflowId = score.workflowId ?? "benchmark"
  const path = this.pathForWorkflow(workflowId)
  mkdirSync(dirname(path), { recursive: true })
  const line = JSON.stringify(score)
  appendFileSync(path, line + "\n", "utf8")
}
```

#### 验收标准

1. 连续 append 三条 score，`list()` 返回 3 条，顺序不变。
2. 文件已有内容时 append 不覆盖原内容。
3. 大文件 append 不调用 `readFileSync`。

---

## 3. Phase 2：尽快修复，但需要更完整测试

### SPEC-05：优化 createSummaryContent，只保留工具事实，不保留 reasoning_content

**对应问题**：M5  
**优先级**：P2  
**文件**：`packages/core/src/context/manager.ts`

#### 当前问题

`createSummaryContent()` 当前只取 `message.content`。这会让 `compress` 模式下被移除的 tool call 行为事实丢失。

但原报告建议加入 `reasoning_content`，不建议采纳。

#### 修复原则

- 可以保留工具调用名称、少量安全参数、工具结果是否错误。
- 不保留 `reasoning_content`。
- 参数摘要必须限长。
- 不把完整工具结果、完整文件内容、密钥、长 JSON 写进摘要。
- 摘要是“行为事实索引”，不是完整 replay log。

#### 建议实现

新增辅助函数：

```ts
function clip(value: unknown, max = 80): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value)
  if (!raw) return ""
  const normalized = raw.replace(/\s+/g, " ").trim()
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized
}

function summarizeToolCall(tc: ToolCall): string {
  const safeKeys = ["path", "file", "filePath", "command", "cwd", "pattern", "query"]
  let argsSummary = ""

  try {
    const parsed = JSON.parse(tc.function.arguments)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts = safeKeys
        .filter(k => k in parsed)
        .map(k => `${k}=${clip((parsed as Record<string, unknown>)[k], 60)}`)
      argsSummary = parts.join(", ")
    }
  } catch {}

  return argsSummary
    ? `[tool_call: ${tc.function.name}(${argsSummary})]`
    : `[tool_call: ${tc.function.name}]`
}
```

修改 `createSummaryContent()`：

```ts
private createSummaryContent(messages: ChatMessage[]): string {
  const existing = this.summary.getRawContent()

  const lines = messages
    .map((message) => {
      const parts: string[] = []

      const raw = message.content ?? ""
      const content = raw.replace(/\s+/g, " ").trim()
      if (content) {
        parts.push(content.length > 200 ? `${content.slice(0, 199)}…` : content)
      }

      if (message.tool_calls) {
        for (const tc of message.tool_calls) {
          parts.push(summarizeToolCall(tc))
        }
      }

      if (message.role === "tool") {
        const status = message.is_error ? "error" : "ok"
        parts.push(`[tool_result: ${message.name ?? "unknown"} ${status}]`)
      }

      // Intentionally do NOT include reasoning_content.
      const combined = parts.join(" ").trim()
      return combined ? `${message.role}: ${combined}` : null
    })
    .filter((line): line is string => line !== null)

  return [
    "Previous conversation summary:",
    existing,
    lines.join("\n"),
    "This summary was generated to reduce context usage. Newer messages override this summary when conflicts exist.",
  ].filter(Boolean).join("\n\n")
}
```

#### 验收标准

1. assistant 消息包含 `tool_calls` 时，compress 摘要包含 `[tool_call: <name>(...)]`。
2. tool 消息 `is_error=true` 时，摘要包含 `[tool_result: <name> error]`。
3. 任何 `reasoning_content` 不出现在摘要中。
4. 参数摘要长度受限，不把完整大 JSON 写入 summary。

---

### SPEC-06：AsyncSessionWriter 增加字节上限与 messages coalescing

**对应问题**：M7  
**优先级**：P2  
**文件**：`packages/core/src/session.ts`

#### 当前问题

`AsyncSessionWriter` 当前按条数限制队列，`MAX_QUEUE_SIZE = 500`。在高频工具调用或连续 submit 场景中，`messages` 记录可能很大，仅按条数限制不足以控制内存。

#### 修复原则

- 保留最新 `messages` 快照，旧的未 flush messages 快照可以 coalesce。
- 加入字节上限，避免 500 条大 messages 快照占用大量内存。
- event 可以丢，但不要把最新 messages 丢掉。
- 不能破坏 `drain()` 语义。

#### 建议实现

新增字段：

```ts
private queueBytes = 0
private queueSizes: number[] = []
private static MAX_QUEUE_BYTES = 10 * 1024 * 1024
```

在 `enqueue()` 中记录大小：

```ts
const serialized = JSON.stringify(record) + "\n"
const size = Buffer.byteLength(serialized, "utf8")

if (record.type === "messages") {
  this.evictOlderQueuedMessages()
}

this.queue.push(serialized)
this.queueRecords.push(record)
this.queueSizes.push(size)
this.queueBytes += size
this.evictIfNeeded()
```

实现 coalescing：

```ts
private evictOlderQueuedMessages(): void {
  for (let i = this.queueRecords.length - 1; i >= 0; i--) {
    if (this.queueRecords[i].type === "messages") {
      this.queueBytes -= this.queueSizes[i]
      this.queue.splice(i, 1)
      this.queueRecords.splice(i, 1)
      this.queueSizes.splice(i, 1)
      this.droppedCount++
      return
    }
  }
}
```

修改 `evictIfNeeded()` 条件：

```ts
while (
  this.queue.length > AsyncSessionWriter.MAX_QUEUE_SIZE ||
  this.queueBytes > AsyncSessionWriter.MAX_QUEUE_BYTES
) {
  // 先丢 event
  // 再丢 stats
  // 再丢旧 messages，但尽量保留最新一条 messages
}
```

修改 flush 时同步 queueSizes / queueBytes：

```ts
const batch = this.queue.splice(0, 50)
const sizes = this.queueSizes.splice(0, 50)
this.queueRecords.splice(0, 50)
this.queueBytes -= sizes.reduce((a, b) => a + b, 0)
const chunk = batch.join("")
await appendFile(this.path, chunk, "utf-8")
```

#### 验收标准

1. 队列连续 enqueue 100 条 messages，只保留最新未 flush messages。
2. 队列总字节超过 10MiB 时触发淘汰。
3. `drain()` 后 queue、queueRecords、queueSizes 均为空，queueBytes 为 0。
4. `readDetailed()` 仍能恢复最后一条 messages。

---

### SPEC-07：CheckpointEngine.save 串行化

**对应问题**：M9  
**优先级**：P2  
**文件**：`packages/core/src/checkpoint/checkpoint-engine.ts`

#### 当前问题

`save()` 执行读 → merge → 写 tmp → rename，但没有串行化。虽然大部分调用在单一 loop 中 await，但 shutdown / safe-point / 未来并发子系统可能产生同一实例上的 save 交错。

#### 修复要求

使用实例级 promise chain。不要使用全局 static lock，避免无关 session 相互阻塞。

#### 建议实现

```ts
private saveChain: Promise<RuntimeCheckpointV2> = Promise.resolve(this.getV2State())

async save(input: CheckpointSaveInput): Promise<RuntimeCheckpointV2> {
  const run = this.saveChain
    .catch(() => this.getV2State())
    .then(() => this.saveUnlocked(input))

  this.saveChain = run.catch(() => this.getV2State())
  return run
}

private async saveUnlocked(input: CheckpointSaveInput): Promise<RuntimeCheckpointV2> {
  this.applyInput(input)
  // 原 save() 剩余实现移动到这里
}
```

#### 验收标准

1. 并发调用 `Promise.all([save(a), save(b)])` 不抛错。
2. 最终 checkpoint 文件为合法 JSON。
3. 两次 input 的效果按调用顺序体现在 `runtimeV2` 中。
4. 不同 session 的 CheckpointEngine 不互相等待。

---

### SPEC-08：ExperienceStore recall 防御性优化

**对应问题**：M12  
**优先级**：P2  
**文件**：`packages/core/src/harness-evolution/experience/experience-store.ts`

#### 修复要求

与 SPEC-03 同步实施以下改造：

1. 坏行跳过。
2. 限制最多解析最近 N 行，默认 5000。
3. 对 `supersededIds` 保持 O(n)。
4. `count()` 可以仍然全量读取，但不得进入 submit 热路径。
5. recall 异常不得抛出到 `submit()`。

#### 验收标准

1. experience 文件含坏行时 recall 返回正常记录。
2. 超过 5000 行时只解析尾部 5000 行。
3. superseded 记录默认不返回。
4. recall 耗时在测试中可控。

---

## 4. Phase 3：低优先级或需要产品决策

### SPEC-09：OutcomeStore 明确产品状态

**对应问题**：M2  
**优先级**：P3 / Deferred

#### 纠错说明

`OutcomeStore` 未实例化属实，但它是模型结果统计/分析能力，不是核心上下文安全问题。不要把它作为 P0 阻塞项。

#### 两种可选处理

**方案 A：标记实验模块**

在 `outcome-store.ts` 顶部加注释：

```ts
/**
 * Experimental storage for offline model outcome analytics.
 * Not wired into runtime by default.
 */
```

并确保文档不要声称当前已启用模型结果统计。

**方案 B：接入可选观测**

如果要启用，应在 loop 完成时写入最小 outcome：

```ts
{
  runId,
  modelTarget,
  taskType,
  status,
  promptTokens,
  completionTokens,
  timestamp
}
```

必须使用 feature flag：

```bash
COVALO_OUTCOME_STORE=true
```

默认不启用，避免每轮模型调用增加磁盘 I/O。

---

### SPEC-10：SessionLoader readDetailed 增补崩溃恢复测试

**对应问题**：M8  
**优先级**：P3

#### 纠错说明

原报告“JSONL 中间损坏时跳过所有后续行”的说法不准确。当前实现从末尾向前扫描，遇到坏行会继续向前找最近的有效 `messages` 记录。它能处理尾部截断降级。

#### 建议只加测试

测试用例：

1. JSONL 最后一行损坏，倒数第二行是 valid messages：应返回倒数第二行。
2. JSONL 中间一行损坏，最后一行 valid messages：应返回最后一行。
3. 所有 messages 行损坏：返回 `corrupt` 或 `empty`，messages 为空。
4. 多条 event 损坏，不影响 messages 恢复。

不要在本轮重写为 temp+rename；JSONL append 日志天然不是每条全量原子快照，重写成本高，收益不匹配。

---

### SPEC-11：truncateByRounds 不采用 fake placeholder 修法

**对应问题**：M10  
**优先级**：P3

#### 纠错说明

原报告建议插入假 assistant/tool placeholder：

```ts
tool_call_id: "truncated"
```

不建议采纳。伪造工具调用可能制造新的 provider 协议风险，也会污染上下文语义。

#### 建议

保留当前保守策略，并加测试：

1. 截断边界出现 orphan tool 时，不返回以 tool 开头的 log。
2. 截断后 `buildMessages()` 不抛 provider 协议错误。
3. `repairMessageStructure()` 能处理 orphan tool_call/tool_result。

如需优化，只允许做“更窄的 orphan 检测”，不得生成 fake tool_call。

---

### SPEC-12：GoalStore 同步 I/O 暂缓

**对应问题**：M11  
**优先级**：P3

#### 纠错说明

同步 I/O 属实，但报告未证明 `accountProgress()` 是高频热路径。当前应先保留行为稳定性。

#### 后续可选改造

- 把 `writeGoal()` 改为原子写：`tmp + rename`。
- 或增加内存 cache + debounce flush。
- 不建议首轮改为全 async，因为会牵动工具接口和调用链。

---

### SPEC-13：SurfaceStore cache 实现或删除

**对应问题**：M14  
**优先级**：P3

#### 最小实现

```ts
private cache: Map<HarnessSurface, { content: string; hash: string }> = new Map()
```

`get()`：

```ts
const cached = this.cache.get(surface)
if (cached) return cached.content

const override = await this.tryReadOverride(surface)
const content = override ?? DEFAULT_CONTENT[surface] ?? `# ${surface}\n\nNo default content available for this surface.\n`
const hash = createHash("sha256").update(content).digest("hex").slice(0, 16)
this.cache.set(surface, { content, hash })
return content
```

`getHash()`：

```ts
const cached = this.cache.get(surface)
if (cached) return cached.hash
await this.get(surface)
return this.cache.get(surface)!.hash
```

`writeOverride()` 后保留当前 `this.cache.delete(surface)`。

---

### SPEC-14：ContextPolicyStore 并发 save 暂缓

**对应问题**：M15  
**优先级**：P3

用户快速连续修改 context policy 才可能触发，风险低。本轮不建议实现文件锁。若后续实现，使用实例级 saveChain 即可。

---

### SPEC-15：result-persistence cleanup 等待机制

**对应问题**：M16  
**优先级**：P3

当前 `sessionByteUsage` 和 `sessionInitialized` 的进程级 Map 设计基本合理。真正可改进的是 `cleanupOldFiles()` fire-and-forget。

后续方案：

```ts
const cleanupTasks = new Set<Promise<void>>()

function trackCleanup(p: Promise<void>): void {
  cleanupTasks.add(p)
  p.finally(() => cleanupTasks.delete(p)).catch(() => {})
}

export async function drainResultPersistence(): Promise<void> {
  await Promise.allSettled([...cleanupTasks])
}
```

在 engine shutdown 时调用。若工具包边界不方便，暂缓。

---

### SPEC-16：ImmutablePrefix fingerprint 优化暂缓

**对应问题**：M17  
**优先级**：P3

当前 `ImmutablePrefix.build()` 每次重算 fingerprint 属实，但 engine 已有 `prefixCacheKey` 逻辑。另一个更实际的问题是 submit 早期仍有一次不带 toolSpecs 的 `prefix.build(systemPrompt)`，这属于 prefix-cache 一致性问题，建议与此前 prefix 修复合并，不在本轮单独处理。

---

## 5. 不应执行的原报告建议

### 禁止 1：不要把 compact success 改成 reduceToTarget("compress")

原因：

- `runSummarize()` 成功后已经 `summary.replace(result.summary)`。
- `reduceToTarget("compress")` 会再次调用 `createSummaryContent(removed)` 并 `summary.replace(summaryContent)`。
- 这会用机械摘要覆盖 LLM 摘要，属于回退。

正确处理：

- 保持 `runSummarize() success → reduceToTarget("trim")`。
- 只补注释说明“summary 已覆盖旧历史，trim 负责移除旧 log”。

### 禁止 2：不要把 reasoning_content 写入 createSummaryContent

原因：

- reasoning_content 不是稳定任务事实。
- 会增加 token 膨胀。
- 可能暴露模型内部推理轨迹。
- 可能让后续模型对旧推理产生过拟合或偏航。

正确处理：

- 只保留 tool call / tool result 的结构化行为事实。
- 不保留 reasoning_content。

### 禁止 3：不要在 truncateByRounds 中插入 fake tool_call

原因：

- 伪造 `tool_call_id: "truncated"` 会污染协议语义。
- 可能与 provider 的 tool-call sequence repair 产生冲突。
- 当前保守删除比伪造消息安全。

正确处理：

- 添加测试覆盖 orphan 边界。
- 如需优化，只做更窄的截断逻辑，不生成虚假工具调用。

---

## 6. 给 Coding Agent 的执行提示词

下面这段可以直接交给 coding agent 执行。

```text
你要在 Covalo v0.1.3 中修复内存与上下文管理问题。不要照原审计报告直接改，按以下 SPEC 执行。

总体要求：
1. 只修改与本 SPEC 相关的文件。
2. 保持现有公共 API 尽量兼容。
3. 每个修复都加单元测试或最小回归测试。
4. 不要把 reasoning_content 写入任何摘要。
5. 不要把 compact 模式改成 reduceToTarget("compress")。
6. 不要伪造 fake tool_call / fake tool_result。

Phase 1 必做：
A. 修复 loadSession 跨会话污染：
   - 文件：packages/core/src/engine.ts
   - 在 loadSession() 中 this.ctx.log.clear() 后清理 scratch 和 summary。
   - 可用 this.ctx.scratch.reset() + this.ctx.getSummary().clear()，或在 ContextManager 增加 clearTransientState()。
   - 测试：切 session 后 buildMessages() 不包含旧 summary/scratch 内容。

B. 修复 scratch.reset() 丢失非 ledger 消息：
   - 文件：packages/core/src/context/scratch.ts
   - 给 VolatileScratch 添加 removeByName(name) 和 replaceByName(name, messages)。
   - 文件：packages/core/src/engine.ts
   - injectTaskLedgerContext() 改为 replaceByName("task_ledger", messages)。
   - refreshLedgerContext() 不再调用 scratch.reset()，只调用 injectTaskLedgerContext()。
   - 文件：packages/core/src/supervisor/guided-loop.ts
   - injectAdviceToContext() append 时添加 name: "supervisor_guidance"。
   - 测试：刷新 task ledger 后 supervisor_guidance 不丢失，task_ledger 不重复。

C. 接入 ExperienceStore trusted-only recall：
   - 文件：packages/core/src/harness-evolution/experience/experience-store.ts
   - recall() 解析 JSONL 时跳过坏行，最多解析最近 5000 行。
   - 文件：packages/core/src/engine.ts
   - 新增 injectExperienceRecall()。
   - 在 submit() 中 this.ctx.startTurn() 之后调用 await this.injectExperienceRecall()。
   - 默认只注入 trusted、30 天内、confidence >= 0.3、最多 3 条。
   - 支持 COVALO_EXPERIENCE_RECALL=false 禁用。
   - 注入 scratch，name 使用 "experience_recall"，role 用 system。
   - 测试：trusted 注入、untrusted 默认不注入、坏行不抛错、refreshLedgerContext 后 recall 仍保留。

D. 修复 AgentScoreStore.append：
   - 文件：packages/core/src/scoring/store.ts
   - 使用 appendFileSync 替代 readFileSync + writeFileSync 全文件重写。
   - 测试：连续 append 多条，list 顺序正确，旧数据不丢。

Phase 2 建议做：
E. createSummaryContent 增加 tool call/tool result 摘要，但禁止 reasoning_content：
   - 文件：packages/core/src/context/manager.ts
   - 对 assistant.tool_calls 记录 [tool_call: name(safeArgs)]。
   - 对 tool 消息记录 [tool_result: name ok/error]。
   - 参数只允许 path/file/filePath/command/cwd/pattern/query 等安全键，且限长。
   - 测试：包含 tool_call 摘要，不包含 reasoning_content。

F. AsyncSessionWriter 增加字节上限和 messages coalescing：
   - 文件：packages/core/src/session.ts
   - 增加 queueBytes / queueSizes / MAX_QUEUE_BYTES。
   - 新 messages 入队前删除旧的未 flush messages。
   - flush 时同步扣减 queueBytes。
   - 测试：大 messages 不导致队列失控，drain 后状态归零。

G. CheckpointEngine.save 串行化：
   - 文件：packages/core/src/checkpoint/checkpoint-engine.ts
   - 将 save() 包装为实例级 promise chain。
   - 原 save 主体移动到 saveUnlocked()。
   - 测试：并发 save 最终文件合法且状态不丢。

不要做：
- 不要修改 compact 模式为 compress。
- 不要向 summary 注入 reasoning_content。
- 不要在 truncateByRounds 插入 fake tool_call。
- 不要默认注入 untrusted experience。
- 不要把 OutcomeStore 当 P0 修。
```

---

## 7. 建议测试清单

优先运行现有测试命令，以项目实际 `package.json` scripts 为准。若 scripts 存在，优先顺序：

```bash
bun test
bun run build
bun run typecheck
```

如果项目没有对应脚本，至少新增并运行相关单元测试文件。

建议新增测试覆盖：

1. `ContextManager / Engine session switch`
   - `loadSession()` 清 scratch/summary。
2. `VolatileScratch named replace`
   - `replaceByName()` 只替换指定来源。
3. `TaskLedger scratch refresh`
   - supervisor guidance 不丢。
4. `ExperienceStore recall`
   - trusted only、bad line skip、limit 生效、superseded 隐藏。
5. `Engine experience injection`
   - submit 后 scratch/buildMessages 包含 experience_recall。
6. `AgentScoreStore append`
   - append 不覆盖。
7. `createSummaryContent`
   - tool_calls 摘要存在，reasoning_content 不存在。
8. `AsyncSessionWriter`
   - queue bytes、messages coalescing、drain 清空。
9. `CheckpointEngine`
   - 并发 save 合法。

---

## 8. 最终实施顺序

建议分 3 个 PR 或 3 个 commit 执行：

### Commit 1：上下文污染与 scratch 来源修复

- SPEC-01
- SPEC-02
- 相关测试

### Commit 2：经验 recall 接入与 score append 修复

- SPEC-03
- SPEC-04
- SPEC-08 的坏行跳过部分
- 相关测试

### Commit 3：上下文压缩与持久化韧性增强

- SPEC-05
- SPEC-06
- SPEC-07
- 相关测试

低优先级项 M2/M10/M11/M14/M15/M16/M17 暂不强制进入本轮。若 agent 时间有限，只完成 Commit 1 和 Commit 2，也能覆盖当前最关键问题。

