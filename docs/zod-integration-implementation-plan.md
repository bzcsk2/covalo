# Deepicode Zod 4 集成实施方案

> 供实施 Agent 使用。本文定义“Deepicode 支持 Zod”的首版范围和实施步骤，不代表功能已经完成。

## 0. 目标定义

“支持 Zod”首版定义为：

1. 插件作者可以使用 Zod 4 schema 声明插件工具参数。
2. Deepicode 使用 Zod 4 官方公开 API 自动生成发给 LLM 的 JSON Schema。
3. 插件工具执行前，Deepicode 使用同一个 schema 验证并转换模型生成的参数。
4. Deepicode 的高风险外部配置边界使用 Zod 校验，替换裸 `JSON.parse(...) as Type` 和分散手工校验。
5. 保持现有 JSON Schema 工具与旧插件完全兼容。

首版不包括：

- 不把全部内置工具参数一次性改写成 Zod。
- 不使用 Zod 验证每一个 SSE chunk、JSON-RPC 消息或 session JSONL 记录。
- 不复制整个 Zod 仓库到 Deepicode。
- 不使用实验性的 `z.fromJSONSchema()` 作为核心运行路径。

## 1. 总原则：依赖官方包，复用源码模式，不复制整库

Zod 源码位于：

- `/vol4/Agent/zod`
- 实际包：`/vol4/Agent/zod/packages/zod`
- 当前版本：`4.4.3`
- License：MIT

Deepicode 应添加正式依赖：

```json
"zod": "4.4.3"
```

开发验证时可把 `/vol4/Agent/zod/packages/zod` 作为源码参考和测试 oracle，但最终 Deepicode 不应依赖绝对路径 `/vol4/Agent/zod`，否则项目离开当前机器后无法安装。

优先使用 Zod 官方公开 API：

- `z.safeParse()` / `schema.safeParse()`
- `schema.safeParseAsync()`
- `z.toJSONSchema(schema, { io: "input" })`
- `z.prettifyError(error)`
- `z.infer<typeof Schema>`
- Standard Schema 的 `schema["~standard"]`

禁止继续依赖 Zod 私有字段：

- `_def.typeName`
- `_def.shape`
- `_def.innerType`
- `_def.values`

复制 Zod 源码示例或测试模式时，保留来源说明并遵守 MIT License。

## 2. 已确认的 Deepicode 现状

### 2.1 插件层已有未完成的 Zod 适配

文件：`packages/plugin/src/tool-adapter.ts`

现有问题：

- 定义了私有 `ZodSchema` 接口并直接读取 `_def`。
- `convertZodToJsonSchema()` 只支持 string、number、boolean、enum、object、optional、array。
- Zod 4 内部结构与该实现不兼容。
- `convertZodToJsonSchema()` 当前实际上没有接入插件工具提取流程。
- 插件的 `server()` 当前只允许返回函数，无法正式声明工具 description/schema。
- 插件工具执行前不验证参数。

这是首版集成的最高优先级。

### 2.2 工具核心只接受 JSON Schema

文件：

- `packages/core/src/interface.ts`
- `packages/core/src/types.ts`
- `packages/core/src/streaming-executor.ts`

`AgentTool.parameters` 和 `ToolSpec.function.parameters` 当前都是 JSON Schema。该 wire contract 应保持不变，因为 LLM provider 接收的是 JSON Schema，不是 Zod 实例。

正确边界：

```text
插件 Zod schema
  -> z.toJSONSchema(..., { io: "input" })
  -> 现有 ToolSpec JSON Schema
  -> LLM

模型返回 args
  -> JSON.parse / repair
  -> Zod safeParseAsync
  -> 插件 execute(validatedArgs)
```

### 2.3 高风险裸 JSON 配置边界

适合首版迁移：

- `packages/plugin/src/config.ts`
- `packages/mcp/src/host.ts`
- `packages/mcp/src/auth.ts`
- `packages/tui/src/settings.ts`
- `packages/tui/src/i18n/persist.ts`
- `packages/core/src/config.ts` 中的 `.deepicode/last-config.json`
- `packages/core/src/runtime-logger.ts` 的日志配置
- `packages/core/src/context/policy-store.ts`

