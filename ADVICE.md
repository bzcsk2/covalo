# Deepicode LSP 完整实现专项设计

最后更新：2026-06-03

本文只记录 **LSP 从最小可用实现升级为完整工程能力** 的专项方案。当前项目总待办仍以 [TODO.md](TODO.md) 为准；已完成能力和历史结论见 [DONE.md](DONE.md)；验收步骤见 [TEST.md](TEST.md)。

---

## 1. 当前结论

Deepicode 的 LSP 不是空壳，已经有最小可用实现：

- `packages/tools/src/lsp.ts`：注册内置 `LSP` 工具，支持 `definition`、`references`、`hover`、`diagnostics`、`completion`。
- `packages/tools/src/lsp-client.ts`：通过 stdio 启动 language server，执行 `initialize`、`initialized`、`didOpen` 和 JSON-RPC 请求。
- `packages/tools/__tests__/workflow-agent-send-lsp.test.ts`：已有 fake LSP server 的 hover 集成测试。
- `packages/tools/src/index.ts`：`createDefaultTools()` 已包含 `createLspTool()`。

但它仍是“一次性请求型 LSP”，不是完整 IDE 级能力。主要缺口：

- 每次工具调用都新建 language server，不能复用索引、缓存或 workspace 状态。
- 没有 server lifecycle manager，无法按语言、workspace、配置版本维持长驻连接。
- 只 `didOpen` 当前文件，不维护 `didChange`、`didSave`、`didClose`。
- diagnostics 只等待短时间收集推送，缺少稳定订阅和缓存。
- completion、definition、references 的返回没有标准化，模型难以稳定消费。
- 没有配置发现、server 自动安装提示、能力协商、日志和 health check。
- 没有多平台真实 server 验收，只用 fake server 覆盖了协议最小路径。

完整实现目标不是把 Deepicode 变成编辑器，而是让 Agent 能可靠查询项目语义信息，并且不破坏当前工具架构和运行速度。

---

## 2. opencode 复用结论

`/vol4/Agent/opencode` 的 LSP 实现可以作为 Deepicode LSP 的主要参考实现，但不能直接整包搬进来。

### 2.1 可以复用的内容

opencode 是 MIT License，允许代码移植，但任何直接复制或大段改写都必须保留 MIT 版权和许可说明。参考源：

- `/vol4/Agent/opencode/LICENSE`
- `/vol4/Agent/opencode/packages/opencode/src/lsp/lsp.ts`
- `/vol4/Agent/opencode/packages/opencode/src/lsp/client.ts`
- `/vol4/Agent/opencode/packages/opencode/src/lsp/server.ts`
- `/vol4/Agent/opencode/packages/opencode/src/lsp/launch.ts`
- `/vol4/Agent/opencode/packages/opencode/src/lsp/language.ts`
- `/vol4/Agent/opencode/packages/opencode/src/lsp/diagnostic.ts`
- `/vol4/Agent/opencode/packages/opencode/src/tool/lsp.ts`
- `/vol4/Agent/opencode/packages/opencode/src/config/lsp.ts`
- `/vol4/Agent/opencode/packages/opencode/test/lsp/*`
- `/vol4/Agent/opencode/packages/opencode/test/tool/lsp.test.ts`
- `/vol4/Agent/opencode/packages/opencode/test/fixture/lsp/fake-lsp-server.js`

优先借鉴这些设计：

1. LSP server 按 root + server id 复用，而不是每次工具调用重新启动。
2. 使用 `vscode-jsonrpc/node` 管理 stdio JSON-RPC 连接，而不是手写不完整协议。
3. `initialize` capability 声明、`initialized`、`workspace/configuration`、`workspace/workspaceFolders` 等基础握手。
4. `textDocument/didOpen`、`textDocument/didChange`、`workspace/didChangeWatchedFiles` 的文档同步模型。
5. push diagnostics 与 pull diagnostics 合并、去重、等待 fresh diagnostics 的策略。
6. 内置 server 探测和 root 识别规则，例如 TypeScript、Deno、Pyright、Gopls、Biome、Rust analyzer。
7. 工具动作集合：definition、references、hover、documentSymbol、workspaceSymbol、implementation、call hierarchy。
8. fake LSP server 测试、client lifecycle 测试、tool 参数测试。

### 2.2 不能直接复用的内容

不要把 opencode 的以下架构直接引入 Deepicode：

