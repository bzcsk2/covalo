# 🌊 DeepReef

<p align="center">
  <a href="./README.md">English</a> |
  <strong>中文</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Bun-1.3+-orange" alt="Bun" />
  <img src="https://img.shields.io/badge/TypeScript-Ready-blue" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Status-pre--1.0-yellow" alt="Status" />
  <img src="https://img.shields.io/badge/TUI-Ink%2FReact-blue" alt="TUI" />
  <img src="https://img.shields.io/badge/Schema-Zod_4-green" alt="Schema" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" alt="License" />
</p>

**DeepReef 是一个终端原生 AI Loop Agent，目标是让便宜、免费、本地模型也能稳定交付工程任务。**

大部分 AI 编程工具默认依赖昂贵的头部模型来保证质量。DeepReef 的设计哲学不同：让更强的模型负责规划、监督、审查和纠偏，让便宜/免费/本地模型负责大量施工，再通过明确的执行闭环、证据汇报、失败恢复和权限边界把任务做完。

> DeepReef 不是要否定强模型，而是把强模型用在最有价值的位置，让弱模型也能持续工作。

---

## DeepReef 经济学

DeepReef 关注的是 AI 编程进入长期工作流之后的真实成本：

- 强模型负责关键判断，而不是每一步都亲自施工。
- Worker 可以使用免费模型、低价 API 模型或本地 OpenAI-compatible 模型。
- Supervisor 在规划、审查、失败恢复和最终判断时介入。
- 通过缓存友好的上下文管理、工具调用修复、Session 恢复和 Verification Gate 减少重复消耗。

这套思路适合独立开发者、小团队、长时间自动化工程任务，以及本地模型能力正在快速提升但仍不稳定的场景。

---

## ⚔️ 双 Agent Workflow

DeepReef 摒弃容易自我迷失的单体无限 Loop，采用固定双角色 Workflow：

```text
Supervisor 分析
  -> Worker 执行
  -> Worker 汇报
  -> Supervisor 检查证据
  -> 继续 / 修正 / 停止 / 求助人类
```

### Worker：干活 Agent

Worker 是主要 token 消耗者。它可以配置为本地模型、免费模型或性价比模型。普通对话时，Worker 可以像常规 coding agent 一样直接工作；进入 workflow 后，Worker 听从 Supervisor 指令，按 harness 强度执行小步任务，并定期汇报结果。

### Supervisor：监督 Agent

Supervisor 使用更强的模型，负责规划、审查、失败识别、恢复建议和最终验收。Worker 达到失败阈值、请求帮助或需要正式检查时，Supervisor 会读取 Worker 汇报和不可变证据包，然后给出下一步结构化指令。

当 workflow 无法安全推进时，Supervisor 应停止自动执行并调用 `ask_user` 求助。

---

## 🚀 快速开始

### 全局安装

```bash
npm install -g @deepreef/cli
```

也可以使用 Bun：

```bash
bun install -g @deepreef/cli
```

### 在项目中启动

```bash
cd your-project
deepreef
```

进入 DeepReef 后，优先使用：

```text
/help
/model
/workflow
```

`/help` 是主要使用入口。你可以直接询问命令、模型配置、workflow、harness、provider、session 恢复等问题。

### 从源码运行

```bash
git clone https://github.com/bzcsk2/DeepReef.git
cd DeepReef
bun install
bun run dev
```

---

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `/model` | 切换对话对象与模型配置，状态不丢失。 |
| `/workflow` | 启动 Supervisor / Worker 双 Agent 工作流。 |
| `/sessions` | 查看和恢复历史会话，支持异常退出后的恢复。 |
| `/skill` | 浏览和启用内置工程技能。 |
| `/status` | 查看系统、模型、Provider、工具和 Session 状态。 |
| `/context` | 修改上下文策略。 |
| `/thinking` | 调整思考强度。 |
| `/harness` | 根据模型能力调整执行约束强度。 |
| `/help` | 查看帮助，也可以直接提问。 |

---

## ✨ 核心亮点

### 💰 更低成本

- **ImmutablePrefix + SHA-256 cacheKey**：稳定缓存边界，提高 prefix-cache 命中率。
- **Tool-call Repair**：自动修复 JSON 参数错误，减少失败后重复计费。
- **多 Provider 路由**：支持免费模型、低价 API 模型和本地 OpenAI-compatible 模型。
- **Supervisor / Worker 分工**：强模型负责关键判断，便宜模型负责大量施工。

### 🧠 面向小模型优化

