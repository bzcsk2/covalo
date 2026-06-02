# Deepicode Code Clean 审查复核与下一步优化规划

> 更新日期：2026-06-02
>
> 适用范围：`code_clean_review_report.md`、`Deepicode-CodeCleanReview-2026-06-02.md` 的复核，以及后续代码清理方向。
>
> 文档定位：本文件是开发路线和约束说明，不是“看到一条就立即修改”的 TODO。执行任务前应先检查当前工作区、同步 `TODO.md`，避免覆盖并行开发中的代码。

## 1. 总体结论

两份 Code Clean 报告都不能直接作为实施清单使用。

- `code_clean_review_report.md` 的通用建议较多，但代码核对不足。它错误地判断项目缺少测试、缺少 README，并把 JSONL 追加写入和 Windows 支持混入代码清理 P0。适合作为检查维度参考，不适合直接指导改代码。Windows 和 macOS 适配确实需要完成，但应作为独立专项推进。
- `Deepicode-CodeCleanReview-2026-06-02.md` 更接近项目实际，但混入了旧版本结论。报告中的敏感路径绕过、Emergency Mode 无法退出、SSE BOM、结果持久化配额、partial repair 等问题，当前代码已经处理或已部分处理。
- 当前最合理的路线不是全面拆文件，而是先恢复门禁、补齐生命周期边界和流式反馈，再做低风险清理，最后才做模块拆分。

必须保护的现有设计：

1. 保持 `ImmutablePrefix + AppendOnlyLog + VolatileScratch` 三区域上下文布局，不破坏 DeepSeek prefix-cache。
2. 保持 `CoreEngine.submit()` 和 `runLoop()` 的 `AsyncGenerator<LoopEvent>` 外部语义。
3. 保持工具调用结果 exactly-once 写回：一个 `tool_call_id` 最多写入一个 `tool` result。
4. 保持会话 JSONL 为 best-effort 辅助持久化，不让磁盘问题阻断主流程。
5. 保持运行时诊断日志默认关闭，关闭时不在热路径增加明显成本。
6. 保持工具协议稳定：跨平台适配优先替换内部 backend，不同时重命名工具、重写 prompt 和改变权限语义。

## 2. 报告结论分类

### 2.1 已确认仍需处理（已完成项标记 ✅）

