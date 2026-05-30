# Deepicode 完成记录

本文按 `Deepicode实施计划.md` 的 Phase / Step 记录已完成内容。状态含义：

- `完成`：代码已落地并通过基础验证。
- `最小完成`：具备可用闭环，但未达到实施计划中的完整版要求。
- `部分完成`：只完成子集能力，仍需后续补齐。

最后更新：2026-06-01（TL1/TL3/TL4 工具层生态）

## 第十一轮：工具层生态（TL1 + TL3 + TL4，2026-06-01）

### TL1 收尾：glob/web-fetch 注册 + WebSearch 工具

| 文件 | 改动 |
|------|------|
| `packages/tools/src/index.ts` | 导出 `createGlobTool`、`createWebFetchTool`、`createWebSearchTool` |
| `packages/tools/src/web-search.ts` | 新建：Google 网页搜索工具，HTML 结果解析，15s 超时，最多 10 条结果 |
| `packages/tools/src/glob.ts` | bugfix：`ReturnType<typeof stat>` → `Awaited<ReturnType<typeof stat>>` |
| `packages/tools/src/skill-loader.ts` | bugfix：`unknown` 类型 `val.startsWith()` 用 `rawVal` 中间变量；`ReturnType<typeof stat>` → `Awaited<ReturnType<typeof stat>>` |
| `packages/cli/src/tui.ts` | 注册 glob/WebFetch/WebSearch 工具 |
| `packages/core/src/agent.ts` | Build Agent 工具列表追加 `glob`/`WebFetch`/`WebSearch`/`Skill`/`ListMcpResources`/`ReadMcpResource`/`McpAuth` |

### TL3 Skills 技能系统

| 文件 | 改动 |
|------|------|
| `packages/tools/src/skills/` | 新建目录，复制 52 个 SKILL.md（来自 ~/.claude/skills） |
| `packages/tools/src/skills/index.ts` | SkillTool：search/list/load 三个命令，按名称/描述/标签匹配，返回技能内容 |
| `packages/tui/src/App.tsx` | `/skill` 斜杠命令列出已加载技能；`/help` 更新 |
| `tsconfig.json` | exclude 添加 `packages/tools/src/skills/**` 避免 TypeScript 编译技能目录内的 .ts 示例文件 |

### TL4 MCP 协议集成

| 文件 | 改动 |
|------|------|
| `packages/mcp/` | 新建包，package.json + 6 个源文件 |
| `packages/mcp/src/client.ts` | `McpClient` 类：stdio 子进程 + JSON-RPC 2.0 协议（initialize/tools/list/call/resources） |
| `packages/mcp/src/host.ts` | `McpHost` 类：多客户端管理 + 自动注册工具/资源 + `.deepicode/mcp.json` 配置加载 |
| `packages/mcp/src/mcp-host-global.ts` | 共享 Symbol 全局引用，跨文件共享 McpHost 实例 |
| `packages/mcp/src/list-resources.ts` | `ListMcpResources` 工具：列出所有 MCP 资源 |
| `packages/mcp/src/read-resource.ts` | `ReadMcpResource` 工具：按 URI 读取 MCP 资源内容 |
| `packages/mcp/src/auth.ts` | `McpAuth` 工具：MCP 认证凭据管理（set/list） |
| `packages/cli/src/tui.ts` | MCP Host 启动 + 注册 3 个 MCP 工具 |
| `tsconfig.json` | 添加 `@deepicode/mcp` 和 `types/**/*.d.ts` 路径映射 |

### 基础设施

| 文件 | 改动 |
|------|------|
| `tsconfig.json` | 添加 `types/**/*.d.ts` include、`@deepicode/mcp` 路径映射、skills 目录 exclude |
| `types/bun.d.ts` | 新建：Bun.Glob 类型声明，修复 `Cannot find module 'bun'` |
| `bun run typecheck` | 零错误 ✅ |
| `bun test` | 66 pass / 3 skip / 0 fail ✅ |

## ADVICE 审计修复（2026-06-01）

根据 `DeepicodeAudit-2026-06-01.md` 评估结果修复 6 项 Bug。详细评判见 `ADVICE.md`。

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| P2-5 | TokenizerPool 单次超时永久降级 | `tokenizer-pool.ts` | `consecutiveTimeouts` 计数器 → 连续 3 次超时才 `healthy=false`；Worker 正常响应时重置为 0 |
| P1-2 | StreamingToolExecutor 事件顺序不一致 | `streaming-executor.ts` | exclusive 路径 `executeToolCall`：`appendToolResult → yield event → yield done`，与 shared 路径对齐 |
| SEC-1 | glob.ts 路径穿越 | `glob.ts` | `realpathSync` + `startsWith` 校验搜索路径在项目目录内 |
| P2-3 | SessionLoader 崩溃恢复数据丢失 | `session.ts` | 从后向前遍历 JSONL，找最近的合法 `messages` 记录 |
| P3-3 | DeepiMessages React key 流式闪烁 | `DeepiMessages.tsx` | key 改为 `role + index`，去掉 `content.slice(0,20)` 前缀 |
| SEC-2 | web-fetch.ts SSRF | `web-fetch.ts` | `hasPrivateIP()` 拦截内网 IP + `isPrivateHostname()` 异步 DNS 解析 + `redirect: "manual"` |

**驳回的审计误判**：
- P1-1 (hash-edit 流式竞态)：审计误读代码结构，`!replaced` 检查在 for-await 循环之后，非循环内部
- P3-1 (repair 语义变更)：理论可能但无实际触发路径
- P3-4 (buildPiModel 硬编码)：死代码，TODO.md D5 标记清理
- TUI-CtrlC：已在 SIGINT 修复中解决，审计基于旧代码

---

## 第八轮：TUI 交互打磨（2026-05-30）

### TM1 + TM2: `/model` 命令 + Provider 切换

- `packages/core/src/config.ts`：新增 `PROVIDERS` 预设表（zen/deepseek/mimo）、`getApiKeyEnvVar()`、`saveLastConfig()`、`loadLastConfig()`
- `packages/tui/src/ModelPicker.tsx`：三步选择器（provider → API key → model），↑↓/Enter 操作，Zen 免费 tier 跳过 key 输入
- `packages/cli/src/tui.ts`：pipe 模式补全 5 种事件类型 + error 改 stderr

### 模型选择持久化

- `.deepicode/last-config.json`：退出时自动保存 provider + model + baseUrl
- `loadConfig()` 优先级：环境变量 > last-config.json > 代码默认值
- Zen 404 修复：`ensureBaseUrl()` 改为字符串拼接，保留 `/zen/v1/` 路径段

### 状态栏重新设计