- `Effect` / `Layer` / `Context.Service`
- opencode `Bus`
- `InstanceState` / `InstanceContext`
- opencode `Config` 服务
- opencode `Tool.define`
- opencode `Process` / `Filesystem` 封装
- opencode TUI status/sidebar 组件

原因：Deepicode 目前是 `AgentTool` + packages 分层架构。硬搬 opencode 服务框架会让 LSP 变成跨包架构迁移，影响范围远超过 LSP 本身，并且会引入大量无关依赖。

### 2.3 推荐实现方式

采用“opencode 设计移植，Deepicode 架构重写”：

- 协议层可以直接参考 opencode `client.ts`，但包装成普通 `LspClient` 类。
- server registry 可以参考 opencode `server.ts`，但配置来源改成 `.deepicode/lsp.json` 和 Deepicode defaults。
- manager 可以参考 opencode `lsp.ts` 的 `getClients()`、`touchFile()`、`diagnostics()`，但实现为无 Effect 依赖的 `LspManager`。
- tool wrapper 可以参考 opencode `tool/lsp.ts` 的 action 设计，但返回格式必须改成 Deepicode 的结构化 `AgentTool` 输出。
- diagnostics 等待策略可优先移植，避免 Deepicode 自己重新踩 LSP push/pull 兼容坑。
- 测试应优先移植 fake server 和 lifecycle 场景，然后再补 Deepicode 自己的权限、日志、进程树终止测试。

如果某段 opencode 代码被直接复制超过少量片段，需要在对应文件头部或 `NOTICE`/文档中标注来源和 MIT 许可。若只是按行为重写，不需要逐文件保留原代码头，但应在本设计文档和提交说明中说明参考来源。

---

## 3. 设计目标

### 必须达到

1. LSP server 按 workspace + language 长驻复用，避免每次工具调用重新索引。
2. 支持 TypeScript/JavaScript、Python、Go、Rust 的配置发现或明确安装提示。
3. 支持核心语义动作：
   - `hover`
   - `definition`
   - `declaration`
   - `type_definition`
   - `implementation`
   - `references`
   - `document_symbols`
   - `workspace_symbols`
   - `diagnostics`
   - `completion`
   - `signature_help`
   - `rename_preview`
4. 返回结构统一、可截断、可被模型稳定阅读。
5. 能处理文件变更：读文件、编辑、写文件后 LSP 状态不长期陈旧。
6. 有超时、取消、进程树终止和错误分类。
7. 日志能追踪 `sessionId → submitId → toolCallId → lspServerId → requestId`。
8. 默认不后台启动 LSP；只有首次调用 LSP 工具时按需启动。

### 非目标

- 不做 VS Code 插件式 UI。
- 不实现完整代码补全弹窗。
- 不托管用户项目依赖安装。
- 不绕过现有工具权限模型。
- 不把 LSP 动态能力混入 static prefix。
- 不把所有代码导航都改为 LSP；`grep`、`read_file`、`glob` 仍是基础工具。

---

## 4. 架构方案

### 4.1 新增模块边界

建议新增：

```text
packages/tools/src/lsp/
  config.ts              # 读取、合并和校验 .deepicode/lsp.json
  language.ts            # 后缀、shebang、package 文件到 languageId 的推断
  protocol.ts            # JSON-RPC 兼容封装；优先复用 vscode-jsonrpc/node，不手写完整协议
  client.ts              # 单个 server 连接：initialize/request/notify/shutdown
  manager.ts             # workspace + language 级长驻 server 管理
  documents.ts           # didOpen/didChange/didSave/didClose 状态
  normalize.ts           # 标准化 Location、Hover、Diagnostic、Completion 等
  health.ts              # server 状态、重启、崩溃分类
  defaults.ts            # 常见语言 server 默认候选和安装提示
  index.ts
```

保留兼容入口：

```text
packages/tools/src/lsp.ts          # createLspTool()，只做参数校验和 manager 调用
packages/tools/src/lsp-client.ts   # 先保留兼容，最终改为 re-export 或删除前迁移测试
```

不要把 LSP manager 放进 Core。Core 只认识 `AgentTool`，生命周期通过 tool context 或 tools 层 shutdown registry 管理。

实现时优先按 opencode 的文件职责映射：

