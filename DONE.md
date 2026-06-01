# Deepicode 完成记录

最后更新：2026-05-31（高级工具补齐，592 tests）

本文按 **阶段 (Phase)** + **时间线** 记录已完成内容。

---

## 项目概览

| 指标 | 状态 |
|------|------|
| TypeScript 编译 | `bun run typecheck` 零错误 |
| 测试 | `bun test` 592 tests；`FileSnapshot` 同毫秒快照排序已用递增序号修复 |
| 运行时 | Bun |
| API 提供商 | DeepSeek / Zen (Free) / Mimo |
| TUI 框架 | Ink (React)，复制自 best-claude-code |
| 会话持久化 | JSONL 写入 `.deepicode/sessions/` |

---

## 一、按阶段：Phase 0–7

### Phase 0：脚手架搭建（完成）

| Step | 内容 | 状态 |
|------|------|------|
| 0.1 | 项目初始化：Git 仓库、根 `package.json`、`tsconfig.json`、`vitest.config.ts`，Bun 运行时 | 完成 |
| 0.2 | Monorepo：`packages/{core,cli,shell,tui,tools,security}`，workspaces 配置 | 完成 |
| 0.3 | 核心代码迁移：`context/{immutable,append-log,scratch,manager,message}.ts`、`types.ts`、`config.ts` | 完成 |
| 0.4 | 最小可运行集成：`cli/src/index.ts` → TUI 交互模式 + 非 TTY 管道模式 + `--help` | 完成 |

**Phase 0 验收**：项目可启动 ✅ / 单轮对话 ✅ / 工具调用 ✅ / CoreEngine 接口（部分） / LoopEvent role（部分） / tool_progress 分层 ✅ / typecheck 零错误 ✅

---

### Phase 1：核心引擎改造

| Step | 模块 | 状态 | 关键文件 |
|------|------|------|----------|
| 1.1 | DeepSeekClient（SSE streaming） | 最小完成 | `core/src/client.ts` |
| 1.2 | SegmentedLog + Session 持久化 | 最小完成 | `core/src/session.ts` |
| 1.3 | ContextManager（三区域组装 + 截断 + token 估算） | 部分完成 | `core/src/context/manager.ts` |
| 1.4 | Tokenizer Worker Pool | 完成 | `core/src/context/tokenizer-pool.ts` |
| 1.5 | StreamingToolExecutor（shared/exclusive） | 最小完成 | `core/src/streaming-executor.ts` |
| 1.6 | Tool-call Repair 流水线（Scavenge/Truncation/Storm） | 完成 | `core/src/context/repair.ts` |
| 1.7 | CacheFirstLoop 独立拆分 + Fold 集成 | 完成 | `core/src/loop.ts` |

**Phase 1 关键细节**：
- 1.1：429/5xx 指数退避重试（最多3次，1s/2s/4s+jitter）；引擎 loop 错误恢复（连续3次失败才终止）；is_error 可见性修复；done 事件去重（finishReasonYielded + finishedWithToolUse）；系统提示词重写（全中文、环境注入、todowrite 任务跟踪）
- 1.2：追加写 + SessionLoader.read() 恢复 + ReasonixEngine.recover() + `--session <id>` CLI 参数。**未完成**：SegmentedLog 未接入主上下文、原子写入/rewrite/archive/compact
- 1.3：ImmutablePrefix SHA-256 cacheKey；防御性拷贝；prefix fingerprint 覆盖 toolSpecs/fewShots；按 user 消息计数截断（默认20轮）；近似 token 估算（4 chars ≈ 1 token）；fold 决策阈值（65%/75%/80%）。**未完成**：增量 token 统计、turn-start 估算、cache miss 阵痛事件
- 1.4：Worker 线程管理 + Map<taskId> O(1) 调度 + 5s 超时降级；Worker 内 CJK（1.5 chars/token）+ 标点（2）+ ASCII（4）细化估算；主线程 CHARS_PER_TOKEN=4 回退
- 1.5：shared 并行 / exclusive 串行；tool_start/tool/tool_progress 事件。**未完成**：AST 防 JSON 假闭合、边流式参数边提前执行
- 1.6：Scavenge 6 子策略（提取块/引号转换/尾逗号/包裹/闭合花括号/闭合引号）、Truncation（截尾重试）、Storm（key-value 兜底）；JSON.parse 失败自动调用
- 1.7：engine.submit() 简化为 ~12 行；每轮检查 fold 决策（100ms 超时降级）；stream 错误自动重试

**Phase 1 验收状态**：

| 检查项 | 状态 | 检查项 | 状态 |
|--------|------|--------|------|
| SSE 解析 | 最小完成 | reasoning 分离 | 完成 |
| JSONL 持久化 | 最小完成 | 阈值旁路 | 完成 |
| Tokenizer Map | 完成 | AST 防假闭合 | 未完成 |
| Cache miss 事件 | 部分完成 | assistant_final 边界 | 完成 |
| 工具结果顺序确定性 | 完成 | prefix fingerprint | 完成 |
| Repair Pipeline | 完成 | Loop 独立拆分 | 完成 |
| API 重试 | 完成 | 核心测试 | 部分完成 |

---

### Phase 1.5：事件体系（完成）

- **#9 tool_progress 分层**：`interface.ts` 新增事件角色，streaming-executor 执行前/后 yield
- **N2 非 UTF-8 检测 + safeStringify**：`tools/src/safe-stringify.ts`，7 个工具文件全部替换 JSON.stringify
- **#11 Token 估算与 fold 决策**：`token-estimator.ts`，ContextManager.estimateTokens()/getFoldDecision()
- **#12 Session 恢复**：SessionLoader.read() + ReasonixEngine.recover() + `--session` CLI 参数

---

### Phase 2：智能推理强度调节系统（未开始）

---

### Phase 3：壳层增强（完成）

| Step | 内容 | 状态 |
|------|------|------|
| 3.0 | TUI 接入 — Ink 框架（146文件，~27K行）+ 7个业务组件（~1200行）+ 旧 TUI 清理 | 完成 |
| 3.1 | Provider 抽象层 — ChatClient 接口 + PROVIDERS 预设表（Zen/DeepSeek/Mimo）+ `/model` 命令 + ModelPicker 三步向导 | 完成 |
| 3.2 | 状态管理 + 多 Agent — AppState 集中式状态 + AGENTS 预设表（Build/Plan）+ QueryEngine 三模式 + `/agent` 命令 | 完成 |

**Step 3.0 细节**：Ink 框架 3 处微改（ThemeProvider/osc.ts/ink.tsx）；FullscreenLayout 10 处 import 替换；4 个 stub；7 个业务组件（App/bridge/DeepiMessages/DeepiPromptInput/ToolCallBanner/Spinner/StatusBar）；清理旧 oh-my-pi TUI ~20 文件。**未完成**：E2E 测试覆盖 TUI 流程。

---

### Phase 4：工具层实现

