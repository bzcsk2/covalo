# AgentMemory 原生集成验收问题与测试分流

更新时间：2026-06-09

## 1. 验收结论

当前 `packages/memory` 已具备可运行的基础能力：

- `MemoryService` 可以启动和停止。
- `MemoryStore` 可以持久化 JSON 状态。
- `memory_save` 和 `memory_recall` 已通过真实读写烟测。
- `packages/memory` 独立 typecheck 和根项目 typecheck 均通过。
- CLI 已注册 6 个 memory 工具，并在退出时停止 MemoryService。

但当前实现不满足 `docs/DONE.md` 中 Phase A-F 全部完成的声明。生产接线、工具注册、高级配置和测试门禁仍有阻断问题。

本轮实测结果：

```text
packages/memory 独立 typecheck: 通过
根项目 typecheck:              通过
memory 定向测试:               71 pass / 5 fail
memory 全量测试:               767 pass / 470 fail / 21 errors
真实 memory_save:              通过
真实 memory_recall:            通过
真实 memory_status:            失败
```

## 2. 必须修复的生产问题

### P0-1：Memory context 没有真正注入 Engine

位置：

- `packages/cli/src/tui.ts`

现状：

1. CLI 在 memory 初始化前调用 `engine.setSystemPrompt(baseSystemPrompt)`。
2. `mem::context` 返回内容后，仅修改本地变量 `baseSystemPrompt`。
3. 修改后没有再次调用 `engine.setSystemPrompt(baseSystemPrompt)`。

结果：`<deepreef-memory-context>` 实际不会进入模型 system prompt。

修复要求：

- memory context 追加完成后重新调用 `engine.setSystemPrompt(baseSystemPrompt)`。
- 增加测试，验证最终 Engine system prompt 包含 context 标记和正文。

### P0-2：Prompt 观察记录了助手输出，而不是用户输入

位置：

- `packages/cli/src/tui.ts`
- `packages/memory/src/bridge/deepreef-memory-bridge.ts`

现状：

- HookManager 的 `onLoopEvent` 检测 `assistant_delta`，随后调用 `onPromptSubmit()`。
- `assistant_delta` 是模型输出片段，不是用户 prompt。
- 一个回复会产生多个 delta，可能生成大量错误、重复观察记录。

修复要求：

- 在用户输入进入 `engine.submit(userInput)` 的真实入口调用 `onPromptSubmit()`。
- pipe mode、TUI submit 和排队输入需要采用同一条观察路径。
- 不得使用 `assistant_delta` 模拟用户 prompt。
- 添加测试，验证一次用户提交只产生一次 `prompt_submit` 观察，模型流式输出不会产生 `prompt_submit`。

### P0-3：`memory_status` 工具必然失败

位置：

- `packages/memory/src/tools.ts`
- `packages/memory/src/functions/diagnostics.ts`

现状：

- `memory_status` 调用 `mem::diagnostics`。
- 实际注册函数 ID 是 `mem::diagnose`。

实测错误：

```text
Function not found: mem::diagnostics
```

修复要求：

- 将工具调用改为 `mem::diagnose`，或统一重命名注册函数。
- 添加真实 `MemoryService.start()` 后执行 `memory_status` 的集成测试。

### P1-1：Session 生命周期接线不完整

位置：

- `packages/cli/src/tui.ts`
- `packages/memory/src/bridge/deepreef-memory-bridge.ts`

现状：

- CLI 退出时调用了 `onSessionEnd()`。
- 启动后没有调用 `onSessionStart()`。
- `onGenerationComplete()` 未接线。
- `onPreToolUse()` 未接线，DONE 已将其列为限制，但 Phase C 的“Session 生命周期已完成”描述仍不准确。

修复要求：

- MemoryService 启动成功后调用一次 `onSessionStart()`。
- 对每次生成完成事件调用 `onGenerationComplete()`。
- 明确决定是否接入 `beforeToolCall -> onPreToolUse()`；未接入前不得将完整生命周期标记为完成。
- 保存 HookManager adapter 引用，并在退出时注销，避免同进程重启后重复观察。

### P1-2：`MemoryServiceConfig` 高级开关未生效

位置：

