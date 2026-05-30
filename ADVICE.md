# Deepicode 代码审查与建议

**最后更新**: 2026-06-01（6 项 Bug 修复完成）

---

## 一、审计报告评估总览

对 `DeepicodeAudit-2026-06-01.md` 中 15 项发现逐条验证。结论：

| 类别 | 数量 | 说明 |
|------|------|------|
| ✅ 有效需修复 | 4 | 真实 Bug，建议近期修复 |
| ⚠️ 部分有效/低优 | 5 | 理论上成立但影响小或边缘场景 |
| ❌ 误判/已修复 | 6 | 审计算法误读代码结构或问题已不存在 |

---

## 二、逐条评估

### ✅ P1-2：StreamingToolExecutor 事件顺序不一致（降级为 P2）

**审计描述**：exclusive 工具 `tool_progress("done")` 在 `tool/error` 事件之前，shared 工具反之。

**验证结果**：代码确认存在。`executeToolCall`（exclusive）先 yield done 再 yield event；`flushSharedBatch`（shared）先 yield event 再 yield done。

**实际影响**：TUI bridge 中 `tool_progress("done")` 和 `tool` 事件都设 `status: 'done'`，后者额外附 `output`。exclusive 路径下工具状态短暂显示 done 但无 output，下一事件立即补上。肉眼不可感知。

**判断**：真实不一致但严重性远低于 P1。降级为 P2。

**建议修复**：统一 `executeToolCall` 的顺序为 `appendToolResult → yield event → yield tool_progress("done")`。

---

### ✅ P2-1：write tier 工具自动放行

**审计描述**：edit/write_file 默认无需确认即可执行。

**验证结果**：`permission.ts` 中只有 `"exec"` tier 触发 `"ask"`，`"write"` 直接 `"allow"`。

**实际影响**：当前安全基线靠 bash denylist + 敏感文件保护，write tier 确实可无确认修改文件。在多人协作或敏感项目中需要确认机制。

**判断**：设计选择而非 Bug，但确实可增强。如果 CLI 默认模式下编辑文件需要确认，用户体验会很差（CC 的 acceptEdits 模式也存在）。更合理的方案是支持可配置的权限模式（如 CC 的 `default`/`acceptEdits`/`dontAsk` 三级）。

**建议**：暂不修改当前默认行为，待 Phase 5 完善权限模式时统一处理。

---

### ✅ P2-3：SessionLoader 崩溃恢复数据丢失

**审计描述**：只保留最后一条有效 messages 记录，中间截断的会被跳过，导致丢失多轮对话。

**验证结果**：代码确认。遍历 JSONL 全部行，只保留 `lastMessages`。如果最后一条 JSON 行被截断（parse 失败），回退到倒数第二条（可能是很旧的快照）。

**实际影响**：当前 session 写入是 best-effort（`AsyncSessionWriter.flushSoon()` catch 错误），不是每轮都完整持久化。崩溃恢复场景概率低但影响大。

**判断**：真实 Bug，低概率高影响。

**建议修复**：从后向前遍历，找到第一条可解析的 messages 记录即返回。修改量 < 5 行。

---

### ✅ P2-5：TokenizerPool 单次超时永久降级

**审计描述**：Worker 超时 5s 后 `healthy = false`，后续全部走 main thread fallback。

**验证结果**：代码确认。`setTimeout` 中直接设置 `this.healthy = false`，之后所有 `estimate()` 调用都走 `fallbackEstimate()`。

**实际影响**：Worker 偶发挂起会导致 tokenizer 精度永久降低（主线程 4 chars/token vs Worker 细化估算），但对功能无阻断。

**判断**：真实 Bug，设计上太激进。生产环境中 Worker 偶尔超时不应导致永久降级。

**建议修复**：改为连续 3 次超时才降级，Worker 正常响应时重置计数（审计建议可行，修改量 ~10 行）。

---

### ⚠️ P2-2：Windows 无 bash

**审计描述**：bash 工具在 Windows 上直接调用 `bash`，Windows 无原生 bash。

**验证结果**：代码确认。`spawn("bash", ...)` 硬编码，且项目运行在 Bun/Linux 环境。

**判断**：技术上准确但 Deepicode 目标平台是 Linux。暂不处理。

**建议**：搁置。待有 Windows 用户需求时再处理。

---

### ⚠️ P2-4：ContextManager 截断可能切断 assistant+tool 组

**审计描述**：截断只检查孤立的 tool 消息，不检查 assistant(tool_calls) 缺少 tool 结果的情况。

