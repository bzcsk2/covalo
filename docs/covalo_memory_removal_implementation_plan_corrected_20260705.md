# Covalo `@covalo/memory` 移除实施方案（校正版）

> 项目：`bzcsk2/covalo`  
> 目标：彻底移除 `@covalo/memory` 包及其运行时集成点，同时保留 ExperienceStore、harness-evolution、Plugin、MCP、TUI、Workflow、Session/checkpoint 等现有能力。  
> 适用版本：当前 `main` 分支，根 `package.json` 版本 `0.1.3`。  
> 结论：原计划方向基本正确，但存在漏项和少量不精确点。本方案已按当前代码结构修正。

---

## 1. 核对结论

原计划的核心判断是正确的：Covalo 当前同时存在两个容易混淆的“memory”概念：

| 名称 | 位置 | 性质 | 本次处理 |
|---|---|---|---|
| `@covalo/memory` | `packages/memory/` | 独立 workspace 包；提供 AgentMemory/向量检索/记忆工具/记忆桥接/hooks | **删除** |
| ExperienceStore / experience recall | `packages/core/src/harness-evolution/experience/` 及 `engine.ts` 中的 `injectExperienceRecall()` | harness-evolution 失败经验召回系统 | **保留** |

必须强调：本次不是删除所有包含 `memory` 字样的代码，而是删除 `@covalo/memory` 这个独立包及其 CLI/TUI 集成。

---

## 2. 对原计划的主要修正

### 2.1 修改文件数量应上调

原计划写“5 个文件修改 + ~100 文件删除”，但它自身列出的修改文件已经超过 5 个。按当前仓库实际情况，建议按以下范围执行：

| 类型 | 文件/目录 | 处理 |
|---|---|---|
| 代码 | `packages/cli/src/tui.ts` | 删除 memory 初始化、工具注册、hook、prompt 注入、TUI/pipe 参数传递 |
| 代码 | `packages/tui/src/App.tsx` | 删除 `onUserInput`、`beforeSubmit` props |
| 代码 | `packages/tui/src/bridge.tsx` | 删除 memory 观察回调、`beforeSubmit` 等桥接参数；建议同步删除 `observeInput` 死参数 |
| 配置 | `packages/cli/package.json` | 删除 `@covalo/memory` workspace 依赖 |
| 配置 | `tsconfig.json` | 删除 `@covalo/memory` path alias |
| 配置 | 根 `package.json` | 删除 memory 测试脚本，修正 `test:all` |
| 目录 | `packages/memory/` | 删除整个 workspace 包 |
| 测试 | `packages/cli/src/__tests__/memory-integration.test.ts` | 删除 memory 集成测试 |
| lockfile | `bun.lock` | 运行 `bun install` 后提交更新 |
| lockfile | `pnpm-lock.yaml` | 若仓库继续保留该文件，检查并同步；否则会留下过期依赖信息 |
| 文档 | `README.md`、`README.zh.md` | 删除或改写 AgentMemory、`packages/memory`、memory tools 等公开说明 |

文档更新是原计划最大漏项。当前 README/中文 README 仍把 memory 作为公开能力、工具和架构包描述；如果代码删除但文档保留，会形成明显的项目状态不一致。

### 2.2 `bridge.tsx` 中 `observeInput` 也应清理

原计划只删除 `onUserInput` 调用点，但 `observeInput` 本身就是为了控制 memory 观察行为的选项。删除 memory 后，它不再有运行时意义。建议同步删除：

- `QueuedSubmit.options.observeInput`
- `submitAndCollect(... options?: { ... observeInput?: boolean })`
- 所有调用方传入的 `observeInput: false`

如果实际仓库中仍有调用方传递 `observeInput`，按 TypeScript 报错逐处删除该字段即可，不应保留一个无效参数。

### 2.3 验证命令应使用项目现有脚本

原计划使用 `npx tsc --noEmit`，可行但不够贴合项目。当前根 `package.json` 已提供：

```bash
bun run typecheck
bun run test
bun run build
```

