# Deepicode TODO 与开发交接指南

最后更新：2026-06-02

本文是后续 Agent 的唯一待办入口，只记录**尚未完成**、**待验收**、**明确暂缓**或**已经驳回**的工作。
已完成能力和历史实施结论见 [DONE.md](DONE.md)。[ADVICE.md](ADVICE.md) 已归档为空壳，不再作为开发输入。

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
| ~~1~~ | ~~`TEST-STABILITY-01` 全量测试抖动收口~~ | ✅ DONE |
| 2 | `OS-17-R` 三平台 CI 结果检查 | CI scaffold 已加入，需 push 后检查 GitHub Actions Matrix 结果。 |
| 3 | `OS-12/13-R` macOS/Windows 原生验收 | 代码层面已就绪，需在原生环境验收。 |

不要一次领取多个任务。每个编号完成后都应保持全量测试为绿色。

---

## 2. 后续任务

### ~~TEST-STABILITY-01：全量测试抖动收口~~ ✅ DONE

已修复并关闭：

- WebSearch 测试：mock `fetch` 替代真实网络调用，消除外部依赖超时。
- SSE client 测试：`afterEach` 增加 3s 超时保护，防止 server.stop() 挂起阻塞后续测试。
- Benchmark 测试：同上，`afterEach` 增加超时保护。
- 连续 3 次 `bun test` 全绿（799 pass / 0 fail），`bun run typecheck` 通过。

### OS-17-R：三平台 CI 结果检查

优先级：`P1`。在 `TEST-STABILITY-01` 完成后执行。

当前状态：

- `.github/workflows/ci.yml` 已加入 `ubuntu-latest`、`macos-latest`、`windows-latest` Matrix。
- 本地只能确认 workflow 文件存在和 Linux 基线，不能代替 GitHub Actions 三平台运行结果。

执行要求：

1. Push 后保存 Actions run URL 和每个平台的结果。
2. 三个平台都必须运行 `bun run typecheck` 和 `bun test`。
3. 检查 shell backend、进程树、Monitor、Scheduler 和 notification smoke 的实际结果。
4. 失败时按平台记录复现证据，不要把 macOS 或 Windows 失败降级为 Linux 已通过。

关闭条件：

- Linux、macOS、Windows Matrix 均通过，或已有明确 Bug 进入本文新的待办项。
- 将 Actions run URL 和结果写入 `DONE.md`。

### OS-12/13-R：macOS 与 Windows 原生验收

优先级：`P1`。在 `OS-17-R` 之后执行。

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

---

## 3. 当前验证状态

2026-06-03

```text
bun run typecheck
  通过

bun test
  799 pass / 0 fail
  连续 3 次全绿（TEST-STABILITY-01 已关闭）
```

P5.5、AUD-02/03/05/07/08、T21-R、P3-R、S1/S2、ST2/ST3/ST4、CL-10/11/12/20/21/30/31/32/40/41/42/50/51/52、OS-00/10/11/14/15/16、LIFE-01、LOG-READABILITY-01、TEST-STABILITY-01 均已完成。OS-17 三平台 CI scaffold 已加入。

下一步：执行 `OS-17-R` push 后检查 GitHub Actions 三平台 Matrix。

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
- Web、IDE Plugin 等多前端。
- AskUserQuestion 专用 TUI 选择弹窗。
- WebBrowser 跨调用持久会话。
- 完整 OAuth 型 MCP 身份系统。
- 将兼容工具名 `bash` 全仓重命名为 `shell`。
- 为 macOS 完整实现 `launchd` backend。
- 为包结构新增 shared/contracts 包；只有真实循环依赖出现时再评估。
- README 全面重写、配置指南和发布包。

---

## 5. 已驳回方案

以下建议已经复核，不要再次作为新任务提交：

- 不把 Session JSONL 改成每条记录 temp file + rename。保持 append-only 和损坏尾行恢复。
- 不用 Bash 命令白名单替代 deny → allow → ask 权限模型。
- 不把所有同步文件 I/O 机械改成异步。只处理交互热路径。
- 不做全仓常量、注释和命名整理。只在所属模块修改时顺手收敛。
- 不在平台适配中自动翻译 POSIX 命令为 PowerShell。