- 样式：`Zen (Free) deepseek-v4-flash-free  入13K 中95% 出65  58K/1000K`
- `loop.ts`：usage 事件 metadata 增加 cacheHit/cacheMiss
- `bridge.tsx`：BridgeState 增加 cacheHit/cacheMiss/contextUsage
- `StatusBar.tsx`：中文标签（入/中/出）+ 缓存命中率 + 上下文用量/总量
- `DeepiPromptInput.tsx`：光标改用字符串拼接（▊ 嵌入文本中），不再嵌套 Text 组件
- 模型名重复修复：`getProviderLabel()` 不再包含 model 名

### 粘贴功能

- `ModelPicker.tsx`：`tryReadClipboard()` 支持 wl-paste → xclip → xsel 三种工具回退
- 终端 bracketed paste 支持：多字符 `_input` 直接追加到输入

## SIGINT / Raw Mode 修复（2026-05-30，三轮迭代）✅ 已解决

### 问题背景

Linux 下 Ctrl+C 产生 SIGINT 信号而非字符事件。Deepicode 使用 Ink/React 终端框架（复制自 best-claude-code），alternate screen + raw mode 环境下 Ctrl+C 导致终端损坏：光标跳屏幕顶部、输入失效、退出后看不到之前的屏幕记录。

### 踩坑历程

**第一轮（失败）：表面修复。** 在 `App.tsx` 的 `useEffect` 中注册 `process.on('SIGINT')` handler，处理加载中取消和空闲双击退出。错误地认为问题是"没有 SIGINT handler"，实际上 handler 早在第八轮就已存在，问题不在此。

**第二轮（部分成功）：发现 `exitOnCtrlC` 根因。** 经深入调查 best-claude-code 对比分析，发现三个互相关联的问题：

| 坑 | 现象 | 根因 |
|----|------|------|
| 坑 1：raw mode 丢失 | Ctrl+C 后输入失效、光标跳顶 | `exitOnCtrlC` 默认为 `true`，Ink 内部的 `App.handleInput('\x03')` 抢先调 `handleExit()` → `setRawMode(false)` + `unmount()`，raw mode 被 Ink 关掉了 |
| 坑 2：连续 Ctrl+C 无法退出 | 双击退出不生效 | `setTimeout(() => process.exit(0), 100)` 在 Bun 信号处理上下文中不可靠——信号交付后事件循环可能异常，定时器回调永远不会触发 |
| 坑 3：`\x03` 字符路径无退出逻辑 | 仅 SIGINT 路径可退出 | 设置 `exitOnCtrlC: false` 后 `\x03` 走 `useInput` 字符路径，但 DeepiPromptInput 只在 loading 时调 `onCancel()`，idle 时直接忽略 |

第二轮修复：
- `cli/src/tui.ts`：`render()` 传 `{ exitOnCtrlC: false }` — 禁止 Ink 内部拦截 `\x03`
- `App.tsx`：创建模块级 `doInterrupt()` 统一入口，同时被 SIGINT handler 和 `useInput` 字符 handler 调用；`process.exit(0)` 改为同步调用
- `bridge.tsx`：`setTUIState('loading'/'idle')` 同步引擎状态到模块变量
- `DeepiPromptInput.tsx`：新增 `\x03` / Ctrl+C 字符检测
- `StatusBar.tsx`：新增 `statusMessage` prop 显示退出确认

**第三轮（成功）：终端恢复顺序错误。** 第二轮修复后，Ctrl+C 双击退出功能正常，但退出后看不到之前的屏幕记录。原因是 `cleanupTerminal()` 的调用顺序不对。

关键教训：Ink 的 `unmount()` 必须在替代屏幕**仍然激活时**调用（它在 alt buffer 上渲染最后一帧），然后 `detachForShutdown()` 必须在 `unmount()` **之后**调用（阻止 signal-exit 二次执行 unmount）。先恢复 raw mode 再调 unmount 是错误的——会导致 unmount 在 cooked mode 下渲染，破坏终端状态。

对照 best-claude-code `gracefulShutdown.ts` 的 `cleanupTerminalModes()` 后，确认正确顺序：

```
1. DISABLE_MOUSE_TRACKING     — 先关鼠标，给终端时间处理
2. inst.unmount()             — alt screen 还在时渲染最后一帧 + 退出 + 取消 signal-exit
3. inst.drainStdin()          — 清掉 tree-walk 期间到达的事件
4. inst.detachForShutdown()   — 标记已卸载 + 恢复 raw mode
5. SHOW_CURSOR                — 显示光标
```

### 最终修复内容

| 文件 | 改动 |
|------|------|
| `packages/cli/src/tui.ts` | `render()` 传 `{ exitOnCtrlC: false }` — 禁止 Ink 内部拦截 `\x03`；`runTUIMode()` 加 try/finally + writeSync 安全网 |
| `packages/tui/src/App.tsx` | 模块级 `tuiState`/`exitTimer`/`exitPending`；`doInterrupt()` 统一入口（SIGINT + useInput `\x03` 双路径）；`cleanupTerminal()` 严格按 CC 顺序：mouse↓ → unmount → drainStdin → detachForShutdown → SHOW_CURSOR |
| `packages/tui/src/bridge.tsx` | `submit()` 开始调 `setTUIState('loading')`，finally/cancel 调 `setTUIState('idle')` |
| `packages/tui/src/DeepiPromptInput.tsx` | 新增 `\x03` / Ctrl+C 字符检测 |
| `packages/tui/src/StatusBar.tsx` | 新增 `statusMessage` prop |

### 中断行为

- **加载中 Ctrl+C**：取消当前操作，回到输入状态，raw mode 保持
- **空闲双击 Ctrl+C**：第一次 StatusBar 提示"Press Ctrl+C again to exit"，2 秒内第二次→`cleanupTerminal()`→退出
- **`/exit`/`/bye`**：同样走 `cleanupTerminal()` 恢复终端

### 验证

- `bun run typecheck` 零错误
- `bun test` 66 pass / 3 skip / 0 fail

### 参考来源

核心清理顺序借鉴 best-claude-code `/vol4/Agent/best-claude-code/src/utils/gracefulShutdown.ts` 的 `cleanupTerminalModes()`。Deepicode Ink 框架已有的 `detachForShutdown()`、`unmount()`、`drainStdin()`、`instances`、signal-exit 基础设施全部复用。

---

### 配置更新

- `PROVIDERS.zen.models`：标签改为全名（`deepseek-v4-flash-free`、`mimo-v2.5-free`）
- `DeepSeekClient`：支持 `zen-free` 等自定义 model 名映射

---

## Phase 0：脚手架搭建

### Step 0.1 项目初始化

状态：完成

- 初始化 `/vol4/Agent/deepicode` Git 仓库。
- 创建根 `package.json`、`tsconfig.json`、`vitest.config.ts`。
- 使用 Bun 作为运行时。

