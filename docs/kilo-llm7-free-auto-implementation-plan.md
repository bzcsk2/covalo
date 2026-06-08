# Kilo、LLM7 与 Free Auto 智能路由实施方案

> 供实施 Agent 使用。本文只描述实施方案，不代表功能已经完成。

## 0. 实施总原则：优先复制，禁止无必要重写

本任务不是从零设计 provider 和路由器。`/vol4/Agent/freellmapi` 已经包含经过真实请求验证的实现，实施 Agent 必须先复制可复用源码，再做适配。

执行优先级：

1. **可原样复制的函数直接复制。**
2. **类型或接口不同的代码，复制主体后只改 import、类型名和事件映射。**
3. **只有 `deepicode` 特有的 Engine/TUI 接线代码才新写。**
4. 禁止在没有说明原因的情况下重写 `freellmapi` 已有的 keyless、SSE、错误分类、429 惩罚和冷却算法。
5. 复制源码时保留关键来源注释，并确认 `freellmapi` 的 MIT 版权声明随分发要求得到满足。

实施 Agent 最终报告必须列出：

- 从 `freellmapi` 复制了哪些函数或代码块。
- 每段复制代码做了哪些适配。
- 哪些功能无法复制、必须新写，以及原因。

## 1. 目标

在 `deepicode` 中增加：

1. `kilo` provider：匿名、无需 API Key。
2. `llm7` provider：匿名、无需 API Key。
3. `free-auto` 虚拟 provider：在已验证的免费模型之间智能选择，并在限速、超时或上游故障时串行故障转移。

测速依据：`/vol4/Agent/freellmapi/FREE_MODEL_SPEED_TEST.md`，测试日期为 2026-06-08。免费模型和限额可能变化，模型目录必须集中定义，便于后续维护。

## 2. 已确认的项目结构

关键现状：

- Provider 预设集中在 `packages/core/src/config.ts` 的 `PROVIDERS`。
- `packages/core/src/client.ts` 中的 `DeepSeekClient` 实际是通用 OpenAI-compatible SSE 客户端。
- `packages/core/src/loop.ts` 在一次 `submit()` 的工具循环中使用固定的 `apiKey/baseUrl/model/provider`。
- `packages/core/src/engine.ts` 负责组装 `runLoop()` 参数。
- TUI `/model` 选择器位于 `packages/tui/src/ModelPicker.tsx`，provider 顺序目前是硬编码数组。
- 当前 `thinking` 参数只应发送给明确支持的 provider。Kilo、LLM7 和 `free-auto` 默认不得发送 DeepSeek 专用 thinking 扩展。

工作区当前已有未提交修改。实施时不得覆盖、回退或格式化无关文件。

## 2.1 可直接移植的源码清单

### A. OpenAI-compatible provider 与 keyless 请求

源文件：

- `/vol4/Agent/freellmapi/server/src/providers/base.ts`
- `/vol4/Agent/freellmapi/server/src/providers/openai-compat.ts`
- `/vol4/Agent/freellmapi/server/src/providers/index.ts`

优先复制：

- `BaseProvider.keyless`
- `BaseProvider.fetchWithTimeout()`
- `BaseProvider.readSseStream()` 的流停滞检测、异常 EOF 检测和 reader 清理逻辑
- `OpenAICompatProvider` 构造参数
- `OpenAICompatProvider.authHeader()`
- Kilo 与 LLM7 的注册配置和注释

目标位置建议：

- 将通用请求/SSE 逻辑移植到 `packages/core/src/client.ts`，或复制为 `packages/core/src/openai-compat-client.ts`。
- 如果新建文件，现有 `DeepSeekClient` 应复用/继承该通用实现，避免产生两套 SSE parser。

必须适配：

- `freellmapi` 输出 `ChatCompletionChunk`；`deepicode` 输出 `DeepSeekStreamEvent`，需保留 `deepicode` 现有 tool call 聚合与事件映射。
- `freellmapi` 使用 `max_tokens`；`deepicode` 当前使用 `max_completion_tokens`。移植后允许按 provider capability 决定字段，首版 Kilo/LLM7 应使用它们真实兼容的字段。
- `AbortSignal` 必须继续使用 `deepicode` 外部传入的 signal；不能用内部 timeout controller 覆盖用户 abort。应组合 signal 或沿用现有 watchdog。

### B. 模型目录与已知风险

源文件：

- `/vol4/Agent/freellmapi/server/src/db/migrations.ts`
- `/vol4/Agent/freellmapi/server/src/providers/index.ts`
- `/vol4/Agent/freellmapi/FREE_MODEL_SPEED_TEST.md`