**验证结果**：代码确认。当前逻辑向前扫描找孤立的 tool 消息并调整 cutFrom。但确实未处理场景：cutFrom 恰好落在一个 assistant(tool_calls) 消息上，且其 tool 结果在 cutFrom 之前被截断。结果是新的消息序列以 assistant(tool_calls) 开头但无对应 tool 结果 → API 400。

**触发条件**：maxRounds 很小（如 3）且截断边界恰好命中带 tool_calls 的 assistant 消息。实际触发概率低（maxRounds 默认 20）。

**判断**：理论正确但极边缘。当前修复已大幅改善（向前扫描配对逻辑），剩余遗漏点触发概率很低。

**建议**：如果有人工修复的预算，可以增加反向检查（检查截断后的第一条消息是否为 assistant(tool_calls)，如果是则连同它一起切掉）。否则可标记为已知限制。

---

### ⚠️ P3-1：repair.truncate 可能静默修改参数

**审计描述**：截断后加 `}` 可能产生语义不同的合法 JSON。

**验证结果**：Truncation 阶段在 Scavenge（6 子策略）全部失败后才触发，且保留最小长度 100 字符。LLM 输出的截断 JSON 以 `}` 收尾是常见修复手段。

**判断**：理论上可能，但：
1. Truncation 是修复流水线最后一环（Scavenge 已尝试 6 种提取方式）
2. 场景极窄：需要恰好截断出的 JSON 合法但语义不同
3. 即使发生，影响范围是单次工具调用参数——模型会在下一轮纠正

**建议**：标注已知限制，不优先修复。如果后续有 token 预算，可以加语义校验（对比 repair 前后的 keyset 差异）。

---

### ⚠️ P3-2：FileSnapshot Date.now() 碰撞

**审计描述**：`Date.now()` 作为快照文件名，高频场景可能碰撞。

**验证结果**：`snapshot.ts:14` 确认使用 `Date.now()`。碰撞概率极低（单毫秒内对同一文件做两次 snapshot），需要自动化测试或极高频编辑场景。

**判断**：真实但优先级极低。类似 hash-edit.ts 的 B4 修复（`Date.now()` → `randomUUID()`），改造成本 ~1 行。

**建议**：有修复预算时改 `Date.now()` → `randomUUID()`。

---

### ⚠️ P3-3：DeepiMessages React key 不稳定

**审计描述**：key 中 `content.slice(0,20)` 在流式输出时频繁变化导致 React 重渲染。

**验证结果**：代码确认。`msg.role + i + (msg.content?.slice(0, 20) ?? '')` 在 streaming 时 content 变化 → key 变化。

**判断**：真实。流式输出时每个 delta 追加到 content，key 随之变化，React 会 unmount/remount 该元素。表现为轻微闪烁。

**建议**：添加稳定的消息 id 字段（如在 ChatMessage 中增加 `id: string`），用 id 作为 key。或对流式消息用固定 key（role + index），非流式才加 content 前缀。

---

### ❌ P1-1：hash-edit.ts 流式写入竞态 — 误判

**审计描述**：`writer.end()` 后 `for await` 循环继续，向已关闭流写入。

**验证结果**：审计误读了代码结构。`if (!replaced)` 检查在 `for await` 循环**结束后**（第 76 行），而非循环内部。此时 reader 已完整消费，不存在「循环继续」的可能。

**判断**：**误判**。审计基于不存在的代码结构做出了错误推理。

**建议**：驳回。

---

### ❌ P3-4：buildPiModel contextWindow 硬编码 — 死代码

**审计描述**：`buildPiModel` 硬编码 `contextWindow: 1_000_000` 覆盖 config 的 128_000。

**验证结果**：`buildPiModel` 仅在 `config.ts` 中定义，**全项目无任何其他文件引用**。是 old pi-ai 时代遗留的 dead code（TODO.md 中 D5 条目标记为「移植遗留」）。

**判断**：技术上准确但函数未被使用。不产生实际影响。

**建议**：随 D5 旧代码清理时删除，无需单独修复。

---

### ❌ TUI-CtrlC：输入框锁定 — 已修复

**审计描述**：interrupt 后 `isStreaming` 未立即重置，输入框持续禁用。

**验证结果**：此问题描述的是 SIGINT 修复**之前**的状态。2026-05-30 三轮 SIGINT 修复中，`bridge.tsx` 的 `cancel()` 已改为立刻重置 `isLoading: false`（不等生成器 drain）。审计日期为 2026-06-01，但审查的是修复前的代码快照（审计可能基于旧代码）。

