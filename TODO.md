# Deepicode TODO 与开发交接指南

最后更新：2026-05-31
基线：`bun run typecheck` 通过，`bun test` 为 **592 pass / 0 fail**。

本文是后续 Agent 的唯一待办入口，只记录**尚未完成**或**明确暂缓**的工作。
已完成实现、历史修复和设计演进见 [DONE.md](DONE.md)。审计记录见 [ADVICE.md](ADVICE.md)，但其中包含已经修复或已经驳回的旧结论，**不要直接照单修改代码**。

> 项目原则：能直接复用 Claude Code、Reasonix、OpenCode 中经过验证的实现时，优先适配，不要凭空重写。适配前先确认 Deepicode 当前接口和安全边界。

---

## 0. Agent 开始工作前必读

### 0.1 每次只领取一个闭环

推荐执行顺序：

1. 从本文选择一个任务编号，例如 `L2` 或 `T20`。
2. 阅读任务列出的文件和邻近测试，不要先做跨模块重构。
3. 先写或更新针对性测试，再做最小实现。
4. 运行任务要求的目标测试。
5. 运行 `bun run typecheck`、`bun test`、`git diff --check`。
6. 将完成项从本文移到 `DONE.md`，写明实现、测试和仍保留的限制。

工作区可能已有其他 Agent 或用户的改动。禁止用 `git reset --hard`、`git checkout --` 等命令清理不属于当前任务的修改。

### 0.2 不可破坏的架构边界

| 边界 | 当前正确做法 | 禁止事项 |
|------|--------------|----------|
| Core 与 TUI 解耦 | `engine.submit()` 只产出 `AsyncGenerator<LoopEvent>` | 不要从 Core import React、Ink 或 TUI 组件 |
| TUI 状态模型 | `TimelineItem[] + TurnView`，由 `bridge.tsx` 消费事件 | 不要为了对齐 Reasonix 引入完整 `Card[] / Store / TurnTranslator` |
| 流式工具索引 | `tool_call_delta`、`tool_start`、`tool`、`tool_progress` 使用 `toolCallIndex` 关联 | 不要用工具名作为唯一 key；同批次和后续批次可能重复调用同名工具 |
| 工具结果 | `ToolResult.content` 始终是字符串；结构化结果用 `safeStringify()` | 不要把对象直接塞入上下文，不要绕过 `isError` |
| 权限模型 | `deny → allow → ask`；`exec` 默认需要用户确认 | 不要给后台子 Agent 静默放开 `exec`；不要绕过 `PermissionEngine` |
| 嵌套工具调用 | 通过 `ToolContext.invokeTool()`；递归调用被拒绝 | 不要在 `Workflow` 内新建第二套 ToolRegistry 或直接调用 Shell |
| MCP | 外部工具通过 `ListMcpTools` / `CallMcpTool` 桥接 | 不要把动态 MCP schema 直接混入静态 prefix，避免每次启动破坏 prefix cache |
| 上下文前缀 | `ImmutablePrefix` 由 system prompt + tool specs 指纹控制 | 不要无理由改变 system prompt 或工具 schema 顺序 |
| 会话持久化 | `.deepicode/sessions/*.jsonl`，best-effort append | 不要让持久化失败阻塞对话主流程 |
| 编辑安全 | `edit` 保留 stale-read、敏感路径、原子 rename 和权限位 | 不要用直接覆盖写替换 hash-edit 主路径 |
| 浏览器安全 | Playwright 子进程隔离；入口和页面请求均执行 SSRF 检查 | 不要允许访问 localhost、私网 IP、`.local`、`.internal` |

### 0.3 当前关键入口

```text
packages/cli/src/tui.ts
  └─ 注册 34 个静态 Agent Tool
     └─ ReasonixEngine.submit()
        └─ runLoop()
           └─ StreamingToolExecutor.run()
              └─ AgentTool.execute(args, ToolContext)

engine.submit()
  → LoopEvent
  → packages/tui/src/bridge.tsx
  → TimelineItem[] + TurnView
  → packages/tui/src/DeepiMessages.tsx
```