直接复制其中 Kilo/LLM7 的：

- model ID
- context window
- keyless、匿名限额和隐私风险注释
- 已失效、付费化、错误模型映射的删除原因

目标位置：

- `packages/core/src/config.ts` 的手动 provider 模型目录
- Free Auto 候选目录
- README 风险说明

不要复制 SQLite migration、key sentinel 或加密 key 存储逻辑。`deepicode` 没有该数据库架构，keyless provider 直接通过 provider capability 表达。

### C. 429 惩罚与成功恢复

源文件：

- `/vol4/Agent/freellmapi/server/src/services/router.ts`

直接复制并改名适配：

- `rateLimitPenalties`
- `recordRateLimitHit()`
- `recordSuccess()`
- `getPenalty()`
- `PENALTY_PER_429`
- `MAX_PENALTY`
- `DECAY_INTERVAL_MS`
- `DECAY_AMOUNT`

目标位置：

- `packages/core/src/free-auto/router.ts`

首版不需要复制 `freellmapi` 的数据库统计、Thompson Sampling、SQLite 查询或 API key round-robin。Free Auto 候选很少，使用复制来的动态 penalty 加上固定基础优先级即可。

### D. 冷却算法

源文件：

- `/vol4/Agent/freellmapi/server/src/services/ratelimit.ts`

直接复制并适配：

- `cooldowns`
- `cooldownHits`
- `COOLDOWN_DURATIONS`
- `getNextCooldownDuration()`
- `TRANSIENT_COOLDOWN_MS`
- `PAYMENT_REQUIRED_COOLDOWN_MS`

目标位置：

- `packages/core/src/free-auto/cooldown.ts`，或并入 `free-auto/router.ts`

适配要求：

- 去掉 `keyId` 维度，改为 `provider:model`；匿名额度重点增加 provider 级 cooldown。
- 去掉数据库持久化、RPD/TPD 查询。
- `429` 优先设置 provider 级短冷却；`402` 设置模型/供应商长冷却。

### E. 故障转移错误分类

源文件：

- `/vol4/Agent/freellmapi/server/src/routes/proxy.ts`

复制该文件中判断可回退 HTTP 状态和 provider 错误的规则，不复制 Express route、数据库日志和响应 header 代码。

目标位置：

- `packages/core/src/free-auto/router.ts` 的 `isRetryableBeforeOutput()`。

必须保留 `deepicode` 特有保护：流已经产生文本、reasoning 或 tool call 后，禁止跨 provider 重放。

## 3. Provider 与模型目录

### 3.1 Kilo

- Provider ID：`kilo`
- Label：`Kilo (Free)`
- Base URL：`https://api.kilo.ai/api/gateway/v1`
- `requiresKey: false`
- 使用空字符串 API Key，客户端不得为 keyless provider 发送 `Authorization` header。

默认只加入已验证可正常输出文本的模型：

| 模型 | 用途 | 默认启用 |
|---|---|---|
| `nvidia/nemotron-3-super-120b-a12b:free` | 通用文本、Free Auto 兜底 | 是 |

以下模型不要加入首版默认路由：

- `nvidia/nemotron-3-ultra-550b-a55b:free`：60 秒超时。
- `poolside/laguna-m.1:free`：测试为空响应。
- `poolside/laguna-xs.2:free`、`stepfun/step-3.7-flash:free`、`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`：小 `max_tokens` 下只返回 reasoning，当前客户端/Agent 流程存在空最终文本风险。
- content-safety 模型：不是聊天模型。

### 3.2 LLM7

- Provider ID：`llm7`
- Label：`LLM7 (Free)`
- Base URL：`https://api.llm7.io/v1`
- `requiresKey: false`
- 使用空字符串 API Key，客户端不得发送 `Authorization` header。

加入：

| 模型 | 用途 | 默认启用 |
|---|---|---|
| `qwen3-235b` | 通用任务、复杂任务首选 | 是 |
| `mistral-small-3.2` | 通用快速备用 | 是 |
| `codestral-latest` | 编码任务首选 | 是 |
| `devstral-small-2:24b` | 手动可选，Free Auto 禁用 | 否（路由层） |

LLM7 Pro 模型不得加入免费目录。测速中它们均返回 `402 Upgrade required`。

### 3.3 Free Auto

