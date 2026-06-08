# Deepreef 完成记录

最后更新：2026-06-09（AgentMemory 原生集成修订）

本文只记录当前代码中仍然成立的已完成功能和已验证修复。
未完成、待验收、明确暂缓和已驳回方案统一见 [TODO.md](TODO.md)。当前后续专项交接见 [ADVICE.md](ADVICE.md)。

---

## 1. 当前验证基线

本次同步依据最新 GitHub Actions 与最近一次本地全量验证：

```bash
bun run typecheck
bun test
```

结果：

| 检查项 | 状态 |
|--------|------|
| TypeScript | 最新 CI `bun run typecheck` 通过 |
| 测试 | 最新 CI Ubuntu：`1054 pass / 0 fail / 18 skip`，共 `78` 个测试文件 |
| 稳定性 | 连续 3 次全绿（TEST-STABILITY-01 已关闭） |
| CI | 最新 master run `26928659701`：✓ ubuntu-latest ✓ windows-latest ✓ macos-latest |

最新已验证提交：

- `6379767 docs: update ci green baseline`
- GitHub Actions: `https://github.com/bzcsk2/deepreef/actions/runs/26928659701`
- 真实代码 checkpoint：`c61cb0e chore: checkpoint full project state`
- CI 修复指南：[CI-Compatibility-Fix-Guide.md](CI-Compatibility-Fix-Guide.md)

---

## 2. 当前架构快照

```text
packages/cli/src/tui.ts
  └─ createDefaultTools() 注册 29 个内置工具 + 5 个 MCP bridge 工具
     └─ ReasonixEngine.submit()
        └─ runLoop(LoopOptions)
           └─ StreamingToolExecutor.run()
              └─ AgentTool.execute(args, ToolContext)

ReasonixEngine.submit()
  → AsyncGenerator<LoopEvent>
  → packages/tui/src/bridge.tsx
  → TimelineItem[] + TurnView
  → packages/tui/src/DeepiMessages.tsx
```

| 主题 | 当前实现 |
|------|----------|
| 运行时 | Bun |
| API Provider | DeepSeek / Zen / Mimo |
| TUI | React 19 + `@deepreef/ink`，显示组件适配自 Reasonix |
| Core 事件 | `AsyncGenerator<LoopEvent>`，使用 role-based 事件模型 |
| 工具并发 | `shared` 并行，`exclusive` 串行 |
| 工具进度 | 已有 `tool_start`、`tool_progress: running/done` 粗粒度事件 |
| 会话持久化 | `.deepreef/sessions/*.jsonl`，best-effort append |
| 上下文 | ImmutablePrefix + AppendOnlyLog + VolatileScratch |
| 权限 | `PermissionEngine` 的 deny → allow → ask 判定 |
| MainMode | `plan`（只读）+ `build`（完整工具集），`PlanMode` 工具切换 |
| Subagent | 三种内置角色：`general-purpose` / `Explore` / `Plan`，独立 child engine + 工具过滤 + 四级权限 |

---

## 3. 已完成能力

### 3.1 Core 与上下文

- SSE 流式解析：文本、reasoning、usage、tool call 和 done 事件。
- API 错误恢复：429 和 5xx 指数退避；连续流错误达到阈值后终止。
- provider tool finish reason 归一化，兼容多个命名变体。
- 空 tool-calls 防御、重复工具调用告警、最大循环轮数保护。
- ImmutablePrefix 指纹覆盖 system prompt 和 tool specs。
- ContextManager 按 user 轮次截断，保留完整 tool message 组。
- TokenizerPool 支持 Worker 调度、超时降级和 shutdown 清理。
- fold 决策支持 none / suggest / force，loop 使用 100ms fallback。
- SessionLoader 支持 read、list、recover、loadSession；恢复时由 Engine 过滤历史 system 消息。
- AsyncSessionWriter 队列上限为 500，溢出时优先淘汰旧 event，保留 messages 和 stats。

### 3.2 工具执行器

- `StreamingToolExecutor` 支持 shared 并行和 exclusive 串行。
- 工具结果按声明 index 顺序回写上下文。
- `toolCallIndex` 用于关联 tool delta、start、result 和 progress。
- 权限检查覆盖 shared 和 exclusive 两条路径。
- `ToolContext.signal` 传递到工具，支持中断。
- `ToolContext.invokeTool()` 支持嵌套调用并拒绝递归。
- Workflow 可以执行真实嵌套工具；后台 AgentTool 使用隔离子会话。
- P1 exactly-once：使用局部 `settled` 集合，成功、失败、拒绝和中断路径统一避免重复追加 tool result。
- loop 已移除中断后的整批盲补结果逻辑。

### 3.3 中途指令注入 Core

P2 已完成并通过对应 Core 测试：

- `CoreEngine.enqueueInstruction()` 返回 `queued / idle / ignored / full`。
- Engine 内部 `pendingInstructionQueue` 上限为 10。
- 工具批次完成后、最终回答结束前存在安全注入点。
- 注入内容作为普通 user message 进入上下文，不修改 system prompt。
- 注入消息写入 SessionWriter。
- interrupt 会清空待注入队列。

TUI 路由已完成接入，`P3-R` 已收口 bridge 回归测试。

### 3.4 TUI

- 保留 Deepreef 自己的 `TimelineItem[] + TurnView` 状态模型。
- Reasonix 显示组件：Card、CardHeader、Markdown、StreamingCard、ToolCard、Spinner、主题 token。
- 流式 assistant 文本、reasoning 折叠显示、工具卡片、耗时和错误内联。
- 工具 key 使用 `toolCallIndex + sequence`，避免后续批次重复 index 覆盖历史记录。
- cancel 先调用 `respondPermission(false)`，再调用 `interrupt()`，避免权限 Promise 悬空。
- TUI `messageQueue` 保留串行提交语义。
- Ctrl+C：加载中取消；空闲时双击退出；终端清理顺序已固定。
- 多行输入、历史记录、Ctrl+方向键跳词、Ctrl+Backspace 删除前词。
- 斜杠命令自动补全已完成；菜单打开时 ↑↓ 只改变选中项，Enter/Tab 回写命令，Esc 关闭菜单。
- 中英文 i18n：`zh-CN / en`，`/lang` 切换并写入 `.deepreef/lang.json`。
- 长会话显示优化：React.memo、useMemo 和 Ink viewport culling。
- `Ctrl+F` 消息搜索与屏幕空间高亮。
- `/context` 菜单已完成：居中弹窗，支持 strategy 切换、trigger/target 比例调整、当前用量显示和 `Run now` 立即执行。

### 3.5 安全

- PermissionEngine：Deny-first，支持 allow / deny 规则、序列化和恢复。
- HookManager：before / after / loop-event 三类 hook。
- before hook 异常 fail-safe 为 deny。
- after 和 loop-event hook 异常被隔离；支持 `setErrorObserver()` 观察错误。
- FileSnapshot：文件快照、恢复、SHA256 路径索引和稳定排序。
- 敏感路径规则覆盖 `.env*`、`.git`、密钥、证书、npmrc、AWS 凭据等。
- WebFetch 和 WebBrowser 执行协议校验、私网地址拒绝和重定向后复查。
- 兼容工具名 `bash` 内部使用当前平台 shell backend，设置非交互环境变量，限制危险命令，并支持进程树终止。

### 3.6 工具与 MCP

Build Agent 当前开放 `34` 个静态工具：

- `packages/tools`：`29` 个。
- MCP bridge：`5` 个。

Plan Agent 只开放：

```text
read_file
list_dir
grep
todowrite
```

MCP 已完成：

- `McpClient`：stdio JSON-RPC。
- `McpHost`：多 server 管理、后台加载配置、工具和资源发现。
- `ListMcpResources`、`ReadMcpResource`、`ListMcpTools`、`CallMcpTool`。
- `McpAuth`：项目级 token 存储，支持 set / list / delete；文件权限 `0600`，list 仅返回掩码。

Skills 已接入：

- `packages/tools/src/skills/` 当前包含 `52` 个 `SKILL.md`。
- Skill 工具支持 search / list / load。
- TUI 提供 `/skill` 命令。

### 3.7 运行时日志系统骨架（LOG0-LOG7）

运行时诊断系统已落地：

**核心组件：**

- `RuntimeLogger`：默认关闭，异步写入 JSONL，支持事件过滤。
- `RuntimeLogSink`：单 sink 设计，timer-based flush（1s），队列超限自动丢弃。
- `parseDebugArgs()`：支持 `--debug`/`-d`/`--debug=<pattern>`/`--debug-file=<path>`。
- `createRuntimeLoggerFromEnv()`：从环境变量创建 logger。
- `registerShutdownFlush()`：优雅退出时 flush 日志。
- `cleanupOldLogs()`：后台清理过期日志。
- `checkDeprecatedDebugEnv()`：弃用 `DEEPREEF_DEBUG` 提示。

**已实现事件（全流程覆盖）：**

| 阶段 | 事件 |
|------|------|
| Core | `api.stream.first_event`, `api.usage`, `loop.stream.retry`, `loop.max_turns`, `reasoning.mode.switch` |
| Executor | `tool.batch.start/done`, `tool.execute.denied` |
| MCP | `mcp.host.start`, `mcp.server.connect.*`, `mcp.request.*` |
| Tools | `tool.result.overflow`, `tool.result.persisted` |
| Process | `process.shutdown.start/done` |

**配置：**

```text
DEEPREEF_LOG_LEVEL=debug|info|warn|error|off
DEEPREEF_LOG_FILE=<path>
DEEPREEF_LOG_FILTER=<pattern>
DEEPREEF_LOG_RETENTION_DAYS=7
DEEPREEF_LOG_MAX_TOTAL_MB=100
DEEPREEF_LOG_SYMLINK=1
DEEPREEF_TUI_DEBUG=1
DEEPREEF_TRACE=1
```

**Perfetto 追踪：**

- 简化版 Chrome Trace Event JSON 输出。
- Span 层级：interaction → llm_request → tool_batch → tool。
- 输出到 `.deepreef/traces/trace-<session-id>.json`。

### 3.8 自动推理模式切换（AS0-AS6）

基于 Provider 能力和规则的自动推理模式切换：

**核心组件：**

- `ProviderThinkingCapabilities`：Provider 思考能力映射。
- `ModeSelector`：纯规则评估器，状态机（idle → pending → active → cooldown）。
- `ModeStats`：切换统计和成功率追踪。

**已实现功能：**

| 阶段 | 内容 |
|------|------|
| AS0 | `reasoning_content` 工具链连续性修复 |
| AS1 | Provider 能力和请求映射 |
| AS2 | 纯规则评估器（120s cooldown） |
| AS3 | Controller 和 loop 集成 |
| AS4 | TUI 状态显示（StatusBar + bridge 事件） |
| AS5 | 手动覆盖 `/thinking` 命令 |
| AS6 | 统计追踪和成功率计算 |

**配置：**

```text
模式映射：
  off → thinking disabled
  low → thinking enabled
  medium → thinking enabled
  high → thinking + reasoningEffort=high
```

### 3.9 编辑链路

- `read_file`：路径解析、敏感路径拒绝、二进制检测、大小限制、行范围和截断提示。
- `write_file`：敏感路径拒绝、父目录创建和 10 MiB 限制。
- `edit`：stale-read 校验、CRLF 保持、hash-anchored 主路径和 fuzzy fallback。
- `hash-edit`：随机临时文件、原子 rename、权限位保持和二进制保护。
- `fuzzy-edit`：多 pass 匹配；遇到歧义时拒绝猜测。
- NotebookEdit：异步读写、临时文件 + rename、权限位保持。

---

## 4. 已完成专项

### 4.1 TUI 收尾

| 编号 | 内容 |
|------|------|
| F3/F5 | StreamingCard 与 token/s 估算 |
| T20 | 多行输入 |
| T21 / T21-R | 斜杠命令自动补全与键盘事件冲突修复 |
| T22 | 跳词和 Ctrl+Backspace |
| T30/T31/T32 | i18n 基础设施、文案替换、`/lang` |
| T40 | 长会话渲染优化 |
| T41 | 消息搜索 |

### 4.2 生命周期闭环（LIFE-01）

| 编号 | 内容 | 验证命令 |
|------|------|----------|
| LIFE-01 | CLI 与 Engine 生命周期闭环 | `bun test e2e/system/cli-pipe-mode.acceptance.test.ts` |

**实现边界：**

- `ReasonixEngine.shutdown()`：幂等；中断活跃 submit；调用 `ctx.shutdown()` 终止 tokenizer worker；drain session writer；flush runtime logger。
- `ContextManager.shutdown()` / `TokenizerPool.shutdown()`：异步 terminate worker，清理 pending tasks。
- `AsyncSessionWriter.drain()`：best-effort，等待队列排空，不阻塞 shutdown。
- `RuntimeLogSink.flush()`：显式清除 `flushTimer`，避免定时器残留。
- CLI `tui.ts`：`try/finally` 管理 engine + MCP host；`main()` resolve 后 `process.exit(0)` 兜底。
- `delegateTask()`：子 Engine 在 `finally` 中关闭。

**保留限制：**

- Bun 1.3.6 的 `fetch()` keep-alive 连接阻止自然进程退出（连接池不在 `_getActiveHandles()` 中）。已尝试 `keepalive: false`、`resp.body?.cancel()` 均无效。最终在所有资源显式关闭后由 `process.exit(0)` 兜底，不依赖 Bun 内部连接池超时。
- TUI `/exit` 后仍由同一 finally 块关闭 engine，未单独测试 PTY 路径（需原生终端环境）。