建议以这些脚本作为主验证命令，并补充 `node ./dist/index.js --help`、`npm pack --dry-run`，因为 CI 和发布链路都依赖它们。

### 2.4 不要把所有 `memory` 字样当作残留错误

以下内容必须保留，即使名称中有 `memory`：

| 位置 | 保留原因 |
|---|---|
| `packages/core/src/engine.ts` 的 `injectExperienceRecall()` | ExperienceStore 召回，不属于 `@covalo/memory` |
| `packages/core/src/context/scratch.ts` 的 `experience_recall` | ExperienceStore 上下文源 |
| `packages/core/src/harness-evolution/**` 中的 `memory-recall-policy` | harness-evolution surface 名称，不是 memory 包依赖 |
| `packages/core/src/checkpoint-engine.ts` 的 `resetMemory()` | 检查点/运行时状态重置方法名 |
| `packages/core/src/config/schema.ts` 的 `storage: z.enum(["memory", "jsonl"])` | session 存储模式枚举，不是 `@covalo/memory` |
| `packages/tools/src/tools/monitor.ts` 的 `sampleMemory()` | 系统 RAM 采样 |
| 与 `Reclaim memory`、`memory usage`、`totalmem/freemem` 相关内容 | 系统内存/RAM 语义 |

---

## 3. 推荐执行顺序

### Step 0：建立独立分支并记录基线

```bash
git checkout -b remove-covalo-memory
bun install
bun run typecheck
bun run test
bun run build
```

如果基线不通过，先记录失败项，不要把既有失败误判为本次删除引入。

---

## 4. 代码修改方案

### Step 1：修改 `packages/cli/src/tui.ts`

这是核心改动文件。当前 `tui.ts` 中 `@covalo/memory` 负责四类事情：

1. 动态导入 memory 包；
2. 初始化 `MemoryService` 与 `DeepreefMemoryBridge`；
3. 向 system prompt 注入 `<covalo-memory-context>`；
4. 注册 memory hooks 与 7 个 memory tools。

这些全部删除。

#### 1.1 删除 `ToolCallHooks` import 与 memory 注释

删除：

```ts
import type { ToolCallHooks } from "@covalo/security"
// P1-4: Memory is dynamically imported when enabled to avoid loading when COVALO_MEMORY=false
```

#### 1.2 删除 `memoryContextPrompt`

删除：

```ts
let memoryContextPrompt = ""
```

并把 `rebuildBaseSystemPrompt()` 从：

```ts
return [
  buildSystemPrompt(process.cwd(), {
    osPlatform: platform,
    shellBackend: `${shellBackend.id} (${shellBackend.executable})`,
    locale,
  }),
  pluginRulesPrompt,
  memoryContextPrompt,
].filter(Boolean).join("\n\n")
```

改为：

```ts
return [
  buildSystemPrompt(process.cwd(), {
    osPlatform: platform,
    shellBackend: `${shellBackend.id} (${shellBackend.executable})`,
    locale,
  }),
  pluginRulesPrompt,
].filter(Boolean).join("\n\n")
```

#### 1.3 删除 memory 初始化块

删除从以下注释开始的整段：

```ts
// Memory is fully background-loaded and never gates the first model request.
```

直到 `memoryReady = deferTask(...)` 完整闭合为止。该块内的以下变量和逻辑全部删除：

```ts
memoryService
memoryBridge
memoryHookAdapter
enableMemory
memoryReady
MemoryService
DeepreefMemoryBridge
COVALO_MEMORY*
createMemoryRecallTool
createMemorySaveTool
createMemorySmartSearchTool
createMemoryForgetTool
createMemoryTimelineTool
createMemoryStatusTool
createMemoryMigrateTool
```

#### 1.4 修改 pipe 模式启动等待

从：

```ts
if (!input.isTTY) {
  await Promise.all([pluginReady, memoryReady])
  await runPipeMode(engine, memoryBridge)
  return
}
```

改为：

