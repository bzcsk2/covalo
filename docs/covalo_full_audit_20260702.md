# Covalo 代码审计核验后的修复执行规格

**项目**: `bzcsk2/covalo`  
**目标分支**: `main`  
**生成日期**: 2026-07-02  
**用途**: 给 coding agent 执行的修复 spec。  
**原则**: 只处理已核实问题；剔除误判；避免“为了过审计而大改架构”。

---

## 0. 执行边界

本 spec 基于对原审计报告与仓库实际代码的交叉核验。原审计报告中存在严重性膨胀和少量误判，因此执行时不得照单全修。

### 必须遵守

1. **不要一次性重构全项目**。按本文件的 Phase 顺序分批提交。
2. **每个任务必须有最小可验证改动**：修复代码、补测试、跑相关测试。
3. **安全修复优先保持兼容**，但遇到危险默认行为时应 fail-closed。
4. **不要为了消除 warning 而吞掉功能**。对于历史兼容入口，添加显式开关、日志和测试。
5. **禁止引入大型依赖**，除非该依赖是安全边界必须项。优先用 Node 标准库实现。
6. **所有空 `catch {}` 应至少记录到现有 logger 或 diagnostics callback**；如果上下文无 logger，保留 best-effort 但加注释说明为什么不能传播。

---

## 1. 重新定级后的修复清单

### Phase 1 — 立即修复，安全与数据损坏

| ID | 文件 | 问题 | 新定级 |
|---|---|---|---|
| S1 | `packages/core/src/eval/verifier.ts` | verifier command 在无 sandbox 时直接 `execSync(command)` | P0 |
| S2 | `packages/core/src/eval/verifier.ts` | `scriptPath` 拼入 shell command | P0 |
| S3 | `packages/memory/src/runtime/memory-store.ts` | 固定 `.tmp` 文件导致并发写损坏；`update()` 读改写也可丢更新 | P0/P1 |
| S4 | `packages/plugin/src/content-pack/ecc-hook-adapter.ts` | content pack hook 用 `sh -c` 执行 manifest command | P0/P1，取决于插件信任边界 |
| S5 | `packages/tools/src/web-fetch.ts` | SSRF 防护用字符串前缀，存在绕过/误拦截/TOCTOU | P1 |

### Phase 2 — 高优先级正确性

| ID | 文件 | 问题 | 新定级 |
|---|---|---|---|
| C1 | `packages/core/src/engine.ts` | `contextPolicyLoadPromise` 在 `submit()` 入口未 await | P1 |
| C2 | `packages/core/src/engine.ts` | `spawnSubagent()` 即使 worker failed 仍返回 `completed` | P1 |
| C3 | `packages/mcp/src/client.ts` | JSON-RPC notification 被静默丢弃 | P1 |
| C4 | `packages/mcp/src/client.ts` | 只按换行分帧，无尾换行消息可能滞留 buffer | P1 |
| C5 | `packages/core/src/eval/runner.ts` | `process.chdir(workspaceDir)` 修改全局 CWD | P1 |
| C6 | `packages/tools/src/shell-dual-track/background-task-manager.ts` | hard timeout timer 未保存/未清除，可能阻止进程退出 | P1 |
| C7 | `packages/tools/src/shell-dual-track/bash-dual-track.ts` | graceful kill 的 SIGKILL timer 会被 cleanup 立即清掉 | P1 |
| C8 | `packages/core/src/runtime-logger.ts` | `pendingOverflow` 无上限 | P1 |
| C9 | `packages/memory/src/memory-service.ts` | `start()` 非幂等，重复调用会重复注册 timers/functions | P1 |

### Phase 3 — 评估准确性、资源清理、解析稳健性

| ID | 文件 | 问题 | 新定级 |
|---|---|---|---|
| Q1 | `packages/core/src/eval/runner.ts` | `git diff \| wc -l` 跨平台不兼容 | P2 |
| Q2 | `packages/core/src/eval/runner.ts` | verifier skipped 与 failed 均按 0 分处理 | P2 |
| Q3 | `packages/core/src/client.ts` | AbortSignal 第二个匿名 listener 未清理 | P2 |
| Q4 | `packages/core/src/loop.ts` | 工具执行 catch 吞异常 | P2 |
| Q5 | `packages/core/src/streaming-executor.ts` | generator catch 不记录原始异常 | P2 |
| Q6 | `packages/core/src/config.ts` | `saveProjectApiKey/deleteProjectApiKey` tmp 文件只用 pid | P2 |
| Q7 | `packages/core/src/supervisor/guided-loop.ts` | `reasoning_delta` 与 `text_delta` 混入同一 output buffer | P2 |
| Q8 | `packages/core/src/scoring/eval-runner.ts` | JSON parse 只尝试第一个 fenced block，boolean 仅接受 `true` | P2 |
| Q9 | `packages/core/src/scoring/rubric.ts` | 自定义 rubric 缺失维度时归一化不正确 | P2 |
| Q10 | `packages/core/src/tool-calls/text-parsers.ts` | JSON 工具调用解析和剥离存在 O(n²) 热点 | P2/P3 |
| Q11 | `packages/core/src/perfetto-tracing.ts` | `splice(0, MAX_EVENTS / 2)` 高频下产生延迟尖峰 | P3 |
| Q12 | `packages/security/src/hooks.ts` | hook deny 不携带错误上下文；first-match-wins 行为需明确 | P2/P3 |
| Q13 | `packages/security/src/permission.ts` | 非 exec tier 默认 allow；需要显式策略或文档化 | P2/P3 |
| Q14 | `packages/shell/src/state.ts` | notify 遍历 listeners 时未快照 | P3 |
| Q15 | `packages/core/src/dual-session/session.ts`、`packages/core/src/task-ledger.ts` | Set/数组长期增长无边界 | P3 |

