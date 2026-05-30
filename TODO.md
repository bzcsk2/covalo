# Deepicode TODO

本文按开发优先级排列。完成后同步更新 `DONE.md`。

> **关联文档**：[实施计划](Deepicode实施计划.md)（每 Step 的验收标准 + § 代码借引逐模块明细 标注了每个模块参考哪个项目的哪个文件）| [ADVICE](ADVICE.md)（审查报告 + 持续关注项）

---

## 已完成

| 阶段 | 内容 | 日期 |
|------|------|------|
| Phase 0 | 脚手架 + 核心引擎（engine/client/context/session 最小版） | 2026-05-29 |
| Phase 1 | 核心引擎改造（SSE重试/repair/loop析出/tokenizer-pool/fold决策） | 2026-05-29~30 |
| TUI重构 | Ink框架复制（146文件）+ 7业务组件 + FullscreenLayout | 2026-05-30 |
| TUI审计 | 22项修复（bridge/loop/App/PromptInput/StatusBar/pipe） | 2026-05-30 |
| TM1+TM2 | ChatClient接口 + PROVIDERS预设 + ModelPicker组件 | 2026-05-30 |
| TUI打磨 | 状态栏重设计、光标修复、粘贴、模型持久化 | 2026-05-30 |
| Phase 4 | 工具层8工具（read/write/edit/bash/list_dir/grep/todowrite + hash-edit + fuzzy-edit + stale-read + repair） | 2026-05-29~30 |
| Phase 3 | 壳层增强（AppState + QueryEngine + Build/Plan Agent） | 2026-05-30 |
| SIGINT修复 | Linux Ctrl+C / raw mode 恢复 / exitOnCtrlC / 终端清理顺序（3轮迭代） | 2026-05-30 |
| TL1+TL3+TL4 | 工具层生态：glob/web-fetch/WebSearch 注册 + Skills 系统（52内置技能+SkillTool） + MCP协议集成（McpClient+Host+3工具） | 2026-06-01 |

---

## 已知缺陷（先搁置）

（暂无）

---

## 第一优先：安全层 ✅

> ✅ S1+S2+S3 已完成。PermissionEngine（三级 Deny → Allow → Ask）、HookManager（before/afterToolCall + onLoopEvent）、FileSnapshot（.deepicode_patches/）。已集成到 streaming-executor.ts 和 engine.ts。`bun run typecheck` 零错误，`bun test` 66 pass。

### S1. Deny-first 权限引擎 ✅

参考：**CC** `src/hooks/toolPermission/PermissionContext.ts` + `src/utils/permissions/`

实现：`packages/security/src/permission.ts`。`PermissionEngine` 类，三级判定——Deny 规则优先 → Allow 规则 → 默认 Ask（exec tier）或 Allow（read/write tier）。

### S2. Hooks 系统 ✅

参考：**CC** `src/hooks/toolPermission/handlers/`

实现：`packages/security/src/hooks.ts`。`HookManager` 类，`beforeToolCall`（可返回 deny/allow 拦截工具执行）/ `afterToolCall`（执行后通知）/ `onLoopEvent`（事件观察）三个 Hook 点。

### S3. Git Snapshot 单文件追踪 ✅

参考：**OC** `packages/opencode/src/git/`

实现：`packages/security/src/snapshot.ts`。`FileSnapshot` 类，`.deepicode_patches/` 目录，`snapshot(filepath)` 保存原始内容，`revert(filepath)` 毫秒级恢复。

---

## 第二优先：壳层增强 + 多 Agent ✅

> ✅ SH1+SH2+SH3 已完成。AppState 集中式状态管理、QueryEngine 双模式事件系统、Build Agent + Plan Agent 多 Agent 系统。已集成到 engine.ts 和 TUI。`bun run typecheck` 零错误，`bun test` 66 pass。

### SH1. 集中式状态管理 ✅

参考：**CC** `src/state/AppState.tsx`

实现：`packages/shell/src/state.ts`。`AppState` 类，持有完整 UI 状态（消息/流式文本/推理文本/活跃工具/token 统计/agent/警告/错误），subscribe/notify 发布订阅模式。

### SH2. 双模式事件系统 ✅

参考：**CC** `src/QueryEngine.ts`