```ts
if (!input.isTTY) {
  await pluginReady
  await runPipeMode(engine)
  return
}
```

#### 1.5 修改 TUI 模式启动等待

从：

```ts
await Promise.all([pluginReady, memoryReady])
```

改为：

```ts
await pluginReady
```

说明：`beforeSubmit` 原本只是再次等待 `pluginReady`，但进入 `runTUIMode()` 前已经等待过 `pluginReady`，因此删除 `beforeSubmit` 不会造成首轮提交缺工具。

#### 1.6 修改 `runTUIMode()` 调用

从：

```ts
await runTUIMode(
  engine,
  config,
  pluginRuntime,
  mcpConfigCount,
  () => memoryBridge,
  () => pluginReady,
  memoryReady,
  dualRuntime,
  workflowCoordinator,
  { os: platform, shell: shellBackend.id, shellBackend: `${shellBackend.id} (${shellBackend.executable})` },
  rebuildBaseSystemPrompt,
)
```

改为：

```ts
await runTUIMode(
  engine,
  config,
  pluginRuntime,
  mcpConfigCount,
  dualRuntime,
  workflowCoordinator,
  { os: platform, shell: shellBackend.id, shellBackend: `${shellBackend.id} (${shellBackend.executable})` },
  rebuildBaseSystemPrompt,
)
```

#### 1.7 修改 `finally` 清理块

从清理流程中删除：

```ts
memoryReady
memoryBridge?.onSessionEnd(...)
engine.hookManager.removeHooks(memoryHookAdapter)
memoryService?.stop()
```

推荐最终结构：

```ts
} finally {
  await pluginReady.catch(() => {})
  // P3-3: Drain all pending hook observations before cleanup
  await engine.hookManager.drain().catch(() => {})
  // LIFE-01: close engine (tokenizer worker, logger, session writer)
  await engine.shutdown()
  // P3: plugin runtime 现在是 async dispose，会派发 onShutdown hooks
  await pluginRuntime.dispose()
  // Wait for background MCP load to settle before disconnecting (best-effort, 2s cap)
  await Promise.race([mcpLoadPromise, new Promise<void>(r => setTimeout(r, 2000))])
  await mcpHost.disconnectAll()
  // Phase 2: dispose LSP pool — shutdown all server processes
  await lspPool.disposeAll().catch(() => {})
}
```

#### 1.8 修改 `runPipeMode()`

从：

```ts
async function runPipeMode(engine: ReasonixEngine, memoryBridge?: import("@covalo/memory").DeepreefMemoryBridge): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(Buffer.from(chunk))
  const prompt = Buffer.concat(chunks).toString("utf8").trim()
  if (!prompt) return
  // P0-2: Observe user prompt at the real entry point (before engine.submit)
  if (memoryBridge) {
    await memoryBridge.onPromptSubmit(engine.getSessionId(), prompt).catch(() => {})
  }
  for await (const event of engine.submit(prompt)) {
```

改为：

```ts
async function runPipeMode(engine: ReasonixEngine): Promise<void> {
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(Buffer.from(chunk))
  const prompt = Buffer.concat(chunks).toString("utf8").trim()
  if (!prompt) return
  for await (const event of engine.submit(prompt)) {
```

#### 1.9 修改 `runTUIMode()` 签名

从：

```ts
async function runTUIMode(
  engine: ReasonixEngine,
  config: ReturnType<typeof loadConfig>,
  pluginRuntime: PluginRuntime,
  mcpConfigCount: number = 0,
  getMemoryBridge?: () => import("@covalo/memory").DeepreefMemoryBridge | undefined,
  beforeSubmit?: () => Promise<void>,
  memoryReady?: Promise<void>,
  dualRuntime?: DualAgentRuntime,
  workflowCoordinator?: WorkflowCoordinator,
  platformInfo?: { os: string; shell: string; shellBackend: string },
  rebuildBaseSystemPrompt?: (locale?: import("@covalo/core").PromptLocale) => string,
): Promise<void> {
```

改为：