---

## 2. Phase 1 详细修复规格

### S1. 修复 command verifier 直接 shell 执行

**文件**: `packages/core/src/eval/verifier.ts`

#### 当前问题

`manifest.verifier.command` 来自 eval manifest。当前无 sandbox provider 时直接执行：

```ts
execSync(command, { cwd: workspaceDir, ... })
```

这等同于把 manifest 字符串交给宿主机 shell。

#### 修复方案

1. 新增安全执行策略：
   - 默认必须通过 sandbox provider 执行 command verifier。
   - 如果没有 sandbox provider：
     - 默认返回 `verdict: "error"`，错误信息为 `Direct command verifier disabled; configure sandbox provider or set COVALO_ALLOW_DIRECT_VERIFIER=1 for trusted local evals.`
     - 只有当 `process.env.COVALO_ALLOW_DIRECT_VERIFIER === "1"` 时才允许 direct 执行。
2. direct 执行保留兼容，但必须：
   - 打出 runtime/diagnostic warning。
   - 明确标注 `details` 中含 `Direct verifier execution enabled by COVALO_ALLOW_DIRECT_VERIFIER=1`.
   - 不把 direct 结果标记为 official benchmark score。
3. 如果类型系统允许，扩展 manifest verifier：
   - 推荐新增结构化字段：`argv?: string[]`。
   - 当 `argv` 存在时使用 `execFileSync(argv[0], argv.slice(1), { cwd })`。
   - 旧的 `command: string` 只允许 sandbox 或显式 direct override。
4. 不要尝试用简单 split 把 shell string 转成 argv；这会制造新的解析漏洞。

#### 验收标准

- 无 sandbox provider 且无 `COVALO_ALLOW_DIRECT_VERIFIER=1` 时，command verifier 不会执行宿主机命令。
- 有 sandbox provider 时行为保持兼容。
- direct override 只在显式 env 下生效。
- 测试覆盖：
  - 恶意 command：`echo ok; touch /tmp/covalo-pwned` 不应在无 override 时执行。
  - sandbox provider mock 应收到原 command。
  - direct override 下旧行为可用，但结果 details 含 warning。

---

### S2. 修复 script verifier 的 `scriptPath` shell 拼接

**文件**: `packages/core/src/eval/verifier.ts`

#### 当前问题

当前代码使用：

```ts
execSync(`bun run ${scriptPath}`, { cwd: workspaceDir, ... })
```

`scriptPath` 可通过 `;`、`&&`、反引号、`$()` 等注入 shell 命令。

#### 修复方案

1. 新增 helper：

```ts
function resolveVerifierScriptPath(workspaceDir: string, scriptPath: string): string
```

要求：