### Step 0.2 Monorepo 结构

状态：完成

- 创建 `packages/{core,cli,shell,tui,tools,security}`。
- 根脚本：
  - `bun run dev`
  - `bun run typecheck`
  - `bun test`
- 根 `package.json` 已声明 `workspaces: ["packages/*"]`。

### Step 0.3 核心代码迁移

状态：完成

- 核心上下文模块位于 `packages/core/src/context/`：
  - `immutable.ts`
  - `append-log.ts`
  - `scratch.ts`
  - `manager.ts`
  - `message.ts`
- 共享类型位于 `packages/core/src/types.ts`。
- 配置读取位于 `packages/core/src/config.ts`。

### Step 0.4 最小可运行集成

状态：完成

- CLI 入口位于 `packages/cli/src/index.ts`，加载 `packages/cli/src/tui.ts`。
- CLI 已从 readline 替换为 oh-my-pi 差分渲染 TUI（纯 JS 移植版）。
- 支持：
  - TUI 交互模式：`bun run dev`
  - 非 TTY 管道模式：`printf '你好\n' | bun run dev`
  - 帮助信息：`bun run dev --help`

### Phase 0 验收状态

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| 项目可正常启动 | 完成 | `bun run dev --help` 可退出 |
| 一轮简单对话可完成 | 完成 | 已用 CLI 单轮验证 |
| 一次工具调用可完成 | 完成 | `read_file` / `bash` / `edit` 已接入 CLI |
| CoreEngine 接口定义完整 | 部分完成 | 基础接口完成，策略/权限决策仍为空实现 |
| LoopEvent 覆盖计划 role | 部分完成 | 当前未实现 `token_estimate` |
| 展示事件分层 (tool_progress) | 完成 | #9: 工具执行期间 yield `tool_progress` 事件 |
| TypeScript 编译零错误 | 完成 | `bun run typecheck` 通过 |

## Phase 1：核心引擎改造

### Step 1.1 DeepSeekClient 实现

状态：最小完成

- 新增 `packages/core/src/client.ts`。
- 直连 DeepSeek 官方 OpenAI-compatible `POST /chat/completions`。
- 支持 SSE streaming。
- 已解析：
  - `content`
  - `reasoning_content`
  - `tool_calls`
  - `usage`
  - `[DONE]`
  - HTTP / API 错误
- 默认 API 配置：
  - `DEEPSEEK_BASE_URL=https://api.deepseek.com`
  - `DEEPSEEK_MODEL=deepseek-v4-flash`
- `packages/core/src/config.ts` 支持从环境变量或项目根 `api-key` 文件读取 `DEEPSEEK_API_KEY`。

额外完成：

- 429/5xx 指数退避重试（最多 3 次，1s/2s/4s + jitter）
- 引擎 loop 错误恢复：stream 失败后自动重试，连续 3 次失败才终止
- Tool is_error 可见性修复：serialize 时给 tool content 加 `[Error]` 前缀，让模型能感知工具执行失败
- B1 done 事件去重：`finishReasonYielded` 标记防止重复发射 done，engine 端加 `finishedWithToolUse` 防御
- 系统提示词重写：全中文、带环境注入（cwd/platform/date）、todowrite 任务跟踪、核心工作流闭环

### Step 1.2 SegmentedLog 与 Session 持久化

状态：最小完成

- 新增 `packages/core/src/session.ts`。
- 实现：
  - `SegmentedLog` 最小结构：`archive + active`
  - `AsyncSessionWriter`
- session JSONL 写入路径：
  - `.deepicode/sessions/<sessionId>.jsonl`
- 引擎会 best-effort 写入：
  - event
  - messages
  - stats

额外完成：

- #12: `SessionLoader.read()` 从 JSONL 恢复 messages
- `ReasonixEngine.recover()` 静态工厂方法
- `tui.ts` 支持 `--session <id>` CLI 参数

未达到计划完整版的部分：

- `SegmentedLog` 尚未接入主上下文替代 `AppendOnlyLog`。
- 尚未实现原子写入、rewrite、archive、compact 恢复。

### Step 1.3 ContextManager

状态：部分完成

- 已实现三区域组装：
  - `ImmutablePrefix`
  - `AppendOnlyLog`
  - `VolatileScratch`
- `ImmutablePrefix.cacheKey` 使用 SHA-256 稳定 hash。
- `AppendOnlyLog` / `VolatileScratch` / `ImmutablePrefix` 对外返回防御性拷贝，避免外部引用污染内部状态。

额外完成：

- prefix fingerprint 覆盖 toolSpecs 和 fewShots（不限于 system prompt）
- 单元测试覆盖 system / toolSpecs / fewShots 三类变化
- N1 上下文截断：`buildMessages()` 按 user 消息计数截断，保留最近 `maxContextRounds` 轮（默认 20），5 个单测
- #11: `token-estimator.ts` 近似 token 估算（4 chars ≈ 1 token）
- #11: `getFoldDecision()` 实现 65%/75%/80% fold 决策阈值
- `ContextManager` 增加 `estimateTokens()` / `getFoldDecision()` 方法

未完成：

- 增量 token 统计旁路。
- turn-start 估算。
- cache miss 阵痛管理事件。

### Step 1.4 Tokenizer Worker Pool

状态：完成（2026-05-30）

- 新增 `packages/core/src/context/tokenizer-pool.ts`：
  - Worker 线程管理（Bun `Worker` 封装）
  - `Map<taskId, {resolve,reject}>` 实现 O(1) 任务调度
  - 5 秒超时降级：Worker 挂起时自动回退主线程估算
- 新增 `packages/core/src/context/tokenizer-worker.js`：
  - CJK（1.5 chars/token）+ 标点（2 chars/token）+ ASCII（4 chars/token）细化估算
- `ContextManager` 的 `estimateTokens()` / `getFoldDecision()` 升级为 async
- 主线程 fallback：Worker 不可用时自动使用 CHARS_PER_TOKEN=4 近似估算

### Step 1.5 StreamingToolExecutor

状态：最小完成

- 新增 `packages/core/src/streaming-executor.ts`。
- 支持：
  - `shared` 工具并行执行。
  - `exclusive` 工具串行执行。
  - `tool_start` 事件。
  - `tool` / `error` 结果事件。
  - `tool_progress` 事件。
  - 工具结果写回上下文。
  - 工具返回内容保持为字符串。

当前实现策略：

- 稳定优先：在模型 tool call 完整结束后执行工具。
- 尚未做真正 eager dispatch。

未达到计划完整版的部分：

- 尚未实现 AST parser 防 JSON 假闭合。
- 尚未实现边流式参数边提前执行。

### Step 1.6 Tool-call Repair 流水线

状态：完成（2026-05-30）