- Provider ID：`free-auto`
- Label：`Free Auto`
- 虚拟模型 ID：`free-auto`
- `requiresKey: false`
- 不存在真实 Base URL；不得直接把虚拟模型发送给上游。
- 配置加载、持久化和 `/model` 选择应把它当作普通 provider 展示。

首版候选池：

1. `llm7/codestral-latest`
2. `llm7/qwen3-235b`
3. `llm7/mistral-small-3.2`
4. `kilo/nvidia/nemotron-3-super-120b-a12b:free`

## 4. Free Auto 路由行为

### 4.1 决策原则

路由必须完全本地执行，不额外调用 LLM。

首版使用确定性规则：

- 请求携带工具定义，或用户输入明显属于编码、调试、重构任务：优先 `codestral-latest`。
- 普通复杂任务、长输入、多文件上下文：优先 `qwen3-235b`。
- 简单问答或前两个模型暂时不可用：优先 `mistral-small-3.2`。
- LLM7 限速或故障：回退 Kilo Nemotron Super。

不要仅依赖关键词判断。路由输入至少包括：

- 是否携带 tools。
- 当前轮消息数量和估算输入长度。
- 当前 submit 中的工具调用轮数。
- 候选模型近期健康状态。
- provider/model 冷却状态。

### 4.2 粘性与切换边界

- 同一个 `submit()` 的整个工具调用循环应优先粘在同一候选模型上。
- 只有当前候选明确失败时，才在下一次尚未成功的 API 请求上切换。
- 已经收到任何文本、reasoning 或 tool call delta 后，不得自动重放到另一 provider，避免重复工具调用和重复副作用。
- 新的用户 `submit()` 可以重新评分并选择更合适模型。

### 4.3 串行故障转移

禁止并行请求多个免费 provider。

可故障转移：

- HTTP `402`、`408`、`429`、`500`、`502`、`503`、`504`
- 连接错误、DNS/TLS 错误
- 首字节前超时
- 在没有产生任何有效事件时结束或返回空响应

不可故障转移：

- HTTP `400`：通常是请求或工具 schema 不兼容，应直接暴露错误。
- HTTP `401`、`403`：配置或上游策略变化，应标记候选不可用并暴露明确错误。
- 用户主动 abort。
- 已产生有效流事件后的中断。

### 4.4 限速和冷却

实现进程内轻量状态，不引入数据库：

```ts
interface FreeRouteHealth {
  consecutiveFailures: number
  cooldownUntil: number
  lastLatencyMs?: number
  lastSuccessAt?: number
}
```

建议冷却：

- `429`：该 provider 全局冷却 60 秒；LLM7 的匿名额度是 provider 共享额度，不能只冷却单模型。
- `402/401/403`：进程生命周期内禁用该候选，直到重启。
- `5xx`/网络错误/首字节超时：指数冷却 10 秒、30 秒、120 秒。
- 成功后清零连续失败，并记录延迟供同优先级候选排序。

不要在首版精确模拟上游每小时额度；真实 `429` 和冷却足以形成可靠闭环。

## 5. 复制移植后的实现边界

### 5.1 新增独立路由模块，但主体从 freellmapi 移植

建议新增：

- `packages/core/src/free-auto/catalog.ts`
  - 从 `freellmapi` migrations/provider 注册复制候选定义、能力、base URL、模型 ID；补充 `deepicode` 所需基础优先级。
- `packages/core/src/free-auto/router.ts`
  - 从 `freellmapi/services/router.ts` 复制 429 penalty；从 `ratelimit.ts` 复制 cooldown；从 `routes/proxy.ts` 复制可回退错误分类。
- `packages/core/src/free-auto/client.ts`
  - 只新写薄包装：选择候选、调用通用 OpenAI-compatible client、在输出前失败时选择下一候选。

不要把路由逻辑塞进 `config.ts`、TUI 或 `DeepSeekClient`。

### 5.2 ChatClient 与 Engine

实施 Agent 应先消除 `loop.ts` 对具体 `DeepSeekClient` 类型的依赖：

- 将 `LoopOptions.client` 改为 `ChatClient`。
- 保持现有自定义 client 注入测试继续工作。
- 在 `engine.ts` 增加 client 解析逻辑：普通 provider 使用现有客户端；`free-auto` 使用 `FreeAutoClient`。
- `/model` 运行时切换到或离开 `free-auto` 后，下一次 `submit()` 必须使用正确 client。不要只在 Engine 构造时选择一次。

