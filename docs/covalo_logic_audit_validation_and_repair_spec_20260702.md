# Covalo 逻辑审查验真与修复 Spec

**目标仓库**: `bzcsk2/covalo`  
**生成日期**: 2026-07-02  
**输入依据**: `covalo_logic_audit_20260702.md` 与 GitHub 当前 `main` 分支源码抽样/逐项核验  
**用途**: 交给 coding agent 执行修复。本文不是原审查的复述，而是对原 75 条问题的真实性复核、优先级重排和可执行补丁规格。

---

## 0. 总体结论

原审查报告有价值，但严重级别明显偏高。可以直接修的真实问题集中在以下几类：

1. **评估/评分语义错误**：Supervisor 分数 0-100 与 0-1 阈值混用；protected file 前缀误匹配；LLM 布尔字段解析过严。
2. **安全边界缺陷**：IPv6 `::` 展开错误；Windows hook 进程树终止不正确；shell 敏感路径 tokenization 漏掉 `--file=/etc/shadow` 这类形式。
3. **运行时一致性问题**：tool-call stream 出错或 tool-use done 后的上下文追加策略不严谨；多个同名工具调用时 ledger 通过 name 匹配会串账。
4. **平台/模块兼容问题**：ESM 文件中使用 `require()`；TUI dialog store 的 snapshot 永远是初始状态；LSP client state/pending/doc sync 有设计缺口。
5. **编辑工具边界问题**：`old_string === ""` 进入 fuzzy replace 会触发空字符串查找风险，原报告低估了这个问题。

不建议 agent 盲目修复原报告中的所有条目。若照单全收，会浪费大量时间在不成立、已修复、或仅为设计取舍的问题上。

---

## 1. 验真矩阵

标记说明：

- `CONFIRMED`: 当前代码中可复现或从源码直接成立。
- `PARTIAL`: 有真实风险，但原描述、严重度或因果链夸大。
- `FALSE/STale`: 当前代码不支持该结论，或文件/逻辑已不存在。
- `DESIGN/LOW`: 更像策略选择或低价值清理，不应进入首轮修复。
- `UNVERIFIED`: 当前核验中未定位到对应文件或证据不足，暂不作为修复入口。

### 1.1 严重问题 S1-S9

| ID | 结论 | 修复处理 | 核验说明 |
|---|---:|---|---|
| S1 | PARTIAL | P1 修 | `finishedWithToolUse` 后确实没有跳出 `for await`；但“文本被丢弃”的表述不完全准确，后续 delta 可能仍被 UI 看到但不会进入最终上下文。应修成明确进入下一 turn。 |
| S2 | PARTIAL | P2 修 | `truncateToBudget` 的 round 边界逻辑偏脆弱，特别是无 user 的异常日志形态；但正常 `user -> assistant -> tool...` round 不必然留下孤立 tool。建议重写为统一 round parser。 |
| S3 | FALSE/STale | 不修 | `withKeyLock` 的 `next` 只 resolve，不会 reject；`fn()` reject 不会污染 lock chain。原报告把业务 Promise 与 release Promise 混淆了。 |
| S4 | CONFIRMED | P0 修 | `extractAssessment` 要求 supervisor 输出 0-100，但 review verdict 用 `>= 0.5` 判断，导致低分也被 ACCEPTED。 |
| S5 | CONFIRMED | P0 修 | `matchProtectedFile` 同时使用 `startsWith(pattern + "/") || startsWith(pattern)`，会让 `src/test` 匹配 `src/test-utils`。 |
| S6 | CONFIRMED | P0 修 | `safetyIssue` 未使用 `coerceBoolean`，字符串 `"true"` / `"yes"` 会漏判。 |
| S7 | CONFIRMED | P1 修 | `finalizeBounded` 在已有 dropped 时只报告历史 dropped，不把 final slice 再截掉的字符计入 dropped。 |
| S8 | CONFIRMED | P1 修 | background task 输出过滤所有后续空行，破坏输出格式和 cursor line count 语义。 |
| S9 | CONFIRMED | P0 修 | `ipv6ToBytes("::")` 会展开出 9 组，影响 `::/128` 等 CIDR 判断，属于 SSRF 防护边界错误。 |

### 1.2 高优先级 H1-H13