- 新增 `packages/core/src/context/repair.ts`：
  - **Scavenge**（6 子策略）：提取 `{...}` 块、单引号→双引号、尾逗号清除、包裹 `{}`、闭合花括号、闭合引号
  - **Truncation**：长字符串逐步截尾重试（从末尾减 50 字符）
  - **Storm**：简单 key-value 提取、空对象兜底
- 集成到 `streaming-executor.ts`：JSON.parse 失败后自动调用 repair pipeline
- 所有修复失败时返回标准错误事件（不触发 API 重试）

### Step 1.7 CacheFirstLoop 完整实现

状态：完成（2026-05-30）

- 新增 `packages/core/src/loop.ts` 独立 `runLoop()`：从 `engine.ts` 完整析出
- `engine.ts` 的 `submit()` 简化为 ≈12 行配置 + `yield* runLoop()`
- Fold 集成：
  - 每轮开始时检查 `ctx.getFoldDecision()`
  - `force` 时 yield `status` 警告 + 携带 metadata
  - `suggest` 且 ratio > 75% 时 yield 推荐事件
  - 100ms 超时降级（不阻塞 loop 启动）
- Stream 错误自动重试：连续 3 次失败才终止，中间自动重试

### Phase 1 当前验证状态

| 检查项 | 状态 | 说明 |
| --- | --- | --- |
| DeepSeekClient SSE 解析 | 最小完成 | content/reasoning/tool/usage 可解析 |
| reasoning 分离 | 完成 | 流式事件已分离，历史 round-trip 已实现 |
| SegmentedLog / JSONL | 最小完成 | 追加写 + #12 恢复读 |
| 阈值旁路 | 完成 | #11: 近似 token 估算 + fold 决策阈值 |
| Tokenizer Map 回收 | 完成 | 1.1 Worker Pool + O(1) Map |
| AST 防假闭合 | 未完成 | 当前非 eager dispatch |
| Cache miss 阵痛事件 | 部分完成 | 1.3 loop.ts fold 决策事件 |
| assistant_final 协议边界 | 完成 | 每次模型响应后产出完整 assistant 消息边界 |
| 工具结果顺序确定性 | 完成 | shared 工具并发执行后按声明 index 顺序提交到上下文 |
| prefix fingerprint 覆盖 toolSpecs/fewShots | 完成 | cacheKey 三段组合，4 个单测覆盖三类变化 |
| 核心测试 | 部分完成 | 现有 66 pass / 3 skip |
| Repair Pipeline | 完成 | 1.2 Scavenge/Truncation/Storm |
| Loop 独立拆分 | 完成 | 1.3 loop.ts 从 engine.ts 析出 |
| API 重试 | 完成 | 429/5xx 指数退避 + 引擎 loop 错误恢复 |

## Phase 2：智能推理强度调节系统

状态：未开始

- 尚未实现 strategy 目录。
- 尚未实现 tier config、task classifier、chain estimator、strategy selector。
- `LoopEvent` 中已预留 `strategy_notify` / `strategy_estimate_refined`，但未实际产出。

## Phase 3：壳层增强

### Step 3.0 TUI 接入（拆分到此处）

状态：完成（2026-05-30）

- 复制 best-claude-code 的 Ink 框架（146 文件，~27K 行）到 `packages/ink/`
- 3 处微改适配 deepicode：ThemeProvider（删 `feature('AUTO_THEME')`）、osc.ts（`USER_TYPE` → `false`）、ink.tsx（删 MACRO 注释）
- 适配 FullscreenLayout.tsx（10 处 import 替换为 deepicode 等效模块）
- 精简 fullscreen.ts（~30 行，移除 ant 专属逻辑和 tmux 探测）
- 4 个 stub 文件：ModalContext.ts、promptOverlayContext.tsx、browser.ts、stringUtils.ts
- 新写 7 个 React/JSX 业务组件（~1200 行）：
  - `App.tsx` — 顶层组件，AlternateScreen + FullscreenLayout 包裹，scrollable（Messages + ToolCallBanner + Spinner）+ bottom（PromptInput + StatusBar）
  - `bridge.tsx` — AsyncGenerator<LoopEvent> → React useState 桥接，switch-case 处理 8 种事件类型
  - `DeepiMessages.tsx` — user/assistant/tool 三种角色消息渲染，流式文本增量追加
  - `DeepiPromptInput.tsx` — useInput hook，多行输入 + 历史 + 基本编辑
  - `ToolCallBanner.tsx` — 活跃工具状态行（spinner/✓/✗）
  - `Spinner.tsx` — useAnimationFrame 循环旋转字符 + 计时
  - `StatusBar.tsx` — 单行反转色，provider + model + tokens + 计时
- CLI 入口 `tui.ts` 更新为 `wrappedRender(<App/>)`，不再使用 ProcessTerminal/TUI 类
- 清理旧 TUI 代码（tui.ts、terminal.ts、stdin-buffer.ts、keys.ts、keybindings.ts 及旧 components/ 目录 ~20 个文件）
- `bun run typecheck` 零错误，`bun test` 66 pass / 3 skip

> **注意**：旧 TUI（oh-my-pi 移植版）的 22 项修复记录（ADVICE 第五轮）随旧代码删除而失效。新 TUI 的 23 项审计发现参见 `ADVICE.md` 当前待处理列表。旧修复保留在下文的 ADVICE修复汇总 § 第五轮 TUI 修复中作为历史参考。

未完成：

- 尚无 E2E 测试覆盖 TUI 流程。

### Step 3.2 壳层增强：状态管理 + 多 Agent

状态：完成（2026-05-30）

- `packages/shell/src/state.ts`：`AppState` 类，集中式状态管理（消息/流式文本/推理文本/活跃工具/token 统计/agent/警告/错误），subscribe/notify 发布订阅模式
- `packages/shell/src/index.ts`：导出 `AppState` 及关联类型
- `packages/core/src/agent.ts`：`AGENTS` 预设表（Build Agent 全工具 / Plan Agent 只读）
- `packages/core/src/query-engine.ts`：`QueryEngine` 类，三模式——`stream()` 生成器 / `query()` Promise / `onEvent()` 推送订阅
- `engine.ts`：`switchAgent()` 返回 agent label；`submit()` 接收 AgentConfig 过滤工具集；`getState()` 返回真实 agent 名
- `interface.ts`：`switchAgent()` 返回类型改为 `string`，新增 `getAgentName()`
- TUI：`/agent` 命令切换 build/plan；`/help` 列出 agent；StatusBar 显示 `[agent]`
- `bun run typecheck` 零错误，`bun test` 66 pass / 3 skip

### Step 3.1 TUI 功能增量：Provider 抽象层 + `/model` 命令

状态：完成（2026-05-30）