- **Harness 强度可调**：根据模型能力选择不同容错档位。
- **小步执行**：限制 Worker 一次做太多不可靠操作。
- **失败恢复**：重复失败后交给 Supervisor 分析和纠偏。
- **Verification Gate**：把可验证结果作为 workflow 推进依据。

### ✏️ 精准编辑

- **Hash-Anchored Edit**：SHA-256 校验和大文件流式处理。
- **Fuzzy Edit Fallback**：渐进式兜底匹配，提升编辑成功率。
- **Stale-read 校验**：防止基于过期读取结果覆盖文件。
- **FileSnapshot**：文件级快照，便于回滚。

### 🧩 完整生态

- 30+ 内置工具：文件、Shell、搜索、编辑、Web、MCP、Cron、Workflow、Notebook、Task 等。
- Skills 系统：按任务自动注入领域知识。
- MCP 支持：通过 JSON-RPC 2.0 / stdio 接入外部工具。
- Plugin / content-pack 支持。
- AgentMemory 集成和记忆工具。

---

## 🏗️ 软件架构

DeepReef 采用核壳分离设计：

```text
packages/core      -> 推理循环、API 适配、上下文管理、缓存、工具修复、workflow 基础
packages/tui       -> Ink/React 终端界面、状态栏、输入、模型选择、workflow 展示
packages/tools     -> 文件、Shell、搜索、编辑、Web、MCP、Workflow、Task、Notebook 工具
packages/plugin    -> Plugin/content-pack、Hook、Schema 工具验证
packages/memory    -> AgentMemory 集成和 memory tools
packages/security  -> Deny-first PermissionEngine、HookManager、FileSnapshot
packages/cli       -> 命令行入口
```

核心引擎通过 `AsyncGenerator<LoopEvent>` 输出事件，CLI、TUI、测试和未来 IDE/Web 壳层都可以消费同一套事件流。

---

## 📡 模型与 Provider

DeepReef 不绑定单一模型供应商。运行时真正关心的是：

```ts
{
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}
```

常见模型类型：

| 类型 | 用途 |
| --- | --- |
| 免费网关模型 | Worker 执行、探索、简单实现。 |
| 本地 OpenAI-compatible 模型 | 私有化、长时间、低成本 Worker 执行。 |
| 用户 API Key 模型 | Supervisor、审查、恢复、高质量执行。 |
| 自定义 OpenAI-compatible Endpoint | vLLM、Ollama、llama.cpp、本地网关或内部路由。 |

通过 `/model` 可以切换模型、配置 API Key、配置本地模型和自定义 endpoint。

---

## 🛡️ 安全边界

DeepReef 可以读取文件、编辑文件、运行命令和调用工具。它是强大的本地工程助手，不是完全隔离的安全沙箱。

当前安全策略包括：

- Deny-first 权限引擎。
- Shell 和文件写入操作需要授权。
- 危险命令拦截。
- Web 请求 SSRF 防护。
- 文件快照与回滚。
- Stale-read 编辑保护。
- 子 Agent 权限隔离。
- API Key 文件默认被 Git 忽略。

不要在你不愿意审查 agent 修改结果的仓库中运行 DeepReef。

---

## 🗺️ 项目状态

DeepReef 当前处于 **pre-1.0** 阶段。

| 模块 | 状态 |
| --- | --- |
| 核心引擎、30+ 工具、安全层、Plugin/Skills | 已实现 |
| AgentMemory 与 memory tools | 已实现 |
| 小模型 harness 定制 | 已实现 |
| MCP 基础接入 | 已实现 |
| 双 Agent Workflow 编排 | 部分实现，持续打磨 |
| TUI 页面体验 | 部分实现，持续打磨 |
| 文档、发布流程、外部贡献入口 | 持续完善 |

详细路线见 [ROADMAP.md](./ROADMAP.md)。

---

## 开发与验证

```bash
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

发布包名是 `@deepreef/cli`，命令行入口是 `deepreef`。

---

## 贡献

欢迎贡献本地模型预设、Provider 适配、MCP 示例、TUI 体验、workflow 可靠性测试、文档和安全加固。

开始前请阅读 [CONTRIBUTING.md](./CONTRIBUTING.md) 和 [SECURITY.md](./SECURITY.md)。

---

## 信念

> 真正有价值的 Agent，不是只在强模型上表现好，而是能把弱模型、便宜模型、本地模型组织起来，让它们稳定完成工程任务。

AI Coding Agent 的下一阶段是成本控制、交付质量和更可靠的 Loop。

**欢迎一起来让“便宜好用”成为 AI 编程的标配。**
