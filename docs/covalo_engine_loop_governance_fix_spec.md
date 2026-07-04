# Covalo Engine / Loop / Governance / Session 修复实施规格书

> 适用仓库：`bzcsk2/covalo`  
> 适用版本基线：PR #37 合并后的 `main`  
> 文档目的：把原“深度审计报告”整理为可直接交给 coding agent 执行的修复 spec。  
> 重要原则：只修复已确认问题；对证据不足或严重性被夸大的条目先补测试或降级处理，不把架构建议误当作阻塞缺陷。

---

## 0. 总体结论

当前 Engine / Loop / Governance / Session 架构已经具备较完整的安全、恢复、上下文压缩和持久化机制。原审计报告有价值，但优先级分级偏激进。尤其是：

- `loadSession` 不清 prefix 被定为 P0：不成立或证据不足。
- `approvalPolicy: "never"` 被定为 P0：事实基础存在，但严重性偏高，因为 write/edit 工具本身已有 `isWriteProtected()` 兜底。
- `submit` 入口 compact 与 loop 内二次 compact：当前代码证据不足，必须先写复现测试。
- `TOOL_SIDE_EFFECTS` 映射问题：原报告引用的文件路径在当前 `main` 上无法直接定位，应先搜索当前实现后再处理。

因此本 spec 将问题分为三类：

1. **Phase 1：确认问题，直接修复。**
2. **Phase 2：安全加固与可观测性改进，低风险实现。**
3. **Phase 3：需验证项，先补测试，不允许凭假设直接改架构。**

---

## 1. 执行约束

### 1.1 coding agent 必须遵守

- 不要一次性大改 Engine / Loop 主路径。
- 每个修复项都必须配套测试。
- 修改前先读对应源码和现有测试，不要只按本 spec 猜代码。
- 不要删除现有安全保护。
- 不要为了让测试通过而降低断言强度。
- 不要改变用户可见行为，除非本 spec 明确要求。
- 优先做小 patch，每个 patch 只覆盖一个问题域。

### 1.2 推荐 PR 拆分

建议拆成 3 个 PR：

- **PR-A：Session / Checkpoint 稳定性**
  - `AsyncSessionWriter.drain()` 超时
  - `SessionLoader.cleanup()` 清理孤儿 checkpoint
  - `CheckpointEngine` 写入阶段重试

- **PR-B：权限与安全可观测性**
  - hook 异常 deny reason
  - 敏感路径模式补充
  - `approvalPolicy: "never"` 的中央敏感写 deny 加固，若测试确认不会破坏现有行为

- **PR-C：上下文压缩 / prefix / salvage 需验证项**
  - 只补测试或 diagnostic
  - 不在没有复现的情况下重构主循环

---

## 2. Phase 1：确认问题，直接修复

---

### FIX-01：`AsyncSessionWriter.drain()` 增加超时，避免 shutdown 无限等待

**优先级**：P1  
**类型**：稳定性 / 生命周期  
**文件**：`packages/core/src/session.ts`

#### 背景

当前 `AsyncSessionWriter.drain()` 通过两个 `while` 循环等待：

```ts
while (this.flushing) {
  await new Promise(r => setTimeout(r, 5))
}

if (this.queue.length > 0) {
  await this.flushSoon()
}

while (this.flushing || this.queue.length > 0) {
  await new Promise(r => setTimeout(r, 5))
}
```

如果底层 `appendFile()` 持续失败，例如磁盘满、权限异常、路径异常，`flushSoon()` 会失败后在 `finally` 中因为 `queue.length > 0` 再次触发 flush。`drain()` 可能无限等待，导致 `engine.shutdown()` 卡住。

#### 目标行为

`drain()` 必须是 best-effort：

- 尽力 flush 队列。
- 默认最多等待 10 秒。
- 超时后不抛异常。
- 记录 warning 日志。
- 保留 `lastError`、`queueSize`、`queueBytes`，便于诊断。
- `shutdown()` 不应永久阻塞。