- `ChatClient` 接口定义于 `interface.ts`，`DeepSeekClient implements ChatClient`（不改实现逻辑）
- `PROVIDERS` 预设表（`config.ts`）：
  - **Zen (Free)**：`baseUrl=https://opencode.ai/zen/v1`，key=`"public"`，模型 `deepseek-v4-flash` / `mimo-v2.5`
  - **DeepSeek**：`baseUrl=https://api.deepseek.com`，需 key，模型 `pro(deepseek-chat)` / `flash(deepseek-v4-flash)`
  - **Mimo**：`baseUrl=https://api.mimo.ai/v1`，需 key，模型 `mimo-v2.5-pro` / `mimo-v2.5`
- `ProviderInfo` 新增 `defaultKey` 字段，Zen 利用此字段硬编码 `"public"` key
- `ProviderModel` 区分 `label`（展示名）和 `model`（API 实际模型 ID）
- 环境变量：`DEEPICODE_PROVIDER` 默认 provider，各 provider 独立 key env（`ZEN_API_KEY` / `DEEPSEEK_API_KEY` / `MIMO_API_KEY`）
- `ModelPicker` 组件（`packages/tui/src/ModelPicker.tsx`）：三步向导（provider 选择 → 可选 key 输入 → 模型选择），`defaultKey` 自动跳过 key 步骤
- `App.tsx` 接入 `/model` 命令，通过 `engine.updateConfig({ provider, model, apiKey, baseUrl })` 即时切换
- `StatusBar.tsx` 实时显示 `provider label / model`
- 输出 `PROVIDERS`、`getApiKeyEnvVar`、`ProviderInfo`、`ProviderModel` 等导出
- `bun run typecheck` 零错误，`bun test` 66 pass

## Phase 4：工具层实现

### Step 4.1 ToolRegistry

状态：最小完成

- 新增 `packages/tools/src/registry.ts`。
- 支持：
  - register
  - get
  - list
  - toToolSpecs

未完成：

- Agent 过滤。
- Deny rules 过滤。
- 与 security 层联动。

### Step 4.2 Hash-Anchored Edit

状态：完成

- 新增 `packages/tools/src/hash-edit.ts`。
- 使用 `createReadStream` / `createWriteStream` 实现流式替换。
- 临时文件后缀使用 `randomUUID()` 替代 `Date.now()` 避免碰撞（B4）。
- N3 临时文件泄漏修复：try-finally 包裹 + `tmpCreated` 标记追踪。
- #7 oldHash 校验：可选参数，传入时验证 `sha256(oldString) === oldHash`，不匹配不写入。
- 6 个单测覆盖精确替换、多行替换、未找到、hash 匹配/不匹配、空字符串。

### Step 4.3 9-Pass Fuzzy Edit

状态：完成

- 新增 `packages/tools/src/fuzzy-edit.ts`。
- 完整 9-pass：
  1. exact — 精确匹配（多 occurrence 时取最后一次）
  2. trimmed_full — 整体 trim
  3. trimmed_lines — 每行右 trim
  4. trimmedBoundary — 每行左右 trim
  5. blockAnchor — 首尾锚点行定位
  6. contextAware — 上下文锚点 + 近似中间行
  7. escapeNormalized — 转义序列归一化
  8. flexible_whitespace — 灵活空白（最激进）
  9. multiOccurrence — 多匹配时取最后一次
- B5 修复：flexible_whitespace pass 改为按 whitespace 分段转义后 join `\s+`
- 9 个单测覆盖每个 pass

### Step 4.4 Stale-read Validation

状态：完成（2026-05-29）

- 新增 `packages/tools/src/stale-read.ts`。
- 模块级 `ReadTracker` 追踪文件路径 → `{mtimeMs, size}`。
- `read_file` 成功读取后调用 `recordRead()` 记录。
- `edit` 执行前调用 `checkStale()`，mtime/size 变化则返回 `{isError: true}`，提示先 re-read。
- 不校验从未 read 过的文件（兼容 CLI 等外部写入场景）。
- N4 修复：`ReasonixEngine` 构造时通过回调 `clearReadTracker()`，避免全局状态跨会话污染。

### Step 4.5 基础工具集

状态：部分完成

- 新增：
  - `packages/tools/src/file-ops.ts`
  - `packages/tools/src/shell-exec.ts`
  - `packages/tools/src/edit.ts`
  - `packages/tools/src/write-file.ts`
  - `packages/tools/src/list-dir.ts`
  - `packages/tools/src/grep.ts`
  - `packages/tools/src/todowrite.ts`
- 已实现并在 CLI 注册：
  - `read_file` / `write_file` / `edit` / `bash` / `list_dir` / `grep` / `todowrite`
- CLI 已修复工具结果展示：tool call 后会显示 bash stdout/stderr、read_file 内容、edit 结果。

额外完成：

- 工具参数运行时校验（shell-exec / file-ops / edit）
- B3: bash cwd 参数使用 `resolve(ctx.cwd, args.cwd)` 解析相对路径
- D1: SENSITIVE_FILE_PATTERNS 提取到 `packages/tools/src/sensitive.ts` 共享使用
- D2: edit.ts 补上 `known_hosts` 敏感文件保护
- D3: `getState()` 改为参数化接口，可传入实际 streaming 状态

## 第九轮：安全层实现（PermissionEngine + HookManager + FileSnapshot，2026-05-30）

- `packages/security/src/permission.ts`：Deny-first 三级权限判定引擎
- `packages/security/src/hooks.ts`：beforeToolCall / afterToolCall / onLoopEvent 三个 Hook 点
- `packages/security/src/snapshot.ts`：`.deepicode_patches/` Git 风格文件快照与毫秒级恢复
- 集成到 streaming-executor.ts（执行前权限检查）和 engine.ts（构造时创建实例，submit 中 onLoopEvent）
- `bun run typecheck` 零错误，`bun test` 66 pass / 3 skip

## 第十轮：壳层增强 + 多 Agent（AppState + QueryEngine + Build/Plan Agent，2026-05-30）

- `packages/shell/src/state.ts`：`AppState` 类，集中式状态管理（消息/流式文本/推理文本/活跃工具/token/agent/警告/错误），subscribe/notify 发布订阅
- `packages/core/src/agent.ts`：`AGENTS` 预设表——**Build Agent**（全工具：bash/read/write/edit/list_dir/grep/todowrite）+ **Plan Agent**（只读：read/list_dir/grep/todowrite）
- `packages/core/src/query-engine.ts`：`QueryEngine` 类，`stream()` 生成器 + `query()` Promise + `onEvent()` 推送三模式
- `engine.ts`：`switchAgent()` 实现 + `submit()` 使用 AgentConfig 过滤工具集 + `getState()` 返回真实 agent 名
- `interface.ts`：`switchAgent()` 返回 string + 新增 `getAgentName()`
- TUI 集成：`/agent` 命令切换 build/plan、`/help` 列出可用 agent、StatusBar 显示 `[agent]`
- `bun run typecheck` 零错误，`bun test` 66 pass / 3 skip