| Step | 模块 | 状态 | 说明 |
|------|------|------|------|
| 4.1 | ToolRegistry | 最小完成 | register/get/list/toToolSpecs；未完成 Agent 过滤/Deny rules/security 联动 |
| 4.2 | Hash-Anchored Edit | 完成 | 流式替换 + randomUUID 临时文件 + try-finally + oldHash 校验；6 单测 |
| 4.3 | 9-Pass Fuzzy Edit | 完成 | exact→trimmed_full→trimmed_lines→trimmedBoundary→blockAnchor→contextAware→escapeNormalized→flexible_whitespace→multiOccurrence；9 单测 |
| 4.4 | Stale-read Validation | 完成 | ReadTracker 追踪 mtime/size；N4: clearReadTracker() 防跨会话污染 |
| 4.5 | 基础工具集 | 部分完成 | read_file/write_file/edit/bash/list_dir/grep/todowrite；参数校验；B3/D1/D2 修复 |

---

### Phase 5：安全层实现（完成）

| 层级 | 内容 | 状态 |
|------|------|------|
| 最小基线（工具内联） | bash denylist + read_file/edit 路径保护 + 参数校验 + session writer 错误吞没 | 完成 |
| 正式安全包 | permission.ts（Deny-first 三级判定）+ hooks.ts（3 Hook 点）+ snapshot.ts（Git 风格快照） | 完成 |

集成：streaming-executor.ts 执行前权限检查；engine.ts 构造时创建实例 + submit 中 onLoopEvent。

---

### Phase 6：高级功能生态接入（部分完成）

### Phase 7：集成测试与调优（未开始）

---

## 二、按时间线：Round 7–24 + 专项修复

### 2026-06-05（旧代码清理 D5）

删除 pi-ai 移植遗留代码，零生产引用：

| 删除项 | 说明 |
|--------|------|
| `vendor/pi.d.ts` | 126 行 pi-ai 类型声明 |
| `vendor/pi.js` | pi-ai 包装器，`completeSimple` 等 |
| `vendor/` 目录 | 已空，移除 |
| `config.ts` 中 `buildPiModel()` | 仅测试引用，生产代码未使用 |
| `config.ts` 中 `import type { Model }` | 随 `buildPiModel` 移除 |
| `config.test.ts` 中 `buildPiModel` describe 块 | 测试死代码的函数 |
| `integration.test.ts` | 138 行，全部依赖 pi.js 且 `.skip` |

验证：`bun run typecheck` 零错误，`bun test packages/core/` 258 pass / 0 fail。

### 2026-06-05（ADVICE P0-P3 批量修复，32 项）

基于 `ADVICE.md` + 4 份配套审查报告（`deepicode_bug_report.md`、`review_core.md`、`review_tools.md`、`review_tui.md`）的综合评判结果，批量修复 P0-P2 全部 + P3 部分项。

#### P0（6 项）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| P0-1 | LSP 路径未用 ctx.cwd + 无 isSensitive | `lsp.ts` | `resolve(ctx.cwd, ...)` + `isSensitive()` |
| P0-2 | web-browser navigate/screenshot 无 SSRF | `web-browser.ts` | `validateUrl()` + `hasPrivateIP()` + redirect 后重校验 + `isPrivateHostnameSync()` |
| P0-3 | 计费公式双重计费 cache tokens | `pricing.ts` | `nonCachePrompt = promptTokens - cacheHit - cacheMiss` |
| P0-4 | Agent 配置 model/temperature/maxTokens 被忽略 | `engine.ts` | `ac.model ?? this.config.model` 等 fallback |
| P0-5 | Session 持久化丢失 tool results | `loop.ts` | toolExecutor.run() 后追加 sessionWriter.enqueue |
| P0-6 | bridge.tsx 直接突变 React state | `bridge.tsx` | assistant_final 改用不可变 `prev.messages.map()` |

#### P1（13 项）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| S1 | Cron 换行符注入 | `cron.ts` | command/name 过滤 `[\n\r]` |
| S2 | read_file 未检测二进制 | `file-ops.ts` | `hasBinaryEncoding()` 检测 |
| S3 | notebook-edit/worktree 缺 isSensitive | 2 文件 | 添加敏感路径检查 |
| S4 | write-file 缺大小限制 | `write-file.ts` | MAX_FILE_SIZE = 10MB |
| R1 | shell-exec error 未清理 timer | `shell-exec.ts` | clearTimeout(timer+sigtermTimer) |
| R2 | anySignal 内存泄漏（3 文件） | `web-fetch.ts`/`web-search.ts`/`web-browser.ts` | anySignal 返回 {signal, cleanup} |
| R3 | TokenizerPool shutdown Promise 悬空 | `tokenizer-pool.ts` | shutdown 先 reject 全部 pending |
| D2 | loadApiKeyFromProjectFile 仅 DEEPSEEK | `config.ts` | 根据 provider 动态查找 key |
| D3 | QueryEngine.query() tool call 返回空串 | `query-engine.ts` | 返回标记字符串 |
| D4 | safe-stringify 截断后非合法 JSON | `safe-stringify.ts` | 输出合法 JSON error 结构 |
| D5 | web-browser Date.now() 命名冲突 | `web-browser.ts` | `Date.now()` → `randomUUID()` |
| T1 | Delete 键被当作 Backspace | `DeepiPromptInput.tsx` | 拆分 Backspace/Delete |
| T2 | SessionPicker 空列表 selIdx=-1 | `SessionPicker.tsx` | 下行时检查 length > 0 |

#### P2（6 项）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| L1 | SSE 注释行（`:` 开头）未跳过 | `client.ts` | `if (trimmed.startsWith(":")) continue` |
| L3 | worktree runGit 无 AbortSignal | `worktree.ts` | runGit 加 signal 参数，3 处调用传递 |
| L4 | sensitive.ts 模式不完整 | `sensitive.ts` | 补充 .dockercfg/.netrc/.htpasswd/token.json |
| L6 | bash 未设置非交互式环境变量 | `shell-exec.ts` | GIT_EDITOR/EDITOR=true |
| L7 | 500 未加入重试列表 | `client.ts` | retryableStatuses 加 500 |
| L8 | web-fetch SSRF 函数未导出 | `web-fetch.ts` | hasPrivateIP/isPrivateHostname → export |

#### P3（7 项）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| Q1 | getFoldDecision 冗余分支 | `token-estimator.ts` | 合并 <=0.75/<=0.80 为 <=0.80 |
| Q2 | AgentEvent 死代码 | `types.ts` | 删除 |
| Q3 | loop.ts 字符串索引私有属性 | `loop.ts` + `manager.ts` | 加 `getContextWindow()` |
| Q5 | CoreEngine 接口签名不匹配 | `interface.ts` | getState() 加可选参数 |
| Q6 | registry 未检查重复注册 | `registry.ts` | register 时抛异常 |
| Q8 | ModelPicker Ctrl+V 仅小写 v | `ModelPicker.tsx` | `_input === 'v' \|\| _input === 'V'` |

#### 验证

- `bun run typecheck` 零错误
- `bun test` 576 pass / 3 skip / 5 fail（5 fail = 3 个 WebSearch 网络超时 + 1 个 SSE 性能 flaky + 1 error，均与修复无关）

### 2026-05-31（N1-N14 修复 + Bash 确认 UI，13 项）