#### 实施方案

将方法签名改为：

```ts
async drain(timeoutMs = 10_000): Promise<void>
```

添加内部 deadline：

```ts
const deadline = Date.now() + timeoutMs
const sleep = () => new Promise(r => setTimeout(r, 5))
const timedOut = () => Date.now() >= deadline
```

等待循环都必须检查 deadline：

```ts
while (this.flushing && !timedOut()) {
  await sleep()
}
```

触发一次 `flushSoon()` 后继续等待，但不能超过 deadline。

超时后记录：

```ts
this.logger.warn("session.writer.drain_timeout", {
  queueSize: this.queue.length,
  queueBytes: this.queueBytes,
  flushing: this.flushing,
  lastError: this.lastError,
  timeoutMs,
})
```

#### 测试要求

新增或修改 `packages/core/__tests__/session.test.ts`。

至少覆盖：

1. **正常 drain**
   - enqueue 若干记录。
   - `await writer.drain()`
   - 断言 queue 清空。

2. **flush 持续失败时 drain 超时返回**
   - 使用不可写路径或 mock `appendFile` 抛错。
   - `await writer.drain(50)`
   - 断言不会无限挂起。
   - 断言 `getStatus().queueSize > 0` 或 `lastError` 存在。
   - 断言耗时小于合理上限，例如 500ms。

3. **重复调用 drain 幂等**
   - 连续调用两次不抛错。

#### 验收标准

- `bun run typecheck` 通过。
- session 相关测试通过。
- `engine.shutdown()` 即使 session writer 异常也能返回。
- 不改变 `enqueue()` 的既有语义。

---

### FIX-02：hook 异常时设置用户可见 deny reason

**优先级**：P2  
**类型**：权限系统 / 可观测性  
**文件**：`packages/core/src/executor-helpers.ts`，必要时涉及 `packages/security/src/hooks.ts`

#### 背景

当前 `evaluatePermission()` 中：

```ts
try {
  hookDecision = await hookManager?.runBeforeToolCall(...)
} catch {
  hookDecision = "deny"
}
```

异常被 fail-closed 为 deny，这是正确的。但 catch 没有保存异常原因。后续 `resolveDenyMessage()` 依赖 `hookManager.lastHookDenyReason` 生成用户可见错误；hook 抛错时这个字段为空，用户只能看到泛化的 “Tool call denied”。

#### 目标行为

- hook 抛错仍然 deny。
- deny message 应说明是 hook 执行异常。
- 不泄露敏感数据；只使用 `Error.message`。
- reason 被消费后应清空，避免污染下一次权限判断。

#### 实施方案

修改 catch：

```ts
} catch (e) {
  hookDecision = "deny"
  if (hookManager) {
    hookManager.lastHookDenyReason =
      `Hook execution failed: ${e instanceof Error ? e.message : String(e)}`
  }
}
```

如果 `lastHookDenyReason` 不是公开可写字段，则在 `HookManager` 增加方法：

```ts
setLastHookDenyReason(reason: string): void
```

然后在 `evaluatePermission()` 调用该方法。

#### 测试要求

新增或修改 `executor-helpers` 相关测试。

覆盖：

1. hook 抛错时 `evaluatePermission()` 返回 `"deny"`。
2. 随后调用 `resolveDenyMessage()` 返回包含 `"Hook execution failed"` 的信息。
3. `resolveDenyMessage()` 消费一次后再次调用不再返回旧 reason。
4. hook 正常 deny 的现有行为不变。

#### 验收标准

- 权限系统 fail-closed 行为不变。
- 错误信息可见。
- 不破坏现有 hook deny reason 流程。

---

### FIX-03：`SessionLoader.cleanup()` 同时清理孤儿 checkpoint 文件

**优先级**：P2  
**类型**：持久化维护 / 磁盘清理  
**文件**：`packages/core/src/session.ts`

#### 背景