| ID | 结论 | 修复处理 | 核验说明 |
|---|---:|---|---|
| H1 | PARTIAL | P2 修 | 子代理失败判断依赖 `event.severity === "error"`，当前主 loop 的 stream error 会带 severity，但其他 error 事件未必一致。建议同时检查 `event.role === "error"` 和严重元数据。 |
| H2 | CONFIRMED | P1 修 | stream error 后只 append `fullContent`，如果此前已收到 `tool_call_end`，上下文没有 assistant `tool_calls` 与 tool results 的一致补偿。 |
| H3 | FALSE/STale | 不修 | 当前代码已有 `result && typeof result === "object" && "then" in result` 守卫，原问题已不存在。 |
| H4 | CONFIRMED | P1 修 | ledger 记录工具结果时通过 `toolName` 找第一个 tool call；多个同名 tool call 会串 args。 |
| H5 | UNVERIFIED | 不进入首轮 | 未在当前仓库定位到 `keyed-mutex.ts`。若后续发现该文件，再按锁链传播问题单独处理。 |
| H6 | PARTIAL | P1 修 | LSP `pending` Map 未被填充，health/kill 中 pending rejection 逻辑无效；“请求永远 pending”被 timeout 部分缓解，但设计确实不一致。 |
| H7 | PARTIAL | P1 修 | `state="running"` 在 initialize 前设置；由于 manager 先 initialize 后暴露，风险受限，但 state 语义错误。 |
| H8 | CONFIRMED | P1 修 | unhealthy client kill/delete 后未清 documents，新 client 不会重新 didOpen 已记录文档。 |
| H9 | CONFIRMED | P0 修 | ESM 项目中 `grep.ts` 直接 `require("node:fs")` / `require("node:path")`，Node ESM 下会崩。 |
| H10 | CONFIRMED | P1 修 | `getSnapshot()` 永远返回 `createInitialDialogState()`，消费者无法看到当前 dialog。 |
| H11 | CONFIRMED | P1 修 | `isBlocking()` 通过 `setState(prev => prev)` 读状态，React 并发模式下不可靠。 |
| H12 | CONFIRMED | P1 修 | plugin hook 使用 `process.kill(-pid)`，Windows 不支持负 PID；需要走 `taskkill /PID <pid> /T /F` 或统一 `terminateProcessTree`。 |
| H13 | PARTIAL | P2 修 | `update()` 内 `get()` 返回 null 时用 `{}` 覆盖旧值，在文件被外部删除/损坏时可能丢数据；但这也可能是当前“missing means create”的设计。建议改为可区分 not-found 与 parse-error。 |

### 1.3 中等问题 M1-M30

| ID | 结论 | 修复处理 | 核验说明 |
|---|---:|---|---|
| M1 | CONFIRMED | 并入 H2 | 与 H2 同类：stream error 后上下文状态不一致。 |
| M2 | CONFIRMED | 并入 H4 | 与 H4 重复。 |
| M3 | DESIGN/LOW | 不修 | `interrupt()` 冗余调用子引擎 permission 响应，当前看是幂等低风险。 |
| M4 | DESIGN/LOW | 不修 | verifier fail 同时设 verifierScore=0 和 cap finalScore<=40 是评分策略，不是明确逻辑 bug。 |
| M5 | CONFIRMED | P2 修 | failure classification 中 worker empty output 优先于 policy gate，统计语义会偏。 |
| M6 | CONFIRMED | P2 修 | `completedKnown = "completed" in parsed` 对 `completed:null` 也视为已知，语义不精确。 |
| M7 | CONFIRMED | P2 修 | checkpoint save 多次 read existing checkpoint，存在 TOCTOU 与复杂性问题。 |
| M8 | CONFIRMED | P2 修 | `shouldExitForcedMode` 不检查 `lastToolSuccess`，刚失败后仍可能满足退出条件。 |
| M9 | CONFIRMED | P2 修 | `getObjectiveSignals` git 命令失败时默认 `cleanGitDiff:true`，会误判干净。 |
| M10 | DESIGN/LOW | 不修 | benchmark 模式零 tool use 扣分是评分策略，不能算逻辑错误。 |
| M11 | CONFIRMED | P1 修 | `PermissionDecision` 包含 `"ask"`，但 hook `beforeToolCall` 只短路 allow/deny，无法将 allow 升级为 ask。 |
| M12 | PARTIAL | P2 修 | MCP initialize 失败清理调用 `terminateProcessTree` 未额外 catch，通常工具函数内部可能安全，但建议防御。 |
| M13 | DESIGN/LOW | 不修 | stdin.write callback 重复/迟到调用最多触发已 settled Promise 的无效 reject，低价值。 |
| M14 | CONFIRMED | P2 修 | Windows rename 失败后 fallback `writeFileSync(path)` 非原子。 |
| M15 | CONFIRMED | P1 修 | permission `matchArgs` 只做浅层严格相等，嵌套对象规则失效。 |
| M16 | PARTIAL | P2 修 | snapshot revert 总是恢复最新快照，不能多步回退；是否为 bug 取决于产品语义。 |
| M17 | DESIGN/LOW | 不修 | search index 同义词/前缀评分噪音属于检索质量优化，不是逻辑错误。 |
| M18 | PARTIAL | 不进入首轮 | 当前代码已先置 `escalated=true` 再 remove listeners，主要竞态已缓解；仍可补测试。 |
| M19 | CONFIRMED | P1 修 | shell sensitive tokenizer 未按 `=` 分隔，且以 `-` 开头 token 会跳过，`--file=/etc/shadow` 可漏检。 |
| M20 | CONFIRMED | P2 修 | `blockAnchorPass` 统计空行 trim 后相等，可能靠空行灌水达阈值。 |
| M21 | FALSE/STale | 不修 | 当前 `contextAwarePass` 已要求双方非空才计匹配，原描述不成立。 |
| M22 | UNVERIFIED | 不进入首轮 | 当前仓库未定位到 `scheduler-backend.ts`。 |
| M23 | CONFIRMED | DESIGN/LOW | abort 路径 cleanup 会被调用两次，但当前 cleanup 幂等，低风险。 |
| M24 | PARTIAL | P2 修 | trimmed match 后按 trimmed 长度替换，可能保留旧文本周边空白；属于编辑语义边界。 |
| M25 | CONFIRMED | P0 修 | 原报告低估：`old_string === ""` 会进入 `fuzzyReplaceOnce`，空 needle 的 `findAllOccurrences` 有无限循环风险。必须加硬拒绝。 |
| M26 | DESIGN/LOW | 不修 | `$CLAUDE_PLUGIN_ROOT` 是兼容命名；可另行改文案，但不是逻辑修复。 |
| M27 | FALSE/STale | 不修 | `TOOL_JSON_KEY_HINT` 当前没有 `g` flag，无 `lastIndex` 副作用。 |
| M28 | CONFIRMED | P2 修 | worker report `verification.passed` 只接受严格 true，应复用 `coerceBoolean`。 |
| M29 | PARTIAL | P2 修 | runtime logger overflow 逻辑复杂，存在审计困难；未直接证明丢数据，但建议用单队列模型简化。 |
| M30 | CONFIRMED | P2 修 | branch-budget 对不存在的新文件豁免，确实可通过创建新 path 绕过 per-file edit budget。 |

