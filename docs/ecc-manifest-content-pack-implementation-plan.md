# Deepicode Claude Code Plugin 协议兼容与 ECC 实施方案

> 供实施 Agent 使用。本文定义 Deepicode plugin 系统如何原生兼容 Claude Code Plugin 协议，并以 `/vol4/Agent/ECC` 作为首个完整兼容目标。本文是实施方案，不代表功能已经完成。

## 0.1 架构校正：以 Claude Code Plugin 协议为主标准

对照 `/vol4/Agent/best-claude-code` 源码后，确认 Claude Code plugin 本身就是 manifest 驱动的资源包插件系统，不是 Deepicode 当前的可执行 JS runtime plugin。

Claude Code 的核心实现参考：

- `src/types/plugin.ts`
- `src/utils/plugins/schemas.ts`
- `src/utils/plugins/pluginLoader.ts`
- `src/utils/plugins/loadPluginCommands.ts`
- `src/utils/plugins/loadPluginAgents.ts`
- `src/utils/plugins/loadPluginHooks.ts`
- `src/utils/plugins/mcpPluginIntegration.ts`
- `src/utils/plugins/lspPluginIntegration.ts`

Claude Code plugin 原生支持：

- `.claude-plugin/plugin.json`
- 根目录默认 `commands/`
- 根目录默认 `agents/`
- 根目录默认 `skills/`
- 根目录默认 `hooks/hooks.json`
- 根目录默认 `.mcp.json`
- manifest 中的额外 commands、agents、skills、hooks、MCP、LSP、output styles、settings 和 user config
- marketplace、安装缓存、启用/禁用、依赖、更新和插件信任边界

因此本文后续提到的“manifest 内容包插件”应理解为：

**Deepicode 对 Claude Code Plugin 协议的兼容实现。**

不要先发明一套与 Claude Code 不同的 Deepicode 内容包协议。Deepicode 专属 manifest 只能作为未来扩展，不能成为 ECC 接入的前置条件。

ECC 的标准 Claude plugin surface 可以由 Deepicode 按 Claude Code 规则直接发现。ECC 的以下能力属于 ECC 自身扩展层，不属于 Claude Code plugin 基础协议：

- `manifests/install-profiles.json`
- `manifests/install-modules.json`
- `manifests/install-components.json`
- `rules/`
- 跨 harness selective install

正确分层：

1. **基础层：Claude Code Plugin Compatibility**
   - 直接兼容 `.claude-plugin/plugin.json` 和标准目录自动发现。
2. **扩展层：ECC Selective Install Compatibility**
   - 可选解析 ECC profiles/modules/components/rules。
3. **遗留层：Deepicode Executable Module Plugin**
   - 保留当前 `id + server()` 插件，但不要把它称为 Claude Code plugin。

## 0. 结论和方向

推荐方案：

**改造 Deepicode 的 plugin 架构，让它原生兼容 Claude Code Plugin 协议；ECC 通过该协议直接接入。**

不要把 ECC 直接内置进 Deepicode 核心，也不要为 ECC 写一次性 wrapper 后结束。ECC 应作为兼容性样本和验收对象，而 Deepicode 获得的是通用内容包能力。

正确边界：

- Deepicode 核心继续负责 Engine、工具执行、安全 hook、MCP host、TUI。
- `@deepicode/plugin` 负责识别、解析、校验和汇总 Claude Code plugin manifest。
- ECC 原始仓库作为外部内容包被引用或安装，不复制整个仓库进 Deepicode。
- Skills、Agents、Rules、Hooks、MCP、Commands 通过统一 `ContentPack` 结构暴露给各消费方。

## 1. 总原则

1. **保留现有 executable module plugin 兼容性。**
   当前 `id + server() -> functions` 插件不能被破坏，但应在类型和文档中标记为 legacy/executable module plugin，避免与 Claude Code plugin 混淆。

2. **新增 Claude Code plugin 类型，而不是替换现有插件类型。**
   现有插件是 Deepicode 自定义可执行模块；ECC 使用的是 Claude Code manifest 插件协议。

3. **优先引用 ECC 源文件，避免复制 ECC 内容。**
   Skills、Agents、Rules 等应通过路径注册和按需读取实现；只有必要的适配逻辑写在 Deepicode。

4. **不要把 ECC 专用字段硬编码进基础兼容层。**
   基础层先对齐 Claude Code plugin；ECC profiles/modules/components 放在独立可选 adapter。

5. **默认安全、显式启用危险能力。**
   ECC hooks、MCP 中存在本地命令、`npx -y`、HTTP MCP、占位 token。默认不自动执行，不自动安装。

6. **按 profile/module/component 选择加载。**
   不要默认加载 ECC 全量 251 个 skills、63 个 agents、79 个 commands。

7. **保持包边界清晰，避免循环依赖。**
   `@deepicode/plugin` 可以产出内容包解析结果；`@deepicode/tools`、`@deepicode/core`、`@deepicode/mcp` 分别消费对应资产。

## 2. 已确认现状

### 2.1 Deepicode 当前 plugin 契约

当前 `@deepicode/plugin` 要求插件模块导出：

```ts
{
  id: string,
  server: () => Record<string, Function>
}
```

相关文件：

- `packages/plugin/src/config.ts`
- `packages/plugin/src/loader.ts`
- `packages/plugin/src/runtime.ts`
- `packages/plugin/src/tool-adapter.ts`
- `packages/plugin/src/hook-adapter.ts`

当前限制：