### 4.3 稳定性修复

| 编号 | 内容 |
|------|------|
| L2 | SessionWriter 有界队列 |
| L5 | 编辑链路 CRLF 归一化并恢复原格式 |
| N1 | NotebookEdit 异步原子写 |
| N2 | `/skill` 使用 `@deepreef/tools` 跨包导入 |
| N3 | SessionPicker 避免卸载后 setState |
| N4 | 空 tool call id 规范化 |
| N5 | client.ts 类型断言收紧 |
| LOG-READABILITY-01 | 收窄日志敏感字段规则：凭证 token 继续脱敏，token 用量统计保留数值 |

### 4.4 工具结果与指令注入

| 编号 | 内容 | 状态 |
|------|------|------|
| P0 | 工具结果、中断、权限和 TUI 队列契约测试 | 已完成 |
| P1 | tool result exactly-once | 已完成 |
| P2 | Core 中途指令队列和 loop 安全点 | 已完成 |
| P3 / P3-R | TUI 注入优先路由和反馈基础接入 | 已完成 |
| P4 | 结果溢出持久化 | 已完成 |
| P5 | Hook 可观测性增强 | 已完成 |

### 4.4 自动推理模式切换（AS0-AS6）

| 编号 | 内容 | 状态 |
|------|------|------|
| AS0 | reasoning_content 工具链连续性修复 | 已完成 |
| AS1 | Provider 能力和请求映射 | 已完成 |
| AS2 | 纯规则评估器 | 已完成 |
| AS3 | Controller 和 loop 集成 | 已完成 |
| AS4 | TUI 状态显示 | 已完成 |
| AS5 | 手动覆盖 `/thinking` 命令 | 已完成 |
| AS6 | 统计追踪 | 已完成 |

### 4.5 运行时日志系统（LOG0-LOG7）

| 编号 | 内容 | 状态 |
|------|------|------|
| LOG0 | 冻结并验收现有骨架 | 已完成 |
| LOG1 | 完善 Core 全链路日志 | 已完成 |
| LOG2 | 迁移 Claude Code 调试体验 | 已完成 |
| LOG3 | 接入 MCP 日志 | 已完成 |
| LOG4 | 定点接入 Tools 日志 | 已完成 |
| LOG5 | TUI 与 Ink 性能采样 | 已完成 |
| LOG6 | Perfetto Trace（可选） | 已完成 |
| LOG7 | 轮转、清理和文档 | 已完成 |

### 4.6 ADVICE.md Bug 修复（AUD-01~10）

| 编号 | 优先级 | 内容 | 状态 |
|------|--------|------|------|
| AUD-01 | P0 | bash 敏感文件扫描绕过 | 已修复 |
| AUD-04 | P1 | thinking mode emergency 生命周期 | 已修复 |
| AUD-06 | P2 | fallback tool-call ID 并发稳健性 | 已修复 |
| AUD-09 | P3 | SSE 首事件 BOM 容错 | 已修复 |
| AUD-10 | P3 | 敏感 key 规则补充 | 已修复 |

---

### 4.7 策略系统基础

| 编号 | 内容 | 状态 |
|------|------|------|
| ST1 | `strategy/tiers.ts` 四级 tiers 数据模型和测试 | 已完成 |

### 4.8 Context 压缩专项（CTX-10, CTX-30）

| 编号 | 内容 | 状态 |
|------|------|------|
| CTX-10 | 策略类型、配置加载和菜单解析 | 已完成 |
| CTX-30 | 摘要区和 summarizer 接口 | 已完成 |

**实现边界：**

- 新增 `packages/core/src/context/policy.ts`：定义 `ContextPolicy` 类型、`DEFAULT_CONTEXT_POLICY`、`validateContextPolicy()` 和 `mergeContextPolicy()`。
- 新增 `packages/core/src/context/policy-store.ts`：负责从 `.deepreef/context.json` 读取和写回策略配置，读失败回退默认值。
- `ReasonixEngine` 接入 `ContextPolicyStore`：启动时异步加载配置，`setContextPolicy()` 异步保存到文件。
- `setContextPolicy()` 改为异步方法，TUI 调用点已适配。
- 新增 `packages/core/__tests__/context-policy.test.ts`：覆盖策略验证、合并和持久化逻辑（26 个测试）。

**验收命令：**

```bash
bun test packages/core/__tests__/context-policy.test.ts
bun run typecheck
bun test
```

**保留限制：**

- `.deepreef/context.json` 独立持久化，不混入主配置文件。
- 读取失败回退默认值，不阻塞启动。
- `setContextPolicy()` 异步保存，best-effort。

### 4.9 Context 压缩专项（CTX-30, CTX-40, CTX-50）

| 编号 | 内容 | 状态 |
|------|------|------|
| CTX-30 | 摘要区和 summarizer 接口 | 已完成 |
| CTX-40 | Engine 自动 trim/compact 触发 | 已完成 |
| CTX-50 | 真实 LLM summarizer | 已完成 |

**实现边界：**

- 新增 `packages/core/src/context/summary.ts`：`ContextSummary` 类类，维护 summary message，支持 replace / clear / read，summary 带 `[CONTEXT_SUMMARY]` / `[/CONTEXT_SUMMARY]` 标记。
- 新增 `packages/core/src/context/summarizer.ts`：`ContextSummarizer` 接口、`FakeSummarizer`（测试用）和 `MechanicalSummarizer`（本地机械摘要）。
- `ContextManager` 使用 `ContextSummary` 替代旧的 `summaryMessages` 字段，暴露 `getSummary()`、`setSummarizer()` 和 `runSummarize()` 方法。
- summary 插入顺序稳定：prefix → summary → log → scratch。
- 新增 `packages/core/__tests__/context-summary.test.ts`：覆盖 ContextSummary、isSummaryMessage、FakeSummarizer、MechanicalSummarizer 和 ContextManager 集成（25 个测试）。

**验收命令：**

```bash
bun test packages/core/__tests__/context-summary.test.ts
bun run typecheck
bun test
```

**保留限制：**

- summary 标记方便模型识别，避免重复包装。
- `setSummarizer()` 可选注入，不注入时 `runSummarize()` 返回 false。
- compress 模式才更新 summary，trim 模式不更新。

### 4.10 Context 压缩专项（CTX-40）

**实现边界：**

- `ContextPolicyMode` 类型扩展支持 `"compact"` 模式。
- `ReasonixEngine.submit()` 在 budget 超过 triggerRatio 时自动触发 context reduction。
- `compact` 模式：调用 `ctx.runSummarize()` 后执行 trim，成功记录 `context.reduction.compact.success`，失败记录 `context.reduction.compact.fallback` 并回退 trim。
- `trim` 模式：直接执行 trim，记录 `context.reduction.trim`。
- `ReasonixEngine.setSummarizer()` 暴露给外部注入 summarizer 实现。
- `ReasonixEngine.runContextReduction()` 将 `"compact"` 映射为 `"compress"` 调用底层 reduceToTarget。
- 新增 `packages/core/__tests__/engine-context-policy.test.ts`：覆盖策略设置、状态获取、reduction 触发和 compact fallback（12 个测试）。

**验收命令：**

```bash
bun test packages/core/__tests__/engine-context-policy.test.ts
bun run typecheck
bun test
```

**保留限制：**

- compact 失败时 fallback trim，不阻塞 submit。
- summarizer 未注入时 compact 退化为 trim。
- 日志不记录原始消息正文。

### 4.11 Context 压缩专项（CTX-50）

**实现边界：**

- 新增 `LLMSummarizer` 类：复用 `DeepSeekClient`，低温度（0.3），不带 tools。
- 输入控制：`truncateMessages()` 按 targetTokens 截断旧消息，保留最近消息。
- 输出控制：`maxTokens` 受 `targetRatio` 约束（50%），最小 256 tokens。
- 错误处理：HTTP 错误抛出、超时（默认 30s）抛出、空摘要抛出、AbortSignal 生效。
- `LLMSummarizerOptions` 配置：`client`、`apiKey`、`baseUrl`、`model`、`temperature`、`timeoutMs`。
- 新增 `packages/core/__tests__/context-summarizer.test.ts`：覆盖 LLM summarizer 成功、截断、错误、超时、空摘要、abort 和配置（11 个测试）。

**验收命令：**

```bash
bun test packages/core/__tests__/context-summarizer.test.ts
bun run typecheck
bun test
```

**保留限制：**

- summarizer 是引擎内部能力，不能触发普通 tool execution。
- 输入消息截断是机械的，不分析语义。
- 超时和错误处理是 best-effort，不保证 100% 覆盖所有网络异常。

### 4.12 Find_ground 隐性兜底治理（FG-20/30/40/50/70）

**实现边界：**

- `TokenizerPool`：
  - 新增 `getDiagnostics()`，暴露 `healthy`、`pendingTasks`、`fallbackCount`、`timeoutCount`、`workerErrorCount`、`lastFallbackReason`。
  - Worker 初始化失败、error/exit、timeout fallback 记录 `fallback.tokenizer`。
  - 修复 worker error/exit 时 pending task 使用 `fallbackEstimate([])` 的问题，改为按每个 task 的原始 messages fallback。
- `SessionLoader`：
  - 保留 `read(sessionId): Promise<ChatMessage[]>` 兼容行为。
  - 新增 `readDetailed(sessionId)`，区分 `ok/missing/empty/corrupt/unreadable`，并返回 `skippedLines` 和可选 `error`。
- `AsyncSessionWriter`：
  - 新增 `getStatus()`，返回 `queueSize`、`droppedCount`、`flushing`、`lastError`、`lastFlushAt`。
- `StreamingToolExecutor`：
  - 新增 `parseToolCallArgs()` 统一解析/修复工具参数。
  - unsafe invalid JSON 参数不再退化为 `{}`；直接生成 error tool result，不进入 permission prompt，不执行工具。
  - 保留已有安全 repair 路径；partial repair 仍拒绝。
- `edit`：
  - fuzzy fallback 保持兼容，但返回 JSON 增加 `warning: "exact_match_failed_used_fuzzy"`。
- `McpHost` / CLI：
  - `loadConfig()` 返回 `{ serverCount, connected, failed }` summary。
  - 新增 `getStatus()`。
  - CLI 后台加载 MCP 时，如果部分 server 失败，会向 stderr 输出简短提示；单个 server 失败仍不阻断启动。

**验收命令：**

```bash
bun run typecheck
bun test packages/core/__tests__/tokenizer-pool.test.ts packages/core/__tests__/session.test.ts packages/core/__tests__/streaming-executor.test.ts packages/core/__tests__/engine-tools.test.ts
bun test packages/tools/__tests__/edit.test.ts packages/tools/__tests__/edit-integration.test.ts
bun test packages/mcp/__tests__/mcp-host.test.ts
```

**保留限制：**

- 没有把所有 fallback 改为 throw；session、MCP、writer 仍保留 best-effort 语义。
- `edit` strict mode 尚未引入；当前只显式返回 warning。
- 临时文件 `chmod/unlink` 失败的日志收尾仍见 `TODO.md` 的 `FG-60-R`。

---

## 5. 重要历史修复摘要

以下修复仍然影响当前行为，但不再保留重复的逐轮流水账：

### Core 与 SSE

- `[DONE]` 前 finalize tool calls。
- SSE 支持多行 data、跨 chunk、半个 UTF-8 字符和超长单行。
- reader 生命周期使用 try/finally 释放。
- Bun abort error 兼容。
- API 计数在 done 事件更新，避免 usage 重复计数。
- 计费排除 cache token 双重计费。

### Session 与上下文

- JSONL 损坏行跳过，恢复最近合法 messages。
- 上下文截断避免产生孤立 tool message。
- updateConfig 同步更新 contextWindow。

### 工具与安全

- grep 使用参数数组和 `--` 防选项注入。
- WebFetch 限制 http/https 并执行 SSRF 防护。
- glob、NotebookEdit、LSP、worktree 等路径处理已收紧。
- bash 不读取用户 `.bashrc`，并清理 timeout timer。
- safeStringify 截断后仍返回合法 JSON。
- TaskManager 使用 UUID，避免同毫秒 ID 碰撞。

### TUI

- assistant_final、reasoning 和工具调用历史不再因状态更新丢失。
- 同名工具和重复 index 不再覆盖历史卡片。
- 权限弹窗支持允许、始终允许和拒绝。
- 终端退出流程恢复 raw mode、鼠标和光标状态。

### Provider 与 API

- **Zen 401 修复**：tier 系统的 `recommendedModel`（`deepseek-v4-flash`）覆盖了用户为 Zen 选择的模型（如 `mimo-v2.5-free`），但 `deepseek-v4-flash` 在 Zen API 上不存在，Zen 返回 401 "Missing API key"。修复方式：`loop.ts:74` 模型覆盖只在 `provider === "deepseek"` 或未指定时生效，第三方 provider 不受影响。

### T21-R：斜杠命令补全键盘事件冲突

- `DeepiPromptInput` 使用 `forwardRef` 暴露 `writeText` 方法，供 autocomplete 回写文本。
- `suppressHistory` prop 在菜单打开时禁用 ↑↓ 历史导航，避免与 autocomplete 光标移动冲突。
- `App.tsx` 将 `ref` 和 `suppressHistory` 传递给 `DeepiPromptInput`，并在 `CommandAutocomplete` 的 `onSelect` 中通过 ref 写入文本。
- 验收：菜单打开时 ↑↓ 只改变选中项；Enter/Tab 回写命令；Esc 只关闭菜单；菜单关闭后 ↑↓ 恢复历史导航。