- `packages/memory/src/memory-service.ts`
- `packages/cli/src/tui.ts`

现状：

- `MemoryServiceConfig` 声明了：
  - `autoObserve`
  - `injectContext`
  - `advancedTools`
  - `enableGraph`
  - `enableConsolidation`
  - `enableReflect`
  - `enableSlots`
- 构造函数只读取 `dataDir`，其余字段全部丢弃。
- CLI 虽传入 `DEEPREEF_MEMORY_*` 环境变量结果，但不会改变 MemoryService 行为。
- 高级工具也没有根据 `advancedTools` 注册。

修复要求：

- MemoryService 保存并消费完整 `MemoryServiceConfig`。
- 配置优先级需明确：显式构造参数应高于旧 `AGENTMEMORY_*` 环境变量。
- `advancedTools` 为 true 时注册经过确认的高级 AgentTool；false 时不得注册。
- 为每个开关添加启用和禁用测试。

### P1-3：`memory_migrate` 没有接入生产 CLI

位置：

- `packages/memory/src/migrate.ts`
- `packages/memory/src/index.ts`
- `packages/cli/src/tui.ts`

现状：

- `createMemoryMigrateTool()` 已存在。
- 包入口没有导出该工具。
- CLI 没有注册该工具。
- `createMemoryMigrateTool(store)` 的 `store` 参数未使用。

修复要求：

- 导出并注册 `memory_migrate`，或者从 DONE 中删除“可从 CLI 触发”的声明。
- 删除无用参数，或使用传入 store 决定目标目录。
- 添加迁移工具端到端测试：源文件迁移、已存在文件跳过、缺少源目录时的错误行为。

### P1-4：`DEEPREEF_MEMORY=false` 不会完全避免加载 memory 包

位置：

- `packages/cli/src/tui.ts`

现状：

- `@deepreef/memory` 在文件顶部静态 import。
- 环境变量只能阻止初始化，不能阻止模块加载。

修复要求：

- 如果目标确实是“完全不加载 memory 包”，改为启用时动态 import。
- 如果只要求“不启动、不注册工具、不读写数据”，修改 DONE 描述，不要声称完全不加载。
- 添加禁用测试，验证不创建 `~/.deepreef/memory`、不注册 memory 工具、不启动 timer。

### P1-5：默认启动行为可能产生不必要副作用

现状：

- Memory 默认启用。
- 每次 CLI 启动都会创建数据目录、初始化索引和多个定时器。
- 没有 LLM key 时会向 stderr 输出较长的 `[agentmemory]` 警告。

修复要求：

- 明确默认启用策略。
- Deepreef 用户未主动配置 memory 时，不应输出上游 AgentMemory 品牌和 Claude-specific 提示。
- 将日志统一为 Deepreef 日志接口，避免直接写 stderr。

## 3. 必须保留并纳入门禁的测试

以下测试覆盖当前 Deepreef memory 生产能力，不能因为来自上游或当前失败而直接删除。

### 3.1 Deepreef 原生集成测试

需要新增独立测试文件，例如：

```text
packages/memory/test/deepreef-memory-service.test.ts
packages/memory/test/deepreef-memory-tools.test.ts
packages/memory/test/deepreef-memory-bridge.test.ts
packages/memory/test/deepreef-memory-migration.test.ts
packages/cli/src/__tests__/memory-integration.test.ts
```

必须覆盖：

- MemoryService start/stop 和重复调用行为。
- `memory_save -> memory_recall -> memory_forget` 完整流程。
- `memory_status` 可执行。
- BM25-only 模式无需 embedding 模型或 API key。
- context 实际进入 Engine system prompt。
- 用户 prompt 仅观察一次。
- tool success/failure 分别写入正确观察。
- session start/end 和 generation complete。
- `DEEPREEF_MEMORY=false`。
- 初始化失败不阻断 CLI。
- stop 后 timer、hook 和持久化资源全部清理。
- migration 工具。

### 3.2 Memory 核心能力测试

以下类型测试必须继续保留，失败时应修复实现或适配测试运行器：

- 存储和 schema：
  - `schema.test.ts`
  - `search-index.test.ts`
  - `index-persistence.test.ts`
  - `vector-index.test.ts`
  - `vector-index-populate.test.ts`
  - `vector-index-dimensions.test.ts`