| Deepicode 目标模块 | opencode 参考文件 | 处理方式 |
| --- | --- | --- |
| `lsp/client.ts` | `opencode/src/lsp/client.ts` | 移植握手、request、diagnostics、shutdown 逻辑，去掉 Effect/Bus 依赖 |
| `lsp/manager.ts` | `opencode/src/lsp/lsp.ts` | 移植 client 复用、broken/spawning 状态、touchFile，改成普通类 |
| `lsp/defaults.ts` | `opencode/src/lsp/server.ts` | 借鉴 server definitions 和 root detection，禁止默认联网自动安装 |
| `lsp/language.ts` | `opencode/src/lsp/language.ts` | 可直接按行为移植语言映射 |
| `lsp/diagnostic.ts` | `opencode/src/lsp/diagnostic.ts` | 借鉴格式化和 severity 映射 |
| `lsp.ts` tool | `opencode/src/tool/lsp.ts` | 借鉴 action 集合，改成 Deepicode 参数 schema 和返回格式 |
| tests | `opencode/test/lsp/*` | 移植 fake server、lifecycle、client tests，补 Deepicode 权限/日志测试 |
| config | `opencode/src/config/lsp.ts` | 借鉴 schema 思路，保留 Deepicode `.deepicode/lsp.json` 格式 |

### 4.2 LSP Manager

`LspManager` 负责复用 server：

```ts
type LspServerKey = `${workspaceRoot}:${languageId}:${configHash}`;

interface LspManager {
  request(input: LspRequestInput, context: ToolContext): Promise<LspToolResult>;
  shutdownWorkspace(workspaceRoot: string): Promise<void>;
  shutdownAll(): Promise<void>;
  health(): LspServerHealth[];
}
```

行为要求：

- 首次请求某语言时启动 server。
- 相同 workspace、language、configHash 复用同一 server。
- 配置文件变化后重启对应 server。
- server 崩溃后标记 unhealthy；下一次请求可重启一次。
- 长时间空闲自动关闭，默认 5 分钟，可配置。
- 每个 server 内 JSON-RPC request id 单调递增。
- pending request 在 timeout、abort、server exit 时全部 resolve 为结构化错误，不悬挂。

### 4.3 配置模型

`.deepicode/lsp.json` 建议升级为：

```json
{
  "version": 1,
  "idleTimeoutMs": 300000,
  "requestTimeoutMs": 8000,
  "languages": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "rootPatterns": ["tsconfig.json", "package.json", ".git"],
      "fileExtensions": [".ts", ".tsx"],
      "initializationOptions": {},
      "settings": {}
    },
    "python": {
      "command": "pyright-langserver",
      "args": ["--stdio"],
      "rootPatterns": ["pyproject.toml", "setup.py", ".git"],
      "fileExtensions": [".py"]
    }
  }
}
```

兼容当前旧格式：

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

配置发现规则：

1. 优先读取 `<workspace>/.deepicode/lsp.json`。
2. 没有配置时，根据语言返回明确安装提示，不直接报泛化错误。
3. 可通过 `DEEPICODE_LSP_CONFIG` 指定配置路径，用于测试和 CI。
4. 禁止从不可信文件自动执行命令；配置只来自 workspace 根的 `.deepicode/lsp.json` 或显式环境变量。
5. command 必须是字符串，args 必须是字符串数组；拒绝 shell 字符串拼接。

### 4.4 文档同步模型

实现 `LspDocumentStore`：

- `ensureOpen(filePath)`：第一次请求文件时读取内容并发送 `textDocument/didOpen`。
- `syncFile(filePath)`：如果磁盘 mtime 或 content hash 改变，发送 `didChange` 或 close/open。
- `didSave(filePath)`：write/edit 后可选发送，低优先级。
- `closeUnusedDocuments()`：空闲清理。

初期可采用 full sync：

```ts
textDocument/didChange {
  textDocument: { uri, version },
  contentChanges: [{ text }]
}
```

后续再考虑增量 sync。不要一开始实现复杂 diff。

编辑工具集成建议：

- `read_file` 不需要通知 LSP。
- `write_file`、`edit`、`NotebookEdit` 完成后可调用 tools 层事件钩子，通知 `LspManager.markDirty(filePath)`。
- 若暂时不做钩子，LSP 工具每次请求前用 mtime/hash 检查并同步，也能保证正确性。

### 4.5 工具 API

保留工具名 `LSP`，扩展参数：