## Phase 5：安全层实现

### 最小安全基线（工具内联实现）

状态：完成（2026-05-29）

在 security 包完整之前，已在工具层实现最小安全保护：

- **bash denylist** — 阻止 `rm -rf /`、`sudo`、`mkfs`、`dd`、`fdisk`、`chmod -R 777 /` 等危险命令
- **read_file 路径保护** — 拒绝读取 `api-key`、`.env`、私钥文件、`.git/` 等敏感文件；基于 `ctx.cwd` resolve 相对路径；超过 10MB 的文件拒绝读取；不存在文件返回结构化错误
- **edit 路径保护** — 同 read_file 的敏感文件拒绝策略
- **参数校验** — shell-exec / file-ops / edit 三个工具入口先校验必填字段类型，不合格直接返回 `{ isError: true }`
- **Session writer 错误吞没** — `flushSoon` catch 写入错误，避免未处理 rejection

### Step 5.1 正式权限引擎 + Hooks + Git Snapshot

状态：完成（2026-05-30）

- `@deepicode/security` 包实现，`packages/security/src/` 三个模块：
  - **`permission.ts`** — `PermissionEngine` 类，三级判定：Deny 规则优先 → Allow 规则 → 默认 Ask（exec tier）/ Allow（read/write tier）。规则支持按 tool name（string/RegExp）和 args 模式匹配。
  - **`hooks.ts`** — `HookManager` 类，`beforeToolCall`（可返回 deny/allow 拦截）、`afterToolCall`（执行后回调）、`onLoopEvent`（事件观察）三个 Hook 点。
  - **`snapshot.ts`** — `FileSnapshot` 类，`.deepicode_patches/` 目录，`snapshot(filepath)` 保存原始内容，`revert(filepath)` 毫秒级恢复，SHA256 路径索引。
- 集成：
  - `streaming-executor.ts`：`PermissionEngine.decide()` 在 `handler.execute()` 前调用；"deny" 返回错误事件；"ask" 触发 `beforeToolCall` 钩子，无钩子自动 deny。
  - `engine.ts`：构造时创建 `permissionEngine` 和 `hookManager` 实例；`submit()` 中每个 loop event 触发 `onLoopEvent` 钩子。
  - tsconfig.json 添加 `@deepicode/security` 路径映射。
- `bun run typecheck` 零错误，`bun test` 66 pass / 3 skip

## Phase 6：高级功能生态接入

状态：未开始

- 尚未实现 TTSR、LSP、MCP、Python Kernel、Universal Config Discovery。

## Phase 7：集成测试与调优

状态：未开始

- 尚未实现 E2E 测试矩阵。
- 尚未实现性能基准、计费校准、长会话压测、发版文档。

## 当前测试结果

最近一次验证：

```bash
bun run typecheck
bun test
```

结果：

- `bun run typecheck`：通过。
- `bun test`：66 pass / 3 skip / 0 fail（Phase 1.1~1.3 后测试依然全绿）。

测试文件：

- `packages/core/__tests__/context.test.ts`
- `packages/core/__tests__/engine-tools.test.ts`
- `packages/core/__tests__/integration.test.ts`（默认 skip）
- `packages/core/__tests__/tools-regression.test.ts`
- `packages/tools/__tests__/edit.test.ts`（新增）

## 关键设计决策

| 决策 | 当前选择 | 说明 |
| --- | --- | --- |
| 运行时 | Bun | Deepicode 当前以 Bun 脚本运行 |
| API 提供商 | DeepSeek 官方 | 默认 `https://api.deepseek.com` |
| 模型 | `deepseek-v4-flash` | 可用 `DEEPSEEK_MODEL` 覆盖 |
| API key | env 优先，其次 `api-key` 文件 | `api-key` 已加入 `.gitignore` |
| API 重试 | 指数退避（最多 3 次） | 429/502/503 自动重试，400/401 直接报错 |
| 核心事件 | `AsyncGenerator<LoopEvent>` | CLI 逐事件消费 |
| 工具执行 | shared 并行 / exclusive 串行 | 当前稳定优先（完整 tool call 后执行）；Eager Dispatch 设计已确定（见下） |
| 会话持久化 | JSONL best-effort append | 写入 `.deepicode/sessions/`，不阻塞主流程 |
| 当前 CLI | Ink render（wrappedRender） | `@deepicode/ink` 框架接管终端，AsyncGenerator → React state 桥接 |
| Eager Dispatch | 分级策略（设计已确定，待实现） | 读操作（`isConcurrencySafe`）buffer 完整即刻执行；写操作等 `finish_reason` 确认。收益最大化（读占 90%+ 调用），风险为零（写走保守路径） |
| TUI 技术选型 | Ink 框架（复制 best-claude-code） | 146 文件 / ~27K 行，React + flexbox + 渲染器，已验证在 Bun 上运行 |

## Phase 1.5：事件体系

### #9. 展示事件与协议事件分层

状态：完成（2026-05-29）

- `interface.ts` 新增 `tool_progress` 事件角色
- `streaming-executor.ts` 在工具执行前/后 yield `tool_progress` 事件
- `tui.ts` 展示 `[tool] <name> ...` 进度提示

## N2. 工具输出非 UTF-8 乱码检测 + safeStringify

状态：完成（2026-05-29）

- 新增 `packages/tools/src/safe-stringify.ts`：
  - `safeStringify(obj, maxLen)` — try-catch + 200K 截断
  - `hasBinaryEncoding(s)` — 检测 `\uFFFD` 占比 > 5%
- `shell-exec.ts` 在输出中检测编码警告
- 所有 7 个工具文件的 `JSON.stringify` 替换为 `safeStringify`

## #11. Token 估算与 fold 决策

状态：完成（2026-05-29）

- 新增 `packages/core/src/context/token-estimator.ts`：
  - `estimateTokens(messages)` — 4 chars ≈ 1 token 近似估算
  - `getFoldDecision(used, total)` — <65% none, 65-75% suggest, 75-80% suggest (warn), >80% force
- `ContextManager.estimateTokens()` / `getFoldDecision()`
- `config.ts` 增加 `contextWindow` 配置（默认 128K）

## #12. Session 恢复

状态：完成（2026-05-29）

- `session.ts` 新增 `SessionLoader.read(sessionId)` — 从 JSONL 恢复 ChatMessage[]
- `engine.ts` 新增 `ReasonixEngine.recover(config, sessionId)` 静态工厂
- 构造器可选 `sessionId` 参数
- `tui.ts` 支持 `--session <id>` CLI 参数

## ADVICE.md 修复汇总

