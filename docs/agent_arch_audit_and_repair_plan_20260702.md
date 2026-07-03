# 代理架构与状态管理审计及修复方案

> 审计方向：Agent Architecture & State Management
> 审计日期：2026-07-02
> 范围：循环状态机、上下文管理、engine 生命周期、资源 dispose 编排、LSP、governance
> 文档结构：每个修复项统一为「问题 / 修复 / 验收标准 / 不在本项范围」四段式

## 一、审计发现总览

| 优先级 | 编号 | 模块 | 问题 | 状态 |
|--------|------|------|------|------|
| P0 | L1/L3 | loop.ts | `for await` 流式消费无 try-catch，throw 击穿循环导致 TUI 卡死 | ✅ 已修复 (PR #17) |
| P0 | L2 | loop.ts | 多个 return 退出路径不 yield done，TUI 永久等待 submit 结束 | ✅ 已修复 (PR #17) |
| P0 | M1 | context/manager.ts | validateMessageStructure 只警告不修复，双向孤儿会破坏上下文一致性、token 估算，并可能在未被 client 层兜底时导致 provider 400 | ✅ 已修复 (PR #17) |
| P0 | M1-fix | context/manager.ts | 修复后不重新计算预算，破坏 budget 不变量 | ✅ 已修复 (PR #17 验收返工) |
| P0 | L1-fix | loop.ts | ctx.buildMessages() 在 stream try 内，确定性错误被当流式错误重试 | ✅ 已修复 (PR #17 验收返工) |
| P0 | L2-fix | loop.ts | 新增 done 路径不写入 sessionWriter，replay/恢复不一致 | ✅ 已修复 (PR #17 验收返工) |
| P1 | P1-A | engine.ts | submit() try 前的 ctx.buildMessages() 抛错时 finally 不执行；且移动后需保证 guard block 路径仍持久化 messages | ✅ 已修复 (PR #18) |
| P1 | P1-B | engine.ts | submit() 外层生命周期信封不完整，isSubmitting 设置后仍有大量代码在 catch/finally 之外 | ✅ 已修复 (PR #18) |
| P1 | P1-C | engine.ts | shutdown() 不 dispose BackgroundTaskManager，后台进程泄漏 | ✅ 已修复 (PR #18) |
| P1 | P1-D | engine.ts | loadSession() 不清理旧 session 的 BackgroundTaskManager | ✅ 已修复 (PR #18) |
| P2 | F0-1 | engine.ts | CheckpointEngine/BranchBudgetTracker/ModeDecisionEngine 未接入运行时 | ✅ P4 阶段修复 |
| P2 | G1 | governance/branch-budget.ts | 工具名集合与 TaskLedger 不交集 | ✅ P3 阶段修复 |
| P2 | G2 | governance/mode-decision.ts | recovery_pending 无法触发 forced | ✅ P4 阶段修复 |
| P2 | C1 | checkpoint/checkpoint-engine.ts | 未接入运行时 | ✅ P4 阶段修复 |
| P2 | LSP-1 | lsp/lsp-client.ts | starting 状态可永久卡死 | ✅ 本阶段修复 |
| P2 | LSP-2 | lsp/manager.ts | DocumentInfo 未绑定 serverKey | ✅ P3 阶段修复 |
| P2 | LSP-3 | lsp/* | LSP 双版本并存（旧版 lsp-client.ts 与新版 lsp/lsp-client.ts） | ✅ 本阶段修复 |
| P2 | P3 | plugin/runtime.ts | 无统一 shutdown 编排 | ✅ P3 阶段修复 |
| P2 | M2 | memory/runtime/memory-store.ts | parse-error 永久阻塞 | ✅ 已核查无需修复（try/finally 已存在） |
| P2 | G5 | governance/branch-budget-path.ts | mergeBudgetPathMap 用 max 而非 sum | ✅ P3 阶段修复 |
| P2 | L8 | loop-helpers.ts | resetToolCallSeq 模块级全局，subagent 并发共享 | ✅ 本阶段修复 |

> 编号说明：L=Loop、M=Memory/Message、G=Governance、C=Checkpoint、LSP=Language Server、F=Framework、P=Plugin/Lifecycle。
> LSP 相关统一使用 `LSP-N` 编号；engine 生命周期相关统一使用 `P1-A/B/C/D` 编号，避免与优先级列重复造成混乱。

---

## 二、P0 阶段修复详情（已完成，PR #17）

### 2.1 L1/L3: loop.ts 流式 try-catch

**问题**：
- 故障路径：`for await (const event of client.chatCompletionsStream(...))` 无 try-catch。
- 触发条件：SSE JSON 解析错误、网络错误、reader 错误、provider SDK 抛错。
- 后果：throw 直接击穿 async generator，TUI 永久卡死等待 submit 结束。

**修复**：
- 在 `for await` 外包 try-catch，统一处理 throw。
- AbortError / signal.aborted → yield interrupted + done。
- 其他错误 → 转换为 streamError，走 consecutiveErrors 重试路径。

**验收标准**：
- 任何 stream 层 throw 不应击穿 generator。
- AbortError 路径必须 yield done(interrupted)。
- 非 abort 错误必须进入 consecutiveErrors 重试，达到上限后 yield done(error_limit)。

**不在本项范围**：
- stream 内部正常的 finishReason 处理。
- context 层错误的分类（见 L1-fix）。

### 2.2 L2: loop.ts done 事件补发

**问题**：
- 故障路径：多个 return 退出路径不 yield done 事件。
- 触发条件：turn 开始 isInterrupted、stream 中 isInterrupted、catch 中 abort、consecutiveErrors >= 3。
- 后果：TUI 永久等待 submit 结束信号。

**修复**：
- 所有异常 / 中断 / 错误上限路径补发 `yield { role: "done", metadata: { reason } }`。

**验收标准**：
- 任何退出 runLoop 的 return 路径都必须在 return 前 yield done。
- done.metadata.reason 必须明确（interrupted / error_limit / context_error 等）。

**不在本项范围**：
- done 事件的持久化（见 L2-fix）。

### 2.3 M1: context/manager.ts repairMessageStructure

**问题**：
- 故障路径：`validateMessageStructure` 只警告不修复。
- 触发条件：双向孤儿（orphaned tool_call / orphaned tool_result），通常由截断、subagent 委派、消息重组产生。
- 后果：破坏上下文一致性、token 估算严重偏差，并在未被 client 层兜底时可能导致 provider 400。

**修复**：
- 改为 `repairMessageStructure`：
  - orphaned tool_call → 插入占位 tool_result（is_error: true）。
  - orphaned tool_result → 删除。

**验收标准**：
- 修复后消息序列中不存在全局 ID 不配对的 tool_call / tool_result。
- 修复不修改原数组（返回新数组）。
- 修复后 token 估算必须以修复后的消息为准（见 M1-fix）。

**不在本项范围**：
- provider 协议层的严格相邻顺序保证（由 client.ts 的 `repairToolCallSequence()` 兜底）。

> **注意（M1-clarify）**：ContextManager 的 `repairMessageStructure` 只保证全局 `tool_call_id` / `tool_result_id` 配对一致性；provider 协议层的严格相邻顺序（assistant tool_calls 后必须紧跟对应 tool_result，不能中间插入 user/assistant/system）仍由 `client.ts` 的 `repairToolCallSequence()` 兜底。本方法负责上下文层的展示/截断一致性，避免 ContextManager 拼装的消息因双向孤儿导致 token 估算严重偏差或日志混乱。

### 2.4 验收返工修正

针对 PR #17 验收反馈的修正。

#### 2.4.1 L1-fix: ctx.buildMessages() 从 stream retry catch 中拆出

**问题**：
- `ctx.buildMessages()` 在 stream try 内部求值，其抛出的确定性错误（prefix/scratch 超窗、aggressive truncation 后仍超窗）会被 stream catch 捕获并转入 consecutiveErrors 重试逻辑，但这类错误重试无意义。

**修复**：
- `buildMessages()` 在 stream try 之前独立求值，context error 直接 `error + done(context_error)` 退出。

**验收标准**：
- context 错误不进入 consecutiveErrors 重试。
- context 错误必须 yield done(context_error)。

**不在本项范围**：
- submit 层的 context error 处理（见 P1-B）。

#### 2.4.2 M1-fix: repairMessageStructure 后重新计算预算

**问题**：
- 原先先算 token 再修复，修复后不重新算 token：
  1. 预算内分支：修复插入占位 tool_result 后可能超窗，却静默返回。
  2. 超预算分支：修复删除 orphaned tool_result 后可能已回到预算内，却仍走 aggressive truncation。

**修复**：
- 以「修复后的最终消息」作为预算校验基准：先修复 → 再算 token → 再判断。
- `prepareLog()` 也在 `truncateToBudget` 之前先修复。

**验收标准**：
- 修复后超窗的消息不得静默返回，必须走 aggressive truncation 或 throw。
- 修复后回到预算内的消息不得走 aggressive truncation（避免丢失不必要的上下文）。
- `prepareLog` 在截断前必须先修复。

**不在本项范围**：
- aggressive truncation 算法本身的优化。

#### 2.4.3 L2-fix: done 路径统一写入 sessionWriter

**问题**：
- 新增的 interrupt/abort/error_limit 路径只 yield 不写入 sessionWriter，导致 session replay / 崩溃恢复 / 调试日志不一致。

**修复**：
- 新增 `emitDone(reason, metadata)` helper，统一 done 事件构造 + 持久化。

**验收标准**：
- 所有由异常、中断、错误上限、上下文构建失败、最大轮数等路径产生的 done 事件，必须统一通过 `emitDone` 或同等 helper：
  - yield 给实时消费者。
  - `sessionWriter` 持久化。
  - `metadata.reason` 明确。
- 后续新增的 done 路径也必须遵循同一规范（不写死具体数量，避免新路径被遗漏）。

**不在本项范围**：
- submit 层的 done 事件持久化（见 P1-B）。

#### 2.4.4 M1-clarify: 职责边界澄清

见 2.3 末尾的「注意」段落。`repairMessageStructure` 只做全局 ID 配对，provider 协议合法性由 `client.ts` 的 `repairToolCallSequence()` 统一保证。

---

## 三、P1 阶段修复详情（已完成，PR #18）

> P1 阶段的核心是 **submit lifecycle envelope**（submit 外层生命周期信封）。
> P1-B 是整个 P1 的核心项，P1-A / P1-C / P1-D 是围绕生命周期的具体修复点。

### 3.1 P1-A: submit() try 前的 buildMessages() 移入 try 块 + guard block 持久化

**问题**：
- 故障路径：`engine.ts` submit() 在进入主要 `try/finally` 之前，会执行 `this.sessionWriter?.enqueue({ ..., payload: this.ctx.buildMessages() })`。
- 触发条件：`ctx.buildMessages()` 抛错（prefix/scratch 超窗、aggressive truncation 后仍超窗、消息结构错误）。
- 后果：`finally` 块不会执行，`isSubmitting` 保持 true、`activeAbortController` 不清理，后续 submit 被永久阻塞。
- 次生风险：若把第一次 `sessionWriter.messages` 持久化移动到 runtime guard 之后，guard block 时会提前 return，导致用户输入已 append 到 context 但 messages 未写入 session，破坏 session replay / 审计。

**修复**：
- 把 `buildMessages()` 调用移到外层 try 块内部（见 P1-B 的外层信封）。
- 第一次 `sessionWriter.messages` 持久化必须位于：
  1. 外层 try/finally 内；
  2. runtime guard block 可能 return 之前；
  3. buildMessages() 抛错时进入 submit_error 或 context_error 路径。

**验收标准**：
- 第一次 sessionWriter messages 持久化必须位于外层 try/finally 内。
- 第一次 sessionWriter messages 持久化必须位于 runtime guard block 可能 return 之前。
- buildMessages() 抛错时必须进入 submit_error（或 context_error）路径，finally 能清理 isSubmitting / activeAbortController。
- guard block 路径也必须保留用户输入与当时上下文快照，便于 replay / 审计。

**不在本项范围**：
- 外层 try/catch/finally 的完整覆盖范围定义（见 P1-B）。
- guard block 本身的判定逻辑。

### 3.2 P1-B: submit() 外层生命周期信封（P1 核心项）

**问题**：
- 故障路径：submit() 一旦设置 `this.isSubmitting = true` 和 `activeAbortController`，后续任何同步 throw 或 await rejection 都必须进入统一 catch/finally。
- 触发条件：系统提示构建（prefix.build）、policy 解析（readProjectHarnessConfig / resolveHarnessStrictness / resolveEffectiveHarnessPolicy）、动态 import（@covalo/tools）、context budget（getBudget）、summary/reduce（runSummarize / reduceToTarget）、runtime guard、resolveEffectiveTools、runLoop、packet lifecycle 中任意一处抛错。
- 后果：若这些代码位于 catch/finally 之外，仍会导致 isSubmitting 不复位、activeAbortController 不清理、TUI/调用方无法得到结构化 error/done。

**修复**：
- 在 `this.isSubmitting = true` 和 `activeAbortController` 设置之后，立即进入同一个外层 try/catch/finally。
- submit 内的系统提示构建、policy 解析、context budget、summary/reduce、runtime guard、resolveEffectiveTools、runLoop、packet lifecycle 全部必须位于该外层 try/catch/finally 内。

**catch 处理**：
- `submitFailed = true`。
- yield error。
- `sessionWriter` 持久化 error。
- yield done(submit_error)。
- `sessionWriter` 持久化 done。

**finally 处理**：
- 根据 `submitFailed` / `interrupted` 输出正确生命周期状态。
- `this.isSubmitting = false`。
- `activeAbortController` 清理（仅当当前 controller 仍是本次设置的才清理）。

**验收标准**：
- 当 submit catch 捕获异常后：
  - 不允许再发出 Accepted。
  - loop_transition 不应进入 done。
  - 应进入 Failed / failed 状态。
  - done.reason 必须为 submit_error。
- finally 中的最终状态必须区分：
  - `submitFailed` → status: "Failed"，transition.to: "failed"。
  - `interrupted` → status: "Interrupted"，transition.to: "paused"。
  - normal → status: "Accepted"，transition.to: "done"。
- catch 产生的 error / done 必须写入 sessionWriter（与 L2-fix 一致）。
- `isSubmitting` 和 `activeAbortController` 在任何退出路径（正常 / 中断 / 异常 / guard block / error_limit）后都必须被清理。

**不在本项范围**：
- loop 层内部的 try/catch（已在 P0 L1/L3 修复）。
- 子引擎（subagent）的 shutdown 编排（spawnSubagent 的 finally 已处理）。
- packetStore 的显式 close（需先确认 PacketStore 是否持有文件句柄，后续评估）。

### 3.3 P1-C: engine.shutdown() dispose BackgroundTaskManager

**问题**：
- 故障路径：`BackgroundTaskManager.dispose()` 存在但生产代码从不调用。engine.shutdown() 不引用 BackgroundTaskManager。
- 触发条件：进程退出或 engine.shutdown()。
- 后果：后台 shell 子进程、hard timer、log 写流泄漏。

**修复**：
- 新增 `disposeBackgroundTaskManagerFor(sessionId)` 函数（只在 manager 存在时 dispose，不创建新实例）。
- 在 engine.shutdown() 中调用。

**验收标准**：
- dispose 不创建新 manager。
- 已存在 manager 被从 `managersBySession` 删除。
- running task 会被终止（killTaskProcesses）。
- hard timeout timer 被 clear。
- cleanup timer 被 clear。
- log stream 被 end。
- dispose 失败应记录 warn，但不阻塞 shutdown。
- 测试必须覆盖：running task 被 kill 的行为验证（不只是缓存删除）。

**不在本项范围**：
- BackgroundTaskManager 内部 dispose 实现的优化。
- 跨 session 的 manager 迁移。

### 3.4 P1-D: loadSession() 切换时清理旧 session（原 8.2）

**问题**：
- 故障路径：`loadSession()` 切换 session 时不清理旧 session 的 BackgroundTaskManager。
- 触发条件：session 切换。
- 后果：旧 session 的 manager 驻留在 `managersBySession` Map 中，其内部 tasks 直到自然完成或进程退出才释放。

**修复**：
- 在 `loadSession()` 切换 sessionId 之前，调用 `disposeBackgroundTaskManagerFor(this.sessionId)` 清理旧 session。

**验收标准**：
- 与 P1-C 相同的资源释放标准（kill running task / clear timer / close log stream）。
- loadSession 相同 sessionId 不 dispose（无切换无清理）。
- loadSession active submit 时仍禁止切换 session（`isSubmitting` 防护保留）。
- dispose 失败应记录 warn，但不阻塞 loadSession。

**不在本项范围**：
- session 切换时的其他资源清理（如 LspManager，见 LSP-2）。

---

## 四、P2 阶段修复详情（已完成）

### 4.1 L8: resetToolCallSeq 并发安全（已修复）

**问题**：`toolCallSeq` 是模块级全局，多个并发的 runLoop（subagent 场景）会共享同一个计数器。`randomUUID()` 已保证全局唯一性，但 per-turn reset 语义在并发场景下被破坏。

**修复**：将 `normalizeToolCallId` / `resetToolCallSeq` 改为 factory 模式（`createToolCallIdNormalizer()`），每个 loop 持有独立实例。保留模块级默认实例的导出以向后兼容未迁移的调用方。

**文件**：
- `packages/core/src/loop-helpers.ts` — 新增 `ToolCallIdNormalizer` 接口和 `createToolCallIdNormalizer()` factory
- `packages/core/src/loop.ts` — 创建 per-loop 实例，替代全局调用

### 4.2 LSP-3: LSP 双版本统一（已修复）

**问题**：旧版 `packages/tools/src/lsp-client.ts`（包装器）与新版 `packages/tools/src/lsp/lsp-client.ts`（`LspClient` 类）并存，`lsp.ts` 通过包装器调用 `LspClient`，增加了一层不必要的间接性。

**修复**：删除旧版包装器 `lsp-client.ts`，`lsp.ts` 直接使用 `LspClient` 类。原 `runLspRequest` 的逻辑（start → initialize → 单次请求 → shutdown）内联到 `lsp.ts` 的 `execute` 方法中。

**文件**：
- `packages/tools/src/lsp-client.ts` — 已删除
- `packages/tools/src/lsp.ts` — import 改为直接引用 `LspClient`，内联请求逻辑

### 4.3 LSP-1: starting 状态 guard timer（已修复）

**问题**：`LspClient.start()` 将 state 置为 `"starting"` 后，若调用方只调 `start()` 不调 `initialize()`，state 会永久停留 `"starting"`，后续请求会被静默拒绝。

**修复**：在 `start()` 末尾启动 30 秒的 starting guard timer（watchdog）。若 `initialize()` 在超时内未成功将 state 转为 `"running"`，timer 回调调用 `kill()` 终止子进程、清理 connection、拒绝 pending requests。`initialize()` 成功后 clear timer。timer 调用 `unref()` 避免阻止进程退出。

**文件**：
- `packages/tools/src/lsp/lsp-client.ts` — 新增 `STARTING_GUARD_TIMEOUT_MS` 常量、`startingGuardTimer` 字段、`start()` 末尾启动 timer、`initialize()` 成功后 clear timer

### 4.4 M2: memory-store parse-error 恢复（已核查无需修复）

**原审计描述**：MemoryStore 的 `withKeyLock` 在 parse-error 时永久阻塞，不释放锁。

**核查结果**：与现状不符。`withKeyLock` 已有完整的 `try { return await fn() } finally { release() }` 保护，parse-error 不会导致锁泄漏。无需修复。

### 4.5 P3 阶段修复详情（已完成）

#### LSP-2: DocumentInfo 绑定 serverKey（已修复）

**问题**：`manager.ts` 的 `DocumentInfo` 接口缺少 `serverKey` 字段，`findClientForLanguage` 仅按 language 查找、忽略 workspaceRoot。在多 workspace 同语言场景下会返回错误的 server，导致文档同步到错误的 LSP 实例；`clearDocumentsForServer` 也无法正确清理文档。

**修复**：
- `DocumentInfo` 新增 `serverKey: string` 字段，`ensureDocumentSync` 创建时写入 `managed.key`。
- `markDirty` 改用 `this.servers.get(existing.serverKey)` 精确查找归属 server。
- `clearDocumentsForServer` 改用 `doc.serverKey === serverKey` 直接比对清理。
- `findClientForLanguage` 保留作 fallback 工具方法。

**文件**：`packages/tools/src/lsp/manager.ts`

#### G5: mergeBudgetPathMap 改为累加（已修复）

**问题**：`mergeBudgetPathMap` 用 `Math.max` 合并同文件不同路径表示的编辑计数，低估实际编辑次数。同一文件以相对/绝对路径各记录一次独立编辑时，应累加而非取较大值。

**修复**：`Math.max(merged.get(key) ?? 0, count)` → `(merged.get(key) ?? 0) + count`。幂等性由 `bindWorkspaceRoot` 的同 root 早退 + `applySnapshot` 的整体替换 map 保证。

**文件**：`packages/core/src/governance/branch-budget-path.ts`、`packages/core/__tests__/branch-budget-path.test.ts`

#### G1: 统一工具名集合（已修复）

**问题**：`BranchBudgetTracker` 的工具名集合（`run_command`、`edit_file`、`append_file` 等）与运行时真实工具名（`bash`、`write_file`、`edit`、`NotebookEdit`）不交集。虽当前未接入运行时（潜伏态），但接入后会静默失效。

**修复**：
- `branch-budget-tool-path.ts` 的 `FILE_WRITE_TOOLS` 对齐为 `["write_file", "edit", "NotebookEdit"]`。
- `branch-budget.ts` 的 `checkToolBlock` 中 `toolName === "run_command"` → `toolName === "bash"`。
- 同步更新 `branch-budget-block.test.ts` 测试用例。

**文件**：`packages/core/src/governance/branch-budget-tool-path.ts`、`packages/core/src/governance/branch-budget.ts`、`packages/core/__tests__/branch-budget-block.test.ts`

#### P3: plugin runtime 统一 shutdown 编排（已修复）

**问题**：`PluginRuntime.dispose()` 是同步的，只移除 hooks、清状态，不触发 ECC `onShutdown` hooks（content pack 中声明的 `SessionEnd`/`onShutdown` 钩子永不执行），也不调用 plugin 自身的 shutdown 回调。

**修复**：`dispose()` 改为 `async dispose()`，按以下顺序编排：
1. 派发 `{ role: "shutdown" }` loop event，触发 ECC onShutdown hooks；
2. `drain()` 等待 in-flight hooks 完成；
3. 逐一调用 plugin 的可选 `shutdown` 回调（向后兼容，未实现则跳过）；
4. 移除 ECC hook adapters、清状态、dispose hookRegistry；
5. 重置内部数组。

`tui.ts` 调用点改为 `await pluginRuntime.dispose()`。

**文件**：`packages/plugin/src/runtime.ts`、`packages/cli/src/tui.ts`、`packages/plugin/__tests__/runtime.test.ts`、`packages/plugin/__tests__/content-pack-runtime-integration.test.ts`

### 4.6 P4 阶段修复详情（已完成，PR #21）

#### F0-1: 接入 CheckpointEngine/BranchBudgetTracker/ModeDecisionEngine（已修复）

**问题**：三件套（BranchBudgetTracker / ModeDecisionEngine / CheckpointEngine）已实现但未接入 `engine.ts` / `loop.ts` 主路径，governance/checkpoint 在运行时完全失效。

**修复**：
- `engine.ts` submit 开始时 `loadV2` 恢复 BranchBudget 快照 + applySnapshot，跨 submit 持久化
- `loop.ts` 解构 `effectivePolicy`，映射 `executionMode` 到 `HarnessMode`，用 `resolveInitialExecutionMode` 初始化
- `evaluateExecutionMode()` 每轮收集 recovery_pending / checkpoint_resumed 信号并调用 `modeDecisionEngine.evaluate()`
- BranchBudget 记录从 taskLedger 条件块中拆出，普通任务也计数
- 工具批次前 BranchBudget 硬拦截（仅 enforce 模式），recover 模式只记录不阻断
- batch 中任意 tool_call 被 block 时，所有 tool_call 都 append tool_result（避免 orphan）

**审计反馈返工（两轮）**：
- B1-B6: effectivePolicy 真正消费 / enforce 与 recover 分离 / BranchBudget 脱离 TaskLedger / checkpoint 恢复后不 reset / batch block 配对 / pending signal 消费
- B6-2: free/forced 路径 signal lifecycle 闭合（engine.ts 仅 adaptive 提交 signal + loop.ts 非 auto 分支显式清理）

**文件**：`packages/core/src/loop.ts`、`packages/core/src/engine.ts`、`packages/core/src/finish-reason.ts`（新增）、`packages/core/__tests__/f0-1-governance-integration.test.ts`、`packages/core/__tests__/f0-1-runtime-loop.test.ts`

#### G2: recovery_pending 触发 forced（已修复）

**问题**：`recovery_pending` 信号未加入 `MODE_SIGNAL_PRECEDENCE`，无法触发 `enter_forced`，BranchBudget 超限后无法进入 forced 模式。

**修复**：`recovery_pending` 加入 `ENTER_SIGNAL_SET` 和 `MODE_SIGNAL_PRECEDENCE`，优先级低于 `verification_failure`。

**文件**：`packages/core/src/governance/mode-decision.ts`、`packages/core/__tests__/mode-decision.test.ts`

#### C1: checkpoint-engine 接入运行时（已修复）

**问题**：`CheckpointEngine` 已实现但 `engine.ts` / `loop.ts` 未引用，checkpoint 永远不落盘。

**修复**：与 F0-1 一同接入。`engine.ts` 构造时实例化 CheckpointEngine，submit 开始时 loadV2 恢复；`loop.ts` 在 safe point 调用 `checkpointEngine.save()`，forced policy 下额外保存 `step_completed` / `verification_started`。

**文件**：`packages/core/src/engine.ts`、`packages/core/src/loop.ts`

---

## 五、验证策略

每个阶段的修复需通过：
1. `bun run typecheck` — TypeScript 类型检查。
2. 目标测试套件 — 覆盖修改模块的单元测试。
3. 回归测试 — 新增针对修复点的测试用例，必须覆盖验收标准中列出的 observable 行为。
4. 无破坏性变更 — 不影响其他模块的测试。

## 六、PR 工作流

- 每个阶段一个 PR。
- PR 标题：`fix: <阶段描述>（PN 阶段N）`。
- PR body 包含：修复内容、验证结果、不在本阶段范围的项。
- 验收反馈修正作为同一 PR 的新 commit。
- PR 必须对照本文档的「验收标准」逐项说明实现情况。