- `scriptPath` 必须是非空字符串。
- 禁止 NUL 字符。
- 禁止 shell metacharacters：`;`, `&`, `|`, `<`, `>`, `` ` ``, `$(`, newline。
- 使用 `resolve(workspaceDir, scriptPath)` 解析。
- 使用 `relative(workspaceDir, resolved)` 校验 containment：
  - `!relativePath.startsWith("..")`
  - `!isAbsolute(relativePath)`
- 可选：要求文件存在且后缀为 `.js`/`.ts`/`.mjs`/`.cjs`。

2. direct 模式改成：

```ts
execFileSync("bun", ["run", resolvedScriptPath], {
  cwd: workspaceDir,
  encoding: "utf-8",
  maxBuffer,
  timeout,
  stdio: "pipe",
})
```

3. sandbox provider 模式：
   - 如果 provider 仅接受 command string，则先校验 `scriptPath`，再构造安全 command。
   - 推荐把 `SandboxCommand` 扩展为 `{ executable?: string; args?: string[] }`，后续 provider 优先走 argv。
   - 如果短期不能改 provider，至少使用校验后的相对路径，并做 shell escaping；但仍应保留 TODO，将 provider command 改为 argv。

#### 验收标准

- `scriptPath: "x.js; rm -rf /"` 返回 error，不执行。
- `scriptPath: "../outside.js"` 返回 error。
- 合法脚本仍能运行。
- 测试覆盖 direct 和 sandbox mock 两条路径。

---

### S3. 修复 MemoryStore 并发写损坏

**文件**: `packages/memory/src/runtime/memory-store.ts`

#### 当前问题

`set()` 使用固定临时文件：

```ts
const tmp = path + ".tmp"
writeFileSync(tmp, data)
renameSync(tmp, path)
```

同 key 并发 `set()` 会竞争同一个 tmp 文件。`update()` 还存在 read-modify-write 丢更新风险。

#### 修复方案

1. 引入唯一临时文件名：

```ts
const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
```

2. 引入 per-key async lock，保护同一 `scope/key` 的 `set/update/delete`。

建议实现：

```ts
private locks = new Map<string, Promise<void>>()

private async withKeyLock<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T> {
  const lockKey = `${scope}\0${key}`
  const prev = this.locks.get(lockKey) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>(resolve => { release = resolve })
  this.locks.set(lockKey, prev.then(() => next, () => next))
  await prev
  try {
    return await fn()
  } finally {
    release()
    if (this.locks.get(lockKey) === next) this.locks.delete(lockKey)
  }
}
```

注意上面只是伪码，实际要确保 Map 中保存的是链式 promise，避免提前删除正在排队的 lock。

3. `update()` 必须整体放进同一 lock：
   - lock 内读取当前值。
   - 应用 ops。
   - lock 内写回。
4. `set()` 的 fallback 写入要清理对应唯一 tmp。
5. 可选：写入前 `fsync` 文件和目录，提高崩溃一致性；这不是本轮必须项。

#### 验收标准

- 并发 100 次 `set()` 不产生 JSON 半截文件。
- 并发 100 次 `update(... append ...)` 不丢元素。
- tmp 文件不会残留，除非故意模拟 rename 异常。
- Windows/Linux 都通过。

---

### S4. 收紧 content pack hook 执行边界

**文件**: `packages/plugin/src/content-pack/ecc-hook-adapter.ts`

#### 当前问题

当前 hook 执行：

```ts
spawn("sh", ["-c", command], ...)
```

如果 content pack manifest 不可信，就等同于任意命令执行。

#### 修复方案

本项取决于项目对 content pack 的信任模型。建议采用“默认安全、兼容可开”的策略。

1. 新增配置开关：
   - 默认：禁用 shell 字符串 hook。
   - 允许旧行为的 env：`COVALO_ALLOW_UNSAFE_PLUGIN_HOOKS=1`。
2. 默认安全模式下，只允许以下形式：
   - command 指向 pluginRoot 内的可执行脚本。
   - 允许 `$CLAUDE_PLUGIN_ROOT/...` 或 `${CLAUDE_PLUGIN_ROOT}/...` 前缀。
   - 允许相对路径，但 resolve 后必须 containment 在 `pluginRoot` 内。
   - 禁止 `;`, `&&`, `||`, `|`, `<`, `>`, `` ` ``, `$(`, newline。
3. 不再用 `sh -c`：
   - 解析出 executable 与 args。
   - 使用 `spawn(executable, args, { shell: false, cwd: workspaceRoot, env })`。
4. 保留 timeout、stdout/stderr cap、process group kill。
5. diagnostics callback 记录：
   - hook 被拒绝的 pluginId、phase、reason。
   - hook 使用 unsafe override 的 warning。
6. 如果历史 ECC manifest 必须支持 shell 片段：
   - 只在 env override 下允许。
   - 文档标明这是 trusted local plugin 模式。

#### 验收标准

- `command: "echo hi; touch pwned"` 默认被拒。
- `$CLAUDE_PLUGIN_ROOT/scripts/hook.sh --flag` 可以执行，且 script 必须在 pluginRoot 内。
- `../outside.sh` 被拒。
- unsafe override 下旧命令可以跑，但 diagnostics 有 warning。
- lifecycle hook 失败仍不打断主流程。

---

### S5. 修复 WebFetch SSRF 防护

**文件**: `packages/tools/src/web-fetch.ts`

#### 当前问题

当前 `BLOCKED_NETS` 是字符串前缀，导致：

- `100.` 误拦截整个 100/8，而真实 CGNAT 仅 `100.64.0.0/10`。
- IPv4-mapped IPv6 如 `::ffff:127.0.0.1` 可能绕过。
- DNS resolve 与 fetch 之间有 TOCTOU，存在 DNS rebinding 风险。
- redirect 后目标未重新检查。

#### 修复方案

1. 实现 IP 解析与 CIDR 判断 helper，不要用字符串前缀：
   - IPv4: 转 uint32 后 CIDR 匹配。
   - IPv6: 使用 16-byte buffer 匹配。
   - 识别 IPv4-mapped IPv6，转回 IPv4 后检查。
2. block ranges 至少包括：
   - IPv4: `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, multicast/reserved。
   - IPv6: `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, IPv4-mapped private ranges。
3. 禁止 `fetch(..., redirect: "follow")`：
   - 改为 `redirect: "manual"`。
   - 每次 3xx 读取 `Location`，resolve 新 URL，重复完整校验。
   - 设置最大 redirect 次数，例如 5。
4. DNS:
   - 对 hostname 用 `dns.lookup(host, { all: true })`，同时获得 IPv4/IPv6。
   - 任一地址命中 blocked 即拒绝。
   - 若 Node fetch 无法绑定已解析 IP，至少在每次 redirect 前重复校验。
   - 更严格方案：使用自定义 dispatcher/agent 绑定 lookup 结果；如果项目暂不引入 undici agent，可记录 TODO。
5. 测试：
   - `http://127.0.0.1`、`http://[::1]`、`http://[::ffff:127.0.0.1]` 拒绝。
   - `100.63.0.1` 不因 `100.` 前缀误拦截；`100.64.0.1` 拒绝。
   - redirect 到 localhost 被拒。
   - hostname resolve 到 private IP 被拒。

---

## 3. Phase 2 详细修复规格

### C1. `submit()` 入口等待 context policy 加载

**文件**: `packages/core/src/engine.ts`

#### 修复方案

在 `submit()` generator 的最前面、任何读取 `this.contextPolicy` 之前添加：

```ts
await this.contextPolicyLoadPromise
```

如果 `submit()` 是 async generator，直接在函数体顶部 await。

同时建议：

- `contextPolicyLoadPromise` catch 中记录 warn，而不是完全静默。
- `getContextPolicy()` 保持同步，但文档注明可能返回默认值；内部路径使用 async 版本。

#### 验收标准

- 构造 engine 后立即调用 submit，使用已持久化 policy。
- load 失败时使用默认 policy，并有 warn 记录。

---

### C2. 修复 subagent 失败状态返回

**文件**: `packages/core/src/engine.ts`

#### 修复方案

当前 TUI worker event 能显示 failed，但返回对象固定：

```ts
status: "completed"
```

改为：

```ts
status: workerCancelled ? "cancelled" : workerFailed ? "failed" : "completed"
```

如果 `SubagentRunResult.status` 类型不支持 `cancelled`，先扩展类型；否则 cancelled 归为 failed，并在 warnings 中保留 `cancelled`。

`delegateTask()` 已根据 `result.status === "completed"` 分支，无需大改。

#### 验收标准

- child submit 连续 error 后，`spawnSubagent()` 返回 `failed`。
- interrupted child 返回 `cancelled` 或 `failed`，但不能是 `completed`。
- `delegateTask()` 对失败返回 `[error] Sub-agent task failed...`。

---

### C3. 支持 MCP JSON-RPC notification

**文件**: `packages/mcp/src/client.ts`

#### 修复方案

1. 扩展类型：

```ts
interface JsonRpcNotification {
  jsonrpc: "2.0"
  method: string
  params?: unknown
}
```

`JsonRpcResponse.id` 应允许 `undefined` 或拆分 response/notification 类型。

2. 在 `processLines()` 中：

```ts
if (resp.id === undefined && typeof resp.method === "string") {
  this.handleNotification(resp.method, resp.params)
  continue
}
```

3. 添加 notification handlers：
   - 最小实现：记录 debug/warn，不再静默丢弃。
   - 更完整：支持注册 handler：
     - `onNotification(method, handler)`
     - 内置处理 `notifications/resources/updated`
     - 内置处理 `notifications/tools/list_changed`
4. 如果当前上层没有动态刷新机制，先把 notification 暴露成 EventEmitter event。

#### 验收标准

- 服务端发送 `{"jsonrpc":"2.0","method":"notifications/tools/list_changed","params":{}}` 不会被当作 pending response。
- handler 被调用。
- 无 handler 时记录 debug，不抛错。

---

### C4. MCP 无尾换行 buffer flush

**文件**: `packages/mcp/src/client.ts`

#### 修复方案

1. 保持换行分帧作为主路径。
2. 在进程 `close`/`exit` 前调用 `flushBuffer()`：
   - 如果 `this.buffer.trim()` 非空，尝试 JSON.parse 一次。
   - 能 parse 就走同一 `handleMessage()`。
   - 不能 parse 则 debug log 后丢弃。
3. 把 `processLines()` 拆成：
   - `processLines()`
   - `processMessageLine(line: string)`
   - `flushBuffer()`

#### 验收标准

- 没有尾换行的最后一条 response 在进程退出前可被处理。
- 半截 JSON 不导致 crash。

---

### C5. 移除 eval runner 中的 `process.chdir`

**文件**: `packages/core/src/eval/runner.ts`

#### 当前问题

`process.chdir(workspaceDir)` 是进程全局状态，并行 eval 时会互相污染。

#### 修复方案

1. 不再修改全局 cwd。
2. 将 cwd 显式传给 worker executor：
   - 如果 `FixedEvalOptions.executeWorker` 当前只收 string，需要扩展为：
     ```ts
     executeWorker(prompt: string, context?: { cwd: string; caseId: string }): Promise<string>
     ```
   - 或新增 `withWorkspaceCwd` wrapper，只在单线程 CLI 兼容路径使用。
3. `_currentCaseWorkspace` 可以保留给工具查询，但不得依赖 process cwd。
4. 所有内部 `execSync` 已有 `{ cwd: workspaceDir }` 的保持不变。

#### 验收标准

- 并行跑两个 eval case 时，不会因 cwd 切换导致读错 workspace。
- 相关测试模拟两个 executeWorker 延迟交错，验证 `process.cwd()` 未变。

---

### C6. 保存并清理 BackgroundTask hard timeout timer

**文件**: `packages/tools/src/shell-dual-track/background-task-manager.ts`

#### 修复方案

1. 扩展 `BackgroundTask`：

```ts
hardTimer?: ReturnType<typeof setTimeout> | null
cleanupTimer?: ReturnType<typeof setTimeout> | null
```

或至少保存 hard timer。

2. `attachChildHandlers()` 中：

```ts
task.hardTimer = setTimeout(...)
```

3. 在 `close`、`error`、`kill`、`dispose` 中 clear：

```ts
if (task.hardTimer) clearTimeout(task.hardTimer)
task.hardTimer = null
```

4. `dispose()` 中也关闭 logStream：
   - 对所有 task 调用 `closeLogStream(task)`。
   - 清理 cleanupTimers。
   - 清理 hard timers。

#### 验收标准

- 启动一个 24h hard timeout 的后台任务，任务立刻结束后进程不会因 timer 保持存活。
- dispose 后没有活动 timer/log stream。

---

### C7. 修复 foreground graceful kill 强杀 timer 被清理

**文件**: `packages/tools/src/shell-dual-track/bash-dual-track.ts`

#### 当前问题

`killChild(true)` 设置 5s 后 SIGKILL，但随后 `finish()` 调 `cleanup()`，把 `sigtermTimer` 清掉，导致 stubborn child 可能残留。

#### 修复方案

1. 区分普通 cleanup 与保留强杀 timer 的 cleanup：
   - `cleanup({ keepKillTimer = false })`
2. hard timeout graceful path：
   - 先 SIGTERM。
   - 不立即 clear SIGKILL timer。
   - finish foreground result 可以返回，但 SIGKILL timer 应保留到触发或 close 后清理。
3. child close 时清理 SIGKILL timer。
4. abort path如果直接强杀，则不需要 grace timer。

#### 验收标准

- 模拟忽略 SIGTERM 的子进程，hard timeout 后最终收到 SIGKILL。
- 正常退出的子进程不会留下 timer。

---

### C8. 给 RuntimeLogger pendingOverflow 加边界

**文件**: `packages/core/src/runtime-logger.ts`

#### 修复方案

1. 引入 overflow 上限，例如：
   - `maxOverflowRecords = maxQueueSize`
   - 或 `maxOverflowBytes`
2. `flushDeferred()` 中追加 pendingOverflow 前先裁剪。
3. 统计 droppedCount。
4. 避免 `pendingOverflow.push(...this.queue)` 在极端大数组下栈/内存问题，可用循环或 concat 后 slice。

#### 验收标准

- 高频日志压测下 `pendingOverflow.length` 不超过上限。
- droppedCount 增加。
- flush 仍能写出最近日志。

---

### C9. MemoryService start 幂等化

**文件**: `packages/memory/src/memory-service.ts`

#### 修复方案

1. 添加字段：
   - `private startPromise?: Promise<void>`
   - `private started = false`
2. `start()`：
   - 如果 `started` 返回。
   - 如果 `startPromise` 存在，返回该 promise。
   - 初始化完成后 `started = true`。
   - 初始化失败时清空 `startPromise`，允许重试。
3. `stop()`：
   - 等待 startPromise settle。
   - 清 timers。
   - `started = false`。
4. interval catch 不要静默：
   - 增加连续失败计数。
   - 每 N 次 bootLog 或 logger warn。
   - 可选指数退避。

#### 验收标准

- 连续两次 `await service.start()` 只注册一组 timers。
- start 失败后可重试。
- stop 后可再次 start。

---

## 4. Phase 3 详细修复规格

### Q1. 跨平台计算 git diff 行数

**文件**: `packages/core/src/eval/runner.ts`

#### 修复方案

替换：

```ts
execSync("git diff 2>&1 | wc -l")
```

为：

```ts
const diff = execSync("git diff 2>&1", { cwd, encoding: "utf-8", stdio: "pipe" }).toString()
const diffSize = diff ? diff.split(/\r?\n/).filter(Boolean).length : 0
```

#### 验收标准

- Windows 环境不依赖 `wc`。
- diff 行数语义与原先接近。

---

### Q2. 区分 verifier skipped 与 failed

**文件**: `packages/core/src/eval/runner.ts`

#### 修复方案

`computeScore()` 中：

- `verifierResult === null` 表示未运行，不应等同失败。
- 可选策略：
  1. 如果 case 要求 verifier，则 null => score ineligible。
  2. 如果 case 明确允许 no verifier，则 verifier 权重重归一化。
  3. 简化实现：null => verifierScore 50，并在 score 中新增 `verifierSkipped: true`。

推荐更严格方案：

```ts
if (!verifierResult) {
  return scoreIneligible 或按 remaining weights normalize
}
```

不要让 skipped case 得到和 verifier fail 一样的语义。

#### 验收标准

- verifier skipped 的报告中明确显示 skipped/ineligible。
- verifier fail 仍 cap finalScore。
- 历史 snapshot 不 crash。

---

### Q3. 清理 AbortSignal 匿名 listener

**文件**: `packages/core/src/client.ts`

#### 修复方案

把匿名函数保存为命名函数：

```ts
const onAbortReject = () => reject(...)
opts.signal.addEventListener("abort", onAbortReject, { once: true })
```

在 finally 中：

```ts
opts.signal?.removeEventListener("abort", onAbort)
opts.signal?.removeEventListener("abort", onAbortReject)
```

需要注意 `onAbortReject` 定义作用域。可用 let：

```ts
let onAbortReject: (() => void) | undefined
```

#### 验收标准

- 正常 stream 完成后 abort listener 全部移除。
- abort 时仍能 reject race 并 cancel reader。

---

### Q4. loop 工具异常至少记录

**文件**: `packages/core/src/loop.ts`

#### 修复方案

两处 `catch {}` 改为：

```ts
} catch (err) {
  logger?.warn("loop.tool_execution_error", { error: ..., turnCount, ... })
  yield { role: "error", content: "...", severity: "error", metadata: { error: true } }
}
```

注意：如果 catch 处于不能 yield 的普通 callback，就至少 logger warn。

#### 验收标准

- 工具执行器抛异常时，用户/日志可见错误。
- 不重复补写已完成 tool result。

---

### Q5. streaming executor catch 保留原异常

**文件**: `packages/core/src/streaming-executor.ts`

#### 修复方案

把：

```ts
} catch {
```

改成：

```ts
} catch (err) {
  logger.warn("tool.batch.interrupted_or_failed", { error: ... })
```

保留 settle remaining tools 行为。

#### 验收标准

- generator abort/throw 时日志能看到原始异常。
- 剩余 tool calls 仍被 settle。

---

### Q6. API key 保存 tmp 文件唯一化

**文件**: `packages/core/src/config.ts`

#### 修复方案

把：

```ts
const tmpFile = join(tmpDir, `.api-key.tmp.${process.pid}`)
```

改为：

```ts
const tmpFile = join(tmpDir, `.api-key.tmp.${process.pid}.${randomUUID()}`)
```

需要 import `randomUUID`。

同时 `saveProjectApiKey` 和 `deleteProjectApiKey` 都改。

可选：同文件读改写也可能丢更新，若要更稳，应引入项目级 lock。

#### 验收标准

- 同进程并发保存不同 provider key 不会因 tmp 文件冲突抛错。
- 文件权限仍为 0600。

---

### Q7. Supervisor stream 分离 reasoning 与 text

**文件**: `packages/core/src/supervisor/guided-loop.ts`

#### 修复方案

当前：

```ts
if text_delta output += delta
else if reasoning_delta output += delta
```

改为：

```ts
let text = ""
let reasoning = ""

if (event.type === "text_delta") text += event.delta
if (event.type === "reasoning_delta") reasoning += event.delta
```

返回：

```ts
return { text, reasoning }
```

如果现有类型不想扩展，至少不要把 reasoning 放入 `text`。

#### 验收标准

- Supervisor JSON 只从 text_delta 解析。
- reasoning 内容不会污染 JSON parser。
- 如果 provider 只返回 reasoning，无 text，应给出 parse error 而不是解析混合文本。

---

### Q8. LLM JSON parser 更稳健

**文件**: `packages/core/src/scoring/eval-runner.ts`

#### 修复方案

1. `tryParseJson(text)` 改为多候选：
   - 所有 ```json fenced block。
   - 所有 balanced JSON object。
   - 整体 trim。
2. 对每个候选尝试 parse，返回第一个 object。
3. boolean coercion：
   - 接受 `true`, `"true"`, `"yes"`, `"pass"`。
   - 接受 `false`, `"false"`, `"no"`, `"fail"`。
   - 未识别保持 false 或 undefined，需显式。
4. `completed: undefined` 与 `completed: false` 不应完全等价：
   - 可在 assessment 中保留 `completedKnown` 或 `rawCompleted`。
   - 如果不改类型，至少在 summary/debug 中记录字段缺失。

#### 验收标准

- prose + fenced JSON 可解析。
- 第一个 fenced block 非 JSON、第二个 JSON 时能解析第二个。
- `"true"` 能识别为 true。

---

### Q9. 修复 rubric 缺失维度归一化

**文件**: `packages/core/src/scoring/rubric.ts`

#### 当前问题

`total` 只统计输入 rubric 已有维度权重，但缺失维度会回填默认权重，然后用原 total 归一化，导致总权重大于 1。

#### 修复方案

1. 先构建完整 dimensions：
   - 对每个默认维度，使用 custom override 或 default。
2. 再基于完整 dimensions 计算 total。
3. 再归一化。

伪码：

```ts
const dimensions = {} as ...
for (const dim of AGENT_SCORING_DIMENSIONS) {
  dimensions[dim] = {
    ...DEFAULT_AGENT_SCORE_RUBRIC.dimensions[dim],
    ...rubric.dimensions[dim],
  }
}
const total = AGENT_SCORING_DIMENSIONS.reduce((s, d) => s + dimensions[d].weight, 0)
...
```

#### 验收标准

- 输入只覆盖 1 个维度时，输出所有维度权重总和为 1。
- 默认 rubric 归一化后仍为原值。

---

### Q10. 优化 text parser O(n²) 热点

**文件**: `packages/core/src/tool-calls/text-parsers.ts`

#### 修复方案

1. `parseJsonToolObjects()`：
   - 不要对每个 `{` 做 `text.slice(i)`。
   - 先用正则找候选 key 位置，再向前找最近 `{`，或直接扫描 `{` 后只检查固定长度窗口。
2. `stripLikelyToolJsonObjects()`：
   - 不在循环里重建 result。
   - 收集 spans，最后一次性拼接。
3. 复用 `mergeSpans()`。

#### 验收标准

- 大文本 100k 字符含多个 JSON 片段时耗时线性增长。
- 原有 salvage/strip 行为不回退。

---

### Q11. Perfetto event buffer 改为环形或低成本驱逐

**文件**: `packages/core/src/perfetto-tracing.ts`

#### 修复方案

短期：

- 把 `splice(0, MAX_EVENTS / 2)` 改为环形缓冲，或维护 `droppedCount` 与 `startIndex`。
- 写 trace 时按顺序导出有效 events。

低成本折中：

- 用 `events = events.slice(-KEEP_EVENTS)` 仍是 O(n)，但频率低；不如环形彻底。

#### 验收标准

- 高频 trace 不出现周期性大 pause。
- trace_truncated 元事件仍保留 dropped 数量。

---

### Q12. Hook error context 与 first-match-wins 策略

**文件**: `packages/security/src/hooks.ts`

#### 修复方案

1. 不破坏现有 API 的最小修复：
   - hook 抛错时 observer 记录 error。
   - 返回 `"deny"` 的同时，在调用链 metadata 中带 reason：`Hook beforeToolCall failed: ...`。
2. 如果 `PermissionDecision` 不能携带 reason，则扩展返回类型为 `PermissionCheck` 或新增 `lastHookError`。
3. first-match-wins：
   - 若保持现状，文档写明 hook 顺序是策略的一部分。
   - 更安全方案：执行所有 hooks，`deny` 优先于 `allow`。
   - 推荐安全方案，但可能有兼容影响；可先加 feature flag。

#### 验收标准

- hook 抛错时调用方能看到拒绝原因。
- 多 hook 场景有测试覆盖 deny 优先或顺序优先。

---

### Q13. Permission 默认 allow 策略显式化

**文件**: `packages/security/src/permission.ts`

#### 修复方案

当前：

```ts
if (tier === "exec") ask
else allow
```

建议：

1. 引入默认策略配置：
   - `defaultDecisionByTier`
   - 默认保持兼容：read/edit/write allow，exec ask。
2. 对未知 tier：
   - 不应默认 allow。
   - 建议 ask 或 deny。
3. 新工具注册时如果 approval/tier 缺失，默认 ask。

#### 验收标准

- 未知 tier 工具不会静默 allow。
- 现有 read 工具行为不变。
- exec 工具仍 ask。

---

### Q14. shell state notify 使用 listener 快照

**文件**: `packages/shell/src/state.ts`

#### 修复方案

```ts
for (const cb of [...this.listeners]) {
  ...
}
```

#### 验收标准

- listener 在 notify 中添加/删除 listener 不影响当前轮迭代。

---

### Q15. 长会话集合边界化

**文件**:

- `packages/core/src/dual-session/session.ts`
- `packages/core/src/task-ledger.ts`

#### 修复方案

1. `executedToolCallIds`：
   - 使用 bounded LRU set。
   - 上限例如 5000。
2. `commandsRun`：
   - 保留最近 N 条，例如 200。
   - snapshot 中只输出最近 N 条。
3. `changedFiles/blockers` 也可加合理上限，但不要影响语义。

#### 验收标准

- 长会话 1 万次工具调用内存不线性无限增长。
- 最近记录仍可用于去重和诊断。

---

## 5. 明确剔除/不按报告处理的误判

以下项不要作为独立任务执行。

### R1. `background-task-manager adopt()` 并发上限“可突破”

**结论**: 不按报告处理。  
**原因**: `adopt()` 从 runningCount 检查到 `tasks.set()` 中间没有 `await`，在单 JS 事件循环内不会被另一个 adopt 调用交错插入。除非引入 worker_threads 或多进程共享内存，否则不是实际竞态。

### R2. `bash-dual-track adopt()` soft timer 与 close 双重管理竞态

**结论**: 不按报告处理。  
**原因**: 当前 adopt 是同步函数，`adoptResult` 返回后才设置 `escalated = true`。close 事件不会在同步调用中间插入。代码已有 `if (escalated || done) return` 防线。真正需要修的是 C7 的 graceful kill 强杀 timer。

### R3. `governance/mode-decision.ts` L0 forced 无法退出

**结论**: 不按报告处理。  
**原因**: `skipStateDerivedEnter` 只在 `ctx.executionMode !== "forced"` 分支内影响进入 forced 的判断。已经处于 forced 时，代码仍执行 `shouldExitForcedMode()`。

### R4. `session.drain()` “返回后仍有数据未写入”

**结论**: 不作为 P1 独立修复。  
**原因**: `drain()` 已等待 `flushing` 和 `queue.length` 清空。`flushSoon()` finally 中 fire-and-forget 风格不优雅，但报告说法过重。可在后续质量清理中改成更清晰的 flush loop，但不是高优先级 bug。

### R5. checkpoint `peekA` 和 `peekB` “无 await”

**结论**: 报告表述错误。  
**原因**: 实际代码两个读取都有 `await`。  
**保留问题**: checkpoint 多次读取 + 无文件锁仍可能 TOCTOU，但应作为“文件锁/单次合并”改进，不按“无 await”修。

### R6. Windows `wc -l` 是 P0

**结论**: 降级为 P2。  
**原因**: 确实跨平台不兼容，但不会造成命令注入或数据损坏。它影响评估准确性，应修，但不属于致命安全问题。

---

## 6. 推荐执行顺序

### PR 1: Eval verifier 安全

包含：S1、S2、Q1、Q2  
测试：`bun test packages/core/src/eval` 或新增 verifier-specific tests。  
验收重点：无 sandbox 时不执行 manifest command；scriptPath 注入被拒。

### PR 2: Memory 与 config 原子写

包含：S3、Q6、Q15 部分  
测试：memory 并发写、api-key 并发写。  
验收重点：不产生 tmp 冲突和 JSON 损坏。

### PR 3: Plugin hook 与 WebFetch 安全

包含：S4、S5  
测试：hook command 拒绝/允许矩阵、SSRF IP/CIDR/redirect。  
验收重点：默认安全，兼容必须显式 env override。

### PR 4: Engine/MCP 正确性

包含：C1、C2、C3、C4、C5  
测试：engine submit policy race、subagent failed status、MCP notification/no-newline、parallel eval cwd。  
验收重点：状态语义正确，MCP notification 不丢。

### PR 5: Shell runtime 与 logger 资源治理

包含：C6、C7、C8、C9、Q3、Q4、Q5  
测试：hard timeout cleanup、SIGTERM ignored child、logger stress、AbortSignal listener cleanup。  
验收重点：进程可退出，无隐藏异常。

### PR 6: 解析/评分/性能清理

包含：Q7、Q8、Q9、Q10、Q11、Q12、Q13、Q14  
测试：JSON parser 多候选、rubric 权重、tool parser 大文本、hook policy。  
验收重点：不破坏现有功能，性能和可解释性提升。

---

## 7. 通用测试命令

执行 agent 在每个 PR 至少运行：

```bash
bun test packages/core packages/tools packages/security
bun run typecheck
```

如果改动 memory：

```bash
cd packages/memory && bun run test
```

如果改动 eval：

```bash
bun test packages/core/src/eval/assets packages/core/src/eval/materialize packages/core/src/eval/__tests__
```

如果改动 package build 相关：

```bash
bun run build
node ./dist/index.js --help
```

---

## 8. 最终验收清单

### 安全

- [ ] manifest command 默认不会在宿主机 shell 直接执行。
- [ ] scriptPath 无法通过 shell metachar 注入。
- [ ] plugin hook 默认不使用 `sh -c` 执行任意字符串。
- [ ] WebFetch 正确拒绝 private/reserved IP、IPv4-mapped IPv6、redirect 到内网。

### 数据一致性

- [ ] MemoryStore 同 key 并发 set/update 不损坏文件、不丢更新。
- [ ] API key 文件写入 tmp 文件唯一化。
- [ ] checkpoint 本轮如要处理，应有文件锁或明确后续 TODO。

### 状态正确性

- [ ] `submit()` 使用已加载 context policy。
- [ ] subagent failed/cancelled 不返回 completed。
- [ ] MCP notification 不丢弃。
- [ ] eval worker 不再改全局 cwd。

### 资源治理

- [ ] background hard timeout timer 结束后清理。
- [ ] graceful kill 最终会 SIGKILL stubborn child。
- [ ] AbortSignal listener 正常清理。
- [ ] runtime logger overflow 有边界。
- [ ] MemoryService start 幂等。

### 解析与评分

- [ ] Supervisor JSON 不被 reasoning 污染。
- [ ] scoring JSON parser 能处理多个 fenced block 和 prose mixed JSON。
- [ ] rubric 权重总和恒为 1。
- [ ] verifier skipped 与 failed 在 score/report 中语义区分。

---

## 9. Agent 执行提示词建议

将下面内容作为 coding agent 的任务说明：

```text
你正在修复 bzcsk2/covalo 的已核实审计问题。不要照原审计报告全量修复；只按 covalo_verified_fix_spec_20260702.md 执行。

执行顺序：
1. 先实现 Phase 1 的 S1-S5。
2. 每完成一个 ID，补最小单元测试或集成测试。
3. 跑相关测试和 typecheck。
4. 不要重构无关代码。
5. 遇到兼容性冲突时，优先 fail-closed，并提供显式 env override。
6. 保留现有公共 API，除非 spec 明确要求扩展类型。
7. 每个提交说明必须写清楚：修复了哪个 ID、根因、测试结果。

重点：
- verifier command/scriptPath 必须防止宿主机命令注入。
- MemoryStore 必须修复同 key 并发写。
- MCP notification 必须被分发或至少可观察。
- subagent failed 不得再返回 completed。
- 原报告中被 spec 标记为 R1-R6 的误判不要修。
```