当前 `cleanup(maxSessions = 50)` 只清理 `.jsonl` 文件。`CheckpointEngine` 会为 session 生成 `${sessionId}.checkpoint.json`。当老 session 的 `.jsonl` 被清理后，对应 checkpoint 可能长期遗留。

#### 目标行为

- cleanup 删除超出保留数量的 `.jsonl`。
- 同时删除这些 session 对应的 `.checkpoint.json`。
- 额外清理没有对应 `.jsonl` 的孤儿 `.checkpoint.json`。
- 不删除不符合 sessionId 校验的异常文件。
- 删除失败时 best-effort，debug 日志记录，不中断 cleanup。

#### 实施方案

在 `cleanup()` 中：

1. 读取 sessionDir 下所有文件。
2. 识别合法 `.jsonl`：
   - `id = filename.slice(0, -6)`
   - `validateSessionId(id)`
3. 按 mtime 排序，确定保留集合 `keptIds` 和删除集合 `deletedIds`。
4. 删除 `deletedIds` 的 `.jsonl`。
5. 删除 `deletedIds` 对应的 `${id}.checkpoint.json`。
6. 遍历所有 `.checkpoint.json`：
   - 提取 id。
   - 如果 id 不在合法 jsonl id 集合中，则删除。

注意：如果某个 checkpoint 对应的 jsonl 仍存在但被保留，不应删除。

#### 建议代码结构

```ts
const checkpointName = `${id}.checkpoint.json`
const checkpointPath = resolve(this.sessionDir, checkpointName)
await unlink(checkpointPath).catch(...)
```

返回值可以维持“删除的 `.jsonl` 数量”，避免破坏 API；也可以更新为总删除数，但如果测试依赖旧语义，应保留旧语义，并用日志记录 checkpoint 删除数量。

#### 测试要求

新增或修改 `SessionLoader.cleanup` 测试。

覆盖：

1. 超出 maxSessions 时，老 `.jsonl` 被删除。
2. 被删除 `.jsonl` 对应 `.checkpoint.json` 也被删除。
3. 没有对应 `.jsonl` 的孤儿 `.checkpoint.json` 被删除。
4. 被保留 session 的 checkpoint 不被删除。
5. 非法文件名不被删除或不会导致异常。

#### 验收标准

- 不改变 `SessionLoader.list()` 语义。
- cleanup 可重复执行。
- 删除失败不影响其他文件清理。

---

### FIX-04：补充敏感路径模式

**优先级**：P2  
**类型**：安全覆盖面  
**文件**：`packages/tools/src/sensitive.ts`

#### 背景

当前敏感读取模式覆盖了 `.env`、`.ssh/`、私钥、`.npmrc`、AWS credentials、Docker config、`.openai/`、`.anthropic/` 等。但仍缺少常见高风险凭据或状态文件：

- `.kube/`
- `.terraform/`
- `*.tfstate`
- `*.tfstate.backup`
- `.gpg`
- `.asc`
- `kubeconfig`
- Google Cloud ADC 路径，如 `.config/gcloud/`

原审计报告中关于 Docker 的表述不完全准确：当前代码已经覆盖 `.dockercfg` 和 `.docker/config.json`，无需重复添加。

#### 目标行为

`isSensitive()` 和 `isWriteProtected()` 对以下路径返回 true：

- `/home/user/.kube/config`
- `.kube/config`
- `.terraform/terraform.tfstate`
- `terraform.tfstate`
- `prod.tfstate`
- `prod.tfstate.backup`
- `secret.gpg`
- `private.asc`
- `.config/gcloud/application_default_credentials.json`
- `.config/gcloud/credentials.db`
- `kubeconfig`

#### 实施方案

在 `SENSITIVE_READ_PATTERNS` 增加：

```ts
/(^|\/|\\)\.kube(\/|\\)/,
/(^|\/|\\)kubeconfig$/,
/(^|\/|\\)\.terraform(\/|\\)/,
/(^|\/|\\)[^.\/\\][^\/\\]*\.tfstate$/,
/(^|\/|\\)[^.\/\\][^\/\\]*\.tfstate\.backup$/,
/(^|\/|\\)[^.\/\\][^\/\\]*\.gpg$/,
/(^|\/|\\)[^.\/\\][^\/\\]*\.asc$/,
/(^|\/|\\)\.config(\/|\\)gcloud(\/|\\)/,
```