### T21-R2：reset 后 slash menu 恢复

- `/status`、`/context` 已重新加入 `parseSlashCommand()`、`CommandRegistry` 和 i18n 文案。
- `CommandAutocomplete` 行为恢复为：Enter 直接执行命令进入二级菜单或输出 status；Tab 只补全到输入框；Esc 关闭。
- `DeepiPromptInput` 支持外部 `history`、`injectedText` 和 `suppressSubmit`，避免 autocomplete 打开时输入框抢 Enter/Tab。
- `/skill` 二级菜单恢复为 52 个 skill 的可选择列表；Space 启用/禁用，Enter 插入 `#skill-name ` 到输入框。
- `/context` 二级菜单恢复为真实 policy 菜单；支持 `trim/compact`、trigger/target 调整、当前用量显示和 `Run now`。
- 为 context reduction 补回 `AppendOnlyLog.replaceAll()`；为 loop/plugin 恢复后遗留类型缺口补齐类型。
- 本轮验收：`bun run typecheck` 通过；`bun test packages/tui` 38/38 通过。
- 本轮完整 `bun test` 按用户要求中断，不作为本轮验收结论。

### P3-R：中途指令 TUI 路由回归

- `bridge.tsx` `full` fallback 后同步更新 `pendingInstructionCount`，修复 P3-2 断言失败。
- `P0-6` 测试更新为验证 `enqueueInstruction()` 优先路由而非旧的 `messageQueue` 路径。
- 验收：全部 12 个 bridge 测试通过（29 条 expect 调用）。

### S1：运行中切换 Session 的状态重绑定

- `loadSession()` 新增 `isSubmitting` 保护，活跃 submit 时抛异常阻止切换。
- 切换时同步更新：`this.sessionId`、`this.ctx.log.clear()`、`this.toolExecutor.setSessionId()`、`this.logger.child({ sessionId })`、`this.rebindSessionWriter()`。
- `StreamingToolExecutor` 新增 `setSessionId(id)` 方法。
- `rebindSessionWriter()` 工厂方法提取自构造函数，切换时复用。
- 验收：31 个 session 测试全通过（含 2 个 S1 专项测试）。

### S2：Session ID 边界与列表摘要正确性

- `SessionLoader.validateSessionId(id)`：拒绝空字符串、路径遍历（`../`）、控制字符、斜杠反斜杠、`.`、`..`、超长 ID。
- `SessionLoader.read()` 使用 `safePath()` 验证，防止外部 ID 越出 session 目录。
- `SessionLoader.list()` 修复：`messageCount` 改为最后快照的消息数量（非快照记录数）；排序使用最后记录时间戳（非首条记录）。
- `engine.loadSession()` 和 `engine.recover()` 在入口处验证 session ID。
- 验收：44 个 session 测试全通过（含 13 个 S2 专项测试）。

### AUD-02：结果溢出持久化配额闭环

- 新增 `sessionByteUsage` 内存 Map 跟踪每个 session 的已用字节数。
- `maybePersistResult()` 在写入前检查 `used + contentBytes > quota`，超额时返回 preview + warning 不写入。
- 新增 `cleanupOldFiles()`：目录文件超过 `maxFilesPerSession`（默认 200）时删除最旧的文件。
- `engine.ts` 接通 `ResultPersistenceConfig` 到 `StreamingToolExecutor` 构造函数。
- 导出 `resetSessionByteUsage()` 和 `getSessionByteUsage()` 用于测试。
- 验收：15 个 persistence 测试全通过（含 5 个 AUD-02 专项测试）。

### AUD-03：上下文预算 force 硬边界

- `ContextManager.buildMessages()` 新增 `truncateToBudget()` 步骤：在 round-based 截断后，再次按 token 预算机械 fallback。
- 使用 `estimateTokens()`（已 mock 为确定性 fallback）估算 prefix + log + scratch 总量。
- 超出 `contextWindow` 时，从最旧的 user 轮开始移除，直到预算满足。
- 保留 system prefix（`prefix.messages`）和 tool-call/tool-result 原子组（round 边界切割）。
- 验收：36 个 context 测试全通过（含 5 个 AUD-03 专项测试）。

### AUD-05：编辑 fallback 歧义保护

- `edit.ts` 在 hash-anchored 替换前执行 `firstIdx !== lastIdx` 唯一性校验。
- 多次出现 `old_string` 时返回 `"appears multiple times"` 错误，要求提供更多上下文。
- `fuzzy-edit.ts` 已在 Pass 1 拒绝歧义（≥2 精确匹配返回 null），无需变动。
- 测试 `hashAnchoredReplaceOnce should replace first occurrence` 改为 `should reject ambiguous old_string with multiple occurrences`。
- 新增 `countOccurrences()` 工具函数。
- 验收：29 个 edit 测试 + 4 个 integration 测试全通过。typecheck 通过。

### AUD-07：Hook 失败日志接线

- `engine.ts` 调用 `hookManager.setErrorObserver()` 注册 logger 回调。
- 记录 `phase`（before / after / loop_event）和错误详情，不记录敏感参数。
- before 失败返回 "deny"（fail-safe），after/loop 失败不阻断主流程（已有行为）。
- 验收：20 个 security hooks 测试全通过。

### AUD-08：`repair.ts storm()` 安全性

- `storm()` 改为使用 `matchAll` 匹配所有 KV 对，而非 `match` 只取第一个。
- 单 KV 时 `partial = false`（可证明安全）；多 KV 时 `partial = true`。
- `repairToolArguments()` 对 storm 多 KV 结果标记 `partial`。
- `streaming-executor.ts` 检测 `repaired.partial` 时拒绝执行并报错。
- 新增 3 个 AUD-08 专项测试。
- 验收：23 个 repair 测试全通过。

### AS2 emergency fix：state.lastSwitchTime 紧急触发

- `engine.ts` interrupt() 和 emergency paths 中设置 `state.lastSwitchTime`。
- 修复 emergency 场景中 `lastSwitchTime` 保持 0 导致时间计算错误的问题。

### P5.5：工具进度流

- `interface.ts` 新增 `ToolProgressUpdate` 类型，`ToolContext.reportProgress` 回调。
- `streaming-executor.ts` 维护 progress buffer，在 `executeToolCall` 末尾 flush。
- `shell-exec.ts` 数据处理器调用 `reportProgress` 报告实时 stdout/stderr。
- `loop.ts` 产出 `tool_progress` 事件，仅转发不持久化。
- `bridge.tsx` 显示工具进度中间内容。
- 验收：24/24 executor 测试通过。

### S2：Session 验证 + list() 修复

- `session.ts` 新增 `validateSessionId()` 和 `safePath()` 函数。
- `list()` 修复消息计数和排序（按 ts 降序）。
- `engine.ts` loadSession/recover 增加验证。

### S1：Session 切换全重建

- `streaming-executor.ts` 新增 `setSessionId()` 方法。
- `engine.ts` switchAgent/setSessionId 触发 rebindSessionWriter + logger.child。
- `isSubmitting` guard 防止切换冲突。

### P3-R：Bridge 测试修复

- P0-6 更新为 `enqueueInstruction` 路径。
- P3-2 修复：full 回退加 `pendingInstructionCount`。
- 验收：12/12 bridge 测试通过。

### T21-R：Autocomplete 键盘冲突

- `DeepiPromptInput` forwardRef + suppressHistory 属性。
- `App.tsx` + `CommandAutocomplete` 通过 ref 控制。

### ST2：StrategyTier 引擎集成

- `engine.ts` 新增 `currentTier` 字段、`resolveTierDecision()` / `setTier()` / `getTier()`。
- `loop.ts` 根据 tier 覆盖 `maxChainLength`、`enableReasoning`、`model`、`temperature`。
- `submit` 时 budget 超标给出警告。
- `interface.ts` `CoreEngine` 新增 `getTier?` / `setTier?`。
- 验收：15 个 strategy tier 测试全通过。

### ST3：策略事件 + TUI

- `engine.ts submit()` 首事件产出 `strategy_notify`。
- `loop.ts` 工具批处理后产出 `strategy_estimate_refined`。
- `bridge.tsx` 消费两个事件（目前空 break）。
- `StatusBar.tsx` 可选 `tier` 属性，`App.tsx` 从 engine 取值传入。
- 验收：typecheck 通过，基线 729/729 无回归。

### ST4：动态 Tier 推荐器

- 新增 `strategy/recommender.ts`：`recommendTier()` 函数，分析 cost/turn/context 模式。
- 规则：budget 超标降级、最大轮数近 + 高上下文升级、多工具 + 余量升级、持续低消耗降级。
- `loop.ts` 在工具批处理后调用 `recommendTier`，非 stay 时产出 `tier_recommendation` 事件。
- `interface.ts` `LoopEventRole` 新增 `tier_recommendation`。
- `bridge.tsx` 消费事件（空 break）。
- 验收：7 个 recommender 测试 + 基线 736/736 无回归。

### CL-10：MCP 生命周期闭环

- 提取 `rejectAllPending()` 辅助函数，消除 `pending` 遍历 + clear 重复代码。
- `request()` 发送前检查 `proc`、`stdin`、`stdin.writable`，不可写时立即 reject。
- `stdin.write()` callback 处理写入错误，失败时清除 timer + 立即 reject。
- `disconnect()` 即使 `!_connected`，只要 `proc` 存在也执行清理。
- `initialize` 失败（超时/非法响应）时清理 pending、重置 `proc` 和 `_connected`。
- stderr 在 debug 日志级别记录（200 字符截断）。
- Malformed JSON 行在 debug 日志记录 server 名称 + 行长度。
- 验收：22 个 MCP 测试全通过。基线 742/742 无回归。

### CL-11：Session stats 兼容读取

- `SessionLoader.list()` 读取 `promptTokens/completionTokens`（新格式），
  `inputTokens/outputTokens`（旧格式）作为 fallback。
- 新格式同时存在时优先使用新格式。
- 不迁移、不重写已有 JSONL。
- 验收：5 个 CL-11 专项测试 + 基线 747/747 无回归。

### CL-12：Hash edit 采样读取 + 流关闭

- 二进制检测使用 `fs.promises.open` + `fd.read(0, 8192)` 代替 `readFile(filePath)`
  （大文件不再整文件读取）。
- `writer.end()` 在未命中路径上改为 `await new Promise(writer.end)`，
  确保临时文件完全刷新后才进入 finally 清理。
- 验收：5 个 CL-12 专项测试 + 33 个 edit 回归测试 + 基线 752/752 无回归。

### CL-20：共享工具进度流

- `flushSharedBatch()` 中每个共享工具收集 progress buffer，工具全部完成后 flush。
- progress buffer 在结果事件之前统一 yield。
- 验收：2 个 CL-20 专项测试 + 24 个 executor 回归测试通过。

### CL-21：Bash 有界输出

- stdout/stderr 使用有界环形缓冲区：超过 `maxChars * 2` 时丢弃早期数据，
  最终输出标注 droppped 计数。
- `createProgressThrottle()` 对 `reportProgress` 限频（200ms 时间窗口内去重）。
- `AbortSignal` listener 在 close/error/timeout 路径解除注册。
- Spawn error 使用 `reject`（不混淆为非零退出码）。
- 验收：5 个 CL-21 专项测试 + 14 个 bash 回归测试 + 基线 759/759 无回归。

### CL-30：Context budget 完整定义

- `prefix` 单独超过 `window`：抛异常 `prefix alone exceeds window`。
- `scratch` 单独超过 `window`：抛异常 `scratch alone exceeds window`。
- `truncateToBudget` 处理无 user messages 的极端情况（仅 assistant+tool 循环），
  避免无限循环。
- `getBudget()` 方法返回 `{ prefixTokens, logTokens, scratchTokens, totalTokens, window }`。
- 最后一个超出警告由 loop 层处理 fold signal，不抛异常。
- 验收：新增 5 个 CL-30 边界测试 + 基线 759/759 无回归。

### CL-31：Result persistence 磁盘扫描初始化

- `maybePersistResult` 首次 overflow 时扫描 `.deepreef/results/<sessionId>/` 初始化用量。
- 每个 session 只扫描一次（`sessionInitialized` 集合）。
- 未超过 threshold 的小结果不触发扫描。
- `cleanupOldFiles` 删除文件后同步减去内存计数（`subtractByteUsage`）。
- cleanup 失败走 `logger.warn` 通路。
- 验收：新增 4 个 CL-31 测试 + 基线 763/763 无回归。

### CL-32：Session writer observability

- `AsyncSessionWriter` 构造函数增加 `RuntimeLogger`，默认 `noopRuntimeLogger`。
- `init()` 成功后 debug log `session.writer.ready`。
- `enqueue` 序列化失败 debug log `session.writer.serialize_error`。
- `evictIfNeeded` queue overflow debug log `session.writer.overflow`。
- `flushSoon` append 失败 debug log `session.writer.append_error`。
- 保持 append-only JSONL 模式，不要求 fsync/rename 每行。
- Loader 继续容忍末尾行损坏。
- 验收：新增 6 个 CL-32 测试 + 基线 769/769 无回归。

### CL-40：Workspace 包边界整理

