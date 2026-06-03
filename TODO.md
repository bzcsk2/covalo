# Deepicode TODO 与开发交接指南

最后更新：2026-06-03

本文是后续 Agent 的唯一待办入口，只记录**尚未完成**、**待验收**、**明确暂缓**或**已经驳回**的工作。
已完成能力和历史实施结论见 [DONE.md](DONE.md)。LSP 和 Plugin 的专项设计见 [ADVICE.md](ADVICE.md)。

---

## 0. 开发规则

### 0.1 每次只领取一个闭环

1. 从本文领取一个任务编号。
2. 阅读任务列出的文件和邻近测试，不要先做跨模块重构。
3. 先写失败测试，再做最小实现。
4. 运行目标测试、`bun run typecheck`、`bun test`、`git diff --check`。
5. 完成后从本文删除任务，在 `DONE.md` 记录实现边界、验证命令和保留限制。

工作区可能已有其他 Agent 或用户的改动。禁止用 `git reset --hard`、`git checkout --` 等命令清理不属于当前任务的修改。

### 0.2 不可破坏的架构边界

| 边界 | 当前正确做法 | 禁止事项 |
|------|--------------|----------|
| Core 与 TUI 解耦 | `engine.submit()` 只产出 `AsyncGenerator<LoopEvent>` | 不要从 Core import React、Ink 或 TUI 组件 |
| TUI 状态模型 | `TimelineItem[] + TurnView`，由 `bridge.tsx` 消费事件 | 不要引入完整 `Card[] / Store / TurnTranslator` |
| 工具索引 | 流式事件使用 `toolCallIndex` 关联 | 不要用工具名作为唯一 key |
| 工具结果 | `ToolResult.content` 始终是字符串 | 不要把对象直接塞入上下文，不要绕过 `isError` |
| 权限 | `deny → allow → ask`；`exec` 默认需要确认 | 不要给后台子 Agent 静默放开 `exec` |
| 嵌套工具 | 通过 `ToolContext.invokeTool()`，递归调用被拒绝 | 不要创建第二套 ToolRegistry 或直接调用 Shell |
| MCP | 外部工具通过 MCP bridge 按需发现和调用 | 不要把动态 MCP schema 混入静态 prefix |
| 上下文前缀 | `ImmutablePrefix` 由 system prompt + tool specs 指纹控制 | 不要无理由改变 system prompt 或 schema 顺序 |
| Session | `.deepicode/sessions/*.jsonl`，best-effort append | 不要让持久化失败阻塞主流程 |
| 生命周期 | CLI、Engine、Context、MCP 和 logger 必须显式释放 | 不要用 `process.exit(0)` 掩盖 worker、子进程或日志 flush 泄漏 |
| 编辑 | 保留 stale-read、敏感路径和原子写边界 | 不要用直接覆盖替换安全写入路径 |
| 浏览器 | Playwright 子进程隔离，入口和页面请求执行 SSRF 检查 | 不要允许 localhost、私网 IP、`.local`、`.internal` |

### 0.3 验证命令

```bash
bun run typecheck
bun test
git diff --check
```

目标测试：

```bash
bun test packages/tui/__tests__/bridge.test.ts
bun test packages/core/__tests__/session.test.ts
bun test packages/core/__tests__/streaming-executor.test.ts packages/core/__tests__/engine-tools.test.ts
bun test packages/tools/__tests__/edit.test.ts packages/tools/__tests__/edit-integration.test.ts
bun test packages/mcp/__tests__/mcp-host.test.ts packages/mcp/__tests__/mcp-tools.test.ts
```

---

## 1. 推荐领取顺序

| 顺序 | 任务 | 原因 |
|------|------|------|
| 1 | `OS-12/13-R` macOS/Windows 原生验收 | 代码层面已就绪，需在原生环境验收。 |
| 2 | `LSP-50` 真实语言服务器 smoke，按 [ADVICE.md](ADVICE.md) 推进 | LSP-40 已完成，需验证真实语言服务器。 |
| 3 | `PLG-10` 起步，按 [ADVICE.md](ADVICE.md) 推进 Plugin 兼容实现 | 新增 opencode server plugin 兼容子集，不引入 opencode 前端。 |

不要一次领取多个任务。每个编号完成后都应保持全量测试为绿色。

---

## 2. 后续任务

### OS-12/13-R：macOS 与 Windows 原生验收

优先级：`P1`。三平台 CI 已通过后执行。

当前状态：