| ID | 优先级 | 问题 | 核对位置 | 结论 |
| --- | --- | --- | --- | --- |
| ~~CC-01~~ | ~~P1~~ | ~~MCP 请求生命周期不完整~~ | ~~`packages/mcp/src/client.ts`~~ | ✅ CL-10 DONE |
| ~~CC-02~~ | ~~P1~~ | ~~工具进度事件还不是真正实时流式~~ | ~~`packages/core/src/streaming-executor.ts`~~ | ✅ CL-20 DONE |
| ~~CC-03~~ | ~~P1~~ | ~~Session 列表统计字段不兼容~~ | ~~`packages/core/src/session.ts`~~ | ✅ CL-11 DONE |
| ~~CC-04~~ | ~~P2~~ | ~~Bash 输出只在结束时截断~~ | ~~`packages/tools/src/shell-exec.ts`~~ | ✅ CL-21 DONE |
| ~~CC-05~~ | ~~P2~~ | ~~Hash edit 的“8KB 采样”仍会整文件读取~~ | ~~`packages/tools/src/hash-edit.ts`~~ | ✅ CL-12 DONE |
| ~~CC-06~~ | ~~P2~~ | ~~Context 硬预算需要补齐剩余边界~~ | ~~`packages/core/src/context/manager.ts`~~ | ~~✅ CL-30 DONE~~ |
| ~~CC-07~~ | ~~P2~~ | ~~Result persistence 配额只在内存中计数~~ | ~~`packages/core/src/result-persistence.ts`~~ | ~~✅ CL-31 DONE~~ |
| ~~CC-08~~ | ~~P2~~ | ~~包边界被源码相对路径穿透~~ | `packages/mcp/src/*.ts`、`packages/tools/src/*.ts`、`packages/cli/src/tui.ts` | ~~✅ CL-40 DONE：62 个跨包相对路径 import 已替换为包名 import~~ |
| CC-09 | P3 | 长任务仍有同步子进程阻塞 | `packages/tools/src/grep.ts`、`packages/tools/src/web-browser.ts`、`packages/tools/src/cron.ts` | `spawnSync` 会阻塞 TUI spinner、日志 flush 和中断响应。优先改可能长时间运行的 `grep` 和浏览器调用。 |
| ~~CC-10~~ | ~~P3~~ | ~~Session writer 和 logger 的 best-effort 失败缺少可见性~~ | ~~`packages/core/src/session.ts`、`packages/core/src/runtime-logger.ts`~~ | ~~✅ CL-32 DONE~~ |
| OS-01 | P1 | Shell 执行器只会启动 `bash` | `packages/tools/src/shell-exec.ts` | Windows 原生环境通常没有 `bash`。需要平台 backend 和进程树终止策略。 |
| OS-02 | P1 | `glob` 的目录边界判断硬编码 `/` | `packages/tools/src/glob.ts` | `realBase + "/"` 在 Windows 路径上不可靠。需要使用 `relative()` 判断是否越界。 |
| OS-03 | P1 | Monitor 使用 Linux 专属命令 | `packages/tools/src/monitor.ts` | `ps aux --sort`、`df -h`、`free -h` 无法直接覆盖 macOS 和 Windows。 |
| OS-04 | P2 | Cron 只支持 Unix `crontab` | `packages/tools/src/cron.ts` | Windows 需要 Task Scheduler；macOS 可先兼容 crontab，再评估 launchd。 |
| OS-05 | P2 | 桌面通知只支持 Linux `notify-send` | `packages/tools/src/push-notification.ts` | macOS 和 Windows 会退化为 terminal bell，需要平台通知 backend。 |
| OS-06 | P2 | 子进程终止逻辑假设 Unix signal 语义 | `packages/tools/src/shell-exec.ts`、`packages/tools/src/worktree.ts`、`packages/mcp/src/client.ts` | Windows 需要显式终止进程树；不能依赖负 PID 和 `SIGKILL`。 |
| OS-07 | P3 | Browser runner 使用 URL pathname 启动脚本 | `packages/tools/src/web-browser.ts` | Windows 上 `runner.pathname` 可能不是可执行的本地路径，应使用 `fileURLToPath()`。 |

### 2.2 不应直接执行的建议

| 建议 | 判断 | 原因 |
| --- | --- | --- |
| 每条 Session JSONL 都使用 temp file + rename | 不采纳 | JSONL 本身是追加日志，loader 会从尾部寻找最近有效快照。每条记录重写全文件会放大 I/O，并改变 best-effort 设计。应补错误观测和恢复测试。 |
| 把 Windows PowerShell 支持作为零散 P0 热修 | 不采纳 | 目标平台已确认包含 Windows 和 macOS，但不能只替换一个命令。应按 Phase 4 的平台 backend、进程管理和测试矩阵整体推进。 |
| 立即替换为“官方 tokenizer” | 暂缓 | 当前机械截断需要保守估算，不要求计费级精确。引入依赖前先用真实请求 usage 校准误差。 |
| 立即拆分 `runLoop()`、`App.tsx`、`StreamingToolExecutor` | 暂缓 | 这些位置承担事件顺序、React 状态和 exactly-once 写回，先补行为测试，再做渐进提取。 |
| 使用命令白名单替代 Bash deny 规则 | 不采纳 | Bash 是通用工具，白名单会破坏核心能力。安全增强应围绕权限确认、敏感路径和审计日志。 |
| 将所有同步文件 I/O 一律改成异步 | 不采纳 | 启动阶段配置读取、小型语言配置落盘可以保留同步实现。只处理会阻塞交互热路径的操作。 |
| 对所有常量、注释和命名做全仓整理 | 不采纳 | 低收益且容易制造 diff 噪音。只在修改所属模块时顺手收敛。 |

## 3. 分阶段实施路线

## Phase 0：恢复可信基线

目标：先确认当前分支能被验证，再开始任何清理。

### CL-00 保持类型检查门禁

要求：

- 每个任务开始前和完成后都执行 `bun run typecheck`。
- 出现类型错误时先确认是否来自并行修改，合并而不是覆盖。
- 不为了绕过类型错误而放宽稳定契约为 `any`。