Build Agent 开放 34 个静态工具；Plan Agent 仅开放 `read_file`、`list_dir`、`grep`、`todowrite`。
外部 MCP Tool 不计入 34 个静态工具，通过 MCP 桥接按需发现和调用。

### 0.4 验证命令

```bash
bun run typecheck
bun test
git diff --check
```

按模块开发时先跑更小的集合：

```bash
bun test packages/tui/__tests__/bridge.test.ts
bun test packages/core/__tests__/streaming-executor.test.ts packages/core/__tests__/engine-tools.test.ts
bun test packages/core/__tests__/session.test.ts
bun test packages/tools/__tests__/edit.test.ts packages/tools/__tests__/edit-integration.test.ts
bun test packages/mcp/__tests__/mcp-host.test.ts packages/mcp/__tests__/mcp-tools.test.ts
```

### 0.5 已确认过时的审计项

`ADVICE.md` 保留历史上下文，但以下条目已经完成。除非新增可复现测试证明回归，否则不要重新修改：

| 历史条目 | 当前状态 |
|----------|----------|
| Session 恢复时 system 消息重复 | `ReasonixEngine._loadSessionMessages()` 已过滤历史 system 消息 |
| repair `1e + 1f` 组合策略缺失 | `repair.ts` 已有 `1g` 组合修复和回归测试 |
| reasoningText 回答后消失 | `TurnView.reasoningText` 已保留，由 `DeepiMessages` 折叠显示 |
| Bash 确认 UI 缺失 | `PermissionPrompt.tsx` 已提供允许、始终允许、拒绝；cancel 会兑现等待中的 Promise |
| `McpAuth` 仍为占位 | 已支持 `set/list/delete`，以 `0600` 权限持久化 |
| Workflow / AgentTool 模拟执行 | 已接入真实嵌套工具调用和隔离子会话 |
| FileSnapshot 同毫秒排序波动 | 已加入实例内递增序号 |

---

## 1. 推荐开发顺序

| 顺序 | 范围 | 原因 |
|------|------|------|
| 1 | `L2`、`L5`、`N1` | 稳定性和文件安全问题，改动范围清晰 |
| 2 | `N2`、`N3`、`N4`、`N5` | 小型维护项，先减少后续 TUI 和 provider 工作中的噪音 |
| 3 | `F3/F5` | 在现有时间线模型上补齐流式显示，不改变架构 |
| 4 | `T20`、`T22`、`T21` | 输入体验；先数据模型，再编辑行为，再补全窗口 |
| 5 | `T30`、`T31`、`T32` | i18n；等 TUI 字符串结构稳定后进行 |
| 6 | `T40`、`T41` | 长会话渲染和搜索，属于独立显示层增强 |
| 7 | `ST1`–`ST4` | 策略系统涉及 Core + TUI，必须单独设计和测试 |
| 8 | `M10`、`H1`–`H23` | 测试矩阵和压力验证，伴随相应模块逐步补齐 |

不要一次领取多个阶段。每个编号完成后都应保持全量测试为绿色。

---

## 2. P2/P3 稳定性修复

### L2：限制 SessionWriter 队列增长 ✅

已修复。队列上限 500 条，溢出时优先丢弃旧 `event` 记录，保留 `messages` 和 `stats`。新增 `getDroppedCount()` 方法。4 个新测试通过。

### L5：编辑链路统一 CRLF ✅

已修复。`edit.ts` 检测 CRLF/LF，归一化后传给编辑函数，写回时恢复原始换行风格。支持精确匹配和 fuzzy fallback。4 个新 CRLF 测试通过。

### N1：NotebookEdit 改为异步原子写 ✅

已修复。改用 `readFile`/`writeFile` 异步 API，写入通过临时文件 + `rename()` 原子替换，保留原始文件权限。9 个测试通过。

### N2：修正 `/skill` 跨包 import

**现状**：`packages/tui/src/App.tsx` 使用 `../../tools/src/skills/index.js` 相对路径动态 import，破坏包边界。

**建议实现**：

- 为 `@deepicode/tools` 暴露稳定入口，或增加明确的 package alias。
- 保留动态加载，避免启动 TUI 时不必要地加载全部 skill 元数据。
- 不要把 skills 文件复制进 TUI 包。

**验收**：