```ts
async function runTUIMode(
  engine: ReasonixEngine,
  config: ReturnType<typeof loadConfig>,
  pluginRuntime: PluginRuntime,
  mcpConfigCount: number = 0,
  dualRuntime?: DualAgentRuntime,
  workflowCoordinator?: WorkflowCoordinator,
  platformInfo?: { os: string; shell: string; shellBackend: string },
  rebuildBaseSystemPrompt?: (locale?: import("@covalo/core").PromptLocale) => string,
): Promise<void> {
```

注意：原计划中展示的旧签名有一处 `platformInfo?: { os: string; shell: shellBackend: string }` 写法不符合当前代码；当前代码实际是 `shell: string; shellBackend: string`。

#### 1.10 删除 `onUserInput` 回调与 App props

删除：

```ts
// P0-2: Provide onUserInput callback so bridge can observe user prompts at the real entry point
const onUserInput = (text: string) => {
  void (memoryReady ?? Promise.resolve()).then(() =>
    getMemoryBridge?.()?.onPromptSubmit(engine.getSessionId(), text),
  ).catch(() => {})
}
```

并把 `React.createElement(App, { ... })` 中的：

```ts
onUserInput,
beforeSubmit,
```

删除。

---

### Step 2：修改 `packages/tui/src/App.tsx`

#### 2.1 删除 `AppProps` 中的 memory/submit 等待 props

删除：

```ts
onUserInput?: (text: string) => void;
beforeSubmit?: () => Promise<void>;
```

#### 2.2 修改 `App()` 解构参数

从：

```ts
export function App({ engine, config, pluginCount = 0, contentPackCount = 0, assetCounts, diagnosticCounts, onUserInput, beforeSubmit, dualRuntime, workflowCoordinator, onPromptLocaleChange }: AppProps) {
```

改为：

```ts
export function App({ engine, config, pluginCount = 0, contentPackCount = 0, assetCounts, diagnosticCounts, dualRuntime, workflowCoordinator, onPromptLocaleChange }: AppProps) {
```

#### 2.3 修改 `createBridge()` 调用

从：

```ts
const bridge = useMemo(() => createBridge(engine, setBridgeState, onUserInput, beforeSubmit, orchestrationStore, dualRuntime, workflowCoordinator), [engine, onUserInput, beforeSubmit, orchestrationStore, dualRuntime, workflowCoordinator]);
```

改为：

```ts
const bridge = useMemo(() => createBridge(engine, setBridgeState, orchestrationStore, dualRuntime, workflowCoordinator), [engine, orchestrationStore, dualRuntime, workflowCoordinator]);
```

---

### Step 3：修改 `packages/tui/src/bridge.tsx`

#### 3.1 修改 `createBridge()` 签名

从：

```ts
export function createBridge(
  engine: ReasonixEngine,
  setState: React.Dispatch<React.SetStateAction<BridgeState>>,
  onUserInput?: (text: string) => void,
  beforeSubmit?: () => Promise<void>,
  orchestrationStore?: import('./store/orchestration-store.js').OrchestrationStore,
  dualRuntime?: DualAgentRuntime,
  workflowCoordinator?: WorkflowCoordinator,
)
```

改为：

```ts
export function createBridge(
  engine: ReasonixEngine,
  setState: React.Dispatch<React.SetStateAction<BridgeState>>,
  orchestrationStore?: import('./store/orchestration-store.js').OrchestrationStore,
  dualRuntime?: DualAgentRuntime,
  workflowCoordinator?: WorkflowCoordinator,
)
```

#### 3.2 删除 `onUserInput` 调用点

删除 `enqueueOrRun()` 中的：

```ts
// P0-2: Observe on first successful acceptance
if (!item.isQueueResubmit && item.options?.observeInput !== false) {
  onUserInput?.(item.text);
}
```

删除 `submitInternalCore()` 开头的：

```ts
// P0-2: Observe fresh user input (not queue re-submissions)
if (!isQueueResubmit && options?.observeInput !== false) {
  onUserInput?.(text);
}
```