注意现有模式风格使用 `/(^|\/|\\).../`，保持一致。

#### 测试要求

新增或修改 sensitive 相关测试。

覆盖：

1. 新增路径均命中 `isSensitive()`。
2. 新增路径均命中 `isWriteProtected()`，因为 write patterns 展开了 read patterns。
3. 普通 `.ts`、`.md`、`package.json` 不误判。
4. Windows 路径分隔符也命中，例如 `C:\Users\x\.kube\config`。

#### 验收标准

- 不删除任何现有敏感模式。
- 不扩大到过度误伤普通源码文件。
- 三平台测试一致。

---

### FIX-05：`CheckpointEngine.saveUnlocked()` 写入阶段增加重试与 tmp 清理

**优先级**：P2  
**类型**：持久化可靠性  
**文件**：`packages/core/src/checkpoint/checkpoint-engine.ts`

#### 背景

当前读取 checkpoint 时已有一定重试，但写入阶段：

```ts
await fs.writeFile(tmpPath, JSON.stringify(merged, null, 2), "utf-8")
await fs.rename(tmpPath, this.checkpointPath)
```

没有重试。Windows 或杀毒软件、同步盘、短暂文件锁可能导致 `rename` 失败。失败后 tmp 文件也可能遗留。

#### 目标行为

- 写入 tmp + rename 仍保持原子写入模型。
- write/rename 失败时短暂重试，例如 3 次。
- 每次失败间隔递增，例如 20ms、40ms、80ms。
- 最终失败时尝试删除 tmp。
- 不吞掉最终错误，保留 `save()` 现有错误传播语义。

#### 实施方案

新增内部 helper：

```ts
private async writeAtomicWithRetry(
  tmpPath: string,
  finalPath: string,
  content: string,
  attempts = 3,
): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.writeFile(tmpPath, content, "utf-8")
      await fs.rename(tmpPath, finalPath)
      return
    } catch (e) {
      lastError = e
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      if (i < attempts - 1) {
        await new Promise(r => setTimeout(r, 20 * 2 ** i))
      }
    }
  }
  throw lastError
}
```

然后替换原写入逻辑。

注意：如果 `writeFile` 成功但 `rename` 失败，下一次循环需要重新写 tmp，不能假设 tmp 仍存在。

#### 测试要求

新增或修改 checkpoint 测试。

覆盖：

1. 正常 save 仍生成 checkpoint。
2. mock `rename` 第一次失败、第二次成功，最终 save 成功。
3. mock `rename` 持续失败，save 抛错，tmp 文件被清理。
4. 并发 save 仍串行，最终文件是合法 JSON。

#### 验收标准

- 不破坏 promise chain 串行化。
- checkpoint 文件始终是合法 JSON。
- 失败时不留下大量 tmp 文件。

---

## 3. Phase 2：安全加固与可观测性改进

---

### HARDEN-01：`approvalPolicy: "never"` 下增加中央敏感写 deny 兜底

**优先级**：P2 / P1-security-hardening  
**类型**：安全加固  
**文件**：`packages/core/src/engine.ts`，可能涉及 `packages/tools/src/sensitive.ts` 或新增共享安全模块

#### 背景

`approvalPolicy: "never"` 的语义是无审批执行，当前会将 write/edit/exec 默认设为 allow。这是设计行为，不是 bug。写工具内部已经有 `isWriteProtected()` 兜底，所以不能说“所有写工具无安全网”。

但是，中央权限层缺少统一 deny rule，导致：

- 安全语义分散在各工具内部。
- 新增写工具时可能忘记调用 `isWriteProtected()`。
- `apply_patch` 等工具如果未统一接入敏感路径保护，会存在覆盖缺口。

#### 目标行为