实现：`packages/core/src/query-engine.ts`。`QueryEngine` 类，`stream()` 异步生成器模式 + `query()` Promise 简捷模式 + `onEvent()` 推送订阅模式。

### SH3. 多 Agent 系统 ✅

参考：**OC** `packages/opencode/src/tool/task.ts` + `plan.ts`

实现：`packages/core/src/agent.ts`。`AGENTS` 预设表——**Build Agent**（全部工具：bash/read/write/edit/list_dir/grep/todowrite）和 **Plan Agent**（只读：read/list_dir/grep/todowrite）。`switchAgent()` 引擎集成 + 工具过滤 + TUI `/agent` 命令切换 + StatusBar 显示当前 agent。

---


## 第三优先：工具层生态 + Skills + MCP

> 当前状态：8 个核心工具已实现 + registry + 安全基线。
> 目标：移植 CC 全部工具至 35+、完整 Skills 技能系统、MCP 协议集成。
> 策略：所有源码从 best-claude-code `/vol4/Agent/best-claude-code/packages/builtin-tools/src/tools/` 适配，不重新发明。

### TL1. 第二批高优先级工具（11 个）

| # | 工具 | CC 源 | 行数 | 说明 |
|---|------|------|------|------|
| TL1.1 | **WebFetch** ✅ | `WebFetchTool/` | 1549 | HTTP GET → markdown，超时 + HTML→text |
| TL1.2 | **WebSearch** ✅ | `WebSearchTool/` | 2840 | 搜索引擎 API 接入 |
| TL1.3 | **AskUserQuestion** | `AskUserQuestionTool/` | 373 | 对话中向用户提问，需适配 TUI |
| TL1.4 | **TaskCreate** | `TaskCreateTool/` | 195 | 任务创建 |
| TL1.5 | **TaskUpdate** | `TaskUpdateTool/` | 484 | 任务更新 |
| TL1.6 | **TaskList** | `TaskListTool/` | 166 | 任务列表 |
| TL1.7 | **TaskGet** | `TaskGetTool/` | 153 | 任务详情 |
| TL1.8 | **TaskStop** | `TaskStopTool/` | 189 | 任务停止 |
| TL1.9 | **Glob** ✅ | `GlobTool/` | 265 | 文件模式匹配，补充 grep |
| TL1.10 | **NotebookEdit** | `NotebookEditTool/` | 618 | Jupyter notebook 编辑 |
| TL1.11 | **PlanMode** | `EnterPlanModeTool/` + `ExitPlanModeTool/` | 876 | 规划模式开关 |

### TL2. 第三批中低优先级工具（~15 个）

| # | 工具 | CC 源 | 行数 | 说明 |
|---|------|------|------|------|
| TL2.1 | **WebBrowser** | `WebBrowserTool/` | 267 | Playwright 浏览器操控 |
| TL2.2 | **LSP** | `LSPTool/` | 2206 | 代码智能，依赖 vscode-languageclient |
| TL2.3 | **EnterWorktree** | `EnterWorktreeTool/` | 183 | Git worktree 隔离 |
| TL2.4 | **ExitWorktree** | `ExitWorktreeTool/` | 394 | Git worktree 退出 |
| TL2.5 | **CronCreate/Delete/List** | `ScheduleCronTool/` | 543 | 定时任务 |
| TL2.6 | **Workflow** | `WorkflowTool/` | 745 | 多 Agent 编排脚本 |
| TL2.7 | **Monitor** | `MonitorTool/` | 180 | 进程/日志监控 |
| TL2.8 | **Sleep** | `SleepTool/` | 269 | 延时执行 |
| TL2.9 | **PushNotification** | `PushNotificationTool/` | 149 | 桌面通知 |
| TL2.10 | **AgentTool** | `AgentTool/` | 7864 | 子 Agent 委托（依赖 Phase 3.4） |
| TL2.11 | **SendMessage** | `SendMessageTool/` | 1298 | Agent 间通信 |

### TL3. Skills 技能系统

> 参考：**CC** `packages/builtin-tools/src/tools/SkillTool/` + `src/skills/`