#### 3.3 删除 `beforeSubmit` 调用点

删除：

```ts
await beforeSubmit?.();
```

#### 3.4 删除 `observeInput` 死参数

把 `QueuedSubmit` 中的：

```ts
options?: { displayText?: string; signal?: AbortSignal; observeInput?: boolean; collectFinalText?: boolean }
```

改为：

```ts
options?: { displayText?: string; signal?: AbortSignal; collectFinalText?: boolean }
```

把 `submitAndCollect()` 参数中的：

```ts
options?: { displayText?: string; signal?: AbortSignal; observeInput?: boolean },
```

改为：

```ts
options?: { displayText?: string; signal?: AbortSignal },
```

然后全仓搜索并删除所有调用方里的：

```ts
observeInput: false
observeInput: true
```

如果某个调用方只是传入 `{ observeInput: false }`，可直接删除整个 options 对象；如果还传入了 `displayText` 或 `signal`，只删除 `observeInput` 字段。

---

### Step 4：修改 `packages/cli/package.json`

删除依赖：

```json
"@covalo/memory": "workspace:*",
```

注意逗号合法性，确保前后 JSON 仍可解析。

---

### Step 5：修改根 `tsconfig.json`

删除 path alias：

```json
"@covalo/memory": ["./packages/memory/src/index.ts"],
"@covalo/memory/*": ["./packages/memory/src/*"],
```

---

### Step 6：修改根 `package.json`

当前脚本应从：

```json
"test:all": "bun run test && cd packages/memory && bun run test",
"test:memory": "cd packages/memory && bun run test",
"test:memory-native": "bun test packages/cli/src/__tests__/memory-integration.test.ts"
```

改为：

```json
"test:all": "bun run test"
```

并删除：

```json
"test:memory"
"test:memory-native"
```

注意 JSON 逗号位置。

---

### Step 7：删除 `packages/memory/`

```bash
rm -rf packages/memory
```

Windows PowerShell：

```powershell
Remove-Item -Recurse -Force "packages/memory"
```

该目录下的 `package.json`、`src/`、`__tests__/`、`LICENSE.agentmemory`、`NOTICE.md` 等随目录一并删除。

---

### Step 8：删除 memory 集成测试

```bash
rm -f packages/cli/src/__tests__/memory-integration.test.ts
```

Windows PowerShell：

```powershell
Remove-Item -Force "packages/cli/src/__tests__/memory-integration.test.ts"
```

---

### Step 9：更新 lockfile

项目主包管理器是 Bun，必须更新 `bun.lock`：

```bash
bun install
```

仓库中同时存在 `pnpm-lock.yaml`。建议二选一：

方案 A，继续保留 `pnpm-lock.yaml`：

```bash
pnpm install --lockfile-only
```

方案 B，明确项目只使用 Bun：删除 `pnpm-lock.yaml`，但这属于额外项目治理决策，不建议混入本次变更，除非维护者明确同意。

本次推荐方案：保留并同步 `pnpm-lock.yaml`，避免仓库内出现过期锁文件。

---

## 5. 文档修改方案

### Step 10：修改 `README.md`

删除或改写以下内容：

- `30+ built-in tools ... memory ...`
- `Skills, MCP, plugin/content-pack, and AgentMemory integration`
- `packages/memory -> AgentMemory integration and memory tools`
- `memory operations`
- `### AgentMemory` 小节

建议替换方向：

```md
Covalo is a TypeScript/Bun CLI and TUI agent runtime with:
  * a cache-aware agent loop optimized for low-cost model usage
  * a Supervisor / Worker workflow for long-running engineering tasks
  * adjustable harness levels for weak, local, or unreliable models
  * a terminal UI built with Ink and React
  * built-in tools for file operations, search, editing, shell, web, tasks, workflow, MCP, and notebooks
  * Skills, MCP, and plugin/content-pack integration
  * deny-first permission handling for shell commands and file modifications
  * session persistence and recovery for interrupted work
```