即使 `approvalPolicy === "never"`：

- 对明确敏感路径的写入仍应被 deny。
- 不影响普通 workspace 文件写入。
- 不改变 read 工具默认 allow。
- 不改变 strictMode 语义。
- 不破坏无头 CI 自动修复场景。

#### 实施方案选项

##### 方案 A：在 PermissionEngine 添加 args-based deny rule

如果 `PermissionEngine.addDenyRule()` 已支持 args 深度匹配但不支持 predicate，则需要扩展能力，风险较大，不建议第一选择。

##### 方案 B：在 executor permission 前添加统一敏感写检查

在权限评估入口或 tool execution 前，对 write/edit/apply_patch/NotebookEdit 做路径提取：

- 复用 `extractToolTargetPath()`。
- 对 `apply_patch` 需要判断 patch 触及文件。
- 命中 `isWriteProtected()` 时直接 deny，并返回明确 reason。

这比在 `configurePermissionDefaults()` 里塞 RegExp deny rule 更可控。

##### 方案 C：仅补充缺失工具内部保护

检查所有写工具：

- `write_file`
- `edit`
- `NotebookEdit`
- `apply_patch`
- 任何 shell patch/edit wrapper

确保每个工具内部都调用敏感路径保护。若全部已覆盖，则中央 deny 可暂缓。

#### 建议

先执行 **方案 C**：

1. 列出所有 `approval: "write"` 和 `approval: "edit"` 工具。
2. 检查每个工具是否调用 `isWriteProtected()` 或等价逻辑。
3. 对缺失工具补保护。
4. 再考虑是否做方案 B 的中央兜底。

#### 测试要求

1. `approvalPolicy: "never"` 时，普通文件写入允许。
2. `approvalPolicy: "never"` 时，`.env`、`.ssh/id_rsa`、`.kube/config` 写入拒绝。
3. `approvalPolicy: "on-request"` 既有 ask 行为不变。
4. 新增写工具必须有敏感路径测试。

#### 验收标准

- 不把 `approvalPolicy: "never"` 改成 ask。
- 只阻断敏感路径。
- 自动化场景仍可正常修改普通源码。

---

### HARDEN-02：补充 shell deny pattern，但不要过度阻断合法命令

**优先级**：P2  
**类型**：shell 安全  
**文件**：先搜索实际 shell security 实现文件；不要按原报告路径盲改

#### 背景

原报告指出 POSIX deny patterns 未覆盖：

- `find / -delete`
- `find ... -exec rm ...`

这类模式确实危险，但需要先定位当前 shell security 实现，因为报告中的 `shell-security.ts` 路径在当前 `main` 上未直接核实。

#### 执行步骤

1. 搜索：
   - `POSIX_DENY_PATTERNS`
   - `ShellSecurity`
   - `dangerous command`
   - `rm -rf`
   - `createBashTool`
   - `dualTrack`
2. 找到实际 shell 安全检查位置。
3. 判断当前是否已有：
   - `rm -rf /`
   - `sudo rm`
   - `chmod -R`
   - `curl | sh`
   - PowerShell destructive patterns
4. 在合适位置补充 find 删除模式。

#### 建议 deny regex

```ts
/\bfind\b[^;\n]*\s-delete\b/,
/\bfind\b[^;\n]*\s-exec\s+rm\b/,
```

#### 测试要求

1. `find . -name "*.tmp" -delete` 在普通 workspace 下是否应该允许？  
   - 这是一个产品决策。若 deny 太严格，会误伤常见清理命令。
2. 至少阻断：
   - `find / -delete`
   - `find / -exec rm -rf {} \;`
   - `find ~ -name "*" -exec rm {} \;`
3. 允许安全查询：
   - `find . -name "*.ts" -print`
   - `find src -type f`

#### 推荐策略

不要直接全局 deny 所有 `find ... -delete`。更合理：

- `find / ... -delete` deny
- `find ~ ... -delete` deny
- `find $HOME ... -delete` deny
- `find . ... -delete` 可根据 shell policy 决定 ask 或 allow