暂不迁移：

- `packages/core/src/client.ts` 的 SSE JSON：高频、上游 shape 宽松，当前 parser 已有容错。
- `packages/mcp/src/client.ts` 的 JSON-RPC 行：协议层需要单独设计完整 schema。
- `packages/core/src/session.ts` 的 JSONL：需要兼容历史记录和部分损坏恢复。
- TUI 中只用于展示的 `JSON.parse`。

## 3. 插件 Zod 工具契约

### 3.1 保持旧插件兼容

现有插件仍可返回普通函数：

```ts
server: () => ({
  greet: (args) => `Hello ${args.name}`,
})
```

行为保持：

- 自动注册为插件工具。
- 参数 schema 仍为 `{ type: "object", properties: {} }`。
- 不做 Zod 参数验证。

### 3.2 新增 schema-aware 插件工具

建议新增公开 helper：

```ts
import { definePluginTool } from "@deepicode/plugin"
import { z } from "zod"

const inputSchema = z.object({
  name: z.string().min(1).describe("Name to greet"),
  excited: z.boolean().default(false),
}).strict()

export default {
  id: "hello",
  server: () => ({
    greet: definePluginTool({
      description: "Greet a user",
      inputSchema,
      async execute(args) {
        return args.excited ? `Hello ${args.name}!` : `Hello ${args.name}`
      },
    }),
  }),
}
```

`definePluginTool()` 应返回带元数据的可调用函数，使 `PluginHooks` 仍然保持“所有 hook 值都是 function”的现有契约，避免重写 loader 和 hook registry。

建议类型：

```ts
interface StandardSchemaLike {
  readonly "~standard": {
    validate(value: unknown): unknown | Promise<unknown>
    jsonSchema?: {
      input(options?: unknown): Record<string, unknown>
    }
  }
}

interface SchemaAwarePluginTool<TInput = unknown, TOutput = unknown> {
  (args: TInput): TOutput | Promise<TOutput>
  deepicodeTool: {
    description: string
    inputSchema: StandardSchemaLike
  }
}
```

优先采用 Standard Schema 形状作为插件运行时契约，而不是把 `ZodType` 写死到公共接口。这样首版正式支持 Zod 4，同时未来可兼容其他实现 Standard Schema 的验证库。

## 4. Zod 到 JSON Schema

### 4.1 删除私有字段转换器

删除 `packages/plugin/src/tool-adapter.ts` 中：

- `ZodSchema` 私有接口
- `zodType()`
- `zodEnumValues()`
- `zodShape()`
- `zodInnerType()`
- `convertZodToJsonSchema()`

替换为公开 API：

```ts
const parameters = z.toJSONSchema(inputSchema, {
  io: "input",
  target: "draft-07",
  unrepresentable: "any",
})
```

为什么使用 `io: "input"`：

- 工具参数描述的是调用者需要传入的结构，不是 transform/default 后的输出结构。

为什么使用 `draft-07`：

- OpenAI-compatible provider 对 Draft 2020-12 关键字支持不一致。

为什么 `unrepresentable: "any"`：

- 插件加载不应因单个不可表示 refinement/transform 让整个应用崩溃。
- 同时必须记录 `invalid_schema` warning，提醒插件作者 schema 降级。

### 4.2 Standard Schema 优先路径

如果 schema 提供：

```ts
schema["~standard"].jsonSchema.input({ target: "draft-07" })
```

优先调用该公开能力。Zod 4 源码已经为 Standard Schema 提供 JSON Schema input/output 支持。

若插件明确传入 Zod 4 schema，但 Standard JSON Schema 方法不可用，可使用 `z.toJSONSchema()` 作为 Zod 专用回退。

不要再读取 `_def`。

## 5. 执行前参数验证

插件 schema-aware 工具执行前必须验证参数：