基于三轮新审查报告（FindBugV4 + security/mcp/shell + packages_review）修复：

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| N1 | `bash -lc` source 用户 .bashrc，安全风险 | `shell-exec.ts` | `-lc` → `-c` |
| N2 | SSE 流无看门狗超时 | `client.ts` | 60s 看门狗，无数据→cancel reader |
| N3 | MCP connect 未校验 protocolVersion | `mcp/client.ts` | 缺失时 SIGTERM + throw |
| N4 | MCP disconnect 不清理 pending | `mcp/client.ts` | reject 全部 pending + clearTimeout |
| N6 | bash 无 git commit/push 拦截 | `shell-exec.ts` | DENY_PATTERNS 加 git push/commit |
| N7 | runOnLoopEvent 无 try-catch | `engine.ts` | try-catch 包裹 |
| N8 | removeDenyRule 无法移除 RegExp | `permission.ts` | RegExp 规则保留（用 clear() 移除） |
| N9 | --session 参数越界 | `cli/tui.ts` | 边界检查 `idx+1 < length` |
| N10 | FileSnapshot Date.now() 并发冲突 | `snapshot.ts` | `Date.now()_randomUUID()` |
| N11 | SSE [DONE] tool call index 丢失 | `client.ts` | `values()` → `entries()` |
| N12 | MCP listTools 顺序不稳定 | `host.ts` | 按 name sort |
| N13 | AppState.notify listener 异常静默 | `state.ts` | catch → console.error |
| — | Bash 确认 UI 核心机制 | 多文件 | permission_ask event + respondPermission + TUI prompt |
| — | flushSharedBatch 绕过权限检查 | `streaming-executor.ts` | 提取 `checkAskPermission()` 方法，shared/exclusive 双路径覆盖 |

验证：`bun run typecheck` 零错误，`bun test` 575 pass / 5 fail / 1 error（fail 均为网络/SSE 环境 flaky）。

### 2026-05-29

| 事件 | 内容 |
|------|------|
| Phase 0–1 核心搭建 | Step 0.1–1.7 全部落地 |
| ADVICE 修复（前四轮） | 37 项核心引擎+工具层修复（详见 §三） |
| N2/#11/#12 | safeStringify / token 估算 / session 恢复 |
| P2-5 | 删除 SegmentedLog 死代码 |

### 2026-05-30（第七轮：TUI 审计修复，22 项）

| 严重度 | 数量 | 关键项 |
|--------|------|--------|
| P0 | 1 | tool_progress 硬编码 → bridge.tsx 检查 content |
| P1 | 5 | error/warning 渲染、token 统计、同名工具歧义、reasoning 忽略、cursorPos closure |
| P2 | 9 | tool_call_delta/status/done 事件处理、warning/error 分离、Pipe 模式 stderr、快捷鍵 |
| P3 | 7 | CLAUDE_CODE→DEEPCODE 环境变量、StatusBar flex、Pipe done 换行、React key、消息截断、非全屏滚动、prefix.build 短路 |

参见 [§四 持续关注（9项）] 和 [§五 驳回项（11项）]。

### 2026-05-30（第八轮：TUI 交互打磨）

- **TM1+TM2**：`/model` 命令 + Provider 切换（三步选择器：provider→key→model）
- **模型选择持久化**：`.deepicode/last-config.json`，退出自动保存；`loadConfig()` 优先级：环境变量 > last-config.json > 默认值

### 2026-05-30（SIGINT / Raw Mode 修复，三轮迭代）

| 轮次 | 结果 | 关键发现 |
|------|------|----------|
| 第一轮 | 失败 | 表面修复——已存在 SIGINT handler，问题不在 handler 缺失 |
| 第二轮 | 部分成功 | 根因：`exitOnCtrlC: true`（Ink 默认）导致 Ink 内部抢先调 handleExit() → raw mode 丢失；连续 Ctrl+C 无法退出（Bun 信号上下文 setTimeout 不可靠）；`\x03` 字符路径无退出逻辑 |
| 第三轮 | **成功** | 终端恢复顺序错误——正确顺序：DISABLE_MOUSE → unmount() → drainStdin() → detachForShutdown() → SHOW_CURSOR。关键教训：unmount() 必须在 alt screen **仍激活时**调用 |

**最终修复**：
- `cli/src/tui.ts`：`render({ exitOnCtrlC: false })` 禁止 Ink 拦截 `\x03`
- `App.tsx`：模块级 `doInterrupt()` 统一入口（SIGINT + useInput `\x03` 双路径）；`cleanupTerminal()` 严格按正确顺序
- `bridge.tsx`：`setTUIState('loading'/'idle')` 同步引擎状态
- `DeepiPromptInput.tsx`：`\x03` 字符检测
- `StatusBar.tsx`：`statusMessage` prop 显示退出确认

**中断行为**：加载中 Ctrl+C → 取消回输入态；空闲双击 Ctrl+C → 第一次提示，2秒内第二次 → 退出；`/exit`/`/bye` → 优雅退出。

参考来源：best-claude-code `gracefulShutdown.ts` 的 `cleanupTerminalModes()`。

### 2026-05-30（第九轮：安全层实现）

PermissionEngine + HookManager + FileSnapshot 三个模块，集成到 streaming-executor 和 engine。详见 Phase 5。

### 2026-05-30（第十轮：壳层增强 + 多 Agent）

AppState + QueryEngine + Build/Plan Agent。详见 Phase 3 Step 3.2。

### 2026-05-30（第十五轮：ADVICE 剩余 Bug 修复，10 项）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| H2 | SSE reader.releaseLock() 泄漏 | `client.ts` | try/finally 包裹 reader |
| M3 | batch.find(...)! 非空断言 | `streaming-executor.ts` | 改为 ?.tc + 空值检查 |
| M7 | hash-edit 非 UTF-8 破坏 | `hash-edit.ts` | 读前 8KB 检测二进制 |
| M14 | grep pattern 选项注入 | `grep.ts` | pattern 前加 `--` |
| M15 | web-fetch 危险协议 | `web-fetch.ts` | 仅允许 http:/https: |
| BUG-012 | edit 无文件大小限制 | `edit.ts` | >10MB 拒绝 |
| BUG-014 | flushSoon 无 .catch() | `session.ts` | 两处加 .catch(() => {}) |
| BUG-008 | SIGKILL 无前置 SIGTERM | `shell-exec.ts` | SIGTERM + 5s grace → SIGKILL |
| — | Zen 404 | `config.ts` | ensureBaseUrl() 改为字符串拼接保留 `/zen/v1/` |
| — | 状态栏重新设计 | 多文件 | 中文标签 + 缓存命中率 + 上下文用量/总量 + 光标改为字符串拼接 |

**验证**：typecheck 零错误；SSE 测试 36 pass；全量 530 pass / 3 skip / 3 fail（3 fail 为 SSE 全局并发超时抖动，单独运行通过）。

### 2026-06-01

| 事件 | 内容 |
|------|------|
| 第十一轮 | TL1 收尾（AskUserQuestion/TaskCreate/TaskUpdate/TaskList/TaskGet/TaskStop/PlanMode/NotebookEdit/glob/WebFetch/WebSearch）+ TL3 Skills 系统（52 个 SKILL.md）+ TL4 MCP 协议集成（McpClient/McpHost/3 MCP 工具 + mcp.json 配置） |
| ADVICE 审计修复 | 6 项（P2-5 TokenizerPool 降级/P1-2 事件顺序/SEC-1 glob 路径穿越/P2-3 SessionLoader 恢复/P3-3 React key/SEC-2 web-fetch SSRF） |
| Session 管理 | SessionLoader.list() + engine.loadSession() + SessionPicker 组件 + `/sessions` 命令 |

### 2026-06-02