如果当前 shell security 没有路径上下文能力，先实现保守 deny，并在 release note 说明。

---

## 4. Phase 3：需验证项，先补测试，不直接重构

---

### VERIFY-01：`loadSession` 是否真的存在 prefix / toolSpecs 残留

**原报告分级**：P0  
**本 spec 判断**：证据不足，疑似误判  
**允许操作**：先补测试，不直接修主逻辑

#### 当前判断

`loadSession()` 确实不清 prefix，但当前 `ImmutablePrefix.messages` 只暴露 system message；toolSpecs 不进入消息列表。`submit()` 每次根据当前 agent/role/mode 组合 system prompt，并用 `lastSystemPromptKey` 判断是否重建 prefix。

报告声称“不同 session 使用不同 agent profile，旧 toolSpecs 残留导致工具列表不正确”，需要测试证明。

#### 必须先写的测试

创建测试模拟：

1. 同一 engine 实例。
2. session A 使用 agent profile A。
3. session A submit 一次。
4. `loadSession(sessionB)`。
5. session B 使用 agent profile B。
6. 两个 profile 的 systemPrompt 相同，但 toolNames 不同。
7. 断言：
   - LLM request 的 `tools` 参数是否正确使用 B 的工具集合。
   - `ctx.buildMessages()` 中是否出现旧 agent 的系统提示或技能内容。
   - prefix cacheKey 是否导致错误复用。

#### 判断标准

- 如果工具集合来自 loop 的 `toolSpecs` 参数，而不是 prefix cache，则报告原问题不成立。
- 如果确实复现旧 toolSpecs 被传给模型，则再修。

#### 可能修复

如果测试证明存在问题，再考虑：

```ts
this.lastSystemPromptKey = ""
this.ctx.prefix.build("")
```

但不要在没有复现的情况下做这个改动，因为清 prefix 可能引入 system prompt 空窗或多余 rebuild。

---

### VERIFY-02：submit 入口 compact 与 loop 内 contextPolicy 是否会双重压缩

**原报告分级**：P1  
**本 spec 判断**：证据不足  
**允许操作**：补测试 / 增加 diagnostic，不直接改压缩策略

#### 当前判断

`submit()` 入口确实会在 budget 超阈值时执行 `compactToTarget()` 或 `reduceToTarget()`。但当前 `loop.ts` 没有明确看到报告所说的 loop 内 `runSummarize` 二次触发路径。

#### 必须先写的测试

1. 构造小 contextWindow。
2. 构造多轮历史，触发 compact。
3. 注入 fake summarizer，记录调用次数。
4. 执行一次 `submit()`。
5. 断言：
   - summarizer 调用次数是否为 1。
   - `summary.replace()` 是否被调用多次。
   - `log.replaceAll()` 是否被执行多次。
   - 最后一轮用户消息是否保留。

#### 如果测试失败

若确实双重压缩，采用 submit-scope 标记：

```ts
let compactedInThisSubmit = false
```

或在 `ContextManager` 内维护一轮 compact marker。

但不要增加私有 `_compactedInThisSubmit` 脏字段，优先通过 `submit()` 局部变量和 loop opts 显式传递。

---

### VERIFY-03：`TOOL_SIDE_EFFECTS` 映射是否仍存在

**原报告分级**：P1  
**本 spec 判断**：当前路径无法核实  
**允许操作**：先定位当前实现

#### 执行步骤

搜索：

- `TOOL_SIDE_EFFECTS`
- `sideEffects`
- `external`
- `workspace`
- `salvage`
- `text tool`
- `truncation`

#### 判断

如果当前代码仍有 side-effect map：

- `apply_patch` 应为 `"workspace"`
- `glob` 应为 `"none"`
- `get_goal` 应为 `"none"`
- `set_goal` 应为 `"workspace"`
- `mailbox` 应按实际行为判断：
  - 若只读本地 mailbox 状态：`"none"` 或 `"workspace"`
  - 若可能发外部消息：`"external"`