```ts
{
  action:
    | "hover"
    | "definition"
    | "declaration"
    | "type_definition"
    | "implementation"
    | "references"
    | "document_symbols"
    | "workspace_symbols"
    | "diagnostics"
    | "completion"
    | "signature_help"
    | "rename_preview"
    | "server_status"
    | "restart_server";
  file_path?: string;
  line?: number;
  column?: number;
  query?: string;
  new_name?: string;
  language?: string;
  timeout_ms?: number;
  include_raw?: boolean;
  max_results?: number;
}
```

参数规则：

- 文件相关 action 必须提供 `file_path`。
- `workspace_symbols` 必须提供 `query`。
- `rename_preview` 必须提供 `file_path`、`line`、`column`、`new_name`。
- `server_status` 不需要文件。
- `restart_server` 需要 `language` 或可由 `file_path` 推断。

权限仍为 `read`。`rename_preview` 只返回 workspace edit 预览，不直接写文件，因此仍为 read。真正应用 rename 必须通过 `edit` 或新增单独 write-tier 工具，不能在 LSP 里隐式写盘。

### 4.6 返回格式

所有结果统一：

```json
{
  "status": "ok",
  "action": "definition",
  "language": "typescript",
  "workspaceRoot": "/repo",
  "file": "/repo/src/a.ts",
  "position": { "line": 10, "column": 4 },
  "summary": "...human readable compact summary...",
  "items": [
    {
      "kind": "location",
      "file": "/repo/src/b.ts",
      "range": {
        "start": { "line": 1, "column": 2 },
        "end": { "line": 1, "column": 10 }
      },
      "preview": "export function foo() {"
    }
  ],
  "truncated": false,
  "server": {
    "id": "typescript:/repo:abc123",
    "reused": true,
    "uptimeMs": 12345
  }
}
```

错误格式：

```json
{
  "status": "error",
  "errorType": "server_not_configured",
  "message": "No LSP server configured for language \"typescript\".",
  "installHint": "npm i -g typescript-language-server typescript",
  "action": "hover",
  "language": "typescript"
}
```

必须标准化：

- `Location` / `LocationLink`
- `Hover`
- `Diagnostic`
- `CompletionItem`
- `SymbolInformation` / `DocumentSymbol`
- `WorkspaceEdit`
- `SignatureHelp`

结果限制：

- 默认最多 50 条 item。
- 每个 preview 最多 240 字符。
- 总 JSON 字符串通过 `safeStringify()` 截断。
- `include_raw` 默认 false，避免模型看到过大的 server 原始结构。

---

## 5. 实施阶段

### LSP-10：配置、语言识别和返回格式

目标：

- 抽出 `config.ts`、`language.ts`、`normalize.ts`。
- 兼容旧 `.deepicode/lsp.json`。
- 增加常见语言默认安装提示。
- 保持当前一次性 `runLspRequest()` 行为不变。
- 对照 opencode `config/lsp.ts`、`lsp/language.ts`、`lsp/diagnostic.ts`，只移植 Deepicode 需要的 schema、语言映射和格式化逻辑。
- 不引入 `effect`，不引入 opencode config service。

测试：

- 旧配置可读取。
- 新配置可读取。
- 无配置时返回 language-specific installHint。
- `.ts/.tsx/.js/.jsx/.py/.go/.rs/.json/.css/.html` 推断正确。
- 敏感路径仍被拒绝。
- 标准化 Location/Hover/Diagnostic 不泄漏 raw 巨型对象。

关闭条件：

- `bun test packages/tools/__tests__/lsp*.test.ts`
- `bun run typecheck`

### LSP-20：协议层和长驻 Client

目标：

- 引入或复用 `vscode-jsonrpc/node` 管理 stdio message connection；不要继续扩大自研 JSON-RPC 帧解析。
- 实现 `LspClient` 类：
  - `start()`
  - `initialize()`
  - `request()`
  - `notify()`
  - `shutdown()`
  - `kill()`
  - `health()`
- 支持 pending request 清理、stderr 捕获、server exit 分类。
- 继续使用 `terminateProcessTree()`。
- 以 opencode `lsp/client.ts` 为主要参考，移植这些关键行为：
  - initialize timeout。
  - `workspace/configuration` 响应。
  - `workspace/workspaceFolders` 响应。
  - `client/registerCapability` / `client/unregisterCapability` 中 diagnostics capability 记录。
  - `textDocument/publishDiagnostics` 缓存。
  - `shutdown` + `exit` + 进程树终止。

测试：