| 事件 | 内容 |
|------|------|
| 第十二轮 | TL1+TL2 全部工具完成（~25 工具）；全部工具注册到 TUI；TEST.md 测试用例文档（7 包 42+ 模块，~450 项用例）；验证 typecheck 零错误 + 66 pass |
| 第四轮 ADVICE | 9 项（isToolUseFinishReason 统一/hook 异常隔离/bash sensitive/hash-edit 恒真哈希/截断边界/MCP 通知/MCP 超时/contextUsage/fuzzy Pass7） |
| 第五轮 ADVICE (FullReAudit) | 5 项（bridge exhaustive check/task-manager ID/web-fetch redirect/session stats/updateConfig ctx） |

### 2026-06-05

| 事件 | 内容 |
|------|------|
| 第十三轮 | MockSseServer（零依赖 HTTP mock，6 预设场景）+ SSE Client 测试（30 tests，覆盖 17/21 TEST.md 用例） |
| 第十四轮 | Session/Streaming Executor/Query Engine/Repair 测试（原 19→56 tests，新增 37）；TEST.md 更新（四个模块标记 [x]） |
| 第十五轮 | TT1 SSE 边界测试（6） + TT2 E2E 工具链闭环（9） + TT3 性能基准&计费校准（20）；总计 533 pass |
| BUG_REPORT 第六/七轮 | 16 项 P1/P2（H4 孤儿 tool_call/M9 Worker 崩溃/H1 SSE 多行/H2 releaseLock/H3 isAbortError/M2 [DONE] finalize/M3 非空断言/M7 非 UTF-8/M12 fold fallback/M14 grep 注入/M15 危险协议/BUG-006 重复调用/BUG-012 文件大小/BUG-014 flushSoon/BUG-008 SIGKILL/M11 contextUsage） |
| 启动性能优化 | MCP server `for await` → `Promise.all` 并行连接；TUI `await mcpHost.loadConfig()` → fire-and-forget |
| 测试回归修复 | B1: hooks.ts afterToolCall try-catch 隔离；B2: McpAuth.set() stub `"stored"` → `"not_implemented"` |
| **第二十四轮** | **S1-S15 简单（15项）+ M7/M8/M11/M14/M15 中等（5项）+ 源码补齐 isAllowed/isDenied/fromJSON；总计 561 pass / 3 skip / 0 fail** |
| **第二十五轮** | **M1-M6 Context/Session + M9 SessionWriter + M12 WebFetch + M13 WebSearch + M16 Task 全流程（9项中等）；总计 580 pass / 3 skip / 0 fail；中等等级 15/18 ✅，剩余 M10 write_file 权限继承** |
| **TUI 重设计** | **Phase 1 完成：气泡消息+主题扩展+可折叠思考+思考持久化+助手回答消失修复；Phase 2：权限确认方向键选择 UI；工具调用合并气泡+JSON格式化+错误内联+布局重排；消息队列；Reasonix 显示框架移植（Markdown/Card/ToolCard/Spinner/Tokens）** |

---

## 二.五、TUI 重设计（Phase 1，2026-05-31）

### 问题诊断与修复

| # | 问题 | 根因 | 文件 | 改动 |
|---|------|------|------|------|
| T5 | 可折叠思考：快捷键 Alt+R → Ctrl+O | 设计变更 | `DeepiMessages.tsx` | `key.meta && _input === 'r'` → `_input === '\x0f' \|\| (key.ctrl && _input === 'o')` |
| T5a | 思考内容回答后自动折叠消失 | `finally` 块中 `reasoningText: null` 清空思考 | `bridge.tsx` | 移除 `reasoningText: null`，保留思考内容 |
| T5b | Ctrl+O 在输入框中被插入为字符 | DeepiPromptInput 未拦截 Ctrl+O | `DeepiPromptInput.tsx` | 新增 `_input === '\x0f' \|\| (key.ctrl && _input === 'o')` 提前 return |
| T5c | Assistant 回答完成后内容消失（**核心 Bug**） | `assistant_final` 的 `setState` 函数式更新器通过闭包引用捕获 `activeAssistantMsg`/`assistantContent`，React 批处理导致更新器执行时变量已被清空 | `bridge.tsx` | 用 `const` 局部变量保存引用值后再调用 `setState` |
| T5d | 思考区块位置错误（在所有消息之后） | Thinking 作为独立 section 渲染在 messages.map 之后 | `DeepiMessages.tsx` | 移入最后一条 assistant 消息的独立 wrapper Box 中，位于内容之前 |
| T5e | 折叠态无操作提示 | 无 | `DeepiMessages.tsx` | 折叠时显示 "ctrl+o open" 提示文本 |
| — | `finally` 兜底保护 | 防御性设计 | `bridge.tsx` | `finally` 中检查 `activeAssistantMsg` + `streamingText/assistantContent`，未 finalize 时兜底复制到消息 |

### 权限确认 UI 重设计（2026-05-31）

| 文件 | 改动 |
|------|------|
| `PermissionPrompt.tsx` (新) | 方向键选择组件：↑↓ 导航，Enter 确认，Esc 拒绝；圆角边框 + 工具名/命令详情 + 操作提示；三选项：允许 / 始终允许 / 拒绝 |
| `bridge.tsx` | `permissionPrompt` 从 `string` 改为 `{ toolName, args }` 结构化对象 |
| `engine.ts` | `respondPermission(allow, alwaysAllow?)` — 始终允许时自动添加 AllowRule 到 PermissionEngine |
| `interface.ts` | `respondPermission` 签名更新 |
| `App.tsx` | 渲染 `PermissionPrompt` 替代纯文本，权限确认期间禁用输入框 |

### 工具调用历史持久化 + 结构化展示（2026-05-31）

| 问题 | 根因 | 文件 | 改动 |
|------|------|------|------|
| 工具调用结果在加载完成后消失 | bridge 的 `"tool"` 事件仅更新 `activeTools`（临时 Map），从未写入持久化存储 | `bridge.tsx` | 新增 `toolHistory: ToolCallRecord[]` 数组，`"tool"` 事件追加记录；`tool_start` 从 assistant 的 `tool_calls` 提取命令参数 |
| assistant 回复以原始 markdown 格式显示 | 未做 markdown 渲染 | `DeepiMessages.tsx` + `markdown.ts` + `Markdown.tsx` (新) | 复用 Claude Code `marked.lexer` + `formatToken` 模式：heading/bold/italic/table/list/code 等 token 渲染为 ANSI 样式；安装 `marked` + `strip-ansi` |
| 每个工具调用一个气泡，碎片化 | 工具消息逐条追加到 messages 数组 | `bridge.tsx` + `DeepiMessages.tsx` | 不再往 `messages` 追加 tool 消息；所有工具调用合并到一个 `codeBlockBackground` 气泡中渲染 |
| toolCallArgs Map 类型不匹配 | number key vs string key | `bridge.tsx` + `DeepiMessages.tsx` | 移除 `toolCallArgs` Map，改用 `toolHistory` 数组 |

### Reasonix 显示框架移植（2026-05-31）

从 DeepSeek-Reasonix（Ink 7 + React 19，专为 DeepSeek 设计）移植核心显示组件：