### 1.4 低优先级 L1-L23

| ID | 结论 | 修复处理 | 核验说明 |
|---|---:|---|---|
| L1 | DESIGN/LOW | 不修 | verifier direct command exitCode 检查可补，但不影响首轮。 |
| L2 | DESIGN/LOW | 不修 | split 正则冗余，低价值。 |
| L3 | UNVERIFIED | 不进入首轮 | 未在本轮深入验证。 |
| L4 | DESIGN/LOW | 不修 | reasoning 收集未使用是清理项。 |
| L5 | UNVERIFIED | 不进入首轮 | 未在本轮深入验证。 |
| L6 | DESIGN/LOW | 可顺手 | truncate 文案不一致，可与 S7 同修。 |
| L7 | DESIGN/LOW | 可顺手 | unused variable，交给 lint/tsc。 |
| L8 | DESIGN/LOW | 可顺手 | unused param。 |
| L9 | DESIGN/LOW | 不修 | web-search 解析器脆弱但需另立需求。 |
| L10 | DESIGN/LOW | 不修 | `git push` 标 destructive 是保守策略。 |
| L11 | FALSE/STale | 不修 | 原审查自身已承认无 bug。 |
| L12 | UNVERIFIED | 不进入首轮 | 需要单独看 memory index migration。 |
| L13 | PARTIAL | P3 | streaming state 残留仅 UI 边界。 |
| L14 | PARTIAL | P3 | transcript order 边界，低优先。 |
| L15 | DESIGN/LOW | 不修 | shallowEqual 不递归是常规设计。 |
| L16 | PARTIAL | P3 | batcher 异常路径一致性可补测试。 |
| L17 | DESIGN/LOW | 不修 | 双 JSON.parse 是效率问题。 |
| L18 | DESIGN/LOW | 不修 | 与 M13 重复。 |
| L19 | FALSE/STale | 不修 | 原审查自身已承认正确。 |
| L20 | FALSE/STale | 不修 | 原审查自身认为设计意图。 |
| L21 | FALSE/STale | 不修 | 原审查自身认为正确。 |
| L22 | FALSE/STale | 不修 | 原审查自身认为正确。 |
| L23 | DESIGN/LOW | 不修 | 只取第一个 JSON 是策略选择，除非需求要求多候选评分。 |

---

## 2. 修复总原则

Agent 执行时必须遵守以下约束：

1. **不要一次性重构全仓库**。只修改本 spec 指定文件及其测试。
2. **每个补丁必须有回归测试**。无法构造单元测试的，至少要给出脚本级复现用例。
3. **优先修真实 P0/P1**。不要把 false/stale 条目当任务。
4. **避免改 API 表面**。若必须扩展事件字段，例如 `toolCallId`，必须保持向后兼容。
5. **保持 ESM 兼容**。项目 package.json 是 `"type": "module"`，禁止新增裸 `require()`。
6. **安全相关变更 fail closed**。SSRF、permission、shell sensitive path 检测宁可保守拒绝，也不要静默放行。

---

## 3. P0 修复 Spec

### P0-1: 统一 Supervisor Assessment 分数范围

**涉及条目**: S4  
**文件**: `packages/core/src/eval/runner.ts`

#### 问题

Supervisor prompt 要求返回 0-100 分；`extractAssessment()` 直接返回这些数值；但 review packet verdict / severity / confidence 使用 0-1 阈值：

- `reviewVerdict`: `score >= 0.5`
- finding severity: `score < 0.5`
- confidence: `Math.min(1, averageScore)`

这会导致 1/100 也被判定为 ACCEPTED。

#### 修复要求

采用一种统一策略，推荐 **内部归一化到 0-1**：

1. 修改 `extractAssessment()`：
   - 接收 0-100 或 0-1。
   - 若值 > 1，除以 100。
   - clamp 到 `[0, 1]`。
   - 丢弃非 number / NaN。
2. 修改 `computeScore()`：
   - 如果 `supervisorAssessment` 已归一化，则 supervisorScore 应乘以 100 再进入 0-100 总分体系。
   - 或者另设 `normalizeSupervisorAssessmentForReview()` 和 `normalizeSupervisorAssessmentForScore()`，但不要混用。
