# deepicode

<p align="center">
  <strong>中文</strong> |
  <a href="./README.en.md">English</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-FF5E5B?style=flat-square" />
  <img src="https://img.shields.io/badge/model-DeepSeek_V4-4B8BF5?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" />
  <img src="https://img.shields.io/badge/version-0.1.0-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/test-43_pass_0_fail-green?style=flat-square" />
</p>

---

**花别人的钱不心疼，花自己的钱每一分都要算。**

deepicode 不是又一个套壳 LLM 聊天工具。它是一个**把 DeepSeek API 经济学玩到极致的终端编程 Agent**。我们围绕 DeepSeek 的 prefix-cache 定价模型重新设计了整个上下文引擎——cache hit 时每百万 token 只要 1 块钱，cache miss 时要 4 块。这个 4 倍的差价，就是 deepicode 存在的意义。

---

## 为什么你要关心 Token 账单

用普通 Agent 写一天代码，轻松烧掉几块钱甚至几十块。不是因为你用了多少 token——而是因为你**为同一段系统提示词反复付了 cache miss 的钱**。

deepicode 的做法：

```
每次 API 调用：
  ┌─────────────────────────────┐
  │ System Prompt (永远不会变)    │  ← 100% cache hit → ¥0.5/M
  │ Tool Definitions (几乎不变)   │  ← 100% cache hit → ¥0.5/M
  │ 对话历史 (只追加不修改)       │  ← 渐进 cache miss → ¥2~4/M
  │ 本轮工具结果 (每轮不同)       │  ← 必 miss → 无优化空间
  └─────────────────────────────┘

普通 Agent：改一个工具定义 → 整个前缀变了 → 全额按 miss 计费
deepicode：SHA-256 指纹检测 → 只有真正变了的部分才触发 miss
```

这不是省 10%、20% 的小优化。一个 50 轮的长会话，deepicode 能比普通 Agent **少花 60-80% 的 API 费用**。

---

## 不只是省——还能提前告诉你花多少

每次输入提交后，deepicode 会分析任务复杂度，预估本轮消耗：

```text
╭─ 成本预估 ─────────────────────────────╮
│  chat-fast        约 ¥0.008 ~ ¥0.015   │  ← 问答、查文件
│  chat-full        约 ¥0.02  ~ ¥0.06    │  ← 常规编码、调试
│  reasoner-budget  约 ¥0.08  ~ ¥0.35    │  ← 中等重构
│  reasoner         约 ¥0.30  ~ ¥1.20    │  ← 架构级变更
├─────────────────────────────────────────┤
│ 自动推荐：chat-full                     │
│ 3 秒后自动执行 · 方向键切换 · Enter 确认 │
╰────────────────────────────────────────╯
```

**透明的代价**——你知道这一轮对话大概花多少钱，再决定用哪个档位。对个人开发者和小团队来说，每个月多省一杯咖啡钱是实实在在的。

---

## 自动挡 + 预算上限

不想每次手动选？开自动挡：

```text
自动模式（Auto Tier）：
  简单问答 / 单文件查找     → deepseek-chat (flash)  最便宜
  常规编码 / 调试 / 小修改  → deepseek-chat (full)   够用
  多模块重构 / 架构变更     → deepseek-reasoner       该花就花
  检测到 Agentic 多轮链路  → 自动叠加 2-3 倍估算系数
```

设置月度预算上限，接近限额自动降级到 flash 档。**花钱这件事，交给代码，不交给人性。**

---

## Skills · MCP · Subagents — 不只是 Agent，是 Agent 平台

### Skills（技能系统）

Skills 是可复用的领域知识包。每个 Skill 是一个独立的指令文件，Agent 按需加载——遇到数据库优化任务自动加载 `postgres-patterns`，做前端页面自动加载 `frontend-design`。你不必每次手写长篇 system prompt，deepicode 帮你记住并适时激活。

```text
用户: "帮我优化这个 SQL 查询"
  → Agent 自动匹配 postgres-patterns skill
  → 注入 PostgreSQL 索引优化、查询计划分析知识
  → 开始工作

用户: "设计一个登录页面"
  → 自动匹配 frontend-design skill
  → 注入 UI/UX 最佳实践
  → 写出符合设计规范的代码
```

### MCP（Model Context Protocol）

通过 MCP 协议接入外部工具和数据源。Supabase 数据库、Serena 代码分析、Playwright 浏览器自动化——都作为 MCP Server 注册，Agent 自动发现并调用。

```text
deepicode                    MCP Servers
   │                            │
   ├── mcp:supabase ────────────┤  执行数据库查询
   ├── mcp:serena ──────────────┤  代码符号分析
   ├── mcp:playwright ──────────┤  浏览器自动化测试
   ├── mcp:context7 ────────────┤  实时文档查询
   └── mcp:your-custom-server ──┤  任意扩展
```

### Subagents（子 Agent 系统）