- `tsconfig.json` 新增 `@deepreef/core` 和 `@deepreef/tui` 的 paths 映射。
- `@deepreef/tools` 补齐 `exports`、`types` 字段，新增 `@deepreef/core` 依赖。
- `@deepreef/mcp` 补齐 `exports` 条件导出，新增 `@deepreef/core`、`@deepreef/tools` 依赖。
- `@deepreef/cli` 新增 `@deepreef/tools`、`@deepreef/mcp`、`@deepreef/tui` 依赖。
- `@deepreef/tui` 补齐 `exports`、`types` 字段。
- `packages/tools/src/index.ts` 新增 `safeStringify`、`hasBinaryEncoding`、`clearReadTracker` 导出。
- `packages/core/src/index.ts` 新增 `ToolProgressUpdate` 类型导出。
- 38 个源文件的 `../../core/src/...`、`../../tools/src/...`、`../../mcp/src/...` 相对路径 import 全部替换为包名 import（`@deepreef/core`、`@deepreef/tools`、`@deepreef/mcp`、`@deepreef/tui`）。
- 验收：typecheck 通过 + 774/774 测试通过 + 0 跨包相对路径引用残留。

### CL-41：工具注册表收敛

- `packages/tools/src/index.ts` 新增 `createDefaultTools()` 工厂函数，返回 29 个内置工具实例。
- 构造顺序与 system prompt 工具规格排序一致。
- `packages/cli/src/tui.ts` 改用 `createDefaultTools()` 循环注册，不再逐个 import + register。
- MCP 动态工具仍单独注册（`createListMcpToolsTool`、`createCallMcpToolTool` 等）。
- 验收：typecheck 通过 + 774/774 测试通过。

### CL-42：热路径同步阻塞清理

- `packages/tools/src/grep.ts`：`spawnSync("rg"/"grep")` → `spawn` 异步，支持 `AbortSignal`、15s 超时、500KB 输出上限。
- `packages/tools/src/web-browser.ts`：`spawnSync(node, [runner])` → `spawn` 异步，支持 `AbortSignal`、可配置超时、5MB 输出上限。
- `packages/tools/src/cron.ts`：`spawnSync("crontab")` → `spawn` 异步，`getCrontab()` 和 `setCrontab()` 均支持 `AbortSignal`、5s 超时。
- 所有工具保持现有返回格式不变。
- 验收：typecheck 通过 + 774/774 测试通过。

### CL-50：StreamingToolExecutor 渐进提取

- 新增 `packages/core/src/executor-helpers.ts`，提取 4 个纯函数：
  - `evaluatePermission()`：权限决策逻辑（allow/deny/ask）
  - `createSettleLedger()`：工具调用结算账本（settled set + settle closure）
  - `createProgressQueue()`：有界进度缓冲队列（push/flush/length）
  - `applyResultPersistence()`：结果溢出持久化适配器
- `streaming-executor.ts` 改为调用上述 helper，内部逻辑不变。
- 验收：typecheck 通过 + 774/774 测试通过。

### CL-51：runLoop() 渐进提取

- 新增 `packages/core/src/loop-helpers.ts`，提取 4 个纯函数：
  - `normalizeToolCallId()` + `resetToolCallSeq()`：工具调用 ID 规范化
  - `createDuplicateDetector()`：重复工具调用检测器（3+ 次相同 tool+args 告警）
  - `evaluateModeSwitchForTurn()`：思维模式切换信号构造与评估
  - `injectPendingInstruction()`：待注入指令安全点 helper
- `loop.ts` 改为调用上述 helper，主控制流不变。
- 验收：typecheck 通过 + 774/774 测试通过。

### CL-52：TUI command routing 收敛

- 新增 `packages/tui/src/commands.ts`，提取 slash command 纯逻辑：
  - `parseSlashCommand()`：解析 `/exit`、`/bye`、`/help`、`/model`、`/sessions`、`/skill`、`/agent`、`/thinking`、`/lang`
  - `validateThinkingMode()` + `getThinkingModes()`：思考模式校验
  - `toggleAgent()`：Build / Plan Agent 切换
  - `buildHelpText()`：帮助文本构造
  - `formatSkillList()`：Skill 列表格式化和 malformed JSON fallback
- `packages/tui/src/App.tsx` 的 `handleSubmit()` 改用上述 helper；React state、异步 Skill 加载、退出和 bridge submit 行为保持在组件内。
- 新增 `packages/tui/__tests__/commands.test.ts`，覆盖命令别名、未知输入、thinking 校验、Agent 切换、help 文本、Skill 截断和 malformed fallback。
- 验收：CL-52 专项 `6 pass / 0 fail`；typecheck 通过；全量 `780 pass / 0 fail`，共 `55` 个测试文件。

### OS-00 / OS-10：平台适配原则与能力层

- 新增 `packages/tools/src/platform/`：
  - `capabilities.ts`：集中式平台能力模型
  - `shell-backend.ts`：Bash / pwsh / powershell 探测、缓存、环境变量覆盖和诊断事件
  - `process-tree.ts`：POSIX process group 与 Windows `taskkill.exe /T` 回收入口
  - `monitor-backend.ts`：memory、process、disk 平台采样入口
  - `scheduler-backend.ts`、`notification-backend.ts`：平台 backend 选择契约
- `bash` 工具保持历史名称，内部改为平台 shell；system prompt 增加 shell backend 信息。
- `glob` 使用 `relative()` + `isAbsolute()` 做目录边界判断；Browser runner 使用 `fileURLToPath()`。
- MCP auth 的 `chmod(0600)` 在 Windows 上降级为 best-effort 文件写入。
- Monitor 首轮接入异步平台 backend：memory 使用 Node `os`，process/disk 不再使用同步 shell pipeline。
- 新增 7 个 OS-10 平台能力测试。
- 保留边界：OS-11/12/13 尚需 macOS、Windows 原生验收；Scheduler、Notification 业务工具尚未切换 backend。
- 验收：typecheck 通过；平台相关目标测试通过；全量 `787 pass / 0 fail`，共 `56` 个测试文件。

### OS-11：子进程终止收口（worktree + MCP client）

- `packages/tools/src/worktree.ts` 的 `runGit()` 改用 `terminateProcessTree()` 终止子进程，设置 `detached: platform !== "win32"`。
- `packages/mcp/src/client.ts` 的 `connect()` 和 `disconnect()` 改用 `terminateProcessTree()` 替代直接 `proc.kill("SIGTERM"/"SIGKILL")`。
- `packages/tools/src/index.ts` 新增 `terminateProcessTree` 导出供 MCP 包消费。
- 验收：typecheck 通过；MCP 22/22 测试通过；cron+worktree 19/19 测试通过。

### OS-14：Scheduler backend 集成

- `packages/tools/src/platform/scheduler-backend.ts` 大幅扩展：新增 `listJobs()`、`createJob()`、`deleteJob()` 统一入口，内部包含 crontab 和 schtasks 两条实现路径：
  - Crontab（POSIX）：保持原有 `getCrontab`/`setCrontab`/`parseCronJobs`/`removeCronJob` 逻辑。
  - Schtasks（Windows）：新增 `listSchTasksJobs()`、`createSchTaskJob()`、`deleteSchTaskJob()`，任务名前加 `DEEPREEF_TASK_PREFIX`。
  - `cronToSchTaskSchedule()`：支持 MINUTE、HOURLY、DAILY、WEEKLY、MONTHLY 子集映射；不支持表达式返回明确错误。
- `packages/tools/src/cron.ts` 完全重写为调用 `scheduler-backend.ts` 统一入口，不再直接操作 `crontab`。
- `getSchedulerBackend()` 和 `normalizePlatform()` 保持导出。
- 验收：typecheck 通过；9/9 cron 测试 + 10/10 cron-worktree 测试通过。

### OS-15：Notification backend 集成

- `packages/tools/src/push-notification.ts` 完全重写：
  - Linux 使用 `execFile("notify-send", args)`，不拼接 shell 字符串。
  - macOS 使用 `execFile("osascript", ...)`，参数经过 `osAEscape()` 转义。
  - Windows 使用 `spawn("powershell.exe", ...)` 通过 `WScript.Shell.Popup` 弹窗，无需额外依赖。
  - 所有路径失败均降级为 terminal bell（`process.stdout.write("\x07")`）。
  - 返回 `{ sent, method, fallbackReason? }` 结构化结果。
- 验收：typecheck 通过。

### OS-16：LSP client 子进程终止 + ModelPicker Windows 剪贴板

- `packages/tools/src/lsp-client.ts` 的 `runLspRequest()` 改用 `terminateProcessTree()` 替代直接 `child.kill()`：
  - `spawn()` 增加 `detached: platform !== "win32"`。
  - AbortSignal 监听器、`withTimeout` 回调和 `finally` 清理路径统一使用 `terminateProcessTree(child, true, platform)`。
- `packages/tui/src/ModelPicker.tsx` 的 `tryReadClipboard()` 新增 Windows 剪贴板读取：
  - 使用 `powershell.exe -NoProfile -NonInteractive -Command Get-Clipboard`。
  - 按 `darwin → win32 → linux` 优先级探测，各平台互斥。
  - 修复 import 路径（`'child_process'` → `'node:child_process'`）。
- Ink 包已具备丰富的 Windows terminal 兼容逻辑（`clearTerminal.ts`、`termio/osc.ts`、`terminal.ts`、`use-terminal-title.ts`、`App.tsx` 等），Deepreef TUI 无需重复实现。
- 验收：typecheck 通过；MCP 22/22、cron 19/19、bridge 12/12 测试全部通过。

### OS-11：System prompt 平台集成

- `buildSystemPrompt()` 新增 `options` 参数（`{ osPlatform?, shellBackend? }`），允许调用方传入平台信息。
- `packages/cli/src/tui.ts` 在设置 system prompt 前调用 `normalizePlatform()` + `resolveShellBackend()` 获取平台能力，传给 `buildSystemPrompt()`。
- 未传入 options 时保持向后兼容：自动使用 `process.platform` 和 `DEEPREEF_SHELL` 环境变量。
- 验收：typecheck 通过；81/81 core 测试通过。

### OS-17：三平台 CI scaffold

- 新增 `.github/workflows/ci.yml`：GitHub Actions matrix（`ubuntu-latest`、`macos-latest`、`windows-latest`）。
- 每个平台执行：typecheck、全量测试、shell backend 探测（POSIX: bash, Windows: pwsh/powershell）、进程树回收验证、glob 路径边界、atomic rename 测试、Monitor memory/cpu 检测、scheduler 和 notification backend 可用性报告。
- 耗时步骤使用 `fail-fast: false` 确保一个平台失败不影响其他平台结果。
- workflow 监听 `master` push / pull request，也支持手工 `workflow_dispatch`。
- 验收边界：本地已完成格式检查；三平台运行结果必须在推送后由 GitHub Actions 产生，不能用本地 Linux 结果代替。

### TEST-STABILITY-01：全量测试抖动收口

- WebSearch 测试：mock `fetch`（`vi.spyOn(globalThis, "fetch")`）替代真实 Google 网络调用，返回可控 HTML fixture，消除外部依赖超时。
- SSE client 测试：`afterEach` 增加 `Promise.race` 3s 超时保护，防止 `server.stop()` 挂起阻塞后续测试。
- Benchmark 测试：同上，`afterEach` 增加超时保护。
- 修改文件：
  - `packages/tools/__tests__/web-search.test.ts`
  - `packages/core/__tests__/sse-client.test.ts`
  - `packages/core/__tests__/benchmark.test.ts`
- 验收：连续 3 次 `bun test` 全绿（799 pass / 0 fail），`bun run typecheck` 通过。

### OS-17-R：三平台 CI 结果检查

- GitHub Actions Matrix 推送后三平台全部通过：
  - ✓ `ubuntu-latest` (1m4s)
  - ✓ `windows-latest` (2m8s)
  - ✓ `macos-latest` (1m22s)
- 修复的 Windows 问题：
  - PowerShell deny patterns 增加 `rm` 别名匹配
  - `result-persistence.test.ts` 路径分隔符兼容
  - `bash.test.ts` PowerShell 语法兼容（stderr、PATH、循环）
  - `security-e2e.test.ts` / `glob-read-file.test.ts` 错误消息兼容
  - `PushNotification` 改用非阻塞 `BalloonTip` 替代阻塞 `WScript.Shell.Popup`
  - MCP 测试增加 Windows 超时保护
- 修复的 macOS 问题：
  - `process-tree.test.ts` 增加 `wait || true` 防止 SIGTERM 退出码导致 `-e` 终止
- 修改文件：
  - `packages/tools/src/shell-exec.ts`
  - `packages/tools/src/push-notification.ts`
  - `packages/tools/__tests__/bash.test.ts`
  - `packages/tools/__tests__/security-e2e.test.ts`
  - `packages/tools/__tests__/glob-read-file.test.ts`
  - `packages/core/__tests__/result-persistence.test.ts`
  - `packages/core/__tests__/tools-regression.test.ts`
  - `packages/mcp/__tests__/mcp-host.test.ts`
  - `.github/workflows/ci.yml`
  - `DONE.md`
- 验收：typecheck 通过 + 799/799 测试通过 + 三平台 CI 全绿。

---

## 6. ADVICE.md 状态

`ADVICE.md` 原先用于复核 Code Clean 报告和安排阶段路线。历史可执行内容已经拆分完成：