3. 修改 review packet findings：
   - severity 阈值可以继续用 `< 0.5`。
   - summary 显示应明确为 normalized score，例如 `taskCompletion: 0.42`，或显示原始与归一化。
4. 添加测试：
   - supervisor 输出 `{dimensions:{taskCompletion:1, verification:1, toolUse:1, efficiency:1, safety:1}}` 应 `NEEDS_FIX`，不是 ACCEPTED。
   - supervisor 输出 80/90 分应 ACCEPTED。
   - supervisor 输出 0.8/0.9 分也应 ACCEPTED。
   - confidence 不得大于 1。

#### 验收标准

- `review-packet.json.verdict` 不再因 1/100 被 ACCEPTED。
- `score.json.supervisorScore` 仍保持 0-100 语义。
- `bun test packages/core/src/eval` 通过。

---

### P0-2: 修复 protected file 前缀误匹配

**涉及条目**: S5  
**文件**: `packages/core/src/eval/runner.ts`

#### 问题

`matchProtectedFile(filePath, pattern)` 中：

```ts
filePath.startsWith(pattern + "/") || filePath.startsWith(pattern)
```

第二个条件会让 `src/test` 匹配 `src/test-utils`。

#### 修复要求

实现严格路径段匹配：

```ts
function matchProtectedFile(filePath: string, pattern: string): boolean {
  const p = normalizePath(pattern).replace(/\/+$/, "")
  const f = normalizePath(filePath)
  if (!p) return false
  return f === p || f.startsWith(p + "/")
}
```

如需要支持 glob，另行显式命名，不要用裸 prefix 模拟 glob。

#### 测试用例

- `matchProtectedFile("src/test/foo.ts", "src/test") === true`
- `matchProtectedFile("src/test", "src/test") === true`
- `matchProtectedFile("src/test-utils/foo.ts", "src/test") === false`
- `matchProtectedFile("src/testing/foo.ts", "src/test") === false`
- Windows separator 输入也应 normalize 后判断。

---

### P0-3: `safetyIssue` 与 worker verification 布尔解析

**涉及条目**: S6, M28  
**文件**: `packages/core/src/scoring/eval-runner.ts`

#### 修复要求

1. `tryParseSupervisorAssessment()` 中：
   ```ts
   safetyIssue: coerceBoolean(parsed.safetyIssue) ?? false
   ```
2. `parseWorkerReport()` 中：
   ```ts
   const verificationObj = parsed.verification as Record<string, unknown> | undefined
   verificationPassed: verificationObj ? coerceBoolean(verificationObj.passed) ?? false : false
   ```
3. 扩展 `coerceBoolean()`：
   - true: `true`, `"true"`, `"yes"`, `"pass"`, `"passed"`, `"ok"`
   - false: `false`, `"false"`, `"no"`, `"fail"`, `"failed"`
   - 其他返回 undefined。

#### 测试用例

- supervisor `{"safetyIssue":"true"}` 应识别为 true。
- worker `{"verification":{"passed":"yes"}}` 应识别为 true。
- worker `{"verification":{"passed":"failed"}}` 应识别为 false。

---

### P0-4: 修复 IPv6 `::` 展开与 SSRF CIDR 检测

**涉及条目**: S9  
**文件**: `packages/tools/src/web-fetch.ts`

#### 问题

当前 `ipv6ToBytes()` 对 `::` 的 zeros 计算错误，会产生 9 组 hextet。

#### 修复要求

1. 用明确 hextet parser 替换当前实现：
   - 支持 `::`
   - 支持前缀、后缀压缩，如 `::1`, `fc00::`, `2001:db8::1`
   - 支持 IPv4-mapped IPv6，如 `::ffff:127.0.0.1`
   - 输出必须恒为 16 bytes，否则返回 invalid。
2. `parseCIDR()` 和 `ipInCIDR()` 对 invalid IPv6 应 fail-closed。
3. `hasPrivateIP()` 应确认：
   - `::` blocked
   - `::1` blocked
   - `fc00::1` blocked
   - `fe80::1` blocked
   - `::ffff:127.0.0.1` blocked
   - `2001:4860:4860::8888` not blocked

#### 测试文件建议

`packages/tools/src/__tests__/web-fetch-ssrf.test.ts`

---

### P0-5: 移除 ESM 中的 `require()`

**涉及条目**: H9  
**文件**: `packages/tools/src/grep.ts`

#### 修复要求

1. 文件顶部改为 ESM import：
   ```ts
   import * as fs from "node:fs"
   import * as path from "node:path"
   ```
2. 删除 `tryFindstr()` / `tryNodeGrep()` 内部所有 `require()`。
3. 保持 Windows `findstr` 行为不变。

#### 验收标准

- `bun run typecheck` 通过。
- Node ESM 环境下 import `packages/tools/src/grep.ts` 不抛 `ReferenceError: require is not defined`。
- Windows 分支可用单元测试 mock 或至少不再引用 require。

---

### P0-6: `edit` 工具拒绝空 `old_string`

**涉及条目**: M25  
**文件**: `packages/tools/src/edit.ts`, `packages/tools/src/fuzzy-edit.ts`

#### 问题

`old_string === ""` 时，`edit.ts` 会跳过 exact 分支并调用 `fuzzyReplaceOnce(normalizedContent, "", normalizedNew)`。`findAllOccurrences()` 对空 needle 会无限循环。