**判断**：**已过期**。当前代码已解决此问题。审计的三条修复建议中，第 3 条（`setState(s => ({...s, isStreaming: false}))`）已被我们的修复采纳。

**建议**：无操作。问题已不存在。

---

### ❌ A1 + A2：架构建议

A1（工具执行后无独立验证步骤）和 A2（Fold 操作无成本记录）是架构改进建议而非 Bug。其中：
- A1：System prompt 已要求「修改后必须验证」（软约束），代码级硬约束可后续考虑
- A2：Phase 2 策略系统包含成本追踪设计

**建议**：记录下来，Phase 2/7 时作为增强项考虑。不阻塞当前开发。

---

## 三、建议修复优先级

| 优先级 | 编号 | 问题 | 状态 |
|--------|------|------|------|
| ✅ 已修复 | P2-5 | TokenizerPool 永久降级 | `tokenizer-pool.ts` — 连续3次超时才降级 |
| ✅ 已修复 | P1-2 | 事件顺序统一 | `streaming-executor.ts` — exclusive 路径顺序对齐 shared |
| ✅ 已修复 | SEC-1 | glob.ts 路径穿越 | `glob.ts` — realpath + startsWith 校验 |
| ✅ 已修复 | P2-3 | SessionLoader 崩溃恢复 | `session.ts` — 从后向前扫描 |
| ✅ 已修复 | P3-3 | React key 稳定性 | `DeepiMessages.tsx` — 去掉 content 前缀 |
| ✅ 已修复 | SEC-2 | web-fetch.ts SSRF | `web-fetch.ts` — IP 校验 + DNS 异步解析 + redirect:manual |
| 🟢 搁置 | P2-1 | write tier 权限确认 | 设计讨论，Phase 5 统一处理 |
| 🟢 搁置 | P2-2 | Windows bash | 非目标平台 |
| 🟢 搁置 | P2-4 | 截断边界 assistant(tool_calls) | 边缘场景 | `manager.ts` |
| 🟢 搁置 | P3-2 | FileSnapshot 碰撞 | ~1行 | `snapshot.ts` |
| ❌ 驳回 | P1-1 | hash-edit 竞态 | — | 审计误读代码结构 |
| ❌ 驳回 | P3-1 | repair 语义变更 | — | 理论可能但无实际路径 |
| ❌ 驳回 | P3-4 | buildPiModel | — | 死代码，随 D5 清理 |
| ❌ 已修复 | TUI-CtrlC | 输入框锁定 | — | 已在 SIGINT 修复中解决 |

---

## 四、安全审查发现（2026-06-01 自动化审查）

### SEC-1：glob.ts 路径穿越 [MEDIUM]

**文件**：`packages/tools/src/glob.ts`
**问题**：`resolve(ctx.cwd, args.path)` 未校验结果在项目目录内，可构造 `../../etc` 类路径读取任意目录。

**当前状态**：未修复。`file-ops.ts` 和 `shell-exec.ts` 已有同类校验（`realpath` + `startsWith`），可复用模式。

**修复方案**：
```ts
const resolved = realpath(resolve(ctx.cwd, args.path))
const base = realpath(ctx.cwd)
if (!resolved.startsWith(base + path.sep) && resolved !== base) {
  return { isError: true, content: "path outside project" }
}
```

### SEC-2：web-fetch.ts SSRF [MEDIUM]

**文件**：`packages/tools/src/web-fetch.ts`
**问题**：`fetch(url, { redirect: "follow" })` 可被利用访问内网资源（`http://169.254.169.254/`、`http://localhost:8080/` 等）。

**当前状态**：未修复。该工具尚未正式启用（TODO.md TL1.1 计划中），启用前需加入以下防护：
1. DNS resolve → 拒绝 private/loopback/link-local IP
2. `redirect: "manual"` → 手动校验每个重定向目标 IP
3. 可选：允许域名白名单

---

## 五、未覆盖的风险

以下场景审计未涉及，但值在未来审查中关注：

1. **SSE 流中断恢复**：`client.ts` 的 abort/retry 在 Bun 环境下的行为可能与 Node.js 不同
2. **大文件 hash 计算**：`hash-edit.ts` 的 `createReadStream` 在 100MB+ 文件上可能阻塞主线程
3. **Worker 生命周期**：`tokenizer-worker.js` 在 Bun 的 Worker 实现中可能有内存泄漏