验收：

```bash
bun run typecheck
bun test
```

### CL-01 固定回归门禁

要求：

- CI 至少执行 `bun run typecheck` 和 `bun test`。
- 不设“全仓覆盖率 > 80%”这种空泛门槛。对高风险模块按行为矩阵补测试。
- 后续每个任务只修改一个责任边界，禁止混入格式化全仓或无关重命名。

## Phase 1：修复生命周期和数据正确性

### CL-10 MCP client 生命周期闭环

范围：

- `packages/mcp/src/client.ts`
- `packages/mcp/__tests__/`

实现约束：

1. 提取统一的 pending reject helper：reject 前清理每个 timer，再清空 Map。
2. `request()` 发请求前检查 `proc`、`stdin`、`stdin.writable`。
3. 处理 `stdin.write()` callback error；写入失败立即 reject 并移除 pending。
4. `disconnect()` 即使 `_connected === false`，只要 `proc` 存在也应执行清理。
5. initialize 失败时终止进程、清空 pending、重置 `proc` 和 `_connected`。
6. MCP stderr 默认不打印到终端；诊断日志开启时记录有长度上限的片段。
7. malformed JSON 行在诊断日志中记录长度和 server 名称，不记录潜在敏感全文。

验收矩阵：

- 子进程正常响应：timer 被清除。
- 子进程请求中途退出：请求立即 reject，不等待 30 秒。
- stdin 不可写：请求立即 reject。
- initialize 超时或返回非法结果：进程被回收。
- `disconnect()` 可重复调用。
- malformed JSON 不影响后续合法响应解析。

### CL-11 Session summary stats 兼容读取

范围：

- `packages/core/src/session.ts`
- `packages/core/__tests__/session*.test.ts`

要求：

- 新格式读取 `promptTokens/completionTokens`。
- 为旧会话保留 `inputTokens/outputTokens` 兼容读取。
- 明确优先级：优先新字段，旧字段作为 fallback。
- 不迁移、不重写已有 JSONL。

验收：

- 新格式 stats 正确显示。
- 旧格式 stats 仍可显示。
- torn tail line 不影响最近有效 messages 和 stats 读取。

### CL-12 Hash edit 采样读取和流关闭

范围：

- `packages/tools/src/hash-edit.ts`
- `packages/tools/__tests__/edit.test.ts`

要求：

- 使用文件句柄读取前 8192 字节，不得为二进制探测整文件读取。
- 未找到目标时等待 writer 完成关闭后再清理临时文件。
- 保持 rename 原子替换、权限保留、CRLF 行为和 stale-read 语义不变。

验收：

- 大文件二进制采样不会读取完整文件。
- 命中、未命中、写入失败、rename 失败均无残留临时文件。
- 现有 edit 回归测试全部通过。

## Phase 2：完成真实的 Tool Progress 流

### CL-20 设计原则

当前实现只把 progress 收集到数组，工具完成后再统一吐出。这能展示历史信息，但不能填补工具执行期间的静默窗口。

目标事件序列：

```text
tool_start
tool_progress(running)
tool_progress(...)
tool_progress(...)
tool_result | error
tool_progress(done)
```

要求：

1. 工具执行和 progress 消费必须并行。可使用有界 async queue/channel，不能在内存中无限堆积。
2. `tool_progress` 只用于 TUI 瞬时反馈，不写入 session JSONL。
3. 对高频 stdout/stderr 做限频或合并，例如固定时间窗口内只保留最新片段。
4. exclusive、shared 和 nested workflow 三条路径都要支持 progress。
5. 工具结果仍按原有 exactly-once 规则写回上下文。
6. interrupt 后停止接收 progress，settle 未完成调用，不允许生成重复 tool result。

范围：

- `packages/core/src/interface.ts`
- `packages/core/src/streaming-executor.ts`
- `packages/core/src/loop.ts`
- `packages/tools/src/shell-exec.ts`
- `packages/tui/src/bridge.tsx`
- 对应测试

验收矩阵：