- npm 插件配置会被识别，但加载阶段直接报 `npm_plugin_not_installed`。
- 只有 `file` 插件可动态 import。
- `server()` 返回值的每个字段都必须是 function。
- 所有 function 都会被当作工具注册为 `<pluginId>.<key>`。
- 只有特殊函数名 `beforeToolCall`、`afterToolCall`、`onLoopEvent` 会被 hook registry 识别。
- 没有 manifest 内容包概念。

这套机制不是 Claude Code plugin。建议在实施中重命名概念：

| 当前名称 | 建议名称 | 含义 |
|---|---|---|
| runtime plugin | executable module plugin / legacy runtime plugin | Deepicode 自定义 JS/TS 模块，导出 `id` 和 `server()` |
| content-pack plugin | Claude Code plugin / manifest plugin | `.claude-plugin/plugin.json` + commands/agents/skills/hooks/MCP 资源包 |

两者的差异：

| 维度 | Deepicode 旧 runtime plugin | Claude Code plugin |
|---|---|---|
| 入口 | JS/TS module import | 插件目录 + `.claude-plugin/plugin.json` |
| 必需字段 | `id`、`server()` | `name`，其他资源可选 |
| 工具能力 | `server()` 返回的函数被注册为 tools | 通常不直接声明工具函数 |
| Commands | 不支持 | 支持 `commands/` 和 manifest `commands` |
| Agents | 不支持 | 支持 `agents/` 和 manifest `agents` |
| Skills | 不支持 | 支持 `skills/` 和 manifest `skills` |
| Hooks | 只识别 `beforeToolCall`/`afterToolCall`/`onLoopEvent` 函数 | 支持 Claude hook event + matcher + command/http/prompt/agent |
| MCP | 不支持 | 支持 `.mcp.json` 和 manifest `mcpServers` |
| ECC 兼容 | 不兼容 | ECC 的主要原生目标 |

### 2.2 Claude Code Plugin 协议要点

从 `/vol4/Agent/best-claude-code` 已确认：

- `createPluginFromPath()` 固定读取 `<pluginRoot>/.claude-plugin/plugin.json`。
- manifest 不存在时会创建最小 manifest，但 ECC 已提供 manifest。
- manifest 未声明资源时，会自动发现根目录下默认目录：
  - `commands/`
  - `agents/`
  - `skills/`
  - `output-styles/`
- hooks 会自动读取 `hooks/hooks.json`，manifest `hooks` 只用于额外 hook 文件或 inline hooks。
- MCP 会先读取插件根目录 `.mcp.json`，再读取 manifest `mcpServers`，后者优先级更高。
- plugin agents 会按 `pluginName:namespace:agentName` 命名空间化，避免覆盖本地 agent。
- plugin agent frontmatter 中的 `permissionMode`、`hooks`、`mcpServers` 会被忽略，避免单个 agent 文件绕过安装时信任边界。
- plugin commands 和 skills 会进入 Claude Code 的 command/skill 系统，而不是变成普通 function tool。

Deepicode 兼容时应优先复刻这些协议语义。

### 2.3 Deepicode 当前 Skills

相关文件：

- `packages/tools/src/skill-loader.ts`
- `packages/tools/src/skills/index.ts`

当前行为：

- 只读取 `packages/tools/src/skills` 目录。
- `Skill` 工具支持 `list`、`search`、`load`。
- `SKILL.md` frontmatter 读取 `name`、`description`、`when_to_use`、`tags`。

ECC 的 `skills/*/SKILL.md` 与该格式基本兼容，因此 Skills 是最容易接入的部分。

### 2.4 Deepicode 当前 Agents

相关文件：

- `packages/core/src/agent.ts`
- `packages/core/src/subagent/definition.ts`
- `packages/core/src/subagent/registry.ts`
- `packages/tui/src/commands.ts`

当前行为：

- 主 agent 只有静态 `build` 和 `plan`。
- TUI `/agent` 和 `/help` 直接读取静态 `AGENTS`。
- 没有从外部 markdown/frontmatter 注册 agent 的能力。

### 2.5 Deepicode 当前 MCP

相关文件：

- `packages/mcp/src/host.ts`

当前行为：

- 读取 `.deepicode/mcp.json`。
- 只支持 stdio MCP：`command`、`args`、`env`。
- 不支持 `type: "http"` / `url` transport。
- auth store 会注入 `MCP_API_KEY` 和 `DEEPICODE_MCP_API_KEY`。

ECC 的 stdio MCP 可以适配；HTTP MCP 首版只能识别并诊断，不能连接。

### 2.6 ECC 内容结构

ECC 路径：

- `/vol4/Agent/ECC`

关键文件：

- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`
- `manifests/install-profiles.json`
- `manifests/install-modules.json`
- `manifests/install-components.json`
- `schemas/plugin.schema.json`
- `schemas/hooks.schema.json`
- `schemas/install-profiles.schema.json`
- `schemas/install-modules.schema.json`
- `skills/*/SKILL.md`
- `agents/*.md`
- `commands/*.md`
- `rules/*`
- `hooks/hooks.json`
- `.opencode/plugins/ecc-hooks.ts`
- `mcp-configs/mcp-servers.json`
- `.mcp.json`

ECC 特点：

- 它是跨 Claude、Codex、OpenCode、Cursor、Gemini 等 harness 的内容发行仓库。
- `.codex-plugin/plugin.json` 声明 `skills`、`mcpServers` 和 UI metadata。
- `.claude-plugin/plugin.json` 声明 `skills`、`commands`、`mcpServers`。
- `manifests/install-*.json` 定义 profile、module、component 选择。
- `hooks/hooks.json` 是 Claude Code hook 风格，含大量 command/http/prompt/agent hooks。
- `.opencode/plugins/ecc-hooks.ts` 是 OpenCode 原生插件，依赖 `@opencode-ai/plugin`，不能直接用于 Deepicode。

## 3. 目标定义

首版目标是让 Deepicode 支持以下配置：

```json
[
  {
    "spec": "/vol4/Agent/ECC",
    "options": {
      "type": "content-pack",
      "profile": "developer",
      "target": "deepicode",
      "targetMode": "compatible",
      "include": ["baseline:workflow", "lang:typescript"],
      "exclude": ["baseline:hooks"],
      "hooks": {
        "enabled": false
      },
      "mcp": {
        "enabled": false
      }
    }
  }
]
```

Deepicode 应能：

1. 识别目录插件。
2. 自动发现 `.deepicode-plugin.json`、`.codex-plugin/plugin.json`、`.claude-plugin/plugin.json` 等 manifest。
3. 解析 ECC profile/module/component。
4. 将选中的 skills 注册到 `Skill` 工具。
5. 将选中的 agents 注册到 Deepicode agent registry。
6. 将选中的 rules 作为可控 system prompt 片段或 skill/rule 资产提供。
7. 将 stdio MCP 配置导入 MCP host 的候选配置。
8. 识别 hooks，但默认不执行危险 command hooks。
9. 给 TUI 和 status 暴露内容包加载状态、数量和诊断。

首版不要求：

- 不直接支持 HTTP MCP 连接。
- 不执行 ECC 全量 Claude command hooks。
- 不直接运行 `.opencode/plugins/ecc-hooks.ts`。
- 不实现 ECC installer、control pane、orchestration scripts。
- 不把 ECC commands 全量加入 TUI slash command 系统。
- 不复制 ECC 整个仓库到 Deepicode。

## 4. 新增统一数据模型

建议在 `packages/plugin/src/content-pack/` 下新增：

- `types.ts`
- `manifest-discovery.ts`
- `manifest-parser.ts`
- `ecc-install-manifest.ts`
- `resolver.ts`
- `diagnostics.ts`

建议核心类型：

```ts
export type PluginKind = "runtime" | "content-pack"

export interface ContentPackManifest {
  id: string
  name: string
  version?: string
  description?: string
  rootDir: string
  sourceManifestPath: string
  sourceKind: "deepicode" | "codex" | "claude" | "ecc"
  skills: string[]
  agents: string[]
  rules: string[]
  commands: string[]
  hooks?: string[]
  mcpServers?: string[]
  profiles?: ContentPackProfiles
  modules?: ContentPackModules
  components?: ContentPackComponents
  metadata?: Record<string, unknown>
}

export interface ResolvedContentPack {
  id: string
  name: string
  rootDir: string
  profile?: string
  modules: string[]
  components: string[]
  assets: {
    skills: ContentAsset[]
    agents: ContentAsset[]
    rules: ContentAsset[]
    commands: ContentAsset[]
    hooks: ContentAsset[]
    mcp: ContentAsset[]
  }
  diagnostics: ContentPackDiagnostic[]
}

export interface ContentAsset {
  kind: "skill" | "agent" | "rule" | "command" | "hook" | "mcp"
  id: string
  path: string
  sourcePluginId: string
  moduleId?: string
  componentId?: string
  enabledByDefault: boolean
}
```

注意：

- `@deepicode/plugin` 只负责解析和 resolve 内容资产。
- 不要让 `@deepicode/plugin` 直接 import `@deepicode/tools`、`@deepicode/mcp` 或 TUI。
- 内容包解析结果由 runtime 统一暴露，消费方自己读取。

## 5. Plugin 配置格式改造

### 5.1 保持旧格式

旧格式继续支持：

```json
[
  "./my-plugin.ts",
  ["./plugin.ts", { "enabled": true }],
  { "spec": "./plugin.ts", "options": { "enabled": true } }
]
```

### 5.2 新增 options

扩展 `PluginOptions`：

```ts
export interface PluginOptions {
  enabled?: boolean
  type?: "runtime" | "content-pack" | "auto"
  manifest?: string
  profile?: string
  target?: string
  targetMode?: "strict" | "compatible" | "ignore"
  modules?: string[]
  include?: string[]
  exclude?: string[]
  skills?: { enabled?: boolean }
  agents?: { enabled?: boolean }
  rules?: { enabled?: boolean; mode?: "system" | "skill" | "off" }
  commands?: { enabled?: boolean; mode?: "skill" | "off" }
  hooks?: {
    enabled?: boolean
    profile?: "minimal" | "standard" | "strict"
    allowCommandHooks?: boolean
    allowHttpHooks?: boolean
    allowPromptHooks?: boolean
    allowlist?: string[]
    denylist?: string[]
  }
  mcp?: {
    enabled?: boolean
    allowStdio?: boolean
    allowHttp?: boolean
    allowNpx?: boolean
    allowPlaceholderEnv?: boolean
    servers?: string[]
  }
  [key: string]: unknown
}
```

默认值：

- `type: "auto"`
- `target: "deepicode"`
- `targetMode: "compatible"`
- `profile: "developer"`，若 manifest 无 profiles 则忽略。
- `skills.enabled: true`
- `agents.enabled: true`
- `rules.enabled: true`
- `rules.mode: "system"`
- `commands.enabled: false`
- `hooks.enabled: false`
- `mcp.enabled: false`
- `mcp.allowStdio: true`
- `mcp.allowHttp: false`
- `mcp.allowNpx: false`
- `mcp.allowPlaceholderEnv: false`

## 6. Manifest 发现规则

当 `spec` 是目录时，按顺序查找：

1. 用户显式 `options.manifest`
2. `<root>/.deepicode-plugin.json`
3. `<root>/deepicode-plugin.json`
4. `<root>/.codex-plugin/plugin.json`
5. `<root>/.claude-plugin/plugin.json`
6. `<root>/package.json`，仅用于识别 npm 包 metadata，不作为内容资产 manifest

ECC 兼容要求：

- `/vol4/Agent/ECC/.codex-plugin/plugin.json` 应被识别为 Codex 内容包 manifest。
- `/vol4/Agent/ECC/.claude-plugin/plugin.json` 应被识别为 Claude 内容包 manifest。
- 若目录下同时存在 Codex 和 Claude manifest，`target: "codex"` 默认优先 Codex manifest。
- 若 Codex manifest 缺少 agents/rules/commands/hooks，但 ECC manifests 存在，应补充读取 `manifests/install-*.json`，按 module paths 解析。

`target` 与 manifest 发现优先级应分开：

- `target: "deepicode"` 表示最终消费方是 Deepicode。
- 发现 manifest 时，Deepicode 可优先使用 Codex manifest 作为最接近的基础入口。
- 不能因为 ECC 尚未声明 `deepicode` target，就把所有 module 过滤掉。

当 `spec` 是文件时：

- `.ts`、`.js`、`.mjs` 默认按旧 runtime plugin 处理。
- `.json` 可按 manifest 文件处理。

当 `spec` 是 npm 包名时：

- 首版继续保留当前错误行为也可以，但推荐实施 agent 顺手支持本地已安装包解析：
  - 使用 `import.meta.resolve` 或 Node resolution 找到 package root。
  - 仅当 package 已安装时加载。
  - 不自动 `npm install`。

## 7. ECC Profile/Module/Component 解析

ECC manifests：

- `manifests/install-profiles.json`
- `manifests/install-modules.json`
- `manifests/install-components.json`

解析规则：

1. 读取 profiles，得到 profile 对应 module 列表。
2. 读取 components，把 `include` 和 `exclude` 的 component id 转换为 module 集合。
3. 合并：
   - `profile.modules`
   - `options.modules`
   - `include` component 的 modules
4. 展开 module dependencies。
5. 应用 `exclude` component 的 modules。
6. 根据 `targetMode` 处理 module `targets`。
7. 按 module `paths` 生成资产候选。
8. 按各资产开关过滤。

伪代码：

```ts
const selected = new Set(profile.modules)
for (const module of options.modules ?? []) selected.add(module)
for (const component of options.include ?? []) add(component.modules)
expandDependencies(selected)
for (const component of options.exclude ?? []) remove(component.modules)
filterByTarget(selected, options.target ?? "deepicode", options.targetMode ?? "compatible")
resolvePaths(selected)
```

Target 模式：

- `strict`：module 必须显式包含目标 target。适合验证某个上游 harness 的原生支持情况。
- `compatible`：默认。`deepicode` 不在 targets 中时，根据 module kind 和 Deepicode 已实现的消费能力决定是否保留，并产生兼容诊断。
- `ignore`：忽略 targets，只按 profile/module/component 选择；仍受各资产开关和安全策略控制。

Deepicode `compatible` 模式建议：

| Module kind | Deepicode 已有消费能力 | 处理 |
|---|---|---|
| `skills` | 是 | 保留 |
| `agents` | 完成 agent registry 后支持 | 保留 |
| `rules` | 完成 rules adapter 后支持 | 保留 |
| `commands` | 仅可转换为 skills | 保留但默认 disabled |
| `hooks` | 部分事件可桥接 | 保留但默认 disabled |
| `platform` | 只解析 MCP/manifest 等已知资产 | 选择性保留 |
| `orchestration` | 首版不支持 | 跳过并诊断 |
| `docs` | 首版不主动加载 | 跳过并诊断 |

注意：

- `hooks-runtime` 在 ECC profiles 中可能默认包含，但 Deepicode 首版 `hooks.enabled` 默认 false，因此即使 module 被选中，也只记录为 disabled asset。
- `platform-configs` 中包含 `.codex-plugin`、`.opencode`、`mcp-configs` 等目录，不能盲目导入全部平台配置。
- `commands-core` 可被选中，但 Deepicode 首版不直接注册 slash commands。

## 8. Skills 接入

### 8.1 改造点

文件：

- `packages/tools/src/skill-loader.ts`
- `packages/tools/src/skills/index.ts`
- `packages/tools/src/index.ts`

当前 `createSkillTool()` 只读内置 skills。需要改成可注入额外目录：

```ts
export interface SkillToolOptions {
  skillDirs?: string[]
  skillAssets?: ContentAsset[]
}

export function createSkillTool(options?: SkillToolOptions): AgentTool
```

`createDefaultTools()` 也应支持 options：

```ts
export interface DefaultToolsOptions {
  skillDirs?: string[]
  contentPacks?: ResolvedContentPack[]
}

export function createDefaultTools(options?: DefaultToolsOptions): AgentTool[]
```

### 8.2 加载策略

- 内置 skills 继续保留。
- 内容包 skills 追加到 skill loader。
- skill id 冲突时，不覆盖内置 skill。
- 冲突命名建议显示为 `ecc:<name>`，但 `load` 时同时支持原名和命名空间名。
- `Skill list` 应显示来源 plugin。

建议 `SkillDef` 增加：

```ts
source?: {
  pluginId?: string
  path: string
}
```

### 8.3 ECC 验收

配置 `/vol4/Agent/ECC` 后：

- `/skill` 或 `Skill list` 能看到 ECC profile 选中的 skills。
- `Skill load tdd-workflow` 能读取 `/vol4/Agent/ECC/skills/tdd-workflow/SKILL.md`。
- 不需要把 ECC skills 复制到 `packages/tools/src/skills`。

## 9. Agents 接入

### 9.1 改造点

文件：

- `packages/core/src/agent.ts`
- `packages/core/src/index.ts`
- `packages/tui/src/commands.ts`
- `packages/tui/src/App.tsx`

当前 `AGENTS` 是静态对象。建议改成 registry：

```ts
export class AgentRegistry {
  register(def: AgentDefinition): void
  get(name: string): AgentDefinition
  list(): AgentDefinition[]
}
```

保留旧导出：

```ts
export const AGENTS = defaultAgentRegistry.snapshot()
export function getAgent(name: string): AgentDefinition
```

但 TUI 和 Engine 应逐步使用 registry，而不是直接读静态 `AGENTS`。

### 9.2 ECC agent markdown 转换

ECC agent 示例：

```yaml
---
name: code-reviewer
description: Expert code review specialist...
tools: ["Read", "Grep", "Glob", "Bash"]
model: sonnet
---
```

转换为：

```ts
AgentDefinition {
  name: "ecc:code-reviewer",
  label: "ECC Code Reviewer",
  model: undefined,
  systemPrompt: markdownBody,
  toolNames: mappedTools
}
```

工具名映射：

| ECC/Claude 工具 | Deepicode 工具 |
|---|---|
| `Read` | `read_file` 或当前实际 read 工具名 |
| `Grep` | `grep` |
| `Glob` | `glob` |
| `Bash` | `bash` |
| `Write` | `write_file` |
| `Edit` | `edit` |
| `MultiEdit` | `edit`，并记录降级诊断 |
| `TodoWrite` | `todo_write` |
| 未知工具 | 过滤并记录 warning |

实施 agent 必须先确认 Deepicode 实际工具名，不能只凭表格写死。

模型名映射：

| ECC model | Deepicode |
|---|---|
| `sonnet` | inherit 当前模型 |
| `opus` | inherit 当前模型，记录 hint |
| `haiku` | inherit 当前模型，记录 hint |
| 具体 provider model | 若 Deepicode 配置支持则使用，否则 inherit |

不要让 ECC agent 切换用户当前 provider/model，除非未来增加明确 per-agent model 配置。

### 9.3 TUI 支持

- `/agent` 菜单应显示 builtin agents 和内容包 agents。
- `/help` 的 Agents 列表应从 registry 读取。
- agent 名称冲突必须命名空间化，例如 `ecc:planner`，避免覆盖内置 `plan`。

## 10. Rules 接入

Rules 不应无条件拼进系统提示词。建议实现规则资产 registry：

```ts
export interface RuleAsset {
  id: string
  path: string
  sourcePluginId: string
  priority: number
  mode: "system" | "skill" | "off"
}
```

首版规则注入：

- 只加载 profile/module 选中的 rules。
- 每个 rule 文件读取后拼接成一个独立 section：

```md
## Content Pack Rules: ecc

Source: /vol4/Agent/ECC/rules/...
...
```

- 必须限制总字符数，建议默认 20k 字符以内。
- 超限时按文件名稳定排序截断，并记录 diagnostic。
- 用户可通过 `rules.mode: "off"` 关闭。

长期优化：

- 把 rules 转换为可搜索/可加载的 rule skill，而不是全部进入 system prompt。

## 11. Commands 接入

ECC 自己也说明 Skills 是更 canonical 的能力，commands 是 legacy shims。Deepicode 首版不要把 ECC commands 直接加入 slash command 解析。

首版策略：

- `commands.enabled` 默认 false。
- 如果开启，转换成 command skills：
  - 名称：`ecc-command:<command-name>`
  - description 从 markdown 首段或文件名生成。
  - content 为原 command markdown。
- 不修改 TUI `parseSlashCommand()` 支持 ECC 的 79 个 slash command。

原因：

- Deepicode slash command 当前是硬编码控制流。
- ECC commands 多数是提示词/工作流，转换成 skill 更安全。
- 直接扩展 slash command 会把 TUI 命令和内容包提示词混在一起。

## 12. Hooks 接入

### 12.1 当前 Deepicode hook 能力

文件：

- `packages/security/src/hooks.ts`
- `packages/plugin/src/hook-adapter.ts`

现有事件：

- `beforeToolCall(context)`
- `afterToolCall(toolName, result)`
- `onLoopEvent(event)`

### 12.2 ECC hook 事件映射

ECC Claude hooks：

| ECC/Claude 事件 | Deepicode 首版映射 |
|---|---|
| `PreToolUse` | `beforeToolCall` |
| `PermissionRequest` | `beforeToolCall`，仅诊断或 deny/allow |
| `PostToolUse` | `afterToolCall` |
| `PostToolUseFailure` | 需要 Deepicode 增加失败 after hook；首版可诊断不执行 |
| `UserPromptSubmit` | 需要 Engine submit 前事件；首版可跳过 |
| `SessionStart` | 需要 Engine lifecycle；首版可跳过 |
| `SessionEnd` | 需要 Engine lifecycle；首版可跳过 |
| `Stop` | `onLoopEvent`，仅当已有对应 loop event |
| `PreCompact` | 需要 context lifecycle；首版可跳过 |

OpenCode `.opencode/plugins/ecc-hooks.ts` 不直接运行，只作为行为参考。它依赖：

- `@opencode-ai/plugin`
- `PluginInput`
- OpenCode event names
- OpenCode `$` shell template
- `client.app.log`

Deepicode 不能直接 import 该文件。

### 12.3 安全策略

默认：

- `hooks.enabled: false`
- `allowCommandHooks: false`
- `allowHttpHooks: false`
- `allowPromptHooks: false`

即使用户设置 `hooks.enabled: true`：

- command hooks 必须经过 allowlist。
- 每个 hook 有 timeout。
- hook 工作目录必须是 workspace root。
- 传给 hook 的环境变量必须最小化。
- 不允许继承完整 `process.env`，除非用户明确配置。
- hook 输出要截断。
- `beforeToolCall` 中 command hook 出错时默认不 allow 危险工具，采用 fail-closed 或按 hook 类型配置。

### 12.4 首版实现建议

新增：

- `packages/plugin/src/content-pack/hooks.ts`
- `packages/plugin/src/content-pack/ecc-hooks-adapter.ts`

先支持只读诊断 hooks 和少量安全 command hooks：

- 解析 `hooks/hooks.json`。
- 按 `matcher` 匹配 Deepicode tool name。
- 支持 command hook 的 dry-run diagnostic。
- 真执行必须满足：
  - `hooks.enabled === true`
  - `allowCommandHooks === true`
  - hook id 在 allowlist

不要在首版执行 ECC 全量 hooks。

## 13. MCP 接入

### 13.1 改造点

文件：

- `packages/mcp/src/host.ts`
- `packages/cli/src/tui.ts`

当前 `McpHost.loadConfig()` 只从 `.deepicode/mcp.json` 读取。建议新增：

```ts
async loadConfigs(configs: McpConfigSource[]): Promise<McpLoadSummary>
```

或：

```ts
async loadConfigObjects(configs: Array<{ source: string; config: McpConfig }>): Promise<McpLoadSummary>
```

由 plugin runtime 提供内容包 MCP assets，CLI 初始化时合并传入。

### 13.2 ECC MCP 策略

ECC MCP 文件：

- `/vol4/Agent/ECC/mcp-configs/mcp-servers.json`
- `/vol4/Agent/ECC/.mcp.json`

首版：

- 识别 `command`/`args`/`env` 的 stdio MCP。
- 识别但不连接 `type: "http"`/`url`。
- 默认 `mcp.enabled: false`。
- 若开启 MCP：
  - `npx -y` server 默认跳过，除非 `allowNpx: true`。
  - env 中包含 `YOUR_`、`_HERE`、`PLACEHOLDER` 等占位值时跳过，除非 `allowPlaceholderEnv: true`。
  - 支持 `mcp.servers` 白名单，只连接指定 server。

诊断示例：

```json
{
  "type": "mcp_skipped",
  "server": "github",
  "reason": "placeholder_env:GITHUB_PERSONAL_ACCESS_TOKEN"
}
```

## 14. Plugin Runtime 接线

### 14.1 Runtime 状态扩展

文件：

- `packages/plugin/src/runtime.ts`

新增状态：

```ts
export interface PluginRuntimeStatus {
  initialized: boolean
  loadedPlugins: string[]
  contentPacks: string[]
  tools: string[]
  hooks: string[]
  assets: {
    skills: number
    agents: number
    rules: number
    commands: number
    mcp: number
    hooks: number
  }
  errors: PluginRuntimeError[]
  diagnostics: ContentPackDiagnostic[]
}
```

新增方法：

```ts
getContentPacks(): ResolvedContentPack[]
getSkillDirs(): string[]
getAgentAssets(): ContentAsset[]
getRuleAssets(): ContentAsset[]
getMcpAssets(): ContentAsset[]
getHookAssets(): ContentAsset[]
```

### 14.2 CLI 初始化顺序

文件：

- `packages/cli/src/tui.ts`

建议顺序：

1. 创建 `HookManager` / Engine 需要的安全对象。
2. 创建 `PluginRuntime({ workspaceRoot, hookManager })`。
3. `await pluginRuntime.init()`。
4. 从 runtime 取得：
   - plugin tools
   - content pack skill dirs
   - agent assets
   - rule assets
   - MCP configs
   - hook configs
5. 创建 default tools 时传入 skill dirs。
6. 创建 agent registry 时注册内容包 agents。
7. 创建 Engine 时传入：
   - tools
   - agent registry
   - rule assets/system prompt extensions
   - plugin hook manager
8. 创建 MCP host 并加载 `.deepicode/mcp.json` 和允许的内容包 MCP。
9. TUI 显示 plugin/content pack/mcp/skill 数量。

如果当前 Engine 构造顺序不方便，实施 agent 可以分两步：

- 第一阶段只把 content pack skills 接到 `Skill` 工具。
- 第二阶段再把 agents/rules/mcp/hooks 接上。

## 15. 包依赖建议

当前依赖：

- `@deepicode/plugin` 依赖 `@deepicode/core`
- `@deepicode/tools` 依赖 `@deepicode/core`
- `@deepicode/mcp` 依赖 `@deepicode/core` 和 `@deepicode/tools`

避免让 `@deepicode/plugin` 依赖 `@deepicode/tools` 或 `@deepicode/mcp`。

推荐：

- `@deepicode/plugin` 产出 plain data。
- `@deepicode/tools` 可依赖 `@deepicode/plugin` 的类型吗？尽量不要，避免包交叉。可以复制极小 `SkillSource` 类型，或把共享类型放到 `@deepicode/core`。
- 更干净方案：在 `@deepicode/core` 新增内容资产通用类型，例如 `ContentAsset`、`AgentDefinition` 扩展。

实施 agent 应优先选择最少依赖变更：

- `packages/plugin` 内定义 resolver 类型。
- `packages/cli` 把 resolver 输出转换为各 package 需要的简单参数。
- `packages/tools` 只接受 `skillDirs: string[]`，不直接关心 plugin 类型。

## 16. 文件级实施清单

### 16.1 Plugin 包

新增：

- `packages/plugin/src/content-pack/types.ts`
- `packages/plugin/src/content-pack/discovery.ts`
- `packages/plugin/src/content-pack/parser.ts`
- `packages/plugin/src/content-pack/ecc-manifests.ts`
- `packages/plugin/src/content-pack/resolver.ts`
- `packages/plugin/src/content-pack/hooks.ts`
- `packages/plugin/src/content-pack/mcp.ts`
- `packages/plugin/src/content-pack/index.ts`
- `packages/plugin/__tests__/content-pack-discovery.test.ts`
- `packages/plugin/__tests__/content-pack-resolver.test.ts`
- `packages/plugin/__tests__/ecc-content-pack.test.ts`

修改：

- `packages/plugin/src/config.ts`
- `packages/plugin/src/loader.ts`
- `packages/plugin/src/runtime.ts`
- `packages/plugin/src/index.ts`
- `packages/plugin/package.json`

重点：

- `loadPlugins()` 继续只处理 runtime plugins。
- `PluginRuntime.init()` 同时调用 runtime loader 和 content-pack resolver。
- content-pack 错误不应阻止 runtime plugin 加载。

### 16.2 Tools 包

修改：

- `packages/tools/src/skill-loader.ts`
- `packages/tools/src/skills/index.ts`
- `packages/tools/src/index.ts`

重点：

- `createSkillTool({ skillDirs })`
- `createDefaultTools({ skillDirs })`
- skill loader 支持重复名诊断和来源信息。

### 16.3 Core 包

修改：

- `packages/core/src/agent.ts`
- `packages/core/src/engine.ts`
- `packages/core/src/system-prompt.ts`
- `packages/core/src/index.ts`

可新增：

- `packages/core/src/agent-registry.ts`
- `packages/core/src/rules.ts`

重点：

- agent registry 支持动态注册。
- Engine 支持注入 registry 或 resolved agent list。
- rules system prompt extension 可注入、可关闭、可限长。

### 16.4 MCP 包

修改：

- `packages/mcp/src/host.ts`
- `packages/mcp/src/index.ts`

重点：

- 支持从对象加载多个 MCP config source。
- 跳过 HTTP MCP 并记录诊断。
- 跳过 placeholder env。
- 跳过 `npx -y`，除非显式允许。

### 16.5 CLI/TUI

修改：

- `packages/cli/src/tui.ts`
- `packages/tui/src/App.tsx`
- `packages/tui/src/commands.ts`
- `packages/tui/src/CommandRegistry.ts`
- `packages/tui/src/WelcomeScreen.tsx`
- `packages/tui/src/StatusBar.tsx`

重点：

- CLI 初始化 plugin runtime 并把内容包资产注入 Engine/tools/MCP。
- TUI 显示 content pack 数量和诊断摘要。
- `/help`、`/agent` 从动态 registry 获取 agents。
- `/status` 展示 content pack assets 统计。

## 17. 与 Zod 集成的关系

Deepicode 另有 Zod 集成计划。内容包 manifest 校验可以按两种路径实施：

1. 如果 Zod 已完成：使用 Zod schema 校验 Deepicode content-pack manifest 和 ECC manifest 解析结果。
2. 如果 Zod 未完成：先用小型手写校验或 JSON schema validator，接口保持 `parse -> Result<T, Diagnostic[]>`，后续可替换为 Zod。

不要让 ECC 内容包支持阻塞在 Zod 完成上。

## 18. 测试计划

### 18.1 Unit Tests

Plugin config：

- 旧 runtime plugin 配置仍通过。
- 目录 spec 能识别 content-pack。
- `options.type: "runtime"` 强制按旧插件加载。
- `options.type: "content-pack"` 强制按 manifest 加载。
- invalid manifest 给出 diagnostic，不崩溃。

ECC resolver：

- 能发现 `/vol4/Agent/ECC/.codex-plugin/plugin.json`。
- `profile: "minimal"` 解析出对应 modules。
- `include` component 能加入 module。
- `exclude` component 能移除 module。
- module dependencies 能展开。
- target 过滤正确。
- paths 解析必须留在 ECC root 内，禁止 path traversal。

Skills：

- 可从临时 content pack skill dir 加载 skill。
- 内置 skill 与内容包 skill 重名时不覆盖。
- `Skill list` 显示来源。
- `Skill load` 可按命名空间加载。

Agents：

- ECC markdown frontmatter 能转为 `AgentDefinition`。
- tool name 映射正确。
- 未知 tool 产生 warning。
- `ecc:planner` 不覆盖 builtin `plan`。

Rules：

- rules 注入有长度上限。
- `rules.mode: "off"` 不注入。
- 超限产生 diagnostic。

MCP：

- stdio MCP 可被导入。
- HTTP MCP 被跳过并诊断。
- placeholder env 被跳过。
- `npx -y` 默认被跳过。

Hooks：

- `hooks.enabled: false` 时只记录 assets，不执行。
- allowlist 外 command hook 不执行。
- timeout 生效。
- matcher 能从 `PreToolUse` 匹配到 Deepicode tool。

### 18.2 Integration Tests

创建临时 workspace：

```text
tmp/
  .deepicode/plugins.json
  ecc-fixture/
    .codex-plugin/plugin.json
    manifests/install-profiles.json
    manifests/install-modules.json
    skills/tdd-workflow/SKILL.md
    agents/code-reviewer.md
    rules/core.md
    mcp-configs/mcp-servers.json
```

测试：

- `PluginRuntime.init()` 加载 fixture。
- `runtime.getStatus()` 返回 content pack asset counts。
- `createSkillTool({ skillDirs })` 能 load fixture skill。
- agent registry 出现 `ecc:code-reviewer`。
- MCP config 只连接允许的 stdio server。

### 18.3 ECC Real-Repo Smoke Test

使用真实 ECC：

```json
[
  {
    "spec": "/vol4/Agent/ECC",
    "options": {
      "type": "content-pack",
      "profile": "developer",
      "target": "deepicode",
      "targetMode": "compatible",
      "hooks": { "enabled": false },
      "mcp": { "enabled": false }
    }
  }
]
```

验收：

- Deepicode 启动不报致命错误。
- status 显示 `ecc` content pack loaded。
- skill 数量增加。
- `tdd-workflow` 或 `security-review` 可加载。
- agent registry 出现 ECC agents。
- hooks/mcp 被识别但默认未执行/未连接。

### 18.4 Regression Tests

- 没有 `.deepicode/plugins.json` 时行为保持现状。
- 旧 `.ts` runtime plugin 仍能注册工具。
- 旧 hook plugin 的 `beforeToolCall`、`afterToolCall`、`onLoopEvent` 仍工作。
- 内置 `/help`、`/skill`、`/agent` 不因无内容包而失败。
- TUI 无 content pack 时 plugin count 显示不回退。

## 19. 验收标准

实施完成后必须满足：

1. Deepicode 支持目录型 manifest 内容包插件。
2. ECC 可通过 `.deepicode/plugins.json` 以 `/vol4/Agent/ECC` 路径加载。
3. 不复制 ECC 整仓内容进 Deepicode。
4. 旧 runtime plugin 测试全部通过。
5. ECC skills 可被 `Skill` 工具搜索和加载。
6. ECC agents 可出现在 agent registry，且不覆盖内置 agents。
7. ECC rules 可按配置注入或关闭。
8. ECC hooks 默认不执行；显式开启后也受 allowlist 和 timeout 控制。
9. ECC MCP 默认不连接；显式开启时只连接安全允许的 stdio MCP。
10. HTTP MCP、placeholder env、`npx -y` 默认跳过并有诊断。
11. `/status` 或 welcome/status 区能看到 content pack 资产统计。
12. `bun test` 和相关 package `typecheck` 通过。

## 20. 实施阶段建议

### Phase 1：内容包识别和 Skills

目标：

- 目录 manifest discovery。
- ECC profile/module 解析。
- resolved content pack status。
- Skill tool 注入外部 skill dirs。

这是最小可用版本。

### Phase 2：Agents 和 Rules

目标：

- agent markdown frontmatter parser。
- dynamic agent registry。
- TUI `/agent` 和 `/help` 接入 registry。
- rules system prompt extension。

### Phase 3：MCP 安全导入

目标：

- MCP host 支持多个 config object。
- 内容包 stdio MCP 导入。
- HTTP/placeholder/npx 安全跳过。
- status diagnostics。

### Phase 4：Hooks 桥接

目标：

- ECC hook JSON parser。
- PreToolUse/PostToolUse 到 Deepicode hook 的桥接。
- allowlist、timeout、最小 env。
- 默认 disabled。

### Phase 5：Commands 作为 Skills

目标：

- ECC command markdown 转换为 `ecc-command:*` skills。
- 不改 TUI slash command 控制流。

## 21. 实施时特别注意

- 当前 Deepicode 工作区已有其他 agent 的未提交修改，实施 agent 不得回退、覆盖或格式化无关文件。
- 不要把 `/vol4/Agent/ECC` 写死到源码中。测试可使用 fixture；真实 smoke test 可使用该路径。
- 不要默认执行 ECC hook command。
- 不要默认连接 ECC MCP。
- 不要默认加载 ECC full profile。
- 不要把 ECC OpenCode plugin 直接 import 到 Deepicode。
- 不要让内容包 agent 覆盖内置 `build`、`plan`。
- 不要让内容包 rules 无限扩展 system prompt。
- 不要引入新的包循环依赖。

## 22. 最终报告要求

实施 agent 完成后，报告必须包含：

- 修改了哪些文件。
- 新增了哪些 public API。
- ECC 哪些能力已兼容，哪些只识别不执行。
- 默认安全策略如何工作。
- 跑过哪些测试和命令。
- 使用真实 `/vol4/Agent/ECC` smoke test 的结果。
- 遗留风险和下一阶段建议。