如果当前代码已删除该机制，则关闭此项，不做无意义修改。

#### 测试要求

如果映射存在：

1. salvage 时 `glob` 不应被误判 external 而阻止。
2. `apply_patch` 不能被误判为 external；但仍需要 write approval / sensitive path guard。
3. 未知工具继续 fail-closed。

---

### VERIFY-04：`BranchBudgetTracker.extractRunCommand()` 字段名是否完整

**原报告分级**：P2  
**本 spec 判断**：客观的需验证项

#### 当前事实

`extractRunCommand()` 当前只读取 `args.command`。

#### 执行步骤

1. 定位 `createBashTool()` 和 dual-track bash 工具 schema。
2. 确认命令字段是否只有 `command`。
3. 如果存在 `cmd`、`script`、`shellCommand` 等别名，补充：

```ts
const raw = args.command ?? args.cmd ?? args.script
```

4. 如果 schema 统一就是 `command`，只补一个测试锁定行为即可。

#### 测试要求

- bash tool schema required 字段与 `extractRunCommand()` 一致。
- BranchBudget 对失败命令 retry 计数能命中真实 bash 参数。

---

### VERIFY-05：`protectedTail` token 上限

**原报告分级**：P2  
**本 spec 判断**：真实边界，但不能简单截断

#### 当前事实

`compactToTarget()` 保护最后一轮 user 开始后的全部消息。最后一轮极大时，compact 可操作空间会变小。

#### 不允许的修复

不要直接截断 `protectedTail`。最后一轮通常是当前任务的关键上下文，截断可能破坏任务正确性。

#### 推荐方案

先增加 diagnostic：

- 如果 `protectedTailTokens > contextWindow * 0.5`，记录 warning。
- 如果 `protectedTailTokens > contextWindow * 0.8`，返回明确错误或提示用户拆分任务。

#### 测试要求

1. 最后一轮巨大时不 silent over-compress。
2. 系统给出可理解的 warning 或 error。
3. 普通 compact 行为不变。

---

## 5. 明确降级或暂不处理的原报告条目

### DEFER-01：`CheckpointEngine.save()` promise chain 无限增长

**原报告分级**：P1  
**本 spec 分级**：P3 / 可维护性观察项

当前 promise chain 是常见串行化写法，不应在没有内存 profile 的情况下重构为自定义 mutex。先不处理。

后续若要处理，必须提供：

- 长任务 500+ save 的内存 profile。
- 与现有 promise chain 语义等价的测试。
- 并发 save 顺序不乱的测试。

### DEFER-02：`loadSession` 后立即注入 experience recall

**原报告分级**：P1  
**本 spec 分级**：P3 / UX

`injectExperienceRecall()` 在下一次 `submit()` 会调用。恢复 session 但不 submit 时没有 recall，不影响安全或正确性。暂不处理。

### DEFER-03：stream error 相同错误去重

**原报告分级**：P2  
**本 spec 分级**：P3 / token 优化

当前 append error tool_result 是为了维护 provider tool-call 协议一致性。不要轻易跳过。若要优化，必须保证：

- 不产生 orphan tool_call。
- 不破坏 OpenAI-style tool result 序列。
- 相同错误去重只影响日志，不影响协议消息完整性。

---

## 6. 验收命令

coding agent 完成任一 PR 后必须运行：

```bash
bun run typecheck
bun test
```

如果仓库已有更细粒度命令，优先运行相关包测试，例如：

```bash
bun test packages/core/__tests__/session.test.ts
bun test packages/core/__tests__/checkpoint*.test.ts
bun test packages/core/__tests__/*executor*.test.ts
bun test packages/tools/__tests__/*sensitive*.test.ts
```

CI 维度必须至少覆盖：

- ubuntu
- macOS
- Windows

如果 Windows 上存在已知 Bun 文件锁问题，只能 skip 明确受影响测试；不能用 skip 掩盖本 spec 新增功能测试。

---