- 运行一个持续 2 秒并周期输出的 Bash 命令，结束前 TUI 已收到 progress。
- shared 工具并发时 progress 可带 `toolCallIndex` 正确归属。
- Workflow 内嵌 Bash 的 progress 不丢失。
- progress 高频输出不会造成无界内存增长。
- `bun test` 和 `bun run typecheck` 通过。

### CL-21 Bash 有界输出

要求：

- stdout/stderr 保存为有界结构，至少保留最终返回所需的截断片段和累计字符数。
- `AbortSignal` listener 在结束路径解除，timer 在所有路径清理。
- 区分 timeout、abort、spawn error 和正常非零退出。
- 保持结果字段兼容：`stdout`、`stderr`、`exitCode`、`timedOut`。

## ✅ Phase 3：上下文和持久化边界收口 ✅

### ~~CL-30 Context budget 完整定义~~ ✅

范围：

- `packages/core/src/context/manager.ts`
- `packages/core/__tests__/context.test.ts`

要求：

1. 保留三区域顺序和 prefix 字节稳定性。
2. 对以下边界明确行为：
   - prefix 单独超过窗口；
   - scratch 单独超过窗口；
   - log 没有 user message；
   - 多个 tool result 必须与对应 assistant tool_calls 原子保留或一起移除；
   - 截断后仍超预算。
3. 无法安全截断时返回结构化错误或 fold 信号，不要静默发送必然超限的请求。
4. Token estimator 继续作为快速机械兜底。先记录实际 usage 偏差，再决定是否引入新 tokenizer。

### ~~CL-31 Result persistence 从软配额升级为可解释配额~~ ✅

范围：

- `packages/core/src/result-persistence.ts`
- 对应测试

要求：

- 初始化 session 使用量时扫描现有结果文件，或把配额明确标注为 process-lifetime soft quota。
- 删除旧文件后同步回收内存计数。
- 清理失败在诊断模式记录，不影响主流程。
- 不在每次小结果返回时扫描目录，只在首次使用或溢出结果时执行。

### ~~CL-32 Session writer 可观测性~~ ✅

范围：

- `packages/core/src/session.ts`
- `packages/core/src/runtime-logger.ts`

要求：

- 保持 append-only JSONL。
- loader 继续容忍最后一行损坏。
- 开启诊断日志时记录 queue overflow、序列化失败、append 失败和 droppedCount。
- 不要求每条写入 fsync，不要求每条记录 rename。

## Phase 4：Windows 与 macOS 平台适配

目标平台：

| 平台 | 最低目标 | Shell 默认 backend | 计划任务 backend | 通知 backend |
| --- | --- | --- | --- | --- |
| Linux | 保持现有能力 | `bash -c` | `crontab` | `notify-send`，失败时 terminal bell |
| macOS | 原生可用 | `/bin/bash -c`，允许配置覆盖 | 第一阶段兼容 `crontab`；第二阶段评估 `launchd` | `osascript`，失败时 terminal bell |
| Windows | 原生 PowerShell 可用，不要求安装 WSL 或 Git Bash | 优先 `pwsh.exe -NoProfile -NonInteractive -Command`，fallback `powershell.exe` | `schtasks.exe` | PowerShell 通知能力或 terminal bell fallback |

### OS-00 平台适配原则

1. 保持对模型暴露的工具名 `bash` 暂时不变。该名称已经进入 agent tool 列表、权限规则、TUI 渲染和大量测试；立即改名会制造无关回归。
2. 将 `bash` 视为历史兼容名，内部语义改为“执行当前平台 shell 命令”。工具 description 和 system prompt 必须告诉模型真实 backend。
3. 不假设 Windows 安装 WSL、Git Bash 或 `bash.exe`。这些只能作为用户显式配置的可选 backend。
4. 不追求不同 shell 语法完全等价。PowerShell 和 POSIX shell 的命令文本不同，应依赖平台提示词引导模型生成正确命令。
5. 平台判断集中管理，禁止在每个工具中散落 `process.platform === ...` 分支。
6. 所有外部命令使用 `spawn` / `execFile` 参数数组，避免拼接 shell 字符串导致转义和注入问题。

### OS-10 建立平台能力层

建议新增：