架构列表中删除：

```text
packages/memory    -> AgentMemory integration and memory tools
```

工具列表中把：

```md
* memory operations
```

删除。

如需保留“经验召回”描述，必须明确写成 harness-evolution 的 ExperienceStore，而不是 AgentMemory 或 `@covalo/memory`。

---

### Step 11：修改 `README.zh.md`

删除或改写以下内容：

- `AgentMemory 集成和记忆工具`
- `packages/memory -> AgentMemory 集成和 memory tools`
- 任何把 memory 作为内置工具、公开能力、架构包的描述

建议把“完整生态”改成：

```md
### 🧩 完整生态

- 内置工具：文件、Shell、搜索、编辑、Web、MCP、Cron、Workflow、Notebook、Task 等。
- Skills 系统：按任务自动注入领域知识。
- MCP 支持：通过 JSON-RPC 2.0 / stdio 接入外部工具。
- Plugin / content-pack 支持。
- Session 持久化、检查点与 harness-evolution 经验召回。
```

架构列表删除：

```text
packages/memory    -> AgentMemory 集成和 memory tools
```

---

## 6. 不应修改的文件与代码

以下内容不是 `@covalo/memory` 包集成点，不应因名称包含 memory 而删除：

| 文件/目录 | 保留内容 |
|---|---|
| `packages/core/src/engine.ts` | `injectExperienceRecall()` |
| `packages/core/src/context/scratch.ts` | `experience_recall` source |
| `packages/core/src/harness-evolution/experience/` | ExperienceStore 实现 |
| `packages/core/src/harness-evolution/surfaces/surface-store.ts` | `memory-recall-policy` surface |
| `packages/core/src/harness-evolution/self-harness/patch-proposer.ts` | `memory-recall-policy` 引用 |
| `packages/core/src/harness-evolution/self-harness/patch-schema.ts` | `memory-recall-policy` 枚举 |
| `packages/core/src/harness-evolution/self-harness/promotion-gate.ts` | `memory-recall-policy` 引用 |
| `packages/core/src/checkpoint-engine.ts` | `resetMemory()` |
| `packages/core/src/config/schema.ts` | `storage: z.enum(["memory", "jsonl"])` |
| `packages/tools/src/tools/monitor.ts` | `sampleMemory()`，系统 RAM 采样 |
| `packages/core/src/result-persistence.ts` | `Reclaim memory count` 注释，系统内存语义 |
| `.github/workflows/ci.yml` | `Monitor: memory via Node os`，系统内存/RAM 检查 |

---

## 7. 残留扫描

优先使用 `rg`。Windows PowerShell、Git Bash、WSL 均可使用。

### 7.1 不应再出现的 hard dependency

```bash
rg -n "@covalo/memory|DeepreefMemoryBridge|MemoryService|createMemory(Recall|Save|SmartSearch|Forget|Timeline|Status|Migrate)Tool" . \
  -g '!node_modules' \
  -g '!dist'
```

期望：零结果。

### 7.2 不应再出现的 memory 环境变量

```bash
rg -n "COVALO_MEMORY(_AUTO_OBSERVE|_INJECT_CONTEXT|_ADVANCED|_GRAPH|_CONSOLIDATE|_REFLECT|_SLOTS)?" . \
  -g '!node_modules' \
  -g '!dist'
```

期望：零结果。

### 7.3 不应再出现的桥接变量

```bash
rg -n "memoryBridge|memoryService|memoryHookAdapter|memoryReady|enableMemory|onUserInput|beforeSubmit|observeInput" packages \
  -g '!node_modules' \
  -g '!dist'
```

期望：零结果。

### 7.4 memory 工具名不应再出现

```bash
rg -n "memory_recall|memory_save|memory_smart_search|memory_forget|memory_timeline|memory_status|memory_migrate" . \
  -g '!node_modules' \
  -g '!dist'
```

期望：零结果。

### 7.5 允许存在的 memory 字样

以下扫描可能仍有结果，逐项确认即可，不要求零结果：