#### 修复要求

1. 在 `edit.ts` 参数校验阶段直接拒绝空 old_string：
   ```ts
   if (args.old_string.length === 0) {
     return { content: safeStringify({ error: "old_string must be non-empty" }), isError: true }
   }
   ```
2. 在 `fuzzyReplaceOnce()` 增加防御：
   ```ts
   if (needle.length === 0) return null
   ```
3. 在 `findAllOccurrences()` 也加防御：
   ```ts
   if (needle.length === 0) return []
   ```

#### 测试用例

- 调用 edit old_string 空字符串，应快速返回错误。
- 单测直接调用 `fuzzyReplaceOnce("abc", "", "x")` 返回 null，不挂起。

---

## 4. P1 修复 Spec

### P1-1: 修复 tool-use stream 生命周期与 stream error 上下文一致性

**涉及条目**: S1, H2, M1  
**文件**: `packages/core/src/loop.ts`

#### 问题 A: tool-use done 后未明确跳出 provider stream

`done(tool_use)` 处理完工具后，只 `break` 当前 switch，不跳出 `for await`。后续 provider event 可能污染 UI/context 状态。

#### 问题 B: stream error 后上下文不一致

若在 stream 中已收到 `tool_call_end`，随后收到 `error`，当前代码只 append `{role:"assistant", content: fullContent}`，丢失已收集 `toolCalls`。这会让已发射事件、session、ctx.log 不一致。

#### 修复要求

1. 引入外层 loop 控制，不要靠裸 `break`：
   ```ts
   let continueOuterTurn = false
   let terminateLoop = false
   ```
   或使用 label：
   ```ts
   streamLoop:
   for await (...) { ... break streamLoop }
   ```
2. `done(tool_use)` 工具执行完成后：
   - append assistant tool_calls
   - execute tools
   - append pending instruction / supervisor guidance
   - **明确结束当前 stream consumption**
   - 回到 outer while 进入下一 turn
3. 如果 provider 在 tool-use done 后继续发 text_delta：
   - 不应进入 ctx.log。
   - 可写 diagnostic warning。
4. stream error 时：
   - 如果 `toolCalls.length === 0`，可以维持当前 append partial assistant content 的重试策略。
   - 如果 `toolCalls.length > 0`，必须二选一：
     - **方案 A：不 append partial assistant，直接重试，并记录 diagnostic**；或
     - **方案 B：append assistant with tool_calls，并为每个 tool call append error tool result**，保证 OpenAI-compatible 消息协议完整。
   - 不允许出现 assistant tool_call 无 tool result，或 tool result 无 assistant tool_call。

#### 测试场景

构造 fake streaming client：

1. `tool_call_end -> done(tool_use) -> text_delta("late") -> done(stop)`
   - late delta 不应进入 ctx.log。
   - 工具只执行一次。
2. `tool_call_end -> error`
   - 下一轮 `ctx.buildMessages()` 不得包含不完整 tool-call protocol。
3. `done(tool_use)` 重复两次：
   - 工具只执行一次。
   - 不产生重复 tool results。

---

### P1-2: 工具结果 ledger 通过 `toolCallId` 关联，而不是 tool name

**涉及条目**: H4, M2  
**文件**:

- `packages/core/src/loop.ts`
- `packages/core/src/interface.ts`
- `packages/core/src/streaming-executor.ts`
- 相关 tool event 类型与 tests

#### 问题

当前 ledger 记录工具结果时：

```ts
const tc = toolCalls.find(t => t.function.name === toolEvent.toolName)
```

多个同名工具并发/批量调用时，第二个及以后会拿到第一个 args。

#### 修复要求

1. 扩展 `LoopEvent` 的 tool/result/error 事件：
   ```ts
   toolCallId?: string
   toolCallIndex?: number
   ```
2. `StreamingToolExecutor.run()` 发出的 tool result/error 必须携带原始 `tc.id`。
3. loop 中 ledger 匹配改为：
   ```ts
   const tc = toolCalls.find(t => t.id === toolEvent.toolCallId)
   ```
   fallback 才允许使用 name，但要写 warning。
4. sessionWriter event payload 保持向后兼容：新增字段，不删除旧字段。

#### 测试用例

- 同一轮两个 `read_file`，path 分别为 `a.ts`、`b.ts`。
- ledger 应记录两个不同 args。
- 不得全部记录为第一个 path。

---

### P1-3: 修复 bounded output 与后台输出格式

**涉及条目**: S7, S8, L6  
**文件**:

- `packages/tools/src/shell-output-buffer.ts`
- `packages/tools/src/shell-dual-track/background-task-manager.ts`

#### 修复要求

1. `finalizeBounded()`：
   - 如果 `buf.dropped > 0` 且 `buf.text.length > buf.max`，额外 dropped 应累加。
   - 文案统一为一种格式，例如：
     ```text
     ... [dropped N earlier chars]
     ```
2. background appendOutput：
   - 不要删除所有空行。
   - 推荐按 chunk 保真追加：
     - `text.split(/\r?\n/)`
     - 保留中间空行。
     - 最后的 trailing 空 fragment 是否计入行，要与 cursor 语义一致。
   - `totalOutputLines` 必须等于可 cursor 追踪的逻辑行数量。