为避免大范围重构，现有 `DeepSeekClient` 类名首版可以保留。优先把 `freellmapi/OpenAICompatProvider` 的 keyless、timeout 和 SSE 健壮性逻辑移植进现有 client，不要另写第二套完整 HTTP/SSE client。

### 5.3 Keyless Authorization

现有客户端无条件发送：

```ts
Authorization: `Bearer ${opts.apiKey}`
```

必须增加显式能力字段，例如 `keyless: boolean`，命名和行为优先沿用 `freellmapi BaseProvider.keyless`。

- Kilo、LLM7、Free Auto 候选：`keyless: true`。
- Zen 的 `public` 行为保持不变。
- 其他 provider 保持 bearer。

不要通过“API Key 为空就不发 Authorization”隐式推断。直接复制 `freellmapi` 的 `authHeader()` 行为：`keyless` 时返回空 header，否则发送 bearer。

### 5.4 事件与可观测性

Free Auto 每次选择或故障转移时发出状态事件，至少包含：

```ts
{
  role: "status",
  content: "free_auto_route",
  metadata: {
    provider,
    model,
    reason,
    attempt
  }
}
```

故障转移事件不得泄露完整上游响应或敏感 header。

状态栏在 `free-auto` 模式下应显示实际路由模型，而不只是静态 `free-auto`。可通过 bridge 消费状态事件更新一个 `routedModel` 展示字段；不要把实际候选持久化成用户配置，否则会失去自动路由模式。

## 6. 文件级实施清单

### 6.1 复制来源到目标的映射

| freellmapi 源码 | deepicode 目标 | 操作 |
|---|---|---|
| `server/src/providers/base.ts` 的 timeout/SSE 逻辑 | `packages/core/src/client.ts` 或 `openai-compat-client.ts` | 复制主体，适配事件类型和外部 AbortSignal |
| `server/src/providers/openai-compat.ts` 的 `keyless`/`authHeader`/请求构造 | `packages/core/src/client.ts` | 复制主体，保留现有 tool call 聚合 |
| `server/src/providers/index.ts` 的 Kilo/LLM7 配置 | `packages/core/src/config.ts`、`free-auto/catalog.ts` | 直接复制配置值和风险注释 |
| `server/src/db/migrations.ts` 的 Kilo/LLM7 model rows | `config.ts`、`free-auto/catalog.ts` | 复制仍被测速确认的 model ID/context；不复制 DB 代码 |
| `server/src/services/router.ts` 的 penalty 函数 | `free-auto/router.ts` | 直接复制并把 modelDbId 改成 route key |
| `server/src/services/ratelimit.ts` 的 cooldown 函数 | `free-auto/router.ts` 或 `cooldown.ts` | 直接复制，去掉 DB/keyId |
| `server/src/routes/proxy.ts` 的 retryable 错误判断 | `free-auto/router.ts` | 复制判断规则，增加“流已开始不可回退” |
| `server/src/scripts/test-all-models.ts` 的最小 probe 思路 | 手工 smoke test 或独立脚本 | 复制请求模式，适配 deepicode client |

### 6.2 deepicode 必须新写的薄适配

以下内容是两个项目架构不同，无法直接复制：

- `FreeAutoClient` 到 `ChatClient` 的事件适配。
- Engine 每次 `submit()` 根据当前 provider 选择普通 client 或 Free Auto wrapper。
- submit 内粘性状态，确保工具循环不无故换模型。
- TUI `/model`、bridge、状态栏实际路由模型展示。
- Free Auto 本地任务分类规则。

预计修改：

- `packages/core/src/config.ts`
  - 增加 Kilo、LLM7、Free Auto provider 和模型元数据。
  - 增加认证模式、是否虚拟 provider 等必要字段。
  - 扩展 project `api-key` 文件 provider 名称扫描列表，或改为从 `PROVIDERS` 动态生成。
- `packages/core/src/interface.ts`
  - 保持/完善通用 `ChatClient` 类型。
- `packages/core/src/client.ts`
  - 移植 `freellmapi` 的 keyless、timeout、异常 EOF/SSE stall 逻辑。
  - 暴露足够的结构化错误信息，供 Free Auto 判断是否可回退。
- `packages/core/src/loop.ts`
  - 使用 `ChatClient` 类型。
  - 传递 provider/auth/路由所需信息。
- `packages/core/src/engine.ts`
  - 根据每次 submit 的当前 provider 解析 client。
- `packages/core/src/free-auto/catalog.ts`（新增）
- `packages/core/src/free-auto/router.ts`（新增）
- `packages/core/src/free-auto/client.ts`（新增）
- `packages/core/src/index.ts`
  - 导出必要类型和配置。