以下 63 项修复已全部完成并记录于此（2026-05-29 ~ 2026-05-30）。修复内容原列于 ADVICE.md，TUI 重构后迁移至 DONE.md。

### 核心引擎 + 工具层修复（前四轮）

| 编号 | 问题 | 修复文件 | 修复方式 |
|------|------|----------|----------|
| B1 | done 事件重复 → 工具循环提前终止 | `client.ts` / `engine.ts` | finishReasonYielded 标记 + finishedWithToolUse 防御 |
| B2 | 缺少 write_file 工具 | `write-file.ts` (新增) | 创建新文件/覆盖已有文件，敏感路径保护 |
| B3 | bash cwd 未基于 ctx.cwd resolve | `shell-exec.ts` | 增加 `resolve(ctx.cwd, args.cwd)` |
| B4 | hash-edit 临时文件碰撞 | `hash-edit.ts` | `Date.now()` → `crypto.randomUUID()` |
| B5 | fuzzy-edit 正则转义耦合 | `fuzzy-edit.ts` | 改为 `split(/\s+/)` 分段转义后 join |
| C1 | 缺少 list_dir/grep/todowrite | 新增 3 个工具文件 | 结构化目录列表、rg/grep 搜索、任务跟踪 |
| D1 | SENSITIVE_FILE_PATTERNS 三处重复 | `sensitive.ts` (新增) | 提取到共享模块，3 个工具统一引用 |
| D2 | edit.ts 缺 known_hosts 保护 | `edit.ts` | 补上 `known_hosts` 模式 |
| D3 | getState() 硬编码默认值 | `engine.ts` | 改为参数化接口 |
| N1 | 上下文无界增长 → 会话硬终止 | `context/manager.ts` / `config.ts` | buildMessages() 按 user 消息计数截断（默认 20 轮） |
| N3 | hash-edit 临时文件泄漏 | `hash-edit.ts` | try-finally + tmpCreated 标记 |
| N4 | stale-read 全局状态跨会话污染 | `engine.ts` / `tui.ts` | 构造函数回调 clearReadTracker() |
| P0-1 | grep 命令注入 | `grep.ts` | execSync → spawnSync 传参数组 |
| P0-2 | write_file 无 mkdir | `write-file.ts` | 增加 mkdir(dirname, recursive) |
| P1-1 | 截断破坏 tool 消息对 | `context/manager.ts` | 截断后向前扫描配对 |
| P1-2 | multiOccurrence 歧义 | `fuzzy-edit.ts` | 拒绝猜测，返回 null |
| P1-3 | interrupt 延迟 | `engine.ts` | error 路径检查 _interrupted |
| P2-1 | shell-exec 截断无提示 | `shell-exec.ts` | 追加 truncated 说明 |
| P2-2 | sessionId 碰撞 | `engine.ts` | Date.now() → randomUUID() |
| P2-3 | SSE JSON 解析静默丢失 | `client.ts` | DEEPICODE_DEBUG 日志 |
| P2-4 | list-dir stat 失败 type 误导 | `list-dir.ts` | file → unknown（v2 改为 type: "unknown"） |
| P2-5 | sleep 监听器泄漏 | `client.ts` | timer 完成时 removeEventListener |
| P2-6 | 死代码分支 | `engine.ts` | 增加防御性注释 |
| P1-1 | finish_reason 不一致 | `client.ts` / `engine.ts` | 提取 `isToolUseFinishReason` 共享函数 |
| P1-2 | 空 toolCalls 死循环 | `engine.ts` | empty guard + yield warning |
| P1-3 | token-estimator 忽略 reasoning | `token-estimator.ts` | 加入 reasoning_content 估算 |
| P2-1 | read_file 截断无提示 | `file-ops.ts` | 追加 truncation notice |
| P2-2 | list-dir 标记未知为 file | `list-dir.ts` | type 扩展为 `"unknown"` |
| P2-5 | SegmentedLog 死代码 | `session.ts` | 删除类定义 |

此外：
- 系统提示词重写：全中文、环境注入、todowrite 任务跟踪、7 工具指南、闭环工作流
- `grep` 工具回退机制修复：rg 不可用时 grep `--include` 参数格式错误
- #7: hash-anchored edit 增加 oldHash 参数校验，6 个单测
- #8: 9-pass fuzzy edit 完整实现（新增 5 pass），9 个单测
- 清理 `sessionCounter` 全局变量（engine.ts）
- N2: 所有工具的 JSON.stringify → safeStringify（7 文件，20+ 调用点）
- #9: tool_progress 事件分层（interface/executor/tui）
- #11: token 估算与 fold 决策（token-estimator.ts + ContextManager）
- #12: session JSONL 恢复（SessionLoader + Recover 工厂）
- reasoning_content 不入上下文：client.ts 不再回传 + engine.ts 三处 log.append 不再写入
- P1-1: `isToolUseFinishReason` 共享函数，client.ts + engine.ts 统一 5 种 finish_reason 判断
- P1-2: engine.ts 空 toolCalls 死循环保护（yield warning + break）
- P1-3: token-estimator 加入 reasoning_content 估算
- P2-1: read_file 截断追加 `[truncated: N more chars]` 提示
- P2-2: list-dir stat 失败标记为 `"unknown"` 类型（扩展 type 联合）
- 第四轮 ADVICE 修复（P2×4 + P3×3）：
  - P2-4-1: Session 恢复过滤 system 消息，避免双 system → prefix-cache 失效
  - P2-4-2: AsyncSessionWriter.enqueue 加 try-catch，防止不可序列化 payload 中断事件流
  - P2-4-3: streaming-executor shared 路径 tool_progress(running) 提前到 Promise.all 前
  - P2-4-4: refinedEstimate 抽取为共享函数，tokenizer Worker 与主线程估算统一
  - P3-4-1: apiCalls 计数从 usage 移到 done 事件（每轮一次）
  - P3-4-3: todowrite 增加 todo 项运行时结构校验
  - P3-4-4: sensitive.ts 补充 .env.*/证书/npmrc/AWS 凭证等 8 个模式
- P2-5: 删除 session.ts 中 SegmentedLog 死代码类
- 1.1: Tokenizer Worker Pool（tokenizer-pool.ts + tokenizer-worker.js）
- 1.2: Tool-call Repair 流水线（repair.ts Scavenge/Truncation/Storm）
- 1.3: CacheFirstLoop 拆分（loop.ts 独立 + fold 决策事件）
- TUI 接入（Ink 框架）：
  - 复制 Ink 框架（146 文件 / ~27K 行）到 `packages/ink/`，3 处微改（ThemeProvider、osc.ts、ink.tsx）
  - 适配 FullscreenLayout.tsx（10 处 import 替换）+ 精简 fullscreen.ts（~30 行）
  - 4 个 stub 文件（ModalContext、promptOverlayContext、browser、stringUtils）
  - 7 个业务组件：bridge.tsx（AsyncGenerator → React state）、DeepiMessages.tsx（消息渲染）、DeepiPromptInput.tsx（输入框）、ToolCallBanner.tsx（工具进度）、Spinner.tsx（加载动画）、StatusBar.tsx（状态栏）、App.tsx（顶层组件）
  - CLI 入口更新为 Ink render（`wrappedRender` + React.createElement）
  - 清理旧 TUI 代码（tui.ts、terminal.ts、components/ 目录等 ~20 个文件）
  - 集成：bridge.tsx 事件桥接 + CLI 替换 readline