| 原路线 | 归档状态 | 对应专项 |
|--------|----------|----------|
| Phase 0：类型检查和回归门禁 | 已建立 | 每个任务执行 `bun run typecheck`、`bun test`、`git diff --check`；三平台 scaffold 见 `OS-17` |
| Phase 1：生命周期和数据正确性 | 已完成原规划 | `CL-10`、`CL-11`、`CL-12` |
| Phase 2：Tool Progress 和 Bash 有界输出 | 已完成 | `P5.5`、`CL-20`、`CL-21` |
| Phase 3：上下文和持久化边界 | 已完成 | `CL-30`、`CL-31`、`CL-32` |
| Phase 4：Windows 与 macOS 代码适配 | 代码层已完成 | `OS-00`、`OS-10`、`OS-11`、`OS-12`、`OS-13`、`OS-14`、`OS-15`、`OS-16`、`OS-17` |
| Phase 5：渐进式边界清理 | 已完成 | `CL-40`、`CL-41`、`CL-42` |
| Phase 6：受测试保护的提取 | 已完成 | `CL-50`、`CL-51`、`CL-52` |

`TEST-STABILITY-01` 和 `OS-17-R` 已完成并记录在本文。仍未完成的原生平台人工验收见 `TODO.md`。

2026-06-04 后，`ADVICE.md` 只保留仍需交接执行的专项。当前剩余 Context 的 `CTX-70` 文档/人工验收和 FG best-effort 日志收尾。

### 6.1 LSP 专项进度

| 阶段 | 状态 | 说明 |
|------|------|------|
| LSP-10：配置、语言识别、返回格式 | ✅ 已完成 | config.ts、language.ts、normalize.ts、lsp.ts 升级 |
| LSP-20：协议层和长驻 Client | ✅ 已完成 | vscode-jsonrpc 协议层、LspClient 类、11 个测试 |
| LSP-30：Manager 和文档同步 | ✅ 已完成 | LspManager 类、文档同步、12 个测试 |
| LSP-40：完整动作集 | ✅ 已完成 | 14 个 actions + 5 个别名、28 个测试 |
| LSP-50：真实语言服务器 smoke | ✅ 已完成 | TypeScript/Python/Go/Rust smoke tests、14 个测试 |
| LSP-60：工具链集成和可观测性 | ✅ 已完成 | LspLogger、9 种事件、12 个测试、@deepreef/core 导出 RuntimeLogger |

### 6.2 仍然有效的设计决策

- 保持 `ImmutablePrefix + AppendOnlyLog + VolatileScratch` 三区域上下文布局。
- 保持 `ReasonixEngine.submit()` 和 `runLoop()` 的 `AsyncGenerator<LoopEvent>` 外部语义。
- 保持工具调用结果 exactly-once：一个 `tool_call_id` 最多写入一个 `tool` result。
- 保持 Session JSONL append-only、best-effort 和损坏尾行恢复。
- 保持运行时诊断日志默认关闭，关闭时不在热路径增加明显成本。
- 保持工具名 `bash` 作为兼容名称，内部选择当前平台 shell backend。
- 保持平台判断集中在 `packages/tools/src/platform/`，不要散落平台分支。
- 保持 MCP 动态工具与内置静态工具分开注册，不把动态 schema 混入 prefix。

---

## 7. Plugin 系统

| 阶段 | 状态 | 说明 |
|------|------|------|
| PLG-10：配置与 spec 解析 | ✅ 已完成 | packages/plugin、config.ts、loader.ts、18 个测试 |
| PLG-20：loader 与 v1 server plugin shape | ✅ 已完成 | server() 调用、hooks 验证、21 个测试 |
| PLG-30：tool adapter | ✅ 已完成 | tool-adapter.ts、schema 转换、9 个测试 |
| PLG-40：hook adapter | ✅ 已完成 | hook-adapter.ts、PluginHookRegistry、10 个测试 |
| PLG-50：CLI 集成和生命周期 | ✅ 已完成 | runtime.ts、PluginRuntime、7 个测试 |
| PLG-60：文档和验收 | ✅ 已完成 | README、examples、历史验收记录 |

---

## 8. Status 卡片

| 阶段 | 状态 | 说明 |
|------|------|------|
| STAT-10：Core 状态快照 | ✅ 已完成 | EngineStatusSnapshot、getStatusSnapshot()、8 个测试 |
| STAT-20：Slash command 接入 | ✅ 已完成 | /status 命令、format.ts、6 个测试 |
| STAT-30：Codex 风格格式化 | ✅ 已完成 | format.ts 增强、Unicode/ASCII、16 个测试 |
| STAT-40：文档和验收 | ✅ 已完成 | README、历史验收记录、G0-04 |

---

## 9. Context 菜单

| 阶段 | 状态 | 说明 |
|------|------|------|
| CTX-UI：TUI `/context` 菜单 | ✅ 已完成 | `ContextModal.tsx` 居中菜单，支持 strategy、triggerRatio、targetRatio、当前用量和 `Run now` |

保留限制：

- `/context` 的代码链路已完成；完整长会话人工验收仍按 `ADVICE.md` 的 `CTX-70` 执行。
- 本轮完整 `bun test` 未作为最新结论记录，因用户要求中断。

---

## 10. Subagent 系统（AGENT-90 P0）

| 阶段 | 状态 | 说明 |
|------|------|------|
| AGENT-90 | ✅ 已完成 | Plan/Build 主状态 + 临时 Subagent 第一阶段 |

**实现边界：**

### 10.1 MainMode 主状态

- 新增 `packages/core/src/main-mode.ts`：`MainMode` 类型（`"plan" | "build"`），`MainModeDefinition` 接口包含 `name / label / systemPrompt / toolNames / permissionProfile`。
- `agent.ts` 收敛为主状态定义，`AGENTS` 与 `MAIN_MODES` 同步，保持 `getAgent()` / `agentConfigFor()` 兼容。
- `Plan` 的 `permissionProfile: "readonly"`，`toolNames` 仅包含读取工具；`Build` 的 `permissionProfile: "build"`，包含完整工具集。
- 主状态通过 `switchAgent()` 切换，Plan 写/exec 工具在 permission 层 fail-closed。

### 10.2 Subagent 系统

- 新增 `packages/core/src/subagent/`，包含 5 个模块：

| 模块 | 职责 |
|------|------|
| `types.ts` | `SubagentDefinition`、`SubagentRun`、`SubagentRunOptions`、`SubagentRunResult` 等类型 |
| `definition.ts` | 三个内置子代理：`general-purpose` / `Explore` / `Plan` |
| `registry.ts` | `SubagentRegistry`：注册、解析、工具过滤 |
| `permission.ts` | 四级权限：`readonly` / `denyExec` / `acceptEdits` / `bubble` |
| `run.ts` | `SubagentRunner`：基于子定义创建 child engine 并执行 |

- 所有内置子代理 `disallowedTools` 包含 `AgentTool`，防止嵌套调用。

### 10.3 AgentTool 重构

- AgentTool 支持新参数：`description`、`prompt`、`subagent_type`（`Explore` / `Plan` / `general-purpose`）。
- 兼容旧参数：`task` → `prompt`，`agent_type` → `subagent_type`。
- 优先使用 `ctx.spawnSubagent()` 新路径，回退 `ctx.delegateTask()` 旧路径。
- 返回结构化 JSON：`{ status, id, subagent_type, description, result, files, usage, warnings }`。

### 10.4 engine.spawnSubagent()

- `engine.spawnSubagent(options)` 创建子 `ReasonixEngine`，共享 API client。
- 注册父级工具（排除 `AgentTool`），按子代理定义过滤 `toolNames` / `disallowedTools`。
- 按 `permissionMode` 在 permission 层添加 deny rule（fail-closed）。
- 注入子代理 `systemPrompt`，使用独立 `agentConfig` 运行。
- 结构化返回结果，子引擎在 `finally` 中始终 shutdown。

### 10.5 测试覆盖

- 3 个新增测试文件：
  - `packages/core/__tests__/subagent-registry.test.ts`（9 个测试）
  - `packages/core/__tests__/subagent-permission.test.ts`（16 个测试）
  - `packages/core/__tests__/subagent-run.test.ts`（9 个测试）
- 更新 `agent.test.ts` 增加 `getMainMode` 测试。
- 更新 `workflow-agent-send-lsp.test.ts` 增加新参数测试 + `spawnSubagent` 测试。
- 所有测试通过，typecheck 通过。

**验收命令：**

```bash
bun test packages/core/__tests__/agent.test.ts
bun test packages/core/__tests__/subagent-registry.test.ts
bun test packages/core/__tests__/subagent-permission.test.ts
bun test packages/core/__tests__/subagent-run.test.ts
bun test packages/tools/__tests__/workflow-agent-send-lsp.test.ts
bun run typecheck
```

**保留限制：**

- Fork 子代理（上下文继承）为第二阶段，未实现。
- `run_in_background` 为第三阶段，未实现。
- `/agent` 命令别名 `/mode` 和 Plan→Build 切换确认尚未更新文案。

---

## 11. Kilo/LLM7 Free Auto 匿名免费 Provider

| 阶段 | 状态 | 说明 |
|------|------|------|
| 免费 Provider 支持 | ✅ 已完成 | Kilo (Free)、NVIDIA NIM (Free)、Free Auto 路由 |

### 11.1 新 Provider 注册

- `packages/core/src/config.ts`：新增 4 个 provider：
  - **kilo**：`api.kilo.ai`，2 个免费模型（Nemotron-3 Super 120B / Laguna XS 2），`keyless: true`
  - **free-auto**：`virtual: true`，`baseUrl: ""`，无实际 API，由内部路由处理
  - **openai-compatible**：通用本地 Provider（vLLM/Ollama/llama.cpp），`keyless: true`，自定义 URL 和模型
  - **nvidia**：`integrate.api.nvidia.com/v1`，6 个模型（Nemotron-3 Super 120B / Nano 30B / Nano Omni / Llama 70B / Llama 49B / Ultra 253B），`requiresKey: true`
- `ProviderInfo` 新增 `keyless?: boolean` 和 `virtual?: boolean` 字段。
- `loadConfig()` 对 `keyless` provider 跳过 API Key 加载；对 `virtual` provider 不设 baseUrl。
- `ModelPicker.tsx`：新增 `kilo`、`free-auto`、`openai-compatible`、`nvidia` 到提供商选择列表；`keyless` provider 跳过 Key 输入步骤。
- 新增配置测试（Kilo / Free Auto / OpenAI Compatible / NVIDIA）。

### 11.2 Free Auto 智能路由（`packages/core/src/free-auto/`）

| 文件 | 定位 |
|------|------|
| `catalog.ts` | 候选列表：LLM7 Codestral (priority 1)、LLM7 Qwen3 235B (priority 2)、LLM7 Mistral (priority 3)、Kilo Nemotron (priority 10) |
| `router.ts` | 429 惩罚衰减、cooldown 管理、retryable 错误分类、task 分类策略 |
| `client.ts` | `FreeAutoClient` 实现 `ChatClient` 接口，串行 failover 路由 |

**路由逻辑：**
- **Sticky**：同一 submit 内持续使用同一候选；跨 submit 保持 5 分钟（避免每次轮询），失败后自动 cooldown 切换。
- **Task 分类**：coding（有 tools）→ 优先 Codestral；complex（>4K 或 >10 轮）→ 优先 Qwen3；simple → 最小惩罚候选。
- **Failover**：串行尝试候选队列，429/provider 级短 cooldown（60s）、402/401/403 模型级长 cooldown（24h）、5xx/timeout 指数退避。
- **Penalty**：429 每次 +3，cap 10，120s 衰减 1；success 每次 -1。
- 通过 `status` 类型 LoopEvent 向 TUI 上报 route 状态（provider/model/reason/attempt）。

### 11.3 ChatClient 接口抽象

- `packages/core/src/interface.ts`：新增 `ChatClient` 接口，定义 `chatCompletionsStream()` 方法。
- `DeepSeekClient` 和 `FreeAutoClient` 分别实现该接口。
- `engine.ts` 的 client 类型从 `DeepSeekClient` 改为 `ChatClient`；`resolveClient()` 根据 provider 选择实现。
- `loop.ts` 的 `LoopOptions.client` 类型从 `DeepSeekClient` 改为 `ChatClient`。
- `loop.ts` 新增 `status` 事件传递。

### 11.4 Client 层改进

| 改进 | 说明 |
|------|------|
| Keyless 支持 | `keyless` 标志跳过 Authorization header |
| Per-request timeout | 通过 `AbortController` + `combineAbortSignals` 实现 |
| SSE stall 检测 | `Promise.race` 替代旧 watchdog，timeout 抛出 Error |
| 异常 EOF 检测 | stream 结束无 `[DONE]` 且无 finish_reason 时 yield error |
| `max_tokens` vs `max_completion_tokens` | 通过 `useMaxCompletionTokens` 区分 Kilo/LLM7（用 max_tokens）和 DeepSeek（用 max_completion_tokens） |

### 11.5 TUI 适配

- `bridge.tsx`：
  - 新增 `routedModel` / `routedModelDetail` 状态，处理 `free_auto_route` 事件。
  - 新增 `effectiveThinkingMode` 状态，处理 `thinking_mode_switch` 事件。
  - 新增 `reasoningActive` 状态。
- `StatusBar.tsx`：
  - Auto 模式下显示 `auto:on` / `auto:open` / `auto:high`。
  - Agent 名称加 `TONE.warn` 高亮。
  - routedModel 优先显示自由自动路由模型。