- 基础记忆能力：
  - `remember-*.test.ts`
  - `search.test.ts`
  - `smart-search.test.ts`
  - `evict.test.ts`
  - `timeline.test.ts`
  - `context-lessons.test.ts`
  - `privacy.test.ts`
  - `retention*.test.ts`
  - `auto-forget.test.ts`
- 当前宣称支持的高级能力：
  - `graph*.test.ts`
  - `consolidation*.test.ts`
  - `reflect.test.ts`
  - `slots*.test.ts`
  - `mesh.test.ts`

如果高级能力不准备在 Deepreef 中支持，应删除对应生产代码和 DONE 声明，而不是保留实现后忽略失败测试。

### 3.3 测试框架不兼容不是跳过理由

大量测试因 Bun test 不支持部分 Vitest API 而失败，例如：

```text
vi.resetModules()
vi.mocked()
vi.stubGlobal()
vi.setSystemTime()
```

这些测试不能直接标记为“不适配，无需执行”。应选择一种方案：

1. 将 memory 上游测试继续使用 Vitest 运行。
2. 将相关测试改写为 Bun test 支持的 API。
3. 将测试分为 `bun test` 原生门禁和 `vitest` 上游兼容门禁。

## 4. 可以不纳入 Deepreef 默认门禁的上游测试

以下测试针对已明确不采用的 AgentMemory 独立产品表面。只要 Deepreef 不计划提供对应功能，可以移至 `packages/memory/test/upstream-legacy/`，或通过单独的 `test:upstream` 脚本运行，不应阻塞 Deepreef 默认 CI。

### 4.1 独立 REST/HTTP 服务

```text
integration.test.ts
integration-plaintext-http.test.ts
multi-instance-port.test.ts
```

原因：

- 要求 `http://localhost:3111` 上运行 AgentMemory 服务。
- Deepreef 当前采用进程内 `MemoryService`，不使用独立 REST 服务。

### 4.2 独立 MCP 服务和 MCP standalone

```text
mcp-env-placeholder.test.ts
mcp-prompts.test.ts
mcp-resources.test.ts
mcp-standalone-proxy.test.ts
mcp-standalone.test.ts
mcp-surface-default.test.ts
mcp-transport.test.ts
tool-count-consistency.test.ts
```

原因：

- Deepreef 当前暴露原生 AgentTool，不使用 AgentMemory 的 53 个 MCP 工具表面。
- 测试依赖已移除的 `src/cli.ts`、`src/mcp/standalone.ts` 或上游 README。

注意：如果未来重新启用 Memory MCP，这些测试必须恢复并适配，不能永久删除。

### 4.3 AgentMemory 独立 CLI、安装和接入脚本

```text
cli-connect.test.ts
cli-doctor-fixes.test.ts
cli-onboarding.test.ts
cli-remove.test.ts
connect-new-agents.test.ts
onboarding.test.ts
```

原因：

- Deepreef 不使用 AgentMemory 独立 CLI。
- 安装、doctor、connect 和 onboarding 应由 Deepreef 自己实现和测试。

### 4.4 其他 Agent/编辑器插件兼容测试

```text
claude-code-with-hooks.test.ts
codex-connect-hooks.test.ts
codex-plugin.test.ts
copilot-plugin.test.ts
hermes-plugin.test.ts
openclaw-plugin.test.ts
opencode-auto-context.test.ts
```

原因：

- 这些测试验证 AgentMemory 作为其他宿主插件时的安装文件和 hook 配置。
- Deepreef 当前只需要验证 `DeepreefMemoryBridge`。

`claude-bridge.test.ts` 和 `claude-bridge-path.test.ts` 是否保留，取决于是否继续支持 `loadClaudeBridgeConfig()`。若保留生产代码，则对应测试不能排除。

### 4.5 已被 DeepreefMemoryBridge 替代的独立 hook 脚本测试

```text
context-injection.test.ts
hook-project.test.ts
stop-hook-recursion-guard.test.ts
stop-worker-pidfile.test.ts
fs-watcher.test.ts
```

原因：

- 测试针对上游 `plugin/scripts/*.mjs` 和独立 hook 进程。
- DONE 已声明这些脚本被 `DeepreefMemoryBridge` 替代。