复杂任务可委托给隔离子 Agent 执行。主 Agent 负责任务规划和结果整合；后台子 Agent 可读写、检索和分析，但不会绕过交互确认执行 `exec` 工具。

```text
用户: "审计这个 PR 的安全性并生成测试"
   │
   ▼
  主 Agent (规划 + 编排)
   │
   ├── Subagent 1: security-reviewer  → 安全漏洞扫描
   ├── Subagent 2: tdd-guide          → 测试用例生成
   └── Subagent 3: code-reviewer      → 代码质量审查
   │
   ▼
  整合结果 → 一份完整的审计报告 + 测试代码
```

> **当前状态**：Skills、MCP 动态工具发现与调用、隔离子 Agent 已接入。内置静态 Agent Tool 共 34 个；LSP 需要在 `.deepicode/lsp.json` 配置 language server，浏览器交互需要安装 Playwright。

LSP 最小配置示例：

```json
{
  "languages": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"]
    }
  }
}
```

---

## 技术架构

### 核壳分离

引擎和界面完全解耦——`CoreEngine` 通过 `AsyncGenerator<LoopEvent>` 向外部推送事件，壳层只需消费事件流即可渲染。这意味着：

- **引擎可独立迭代**：prefix-cache 策略、token 预算、repair 流水线的改进不影响 UI
- **壳层可独立扩展**：CLI / TUI / Web / IDE 插件，只需实现同一套 `LoopEvent` 消费者
- **测试无需启动界面**：引擎的完整行为可通过 `for await (const event of engine.submit(...))` 直接验证

```text
CLI (readline)           TUI (Ink/React)          IDE Plugin
      │                        │                       │
      └────────────────────────┼───────────────────────┘
                               │
                    AsyncGenerator<LoopEvent>
                               │
                      ┌────────┴────────┐
                      │   CoreEngine    │
                      │   (engine.ts)   │
                      └────────┬────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
   DeepSeekClient      ContextManager      StreamingToolExecutor
   (SSE streaming)     (三段式上下文)       (并行/串行调度)
```

### 三段式上下文

这是 deepicode 的省钱核心。DeepSeek 的 prefix-cache 按**请求消息的字节前缀**匹配：前缀相同时 token 按 cache hit 计费（便宜），前缀变化时按 cache miss 计费（贵）。

```
发给 API 的 messages 数组：
┌──────────────────────────────────────┐
│ [0] system prompt            ▲       │
│     (ImmutablePrefix)        │ 不会变  │  ← 100% cache hit
│ [1] tool definitions         ▼       │
├──────────────────────────────────────┤
│ [2] user: "帮我看看文件A"             │
│ [3] assistant: "文件A内容如下..."     │  ← AppendOnlyLog
│ [4] tool: read_file 结果             │    只追加，不修改
│ [5] assistant: "我建议..."           │    前缀连续性保持
├──────────────────────────────────────┤
│ [6] ...本轮工具调用的临时结果...       │  ← VolatileScratch
│                             每轮清空   │    不破坏前缀
└──────────────────────────────────────┘
```

**关键设计决策**：

- `ImmutablePrefix` 使用 SHA-256 指纹（system prompt + toolSpecs + fewShots），工具 schema 变化时自动检测并预警 cache miss
- `AppendOnlyLog` 只调用 `push()`，从不 `splice()` 或 `shift()`——一旦修改历史消息就会位移整个前缀
- `VolatileScratch` 每轮 `startTurn()` 清空，确保本轮临时状态不影响下一轮的前缀匹配

### 流式工具执行

不等模型输出完毕就开始调度工具。当前策略是稳定优先——模型 tool call 完整接收后再执行。后续升级为 **eager dispatch**：

```text
模型输出: { "name": "read_file", "arguments": { "path":...

   │                            │
   │  参数部分完整可解析         │  ← 即刻创建 Promise 并发执行
   │  (增量式 JSON 验证)        │     不等后续文本生成
   │                            │
   ▼                            ▼
   read_file("a.ts")     read_file("b.ts")    ← shared 工具并行
        │                      │
        └──────────┬───────────┘
                   ▼
              结果合并后继续
```

### 多维编辑

`edit` 工具策略链：**Hash 锚定 → 4-pass Fuzzy → 失败反馈**。

```
┌─ Hash-Anchored ──────────────────────┐
│ 流式异步读取 → 分块匹配 → 临时文件写 │
│ 入 → rename 原子替换 → 保留原权限    │
└──────────┬───────────────────────────┘
           │ old_string 未精确匹配
           ▼
┌─ Fuzzy Fallback ─────────────────────┐
│ Pass 1: exact (精确匹配)              │
│ Pass 2: trimmed_lines (去行尾空白)    │
│ Pass 3: trimmed_full (全文去空白)     │
│ Pass 4: flexible_whitespace (弹性空白)│
│ [Pass 5-9 待实现]                     │
└──────────┬───────────────────────────┘
           │ 所有 pass 均失败
           ▼
        返回 [Error] old_string not found
        → 模型收到反馈后重试
```