- `/skill` 可正常列出 skills。
- TUI 不再出现跨包 `../../tools/src/...` import。

### N3：避免 SessionPicker 卸载后 setState

**现状**：`handleSessionSelect()` 在异步 `loadSession()` 后直接更新状态。如果组件期间卸载，可能触发卸载后 setState。

**建议实现**：

- 使用 `useEffect()` cleanup 维护 mounted ref，或使用递增 request id。
- 多次选择 session 时只允许最后一次结果生效。
- 不要更改 `ReasonixEngine.loadSession()` 的系统消息过滤行为。

**验收**：

- 卸载期间完成异步加载不会 setState。
- 连续快速选择两个 session，最终显示第二个。

### N4：跨 provider 的 tool call id 规范化

**现状**：`runLoop()` 直接使用 provider 返回的 `event.id`。不同 DeepSeek-compatible provider 可能返回空 id、重复 id 或格式差异。

**建议实现**：

- 在进入上下文前统一生成稳定、非空、单轮唯一的 `tool_call_id`。
- 保留原始 id 时放入调试 metadata，不要破坏 tool result 与 assistant tool call 的关联。
- `toolCallIndex` 仍是 TUI 事件映射依据，不要混用 id 和 index。

**涉及文件**：

- `packages/core/src/loop.ts`
- `packages/core/src/types.ts`
- `packages/core/__tests__/engine-tools.test.ts`

**验收**：

- 空 id、重复 id、多工具同轮场景均能生成唯一 id。
- tool result 的 `tool_call_id` 与 assistant tool call 一致。

### N5：收紧 client.ts 类型断言

**现状**：`packages/core/src/client.ts` 仍有少量 `any` / 强制断言，集中在消息构造、API error 解析和 abort error 判定。

**建议实现**：

- 使用小型 type guard，不要引入大型 schema 依赖。
- 保持 SSE 容错语义：未知字段忽略、合法字段继续解析、网络 abort 可识别。

**验收**：

- `rg -n "\\bany\\b| as " packages/core/src/client.ts` 中不再有可消除的宽泛断言。
- `bun test packages/core/__tests__/sse-client.test.ts` 通过。

---

## 3. TUI 当前重点

### 3.1 已确定的设计

TUI 保持键盘驱动，鼠标只用于终端文本选择。显示层对齐 Reasonix 的视觉组件，但保留 Deepicode 自己的事件桥接：

```text
engine.submit()
  → LoopEvent
  → bridge.tsx
  → TimelineItem[] + TurnView
  → DeepiMessages
  → reasonix/Card、CardHeader、Spinner、ToolCard
```

**不要做的事**：

- 不要引入 Reasonix 的完整 `Card[]` 数据模型。
- 不要把 `bridge.tsx` 改写为 Redux 风格 Store。
- 不要删除 `messageQueue` 串行提交逻辑。
- 不要删除 cancel 时的 `engine.respondPermission(false)`；否则权限弹窗会让 generator 永久等待。
- 不要把 tool key 简化为 `toolCallIndex`；后续工具批次会重新从 index `0` 开始。

已有回归测试：`packages/tui/__tests__/bridge.test.ts`。

### F3/F5：StreamingCard 与 token 速率

**目标**：合并完成。新增轻量 `StreamingCard` 显示流式文本、Spinner 和 token/s，不迁移 Reasonix Store。

**实现思路**：

- 在 TUI 显示层新增 `StreamingCard.tsx`，由 `DeepiMessages.tsx` 在 `turn.streamingText !== null` 时使用。
- provider 的 `usage` 通常在阶段末尾才到达。流式阶段优先根据新增字符做近似 token 采样，阶段末尾再用 `usage` 校准；不要为了显示速率修改 Core API。
- token/s 应基于时间窗口平滑，避免每个字符触发跳动。
- 流结束后继续使用 Markdown 渲染最终 assistant 文本。

**验收**：

- 流式阶段显示光标、Spinner、token/s。
- 完成后替换为 Markdown，不重复渲染 assistant 消息。
- 不影响 reasoning 和 tool cards 折叠。

### T20：多行输入

**目标**：`Enter` 插入换行，`Ctrl+Enter` 提交。

**实现思路**：