3. logStream 写入保持原始 text，不受 ring buffer 处理影响。

#### 测试用例

- `line1\n\nline3` 输出中间空行。
- 连续 chunk：`"line1\n"` + `"\nline3\n"` 输出仍保留空行。
- dropped 计数等于实际被移除字符数。

---

### P1-4: LSP client state / pending / document sync 修复

**涉及条目**: H6, H7, H8  
**文件**:

- `packages/tools/src/lsp/lsp-client.ts`
- `packages/tools/src/lsp/manager.ts`

#### 修复要求

1. `state="running"` 移到 `initialize()` 成功之后。
   - 可新增 `initialized` state，或在 `start()` 后保持 `starting`。
2. 若保留 `pending` Map：
   - `sendRequest()` 必须注册 pending 并在 resolve/reject/timeout 删除。
   - `kill()` / `handleExit()` 能 reject 所有 pending。
   - `getHealth().pendingRequests` 返回真实值。
3. 若决定不用 pending Map：
   - 删除 pending Map 与相关 health 字段，避免虚假状态。
   - 不推荐，因为 kill 时主动 reject 更好。
4. manager 删除 unhealthy client 时：
   - 清除该 workspace+language 关联 documents。
   - 或在 document info 中记录 server key，server 重建时强制 didOpen。
5. idle cleanup / shutdownWorkspace 删除 server 时也应清理相关 documents。

#### 测试用例

- mock LSP server 初始化失败后，client state 不是 running。
- server exit 后 pending request 被 reject。
- 重启 server 后同一文件会重新 didOpen。

---

### P1-5: TUI dialog store 改为真实 snapshot/ref 模型

**涉及条目**: H10, H11  
**文件**: `packages/tui/src/store/dialog-store.ts`

#### 问题

`createDialogController()` 返回的 state 是初始快照；`isBlocking()` 用 setState 读取状态，不可靠。

#### 修复要求

推荐改成外部 store 或 ref-based controller：

1. controller 接收 `getState` 与 `setState`：
   ```ts
   createDialogController(getState, setState)
   ```
2. `isBlocking()` 直接读取 `getState().activeDialog !== null`。
3. `getSnapshot()` 返回当前 state，而非 `createInitialDialogState()`。
4. 若调用方当前只有 `setState`，需要在调用方维护 `useRef` 同步当前 dialog state。

#### 测试用例

- openPermission 后 snapshot.activeDialog 为 `permission`。
- openQuestion 后如果 permission 已存在，activeDialog 优先级按设计明确。
- closePermission 后 question 仍在时 activeDialog 为 `question`。
- isBlocking 不触发 setState。

---

### P1-6: plugin hook 跨平台进程树终止

**涉及条目**: H12  
**文件**: `packages/plugin/src/content-pack/ecc-hook-adapter.ts`

#### 修复要求

1. 不要在 Windows 上调用 `process.kill(-pid)`。
2. 统一使用已有 `terminateProcessTree()` 工具，或实现：
   - POSIX: `process.kill(-pid, signal)`
   - Windows: `taskkill /PID ${pid} /T /F`
3. safe spawn 的 `detached` 应按平台设置：
   ```ts
   detached: process.platform !== "win32"
   ```
4. 超时后先 graceful，再 force；Windows 可直接 force。

#### 测试用例

- 通过 mock child pid，验证 Windows 分支调用 taskkill。
- POSIX 分支仍使用负 pid。
- timeout settle 只执行一次。

---

### P1-7: permission hook 支持返回 `"ask"`

**涉及条目**: M11  
**文件**: `packages/security/src/hooks.ts`

#### 修复要求

`runBeforeToolCall()` 应短路所有显式 decision：

```ts
if (result === "deny" || result === "allow" || result === "ask") return result
```

#### 测试用例

- 一个 hook 返回 ask，后续 hook 不执行。
- ask 能覆盖原本 allow 的默认权限。
- hook throw 仍 fail-safe deny。

---

### P1-8: 嵌套 args 匹配与 shell sensitive tokenization

**涉及条目**: M15, M19  
**文件**:

- `packages/security/src/permission.ts`
- `packages/tools/src/shell-dual-track/shell-security.ts`

#### 修复要求 A: permission deep match

替换浅层 `actual[key] !== val`：

1. 支持 primitive exact。
2. 支持 plain object 递归包含匹配。
3. 支持 array exact 或包含策略，必须在测试中明确。
4. 支持 RegExp rule value 可选；若不想扩展类型，则不要实现。

#### 修复要求 B: shell sensitive tokenization