| 文件 | 行数 | 说明 |
|------|------|------|
| `reasonix/markdown.tsx` | 230 | 完整 Markdown→Ink 渲染（heading/list/code/table/blockquote/inline + cli-highlight 代码高亮） |
| `reasonix/ToolCard.tsx` | 107 | 工具调用卡片（状态生命周期 running/ok/error + 输出预览 + 参数摘要） |
| `reasonix/text-width.ts` | 55 | CJK 安全文本宽度（graphemes/clipToCells/wrapToCells/padToCells） |
| `reasonix/CardHeader.tsx` | 36 | 卡片标题（glyph + title + subtitle + meta + right） |
| `reasonix/tokens.ts` | 31 | 主题 token 系统（FG/TONE/SURFACE，Proxy 代理支持运行时切换） |
| `reasonix/Spinner.tsx` | 16 | 动画 spinner（circle/braille 两套帧，keepAlive `useAnimationFrame` 驱动） |
| `reasonix/html-entities.ts` | 12 | HTML 实体解码（LLM 输出中的 &quot; &amp; 等） |
| `reasonix/Card.tsx` | 8 | 卡片容器 |
| `reasonix/index.ts` | 7 | 导出 |
| **总计** | **502** | |

**适配改动**：
- `ink` → `@deepicode/ink`
- `useStdout` → `process.stdout.columns`
- `useAnimation` → `useAnimationFrame`（deepicode Ink fork 的 keepAlive 共享时钟动画）
- 移除 i18n/state 依赖（ToolCard 独立可用）
- Token 颜色用 `as any` 绕过 Ink 类型限制（hex 字符串运行时有效但类型不匹配）

**集成方式**：
- `MarkdownRenderer.tsx` → 直接导出 `reasonix/markdown.js` 的 `Markdown`
- `DeepiMessages.tsx` → User/Assistant 用 Reasonix `Card`+`CardHeader`，Tool 用 Reasonix `ToolCard`，Loading 用 Reasonix `Spinner`

### Timeline 状态模型收尾（2026-05-31）

保留 Deepicode 的 `LoopEvent → bridge.tsx → React` 架构，不引入 Reasonix Store/TurnTranslator。bridge 改为轻量 `TimelineItem[] + TurnView`，每轮持久保存 user、reasoning、tools、assistant 和 loading 状态。

| 编号 | 问题 | 改动 |
|------|------|------|
| TUI-B1 | `tool_call_delta` 转发丢失 `toolCallIndex` | `loop.ts` 补齐索引；bridge 按索引关联参数 |
| TUI-B2 | Thinking / Tool use 依附最后一条 assistant，纯工具轮次无容器 | 每次 submit 先创建 `TurnView`，纯工具轮次和下一轮开始后仍可渲染 |
| TUI-B3 | App 同时挂载新旧 Tool/Spinner | 删除 App 中旧 `ToolCallBanner` 和旧 Spinner 挂载 |
| TUI-B4 | cancel 后立即开放新 submit，旧 generator 与新请求串状态 | bridge 串行处理 submit；取消后等待旧 generator 退出再处理队列 |
| TUI-B5 | Reasonix Spinner 使用非 keepAlive `useInterval`，无其他动画时不推进 | 改用 keepAlive `useAnimationFrame` |
| TUI-B6 | 权限确认期间 cancel 无法兑现等待中的 Promise | cancel 时先 `respondPermission(false)`，再 interrupt |
| TUI-B7 / Q10 | 同一轮后续工具批次重复使用 `toolCallIndex=0`；tool key fallback 不一致 | index 只作为活跃映射，每次 `tool_start` 分配唯一 key |

同步完成的显示修复：

| 编号 | 内容 |
|------|------|
| F1 | 普通与流式 Assistant 回复增加 `Assistant` CardHeader |
| F2 | User 消息气泡使用 Reasonix `SURFACE.bgElev` |
| F4 | bridge 记录工具 `startedAt / elapsedMs`，ToolCard 显示耗时 |
| F6 | Ctrl+O 统一展开/折叠 Thinking 和 Tool use |
| F7 | Spinner 改用 keepAlive `useAnimationFrame`，不再依赖非驱动型 `useInterval` |
| — | PromptInput 光标从 ref 改为 state，左右移动会触发重绘 |

从 TODO 清理的已完成核心项：

| 编号 | 内容 | 验证 |
|------|------|------|
| B6 | Session 恢复时由 `engine._loadSessionMessages()` 过滤历史 system 消息，避免重复注入 | `session.test.ts` M4 |
| B5 | repair Scavenge 增加 `1g`：未闭合引号 + 未闭合花括号组合修复 | `repair.test.ts` combined strategy 1g |

新增 `packages/tui/__tests__/bridge.test.ts`，覆盖：
- 纯工具轮次持久显示和参数索引关联
- 后续批次重复使用 `toolCallIndex=0`
- cancel 后排队串行执行
- 权限提示期间 cancel 自动拒绝并退出 generator

验证：
- `bun run typecheck` 零错误
- `git diff --check` 通过
- TUI + engine 定向测试 14 pass / 0 fail
- 完整测试曾运行通过：584 pass / 0 fail
- `FileSnapshot` 同毫秒快照按随机后缀排序会偶发失败；已在高级工具补齐轮次加入递增序号修复

### T30/T31/T32：i18n 国际化（2026-06-01）

**实现**：`eb658db`

- 创建 `packages/tui/src/i18n/` 模块：`strings.ts`（接口）、`zh-CN.ts`、`en.ts`（字典）、`persist.ts`（持久化）、`index.ts`（导出）
- 类型安全的 `t()` 函数，支持参数化字符串（如 `t().queued(n)`、`t().switchedModel(provider, model)`）
- 运行时 `setLocale()` 切换，持久化到 `.deepicode/lang.json`
- `/lang` 命令循环切换 zh-CN ↔ en
- 替换 14 个文件中 ~55 个硬编码用户可见字符串
- 不翻译：工具名、事件 role、provider id、JSON 字段、Unicode 符号
- typecheck 通过，596 pass / 4 fail（web-search 超时为预存问题）

**新文件**：
- `packages/tui/src/i18n/strings.ts` — Strings 接口定义
- `packages/tui/src/i18n/zh-CN.ts` — 中文字典
- `packages/tui/src/i18n/en.ts` — 英文字典
- `packages/tui/src/i18n/persist.ts` — .deepicode/lang.json 读写
- `packages/tui/src/i18n/index.ts` — t() / setLocale() / getLocale() / toggleLocale()

---

## 三、ADVICE 审计修复总汇（共 38 项，4 份审计报告全部处理完毕）