```bash
rg -n "memory" packages/core packages/tools .github README.md README.zh.md \
  -g '!node_modules' \
  -g '!dist'
```

允许命中：ExperienceStore、`memory-recall-policy`、RAM/system memory、`storage: ["memory", "jsonl"]` 等。

---

## 8. 验证流程

### 8.1 类型检查

```bash
bun run typecheck
```

必须通过。

常见错误及处理：

| 错误 | 原因 | 处理 |
|---|---|---|
| `Cannot find module '@covalo/memory'` | 仍有 import 或动态 import 残留 | 按 7.1 扫描删除 |
| `Cannot find name 'ToolCallHooks'` | `tui.ts` 中 hook adapter 未删干净 | 删除 memory hook 代码 |
| `Property 'onUserInput' does not exist on type 'AppProps'` | `App` props 未同步 | 修正 `tui.ts` / `App.tsx` |
| `Expected 5-7 arguments, but got ...` | `createBridge()` 签名与调用不一致 | 同步 `App.tsx` / `bridge.tsx` |
| `Object literal may only specify known properties, and 'observeInput' does not exist` | 调用方仍传入 memory 观察控制字段 | 删除调用方的 `observeInput` |

### 8.2 测试

```bash
bun run test
```

必须通过。

如果 CI 仍跑 `packages/cli/__tests__`，确认 `memory-integration.test.ts` 已删除，否则它会继续动态导入 `@covalo/memory`。

### 8.3 构建与 smoke test

```bash
bun run build
node ./dist/index.js --help
```

必须通过。

### 8.4 本地运行验证

Pipe 模式：

```bash
echo "hello" | node ./dist/index.js
```

TUI 模式：

```bash
node ./dist/index.js
```

期望：

- 不再输出 `[covalo] Memory initialized`
- 不再输出 `[covalo] Memory init skipped: ...`
- `/help` 正常
- `/status` 正常
- `/workflow` 正常进入 Supervisor / Worker 流程
- MCP 工具仍可列出和调用
- Plugin/content-pack 仍可加载
- 工具列表中不再出现：
  - `memory_recall`
  - `memory_save`
  - `memory_smart_search`
  - `memory_forget`
  - `memory_timeline`
  - `memory_status`
  - `memory_migrate`

### 8.5 发布前检查

```bash
npm pack --dry-run
```

确认包内不包含：

- `packages/memory`
- memory docs 残留
- `@covalo/memory` 依赖

---

## 9. Git diff 检查清单

执行：

```bash
git status --short
git diff --stat
```

期望变更大致包括：

```text
M  packages/cli/src/tui.ts
M  packages/tui/src/App.tsx
M  packages/tui/src/bridge.tsx
M  packages/cli/package.json
M  package.json
M  tsconfig.json
M  bun.lock
M  pnpm-lock.yaml              # 若保留 pnpm lockfile
M  README.md
M  README.zh.md
D  packages/cli/src/__tests__/memory-integration.test.ts
D  packages/memory/**
```

确认没有以下非预期变更：

```bash
git diff -- packages/core/src/harness-evolution/experience/
git diff -- packages/core/src/engine.ts
git diff -- packages/core/src/context/scratch.ts
git diff -- packages/core/src/harness-evolution/surfaces/surface-store.ts
```

除非你主动做了与本次无关的改动，上述 diff 应为空。

---

## 10. 影响评估

### 10.1 用户可见功能变化

删除以下 memory 工具：

| 工具 | 删除原因 |
|---|---|
| `memory_recall` | 由 `@covalo/memory` 提供 |
| `memory_save` | 由 `@covalo/memory` 提供 |
| `memory_smart_search` | 由 `@covalo/memory` 提供 |
| `memory_forget` | 由 `@covalo/memory` 提供 |
| `memory_timeline` | 由 `@covalo/memory` 提供 |
| `memory_status` | 由 `@covalo/memory` 提供 |
| `memory_migrate` | 由 `@covalo/memory` 提供 |