- 基于 `vscode-jsonrpc/node` 时，不再单独测试底层分片 header；只测试 client 能消费 fake server 分片/拼包输出。
- request timeout 会 reject，pending 被清理。
- server exit 会 reject 所有 pending。
- shutdown 发送 `shutdown` request 和 `exit` notify；超时后 kill。
- AbortSignal 会终止进程树。

关闭条件：

- fake LSP server 覆盖 initialize、hover、timeout、crash。
- 无残留子进程。

### LSP-30：Manager 和文档同步

目标：

- 实现 `LspManager`。
- 按 workspace + language + configHash 复用 server。
- 实现 `LspDocumentStore`，请求前自动同步磁盘变化。
- 空闲 server 自动关闭。
- 以 opencode `lsp/lsp.ts` 的 `getClients()`、`touchFile()`、`status()`、`diagnostics()` 为参考，但不要照搬 `Effect` 服务层。
- 文档同步优先移植 opencode `client.notify.open()` 的策略：
  - 首次发送 `workspace/didChangeWatchedFiles` created。
  - 首次发送 `textDocument/didOpen`。
  - 已打开文件内容变化时发送 changed + `textDocument/didChange`。
  - 根据 server sync capability 选择 full sync；初期可以只实现 full sync，保留增量 sync 扩展点。

测试：

- 两次 hover 复用同一 server。
- 不同语言启动不同 server。
- 配置变化后重启 server。
- 文件修改后发送 `didChange`。
- idle timeout 后 server 被关闭。
- 并发同语言请求不启动重复 server。

关闭条件：

- 单测覆盖 server 复用和 dirty sync。
- 全量测试无残留 handle。

### LSP-40：完整动作集

目标：

实现并标准化：

- `hover`
- `definition`
- `declaration`
- `type_definition`
- `implementation`
- `references`
- `document_symbols`
- `workspace_symbols`
- `diagnostics`
- `completion`
- `signature_help`
- `rename_preview`
- `server_status`
- `restart_server`
- action 名称对外使用 Deepicode 风格，同时兼容 opencode 风格别名：
  - `definition` 兼容 `goToDefinition`
  - `references` 兼容 `findReferences`
  - `implementation` 兼容 `goToImplementation`
  - `document_symbols` 兼容 `documentSymbol`
  - `workspace_symbols` 兼容 `workspaceSymbol`

测试：

- fake server 为每个 action 返回典型结果。
- LocationLink 和 Location 都能标准化。
- diagnostics 支持 publishDiagnostics 缓存。
- completion 限制数量并保留 label/kind/detail/documentation 摘要。
- rename_preview 返回 workspace edit，但不写文件。
- server_status 可看到 running/unhealthy/restarted/idle 信息。

关闭条件：

- 每个 action 至少一个成功测试和一个参数错误测试。

### LSP-50：真实语言服务器验收

目标：

在可选依赖存在时跑真实 server smoke，不存在时 skip 并打印安装提示。

建议覆盖：

- TypeScript：`typescript-language-server --stdio`
- Python：`pyright-langserver --stdio`
- Go：`gopls`
- Rust：`rust-analyzer`
- 可选扩展参考 opencode server registry：Deno、Biome、ESLint、Vue、Oxlint、Ruby、Elixir、Zig。

测试策略：

- CI 默认只跑 fake server，避免强依赖全局安装。
- 本地或 nightly 可通过 `DEEPICODE_LSP_REAL=1` 启用真实 server smoke。
- 每种语言创建最小 fixture 项目，验证 hover/definition/diagnostics 至少两项。
- Deepicode 默认不要像 opencode 一样联网下载 server；缺依赖时返回 installHint。自动下载可以以后作为显式 opt-in 功能设计。

关闭条件：

- fake server 全绿。
- 至少 TypeScript 真实 server smoke 在本地通过，并记录证据。
- macOS/Windows 下 server 启动与关闭路径通过。

### LSP-60：工具链集成和可观测性

目标：

- RuntimeLogger 增加 LSP 事件：
  - `lsp.server.start`
  - `lsp.server.ready`
  - `lsp.server.exit`
  - `lsp.server.restart`
  - `lsp.request.start`
  - `lsp.request.done`
  - `lsp.request.timeout`
  - `lsp.document.open`
  - `lsp.document.change`
- 日志字段带上 `sessionId`、`submitId`、`toolCallId`、`lspServerId`、`requestId`。
- TUI 工具进度可显示：
  - `LSP starting typescript server`
  - `LSP indexing workspace`
  - `LSP request hover`