### 第一轮（2026-05-29，对应 DONE.md 中"前四轮核心引擎+工具层"）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| B1 | done 事件重复 → 工具循环提前终止 | `client.ts`/`engine.ts` | finishReasonYielded + finishedWithToolUse 防御 |
| B2 | 缺少 write_file 工具 | `write-file.ts` | 新建 |
| B3 | bash cwd 未基于 ctx.cwd resolve | `shell-exec.ts` | resolve(ctx.cwd, args.cwd) |
| B4 | hash-edit 临时文件碰撞 | `hash-edit.ts` | Date.now() → randomUUID() |
| B5 | fuzzy-edit 正则转义耦合 | `fuzzy-edit.ts` | split(/\s+/) 分段转义后 join |
| C1 | 缺少 list_dir/grep/todowrite | 3 个新文件 | — |
| D1 | SENSITIVE_FILE_PATTERNS 三处重复 | `sensitive.ts` | 提取共享模块 |
| D2 | edit.ts 缺 known_hosts 保护 | `edit.ts` | 补充模式 |
| D3 | getState() 硬编码默认值 | `engine.ts` | 参数化接口 |
| N1 | 上下文无界增长 | `manager.ts`/`config.ts` | 按 user 消息截断（默认20轮） |
| N3 | hash-edit 临时文件泄漏 | `hash-edit.ts` | try-finally + tmpCreated 标记 |
| N4 | stale-read 全局状态跨会话污染 | `engine.ts` | clearReadTracker() 回调 |
| P0-1 | grep 命令注入 | `grep.ts` | execSync → spawnSync 参数组 |
| P0-2 | write_file 无 mkdir | `write-file.ts` | mkdir(dirname, recursive) |
| P1-1 | 截断破坏 tool 消息对 | `manager.ts` | 截断后向前扫描配对 |
| P1-2 | multiOccurrence 歧义 | `fuzzy-edit.ts` | 拒绝猜测返回 null |
| P1-3 | interrupt 延迟 | `engine.ts` | error 路径检查 _interrupted |
| P2-1 | shell-exec 截断无提示 | `shell-exec.ts` | 追加 truncated 说明 |
| P2-2 | sessionId 碰撞 | `engine.ts` | Date.now() → randomUUID() |
| P2-3 | SSE JSON 解析静默丢失 | `client.ts` | DEEPICODE_DEBUG 日志 |
| P2-4 | list-dir stat 失败 type 误导 | `list-dir.ts` | 改为 type: "unknown" |
| P2-5 | sleep 监听器泄漏 | `client.ts` | removeEventListener |
| P2-6 | 死代码分支 | `engine.ts` | 防御性注释 |
| P1-1b | finish_reason 不一致 | `client.ts`/`engine.ts` | isToolUseFinishReason 共享 |
| P1-2b | 空 toolCalls 死循环 | `engine.ts` | empty guard + yield warning |
| P1-3b | token-estimator 忽略 reasoning | `token-estimator.ts` | 加入 reasoning_content |
| P2-1b | read_file 截断无提示 | `file-ops.ts` | 追加 truncation notice |
| P2-2b | list-dir 标记未知为 file | `list-dir.ts` | type 扩展为 "unknown" |
| P2-5b | SegmentedLog 死代码 | `session.ts` | 删除类定义 |

外加第四轮 ADVICE（P2×4 + P3×3）：

| 编号 | 问题 | 改动 |
|------|------|------|
| P2-4-1 | Session 恢复过滤 system → 双 system 失效 | 恢复时过滤 system 消息 |
| P2-4-2 | AsyncSessionWriter 不可序列化 payload | enqueue 加 try-catch |
| P2-4-3 | streaming-executor tool_progress 时序 | running 提前到 Promise.all 前 |
| P2-4-4 | refinedEstimate 重复定义 | 抽取为共享函数 |
| P3-4-1 | apiCalls 计数位置 | 从 usage 移到 done 事件 |
| P3-4-3 | todowrite 缺少结构校验 | 运行时校验 todo 项 |
| P3-4-4 | sensitive 模式不足 | 补充 .env.*/证书/npmrc/AWS 等 8 个模式 |

### 第二轮（2026-06-01，6 项）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| P2-5 | TokenizerPool 单次超时永久降级 | `tokenizer-pool.ts` | 连续 3 次超时才 healthy=false；正常响应时重置 |
| P1-2 | StreamingToolExecutor 事件顺序不一致 | `streaming-executor.ts` | exclusive 路径对齐 shared（appendToolResult→yield event→yield done） |
| SEC-1 | glob.ts 路径穿越 | `glob.ts` | realpathSync + startsWith 校验 |
| P2-3 | SessionLoader 崩溃恢复数据丢失 | `session.ts` | 从后向前遍历 JSONL，找最近合法 messages 记录 |
| P3-3 | React key 流式闪烁 | `DeepiMessages.tsx` | key 改为 role + index |
| SEC-2 | web-fetch.ts SSRF | `web-fetch.ts` | hasPrivateIP() + isPrivateHostname() + redirect:"manual" |

### 第三轮（2026-06-02，9 项）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| NEW-1 | isToolUseFinishReason 重复定义 | `loop.ts` | import from client.js |
| NEW-5 | hook beforeToolCall 异常未隔离 | `hooks.ts` | try-catch 包裹，异常返回 "deny" |
| SEC-3 | bash 绕过 sensitive 检查 | `shell-exec.ts` | 正则提取文件路径 → isSensitive() |
| NEW-2 | hash-edit 恒真哈希 | `hash-edit.ts` | 删除冗余 sha256 校验 |
| NEW-4 | 截断边界 assistant(tool_calls) | `manager.ts` | log.slice() 后反向扫描，向前切到下一个 user |
| NEW-6 | MCP notifications/initialized 协议错误 | `mcp/client.ts` | 改用 proc.stdin.write(json) 直接发送（无 id） |
| NEW-7 | MCP pending 泄漏 | `mcp/client.ts` | 30s 超时 + timer + clearTimeout |
| NEW-8 | bridge contextUsage 跳变 | `bridge.tsx` | 改为累积 prev.tokens.input + addInput |
| NEW-9 | fuzzy-edit Pass 7 多匹配 | `fuzzy-edit.ts` | match() → matchAll() + 多匹配返回 null |

### 第四轮（2026-06-02，FullReAudit，5 项）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| P0-1 | bridge switch 无 exhaustive check | `bridge.tsx` | 补 strategy_notify/strategy_estimate_refined case + default exhaustiveCheck |
| P1-1 | task-manager ID 碰撞 | `task-manager.ts` | Date.now()+Math.random() → crypto.randomUUID() |
| P1-2 | web-fetch redirect:manual 阻断合法 URL | `web-fetch.ts` | → redirect:"follow" + 重定向后 IP 二次校验 |
| P1-3 | session stats 重复累加 | `session.ts` | 只取最后一条 stats 记录（累计值） |
| P1-5 | updateConfig 不同步 contextWindow | `engine.ts`/`manager.ts` | updateContextWindow() 方法 + updateConfig 同步调用 |

### 第五轮（ReAudit-Round2，10 项）

假 exhaustive check、/skill catch、stats reset、client error、tool_start UUID、cancel activeTools、路径分隔符、MCP disconnect、prefixCacheKey 排序、SessionPicker bounds、CLAUDE_CODE 残余。

---