- `DeepiPromptInput` 当前是单个字符串 + 单个 cursor offset，可继续沿用，不必改成二维坐标。
- 渲染时允许换行，不要使用只适合单行的 `wrap="truncate-end"`。
- 历史记录仍以完整字符串保存。
- loading 期间输入仍允许排队，这是现有能力。

**验收**：

- `Enter` 在 cursor 位置插入 `\n`。
- `Ctrl+Enter` 提交并清空输入。
- 上下左右移动不会破坏中英文文本。

### T22：输入编辑增强

在 `T20` 完成后实现：

- `Ctrl+Left` / `Ctrl+Right`：按单词跳转。
- `Ctrl+Backspace`：删除前一个单词。
- 多行模式下 `Up` / `Down`：优先移动行内光标；仅在单行或显式历史模式下浏览历史。

**验收**：

- ASCII、中文、连续空白、行首行尾均有测试。
- 不破坏 `Ctrl+A`、`Ctrl+E`、`Ctrl+U`、`Ctrl+K`、`Ctrl+D`。

### T21：斜杠命令自动补全

在 `T20/T22` 之后实现 `CommandAutocomplete.tsx`：

- 只在输入以 `/` 开始且 cursor 位于命令 token 内时显示。
- 命令来源集中维护，至少包含 `/help`、`/model`、`/sessions`、`/agent`、`/skill`、`/lang`、`/exit`、`/bye`。
- `Up/Down` 选择，`Tab` 或 `Enter` 补全，`Esc` 关闭。
- 不要在 `App.tsx` 和补全组件分别维护两套命令文本；抽出 command registry。

### T30/T31/T32：中英文切换

**顺序**：

1. `T30`：新增 `packages/tui/src/i18n/`，实现类型安全的 `t(key)` 和 `zh-CN/en` 字典。
2. `T31`：替换 TUI 用户可见硬编码字符串。
3. `T32`：新增 `/lang`，运行时切换并持久化偏好。

**边界**：

- 不要翻译工具名、事件 role、provider id、agent name 或 JSON 字段。
- Core 错误消息暂时不纳入 TUI i18n，避免跨层耦合。

### T40：虚拟消息列表

**目标**：长会话只渲染可见窗口，降低 Ink 重绘成本。

**边界**：

- 虚拟化只发生在显示层，不裁剪 `timeline` 和 Engine 上下文。
- 保留稳定 `item.id`，不要按数组 index 作为 React key。
- 先对 500+ TimelineItem 做 benchmark，再决定窗口大小。

### T41：消息搜索

**目标**：`Ctrl+F` 打开 `SearchOverlay.tsx`，搜索当前 timeline。

**边界**：

- 搜索只读，不改写 timeline。
- 结果定位与虚拟列表共用稳定 item id。
- 搜索 assistant、user、reasoning 和工具输出时分别标注来源。

---

## 4. 智能推理强度调节

参考 RNX `src/loop.ts` 的 strategy select 思路，但不要把 RNX loop 整段搬进 Deepicode。Deepicode 已预留 `strategy_notify` 和 `strategy_estimate_refined` 两个 `LoopEvent` role。

### ST1：Tier 配置定义

新增 `packages/core/src/strategy/`：

- 定义四档 tier，记录 CNY 预算、上下文阈值、推荐模型和最大链路长度。
- 配置必须是纯数据，不 import TUI。
- 默认行为保持现状；策略模块未启用时不能改变请求参数。

### ST2：TaskClassifier

- 纯规则、可测试、无网络请求。
- 输入为用户文本和有限会话摘要，不读取完整工具输出。
- 输出分类理由和分数，便于 TUI 展示和调试。

### ST3：ChainEstimator

- 根据最近 usage 事件、TPS 和工具调用次数估算剩余成本。
- 使用滑动窗口，避免单次 usage 抖动。
- 估算失败时返回 conservative fallback，不阻塞主 loop。

### ST4：StrategySelector 与 TUI 倒计时

- Core 只产出事件和建议，不直接渲染。
- TUI 显示倒计时，用户可接受、覆盖或取消。
- 未响应时采用文档明确的默认策略。

**验收**：