测试：

- debug 日志下能串起一次 LSP 请求。
- 日志不泄漏源码全文，只记录路径、语言、耗时、结果数量。
- 关闭日志时不产生文件，不影响热路径。

关闭条件：

- `DEEPICODE_LOG_LEVEL=debug` 下完成一次 LSP hover，日志可读。
- `DEEPICODE_LOG_LEVEL=off` 下不产生日志文件。

---

## 6. 安全边界

1. LSP command 只能来自 `.deepicode/lsp.json` 或显式环境配置，不从 package script 自动推断执行。
2. 不使用 shell 拼接命令；必须 `spawn(command, args)`。
3. `file_path` 必须 resolve 到 workspace 内，拒绝敏感路径和路径穿越。
4. 不发送 `.env`、密钥、证书等敏感文件内容给 language server。
5. stderr 写入日志时必须截断。
6. `include_raw` 默认 false；开启时也必须走 `safeStringify()`。
7. `rename_preview` 只预览，不自动写盘。
8. server 崩溃后最多自动重启一次，避免 crash loop。
9. 所有超时必须有上限，默认 request timeout 8s，initialize timeout 10s。
10. 退出时必须关闭所有 LSP 子进程，不允许残留。

---

## 7. 测试矩阵

### 单元测试

- `protocol.test.ts`
- `lsp-config.test.ts`
- `lsp-language.test.ts`
- `lsp-normalize.test.ts`
- `lsp-client.test.ts`
- `lsp-manager.test.ts`
- `lsp-tool.test.ts`

### 集成测试

- fake server:
  - hover
  - definition
  - references
  - diagnostics
  - completion
  - rename_preview
  - timeout
  - crash
  - malformed frame
- 从 opencode 移植 fake server 时，要改成 Deepicode fixture 路径和测试工具，不依赖 opencode workspace alias。
- real server smoke:
  - TypeScript 必跑条件：`DEEPICODE_LSP_REAL=1` 且 server 可执行。
  - Python/Go/Rust 可选。

### 回归测试

- 当前 `workflow-agent-send-lsp.test.ts` 的 hover 测试必须继续通过。
- OS-16 的进程树终止语义必须继续成立。
- 全量 `bun test` 不得出现残留 handle 或 hang。

### 手工验收

在一个真实 TypeScript 项目中：

1. 配置 `.deepicode/lsp.json`。
2. 对已知函数执行 `hover`，返回类型信息。
3. 对 import symbol 执行 `definition`，跳到真实文件。
4. 执行 `references`，返回多个引用且路径正确。
5. 故意制造 TS 错误，执行 `diagnostics`，能看到错误位置和 message。
6. 修改文件后再次执行 `diagnostics`，旧错误消失或新错误出现。
7. 连续执行 5 次 LSP 请求，确认 server 被复用。
8. 退出 Deepicode 后确认无 language server 残留进程。

---

## 8. 开发注意事项

- 先做 fake server 全覆盖，再接真实 language server。
- 长驻 manager 是关键，不要继续堆一次性 `runLspRequest()`。
- 不要把 LSP 返回直接丢给模型；必须标准化、截断、摘要。
- 不要为了“完整”引入大型第三方 LSP client，除非它能明确降低维护成本且不破坏 Bun/Node 兼容。
- 允许引入 `vscode-jsonrpc` / `vscode-languageserver-types` 这种轻量协议依赖；不要引入 opencode 的 `effect` 服务框架。
- 直接复制 opencode 代码时必须处理 MIT 许可标注；按行为重写时在提交说明中说明参考来源即可。
- 禁止为了复用 opencode 而修改 Deepicode 的工具注册、Core loop、TUI 架构。
- 每个阶段都要保持 `bun run typecheck` 和相关测试通过。
- 任何涉及 server 生命周期的改动，都要跑全量 `bun test`，防止残留 handle。

---

## 9. 建议领取顺序

1. `LSP-10`：配置、语言识别、返回标准化。
2. `LSP-20`：协议层和长驻 client。
3. `LSP-30`：manager 和文档同步。
4. `LSP-40`：完整 action 集。
5. `LSP-50`：真实语言服务器 smoke。
6. `LSP-60`：日志、进度和验收。

每次只领取一个阶段。阶段完成后，把已实现内容迁移到 `DONE.md`，把剩余阶段或新发现问题写入 `TODO.md`。