- `packages/tools/src/platform/capabilities.ts`
- `packages/tools/src/platform/process-tree.ts`
- `packages/tools/src/platform/shell-backend.ts`
- `packages/tools/src/platform/scheduler-backend.ts`
- `packages/tools/src/platform/notification-backend.ts`
- `packages/tools/src/platform/monitor-backend.ts`

能力模型至少包含：

```ts
interface PlatformCapabilities {
  platform: "linux" | "darwin" | "win32"
  shell: { id: "bash" | "pwsh" | "powershell"; executable: string; args: string[] }
  scheduler: { id: "crontab" | "schtasks" | "unsupported" }
  notification: { id: "notify-send" | "osascript" | "powershell" | "terminal-bell" }
  supportsPosixSignals: boolean
}
```

要求：

- Shell backend 支持环境变量覆盖，例如 `DEEPICODE_SHELL` 和可选 `DEEPICODE_SHELL_ARGS`。
- 覆盖值必须经过可执行文件探测；不可用时返回结构化错误，不静默回退到语义不同的 shell。
- 默认探测只在首次使用时执行并缓存，避免每次工具调用产生额外子进程。
- 将平台和选中的 backend 写入诊断日志，但不记录用户命令全文。

### OS-11 Shell backend 与进程树终止

范围：

- `packages/tools/src/shell-exec.ts`
- `packages/tools/src/platform/shell-backend.ts`
- `packages/tools/src/platform/process-tree.ts`
- `packages/core/src/system-prompt.ts`
- 对应测试

实现要求：

1. Linux 和 macOS 保持 POSIX 命令语义，优先使用明确的 Bash 可执行文件。
2. Windows 默认使用 PowerShell。优先探测 `pwsh.exe`，否则使用系统自带 `powershell.exe`。
3. Windows PowerShell 参数至少包含 `-NoProfile` 和 `-NonInteractive`，降低用户 profile 副作用。
4. POSIX 平台继续使用 detached process group，并按 `SIGTERM → grace period → SIGKILL` 终止。
5. Windows 使用独立的进程树终止 helper，例如通过 `taskkill.exe /PID <pid> /T /F` 回收子进程。禁止只 kill 父进程。
6. 保持现有输出上限、progress 限频、timeout、abort 和返回字段兼容。
7. DENY 规则按 shell backend 分组。POSIX 的 `rm -rf /` 规则不能假装覆盖 PowerShell；Windows 至少覆盖递归删除系统盘、格式化卷、危险磁盘操作和提权启动。

system prompt 要求：

- 明确当前 OS 和 shell backend。
- Windows 示例使用 PowerShell，例如 `Get-ChildItem`、`Get-Content`、`Select-String`。
- Linux/macOS 示例继续使用 POSIX 命令。
- 推荐优先使用 `read_file`、`list_dir`、`grep` 等结构化工具，降低 shell 差异暴露面。

兼容策略：

- 第一阶段保留工具名 `bash`。
- 等平台适配稳定后，再评估新增中性名称 `shell`，并把 `bash` 保留为 alias。不要在同一批改动中同时重命名。

### OS-12 路径、文件 URL 和权限位兼容

范围：

- `packages/tools/src/glob.ts`
- `packages/tools/src/web-browser.ts`
- `packages/tools/src/hash-edit.ts`
- `packages/tools/src/notebook-edit.ts`
- `packages/mcp/src/auth.ts`
- 对应测试

要求：

1. 目录包含判断统一使用 `relative(base, candidate)`：结果为空表示同目录；以 `..` 开头或为绝对路径表示越界。禁止字符串拼接 `/` 判断。
2. 跨平台敏感路径检查继续先把反斜杠规范化为 `/`，并补充 Windows 用户目录、盘符和 UNC 路径测试。
3. Browser runner 从 `import.meta.url` 转本地路径时使用 `fileURLToPath()`，不得直接使用 URL pathname。
4. `chmod()` 和 Unix mode 保留属于 best-effort：POSIX 平台执行；Windows 不把 mode 失败视为业务失败。
5. 所有测试临时目录使用 `tmpdir()` 和 `join()`，不要硬编码 `/tmp`。
6. 增加包含空格、中文、反斜杠、盘符和 UNC path 的测试样例。

### OS-13 Monitor 平台 backend

范围：