- 所有策略逻辑有纯单测。
- strategy 模块异常不会中断正常问答。
- 未开启策略功能时 API 请求与当前基线一致。

---

## 5. 测试矩阵待补齐

### M10：write_file 父目录权限继承

**目标**：新建文件时继承父目录合理权限，避免依赖进程 umask 产生意外结果。

**注意**：先确定 Linux 目标语义，再修改实现；不要破坏敏感路径拒绝和 10MB 限制。

### H1–H23：困难场景

| # | 模块 | 场景 | 实现提示 |
|---|------|------|----------|
| H1 | Streaming | AbortSignal 终止后续工具 | 覆盖 shared batch 和 exclusive 队列 |
| H2 | Streaming | shared 工具并发安全 | 验证结果按声明 index 回写 |
| H3 | Streaming | 工具执行超时 | 先设计 timeout 所属层，不要让工具各自重复实现 |
| H4 | Engine | interrupt 在工具执行中 | 覆盖 pending permission 和工具 signal |
| H5 | Engine | interrupt 在 SSE 流中 | 使用 MockSseServer，不依赖公网 |
| H6 | Engine | submit 后 switchAgent | 下一轮生效，当前轮工具集保持稳定 |
| H7 | Engine | fold force 集成 | 不阻塞 loop；100ms fallback 保持有效 |
| H8 | Engine | 并发 submit | 先明确拒绝、排队或隔离语义 |
| H9 | Engine | submit 中 updateConfig | 下一轮生效，不污染当前请求 |
| H10 | Engine | 50+ 轮对话 | 验证截断边界不产生孤立 tool message |
| H11 | edit | 1MB 单行文件 | 验证 hash 主路径内存和原子替换 |
| H12 | edit | 10 万行文件 | 验证 fuzzy fallback 不误匹配 |
| H13 | bash | `sleep 60` 超时 | 验证子进程终止 |
| H14 | bash | stdout 未完全消费 | 验证截断后仍回收进程 |
| H15 | bash | detached 子进程 | 明确是否支持及清理策略 |
| H16 | WebFetch | 30s 超时 / DNS 失败 | 使用可控 mock，保留 SSRF 检查 |
| H17 | McpClient | JSON-RPC stdio 全套 12 项 | 扩展 fake MCP server |
| H18 | McpHost | 多 server、断连、部分失败 6 项 | 单 server 失败不能阻塞其他 server |
| H19 | MCP Tools | List/Read 资源 | 覆盖资源不存在和 host 未初始化 |
| H20 | Bridge | TUI 状态机 18 项 | 扩展现有 `bridge.test.ts` |
| H21 | Terminal | Ink/SIGINT 8 项 | 保留双 Ctrl+C、Esc×2 和 alt-screen 恢复 |
| H22 | 压力 | 50 轮 / 50K JSON / 10MB 文件 | 单独标记 slow test |
| H23 | 压力 | 100 工具 / 1000 行 JSONL / 极端文件名 | 验证排序、截断和恢复 |

---

## 6. 明确暂缓，不要顺手实现

以下事项不是当前里程碑的一部分。除非用户明确要求，不要在其他任务中顺便引入：

- TTSR 规则系统。
- Universal Config Discovery。
- Python Kernel。
- 多前端：Web、IDE Plugin。
- AskUserQuestion 专用 TUI 选择弹窗。当前行为是输出结构化提问，等待用户下一轮输入回答。
- WebBrowser 跨调用持久会话。当前行为是隔离单次 Playwright 操作，每次显式携带 URL。
- 完整 OAuth 型 MCP 身份系统。当前 `McpAuth` 是项目级 token 存储。
- README 全面重写、配置指南和发布包。

---

## 7. 完成任务后的文档动作

完成一个编号后：

1. 从本文删除对应待办。
2. 在 `DONE.md` 增加简短记录：日期、任务编号、实现边界、测试命令和测试数量。
3. 如果发现新问题，只在已确认可复现后写入本文；审计猜测先写入 `ADVICE.md`。
4. 如果实现改变用户可见行为，同步更新 `README.md` 和 `README.en.md`。

不要在 TODO 中保留已经完成的 checkbox。TODO 是下一位 Agent 的工作队列，不是历史档案。