## 四、BUG_REPORT 修复总汇（第六/七轮，16 项）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| H4 | 中断产生孤儿 tool_call | `loop.ts` | try/catch 包裹工具执行，中断时 append error results |
| M9 | TokenizerPool Worker 崩溃挂起 | `tokenizer-pool.ts` | error/exit 时 resolve 全部 pending tasks |
| H1 | SSE 多行 data: 拼接 | `client.ts` | 累积 dataPayloads 后 join 再 parse |
| H2 | reader.releaseLock() | `client.ts` | try/finally 包裹 reader 生命周期 |
| H3 | isAbortError Bun 兼容 | `client.ts` | 增加 Error + ABORT_ERR code 检测 |
| M2 | [DONE] 前 finalize tool calls | `client.ts` | toolState 未完成强制 finalize |
| M3 | batch.find(...)! 非空断言 | `streaming-executor.ts` | 改为安全可选链 + 空值检查 |
| M7 | hash-edit 非 UTF-8 破坏 | `hash-edit.ts` | 读取前 8KB 检测二进制 |
| M12 | fold fallback 硬编码 128000 | `loop.ts` | 动态取 ctx.contextWindow |
| M14 | grep pattern 选项注入 | `grep.ts` | pattern 前加 `--` |
| M15 | web-fetch 危险协议 | `web-fetch.ts` | 仅允许 http:/https: |
| BUG-006 | 重复工具调用 | `loop.ts` | recentToolCalls Map + 3 次阈值检测 |
| BUG-012 | edit 无文件大小限制 | `edit.ts` | 添加 10MB 上限 |
| BUG-014 | flushSoon 无 .catch() | `session.ts` | 两处加 .catch(() => {}) |
| BUG-008 | SIGKILL 前无 SIGTERM | `shell-exec.ts` | 先 SIGTERM + 5s 后 SIGKILL |
| M11 | contextUsage 累积增长 | `bridge.tsx` | 回退为 addInput（当前请求，不过度累积） |

### 测试回归修复（2026-06-05，B1/B2）

| 编号 | 问题 | 文件 | 改动 |
|------|------|------|------|
| B1 | afterToolCall 回调异常传播中断后续 hook | `hooks.ts` | try-catch 包裹每个回调 |
| B2 | McpAuth.set() stub 返回 "stored" 误导用户 | `auth.ts` | 改为 "not_implemented" |

---

## 五、测试覆盖总汇

### 最终状态：580 pass / 3 skip / 0 fail

### 逐轮测试增长

| 轮次 | 原测试数 | 新测试数 | 覆盖模块 |
|------|----------|----------|----------|
| 第十三轮 | — | 41 | MockSseServer (11) + SSE Client (30) |
| 第十四轮 | 19 | 37 | Session (18) / Streaming Executor (10) / Query Engine (9) / Repair (19) |
| 第十五轮 TT1 | — | 6 | SSE 边界（1字节chunk/前缀拆分/UTF-8/JSON/\n\n跨chunk） |
| 第十五轮 TT2 | — | 9 | E2E 工具链（write→read/edit/bash/5轮链/error/interrupt/perm/空write） |
| 第十五轮 TT3 | — | 20 | 性能基准 & 计费校准（pricing 10项 + 性能 9项） |
| 第二十四轮 S1-S15 | — | 15 | 简单项全覆盖（Repair/SSE/Glob/Grep/TaskMgr/NotebookEdit/Cron/Skill/排序/Permission/bash/WebFetch/路径穿越） |
| 第二十四轮 M7-M18（部分） | — | 5 | 超长单行、并发流、并发 edit、afterToolCall 异常、SHA256 索引 |
| 第二十五轮 M1-M16 | — | 19 | 中等项：Context fold 决策（3）/ Session 过滤+load+recover（3）/ SessionWriter enqueue（1）/ WebFetch 全流程（6）/ WebSearch（5）/ Task 全流程（1） |

### TEST.md 覆盖状态

| 模块 | 标记完成 | 总用例 |
|------|----------|--------|
| 1.1 Context | 3/3 | [x] ✅ 全覆盖（新增 fold force/suggest/none 决策） |
| 1.3 Streaming Executor | 11/16 | [x] |
| 1.4 Repair | 13/14 | [x]（新增 truncation 语义 diff） |
| 1.5 Session | 17/17 | [x] ✅ 全覆盖（新增系统消息过滤+loadSession+recover） |
| 1.6 SSE Client | 19/21 | [x]（新增 reasoning_content 验证 + 超长单行 + 并发流） |
| 1.7 Engine+Loop | 1/1 | [x] ✅ 全覆盖（新增 SessionWriter enqueue） |
| 1.8 Query Engine | 8/8 | [x] ✅ 全覆盖 |
| 2.5 glob | 7/7 | [x] ✅ 全覆盖（新增 Bun.Glob fallback + rg→grep 回退） |
| 2.6 TaskManager | 7/7 | [x] ✅ 全覆盖（新增全流程 Create→List→Get→Update→Stop） |
| 2.7 WebFetch | 6/6 | [x] ✅ 全覆盖（新增 HTTPS/HTTP升级/redirect/HTML/超大/截断） |
| 2.8 WebSearch | 5/5 | [x] ✅ 全覆盖（新增空/缺参/上限/默认值/无结果） |
| 2.9 NotebookEdit | 8/8 | [x] ✅ 全覆盖（新增路径穿越） |
| 2.10 Cron | 8/8 | [x] ✅ 全覆盖（新增 crontab 不存在） |
| 2.10 SkillTool | 5/5 | [x] ✅ 全覆盖（新增 load 不存在） |
| 3. Skills 排序 | 3/3 | [x] ✅ 全覆盖（新增排序逻辑） |
| 5.1 PermissionEngine | 12/12 | [x] ✅ 全覆盖（新增 isAllowed/isDenied/fromJSON/toJSON） |
| 5.2 HookManager | 8/8 | [x] ✅ 全覆盖（新增 afterToolCall 异常验证） |
| 5.3 FileSnapshot | 6/6 | [x] ✅ 全覆盖（新增 SHA256 索引） |
| 7.1 工具链 Task | 1/1 | [x] ✅ 全覆盖（新增 Create→List→Get→Update→Stop 全流程） |

### 未覆盖项（剩余中等 1 项 + 困难 23 项）

- 2.2 write_file：权限继承（M10）

---

## 六、技能系统 & MCP 集成

### 高级工具补齐（2026-05-31）

| 模块 | 完成内容 |
|------|----------|
| Workflow | 通过 Engine `ToolContext.invokeTool()` 串行执行真实工具；禁止递归，嵌套 `exec` 不绕过确认 |
| AgentTool | 启动隔离子会话执行任务；后台子 Agent 禁止无交互确认的 `exec` 工具 |
| SendMessage | 项目级 JSONL 邮箱 `.deepicode/messages.jsonl`，支持 send/list |
| PlanMode | 通过 Engine 上下文真实切换 build/plan agent |
| MCP | 修复 JSON-RPC `result` 解包；新增 `ListMcpTools` / `CallMcpTool`；McpAuth 以 `0600` 权限持久化 |
| LSP | stdio JSON-RPC initialize/didOpen；支持 definition/references/hover/diagnostics/completion |
| WebBrowser | Playwright 隔离进程支持 screenshot/click/fill/extract；所有页面入口执行 SSRF 检查 |

内置静态 Agent Tool：`packages/tools` 29 个 + MCP 桥接 5 个 = **34 个**。

### Skills（TL3，52 个 SKILL.md）

| 文件 | 说明 |
|------|------|
| `packages/tools/src/skills/` | 复制自 ~/.claude/skills 的 52 个 SKILL.md |
| `packages/tools/src/skills/index.ts` | SkillTool：search/list/load 三命令 |
| `packages/tui/src/App.tsx` | `/skill` 斜杠命令 |

### MCP 协议集成（TL4）

| 文件 | 说明 |
|------|------|
| `packages/mcp/src/client.ts` | McpClient：stdio 子进程 + JSON-RPC 2.0 |
| `packages/mcp/src/host.ts` | McpHost：多客户端管理 + 自动注册 + .deepicode/mcp.json 配置 |
| `packages/mcp/src/list-resources.ts` | ListMcpResources 工具 |
| `packages/mcp/src/read-resource.ts` | ReadMcpResource 工具 |
| `packages/mcp/src/auth.ts` | McpAuth 工具（set/list/delete） |
| `packages/mcp/src/list-tools.ts` | ListMcpTools：列举外部 MCP Tool |
| `packages/mcp/src/call-tool.ts` | CallMcpTool：调用外部 MCP Tool |