- `packages/tools/src/monitor.ts`
- `packages/tools/src/platform/monitor-backend.ts`
- 对应测试

实现顺序：

1. `memory` 优先使用 Node `os.totalmem()`、`os.freemem()`，三平台共享。
2. `file` 继续使用 Node `fs.stat()`，三平台共享。
3. `process` 使用平台 backend：
   - Linux：`ps` 参数数组；
   - macOS：兼容 BSD `ps`，不要使用 GNU `--sort`；
   - Windows：PowerShell `Get-Process` 或 `tasklist.exe`。
4. `disk` 使用平台 backend：
   - Linux/macOS：`df` 参数数组；
   - Windows：PowerShell `Get-PSDrive -PSProvider FileSystem`。
5. 删除 shell pipeline，例如 `ps ... | head -20`。采样后在 TypeScript 中排序和截断。
6. 将 exec 同步调用改为异步 spawn，支持 timeout 和 abort。

验收：

- 三平台都能返回稳定的结构化字段，而不是平台命令原始文本。
- 单个采样失败不终止 Monitor 工具；结果中包含 `error` 和 backend 信息。

### OS-14 Scheduler backend

范围：

- `packages/tools/src/cron.ts`
- `packages/tools/src/platform/scheduler-backend.ts`
- 对应测试

策略：

- 对外工具名暂时保持 `Cron`，返回结果增加 `backend` 字段。
- Linux 使用 `crontab`。
- macOS 第一阶段沿用 `crontab`，确保 list/create/delete 可用；是否迁移到 `launchd` 单独做 ADR，因为 launchd 的 plist 模型与 cron expression 不等价。
- Windows 使用 `schtasks.exe`。不要把任意 cron expression 直接伪装成 `schtasks` 参数；先支持可可靠映射的 schedule 子集，对不可映射表达式返回明确错误。

要求：

- 抽象统一数据结构，例如 `{ name, schedule, command, backend }`。
- Windows 任务名增加 Deepicode 前缀，避免删除用户已有任务。
- create/delete 继续保留换行过滤和名称校验。
- 外部命令改为异步执行，支持 timeout。

### OS-15 Notification backend

范围：

- `packages/tools/src/push-notification.ts`
- `packages/tools/src/platform/notification-backend.ts`
- 对应测试

要求：

- Linux：使用 `execFile("notify-send", args)`，不拼接 shell 字符串。
- macOS：使用 `osascript` 参数传值或安全生成脚本，覆盖引号和换行测试。
- Windows：优先实现无需额外依赖的 PowerShell 路径；失败时 terminal bell fallback。
- 返回 `{ sent, method, fallbackReason? }`，使降级行为可诊断。
- 通知失败不能阻断 Agent 主流程。

### OS-16 其他子进程与 TUI 检查

范围：

- `packages/tools/src/worktree.ts`
- `packages/mcp/src/client.ts`
- `packages/tools/src/lsp-client.ts`
- `packages/tui/src/ModelPicker.tsx`
- `packages/ink/src/`

检查项：

- `Worktree`、MCP 和 LSP 统一复用 process-tree helper，确保 timeout 和 abort 后不残留子进程。
- `ModelPicker` 为 Windows 增加剪贴板读取 backend，例如 PowerShell `Get-Clipboard`。
- 复用现有 Ink 中的 Windows terminal 兼容逻辑，不在 Deepicode TUI 重复实现终端控制层。
- 验证 Windows Terminal、PowerShell 7、系统 PowerShell、macOS Terminal 和常见 Linux terminal。

### OS-17 CI 与验收矩阵

CI 建议使用 GitHub Actions matrix：

```yaml
os: [ubuntu-latest, macos-latest, windows-latest]
```

每个平台必须执行：

```text
1. bun run typecheck
2. bun test
3. shell backend 探测和简单命令执行
4. shell timeout、abort 和子进程树回收
5. glob 项目目录边界和路径 traversal
6. hash-edit、notebook-edit 的原子替换
7. Monitor memory/file/process/disk
8. Scheduler backend 可用能力测试；不可用能力必须返回结构化错误
9. Notification backend 或 terminal bell fallback
10. TUI 启动、slash menu 上下键、退出后终端恢复
```