处理要求：

- 排除这些测试前，删除或明确隔离对应死代码。
- 使用 Deepreef 原生 bridge 测试替代，不能仅删除测试而不补覆盖。

### 4.6 Viewer 测试

```text
viewer-graph-cooldown.test.ts
viewer-host.test.ts
viewer-memories-sort.test.ts
viewer-security.test.ts
viewer-session-id.test.ts
```

原因：

- DONE 明确 Viewer 尚未接入 Deepreef。
- Viewer 不应进入当前原生 memory 默认门禁。

如果继续保留 viewer 源码，建议设立独立 `test:memory-viewer`，避免其状态与原生集成完成度混淆。

## 5. 条件执行的测试

以下测试不能简单删除，但不适合在无外部依赖的默认 CI 中强制执行。

### 5.1 外部 Provider

```text
agent-sdk-provider.test.ts
embedding-provider.test.ts
minimax-provider.test.ts
openai-shared.test.ts
fallback-chain.test.ts
fallback-model-resolution.test.ts
vision-search.test.ts
multimodal.test.ts
reranker.test.ts
```

建议：

- 默认 CI 运行 mock/noop/BM25-only 测试。
- 需要真实 SDK、模型或 embedding 的测试放入 `test:memory-providers`。
- 通过环境变量和依赖检测决定是否运行。

### 5.2 网络和分布式能力

```text
mesh.test.ts
team.test.ts
```

建议：

- 如果 `advancedTools` 默认关闭，可从默认快速门禁移入 `test:memory-advanced`。
- 启用 advanced 功能的发布门禁必须运行并通过。

### 5.3 文件系统和平台相关能力

```text
obsidian-export.test.ts
snapshot.test.ts
replay.test.ts
compress-file.test.ts
```

建议：

- 使用临时目录运行，不依赖用户真实 home。
- 不能因为涉及文件系统就直接跳过。

## 6. 建议的测试脚本和门禁

建议在 `packages/memory/package.json` 中拆分：

```json
{
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "bun test test/deepreef-*.test.ts test/remember-*.test.ts test/search.test.ts test/smart-search.test.ts test/evict.test.ts test/timeline.test.ts test/schema.test.ts test/search-index.test.ts test/index-persistence.test.ts",
    "test:core": "bun test <维护后的核心测试列表>",
    "test:advanced": "bun test <graph/consolidation/mesh/slots 等>",
    "test:upstream": "vitest run test/upstream-legacy",
    "test:providers": "vitest run <外部 provider 测试列表>"
  }
}
```

默认 Deepreef CI 最低要求：

```text
bun run typecheck
bun test packages/memory 的 Deepreef 原生测试
bun test packages/cli 的 memory 接线测试
根项目 bun test 不新增失败
```

## 7. DONE.md 修订要求

修复完成前，需要调整以下声明：

- Phase C 的 `mem::context 注入 system prompt` 不应标记完成。
- Phase C 的 `Session 生命周期` 不应标记完成。
- Phase D 的 `memory_status` 不应标记完成。
- Phase E 的高级开关和 `memory_migrate` CLI 工具不应标记完成。
- Phase F 的“稳定性验证完成”不成立。
- “`DEEPREEF_MEMORY=false` 禁用后完全不加载 memory 包”应改为“不会初始化 MemoryService”，除非改成动态 import。

最终验收不能只报告根项目测试数量。必须单独报告：

```text
memory native tests
memory core tests
memory advanced tests
memory upstream legacy tests
root project tests
```

## 8. 完成标准

满足以下条件后，AgentMemory 原生集成才可以标记完成：

1. P0 问题全部修复。
2. 6 个默认 memory 工具全部通过真实 MemoryService 测试。
3. Context、用户 prompt、session、tool 和 generation 生命周期接线测试通过。
4. 高级开关实际生效，或从当前完成范围中移除。
5. `memory_migrate` 实际接入，或从 DONE 中移除。
6. 默认测试门禁不包含明确废弃的上游表面，但所有 Deepreef 原生能力都有替代测试。
7. `packages/memory` typecheck、Deepreef memory native tests、memory core tests 和根项目测试门禁通过。