### Stale-read 保护

Agent 经常在"读文件 → 思考 → 编辑"之间跨越多个 API 调用回合。在此期间文件可能被用户或 git 操作修改。

```
read_file("a.ts")  →  recordRead(mtime=10:30:01, size=4096)
                         │
         ... 模型思考 + 多轮工具调用 ...
                         │
       edit("a.ts", ...) →  checkStale("a.ts")
                         │
                    ┌────┴────┐
                    │ mtime 变了？ │
                    │ size 变了？  │
                    └────┬────┘
                    是 → 拒绝编辑 → 提示先 re-read
                    否 → 执行编辑
```

### Session 持久化

每轮对话完整写入 `.deepicode/sessions/<id>.jsonl`，异步批量写不阻塞主循环。

```jsonl
{"ts":1717000000,"type":"event","payload":{"role":"reasoning_delta","content":"..."}}
{"ts":1710000001,"type":"event","payload":{"role":"assistant_delta","content":"..."}}
{"ts":1710000002,"type":"messages","payload":[...]}
{"ts":1710000003,"type":"stats","payload":{"promptTokens":120,...}}
```

---

## 快速开始

```bash
# 前置：Bun >= 1.3
git clone https://github.com/bzcsk2/deepicode.git
cd deepicode
bun install

# 配置 API Key（二选一）
export DEEPSEEK_API_KEY="sk-your-key"
# 或者项目根目录创建 api-key 文件（git-ignored）

# 启动
bun run dev
```

```bash
# 管道输入
echo "帮我重构 src/utils.ts" | bun run dev

# 查看帮助
bun run dev --help
```

交互中可用 `/exit` 退出，`/help` 查看帮助。

---

## 工具集

| 工具 | 类型 | 说明 |
|------|------|------|
| `read_file` | shared | 读取文件，支持行切片、大小限制、敏感文件自动拒绝 |
| `write_file` | exclusive | 创建/覆盖文件 |
| `edit` | exclusive | 文本块替换（hash 锚定 + 4-pass fuzzy 回退） |
| `bash` | exclusive | Shell 命令，自动拦截 rm -rf /、sudo 等危险操作 |
| `list_dir` | shared | 目录列表 |
| `grep` | shared | 正则搜索代码 |
| `todowrite` | shared | 任务跟踪 |

并发安全：`shared` 工具并行执行，`exclusive` 工具串行执行。读文件不阻塞写文件。

---

## 项目结构

```text
deepicode/packages/
├── core/     # 核层：推理引擎
│   ├── engine.ts              # 主循环 (AsyncGenerator)
│   ├── client.ts              # DeepSeek SSE 客户端
│   ├── streaming-executor.ts  # 流式工具执行器
│   ├── session.ts             # JSONL 异步会话持久化
│   └── context/               # 三段式上下文管理
├── tools/    # 工具层（7 个工具）
├── cli/      # readline 交互入口
├── shell/    # 状态管理 & 事件系统（待实现）
├── tui/      # Ink/React TUI（待接入）
└── security/ # 权限引擎（待实现）
```

---

## 开发进度

| Phase | 内容 | 状态 |
|-------|------|------|
| 0 | 脚手架 & monorepo | ✅ |
| 1 | 核心引擎（SSE、上下文、流式执行器） | ✅ |
| 2 | **智能推理强度调节 & 成本预估** | ⬜ |
| 3 | 壳层增强（状态管理、事件系统） | ⬜ |
| 4 | 工具层完善（9-pass fuzzy、session 恢复） | 🔄 |
| 5 | 安全层（权限引擎、Git 快照） | ⬜ |

详见 [`TODO.md`](./TODO.md) · [`DONE.md`](./DONE.md)

---

## 开发

```bash
bun test           # 43 pass / 0 fail
bun run typecheck  # TypeScript 编译检查
```

---

## 文档

| 文档 | 说明 |
|------|------|
| [设计文档](./Deepicode项目设计文档.md) | 五层架构、三段式上下文、策略系统 |
| [实施计划](./Deepicode实施计划.md) | 分 Phase 实施步骤与验收标准 |
| [TODO](./TODO.md) | 当前任务与优先级 |
| [DONE](./DONE.md) | 已完成记录与已知限制 |
| [FindBug](./FindBug.md) | Agent 系统 Bug 模式与审查指南 |
| [ADVICE](./ADVICE.md) | 代码审查发现的全部问题与修复记录 |

---

## 贡献

Issue 和 PR 都欢迎。Fork → Feature Branch → Commit → PR。

---

## 许可证

MIT · [`LICENSE`](./LICENSE)

---

## 致谢

设计借鉴：

- [Reasonix](https://github.com/bczsk2/reasonix-core) — Cache-first 引擎
- [oh-my-pi](https://github.com/earendil-works/pi-mono) — Agent 状态管理
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — 流式工具执行
- [OpenCode](https://github.com/opencode-ai/opencode) — Fuzzy Edit & Stale-read