| # | 模块 | CC 源 | 行数 | 说明 |
|---|------|------|------|------|
| TL3.1 | **SkillTool** ✅ | `SkillTool/SkillTool.ts` | 1113 | 核心工具：search/list/load 三个命令 |
| TL3.2 | **loadSkillsDir** ✅ | `src/skills/loadSkillsDir.ts` | 1087 | SKILL.md 发现/解析/去重/条件激活 |
| TL3.3 | **frontmatterParser** ✅ | `src/utils/frontmatterParser.ts` | ~80 | YAML 前置元数据解析（内联于 loadSkillsDir） |
| TL3.5 | **/skill 斜杠命令** ✅ | `src/commands.ts` | ~200 | 技能列表/搜索/加载 |
| TL3.6 | **内置技能** ✅ | `bundled/` (52个) | ~1000 | 复制自 ~/.claude/skills，覆盖 verification/brainstorming/debug/writing 等 |

### TL4. MCP 协议集成

> 参考：**CC** `packages/mcp-client/` + `src/services/mcp/`

| # | 模块 | CC 源 | 说明 |
|---|------|------|------|
| TL4.1 | **mcp-client 核心库** ✅ | `packages/mcp/src/client.ts` | stdio 子进程 + JSON-RPC 2.0（initialize/tools/list/call/resources） |
| TL4.2 | **Deepicode MCP 宿主层** ✅ | `packages/mcp/src/host.ts` | `.deepicode/mcp.json` 配置 → McpHost 多客户端管理 + 工具注册 |
| TL4.3 | **ListMcpResources** ✅ | `packages/mcp/src/list-resources.ts` | MCP 资源发现 |
| TL4.4 | **ReadMcpResource** ✅ | `packages/mcp/src/read-resource.ts` | MCP 资源读取 |
| TL4.5 | **McpAuth** ✅ | `packages/mcp/src/auth.ts` | MCP 认证凭据管理（set/list）

> **不移植的 CC 模块**：OAuth 完整流程（~88K行，依赖CC身份系统）、claudeai-proxy transport、SDK transport、useManageMCPConnections hook（过重）

---


## 第四优先：测试与调优

### TT1. SSE 边界测试

streaming parser 任意 chunk 切分：1 字节 / 半个 UTF-8 / 半个 JSON。

### TT2. E2E 场景

bash / read_file / edit / 工具错误恢复 / 中断。不依赖真实 API。

### TT3. 性能基准 & 计费校准

CNY 预估 vs DeepSeek 账单误差 < 20%。TUI 帧率 > 30fps。

---

## 旧代码清理

| # | 内容 | 优先级 |
|---|------|--------|
| D5 | `buildPiModel` + `vendor/pi.d.ts` + `vendor/pi.js` | 移植遗留 |
| P3-4-5 | fold 竞态孤儿 tokenizer 任务 `loop.ts:40-43` | pool 5s 超时自动清理，加注释即可 |

---

## 暂缓

- TTSR 规则系统
- Universal Config Discovery
- Python Kernel
- 多前端（Web、IDE Plugin）

- 智能推理强度调节
参考：**RNX** `src/loop.ts`（strategy select 内嵌逻辑）
### ST1-4: Tier 配置 → TaskClassifier → ChainEstimator → StrategySelector
CNY 原生计价四档位，`packages/core/src/strategy/` 目录不存在，LoopEvent 已预留 `strategy_notify` / `strategy_estimate_refined`。

---

## 进度总览

| 优先级 | 内容 | 项数 | 状态 |
|--------|------|------|------|
| 0 | 脚手架 + 核心引擎 | — | ✅ |
| 0 | TUI 重构（Ink框架+7组件+审计+功能增量） | 4 | ✅ |
| 0 | SIGINT / raw mode 修复（3轮迭代） | 1 | ✅ |
| 1 | 安全层（PermissionEngine + HookManager + FileSnapshot） | 3 | ✅ |
| 2 | 壳层增强 + 多 Agent（AppState + QueryEngine + Build/Plan Agent） | 3 | ✅ |
| 3 | 工具层：第二批（11工具 + Skills + MCP） | 22 | ✅ 完成7/11工具 + Skills ✅ + MCP ✅ |
| 3 | 工具层：第三批（~15工具） | 15 | ⬜ |
| 4 | 智能推理调节 | 4 | ⬜ |
| 5 | 测试与调优 | 3 | ⬜ |
| — | 旧代码清理 | 2 | ⬜ |