1. token split 增加 `=`：
   ```ts
   command.split(/[\s="'|&;<>()`$]+/)
   ```
2. 不要因为 token startsWith("-") 就跳过含路径参数：
   - `--file=/etc/shadow` 应被拆出 `/etc/shadow`。
   - `--env-file=.env` 应检测 `.env`。
3. 增加对 `KEY=/path`、`--flag=/path` 的右侧检测。

#### 测试用例

- `cat --file=/etc/shadow` denied。
- `docker run --env-file=.env image` denied。
- `echo safe` allowed。
- permission deny rule `{ args: { payload: { path: "secret" }}}` 能匹配嵌套对象。

---

## 5. P2 修复 Spec

P2 是可靠性和统计语义改进。建议在 P0/P1 全部通过后执行。

### P2-1: context round truncation 重写

**涉及条目**: S2  
**文件**: `packages/core/src/context/manager.ts`

#### 修复要求

新增 helper：

```ts
function findFirstCompleteRoundEnd(messages: ChatMessage[], startUserIdx: number): number {
  for (let i = startUserIdx + 1; i < messages.length; i++) {
    if (messages[i].role === "user") return i
  }
  return messages.length
}
```

并对无 user 的异常日志形态单独处理：

- 如果开头是孤立 tool，连续删除到第一个非 tool/或下一个 user。
- 不得返回会留下孤立 tool result 的 slice。

#### 测试用例

- `user, assistant(tool_calls), tool, tool, user` 删除第一整轮后从第二 user 开始。
- `tool, tool, user` 不留下开头 tool。
- `assistant, tool, user` 不留下孤立 tool。

---

### P2-2: eval failure classification 顺序

**涉及条目**: M5  
**文件**: `packages/core/src/eval/runner.ts`

#### 修复要求

policy gate failure 应优先于 worker empty output，除非 error 是 system/preflight。

推荐顺序：

1. pass
2. system/preflight/setup error
3. policy_gate_failure
4. verifier classification
5. worker_empty_output
6. worker_failure fallback

#### 测试用例

- workerOutput empty + protectedFiles fail => `policy_gate_failure`
- workerOutput empty + no policy + verifier skipped => `worker_empty_output`

---

### P2-3: scoring/eval JSON 语义清理

**涉及条目**: M6, M28  
**文件**: `packages/core/src/scoring/eval-runner.ts`

#### 修复要求

- `completedKnown` 只有在 `coerceBoolean(parsed.completed) !== undefined` 时为 true。
- verification parsing 使用 `coerceBoolean`。
- 对 null/unknown 值写测试。

---

### P2-4: checkpoint save 单读合并

**涉及条目**: M7  
**文件**: `packages/core/src/checkpoint/checkpoint-engine.ts`

#### 修复要求

当前 save 多次 `readExistingCheckpoint()`，逻辑复杂。建议：

1. 单次读取 base。
2. 若读取失败但主文件存在，有限重试一次。
3. merge runtimeV2。
4. atomic write tmp + rename。
5. terminal checkpoint 的保护规则用显式测试表达。

---

### P2-5: forced mode exit 检查最近工具失败

**涉及条目**: M8  
**文件**: `packages/core/src/governance/mode-decision.ts`

#### 修复要求

`shouldExitForcedMode()` 增加：

```ts
if (!state.lastToolSuccess || signals.includes("tool_failure")) return false
```

#### 测试用例

- pendingStep=0/stable enough，但 lastToolSuccess=false，不退出 forced。
- lastToolSuccess=true 且其他条件满足，退出。

---

### P2-6: git objective signal fail-closed

**涉及条目**: M9  
**文件**: `packages/core/src/eval/runner.ts`

#### 修复要求

git 命令失败时：

```ts
cleanGitDiff: false
toolTrackingValid: false
```

并增加 `gitSignalError?: string` 或写入 objective metadata，避免把未知当干净。

---

### P2-7: MemoryStore update parse/not-found 区分与 Windows atomic fallback

**涉及条目**: H13, M14  
**文件**: `packages/memory/src/runtime/memory-store.ts`

#### 修复要求

1. `get()` 不应吞掉所有错误并返回 null。
   - not found: null
   - JSON parse error: throw or return typed error
   - permission/read error: throw
2. `update()`:
   - not found 可按 `{}` create。
   - parse/read error 不得覆盖原文件。
3. Windows rename 失败：
   - 尽量使用 retry/backoff。
   - 若跨设备/权限导致 rename 不可用，fallback 写入前先保留 `.bak`。
   - 文档化“非完全原子”的 fallback。

---

### P2-8: FileSnapshot 支持指定快照或 revert 后 pop

**涉及条目**: M16  
**文件**: `packages/security/src/snapshot.ts`

#### 修复要求

二选一：

- `revert(filepath, snapshotName?)` 支持指定 snapshot。
- 或 latest revert 成功后删除 latest snapshot，使连续 revert 可多步回退。

必须先确认产品期望。若无需求，不做破坏性 API 改动。

---

### P2-9: fuzzy edit 空行灌水与 trimmed replacement

**涉及条目**: M20, M24  
**文件**: `packages/tools/src/fuzzy-edit.ts`

#### 修复要求

1. `blockAnchorPass` matches 统计忽略双方都为空的行：
   ```ts
   if (trimmedNeedle[k] && trimmedRegion[k] && trimmedNeedle[k] === trimmedRegion[k]) matches++
   ```
2. threshold 基于非空 needle lines 计算，而不是总行数。
3. trimmed full replacement 是否保留周边空白必须明确：
   - 推荐替换完整原始行跨度，而不是只替换 trimmed substring。
   - 若保留当前行为，返回 warning `trimmed_match_preserved_surrounding_whitespace`。

---

### P2-10: runtime logger overflow 简化

**涉及条目**: M29  
**文件**: `packages/core/src/runtime-logger.ts`

#### 修复要求

当前 `queue + pendingOverflow + setImmediate` 模型难审计。建议改为单一 bounded queue + single flush promise：

1. enqueue 只进一个 bounded queue。
2. flush 中 swap queue 到 local chunk。
3. flushing 时继续 enqueue 到新 queue。
4. droppedCount 只在 queue 超限时增加。
5. flush() 等待当前 flushing + 再 flush 剩余 queue。

---

### P2-11: branch budget 新文件豁免收紧

**涉及条目**: M30  
**文件**: `packages/core/src/governance/branch-budget.ts`

#### 修复要求

当前已达到 file edit max 后，如果 `write_file` path 不存在，会放行。应改为：

1. 新文件也计入 `fileEdits` 或新增 `createdFiles` budget。
2. 对同一路径 create/delete/create 不应绕过。
3. 可设置单独阈值：
   ```ts
   newFileCreateMaxPerRound
   ```
4. 测试 create-delete-create 是否被 block。

---

## 6. 不建议修复 / 不成立条目清单

Agent 不要处理以下条目，除非用户另行指定：

- S3：lock chain 永久阻塞，当前代码不成立。
- H3：`loadLastConfig` null guard 当前已存在。
- H5：未定位到 `keyed-mutex.ts`。
- M4：verifier fail 双重惩罚属于评分策略。
- M10：benchmark 零 tool use 扣分属于评分策略。
- M13：stdin.write callback 迟到 reject 低价值。
- M17：search index prefix scoring 是检索质量优化，不是逻辑修复。
- M21：当前 `contextAwarePass` 已排除空行匹配。
- M22：未定位到 `scheduler-backend.ts`。
- M26：`CLAUDE_PLUGIN_ROOT` 属兼容命名/文案问题。
- M27：当前 regex 无 `g` flag，不存在 lastIndex 副作用。
- L1-L23：除 L6 可与 S7 顺手修，其余不进入首轮逻辑修复。

---

## 7. 建议给 coding agent 的执行指令

下面这段可以直接作为修复任务 prompt 使用。

```markdown
你是 Covalo 仓库的修复 agent。请按本文 `Covalo 逻辑审查验真与修复 Spec` 执行修复。