### 10.2 System Prompt 变化

删除：

```xml
<covalo-memory-context>
...
</covalo-memory-context>
```

预期效果：

- system prompt 更稳定；
- token 占用降低；
- 不再依赖记忆服务启动和召回结果；
- 不影响 plugin rules prompt、locale prompt、mode prompt、skills prompt。

### 10.3 HookManager 变化

删除 memory 注册的：

- `afterToolCall`
- `onLoopEvent`

PluginRuntime 使用同一个 `engine.hookManager`，但它由 `PluginRuntime({ hookManager: engine.hookManager })` 独立注册和释放，不受本次删除影响。

### 10.4 环境变量变化

以下环境变量不再被读取，可从 `.env`、README、开发文档、部署文档中删除：

| 环境变量 | 原用途 |
|---|---|
| `COVALO_MEMORY` | memory 总开关 |
| `COVALO_MEMORY_AUTO_OBSERVE` | 自动观察工具调用 |
| `COVALO_MEMORY_INJECT_CONTEXT` | 注入 memory context |
| `COVALO_MEMORY_ADVANCED` | 高级 memory tools |
| `COVALO_MEMORY_GRAPH` | 图谱 memory |
| `COVALO_MEMORY_CONSOLIDATE` | memory 整合 |
| `COVALO_MEMORY_REFLECT` | memory 反思 |
| `COVALO_MEMORY_SLOTS` | slot memory |

### 10.5 不受影响的系统

- PluginRuntime
- content-pack
- MCP host 与 MCP proxy tools
- WorkflowCoordinator
- DualAgentRuntime
- SessionLoader / session recovery
- checkpoint engine
- ExperienceStore / harness-evolution experience recall
- task ledger scratch context
- LSP client pool
- shell/file/edit/search/web/notebook/task/workflow tools

---

## 11. 回滚方案

如果移除后出现不可接受问题：

```bash
git checkout -- \
  packages/cli/src/tui.ts \
  packages/tui/src/App.tsx \
  packages/tui/src/bridge.tsx \
  packages/cli/package.json \
  package.json \
  tsconfig.json \
  bun.lock \
  pnpm-lock.yaml \
  README.md \
  README.zh.md

git checkout -- packages/cli/src/__tests__/memory-integration.test.ts
git checkout -- packages/memory
bun install
```

然后重新执行：

```bash
bun run typecheck
bun run test
bun run build
```

---

## 12. 最终执行清单

```text
1. 建分支：remove-covalo-memory
2. 修改 packages/cli/src/tui.ts，删除 memory 初始化、prompt 注入、hooks、tools、清理逻辑
3. 修改 packages/tui/src/App.tsx，删除 onUserInput/beforeSubmit props
4. 修改 packages/tui/src/bridge.tsx，删除 onUserInput/beforeSubmit/observeInput
5. 修改 packages/cli/package.json，删除 @covalo/memory 依赖
6. 修改 tsconfig.json，删除 @covalo/memory paths
7. 修改根 package.json，删除 memory 测试脚本并修正 test:all
8. 删除 packages/memory/
9. 删除 packages/cli/src/__tests__/memory-integration.test.ts
10. 更新 bun.lock；同步检查 pnpm-lock.yaml
11. 更新 README.md 与 README.zh.md，删除 AgentMemory / packages/memory / memory tools 描述
12. 运行 rg 残留扫描
13. 运行 bun run typecheck
14. 运行 bun run test
15. 运行 bun run build
16. 运行 node ./dist/index.js --help
17. 运行 pipe/TUI smoke test
18. 确认 ExperienceStore 和 harness-evolution 未被误改
```

---

## 13. 一句话验收标准

本次变更完成后，仓库中不应再存在任何 `@covalo/memory` 包、导入、工具注册、环境变量读取、memory bridge/hook、AgentMemory 文档承诺或 memory 集成测试；但 ExperienceStore、`experience_recall`、`memory-recall-policy`、系统 RAM 监控和 session/checkpoint 内部状态语义必须完整保留。