> **旧 TUI 修复失效说明**: 第五轮 TUI 修复(22 项)针对 oh-my-pi 自研 TUI 的旧代码(bridge.ts/chat-view.ts/tool-call-view.ts 等类组件),这些文件已整体删除并替换为 Ink/React 架构。旧修复记录保留在下方 ADVICE修复汇总 E5 中作历史参考。新 TUI 代码质量由 2026-05-30 DecipecodeTUIReAudit 审计(23 项,见 ADVICE.md)。

## 已知限制

- `token_estimate` 事件尚未产出（#11 提供了 ContextManager 接口，未接入 loop event）。

## 第七轮修复：TUI 审计修复（2026-05-30，共 22 项）

---

## ✅ 已修复（2026-05-30 第七轮）

| # | 问题 | 修复方式 |
|---|------|----------|
| TUI-P0-1 | tool_progress 硬编码 `status: 'running'` | `bridge.tsx`：tool_progress 检查 content，`done` 时不回退 |
| TUI-P1-1 | error/warning 状态不渲染 | `App.tsx`：scrollable 区域底部添加 error/warning 显示 |
| TUI-P1-2 | Token 统计永远 ↑0 ↓0 | `loop.ts`：yield usage 事件 → `bridge.tsx` 累加到 tokens state |
| TUI-P1-3 | 同名工具状态更新歧义 | `bridge.tsx`：改为 `toolCallIndex` 精确匹配 |
| TUI-P1-4 | reasoning_delta 完全忽略 | `bridge.tsx`：追踪 reasoningText → `DeepiMessages.tsx` 显示 reasoning 行 |
| TUI-P1-5 | cursorPos closure 陈旧 | `DeepiPromptInput.tsx`：改用 `useRef` 存储光标位置 |
| TUI-P2-1 | tool_call_delta 事件忽略 | `bridge.tsx`：添加 case |
| TUI-P2-2 | status 事件忽略 | `bridge.tsx`：非 interrupt/tools_completed 的状态作为 warning 显示 |
| TUI-P2-3 | done 事件未被明确处理 | `bridge.tsx`：添加 case（空处理，finally 已负责清理） |
| TUI-P2-4 | warning 与 error 状态混淆 | `bridge.tsx`：warning 改为独立 `warnings[]` 数组 |
| TUI-P2-5 | Pipe 模式 error 输出到 stdout | `cli/src/tui.ts`：error/warning 改用 `errorOutput` (stderr) |
| TUI-P2-6 | Pipe 模式缺事件处理 | `cli/src/tui.ts`：添加 reasoning_delta / tool_call_delta / tool_progress / status / warning |
| TUI-P2-7 | 输入框无光标 | `DeepiPromptInput.tsx`：在输入位置渲染 `▊` 光标 |
| TUI-P2-8 | 快捷键缺失 | `DeepiPromptInput.tsx`：添加 Ctrl+D / Ctrl+U / Ctrl+K / Home / End / Ctrl+A / Ctrl+E |
| TUI-P2-9 | /exit 不优雅 | `App.tsx`：interrupt() + 延迟 300ms 退出 |
| TUI-P3-2 | CLAUDE_CODE 环境变量前缀 | `fullscreen.ts`：兼容 `DEEPCODE_NO_FLICKER` / `DEEPCODE_DISABLE_MOUSE` |
| TUI-P3-4 | StatusBar 无 flex 分隔 | `StatusBar.tsx`：添加 `<Box flexGrow={1} />` 分隔 |
| TUI-P3-6 | Pipe 模式 done 重复换行 | `cli/src/tui.ts`：移除 done case 的 `output.write("\n")` |
| TUI-P3-7 | messages 用 index 作 React key | `DeepiMessages.tsx`：改为 `role + index + content 前缀` 组合 key |
| TUI-P3-8 | Tool 消息截断无提示 | `DeepiMessages.tsx`：`slice(0, 200) + '...'` |
| TUI-P3-3 | 非全屏无滚动容器 | `FullscreenLayout.tsx`：非全屏路径也包 ScrollBox |
| P3-4-2 | prefix.build 每次 submit 无短路 | `engine.ts`：计算 cacheKey，未变化时跳过 rebuild |

---

## 持续关注（低风险，不建议立即改动）

| # | 问题 | 理由 |
|---|------|------|
| 1 | Stale-read TOCTOU 窗口 | 毫秒级窗口，atomic rename + exclusive 并发 |
| 2 | Session JSONL 崩溃一致性 | best-effort 设计 |
| 3 | Bash 命令绕过 | 黑名单永远有绕过 |
| 4 | Fuzzy Edit flexible_whitespace 误匹配 | 前 7 pass 约束 |
| 5 | Prompt 注入 | system prompt 声明即可 |
| 6 | 设计文档功能缺口 | Phase 2 未实现 |
| 7 | P3-4-5 fold 竞态孤儿 tokenizer | pool 5s 超时自动清理 |
| 8 | TUI-P3-1 Help 消息硬编码 | 不影响功能，后续扩展 `/model` 时自然解决 |
| 9 | TUI-P3-5 promptOverlayContext 空占位 | MVP 不需要斜杠命令建议 |

---

## 驳回

| 来源 | 原描述 | 驳回理由 |
|------|--------|---------|
| v2 | P0-1 reasoning_content | 已改为不入上下文 |
| v2 | P1-4 hash-edit sha256 重复 | indexOf 已保证精确匹配 |
| v2 | P1-5 computeFingerprint 工具顺序 | 不跨 session 持久化 |
| v2 | P1-6 fuzzy fallback 未 re-check stale | fuzzy 路径重新 readFile |
| Audit | NEW-P2-1 flushSoon 竞态 | 自身降级为低风险 |
| Audit | NEW-P2-4~7 | 不适用/不影响 |
| 第四轮 | NEW-3/4 | 不触发/已等价完成 |

---

## 总览

| 级别 | 数量 |
|------|------|
| ✅ 已修复 | 22（本轮） |
| ⬜ 关注 | 9 |
| ✅ 已修复（移入 DONE.md） | 63 |
| ❌ 驳回 | 11 |