## 7. agent 执行提示词

下面这段可以直接交给 coding agent：

```text
你正在修复 bzcsk2/covalo 的 Engine / Loop / Governance / Session 审计问题。请严格按照 docs/specs/engine-loop-governance-session-fix-spec.md 执行。

目标不是重构架构，而是修复已确认问题并补测试。

执行顺序：
1. 先处理 FIX-01 AsyncSessionWriter.drain timeout。
2. 再处理 FIX-02 hook exception deny reason。
3. 再处理 FIX-03 SessionLoader.cleanup orphan checkpoint。
4. 再处理 FIX-04 sensitive path patterns。
5. 再处理 FIX-05 CheckpointEngine write/rename retry。
6. 最后只为 VERIFY-* 项补复现测试，不要在无复现时改主逻辑。

约束：
- 每个 FIX 必须有测试。
- 不要降低断言。
- 不要把 approvalPolicy: never 改成 ask。
- 不要直接截断 protectedTail。
- 不要重构 promise chain，除非有内存 profile 和完整并发测试。
- 不要按旧审计报告的 P0/P1 分级照单全收；以本 spec 的分级为准。

完成后输出：
- 修改文件列表
- 每项 FIX 的实现说明
- 测试命令与结果
- 未处理 VERIFY/DEFER 项的原因
```

---

## 8. 最终交付标准

一个合格修复 PR 至少应满足：

- typecheck 通过。
- 相关单元测试通过。
- full suite 不引入新增失败。
- 每个确认问题都有对应测试。
- 没有把“需验证项”伪装成已修复。
- PR 描述中明确列出：
  - 已修复项
  - 未修复但已降级项
  - 需后续验证项

---

## 9. 建议 issue 切分

### Issue 1：Session writer shutdown safety

包含：

- FIX-01

### Issue 2：Checkpoint and session cleanup reliability

包含：

- FIX-03
- FIX-05

### Issue 3：Permission observability and sensitive file coverage

包含：

- FIX-02
- FIX-04
- HARDEN-01

### Issue 4：Context/prefix compaction verification

包含：

- VERIFY-01
- VERIFY-02
- VERIFY-05

### Issue 5：Tool salvage side-effect mapping verification

包含：

- VERIFY-03
- VERIFY-04

---

## 10. 附：原审计条目重新分级表

| 原编号 | 原结论 | 本 spec 判断 | 处理方式 |
|---|---|---|---|
| P0-1 | approvalPolicy never 无安全网 | 事实部分正确，严重性过高 | HARDEN-01 |
| P0-2 | loadSession 不清 prefix 导致 toolSpecs 残留 | 证据不足，疑似误判 | VERIFY-01 |
| P1-1 | compact 双重截断 | 证据不足 | VERIFY-02 |
| P1-2 | loadSession 后不注入 recall | 低优先级 UX | DEFER-02 |
| P1-3 | BackgroundTaskManager adopt 失败孤儿进程 | 未在本轮核实 | 另开专项审计 |
| P1-4 | TOOL_SIDE_EFFECTS 不完整 | 当前路径无法核实 | VERIFY-03 |
| P1-5 | AsyncSessionWriter.drain 无超时 | 确认问题 | FIX-01 |
| P1-6 | Checkpoint promise chain 无限增长 | 严重性过高 | DEFER-01 |
| P2-1 | hook 异常 deny 无 reason | 确认问题 | FIX-02 |
| P2-2 | cleanup 不清 checkpoint | 确认问题 | FIX-03 |
| P2-3 | shell find -delete 未覆盖 | 需先定位当前实现 | HARDEN-02 |
| P2-4 | sensitive patterns 不完整 | 确认问题 | FIX-04 |
| P2-5 | stream error 累积错误消息 | 设计取舍 / token 优化 | DEFER-03 |
| P2-6 | extractCommand 只看 command | 需验证 | VERIFY-04 |
| P2-7 | protectedTail 可能过大 | 确认边界，不能直接截断 | VERIFY-05 |
