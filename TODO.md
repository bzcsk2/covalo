# Deepicode TODO

  主要问题

  ✅ 已修复：
  
  4. ~~shared 工具结果顺序不稳定~~ → 已完成：并发执行后按声明 index 顺序提交到上下文
  5. ~~toolCallIndex 映射可能丢失~~ → 已完成：executeToolResult 保留原始 index
  6. ~~assistant_final / reasoning_content~~ → 已完成：协议边界 + 历史 round-trip

  所有问题已修复 ✅（2026-05-29）


本文记录下一阶段任务。优先级从高到低排列，建议每个任务完成后同步更新 `DONE.md`。

## P0：修正核心协议边界

### 1. 增加 `assistant_final` 事件

状态：完成 ✅（2026-05-29）

- `LoopEventRole` 增加 `assistant_final`。
- `ReasonixEngine.submit()` 在模型 stop/tool_calls 前均产出 `assistant_final`。
- TUI 已处理 `assistant_final` 事件。

### 2. 引入 `reasoning_content` 历史字段

状态：完成 ✅（2026-05-29）

- `ChatMessage` 增加 `reasoning_content?: string | null`。
- assistant 历史消息写入时保留 `reasoning_content`。
- `DeepSeekClient` 发送 assistant message 时包含 `reasoning_content`。
- `cloneChatMessage` / `computeHash` 已覆盖 `reasoning_content`。

### 3. 工具结果提交顺序确定化

状态：完成 ✅（2026-05-29）

- shared 工具并发执行，结果按模型声明 index 顺序排序后统一 yield + appendToolResult。
- 提取 `executeToolResult()` 分离结果计算与 append 逻辑。
- `engine-tools.test.ts` 已验证 toolCallIndex 顺序正确。

## P1：补齐工具安全底线

### 4. 为 `bash` 增加最小权限确认接口

状态：完成 ✅（2026-05-29）

- 添加了 deny patterns：`rm -rf /`、`sudo`、`mkfs`、`dd`、`fdisk`、`chmod -R 777 /`
- 危险命令返回结构化错误，不执行
- read-only 命令如 `pwd`、`ls`、`cat` 正常执行
- command 参数过滤：非 string/空字符串返回错误

### 5. 为 `read_file` 增加路径与大文件保护

状态：完成 ✅（2026-05-29）

- 路径基于 `ctx.cwd` resolve 为绝对路径
- 拒绝读取 `api-key`、`.env`、私钥、`.git/` 等敏感文件
- 超过 10MB 的文件返回错误，不读取内容
- 不存在文件返回结构化错误
- path 参数验证：非 string/空返回错误

### 6. 完成 Stale-read Validation 最小版

目标：

- 写入前确保文件内容没有被外部修改。

验收：

- `read_file` 记录 path + mtime + hash。
- `edit` 前校验记录。
- stale 时返回错误并提示先重新 read。

## P1：补齐编辑工具

### 7. 完整化 Hash-Anchored Edit

目标：

- 让 edit 从“exact replace once”升级为可验证锚点编辑。

验收：

- 支持 oldHash 或上下文 hash。
- hash 不匹配时不写文件。
- 写入使用临时文件 + rename。
- 单测覆盖 hash match / mismatch / 多行替换。

### 8. 完整化 9-Pass Fuzzy Edit

目标：

- 实现实施计划中的 9-pass fallback。

验收：

- 至少覆盖：
  - exact
  - lineTrimmed
  - blockAnchor
  - whitespaceNormalized
  - indentationFlexible
  - escapeNormalized
  - trimmedBoundary
  - contextAware
  - multiOccurrence
- 所有 pass 有独立单测。

## P1.5：事件体系分层

### 9. 展示事件与协议事件分层

状态：待完成

目标：

- 协议事件：`assistant_final`、`tool`、`done`
- 展示事件：`status`、`tool_progress`、`warning`

验收：

- `tool_progress` 事件可展示工具执行进度，不影响协议事件顺序
- assistant_final/tool/done 保持协议 deterministic

## P2：Context 与 Session

### 10. prefix fingerprint 覆盖真实请求前缀

状态：完成 ✅（2026-05-29）

- cacheKey 由 system + toolSpecs JSON + fewShots JSON 三者 SHA-256 组合计算
- 工具 schema 变化会改变 fingerprint
- 4 个单测覆盖 system/toolSpecs/fewShots 三类变化

### 11. 接入 token 估算与 fold 决策

目标：

- 为长会话做上下文预算保护。

验收：

- `ContextManager` 提供估算接口。
- 实现 75% fold 建议、80% force summary 的最小决策。
- 暂时可用近似 token 估算，后续再替换 tokenizer worker。

### 12. 完成 session 恢复

目标：

- JSONL 不只写入，也能恢复。

验收：

- 支持从 `.deepicode/sessions/<sessionId>.jsonl` 加载 messages。
- 启动参数或 API 支持指定 sessionId。
- 恢复后可继续对话。

## P2：DeepSeekClient 稳定性

### 13. 增加 API 重试与错误分类

状态：完成 ✅（2026-05-29）

- 429 / 502 / 503 使用指数退避重试（最多 3 次，1s/2s/4s + jitter）
- 400 / 401 不重试，直接返回结构化错误
- 引擎 loop 中连续 3 次 stream 失败才终止，中间自动重试

### 14. 补齐 SSE 边界测试

目标：

- 保证 streaming parser 在真实网络 chunk 边界下可靠。

验收：

- chunk 被任意切分仍可解析。
- 最后一个 chunk 不完整时不崩溃。
- `[DONE]` 后正确结束。

## P3：Shell / TUI / Agent 外壳

### 15. 建立 shell 状态层

目标：

- 从 CLI 直接消费 core events，升级为 shell state projection。

验收：

- `packages/shell/src/state.ts` 实现不可变状态更新。
- 支持 messages、tool status、stats、errors。

### 16. 重新评估 TUI 接入

目标：

- 当前 CLI 是 readline；后续需要真正 TUI 时再引入 UI 框架。

建议：

- 不再跨仓库源码直引 oh-my-pi。
- 若使用 oh-my-pi，先做 workspace/package 级依赖或复制必要组件。

验收：

- `bun run typecheck` 不依赖 `/vol4/Agent/oh-my-pi` 源码。
- UI 能显示 assistant stream、tool progress、tool result、stats。

## P4：测试与文档

### 17. README 重建

目标：

- 当前仓库没有 README，需恢复面向开发者的入口文档。

验收：

- 包含安装、配置、运行、测试、工具说明、限制。

### 18. 增加 E2E 场景

目标：

- 覆盖最关键 agent 工作流。

建议场景：

- bash 执行 `pwd` 并返回结果。
- read_file 读取 `package.json`。
- edit 修改临时文件并验证内容。
- 工具错误后模型继续回复。
- 中断正在执行的 bash。

验收：

- 每个场景可自动化运行。
- CI 或本地 `bun test` 可执行，不依赖真实 DeepSeek API。

## 暂缓任务

以下任务价值高，但当前不建议立即做：

- 完整 Repair Pipeline。
- Tokenizer Worker Pool。
- StrategySelector 和 CNY 成本卡片。
- MCP / LSP / Python Kernel。
- Git Snapshot 回滚。
- 多 Agent Plan / Build 模式。

原因：这些任务会显著扩大实现面。建议先把核心协议、工具安全、session 恢复和测试闭环稳定后再推进。