- 路径、文件 URL、权限位和 Monitor backend 的代码层已完成。
- 原生平台行为仍需按 `TEST.md` 的 `G3` 与 `H8` 验收。

执行要求：

1. macOS 验证 Bash、BSD `ps`、`df`、`osascript`、crontab、PTY 和路径边界。
2. Windows 验证 PowerShell backend、ConPTY、盘符、反斜杠、UNC path、中文与空格路径、进程树、Monitor、Scheduler、通知 fallback 和剪贴板。
3. GitHub Actions Matrix 只能覆盖自动化部分，不能替代真实终端体验确认。

关闭条件：

- `TEST.md` 中目标平台对应的 `G3` 自动化项通过。
- 项目负责人完成目标平台对应的 `H8` 人工验收。
- 结果写入 `DONE.md`。

### ~~LSP-10：配置、语言识别和返回格式~~ ✅ DONE

优先级：`P2`。专项设计见 [ADVICE.md](ADVICE.md) 的 `LSP-10` 到 `LSP-60`。

当前状态：

- ✅ 已完成（2026-06-03）。
- 实现：config.ts、language.ts、normalize.ts、lsp.ts 升级、lsp-client.ts 更新。
- 测试：36 个单元测试 + 17 个集成测试通过。

### ~~LSP-20：协议层和长驻 Client~~ ✅ DONE

优先级：`P2`。专项设计见 [ADVICE.md](ADVICE.md) 的 `LSP-20`。

当前状态：

- ✅ 已完成（2026-06-03）。
- 实现：vscode-jsonrpc 协议层、LspClient 类。
- 测试：11 个单元测试通过。

### ~~LSP-30：Manager 和文档同步~~ ✅ DONE

优先级：`P2`。专项设计见 [ADVICE.md](ADVICE.md) 的 `LSP-30`。

当前状态：

- ✅ 已完成（2026-06-03）。
- 实现：LspManager 类、文档同步、idle timeout 清理。
- 测试：12 个单元测试通过。

### ~~LSP-40：完整动作集~~ ✅ DONE

优先级：`P2`。专项设计见 [ADVICE.md](ADVICE.md) 的 `LSP-40`。

当前状态：

- ✅ 已完成（2026-06-03）。
- 实现：14 个 actions + 5 个别名。
- 测试：28 个单元测试通过。

### LSP-50：真实语言服务器 smoke

优先级：`P2`。专项设计见 [ADVICE.md](ADVICE.md) 的 `LSP-50`。

当前状态：

- LSP-10/20/30/40 已完成，基础模块就绪。
- 需要验证真实语言服务器（TypeScript、Python、Go、Rust）。

关闭条件：

- 按 `ADVICE.md` 完成当前领取阶段。
- 将阶段实现、验证命令和剩余限制写入 `DONE.md`。
- 从本文更新下一阶段入口。

### PLG-10：Plugin 配置与 spec 解析

优先级：`P2`。专项设计见 [ADVICE.md](ADVICE.md) 的 `PLG-10` 到 `PLG-60`。

当前状态：

- 设计目标是兼容 opencode server plugin 子集。
- 不引入 opencode 前端、不实现 TUI plugin、不引入 opentui/solid。

关闭条件：

- 按 `ADVICE.md` 完成当前领取阶段。
- 将阶段实现、验证命令和剩余限制写入 `DONE.md`。
- 从本文更新下一阶段入口。

---

## 3. 当前验证状态


下一步：优先执行 `OS-12/13-R` macOS/Windows 原生验收（需人工）；开发专项从 `LSP-50` 或 `PLG-10` 开始领取。

---

## 4. 明确暂缓

除非用户明确要求，不要顺手实现：

- 动态 bash 并发判断。
- bash 特判级联取消。
- 默认 LLM 摘要。
- 引入官方 tokenizer；先用真实 usage 校准当前估算误差。
- TTSR 规则系统。
- Universal Config Discovery。
- Python Kernel。
- Web、IDE Plugin、TUI Plugin 等多前端。
- AskUserQuestion 专用 TUI 选择弹窗。
- WebBrowser 跨调用持久会话。
- 完整 OAuth 型 MCP 身份系统。
- 将兼容工具名 `bash` 全仓重命名为 `shell`。
- 为 macOS 完整实现 `launchd` backend。
- 为包结构新增 shared/contracts 包；只有真实循环依赖出现时再评估。
- README 全面重写、配置指南和发布包。

---