平台专项验收：

- Linux：现有行为不回归。
- macOS：Bash、BSD `ps`、`df`、`osascript`、crontab 路径通过。
- Windows：无需安装 WSL 或 Git Bash即可完成启动、PowerShell 命令执行、中断、路径边界、Monitor、通知降级和 TUI 基础交互。

不建议在第一批处理：

- 将所有 POSIX 命令自动翻译成 PowerShell；
- 为 macOS 立即完整实现 launchd；
- 将 `bash` 工具立即全仓重命名为 `shell`；
- 为平台 backend 引入大型依赖框架。

## Phase 5：渐进式边界清理

### ✅ CL-40 Workspace 包边界整理

目标：减少 `../../core/src/...` 和 `../../tools/src/...` 穿透引用。

顺序：

1. 盘点跨包使用的稳定契约：`AgentTool`、`ToolContext`、`ToolResult`、`LoopEvent`、`ToolSpec`、`safeStringify`。
2. 优先从已有包入口导出，不先创建新的 shared 包。
3. 修改 import 后执行全仓 typecheck 和 tests。
4. 只有出现真实循环依赖时，才考虑创建轻量 contracts 包。

禁止：

- 不为了“层次好看”复制类型。
- 不把 runtime logger 强行放入所有 package。
- 不一次性迁移所有文件。

### ✅ CL-41 工具注册表收敛

范围：

- `packages/cli/src/tui.ts`
- `packages/tools/src/index.ts`
- `packages/tools/src/registry.ts`

目标：

- 用一个工厂函数生成 CLI 默认工具集合，避免新增工具时遗漏注册。
- 保留工具构造顺序和名称，不改变 system prompt 中工具规格排序策略。
- MCP 动态工具与内置工具仍分开管理。

### ✅ CL-42 热路径同步阻塞清理

优先顺序：

1. `packages/tools/src/grep.ts`
2. `packages/tools/src/web-browser.ts`
3. `packages/tools/src/cron.ts`
4. 测量后再决定是否修改 `packages/tools/src/task-manager.ts`

要求：

- 使用异步 `spawn`，支持 `AbortSignal`、timeout、输出上限。
- 保持现有工具返回格式。
- 启动配置和小型 locale 文件允许保留同步 I/O。

## Phase 6：受测试保护的可维护性重构

只有 Phase 0-5 完成且行为测试稳定后，才进入本阶段。

### CL-50 `StreamingToolExecutor` 渐进提取

可提取：

- permission decision helper；
- bounded progress queue；
- result persistence adapter；
- settle ledger。

不建议：

- 一次性重写成复杂 scheduler 框架；
- 引入 RxJS、Effect TS 或新的并发库；
- 改变 `AsyncGenerator<LoopEvent>` 接口。

### CL-51 `runLoop()` 渐进提取

只提取纯逻辑：

- tool call ID normalize；
- duplicate tool-call detector；
- mode switch signal 构造；
- pending instruction safe-point helper。

保留：

- API stream 消费、yield 顺序和 session enqueue 的主控制流仍集中在 `runLoop()`。

### CL-52 TUI command routing 收敛

范围：

- `packages/tui/src/App.tsx`
- `packages/tui/src/bridge.tsx`

目标：

- 将 slash command 解析和 handler 映射提取为可测试逻辑。
- 保留 React state 所有权，避免一次性拆散输入、权限确认、session 切换和流式渲染。
- 为菜单上下键、历史记录、slash completion、permission prompt 增加最小交互回归测试。

## 4. 日志系统后续原则

日志系统已经具备 `RuntimeLogger`、异步 append、level、filter、child bindings 和默认关闭能力。Code Clean 阶段只补接入和边界，不重新设计日志架构。

要求：

- 默认 `DEEPICODE_LOG_LEVEL` 未设置时关闭。
- 日志开启后重点覆盖 submit、API 请求、tool 执行、MCP 请求、session writer、result persistence 和 interrupt。
- 不记录 API key、完整敏感路径内容、完整 MCP stderr、完整 SSE payload。
- 记录事件名、耗时、长度、状态、requestId/submitId/toolCallId 等可关联字段。
- 对 dropped logs 和 dropped session records 提供可观测计数。