- `WelcomeScreen.tsx`：引入 figlet ASCII 大标题。

### 11.6 WebFetch / WebSearch 工具重写

**WebFetch：**
- 从正则 HTML→text 改为 `turndown`（HTML→Markdown） + `htmlparser2`（HTML→plain text）。
- 新增 `format` 参数（`markdown` / `text` / `html`），默认 `markdown`。
- 新增 `User-Agent` header。
- 新增依赖：`turndown`、`htmlparser2`、`@types/turndown`。

**WebSearch：**
- 从 Google HTML scraping 改为 MCP 协议调用（Exa / Parallel 双 provider）。
- 新增参数：`livecrawl`、`type`。
- Provider 选择：`OPENCODE_WEBSEARCH_PROVIDER` 环境变量，或自动检测 `EXA_API_KEY` / `PARALLEL_API_KEY`。
- MCP 响应处理：支持 direct JSON 和 SSE-streamed 两种格式。
- 搜索结果解析：结构化 URL/title/snippet 提取 + fallback 文本提取。

### 11.7 测试覆盖

| 文件 | 测试数 | 说明 |
|------|--------|------|
| `free-auto-router.test.ts` | 新文件 14 个 | 429 惩罚、cooldown、health tracking、retryable 分类、task 分类 |
| `config.test.ts` | 新增 7 个 | Kilo/Free-Auto/OpenAI-Comaptible/NVIDIA 配置验证 + loadConfig keyless 行为 |

### 11.8 LLM7 删除 + 修复轮询、Kilo 模型清理

**LLM7 provider 已删除：** `llm7` 从 `SUPPORTED_PROVIDERS`、`MODEL_PRICING`、`ModelPicker` 及所有 provider 列表中移除。
NVIDIA NIM 作为替代免费 provider 加入。Free Auto 路由候选列表相应更新，不再含 LLM7 模型。

### 11.9 修复轮询、Kilo 模型清理与 LLM7 8000 字符限制

#### 问题诊断

LLM7 匿名用户有 **8000 字符总数限制**（所有 messages 的 content 长度之和）。system prompt 中嵌入了 `frontend-design` 等技能的完整文档（>5000 字符），导致第一句话就超限，所有模型返回 HTTP 400：
```json
{"detail":"Total content length of messages exceeds limit of 8000 characters for anonymous users. Get a free token at https://token.llm7.io to get access to higher limits."}
```

Kilo 的 `nemotron-3-nano-omni-reasoning:free` 本身不是有效模型 ID，返回 400 "not a valid model ID"。之前 `thinking` 参数也被怀疑，但实测 LLM7 所有模型通过 curl 均正常返回 200（streaming、tools、中文、长 max_tokens 均无误）。

#### 修复清单

| 修复 | 文件 | 说明 |
|------|------|------|
| Kilo 无效模型清理 | `config.ts:80-84` | 移除 `nemotron-3-nano-omni-reasoning:free`。Kilo free tier 确认可用模型：`nvidia/nemotron-3-super-120b-a12b:free`、`poolside/laguna-xs.2:free` |
| LLM7 精简系统提示词 | `engine.ts:325-338` | `buildActiveSkillsPrompt(brief=true)` — LLM7/Free Auto 时只保留技能名称和描述，不嵌入完整 content，节省 >5000 字符 |
| 8000 字符友好错误提示 | `loop.ts:286` | 检测响应体中包含 `"8000 characters"` + `"token.llm7"` 时，显示 actionable 的提示信息并引导用户申请 token |
| 错误元数据增强 | `loop.ts:286`、`client.ts:172-177` | `streamError.metadata.responseBody` 附带原始错误详情；`api.request.http_error` 日志中记录请求体前 5000 字符和响应体前 2000 字符 |
| Free Auto 跨 submit sticky | `free-auto/client.ts` + `engine.ts` | 移除 `engine.ts` 中每次 submit 调用的 `resetSticky()`，改为 5 分钟时间过期；成功候选持续复用 |
| 非 DeepSeek 提供商移除 thinking 参数 | `loop.ts:122` | `supportsThinking` 仅对 `deepseek/zen/mimo` 为 true |

**验收命令：**
```bash
bun run typecheck
bun test packages/core/__tests__/config.test.ts
```

### 11.10 openai-compatible：通用本地 Provider 支持

用户可以使用 TUI Model Picker、环境变量或 `last-config.json` 连接任意 OpenAI 兼容的本地推理服务。

**支持范围：** vLLM、Ollama、llama.cpp、LM Studio、LocalAI、Text Generation Web UI 等。

**使用方式：**
- **TUI**：`/model` → 选中 `OpenAI Compatible (Local)` → 输入 Base URL（默认 `http://localhost:8000/v1`）→ Enter → 输入模型名 → Enter 确认
- **环境变量**：`OPENAI_COMPATIBLE_BASE_URL`、`OPENAI_COMPATIBLE_MODEL`
- **`last-config.json`**：`baseUrl` 和 `model` 字段自动持久化

**关键特性：**
- `keyless: true`：跳过 API Key 步骤
- `models: []`：不限制模型名，用户自由输入
- `loadConfig()` 中跳过 `normalizeModelForProvider`，保留用户输入的原样模型名
- `loop.ts`：标记为 `isKeyless` 和 `useMaxTokens`，不发送 `Authorization` 头，使用 `max_tokens`（非 `max_completion_tokens`）
- 成本计算返回 0（`MODEL_PRICING` 无匹配项 → `calculateCost()` 返回 0）

**环境变量命名规范：** 包含连字符的 provider ID（如 `openai-compatible`）在 env var 中自动转换为下划线：`OPENAI_COMPATIBLE_*`。

**验收：** `bun run typecheck` 通过；27 个 config 测试全部通过（含 2 个 `openai-compatible` 专项测试）。

---

## 12. Zod 4 集成：插件工具 Schema 声明与验证

### 12.1 目标

插件作者可以使用 Zod 4 schema 声明工具参数，Deepreef 自动生成 JSON Schema 发给 LLM，并在执行前验证模型返回的参数。

### 12.2 新增文件

| 文件 | 定位 |
|------|------|
| `packages/plugin/src/define-tool.ts` | `definePluginTool()` helper — 接受 `{ description, inputSchema, execute }`，返回带 `deepreefTool` 元数据的函数 |
| `packages/plugin/src/schema-adapter.ts` | `StandardSchemaLike` 最小契约类型、`convertSchemaToJsonSpec()`、`validateSchemaArgs()` |
| `packages/plugin/src/schemas.ts` | `PluginSpecSchema` / `PluginConfigSchema`（Zod schema 定义） |
| `packages/mcp/src/schemas.ts` | `McpConfigSchema` / `McpAuthStoreSchema` / `McpAuthEntrySchema` |
| `packages/core/src/schemas/json.ts` | `parseJsonConfig()` — 泛型 JSON 文件加载+验证 helper |
| `packages/core/src/schemas/config.ts` | `LastConfigSchema` — last-config.json 验证 |
| `packages/tui/src/settings-schema.ts` | `TuiSettingsSchema` / `LangConfigSchema` |
| `packages/plugin/__tests__/zod-tool.test.ts` | 23 个 Zod 集成测试 |

### 12.3 关键架构决策

**Standard Schema 优先**：`schema-adapter.ts` 使用 Standard Schema V1 形状（`~standard.validate`）作为运行时契约，而非硬编码 `ZodType`。Zod 4 原生支持，未来其他库也可通过同一接口接入。

**JSON Schema 生成**：
- 优先调用 `schema["~standard"].jsonSchema.input({ target: "draft-07" })`
- 回退使用 `z.toJSONSchema(schema, { io: "input", target: "draft-07", unrepresentable: "any" })`
- 删除全部私有 `_def` 访问（`zodType()`、`zodEnumValues()`、`zodShape()`、`zodInnerType()`、`convertZodToJsonSchema()`）

**执行前验证**：`executePluginTool` → schema-aware tool 的 execute wrapper 调用 `validateSchemaArgs()`，失败时返回结构化错误（`invalid_schema` + `issues`），不调用插件业务函数。

### 12.4 配置验证迁移

| 配置边界 | Schema | 策略 |
|----------|--------|------|
| `plugins.json` | `PluginConfigSchema` | 定义了 schema，未替换现有解析器（保留原容错行为） |
| `mcp.json` | `McpConfigSchema` | loadConfig 中接入验证，失败时降级使用 raw parsed |
| `mcp-auth.json` | `McpAuthStoreSchema` | readAuthStore 中接入验证 |
| `last-config.json` | `LastConfigSchema` | loadLastConfig 中接入验证 |
| `ui-settings.json` | `TuiSettingsSchema` | loadTuiSettings 中接入验证 |
| `lang.json` | `LangConfigSchema` | loadLang 中接入验证 |

### 12.5 向后兼容策略

- 普通函数插件无需修改即可继续工作
- `PluginHooks` 仍为 `Record<string, Function>`，loader 无需修改
- `definePluginTool()` 返回可调用函数，通过 `deepreefTool` 属性携带元数据

### 12.6 依赖分布

- `packages/plugin/package.json`：`zod: "4.4.3"`
- `packages/core/package.json`：`zod: "4.4.3"`
- `packages/mcp/package.json`：`zod: "4.4.3"`
- `packages/tui/package.json`：`zod: "4.4.3"`

### 12.7 验收

```bash
bun run typecheck          # 通过
bun test packages/plugin/  # 64 pass, 0 fail
bun test                   # 1134 pass, 5 pre-existing fail (mode-selector + bridge, 与本次无关)
```

---

## 13. 文档维护规则

1. `DONE.md` 只记录已存在且仍然成立的能力。
2. 未完成事项移入 `TODO.md`，不要在 DONE 中维护第二套待办列表。
3. 每次更新基线必须实际运行 `bun run typecheck` 和 `bun test`。
4. 已驳回方案和低风险暂缓项写入 `TODO.md` 对应章节。
5. 不再追加重复的"第 N 轮修复"流水账；后续按专项编号记录结果。

---

## 14. ECC Manifest Content Pack 审查修复（2026-06-08）

依据 `docs/ecc-manifest-content-pack-review-fixes.md` 审查文档完成全部 P0 和关键 P1 修复。

### 14.1 整体状态：代码就绪，端到端接入待完成

代码架构层面的修复（类型系统、解析器、安全策略、接线管道）已全部完成并通过单元测试验证，
**但缺少最后一步生产接线**：`PluginRuntime.init()` 从 `.deepreef/plugins.json` 读取配置，
当前未创建该文件，CLI 启动时不会实际加载 ECC 内容包。

**Resolver 和管线逻辑已验证可正确运行**（185 个测试全部通过，含 ECC smoke 验证），
但缺少"用真实配置启动 CLI → Skill 搜索 → Agent 注册 → Rules 注入 → Hooks 注册"的完整端到端验收。

### 14.2 实现概览

| 编号 | 优先级 | 内容 | 状态 |
|------|--------|------|------|
| P0-1 | P0 | Profile/Module/Component 类型定义和解析 | ✅ 已完成 |
| P0-2 | P0 | 禁用默认目录发现绕过选择性安装 | ✅ 已完成 |
| P0-3 | P0 | 路径边界安全（`path-security.ts`） | ✅ 已完成 |
| P0-4 | P0 | MCP Manifest 解析与安全选项 | ✅ 已完成 |
| P0-5 | P0 | Hooks 接入与默认安全（`ecc-hook-adapter.ts`） | ✅ 已完成 |
| P1-6 | P1 | Rules mode（off/system/skill）+ 来源标注 | ✅ 已完成 |
| P1-7 | P1 | Commands 转 Skills 接线 | ✅ 已完成 |
| P1-8 | P1 | Skills 来源/命名空间冲突解决 | ✅ 已完成 |
| P1-9 | P1 | TUI 状态展示（内容包/资产/诊断） | ✅ 已完成 |

### 14.3 关键代码变更

**修改文件：**

| 文件 | 变更 |
|------|------|
| `packages/plugin/src/content-pack/types.ts` | `InstallProfiles` 从数组改为对象映射；`InstallModule.paths` 从 `Record` 改为 `string[]`；新增 `family` 字段；`ResolvedContentPack` 新增 `options` 字段 |
| `packages/plugin/src/content-pack/index.ts` | 导出更新 |
| `packages/plugin/src/content-pack/parser.ts` | 移除无条件默认目录发现；修复 `mcpServers` 解析（支持字符串路径、数组、内联对象） |
| `packages/plugin/src/content-pack/resolver.ts` | 全面重写：ECC 模式 vs 标准模式分离；profile 对象映射查找；module kind 分类资产解析；targetMode 严格/兼容/忽略实现；未知 profile/module 诊断 |
| `packages/plugin/src/content-pack/rules-compiler.ts` | 稳定路径排序；来源标注 header |
| `packages/plugin/src/runtime.ts` | MCP 安全选项全面实施（enabled/allowStdio/allowHttp/allowNpx/allowPlaceholderEnv/servers 白名单）；Rules mode 处理；Command skills 接线；ECC hooks 注册 |
| `packages/plugin/src/index.ts` | 导出更新 |
| `packages/cli/src/tui.ts` | 传入 `hookManager` 到 `PluginRuntime`；Command skills 加载；状态信息传递 |
| `packages/tui/src/App.tsx` | AppProps 扩展（contentPackCount/assetCounts/diagnosticCounts） |
| `packages/tui/src/WelcomeScreen.tsx` | WelcomeScreenProps 扩展；组件状态面板新增内容包、代理、规则、MCP、诊断显示 |
| `packages/tools/src/skill-loader.ts` | `loadSkillsDirs()` 支持可选 `source` 参数 |
| `packages/tools/src/skills/index.ts` | 命名空间冲突解决：外部重名 skill 使用 `<pluginId>:<name>` |