1. `streaming-executor` 继续负责 JSON parse/repair、权限和调度。
2. `executePluginTool()` 或插件工具 wrapper 调用 `inputSchema["~standard"].validate(args)`。
3. 验证失败时：
   - 不调用插件业务函数。
   - 返回结构化工具错误。
   - 错误消息包含字段路径和简洁原因。
   - 不输出 schema 内部对象或敏感输入全文。
4. 验证成功时，将 Zod 转换后的输出传给插件函数。

转换后的输出很重要，例如：

- `.default()` 应注入默认值。
- `.trim()` 应传递裁剪后的字符串。
- `.transform()` 如果插件明确使用，应把转换结果传给 execute；JSON Schema 仅描述输入形状。

错误格式建议：

```json
{
  "error": "Invalid tool arguments",
  "issues": [
    { "path": "name", "message": "Too small: expected string to have >=1 characters" }
  ]
}
```

## 6. 配置验证迁移

### 6.1 建议新增共享 schema 模块

建议新增：

- `packages/core/src/schemas/json.ts`
  - 通用 `parseJsonWithSchema()`、错误格式化 helper。
- 各 package 就近维护自己的 schema：
  - `packages/plugin/src/schemas.ts`
  - `packages/mcp/src/schemas.ts`
  - `packages/tui/src/settings-schema.ts`

不要建立一个包含所有 package 配置的巨型 schema 文件。

### 6.2 迁移顺序

第一批：

1. 插件配置 `plugins.json`
2. MCP 配置 `mcp.json`
3. MCP auth store
4. TUI settings 和语言设置
5. last-config

第二批：

6. runtime logger 配置
7. context policy store

每次迁移必须保持当前容错语义：

- 可选配置文件不存在时返回默认值，不报致命错误。
- JSON 语法错误与 schema 错误应区分。
- 单个错误配置项尽量不阻止其他有效项加载。
- auth store 校验失败不得泄露 API key。

## 7. 依赖和包边界

推荐依赖放置：

- `packages/plugin/package.json`：`zod: "4.4.3"`，用于 Zod 专用回退和 helper 类型推断。
- 需要直接定义 schema 的 package 各自声明 `zod` 依赖：
  - `packages/core`
  - `packages/mcp`
  - `packages/tui`

不要只把 Zod 放在根 `package.json` 后依赖 workspace hoisting；每个实际 import Zod 的 package 必须显式声明依赖。

更新 `bun.lock`，但不得覆盖当前工作区内其他 agent 已完成的 Free Auto 变更。

## 8. 源码参考与复制映射

| Zod 源码/文档 | Deepicode 目标 | 用法 |
|---|---|---|
| `packages/zod/src/index.ts`、`v4/classic/external.ts` | package imports | 使用公开 `z`、`toJSONSchema`、`prettifyError` |
| `packages/docs/content/json-schema.mdx` | plugin tool adapter | 复制官方 `toJSONSchema` 使用模式，不复制内部 generator |
| `packages/zod/src/v4/classic/tests/to-json-schema.test.ts` | plugin tests | 参考 object/default/optional/enum/union/refinement 测试矩阵 |
| `packages/zod/src/v4/classic/tests/standard-schema.test.ts` | plugin schema adapter tests | 参考 `~standard.validate` 和 `~standard.jsonSchema.input` |
| `packages/zod/src/v4/core/standard-schema.ts` | plugin public types | 参考最小结构，避免依赖 Zod 私有字段 |
| `packages/zod/src/v4/locales/zh-CN.ts` | 可选错误本地化 | 仅在现有语言设置可稳定控制全局 locale 时使用 |

不要复制：

- Zod parser、schema class、JSON Schema generator 实现。
- Zod tests 全量快照。
- Zod build、pnpm workspace 或发布配置。

## 9. 文件级修改清单

预计新增：

- `packages/plugin/src/define-tool.ts`
- `packages/plugin/src/schema-adapter.ts`
- `packages/plugin/__tests__/zod-tool.test.ts`
- `packages/plugin/__tests__/schema-adapter.test.ts`
- `packages/plugin/src/schemas.ts`
- `packages/mcp/src/schemas.ts`
- `packages/tui/src/settings-schema.ts`
- 可选：`packages/core/src/schemas/json.ts`