## 5. Agent 执行约束

后续 Agent 开始任何任务前必须：

1. 读取 `TODO.md`、`DONE.md`、本文件和目标模块。
2. 执行 `git status --short`，识别用户或其他 Agent 的未提交修改。
3. 不回滚、不覆盖与当前任务无关的已有修改。
4. 先补或确认回归测试，再修改高风险控制流。
5. 每次只完成一个 CL 或 OS 任务；完成后把结果写入 `DONE.md`，未完成项保留在 `TODO.md`。

禁止事项：

- 禁止在清理任务中顺手全仓格式化。
- 禁止把历史报告中的行号当成当前代码事实。
- 禁止绕过 `settle()` 直接追加 tool result。
- 禁止破坏 JSONL 向后兼容。
- 禁止破坏 prefix-cache 字节稳定性。
- 禁止把默认关闭的诊断功能改成热路径强制开启。

## 6. 推荐执行顺序

| 顺序 | 任务 | 原因 |
| --- | --- | --- |
| 1 | CL-00 类型检查门禁 | 每个任务前后保持可信基线，发现并行回归时先收口。 |
| 2 | CL-10 MCP 生命周期闭环 | 有真实请求悬挂和资源清理风险，修改范围清晰。 |
| 3 | CL-11 Session stats 兼容读取 | 用户可见错误，改动小，风险低。 |
| 4 | CL-12 Hash edit 采样和关闭路径 | 降低大文件成本，保持原子编辑语义。 |
| 5 | CL-20、CL-21 Tool Progress 和 Bash 有界输出 | 直接改善 TUI 长工具体验，并消除无界内存。 |
| 6 | CL-30、CL-31、CL-32 边界收口 | 补齐极端工况和开发诊断能力。 |
| 7 | OS-00、OS-10 平台能力层 | 先固定平台契约，避免在各工具中散落条件分支。 |
| 8 | OS-11、OS-12 Shell、进程树和路径兼容 | 先完成 Windows/macOS 可运行所需的基础能力。 |
| 9 | OS-13 至 OS-16 Monitor、Scheduler、通知和 TUI 检查 | 补齐用户可见的平台差异。 |
| 10 | OS-17 三平台 CI | 把适配结果变成持续门禁。 |
| 11 | CL-40、CL-41、CL-42 包边界和热路径清理 | 在功能稳定后降低维护成本。 |
| 12 | CL-50、CL-51、CL-52 渐进式拆分 | 最后处理结构优化，避免先制造回归。 |

## 7. 验收基线

每个阶段至少执行：

```bash
bun run typecheck
bun test
```

涉及交互或长任务时追加手工验证：

```text
1. 启动 TUI，输入 slash command，确认上下键不会关闭菜单。
2. 执行一个持续输出 2 秒以上的 Bash 命令，确认命令结束前可看到 tool_progress。
3. 中断长 Bash 命令，确认子进程结束、TUI 恢复输入、上下文只写入一个 tool result。
4. 切换 session，确认新工具结果写入新 session，session 列表 token 统计正确。
5. 启用诊断日志，确认能关联 submit → API → tool/MCP → result；关闭后不生成运行时日志文件。
6. 在 Linux、macOS 和 Windows 原生环境分别启动 TUI，确认 system prompt 识别正确平台和 shell backend。
7. 在 Windows 原生 PowerShell 环境执行、超时并中断长命令，确认不要求 WSL 或 Git Bash，且子进程树被回收。
8. 在 macOS 验证 Bash、Monitor、通知和 crontab 路径；在 Windows 验证 PowerShell、Monitor、Scheduler、通知 fallback 和包含空格的路径。
```

## 8. 本次复核验证记录

截至 2026-06-02，本次复核实际执行：

```bash
bun run typecheck
bun test
```

结果：

- `bun run typecheck` 最终通过。复核期间并行开发曾短暂引入 `ModeStats` 导入和 `turnsElapsed` 作用域错误，均已由并行修改解决；因此 Phase 0 仍需作为持续门禁。
- `bun test` 通过：`724 pass / 0 fail`，共运行 54 个测试文件，足以证明“项目没有测试”是误判。后续仍需根据上述高风险路径补专项回归测试。
