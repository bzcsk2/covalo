# Deepicode 完成记录

最后更新：2026-06-02

本文只记录当前代码中仍然成立的已完成功能和已验证修复。
未完成、待验收和明确暂缓事项统一见 [TODO.md](TODO.md)。历史审计上下文见 [ADVICE.md](ADVICE.md)。

---

## 1. 当前验证基线

本次整理时实际运行：

```bash
bun run typecheck
bun test
```

结果：

| 检查项 | 状态 |
|--------|------|
| TypeScript | `bun run typecheck` 通过 |
| 测试 | `688 pass / 6 fail`，共 `694` tests |
| 失败范围 | 见 TODO.md 第 7 节 |

---

## 2. 当前架构快照

```text
packages/cli/src/tui.ts
  └─ 注册 34 个静态 Agent Tool
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
| TUI | React 19 + `@deepicode/ink`，显示组件适配自 Reasonix |
| Core 事件 | `AsyncGenerator<LoopEvent>`，使用 role-based 事件模型 |
| 工具并发 | `shared` 并行，`exclusive` 串行 |
| 工具进度 | 已有 `tool_start`、`tool_progress: running/done` 粗粒度事件 |
| 会话持久化 | `.deepicode/sessions/*.jsonl`，best-effort append |
| 上下文 | ImmutablePrefix + AppendOnlyLog + VolatileScratch |
| 权限 | `PermissionEngine` 的 deny → allow → ask 判定 |
| Agent | Build Agent + Plan Agent |

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

TUI 路由已开始接入，但仍有两个 bridge 测试待修复，因此不在此处标为完整闭环。

### 3.4 TUI

- 保留 Deepicode 自己的 `TimelineItem[] + TurnView` 状态模型。
- Reasonix 显示组件：Card、CardHeader、Markdown、StreamingCard、ToolCard、Spinner、主题 token。
- 流式 assistant 文本、reasoning 折叠显示、工具卡片、耗时和错误内联。
- 工具 key 使用 `toolCallIndex + sequence`，避免后续批次重复 index 覆盖历史记录。
- cancel 先调用 `respondPermission(false)`，再调用 `interrupt()`，避免权限 Promise 悬空。
- TUI `messageQueue` 保留串行提交语义。
- Ctrl+C：加载中取消；空闲时双击退出；终端清理顺序已固定。
- 多行输入、历史记录、Ctrl+方向键跳词、Ctrl+Backspace 删除前词。
- 斜杠命令自动补全基础组件；键盘事件回归见 TODO `T21-R`。
- 中英文 i18n：`zh-CN / en`，`/lang` 切换并写入 `.deepicode/lang.json`。
- 长会话显示优化：React.memo、useMemo 和 Ink viewport culling。
- `Ctrl+F` 消息搜索与屏幕空间高亮。

### 3.5 安全

- PermissionEngine：Deny-first，支持 allow / deny 规则、序列化和恢复。
- HookManager：before / after / loop-event 三类 hook。
- before hook 异常 fail-safe 为 deny。
- after 和 loop-event hook 异常被隔离；支持 `setErrorObserver()` 观察错误。
- FileSnapshot：文件快照、恢复、SHA256 路径索引和稳定排序。
- 敏感路径规则覆盖 `.env*`、`.git`、密钥、证书、npmrc、AWS 凭据等。
- WebFetch 和 WebBrowser 执行协议校验、私网地址拒绝和重定向后复查。
- bash 使用 `bash -c`，设置非交互编辑器环境变量，限制危险命令，并支持超时后 SIGTERM → SIGKILL。

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

### 3.7 运行时日志系统（LOG0-LOG7）

完整的运行时诊断系统，借鉴 Claude Code 日志架构：

**核心组件：**

- `RuntimeLogger`：默认关闭，异步写入 JSONL，支持事件过滤。
- `RuntimeLogSink`：单 sink 设计，timer-based flush（1s），队列超限自动丢弃。
- `parseDebugArgs()`：支持 `--debug`/`-d`/`--debug=<pattern>`/`--debug-file=<path>`。
- `createRuntimeLoggerFromEnv()`：从环境变量创建 logger。
- `registerShutdownFlush()`：优雅退出时 flush 日志。
- `cleanupOldLogs()`：后台清理过期日志。
- `checkDeprecatedDebugEnv()`：弃用 `DEEPICODE_DEBUG` 提示。

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
DEEPICODE_LOG_LEVEL=debug|info|warn|error|off
DEEPICODE_LOG_FILE=<path>
DEEPICODE_LOG_FILTER=<pattern>
DEEPICODE_LOG_RETENTION_DAYS=7
DEEPICODE_LOG_MAX_TOTAL_MB=100
DEEPICODE_LOG_SYMLINK=1
DEEPICODE_TUI_DEBUG=1
DEEPICODE_TRACE=1
```

**Perfetto 追踪：**

- 简化版 Chrome Trace Event JSON 输出。
- Span 层级：interaction → llm_request → tool_batch → tool。
- 输出到 `.deepicode/traces/trace-<session-id>.json`。

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
| T21 | 斜杠命令自动补全基础组件；键盘事件回归见 TODO `T21-R` |
| T22 | 跳词和 Ctrl+Backspace |
| T30/T31/T32 | i18n 基础设施、文案替换、`/lang` |
| T40 | 长会话渲染优化 |
| T41 | 消息搜索 |

### 4.2 稳定性修复

| 编号 | 内容 |
|------|------|
| L2 | SessionWriter 有界队列 |
| L5 | 编辑链路 CRLF 归一化并恢复原格式 |
| N1 | NotebookEdit 异步原子写 |
| N2 | `/skill` 使用 `@deepicode/tools` 跨包导入 |
| N3 | SessionPicker 避免卸载后 setState |
| N4 | 空 tool call id 规范化 |
| N5 | client.ts 类型断言收紧 |

### 4.3 工具结果与指令注入

| 编号 | 内容 | 状态 |
|------|------|------|
| P0 | 工具结果、中断、权限和 TUI 队列契约测试 | 已完成 |
| P1 | tool result exactly-once | 已完成 |
| P2 | Core 中途指令队列和 loop 安全点 | 已完成 |
| P3 | TUI 注入优先路由和反馈基础接入 | 已完成；回归收口见 TODO `P3-R` |
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

### T21-R：斜杠命令补全键盘事件冲突

- `DeepiPromptInput` 使用 `forwardRef` 暴露 `writeText` 方法，供 autocomplete 回写文本。
- `suppressHistory` prop 在菜单打开时禁用 ↑↓ 历史导航，避免与 autocomplete 光标移动冲突。
- `App.tsx` 将 `ref` 和 `suppressHistory` 传递给 `DeepiPromptInput`，并在 `CommandAutocomplete` 的 `onSelect` 中通过 ref 写入文本。
- 验收：菜单打开时 ↑↓ 只改变选中项；Enter/Tab 回写命令；Esc 只关闭菜单；菜单关闭后 ↑↓ 恢复历史导航。

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

- `maybePersistResult` 首次 overflow 时扫描 `.deepicode/results/<sessionId>/` 初始化用量。
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

- `tsconfig.json` 新增 `@deepicode/core` 和 `@deepicode/tui` 的 paths 映射。
- `@deepicode/tools` 补齐 `exports`、`types` 字段，新增 `@deepicode/core` 依赖。
- `@deepicode/mcp` 补齐 `exports` 条件导出，新增 `@deepicode/core`、`@deepicode/tools` 依赖。
- `@deepicode/cli` 新增 `@deepicode/tools`、`@deepicode/mcp`、`@deepicode/tui` 依赖。
- `@deepicode/tui` 补齐 `exports`、`types` 字段。
- `packages/tools/src/index.ts` 新增 `safeStringify`、`hasBinaryEncoding`、`clearReadTracker` 导出。
- `packages/core/src/index.ts` 新增 `ToolProgressUpdate` 类型导出。
- 38 个源文件的 `../../core/src/...`、`../../tools/src/...`、`../../mcp/src/...` 相对路径 import 全部替换为包名 import（`@deepicode/core`、`@deepicode/tools`、`@deepicode/mcp`、`@deepicode/tui`）。
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

---

## 6. 文档维护规则

1. `DONE.md` 只记录已存在且仍然成立的能力。
2. 未完成事项移入 `TODO.md`，不要在 DONE 中维护第二套待办列表。
3. 每次更新基线必须实际运行 `bun run typecheck` 和 `bun test`。
4. 历史审计猜测、驳回项和低风险观察写入 `ADVICE.md`。
5. 不再追加重复的“第 N 轮修复”流水账；后续按专项编号记录结果。