执行约束：

1. 只修 P0 和 P1，P2 不动，除非 P0/P1 测试需要极小范围辅助改动。
2. 不要照搬原审查报告；以本 spec 的验真结论为准。
3. 每个修复点必须添加或更新测试。
4. 保持 TypeScript ESM 兼容，不要新增裸 require。
5. 安全相关逻辑 fail closed。
6. 修改后运行：
   - bun run typecheck
   - bun test packages/core packages/tools packages/tui packages/security packages/memory
7. 输出最终报告：
   - 修改文件列表
   - 每个 P0/P1 条目的修复说明
   - 新增测试列表
   - 未修复项及原因
```

---

## 8. 推荐提交拆分

为降低回归风险，建议拆成 5 个 commit/PR：

### PR 1: Eval scoring correctness

包含：

- P0-1 Supervisor score normalization
- P0-2 protected file path matching
- P0-3 safetyIssue / verification boolean parsing
- P2-2 failure classification 可选，不建议首 PR 合入，除非测试覆盖充分

### PR 2: Security and platform hardening

包含：

- P0-4 IPv6 SSRF
- P0-5 ESM require removal
- P1-6 plugin hook process kill
- P1-8 shell sensitive tokenizer

### PR 3: Loop/tool-call consistency

包含：

- P1-1 stream lifecycle
- P1-2 toolCallId ledger mapping

### PR 4: Output and edit boundaries

包含：

- P0-6 empty old_string
- P1-3 bounded output and background output format

### PR 5: TUI/LSP state correctness

包含：

- P1-4 LSP state/pending/document sync
- P1-5 dialog store snapshot/ref
- P1-7 permission hook ask support

---

## 9. 最小验收命令

```bash
bun run typecheck
bun test packages/core packages/tools packages/tui packages/security packages/memory
bun test packages/core/src/eval packages/core/src/scoring packages/tools/src packages/tui/src/store packages/security/src
```

如果仓库测试量较大，至少运行以下目标测试：

```bash
bun test packages/core/src/eval
bun test packages/core/src/scoring
bun test packages/tools/src
bun test packages/tui/src/store
bun test packages/security/src
```

---

## 10. 最终验收标准

修复完成后，必须满足：

1. 0-100 supervisor 评分不会被 0.5 阈值误判。
2. `src/test` 不会误保护 `src/test-utils`。
3. `safetyIssue:"true"` 和 worker verification `"yes"` 可被识别。
4. `hasPrivateIP("::")`、`hasPrivateIP("::1")`、`hasPrivateIP("::ffff:127.0.0.1")` 均为 true。
5. ESM 环境下 grep 工具不引用 `require`。
6. edit 空 `old_string` 立即返回错误，不挂起。
7. tool-use stream 中工具批次只执行一次，stream error 不产生不完整 tool-call 上下文。
8. 同名多 tool call 的 ledger args 不串账。
9. background task 输出保留空行。
10. dialog store snapshot 反映真实 active dialog。
11. LSP server 重启后文档重新 didOpen。
12. hook 返回 ask 能升级权限决策。
13. Windows hook timeout 能杀掉子进程树。
14. `--file=/etc/shadow` / `--env-file=.env` 被 shell security 拒绝。