- `packages/tui/src/ModelPicker.tsx`
  - 加入 `free-auto`、`kilo`、`llm7`；最好从集中配置推导顺序，避免再次硬编码遗漏。
- `packages/tui/src/bridge.tsx`、`packages/tui/src/App.tsx`、`packages/tui/src/StatusBar.tsx`
  - 展示 Free Auto 的实际路由模型与切换状态。
- `README.md`、`README.en.md`
  - 说明匿名免费 provider、限速、隐私和稳定性风险。

不要修改 `/vol4/Agent/freellmapi`。

## 7. 测试要求

### 7.1 单元测试

新增或扩展：

- `packages/core/__tests__/config.test.ts`
  - Kilo、LLM7、Free Auto 配置、默认模型、context window、keyless auth。
  - 环境变量和 `last-config` 恢复。
- `packages/core/__tests__/free-auto-router.test.ts`
  - tools/编码任务选择 Codestral。
  - 普通任务选择 Qwen。
  - `429` 后跳过整个 LLM7 provider。
  - `5xx` 后按候选回退。
  - `400`、abort 和流已开始后的失败不回退。
  - submit 内粘性；新 submit 重新评分。
- `packages/core/__tests__/free-auto-client.test.ts`
  - 使用 mock SSE server，验证不同 base URL/model。
  - 验证 Kilo、LLM7 请求不带 Authorization。
  - 验证状态事件和实际路由元数据。
- TUI 测试
  - `/model` 可选三个新 provider。
  - Free Auto 状态栏显示实际路由但持久化仍为 `free-auto`。

所有网络测试必须 mock；默认测试套件不能依赖真实免费 API。

### 7.2 手工烟雾测试

单元测试通过后，最多使用极少量真实请求验证：

1. 手动选择 `llm7/qwen3-235b`，完成简单文本请求。
2. 手动选择 `kilo/nvidia/nemotron-3-super-120b-a12b:free`，完成简单文本请求。
3. 选择 `free-auto`，执行一个普通问答，确认状态显示实际模型。
4. 执行一个只读编码分析任务，确认优先路由到 Codestral。
5. 用 mock 或受控错误验证 `429` 回退；不要为了制造真实限速而大量请求上游。

## 8. 验收标准

- `/model` 中可选择 Kilo、LLM7 和 Free Auto。
- Kilo、LLM7 匿名请求不发送 Authorization header。
- Kilo 与 LLM7 手动模式可正常流式文本和工具调用。
- Free Auto 不把 `free-auto` 虚拟模型发送给上游。
- Free Auto 按规则选择候选，遇到可恢复错误时串行回退。
- 已开始输出后不会重放请求。
- 同一工具循环保持模型粘性，避免 provider 无故切换。
- 状态栏能看到实际 provider/model 和回退提示。
- 未验证 reasoning 模型、空响应模型、慢模型不进入默认 Free Auto 路由。
- `bun test` 与 `bun run typecheck` 通过。
- 不覆盖工作区中已有的用户修改。

## 9. 实施顺序

1. 建立复制记录：逐项列出要从 `freellmapi` 移植的函数/代码块。
2. 复制 Kilo/LLM7 provider 配置、model ID、context 和风险注释到 `deepicode` 配置。
3. 复制 `keyless/authHeader` 与 SSE/timeout 健壮性逻辑到现有 client，完成配置/client 单元测试。
4. 将 `loop.ts` 的 client 类型改为通用 `ChatClient`，确保现有测试仍通过。
5. 从 `freellmapi` 复制 penalty、cooldown 和 retryable-error 判断，做最少类型适配。
6. 只新写 Free Auto 薄包装、任务分类和 submit 粘性。
7. 接入 Engine、ModelPicker、bridge 和状态栏。
8. 更新中英文文档。
9. 运行完整测试与 typecheck。
10. 最后执行低请求量真实烟雾测试，并在实施报告中记录绝对日期、模型、HTTP 状态和耗时。

## 10. 实施 Agent 最终报告格式

实施完成后必须汇报：

- 修改文件列表。
- 从 `freellmapi` 复制的函数/代码块清单，以及每项适配内容。
- 必须新写而不能复制的代码及原因。
- 路由规则和故障转移规则摘要。
- 测试命令及结果。
- 真实烟雾测试结果，或未执行原因。
- 仍存在的风险，尤其是免费模型变更、匿名限速、提示/输出可能被上游记录，以及跨 provider 工具调用兼容性。