**新增文件：**

| 文件 | 定位 |
|------|------|
| `packages/plugin/src/content-pack/path-security.ts` | `validateAssetPath()` 统一路径边界安全 |
| `packages/plugin/src/content-pack/ecc-hook-adapter.ts` | ECC command hooks → HookManager 桥接适配器 |

**新增测试文件：**

| 文件 | 测试数 |
|------|--------|
| `packages/plugin/__tests__/ecc-content-pack.test.ts` | 8 |
| `packages/plugin/__tests__/content-pack-resolver.test.ts` | 8 |
| `packages/plugin/__tests__/content-pack-path-security.test.ts` | 5 |
| `packages/plugin/__tests__/content-pack-mcp.test.ts` | 3 |
| `packages/plugin/__tests__/content-pack-hooks.test.ts` | 3 |
| `packages/plugin/__tests__/content-pack-rules.test.ts` | 3 |
| `packages/plugin/__tests__/content-pack-commands.test.ts` | 3 |
| `packages/plugin/__tests__/content-pack-discovery.test.ts` | 4 |
| `packages/plugin/__tests__/content-pack-runtime-integration.test.ts` | 8 |

### 14.4 真实 ECC Smoke Test 结果

```text
minimal:   modules=5,  agents=64, skills=21,  rules=1,  commands=0, hooks=0, mcp=0
developer: modules=9,  agents=64, skills=78,  rules=1,  commands=0, hooks=1, mcp=0
full:      modules=23, agents=64, skills=196, rules=1,  commands=0, hooks=1, mcp=0
```

**验证结果：**
- `minimal < developer < full` module 数量递增 ✅
- Profile 间资产数量确实不同 ✅
- minimal 仅加载 5 个 module 对应资产，未被默认目录发现绕过 ✅
- hooks 默认关闭 ✅
- MCP 默认关闭 ✅

### 14.5 验收

```bash
bun run typecheck    # packages/memory 因缺 Zod 依赖存在预置错误，其余包通过
bun test             # 185 pass, 0 fail
```

**覆盖范围：**
- 真实 ECC profiles/modules/components 正确解析 ✅
- selective install 不再被默认目录发现绕过 ✅
- Skills、Agents、Rules、Commands、Hooks、MCP 按选项正确消费 ✅
- Hooks 和 MCP 默认安全关闭 ✅
- 路径边界对所有资产类型有效 ✅（含 ../ traversal 和 symlink escape）
- TUI/status 展示 content pack 状态和诊断 ✅
- Command skills 通过 preloaded Skills 接线 ✅
- Hook allowCommandHooks 检查 ✅
- Hook allowlist 必须显式配置（默认拒绝）✅
- Hook 超时后子进程被终止 ✅
- Lifecycle hooks 不会重复执行 ✅

### 14.6 第二轮修复（验收反馈后）

| 问题 | 修复 |
|------|------|
| ECC Skills 无法使用 | `getSkillDirs()` 改为返回父目录而非单个 skill 目录 |
| Commands 转 Skills 未接线 | 添加 `preloadedSkills` 管道，`createDefaultTools` 传参 |
| Hook allowCommandHooks 未检查 | 增加 `allowCommandHooks` 显式启用检查 |
| Hook allowlist 比较错误 | 未配置 allowlist 时默认阻止所有 hooks |
| Hook 超时不杀子进程 | `child.kill('SIGTERM')` + `SIGKILL` 回退 |
| Lifecycle hooks 重复执行 | 追踪已执行 phase，每 lifecycle 只触发一次 |
| 路径安全测试被 skip | `../` traversal 测试启用；新增 symlink escape 测试 |
| DONE.md typecheck 状态不准确 | 标注 packages/memory 预置错误 |

### 14.7 待完成：端到端接入

要将 ECC 真正接入生产管线，还需：

1. 创建 `.deepreef/plugins.json`，配置 ECC content-pack 条目：
```json
[
  {
    "spec": "/vol4/Agent/ECC",
    "options": {
      "type": "content-pack",
      "profile": "developer",
      "target": "deepreef",
      "targetMode": "compatible",
      "hooks": { "enabled": false },
      "mcp": { "enabled": false }
    }
  }
]
```
2. 启动 CLI 并验证：Skill 搜索能返回 profile 内 skill（如 `tdd-workflow` 可加载）、profile 外 skill 不可加载
3. 验证最小完整管线：`minimal` / `developer` / `full` 三个 profile 全部走通
4. 确认 CLI 不会因 content-pack 加载产生致命错误

### 14.8 第三轮修复（验收反馈后）

| 问题 | 修复 |
|------|------|
| Selective install 被 `getSkillDirs()` 绕过 | `getSkillDirs()` 返回 `[]`；新增 `loadSkillDefs()` 为每个选中 skill 直接读取 SKILL.md，通过 `preloadedSkills` 接入 Skill 工具。只加载选中 module 的 skills，不再通过父目录加载全集 |
| 子资产 symlink 逃逸未阻止 | `discoverAgentFiles`/`discoverRuleFiles`/`discoverCommandFiles`/`discoverHookFiles`/`discoverPlatformAssets` 中所有 `readdirSync` 发现的文件均调用 `validateAssetPath()` |
| Hook allowlist 按 command 不按 ID | `BridgedHook` 新增 `id` 字段；`parseEccHooks` 从 manifest 的 `hook.id` 生成；allowlist 过滤改为 `h.id` |
| Lifecycle hooks 全部一起执行 | `onLoopEvent` 根据 `event.type` 分发到对应 phase；`onStartup`/`onShutdown`/`onGenerationComplete` 仅在匹配事件时触发且各只执行一次 |
| Hook 超时不终止后代进程 | `spawn` 使用 `detached: true`；超时通过 `process.kill(-pid)` 杀进程组，1000ms 后 SIGKILL 回退 |
| Skill source 未传入生产调用 | ECC skills 通过 `loadSkillDefs()` 直接构造带 `source` 的 SkillDef，不经过 `loadSkillsDirs` |

### 14.9 第四轮修复（验收反馈后）

| 问题 | 修复 |
|------|------|
| Hook ID 解析为内层 `hook.id` 而非外层 `entry.id` | `parseEccHooks` 改为读取 `entry.id`，生成正确 ID 如 `ecc:pre:bash:dispatcher` |
| 复合 matcher（`Edit\|Write` 等）等值匹配失败 | 新增 `matchToolMatcher()`，按 `\|` 拆分 matcher，匹配任一子项即触发 |
| ECC hooks dispose 后不注销 | `registerEccHooks()` 存储 adapter 引用；`dispose()` 调用 `hookManager.removeHooks()` + `clearEccHookState()` |
| 嵌套 MCP 路径未验证 | `discoverPlatformAssets` 中嵌套 `plugin.json` 的 `mcpServers` 引用增加 `validateAssetPath()` |
| Lifecycle hooks 按 `event.role` 分发 | `onLoopEvent` 改为检测 `event.role`（Deepreef 实际字段），`"done"` → `onGenerationComplete` |
| Hook 命令缺少 `CLAUDE_PLUGIN_ROOT` | `executeHookCommandSafe()` 新增 `pluginRoot` 参数，env 中设置 `CLAUDE_PLUGIN_ROOT=cp.rootDir` + `HOME` |

### 14.10 当前验证基线

```bash
bun run typecheck    # 除 packages/memory 预置错误外全部通过
bun test             # 185 pass, 0 fail
```

### 14.11 覆盖范围

- 真实 ECC profiles/modules/components 正确解析 ✅
- Selective install 有效：minimal=21, developer=78, full=196 skills ✅
- Hook ID 按 `entry.id` 正确解析（`ecc:pre:bash:dispatcher` 等） ✅
- 复合 matcher（`Edit|Write` 等）按 `|` 拆分匹配 ✅
- 子资产 symlink 逃逸全部阻止 ✅
- 嵌套 MCP 路径再次验证 ✅
- Hook 超时进程组终止 ✅
- Hook dispose 完整清理 ✅
- `CLAUDE_PLUGIN_ROOT` 已注入 hook 运行环境 ✅

### 14.12 保留限制

- **Lifecycle Hooks**：`SessionStart`/`SessionEnd` 在生产中不会触发，这是 Deepreef 引擎行为限制（`loop.ts` 只产出 `role: "done"` 事件，未发出 `startup`/`shutdown` LoopEvent），不是适配器代码缺陷。`Stop` hook（对应 `role: "done"`）可正常执行。
- ECC 端到端接入未完成（缺少 `.deepreef/plugins.json` 和完整 CLI 验收）
- `packages/memory/` 因依赖 `zod` 模块缺失存在 typecheck 错误（预置问题，非本修复引入）
- P1-10（Manifest Schema 校验）仍标记为 P1 最小集

---

## 15. AgentMemory 原生集成（进行中）

### 15.1 阶段 A：上游源码落位（进行中）

| 子项 | 状态 | 说明 |
|------|------|------|
| `packages/memory/` 目录创建 | ✅ 已完成 | `package.json`、`tsconfig.json`、`src/` 骨架 |
| 64 个 function 模块复制 | ✅ 已完成 | 来自 `/vol4/Agent/agentmemory/src/functions/` |
| 12 个 state 文件复制 | ✅ 已完成 | 搜索索引、向量索引、schema 等 |
| providers / prompts / eval / health / viewer / mcp 复制 | ✅ 已完成 | 全部源自 agentmemory |
| `iii-sdk` 导入替换 | ✅ 已完成 | 全部替换为 `../runtime/index.js` |
| `MemoryRuntimeSdk` 实现 | ✅ 已完成 | 进程内 ISdk，`registerFunction()` / `trigger()` / `registerTrigger()` |
| `MemoryStore` 文件型 KV | ✅ 已完成 | `~/.deepreef/memory/state/<scope>/<key>.json` |
| `MemoryService` 完整初始化 | ✅ 已完成 | 57 个 function 注册 + 定时器管道 |
| `DeepreefMemoryBridge` | ✅ 已完成 | Session/tool 生命周期 hooks |
| `config.ts` 路径迁移 | ✅ 已完成 | `.agentmemory` → `.deepreef/memory` |
| 独立 typecheck 通过 | ✅ 已完成 | 0 个 TSC 错误 |
| LICENSE / NOTICE 文件 | ✅ 已完成 | `LICENSE.agentmemory`（Apache-2.0）、`NOTICE.md`（上游 commit `749c280`） |
| 测试文件复制 | ✅ 已完成 | 129 个 test 文件从 agentmemory 复制 |
| 独立测试通过 | ⏳ 部分（728/1186 pass） | 458 fail 依赖 iii-engine 环境，需 Phase B 适配 |

### 15.2 关键架构决策

- **进程内 `MemoryRuntimeSdk` 替代 `iii-sdk`**：`trigger()` 直接调用本地 `Map<string, FunctionHandler>`，不依赖外部 iii-engine 二进制
- **`MemoryStore` 替代 iii-KV**：文件型 JSON store，每个 key 独立文件，原子写入，保留 scope/key schema
- **`DeepreefMemoryBridge` 替代独立 MCP/REST**：通过 Deepreef 的 HookManager 监听 session/tool/loop 事件，不走 localhost HTTP
- **保留函数模块不改写**：`mem::remember`、`mem::search`、`mem::context` 等 57 个函数保持原有 handler 实现

### 15.3 保留限制

- Apache-2.0 license、NOTICE.md 和上游 commit 尚未写入
- `MemoryRuntimeSdk.trigger()` 现支持 `<A, B>` 泛型，与原始 `iii-sdk` 签名兼容
- `health/monitor.ts` 中 `sdk.on("connection_state", ...)` 已移除（MemoryRuntimeSdk 不支持事件监听）
- `@anthropic-ai/sdk`、`@anthropic-ai/claude-agent-sdk`、`@xenova/transformers` 为 optional peer deps，缺失时 fallback
- typecheck 已 0 错误通过

---

## 16. AgentMemory Phase C：Deepreef 生命周期原生接线

| 子项 | 状态 | 说明 |
|------|------|------|
| MemoryService 启动/停止 | ✅ 已完成 | `tui.ts` 中 `engine` 创建后 start，`finally` 中 stop |
| HookManager tool 后钩子 | ✅ 已完成 | `afterToolCall` → `bridge.onPostToolUse/onPostToolFailure` |
| Loop 事件钩子 | ⚠️ 已修复 | `onLoopEvent` 已从 `assistant_delta` 改为用户输入真实入口 |
| mem::context 注入 system prompt | ⚠️ 已修复 | 启动时调用 `mem::context`，内容追加后重新调用 `engine.setSystemPrompt()` |
| Session 生命周期 | ✅ 已完成 | `onSessionEnd` 已接线；`onSessionStart` 已修复接入；`onGenerationComplete` 已接入（`onLoopEvent` 检测 `role === "done"`）；`onPreToolUse` 明确不接入（DONE 已列为限制） |
| 故障隔离 | ✅ 已完成 | 所有 bridge 调用 try/catch，初始化失败不阻断启动 |
| 开关控制 | ✅ 已完成 | `DEEPREEF_MEMORY=false` 环境变量禁用 |
| hooks/ 死代码清理 | ✅ 已完成 | 独立脚本添加 `@ts-nocheck`，被 bridge 替代 |