预计修改：

- `packages/plugin/package.json`
- `packages/plugin/src/index.ts`
- `packages/plugin/src/loader.ts`
- `packages/plugin/src/tool-adapter.ts`
- `packages/plugin/src/runtime.ts`
- `packages/plugin/__tests__/tool-adapter.test.ts`
- `packages/core/package.json`
- `packages/core/src/config.ts`
- `packages/mcp/package.json`
- `packages/mcp/src/host.ts`
- `packages/mcp/src/auth.ts`
- `packages/tui/package.json`
- `packages/tui/src/settings.ts`
- `packages/tui/src/i18n/persist.ts`
- `README.md`
- `README.en.md`
- `bun.lock`

首版不应修改：

- `/vol4/Agent/zod`
- `packages/core/src/client.ts`
- `packages/core/src/session.ts`
- 大多数 `packages/tools/src/*.ts`

## 10. 测试要求

### 10.1 插件 Zod 支持

必须覆盖：

- Zod object schema 转换成 Draft-07 JSON Schema。
- required、optional、default、enum、array、union、nested object。
- `.describe()` / metadata 进入 JSON Schema。
- `io: "input"` 对 default/transform 输入形状正确。
- schema-aware 工具验证成功后执行。
- default、trim、transform 后的值传入 execute。
- 验证失败时 execute 不被调用。
- 异步 refinement 使用异步验证。
- 不可表示 schema 降级并产生明确 warning。
- 普通旧插件函数行为不变。
- 不再访问 `_def`。

### 10.2 配置验证

必须覆盖：

- 文件不存在。
- malformed JSON。
- JSON 合法但 schema 错误。
- 未知字段策略。
- 部分有效、部分无效插件项。
- MCP auth 无效数据不泄露密钥。
- 旧版合法配置仍可加载。

### 10.3 回归

运行：

```bash
bun test
bun run typecheck
```

并确认：

- 已完成的 Kilo、LLM7、Free Auto 功能测试继续通过。
- Plugin、MCP、TUI 配置的旧行为保持兼容。
- prefix-cache 中的工具 JSON Schema 保持稳定排序，不因 Zod metadata 顺序导致每轮变化。

## 11. 验收标准

- 插件可通过 `definePluginTool({ inputSchema: z.object(...), ... })` 注册工具。
- 模型收到由 Zod 4 官方 API生成的 JSON Schema。
- 插件执行前参数经过同一 schema 验证和转换。
- Zod 验证失败不会执行插件。
- 旧插件无需修改即可继续工作。
- `tool-adapter.ts` 不再读取 Zod `_def`。
- 高风险配置文件使用 Zod schema 验证并保留原容错行为。
- 不复制整个 Zod 实现，不依赖 `/vol4/Agent/zod` 绝对路径。
- `bun test` 与 `bun run typecheck` 通过。
- 不覆盖当前工作区已有修改。

## 12. 实施顺序

1. 添加各 package 的 Zod 4.4.3 显式依赖，更新 lockfile。
2. 新增 `definePluginTool()` 和 Standard Schema 最小类型。
3. 用 Standard Schema/Zod 公开 API替换私有 `_def` 转换器。
4. 为 schema-aware 插件工具加入执行前异步验证。
5. 完成插件兼容性和 JSON Schema 测试。
6. 按迁移顺序接入插件、MCP、TUI、core 配置验证。
7. 更新中英文 README，加入插件 Zod 示例。
8. 运行完整测试和 typecheck。

## 13. 实施 Agent 最终报告格式

实施完成后必须汇报：

- 修改文件列表。
- 使用的 Zod 版本和依赖位置。
- 使用了哪些 Zod 公开 API。
- 删除了哪些私有 `_def` 访问。
- 插件工具契约与向后兼容策略。
- 已迁移的配置边界和暂未迁移原因。
- 测试命令及结果。
- 当前工作区已有修改如何被保留。
