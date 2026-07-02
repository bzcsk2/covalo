# 代理架构与状态管理审计及修复方案

> 审计方向：Agent Architecture & State Management
> 审计日期：2026-07-02
> 范围：循环状态机、上下文管理、engine 生命周期、资源 dispose 编排、LSP、governance

## 一、审计发现总览

| 优先级 | 编号 | 模块 | 问题 | 状态 |
|--------|------|------|------|------|
| P0 | L1/L3 | loop.ts | `for await` 流式消费无 try-catch，throw 击穿循环导致 TUI 卡死 | ✅ 已修复 (PR #17) |
| P0 | L2 | loop.ts | 4 个 return 退出路径不 yield done，TUI 永久等待 submit 结束 | ✅ 已修复 (PR #17) |
| P0 | M1 | context/manager.ts | validateMessageStructure 只警告不修复，双向孤儿导致 provider 400 | ✅ 已修复 (PR #17) |
| P0 | M1-fix | context/manager.ts | 修复后不重新计算预算，破坏 budget 不变量 | ✅ 已修复 (PR #17 验收返工) |
| P0 | L1-fix | loop.ts | ctx.buildMessages() 在 stream try 内，确定性错误被当流式错误重试 | ✅ 已修复 (PR #17 验收返工) |
| P0 | L2-fix | loop.ts | 新增 done 路径不写入 sessionWriter，replay/恢复不一致 | ✅ 已修复 (PR #17 验收返工) |
| P1 | A | engine.ts | submit() try 前的 ctx.buildMessages() 抛错时 finally 不执行 | 🔄 本阶段修复 |
| P1 | B | engine.ts | submit() 无总 catch，throw 直接传播给消费者 | 🔄 本阶段修复 |
| P1 | C | engine.ts | shutdown() 不 dispose BackgroundTaskManager，后台进程泄漏 | 🔄 本阶段修复 |
| P1 | 8.2 | engine.ts | loadSession() 不清理旧 session 的 BackgroundTaskManager | 🔄 本阶段修复 |
| P2 | F0-1 | engine.ts | CheckpointEngine/BranchBudgetTracker/ModeDecisionEngine 未接入运行时 | ⏳ 后续阶段 |
| P2 | G1 | governance/branch-budget.ts | 工具名集合与 TaskLedger 不交集 | ⏳ 后续阶段 |
| P2 | G2 | governance/mode-decision.ts | recovery_pending 无法触发 forced | ⏳ 后续阶段 |
| P2 | C1 | checkpoint/checkpoint-engine.ts | 未接入运行时 | ⏳ 后续阶段 |
| P2 | P4 | lsp/lsp-client.ts | starting 状态可永久卡死 | ⏳ 后续阶段 |
| P2 | P2 | lsp/manager.ts | DocumentInfo 未绑定 serverKey | ⏳ 后续阶段 |
| P2 | P3 | plugin/runtime.ts | 无统一 shutdown 编排 | ⏳ 后续阶段 |
| P2 | M2 | memory/runtime/memory-store.ts | parse-error 永久阻塞 | ⏳ 后续阶段 |
| P2 | G5 | governance/branch-budget-path.ts | mergeBudgetPathMap 用 max 而非 sum | ⏳ 后续阶段 |
| P2 | L8 | loop-helpers.ts | resetToolCallSeq 模块级全局，subagent 并发共享 | ⏳ 后续阶段 |

---

## 二、P0 阶段修复详情（已完成，PR #17）

### 2.1 L1/L3: loop.ts 流式 try-catch

**问题**：`for await (const event of client.chatCompletionsStream(...))` 无 try-catch，SSE JSON 解析错误、网络错误、reader 错误等 throw 会直接击穿 generator，导致 TUI 永久卡死。

**修复**：在 `for await` 外包 try-catch，统一处理 throw：
- AbortError / signal.aborted → yield interrupted + done
- 其他错误 → 转换为 streamError，走 consecutiveErrors 重试路径

### 2.2 L2: loop.ts done 事件补发

**问题**：4 个 return 退出路径不 yield done 事件：
1. turn 开始 isInterrupted
2. stream 中 isInterrupted
3. catch 中 abort
4. consecutiveErrors >= 3 error_limit

**修复**：所有 return 路径补发 `yield { role: "done", metadata: { reason } }`。

### 2.3 M1: context/manager.ts repairMessageStructure

**问题**：`validateMessageStructure` 只警告不修复。双向孤儿（orphaned tool_call / orphaned tool_result）会导致 provider 400 错误。

**修复**：改为 `repairMessageStructure`：
- orphaned tool_call → 插入占位 tool_result（is_error: true）
- orphaned tool_result → 删除

### 2.4 验收返工修正

针对 PR #17 验收反馈的 3 个阻塞修正：

#### 2.4.1 L1-fix: ctx.buildMessages() 从 stream retry catch 中拆出

**问题**：`ctx.buildMessages()` 在 stream try 内部求值，其抛出的确定性错误（prefix/scratch 超窗、aggressive truncation 后仍超窗）会被 stream catch 捕获并转入 consecutiveErrors 重试逻辑，但这类错误重试无意义。

**修复**：`buildMessages()` 在 stream try 之前独立求值，context error 直接 `error + done(context_error)` 退出。

#### 2.4.2 M1-fix: repairMessageStructure 后重新计算预算

**问题**：原先先算 token 再修复，修复后不重新算 token：
1. 预算内分支：修复插入占位 tool_result 后可能超窗，却静默返回
2. 超预算分支：修复删除 orphaned tool_result 后可能已回到预算内，却仍走 aggressive truncation

**修复**：以「修复后的最终消息」作为预算校验基准：先修复 → 再算 token → 再判断。`prepareLog()` 也在 `truncateToBudget` 之前先修复。

#### 2.4.3 L2-fix: done 路径统一写入 sessionWriter

**问题**：新增的 interrupt/abort/error_limit 路径只 yield 不写入 sessionWriter。

**修复**：新增 `emitDone(reason, metadata)` helper，统一 done 事件构造 + 持久化。5 处 done 路径全部走 emitDone。

#### 2.4.4 M1-clarify: 职责边界澄清

`repairMessageStructure` 只做「全局 ID 配对」层面修复，provider 协议合法性的最终兜底由 `client.ts` 的 `repairToolCallSequence()` 统一保证。

---

## 三、P1 阶段修复详情（本阶段进行中）

### 3.1 A: submit() try 前的 buildMessages() 移入 try 块

**问题**：`engine.ts` submit() 在进入主要 `try/finally` 之前（约第 976 行），会执行：
```ts
this.sessionWriter?.enqueue({ ts: Date.now(), type: "messages", payload: this.ctx.buildMessages() })
```
如果 `ctx.buildMessages()` 在此处抛错，`finally` 块不会执行，导致：
- `isSubmitting` 保持 true
- `activeAbortController` 不被清理
- 后续 submit 被永久阻塞

**修复**：把 `buildMessages()` 调用移到 try 块内部。

### 3.2 B: submit() 增加总 catch

**问题**：submit() 只有 `try { ... } finally { ... }`，没有 `catch`。任何从 runLoop、resolveEffectiveTools、packet 写入等抛出的错误会直接传播给 async generator 消费者，TUI 难以处理。

**修复**：在 try/finally 外层加 catch，把 throw 转为 `yield { role: "error" }` + `yield { role: "done", metadata: { reason: "submit_error" } }`，确保 finally 仍执行。

### 3.3 C: engine.shutdown() dispose BackgroundTaskManager

**问题**：`BackgroundTaskManager.dispose()` 存在但生产代码从不调用。engine.shutdown() 不引用 BackgroundTaskManager，导致后台 shell 子进程、hard timer、log 写流在进程退出时泄漏。

**修复**：
1. 新增 `disposeBackgroundTaskManagerFor(sessionId)` 函数（只在 manager 存在时 dispose）
2. 在 engine.shutdown() 中调用

### 3.4 8.2: loadSession() 切换时清理旧 session

**问题**：`loadSession()` 切换 session 时不清理旧 session 的 BackgroundTaskManager。旧 session 的 manager 驻留在 `managersBySession` Map 中，其内部 tasks 直到自然完成或进程退出才释放。

**修复**：在 `loadSession()` 切换 sessionId 之前，调用 `disposeBackgroundTaskManagerFor(this.sessionId)` 清理旧 session。

---

## 四、后续阶段（P2+）规划

### 4.1 F0-1: 接入 CheckpointEngine/BranchBudgetTracker/ModeDecisionEngine

这三个 governance 组件已实现但未接入运行时。需要：
- 确定接入点（engine.ts 或 loop.ts）
- 定义与 effectivePolicy 的关系
- 添加集成测试

### 4.2 G1: 统一工具名集合

BranchBudgetTracker 的工具名集合与 TaskLedger 的工具名集合不交集，可能导致预算追踪遗漏。

### 4.3 LSP 修复（P2/P4/P6）

- `lsp-client.ts` starting 状态可永久卡死（无超时）
- `manager.ts` DocumentInfo 未绑定 serverKey，`findClientForLanguage` 忽略 workspaceRoot
- LSP 双版本并存（`lsp-client.ts` 旧版与 `lsp/lsp-client.ts` 新版）

### 4.4 M2: memory-store parse-error 恢复

MemoryStore 的 `withKeyLock` 在 parse-error 时永久阻塞，不释放锁。

### 4.5 G5: mergeBudgetPathMap 求和

`mergeBudgetPathMap` 用 `Math.max` 而非求和，可能低估实际编辑次数。需确认 `bindWorkspaceRoot` 重复调用的幂等性后修复。

### 4.6 L8: resetToolCallSeq 并发安全

`toolCallSeq` 是模块级全局，多个并发的 runLoop（subagent 场景）会共享同一个计数器。当前 `randomUUID()` 已保证全局唯一性，但 per-turn reset 语义在并发场景下被破坏。

---

## 五、验证策略

每个阶段的修复需通过：
1. `bun run typecheck` — TypeScript 类型检查
2. 目标测试套件 — 覆盖修改模块的单元测试
3. 回归测试 — 新增针对修复点的测试用例
4. 无破坏性变更 — 不影响其他模块的测试

## 六、PR 工作流

- 每个阶段一个 PR
- PR 标题：`fix: <阶段描述>（PN 阶段N）`
- PR body 包含：修复内容、验证结果、不在本阶段范围的项
- 验收反馈修正作为同一 PR 的新 commit