### 16.1 接线架构

```text
tui.ts (CLI)
  ├─ new MemoryService({ autoObserve, injectContext })
  ├─ await memoryService.start()
  ├─ bridge.onSessionStart(sessionId)
  ├─ engine.hookManager.addHooks({
  │     afterToolCall → bridge.onPostToolUse / onPostToolFailure
  │     onLoopEvent   → (不再用于 prompt 观察)
  │   })
  ├─ App.onUserInput → bridge.onPromptSubmit (用户输入真实入口)
  ├─ mem::context → system prompt injection → engine.setSystemPrompt()
  └─ finally:
       ├─ bridge.onSessionEnd
       ├─ memoryService.stop()
       └─ engine.shutdown()
```

### 16.2 保留限制

- `pre_tool_use` 钩子明确不接入（bridge.onPreToolUse 已实现但未从 HookManager 调用，DONE 已将其列为限制）
- Subagent start/stop 观察尚未接入
- 关闭记忆功能后已确认不阻断引擎流程

---

## 17. AgentMemory Phase D：原生工具注册

| 子项 | 状态 | 说明 |
|------|------|------|
| `memory_recall` 工具 | ✅ 已完成 | 调用 `mem::search`，返回相关记忆 |
| `memory_save` 工具 | ✅ 已完成 | 调用 `mem::remember`，持久化内容 |
| `memory_smart_search` 工具 | ✅ 已完成 | 调用 `mem::smart-search`，混合 BM25+向量 |
| `memory_forget` 工具 | ✅ 已完成 | 调用 `mem::evict`，按 ID 删除 |
| `memory_timeline` 工具 | ✅ 已完成 | 调用 `mem::timeline`，时间线分组 |
| `memory_status` 工具 | ⚠️ 已修复 | 调用 ID 从 `mem::diagnostics` 修正为 `mem::diagnose` |
| CLI 接线 | ✅ 已完成 | `tui.ts` 中启用记忆时自动注册 7 个工具（含 memory_migrate） |
| typecheck | ✅ 已完成 | 0 错误 |
| 无回归 | ✅ 已完成 | 基线测试 965 pass / 1 fail（预置 AS2） |

### 17.1 保留限制

- 高级工具（graph、consolidation、mesh 等）未默认注册，需 `DEEPREEF_MEMORY_ADVANCED=true` 环境变量开启
- MCP、REST、Viewer、`deepreef memory *` CLI 命令尚未实现

---

## 18. AgentMemory Phase E：高级能力与数据迁移

| 子项 | 状态 | 说明 |
|------|------|------|
| `MemoryServiceConfig` 高级开关 | ⚠️ 已修复 | 构造函数现在保存并消费完整 config，不再丢弃 |
| 环境变量门控 | ✅ 已完成 | `DEEPREEF_MEMORY_ADVANCED/GRAPH/CONSOLIDATE/REFLECT/SLOTS` |
| `~/.agentmemory` 迁移 | ✅ 已完成 | `migrateFromAgentMemory()` 复制 state 目录，跳过已存在的文件 |
| `memory_migrate` 工具 | ⚠️ 已修复 | 已导出并注册到 CLI，已移除无用 store 参数 |
| typecheck | ✅ 已完成 | 0 错误 |

---

## 19. AgentMemory Phase F：稳定性验证

| 子项 | 状态 | 说明 |
|------|------|------|
| 全量测试（核心包） | ⚠️ 部分完成 | 1180 pass / 5 fail（预置 mode-selector + bridge，无新增） |
| typecheck | ✅ 已完成 | 0 错误 |
| 无 iii-engine 依赖 | ✅ 已完成 | 无 `iii-sdk`、`iii-engine` 引用 |
| 启动故障隔离 | ✅ 已验证 | Memory init 失败不阻断 CLI 启动 |
| 关闭清理 | ✅ 已完成 | `finally` 中 `memoryService.stop()` 清理所有 timer |
| 记忆开关 `DEEPREEF_MEMORY=false` | ✅ 已完成 | 禁用后不加载 `@deepreef/memory` 模块（动态 import）、不初始化 MemoryService、不注册工具、不读写数据 |

### 19.1 最终架构总结

```text
packages/memory/
  src/
    runtime/          MemoryRuntimeSdk (ISdk), MemoryStore (file KV)
    functions/        57 个 mem::* 函数（原样复制自 agentmemory）
    state/            索引、搜索、schema
    providers/        LLM provider 适配层
    bridge/           DeepreefMemoryBridge（生命周期桥梁）
    tools.ts          AgentTool 工厂（6 个记忆工具 + memory_migrate）
    migrate.ts        ~/.agentmemory 迁移
    memory-service.ts 统一入口（start/stop/trigger），完整消费 config
    hooks/            死代码（被 bridge 替代，@ts-nocheck 保留）

packages/cli/src/tui.ts  — MemoryService init + HookManager 接线 + 工具注册 + 动态 import

packages/tui/src/bridge.tsx  — createBridge 新增 onUserInput 回调

依赖关系：@deepreef/memory → @deepreef/core（AgentTool 类型）
         @deepreef/cli → @deepreef/memory（创建 + 接线）
```

### 19.2 与原始 agentmemory 的功能对照

| 能力 | agentmemory (iii-engine) | deepreef memory |
|------|------------------------|-----------------|
| 记忆存储 | iii-engine KV | `MemoryStore` 文件 KV |
| 函数注册 | `iii-sdk.registerFunction()` | `MemoryRuntimeSdk.registerFunction()` |
| 函数触发 | `iii-sdk.trigger()` | `MemoryRuntimeSdk.trigger()` |
| 生命周期 | 独立 MCP/REST 进程 | `DeepreefMemoryBridge` + `HookManager` |
| 上下文注入 | 独立 hook 脚本写 stdout | `mem::context` 注入 system prompt |
| BM25 索引 | iii-engine | `IndexPersistence` 文件持久化 |
| 向量索引 | iii-engine | `VectorIndex` 内存 + 文件持久化 |
| 工具暴露 | 53 个 MCP 工具 | 7 个原生 AgentTool（含 memory_migrate，高级工具可配） |
| AgentMemory 数据 | `~/.agentmemory` | `~/.deepreef/memory`（可迁移） |

---

## 20. AgentMemory 原生集成修复轮（2026-06-09）

依据 `docs/agentmemory-native-integration-review-fixes.md` 审查文档完成全部 P0 和关键 P1 修复，随后通过二、三轮审查修复剩余问题。

### 20.1 修复清单

**第一轮（698355f）**

| 编号 | 优先级 | 内容 | 修改文件 |
|------|--------|------|----------|
| P0-1 | P0 | memory context 注入后重新调用 `engine.setSystemPrompt()` | `tui.ts` |
| P0-2 | P0 | prompt 观察从 `assistant_delta` 改为用户输入真实入口 | `tui.ts`, `bridge.tsx`, `App.tsx` |
| P0-3 | P0 | `memory_status` 调用 ID 修正为 `mem::diagnose` | `tools.ts` |
| P1-1 | P1 | 接入 `onSessionStart()`，hook adapter 引用已保存 | `tui.ts` |
| P1-2 | P1 | `MemoryServiceConfig` 完整消费，开关实际控制函数注册和定时器 | `memory-service.ts` |
| P1-3 | P1 | 导出并注册 `memory_migrate`，移除无用 store 参数 | `migrate.ts`, `index.ts`, `tui.ts` |
| P1-4 | P1 | memory 改为动态 `import()`，`DEEPREEF_MEMORY=false` 时不加载模块 | `tui.ts` |
| P1-5 | P1 | 日志前缀从 `[agentmemory]` 改为 `[deepreef:memory]` | `logger.ts` |

**第二轮（a4be2b0）**

| 编号 | 优先级 | 内容 | 修改文件 |
|------|--------|------|----------|
| FIX-1 | 高 | CLI memory-integration 测试修正导出名和路径 | `memory-integration.test.ts` |
| FIX-2 | 高 | P0-2 队列去重：`fromQueue` 全局标志改为 per-call `isQueueResubmit` 参数 | `bridge.tsx` |
| FIX-3 | 中 | consolidation timer 增加 `advancedTools` 门控 | `memory-service.ts` |
| FIX-4 | 中 | `injectContext=false` 时跳过 `mem::context` 调用 | `tui.ts` |
| FIX-5 | 低 | DONE.md 移除 `onGenerationComplete 未接线` 过时描述 | `DONE.md` |

**第三轮（本轮）**

| 编号 | 优先级 | 内容 | 修改文件 |
|------|--------|------|----------|
| FIX-6 | 中 | ignored 输入不再写入 Memory：`onUserInput` 移到 `enqueueInstruction` 状态检查之后 | `bridge.tsx` |
| FIX-7 | 中 | CLI 测试移除 tui.ts 导入（触发 `main()`/`process.exit()`） | `memory-integration.test.ts` |
| FIX-8 | 中 | `onGenerationComplete` 竞态：追踪最后一个 hook promise，cleanup 前 await | `tui.ts` |
| FIX-9 | 低 | `package.json` 添加 `test:memory-native` 脚本 | `package.json` |

### 20.2 关键变更说明

**P0-2：prompt 观察路径**

```text
旧路径（错误）：
  onLoopEvent → assistant_delta → onPromptSubmit()
  问题：assistant_delta 是模型输出，不是用户输入；一个回复产生多个 delta

新路径（正确）：
  pipe mode:  直接调用 bridge.onPromptSubmit() before engine.submit()
  TUI mode:   App.onUserInput → bridge.onPromptSubmit()
  机制：bridge.tsx 的 createBridge 新增 onUserInput 回调参数
        App.tsx 新增 onUserInput prop
        tui.ts 传递 memoryBridge.onPromptSubmit 作为回调
```

**P0-2 FIX-2：队列去重**

```text
旧：fromQueue 是全局 boolean，submit() 执行期间保持 true
    → 用户在此期间的新输入被跳过
新：submit(text, isQueueResubmit = false) per-call 参数
    processQueue 调用 submit(next, true)，直接调用不传参
    → 每次调用独立判断，新输入不受队列处理影响
```

**P1-4：动态 import**

```text
旧：文件顶部静态 import { MemoryService, ... } from "@deepreef/memory"
新：if (enableMemory) { const memory = await import("@deepreef/memory") ... }
效果：DEEPREEF_MEMORY=false 时完全不加载 memory 模块
```

**P1-2：配置优先级**

```text
旧：构造函数只读 dataDir，其余 config 字段全部丢弃
新：this.userConfig = userConfig 完整保存
    registerAllFunctions() 中 uc.enableGraph ?? isGraphExtractionEnabled()
    显式构造参数 > 环境变量 > 默认值
```

**FIX-3：consolidation timer 门控**

```text
旧：startTimers() 只检查 enableConsolidation，不检查 advancedTools
    → advancedTools=false 时 timer 启动但 mem::consolidate-pipeline 未注册
新：shouldConsolidate = advancedTools && enableConsolidation
    → advancedTools=false 时不启动 timer
```

**FIX-4：injectContext=false 门控**

```text
旧：无论 memoryInjectContext 是否关闭，启动时都调用 mem::context
新：if (memoryInjectContext) { ... mem::context ... }
    → DEEPREEF_MEMORY_INJECT_CONTEXT=false 时不调用，不污染 system prompt
```

**FIX-6：ignored 输入不再观察**

```text
旧：onUserInput() 在 enqueueInstruction() 之前调用
    → 空白/ignored 输入也被记录为观察
新：onUserInput() 移到 enqueueInstruction() 状态检查之后
    → ignored 时直接 return，不调用 onUserInput
```

**FIX-8：onGenerationComplete 竞态**

```text
旧：engine 的 void runOnLoopEvent() 是 fire-and-forget
    → CLI finally 可能在 generation observation 完成前执行 onSessionEnd/stop
新：hookAdapter 包装为 trackedAdapter，存储 lastHookPromise
    → finally 中 await lastHookPromise?.catch(() => {}) 后再清理
```

### 20.3 验收

```bash
bun run typecheck                          # 通过
bun run --cwd packages/memory typecheck    # 通过
bun run test:memory-native                 # 32/32 通过
```

### 20.4 测试门禁（已建立）

```bash
bun run test:memory-native   # 独立脚本，可接入 CI
```

| 测试文件 | 覆盖内容 | 状态 |
|----------|----------|------|
| `test/deepreef-memory-service.test.ts` | service start/stop/CRUD/evict | ✅ 5/5 |
| `test/deepreef-memory-tools.test.ts` | agent tool shape/execute/full flow | ✅ 8/8 |
| `test/deepreef-memory-bridge.test.ts` | bridge hook lifecycle/autoObserve | ✅ 11/11 |
| `test/deepreef-memory-migration.test.ts` | migrate tool shape/schema/execute | ✅ 3/3 |
| `packages/cli/src/__tests__/memory-integration.test.ts` | CLI import/tool registration/service lifecycle | ✅ 5/5 |

### 20.5 仍需后续处理

- `onPreToolUse` 明确不接入（DONE 已列为限制）
- Subagent start/stop 观察未接入
- 测试断言强度待加强（advancedTools 注册验证、autoObserve 观察计数、forget 后 recall 验证）
- CI 集成待完成（test:memory-native 脚本已就绪，需接入 CI pipeline）