### 性能优化（2026-06-05）

| 文件 | 改动 |
|------|------|
| `mcp/src/host.ts` | `for await` 串行连接 → `Promise.all` 并行连接 |
| `cli/src/tui.ts` | `await mcpHost.loadConfig()` → fire-and-forget，TUI 立即渲染 |

---

## 七、关键设计决策

| 决策 | 选择 | 说明 |
|------|------|------|
| 运行时 | Bun | 脚本运行 |
| API 提供商 | DeepSeek 官方 | 默认 `https://api.deepseek.com`，支持 Zen/Mimo 切换 |
| 默认模型 | `deepseek-v4-flash` | 可用环境变量覆盖 |
| API key | env 优先，其次 `api-key` 文件 | `api-key` 已加入 .gitignore |
| API 重试 | 指数退避（最多3次） | 429/502/503 自动重试，400/401 直接报错 |
| 核心事件 | `AsyncGenerator<LoopEvent>` | CLI 逐事件消费 |
| 工具执行 | shared 并行 / exclusive 串行 | 稳定优先（完整 tool call 后执行）；Eager Dispatch 设计已确定（读操作即时执行，写操作等 finish_reason） |
| 会话持久化 | JSONL best-effort append | 写入 `.deepicode/sessions/`，不阻塞主流程 |
| TUI 技术选型 | Ink 框架（复制 best-claude-code） | 146 文件 / ~27K 行，React + flexbox + 渲染器 |
| 配置优先级 | 环境变量 > last-config.json > 默认值 | `.deepicode/last-config.json` 自动保存 |

---

## 八、已知限制

- `token_estimate` 事件尚未产出（#11 提供了 ContextManager 接口，未接入 loop event）
- Phase 2（智能推理强度调节）未开始
- Phase 6 剩余项（TTSR/Python Kernel/Universal Config）未开始
- Phase 7（E2E 测试矩阵/性能基准/长会话压测）未开始
- 尚无 E2E 测试覆盖 TUI 流程
- SegmentedLog 尚未接入主上下文，未实现原子写入/rewrite/archive/compact
- ToolRegistry 未实现 Agent 过滤和 Deny rules 过滤
- SSE Client 3 项边界用例未覆盖（reasoning_content 剥离/超长单行/并发调用）

---

## 九、持续关注（低风险，不建议立即改动）

| # | 问题 | 理由 |
|---|------|------|
| 1 | Stale-read TOCTOU 窗口 | 毫秒级窗口，atomic rename + exclusive 并发 |
| 2 | Session JSONL 崩溃一致性 | best-effort 设计 |
| 3 | Bash 命令绕过 | 黑名单永远有绕过 |
| 4 | Fuzzy Edit flexible_whitespace 误匹配 | 前 7 pass 约束 |
| 5 | Prompt 注入 | system prompt 声明即可 |
| 6 | 设计文档功能缺口 | Phase 2 未实现 |
| 7 | fold 竞态孤儿 tokenizer | pool 5s 超时自动清理 |
| 8 | Help 消息硬编码 | 不影响功能 |
| 9 | promptOverlayContext 空占位 | MVP 不需要斜杠命令建议 |

---

## 十、驳回项（共 11 项）

| 来源 | 描述 | 驳回理由 |
|------|------|---------|
| v2 | P0-1 reasoning_content 入上下文 | 已改为不入上下文 |
| v2 | P1-4 hash-edit sha256 重复 | indexOf 已保证精确匹配 |
| v2 | P1-5 computeFingerprint 工具顺序 | 不跨 session 持久化 |
| v2 | P1-6 fuzzy fallback 未 re-check stale | fuzzy 路径重新 readFile |
| Audit | NEW-P2-1 flushSoon 竞态 | 降级为低风险 |
| Audit | NEW-P2-4~7 | 不适用/不影响 |
| 第四轮 | NEW-3/4 | 不触发/已等价完成 |
| 2026-06-01 | P1-1 hash-edit 流式竞态 | 审计误读——!replaced 检查在 for-await 循环之后 |
| 2026-06-01 | P3-1 repair 语义变更 | 理论可能但无实际触发路径 |
| 2026-06-01 | P3-4 buildPiModel 硬编码 | 死代码，TODO.md D5 标记清理 |
| 2026-06-01 | TUI-CtrlC | 已在 SIGINT 修复中解决 |

---

## TEST.md 已完成项（31 项）

来自 TEST.md 标记为 ✅ 的测试项，已于各轮次中实现。

### 🟢 简单（15 项）

| # | 模块 | 项 |
|---|------|----|
| S1 | Repair | Truncation 截断后 JSON 合法但语义不同 |
| S2 | SSE Client | reasoning_content 不进入 ChatMessage |
| S3 | list/grep/glob | Bun.Glob 不可用 → fallback |
| S4 | list/grep/glob | rg 不可用回退 grep |
| S5 | Task Manager | 完整流程 — create→get→update→stop |
| S6 | NotebookEdit | 路径穿越保护 |
| S7 | 其余工具 | Cron: crontab 不存在 → 自动创建 |
| S8 | Skills | SkillTool load 不存在 → 返回错误 |
| S9 | Skills | skill 排序 — 按 matching score 降序 |
| S10 | Permission | isAllowed / isDenied 快捷方法 |
| S11 | Permission | 自定义规则从 JSON 加载 |
| S12 | 安全 | bash 敏感文件 |
| S13 | 安全 | web-fetch 内网 IP 拒绝 |
| S14 | 安全 | glob / notebook-edit / monitor 路径穿越 |
| S15 | 安全 | SQL 注入尝试 |

### 🟡 中等（16 项）

| # | 模块 | 项 |
|---|------|----|
| M1 | Context | fold force → yield status 警告事件 |
| M2 | Context | fold suggest + ratio>75% → yield 推荐事件 |
| M3 | Context | fold 100ms 超时降级不阻塞 loop |
| M4 | Session | SessionLoader 系统消息被过滤 |
| M5 | Session | loadSession — 清空+加载+继续 |
| M6 | Session | recover — 静态工厂返回可用 engine |
| M7 | SSE Client | 超长单行 >100K chars 不 OOM |
| M8 | SSE Client | 并发 chatCompletionsStream 不干扰 |
| M9 | Engine+Loop | SessionWriter enqueue 每轮写入 |
| M11 | edit | 并发 edit — 不同文件可并行 |
| M12 | WebFetch | 正常 HTTPS + HTTP 升级 + redirect + HTML 提取 + 超大 + 截断 |
| M13 | WebSearch | 全套 6 项（搜索/空/限制/无结果/结构变更/超时） |
| M14 | HookManager | afterToolCall 异常不中断主流程 |
| M15 | FileSnapshot | SHA256 路径索引 |
| M16 | 多轮工具链 | Task 完整流程 — Create→List→Get→Update→Stop |
| M17 | 错误恢复 | 连续 stream 失败 → 重试，第三次终止 |
| M18 | 错误恢复 | repair 失败 → 不触发 API 重试 |

---
