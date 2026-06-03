# Deepicode LSP、Plugin、Status 与 Context 专项实现设计

最后更新：2026-06-03

本文记录四个下一阶段专项方案：

1. **LSP**：从最小可用实现升级为完整工程能力。
2. **Plugin**：增加与 opencode server plugin 形态兼容的扩展系统。
3. **Status**：增加类似 Codex `/status` 的运行状态卡片。
4. **Context**：保留现有裁剪能力，增加可选摘要压缩能力和 `/context` 配置菜单。

当前项目总待办仍以 [TODO.md](TODO.md) 为准；已完成能力和历史结论见 [DONE.md](DONE.md)；验收步骤见 [TEST.md](TEST.md)。

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

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/tools/src/lsp/config.ts`：配置读取、合并和校验，支持旧格式兼容
- `packages/tools/src/lsp/language.ts`：语言识别，支持 80+ 文件扩展名
- `packages/tools/src/lsp/normalize.ts`：返回格式标准化，支持 Location/Hover/Diagnostic/Completion/Symbol/SignatureHelp/RenameEdit
- `packages/tools/src/lsp/index.ts`：模块导出
- `packages/tools/src/lsp.ts`：升级为使用新模块，支持 14 个 actions
- `packages/tools/src/lsp-client.ts`：支持 query、new_name 参数
- `packages/tools/__tests__/lsp-modules.test.ts`：36 个单元测试覆盖 config、language、normalize

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

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/tools/src/lsp/lsp-client.ts`：基于 vscode-jsonrpc 的 LspClient 类
- `packages/tools/src/lsp/index.ts`：新增 LspClient 导出
- `packages/tools/__tests__/lsp-client.test.ts`：11 个单元测试覆盖 start、initialize、hover、definition、references、timeout、crash、shutdown、health、concurrent requests
- `packages/tools/package.json`：新增 vscode-jsonrpc 依赖

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

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/tools/src/lsp/manager.ts`：LspManager 类，支持 server 复用、文档同步、idle timeout 清理
- `packages/tools/src/lsp/index.ts`：新增 LspManager 导出
- `packages/tools/__tests__/lsp-manager.test.ts`：12 个单元测试覆盖 server 复用、文档同步、health status、shutdown

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

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/tools/src/lsp.ts`：支持 14 个 actions + 5 个别名（goToDefinition、findReferences、goToImplementation、documentSymbol、workspaceSymbol）
- `packages/tools/__tests__/lsp-actions.test.ts`：28 个单元测试覆盖所有 actions 和错误处理

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

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/tools/__tests__/lsp-real-servers.test.ts`：真实语言服务器 smoke tests
- 支持 TypeScript、Python、Go、Rust 四种语言
- 使用 `DEEPICODE_LSP_REAL=1` 环境变量启用
- 缺少依赖时自动 skip
- 14 个测试覆盖 start、hover、definition、diagnostics、shutdown

### LSP-60：工具链集成和可观测性

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/tools/src/lsp/logger.ts`：LspLogger 类，封装 RuntimeLogger
- 支持 9 种 LSP 事件：server.start/ready/exit/restart, request.start/done/timeout, document.open/change
- 日志字段带 sessionId、submitId、toolCallId、lspServerId、requestId
- 不记录源码内容，只记录路径、语言、耗时、结果数量
- `@deepicode/core` 导出 RuntimeLogger
- 12 个单元测试覆盖所有事件类型、上下文继承、安全字段

测试：

- debug 日志下能串起一次 LSP 请求。
- 日志不泄漏源码全文，只记录路径、语言、耗时、结果数量。
- 关闭日志时不产生文件，不影响热路径。

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

---

# Deepicode Plugin 兼容实现专项设计

## 10. 当前结论

Deepicode 目前没有真正的 plugin runtime，但已经具备几个底层接入点：

- `packages/tools/src/registry.ts`：支持注册 `AgentTool`。
- `packages/security/src/hooks.ts`：已有 `beforeToolCall`、`afterToolCall`、`onLoopEvent`。
- `packages/cli/src/tui.ts`：CLI 启动时集中创建 engine、注册工具、启动 MCP。
- `packages/mcp/`：已有外部工具扩展机制，但它是 MCP server，不是本地 plugin。
- `packages/tools/src/skills/`：已有静态 skill 系统，但不能动态注册工具或 hook。

目标不是复制 opencode 的整个 plugin runtime，而是做一个 **Deepicode 原生 runtime + opencode server plugin 兼容层**。

## 11. opencode Plugin 复用结论

`/vol4/Agent/opencode` 有两类 plugin：

1. Server plugin：用于注册工具、hook、provider/auth 等。
2. TUI plugin：用于路由、slots、keymap、theme、dialog 等前端扩展。

Deepicode 第一阶段只实现 **server plugin 兼容子集**。不要引入 opencode 的 TUI plugin runtime，也不要引入 opentui/solid 前端体系。

### 11.1 可以参考的 opencode 文件

- `/vol4/Agent/opencode/packages/plugin/src/index.ts`
- `/vol4/Agent/opencode/packages/plugin/src/tool.ts`
- `/vol4/Agent/opencode/packages/plugin/src/example.ts`
- `/vol4/Agent/opencode/packages/opencode/src/config/plugin.ts`
- `/vol4/Agent/opencode/packages/opencode/src/plugin/loader.ts`
- `/vol4/Agent/opencode/packages/opencode/src/plugin/shared.ts`
- `/vol4/Agent/opencode/packages/opencode/src/plugin/index.ts`
- `/vol4/Agent/opencode/packages/opencode/test/cli/tui/plugin-loader-entrypoint.test.ts`
- `/vol4/Agent/opencode/packages/opencode/test/cli/tui/plugin-lifecycle.test.ts`

可复用设计：

1. plugin spec 支持 file path、file URL、npm package spec。
2. 配置项支持字符串或 `[spec, options]`。
3. file plugin 的相对路径按声明配置文件所在目录解析。
4. npm plugin 可按 package entrypoint 解析。
5. `default export { id, server }` 的 v1 plugin 形态。
6. 插件按配置顺序初始化，hook 执行顺序稳定。
7. 插件加载失败要隔离，不影响 Deepicode 主流程启动。
8. plugin id 去重，重复 id 不能覆盖已加载插件。

### 11.2 禁止直接引入的内容

不要引入：

- opencode `Effect` / `Layer` / `Context.Service`
- opencode `Bus`
- opencode SDK client 完整对象
- opencode provider/auth 插件体系
- opencode workspace adapter
- opencode TUI route/slot/theme/keymap runtime
- `@opencode-ai/plugin/tui`
- opentui/solid 前端依赖

原因：Deepicode 当前是 Bun + TypeScript workspace，核心执行模型是 `ReasonixEngine` + `AgentTool` + `HookManager`。直接移植 opencode runtime 会改变架构重心，收益不如风险。

## 12. Plugin 目标与非目标

### 必须达到

1. 支持从 `.deepicode/plugins.json` 或主配置读取 plugin 列表。
2. 支持本地 file plugin。
3. 支持 npm plugin spec 的解析，但第一阶段不自动安装。
4. 支持 opencode v1 server plugin 的核心子集：
   - `tool`
   - `event`
   - `tool.execute.before`
   - `tool.execute.after`
   - `permission.ask` 的只读兼容或映射
   - `config`
5. plugin tool 能转换成 Deepicode `AgentTool` 并注册到 engine。
6. plugin hooks 能接入 Deepicode `HookManager`。
7. plugin runtime 有明确生命周期：
   - `load`
   - `activate`
   - `deactivate`
   - `dispose`
8. plugin 加载、执行、失败都有结构化日志。
9. plugin 默认关闭危险能力，不允许绕过权限系统。
10. plugin 失败不导致 Deepicode 主流程崩溃，除非显式设置 strict mode。

### 暂不实现

- TUI plugin route/slot/theme/keymap。
- provider/auth 插件。
- workspace adapter。
- 自动 npm install。
- remote plugin registry。
- 插件热更新。
- 插件沙箱隔离进程。
- 让 plugin 修改 system prompt。
- 让 plugin 直接访问模型 client。

## 13. 建议模块边界

新增包：

```text
packages/plugin/
  package.json
  tsconfig.json
  src/
    config.ts              # 读取 .deepicode/plugins.json，解析 spec/options/enabled
    shared.ts              # spec/path/package 解析，参考 opencode plugin/shared.ts
    loader.ts              # resolve + import plugin module
    runtime.ts             # PluginRuntime 生命周期和状态
    opencode-v1.ts         # opencode v1 server plugin 兼容读取和校验
    tool-adapter.ts        # opencode tool -> Deepicode AgentTool
    hook-adapter.ts        # opencode hook -> Deepicode HookManager
    api.ts                 # Deepicode plugin input API
    types.ts
    index.ts
```

CLI 接入点：

```text
packages/cli/src/tui.ts
```

启动顺序建议：

1. `loadConfig()`
2. 创建 `McpHost`
3. 创建 `ReasonixEngine`
4. 注册内置工具
5. 注册 MCP 基础工具
6. 创建并初始化 `PluginRuntime`
7. 注册 plugin tools
8. 注册 plugin hooks
9. 进入 pipe mode 或 TUI mode
10. finally 中 `pluginRuntime.dispose()`，再 shutdown engine 和 MCP

如果当前 engine 没有暴露 hook manager 注册入口，先新增窄接口，不要把 plugin runtime 塞进 core loop：

```ts
engine.addHooks(hooks)
engine.removeHooks(hooks)
```

## 14. 配置格式

第一阶段使用 `.deepicode/plugins.json`：

```json
{
  "version": 1,
  "strict": false,
  "plugins": [
    "./plugins/demo.ts",
    ["./plugins/audit.ts", { "level": "debug" }],
    {
      "spec": "./plugins/tools.ts",
      "enabled": true,
      "options": {}
    }
  ]
}
```

规则：

- 字符串等价于 `{ "spec": "...", "enabled": true }`。
- tuple 等价于 `{ "spec": "...", "enabled": true, "options": ... }`。
- object 是推荐格式。
- 相对路径按 `.deepicode/plugins.json` 所在目录解析。
- `file://`、绝对路径、相对路径都允许。
- npm spec 第一阶段只解析并报 `npm_plugin_not_installed`，不自动安装。
- `strict: true` 时，plugin 加载失败让 CLI 启动失败；默认 `false` 只记录错误并跳过。

后续可以把 plugin 配置合入主 config，但第一阶段先独立文件，降低和现有 config 的耦合。

## 15. 兼容的 Plugin 形态

支持 opencode v1 server plugin：

```ts
import { tool } from "@opencode-ai/plugin"

export default {
  id: "demo.plugin",
  server: async (ctx, options) => {
    return {
      tool: {
        hello: tool({
          description: "Say hello",
          args: {
            name: tool.schema.string().describe("Name")
          },
          async execute(args, context) {
            return `Hello ${args.name}`
          }
        })
      },
      async "tool.execute.before"(input, output) {
        // may mutate output.args
      },
      async "tool.execute.after"(input, output) {
        // may inspect output
      },
      async event({ event }) {
        // observe Deepicode loop events
      }
    }
  }
}
```

Deepicode 自有 plugin 也可以使用同样形态，但推荐以后发布 `@deepicode/plugin` 类型包，避免开发者必须依赖 `@opencode-ai/plugin`。

第一阶段为了兼容现有 opencode plugin，可以支持两种导出：

```ts
export default { id, server }
```

以及 legacy：

```ts
export async function MyPlugin(ctx, options) {
  return {}
}
```

legacy 支持优先级低；如果实现复杂，可以只支持 default object。

## 16. Tool 适配

opencode tool 的返回：

```ts
type ToolResult =
  | string
  | {
      title?: string
      output: string
      metadata?: Record<string, any>
      attachments?: ToolAttachment[]
    }
```

Deepicode `AgentTool.execute()` 需要返回当前项目约定的 tool result。适配要求：

1. opencode `description` 映射到 `AgentTool.description`。
2. opencode `args` 使用 zod schema，Deepicode 当前工具参数是 JSON Schema；需要实现 `zodToJsonSchema` 或只支持可转换基础类型。
3. plugin tool name 必须加命名空间，避免覆盖内置工具：

```text
plugin__<pluginIdSanitized>__<toolName>
```

4. 对模型展示时可以把 title 保留为原始工具名：

```text
demo.plugin/hello
```

5. plugin tool 的权限 tier 默认是 `exec`，除非插件显式声明只读。
6. plugin tool 永远走 Deepicode `PermissionEngine` 和 `HookManager`，不能因为来自 plugin 就跳过权限。
7. plugin tool 参数和结果必须走 `safeStringify()` 截断。
8. attachment 第一阶段可以忽略或转换成 metadata，不进入上下文正文。

如果 zod schema 转 JSON Schema 工作量过大，第一阶段限制 schema 能力：

- `string`
- `number`
- `boolean`
- `array`
- `object`
- `enum`
- `optional`
- `describe`

遇到无法转换的 schema，plugin tool 加载失败，但不影响其他 plugin。

## 17. Hook 适配

Deepicode 已有：

```ts
beforeToolCall(context): Promise<"allow" | "deny" | void>
afterToolCall(toolName, result): Promise<void>
onLoopEvent(event): Promise<void>
```

映射：

| opencode hook | Deepicode 映射 | 第一阶段行为 |
| --- | --- | --- |
| `event` | `onLoopEvent` | 传入 Deepicode LoopEvent 的兼容对象 |
| `tool.execute.before` | `beforeToolCall` | 允许修改 args；返回 deny/allow 映射权限 |
| `tool.execute.after` | `afterToolCall` | 可观察结果；是否允许修改结果需单独设计 |
| `permission.ask` | `beforeToolCall` 附加阶段 | 只允许把 ask 改为 deny/allow，不允许直接弹自定义 UI |
| `config` | plugin 初始化后调用 | 传 Deepicode config 的兼容子集 |
| `chat.params` | 暂不支持 | 记录 unsupported hook |
| `chat.headers` | 暂不支持 | 记录 unsupported hook |
| `command.execute.before` | 暂不支持 | 等 slash command 架构稳定后再做 |
| `shell.env` | 暂不支持 | 后续可接入 shell backend |

关键要求：

- before hook 抛错时 fail-safe：拒绝该工具调用。
- after/event hook 抛错时只记录日志，不中断主流程。
- hook 执行必须有超时，默认 3s。
- hook 顺序按 plugin 配置顺序稳定执行。
- plugin deactivate 后必须移除对应 hooks。

## 18. Plugin API

传给 plugin 的 `ctx` 不要模拟完整 opencode SDK，只提供兼容子集：

```ts
interface DeepicodePluginInput {
  directory: string;
  worktree: string;
  project: {
    id: string;
    directory: string;
  };
  client: {
    // 第一阶段只提供最小只读能力，避免插件控制 session
  };
  serverUrl: URL;
  experimental_workspace: {
    register(): void; // 第一阶段 no-op + warning
  };
  $?: unknown; // 第一阶段不提供 Bun.$，避免任意 shell 便利入口
}
```

原则：

- 不给 plugin 直接访问 engine 内部对象。
- 不给 plugin 直接注册 system prompt。
- 不给 plugin 直接改模型请求。
- 需要能力时通过明确 API 逐个开放。

## 19. 安全边界

1. 默认只加载 workspace 明确配置的 plugin。
2. 不扫描任意目录自动加载 plugin。
3. npm plugin 第一阶段不自动安装。
4. file plugin 必须 resolve 到 workspace 内，除非用户显式设置 `allowExternalPluginPaths: true`。
5. plugin tool 默认按 exec 权限处理。
6. plugin 不能覆盖内置工具名。
7. plugin 不能注册以 `mcp__`、`system__`、`deepicode__` 开头的保留工具名。
8. plugin import 失败、shape 错误、schema 转换失败都要隔离。
9. plugin hook timeout 必须可配置且有上限。
10. 日志中不要打印 plugin options 的敏感字段。

## 20. 可观测性

RuntimeLogger 增加事件：

- `plugin.config.load`
- `plugin.resolve.start`
- `plugin.resolve.done`
- `plugin.resolve.error`
- `plugin.load.start`
- `plugin.load.done`
- `plugin.load.error`
- `plugin.activate.done`
- `plugin.deactivate.done`
- `plugin.dispose.done`
- `plugin.tool.register`
- `plugin.tool.execute.start`
- `plugin.tool.execute.done`
- `plugin.hook.start`
- `plugin.hook.done`
- `plugin.hook.error`
- `plugin.hook.timeout`

字段：

- `pluginId`
- `pluginSpec`
- `pluginSource`
- `pluginPath`
- `hookName`
- `toolName`
- `durationMs`
- `errorClass`
- `strict`

`DEEPICODE_LOG_LEVEL=off` 时不能产生 plugin 日志文件，也不能明显拖慢工具执行。

## 21. 实施阶段

### PLG-10：配置与 spec 解析

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/plugin`：新建 plugin 包
- `packages/plugin/src/config.ts`：`.deepicode/plugins.json` 读取
- 支持 string、tuple、object 三种配置项
- 支持相对路径、绝对路径、file URL
- npm spec 只解析，不安装
- 实现 duplicate spec 和 duplicate id 的错误分类
- 18 个单元测试覆盖所有配置场景

测试：

- 相对路径按配置文件目录解析。
- disabled plugin 不加载。
- malformed config 返回结构化错误。
- npm spec 返回 `npm_plugin_not_installed`。
- strict false 跳过错误，strict true 抛错。

### PLG-20：loader 与 v1 server plugin shape

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/plugin/src/loader.ts`：增强 loader 支持 server() 调用和 hooks 验证
- 识别 `default export { id, server }`
- 校验 id、server 函数、返回 hooks 对象（所有值必须是函数）
- 加载顺序稳定
- 加载失败隔离
- 21 个单元测试覆盖所有场景

测试：

- 成功加载本地 plugin。
- 缺 id 的 file plugin 失败。
- server 不是函数失败。
- server 抛错被隔离。
- server 返回非对象被拒绝。
- server 返回对象包含非函数值被拒绝。
- 两个 plugin id 重复时后者失败。

### PLG-30：tool adapter

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/plugin/src/tool-adapter.ts`：plugin tool 提取和执行
- 支持 opencode `tool()` 定义
- 转换 zod schema 到 JSON Schema 基础子集（string/number/boolean/object/enum/array）
- 注册 plugin tools 到 `ReasonixEngine`
- 工具名命名空间化（`pluginId.hookName`）
- 执行结果转换为 Deepicode tool result
- 9 个单元测试覆盖所有场景

测试：

- plugin tool 出现在 tool specs。
- string/number/boolean/object/enum schema 转换正确。
- plugin tool execute 返回 string。
- plugin tool execute 返回 `{ title, output, metadata }`。
- 无法转换 schema 的 tool 被跳过并记录错误。
- plugin tool 不能覆盖内置工具。

### PLG-40：hook adapter

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/plugin/src/hook-adapter.ts`：PluginHookRegistry 类
- 映射 `event` 到 `HookManager.onLoopEvent`
- 映射 `tool.execute.before` 到 before hook
- 映射 `tool.execute.after` 到 after hook
- 支持 hook timeout（默认 5000ms，可配置）
- deactivate/dispose 时移除 hooks
- 10 个单元测试覆盖所有场景

测试：

- before hook 可 deny。
- before hook 可修改 args。
- before hook 抛错时 deny。
- after hook 抛错不影响主流程。
- event hook 收到 LoopEvent。
- dispose 后 hook 不再触发。

### PLG-50：CLI 集成和生命周期

**状态：✅ 已完成（2026-06-03）**

实现内容：

- `packages/plugin/src/runtime.ts`：PluginRuntime 类
- 在 CLI 启动时初始化 `PluginRuntime`
- pipe mode 和 TUI mode 共用 plugin runtime
- finally 中 dispose
- `--help` 不加载 plugin（由调用方控制）
- `DEEPICODE_PURE=1` 或 `--pure` 跳过 plugin（由调用方控制）
- 7 个单元测试覆盖所有场景

测试：

- pipe mode 可以调用 plugin tool。
- TUI mode 启动不因 plugin 加载失败崩溃。
- `--pure` 不加载 plugin。
- dispose 被调用。
- plugin runtime 不造成 pipe mode 不退出。

### PLG-60：文档和验收

目标：

- 更新 README plugin 配置说明。
- 增加 `examples/plugins/hello.ts`。
- 增加 `examples/plugins/audit.ts`。
- 更新 TEST.md 的 plugin 验收项。

测试：

- 示例 plugin 可被测试加载。
- 用户能按文档写出一个 hello tool。

## 22. 测试矩阵

单元测试：

- `plugin-config.test.ts`
- `plugin-shared.test.ts`
- `plugin-loader.test.ts`
- `plugin-tool-adapter.test.ts`
- `plugin-hook-adapter.test.ts`
- `plugin-runtime.test.ts`

集成测试：

- `plugin-cli-pipe.acceptance.test.ts`
- `plugin-runtime-lifecycle.acceptance.test.ts`

必须覆盖：

- 正常加载。
- 加载失败。
- duplicate id。
- disabled plugin。
- strict mode。
- tool schema 转换。
- before/after/event hook。
- dispose 无残留。
- `DEEPICODE_LOG_LEVEL=off` 不产生 plugin 日志。

## 23. 开发注意事项

- 第一阶段不要实现 TUI plugin。
- 第一阶段不要自动 npm install。
- 第一阶段不要 provider/auth。
- 不要为了兼容 opencode plugin 而引入 opencode runtime。
- 不要把 plugin runtime 放进 core loop；它应该在 CLI/应用层装配。
- 所有 plugin tool 和 hook 都必须走 Deepicode 权限、日志和错误隔离。
- 每个阶段完成后更新 `DONE.md`；未完成或新发现问题更新 `TODO.md`。

## 24. Plugin 建议领取顺序

1. `PLG-10`：配置与 spec 解析。
2. `PLG-20`：loader 与 v1 server plugin shape。
3. `PLG-30`：tool adapter。
4. `PLG-40`：hook adapter。
5. `PLG-50`：CLI 集成和生命周期。
6. `PLG-60`：文档、示例和验收。

每次只领取一个阶段。优先保证 typecheck 和 plugin 单测通过，再跑全量 `bun test`。

---

# Deepicode /status 状态卡片专项设计

## 25. 当前结论

Deepicode 目前没有 `/status` slash command。现有状态信息分散在多个位置：

- `packages/tui/src/StatusBar.tsx`：底部状态栏已有 model、provider、agent、token、context、cwd。
- `packages/tui/src/App.tsx`：掌握当前 provider/model/agent/thinkingMode/tier 和 slash command 路由。
- `packages/tui/src/commands.ts`：纯 slash command 解析。
- `packages/core/src/engine.ts`：掌握 sessionId、stats、ContextManager、PermissionEngine、currentAgent、tier。
- `packages/core/src/context/manager.ts`：已有 `getBudget()` 和 `getContextWindow()`。

因此 `/status` 不应该只在 TUI 拼字符串。正确做法是先让 Core 暴露一个稳定的运行状态快照，再由 TUI 渲染成 Codex 风格卡片。

## 26. Codex 参考实现结论

Codex 的 `/status` 主要参考：

- `/vol4/Agent/codex/codex-rs/tui/src/status/card.rs`
- `/vol4/Agent/codex/codex-rs/tui/src/chatwidget/slash_dispatch.rs`
- `/vol4/Agent/codex/codex-rs/tui/src/chatwidget/tests/status_command_tests.rs`
- `/vol4/Agent/codex/codex-rs/tui/src/chatwidget/tests/status_and_layout.rs`

可借鉴设计：

1. `/status` 先把用户命令作为历史项显示，再插入一个状态卡片。
2. 卡片用统一字段 formatter，左侧 label 对齐，右侧 value 自适应宽度。
3. 字段按数据是否存在动态显示。
4. context window 使用运行时上下文窗口，不使用配置原始值。
5. 状态卡片是历史消息的一部分，不是临时 overlay。
6. rate limit 可异步刷新；Deepicode 第一阶段不做远程刷新，只显示本地可得信息。

不直接复用 Codex Rust 代码，只复刻信息结构和视觉风格。

## 27. 目标效果

用户输入：

```text
/status
```

Deepicode 应在消息历史中插入类似：

```text
╭────────────────────────────────────────────────────────────────────────────────╮
│  >_ Deepicode (v0.1.0)                                                        │
│                                                                                │
│  Model:                deepseek-chat (provider DeepSeek, thinking off)          │
│  Directory:            /vol4/Agent/deepicode                                   │
│  Permissions:          ask exec / allow read-write                             │
│  Agents.md:            <none>                                                  │
│  Account:              API key configured                                      │
│  Agent:                Build Agent                                             │
│  Strategy tier:         <current tier label>                                    │
│  Session:              019e7de2-2432-7631-beae-a0af482bfe14                    │
│                                                                                │
│  Context window:       30% left (184K used / 258K)                              │
│  Token usage:          input 12K / output 3K / cache hit 64%                    │
╰────────────────────────────────────────────────────────────────────────────────╯
```

字段名和颜色可按 Deepicode 风格调整，但布局必须接近 Codex：边框、标题、空行、label 对齐、context window 总结。

## 28. 必须显示的字段

第一阶段字段：

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| App title/version | package version 或常量 | `Deepicode (v0.1.0)` |
| Model | 当前 `activeModel` + provider label | 包含 thinking mode |
| Directory | `process.cwd()` | 需要压缩长路径 |
| Permissions | Core 状态快照 | 初期可显示 `deny → allow → ask; exec asks` |
| Agents.md | workspace 探测 | 找不到显示 `<none>` |
| Account | config/env 状态 | 不显示 API key，只显示 `API key configured` 或 `<not configured>` |
| Agent | 当前 agent label | Build / Plan |
| Strategy tier | engine `getTier()` | 有则显示 |
| Session | engine sessionId | 必须从 Core 暴露 |
| Context window | `ContextManager.getBudget()` | 显示 left%、used、total |
| Token usage | engine stats + bridge tokens | 至少 prompt/output/cache hit |

第二阶段可选字段：

- MCP 状态
- Plugin 状态
- LSP server 状态
- Git branch / dirty summary
- Runtime log path
- Config path
- OS platform / shell backend

不要第一阶段塞太多字段，先把 Codex 核心状态卡片做稳。

## 29. 架构方案

### 29.1 Core 状态快照

新增类型：

```ts
export interface EngineStatusSnapshot {
  app: {
    name: "Deepicode";
    version: string;
  };
  model: {
    provider: string;
    providerLabel: string;
    model: string;
    thinkingMode: string;
    tier?: { id: string; label: string };
  };
  workspace: {
    cwd: string;
    agentsMd: string[];
  };
  permissions: {
    summary: string;
  };
  session: {
    id: string;
  };
  context: {
    usedTokens: number;
    totalTokens: number;
    leftRatio: number;
  };
  usage: {
    promptTokens: number;
    completionTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    apiCalls: number;
    toolCalls: number;
    totalCost: number;
  };
}
```

在 `ReasonixEngine` 新增：

```ts
async getStatusSnapshot(input?: {
  providerLabel?: string;
  thinkingMode?: string;
  cwd?: string;
}): Promise<EngineStatusSnapshot>
```

实现要求：

- `session.id` 来自私有 `sessionId`，不要让 TUI 读 private 字段。
- `context` 来自 `ctx.getBudget()`，不是 `config.contextWindow`。
- `usage` 来自 `this.stats`。
- `agentsMd` 扫描顺序：
  1. `<cwd>/AGENTS.md`
  2. `<cwd>/CLAUDE.md` 可选显示为 `CLAUDE.md`
  3. 没有则 `<none>`
- `account` 不放入 Core 第一版；由 TUI 根据 config/env 组装，避免 Core 接触 UI 文案。

如果 `getBudget()` 需要 tokenizer，`/status` 可以是 async command。TUI 里追加一个 “loading status...” 临时消息不是必须；优先直接 await 后插入卡片。

### 29.2 TUI command 路由

修改 `packages/tui/src/commands.ts`：

- `SlashCommand` 增加 `{ name: "status" }`。
- `parseSlashCommand()` 支持 `/status`。
- `buildHelpText()` 增加 `/status` 说明。
- `commands.test.ts` 增加解析和 help 覆盖。

修改 `packages/tui/src/App.tsx`：

- 在 `handleSubmit()` 中处理 `command?.name === "status"`。
- 调用 `engineRef.current.getStatusSnapshot(...)`。
- 通过 `appendMessage({ role: "assistant", content })` 插入状态卡片。
- `/status` 不应调用 `bridge.submit()`，不能向模型发请求。
- `/status` 执行期间不应改变 `isLoading`，不应进入 messageQueue。

### 29.3 状态卡片渲染

新增：

```text
packages/tui/src/status/
  format.ts        # 纯格式化：字段对齐、数字缩写、路径压缩
  StatusCard.tsx   # Ink 组件，可选
```

第一阶段建议先用纯文本输出，减少 Ink 历史消息渲染复杂度：

```ts
export function formatStatusCard(snapshot: StatusCardInput, width = 80): string
```

原因：当前 `appendMessage()` 走 Markdown/消息渲染路径，纯文本卡片最容易保持为历史消息，不需要新增 timeline item 类型。

卡片格式要求：

- 默认宽度 80。
- 使用 Unicode box drawing：`╭─╮│╰─╯`。
- label 宽度由最长 label 计算，但设置上限，避免极长 label 破坏布局。
- value 超长时截断，末尾使用 `…`。
- Windows 终端若出现显示问题，提供 ASCII fallback：

```ts
DEEPICODE_STATUS_ASCII=1
```

格式 helper：

- `formatTokenCount(184000) -> "184K"`
- `formatPercentLeft(used, total) -> "30% left"`
- `formatContextWindow(used, total)`
- `formatPath(path, maxWidth)`
- `formatCacheRate(hit, miss)`
- `formatStatusRows(rows, width)`

## 30. 数据来源细节

### 30.1 Model

优先使用 TUI 当前状态：

- `activeProvider`
- `providerLabel`
- `activeModel`
- `bridgeState.thinkingMode`
- `engine.getTier?.()?.label`

原因：用户可能刚用 `/model` 切换，TUI state 最接近当前显示状态。

### 30.2 Permissions

第一阶段不要展开完整 permission rules。显示稳定摘要：

```text
deny rules active; read/write allowed by tier; exec asks
```

如果后续 `PermissionEngine` 暴露 `getSummary()`，再显示：

```text
2 deny / 1 allow / exec asks
```

### 30.3 Account

不泄漏 API key。根据当前 provider config：

- env 或 config 存在 key：`API key configured`
- 使用默认 key：`default key`
- 无 key：`<not configured>`

不要显示邮箱，Deepicode 当前没有账号系统。

### 30.4 Context window

必须使用：

```ts
const budget = await engine.getContextManager().getBudget()
```

或者封装后的 `engine.getStatusSnapshot()`。

计算：

```ts
used = budget.totalTokens
total = budget.window
left = Math.max(0, 1 - used / total)
```

显示：

```text
30% left (184K used / 258K)
```

### 30.5 Session

当前 `ReasonixEngine.getState()` 已包含 `sessionId`，但 `/status` 不应为了获取 session 构造完整 messages。推荐新增轻量：

```ts
getSessionId(): string
```

或者只通过 `getStatusSnapshot()` 返回。

## 31. 实施阶段

### STAT-10：Core 状态快照

目标：

- 新增 `EngineStatusSnapshot` 类型。
- `ReasonixEngine` 新增 `getStatusSnapshot()`。
- 从 `ContextManager.getBudget()` 读取真实 context。
- 不改变现有 `submit()` 行为。

测试：

- sessionId 返回当前 session。
- context 使用 runtime window。
- stats 从 engine stats 复制，不暴露引用。
- loadSession 后 status sessionId 更新。

目标测试：

```bash
bun test packages/core/__tests__/engine-status.test.ts
bun run typecheck
```

### STAT-20：Slash command 接入

目标：

- `parseSlashCommand()` 支持 `/status`。
- `/help` 显示 `/status`。
- `App.handleSubmit()` 拦截 `/status`，不调用模型。
- status 结果作为 assistant 历史消息插入。

测试：

- commands test 覆盖 `/status`。
- App/bridge 级测试确认 `/status` 不调用 `engine.submit()`。
- `/status` 不受 loading queue 影响；若正在生成中，建议仍显示当前快照，但不打断生成。

目标测试：

```bash
bun test packages/tui/__tests__/commands.test.ts
bun test packages/tui/__tests__/status-command.test.ts
```

### STAT-30：Codex 风格格式化

目标：

- 新增 `packages/tui/src/status/format.ts`。
- 生成 Codex 风格 box card。
- 宽度可配置，默认 80。
- 支持 Unicode 和 ASCII fallback。
- 格式化 context、tokens、path、cache rate。

测试：

- snapshot fixture 生成稳定快照。
- 宽度 80 下包含所有核心字段。
- 窄宽度下长路径被截断。
- ASCII fallback 不含 Unicode box drawing。
- context window 使用 `left% (used / total)` 形式。

目标测试：

```bash
bun test packages/tui/__tests__/status-format.test.ts
```

### STAT-40：文档和验收

目标：

- README 或 TEST.md 增加 `/status` 说明和验收步骤。
- `TODO.md` 增加/推进 `STAT-*` 当前阶段，完成后移入 `DONE.md`。

手工验收：

1. 启动 TUI。
2. 输入 `/status`。
3. 确认没有 API 请求。
4. 确认显示 model、cwd、permissions、session、context window。
5. 切换 `/model` 后再次 `/status`，确认 model 更新。
6. 恢复 `/sessions` 后再次 `/status`，确认 session 更新。

## 32. 安全与边界

- `/status` 只读，不应触发模型请求、工具执行或权限弹窗。
- 不显示 API key、auth token、环境变量值。
- 不读取大文件；`AGENTS.md` 只检测存在和路径，不读取全文。
- 不阻塞 TUI 超过 200ms；context budget 若慢，应显示可用字段并把 context 标记为 `calculating unavailable`，但第一阶段可直接 await。
- 不引入 Codex Rust 依赖，不复用 Codex 代码。
- 不把 `/status` 做成工具；它是本地 slash command。

## 33. 建议领取顺序

1. `STAT-10`：Core 状态快照。
2. `STAT-20`：Slash command 接入。
3. `STAT-30`：Codex 风格格式化。
4. `STAT-40`：文档和验收。

每次只领取一个阶段。完成后更新 `DONE.md` 和 `TODO.md`，并至少运行对应目标测试、`bun run typecheck`、`git diff --check`。

---

# Deepicode /context 上下文裁剪与压缩专项设计

## 34. 当前结论

Deepicode 现在已有上下文裁剪能力，但没有摘要式上下文压缩：

- `ContextManager` 使用 `ImmutablePrefix + AppendOnlyLog + VolatileScratch`。
- `truncateByRounds()` 按 user 轮次保留最近若干轮。
- `truncateToBudget()` 在超过窗口时删除旧消息，防止请求超窗。
- `getBudget()` 能计算 prefix/log/scratch/total/window/ratio。
- loop 层已有 fold/status 信号，但没有真正把旧历史总结成 summary。

用户目标是：

1. 保留现有裁剪功能。
2. 增加“压缩”功能：用模型把旧历史总结为摘要，替代被移除的旧消息。
3. 用户可以选择策略：裁剪或压缩。
4. 通过 `/context` 菜单配置。
5. 二级菜单配置两个百分比参数：
   - `70%`：达到上下文窗口 70% 时开始裁剪或压缩。
   - `30%`：裁剪或压缩后目标降到上下文窗口 30%。

核心设计：把“何时触发”和“触发后降到多少”从硬编码裁剪逻辑中抽出来，形成可配置的 ContextPolicy。

## 35. 设计目标

### 必须达到

1. 保留当前裁剪行为作为默认安全 fallback。
2. 新增策略：
   - `trim`：只裁剪，不摘要。
   - `compress`：优先摘要压缩，失败时裁剪。
3. 新增 `/context` 菜单。
4. `/context` 二级菜单支持配置：
   - strategy：`trim` / `compress`
   - triggerRatio：默认 `0.70`
   - targetRatio：默认 `0.30`
5. 配置变更立即作用于当前 session。
6. 可持久化到 `.deepicode/context.json` 或主 config。
7. 压缩摘要必须进入上下文，且明确标记为 summary，不伪装成用户/助手原始消息。
8. 压缩不能破坏 tool_call / tool result 对应关系。
9. 压缩失败不能阻塞主流程，必须 fallback 到裁剪。
10. 提供测试覆盖，保证不会出现无限压缩、重复摘要、上下文越压越大。

### 非目标

- 不实现向量数据库长期记忆。
- 不做跨 session 自动知识库。
- 不把压缩摘要写回所有历史 JSONL 替代原始消息。
- 不让压缩调用绕过用户选择。
- 不在每轮都压缩；只在达到 triggerRatio 时触发。
- 不压缩 `ImmutablePrefix` 和当前轮 `VolatileScratch`。

## 36. 策略模型

新增类型：

```ts
export type ContextPolicyMode = "trim" | "compress";

export interface ContextPolicy {
  mode: ContextPolicyMode;
  triggerRatio: number; // default 0.70
  targetRatio: number;  // default 0.30
  enabled: boolean;     // default true
}
```

默认配置：

```json
{
  "enabled": true,
  "mode": "trim",
  "triggerRatio": 0.7,
  "targetRatio": 0.3
}
```

校验规则：

- `0.10 <= targetRatio < triggerRatio <= 0.95`
- 推荐 UI 只开放常用选项：
  - trigger：`60%` / `70%` / `80%`
  - target：`20%` / `30%` / `40%`
- 初始默认使用用户指定的 `70% -> 30%`。
- 如果用户设置非法值，保持旧配置并显示错误。

## 37. Core 架构方案

### 37.1 ContextManager 职责拆分

当前 `prepareLog()` 直接执行：

```ts
truncateByRounds()
truncateToBudget()
```

建议改成：

```text
ContextManager
  ├─ buildMessages()
  ├─ getBudget()
  ├─ applyPolicy()
  ├─ trimToTarget()
  ├─ installSummary()
  └─ getCompressionCandidate()
```

新增内部概念：

```ts
interface ContextCompressionState {
  summaryMessages: ChatMessage[];
  lastCompressedAtMessageIndex: number;
  compressionCount: number;
}
```

摘要消息建议使用 `system` 或 `assistant`？

推荐使用 `system` 后缀消息，但必须放在 prefix 后、log 前，独立成 `summary` 区域更清晰：

```text
ImmutablePrefix
ContextSummary
AppendOnlyLog recent tail
VolatileScratch
```

新增第四区：

```text
packages/core/src/context/summary.ts
```

```ts
export class ContextSummary {
  messages: ChatMessage[];
  replace(summary: string, metadata: ContextSummaryMetadata): void;
  clear(): void;
}
```

消息形态：

```ts
{
  role: "system",
  content: [
    "Previous conversation summary:",
    summary,
    "",
    "This summary was generated to reduce context usage. Prefer recent messages when conflicts exist."
  ].join("\n")
}
```

原因：

- summary 不是用户输入，也不是模型本轮输出。
- 放在 system role 中更稳定提醒模型。
- 与 immutable prefix 分开，避免改变 prefix fingerprint 和 tool schema cache。

### 37.2 裁剪模式 trim

`trim` 模式保留当前语义，但参数化：

- 当 `budget.ratio < triggerRatio`：不处理。
- 当 `budget.ratio >= triggerRatio`：裁剪旧 log，直到 `totalTokens <= targetRatio * window`。
- 如果因 prefix/scratch 太大无法降到 targetRatio，只降到可达最小值，并记录 warning。

新增方法：

```ts
trimToTarget(targetTokens: number): ContextReductionResult
```

返回：

```ts
interface ContextReductionResult {
  mode: "trim" | "compress";
  beforeTokens: number;
  afterTokens: number;
  removedMessages: number;
  summaryTokens?: number;
  fallback?: boolean;
  warning?: string;
}
```

### 37.3 压缩模式 compress

触发条件：

- 当前策略 `mode === "compress"`。
- `budget.ratio >= triggerRatio`。
- 当前没有正在执行 compression。
- 有足够旧消息可压缩。
- 不能压缩当前 user turn 和未完成 tool 组。

候选范围：

- 从 log 最旧消息开始。
- 保留 recent tail，确保压缩后总量可降到 targetRatio。
- 候选必须按完整 user round 切分。
- 候选中如果包含 assistant tool_calls，必须包含对应 tool result；否则该边界不合法。

算法建议：

1. 计算 `targetTokens = window * targetRatio`。
2. 计算 `protectedTokens = prefix + summary + scratch + recentTailMinTokens`。
3. 从最旧轮开始选择 candidate，直到压缩后预计能接近 target。
4. 调用 summarizer 生成 summary。
5. 将原有 summary + candidate 一起总结成新 summary，避免 summary 越积越多。
6. 从 log 删除 candidate。
7. `ContextSummary.replace(newSummary)`。
8. 再执行一次 `trimToTarget()` 作为兜底。

### 37.4 Summarizer 设计

不要把压缩逻辑写死在 `ContextManager` 里。新增接口：

```ts
export interface ContextSummarizer {
  summarize(input: ContextSummarizeInput, signal?: AbortSignal): Promise<ContextSummarizeOutput>;
}

export interface ContextSummarizeInput {
  previousSummary?: string;
  messages: ChatMessage[];
  targetTokens: number;
  workspaceRoot: string;
}

export interface ContextSummarizeOutput {
  summary: string;
  inputTokens?: number;
  outputTokens?: number;
}
```

实现位置：

```text
packages/core/src/context/summarizer.ts
```

第一版实现：

- 使用当前 `DeepSeekClient`。
- 使用低温度。
- maxTokens 按 `targetTokens` 上限控制。
- 不携带 tools。
- 不写入普通 conversation log。
- 不触发 tool execution。
- 失败抛结构化错误，由 Engine fallback 到 trim。

摘要 prompt 要求：

```text
Summarize the older conversation for future continuation.
Keep:
- user goals and constraints
- files changed and reasons
- decisions made
- unresolved TODOs
- bugs found and fixes attempted
- commands/tests already run
Drop:
- repetitive logs
- raw tool output unless essential
- transient UI chatter
When conflicts exist, newer messages override older summary.
```

### 37.5 Engine 集成点

不要在 `buildMessages()` 内部发起模型压缩，因为 `buildMessages()` 当前是同步方法。推荐在 `ReasonixEngine.submit()` 开始前做 async policy：

```ts
await this.maybeReduceContext()
```

顺序：

1. 用户提交前或刚 append user message 后？
2. 推荐在 append 当前 user message 之前检查旧上下文。
3. 如果压缩发生，压缩旧历史；然后 append 当前 user message。

原因：当前用户输入应尽量保留原文，不参与刚触发的压缩。

伪流程：

```ts
async *submit(userInput: string) {
  await this.maybeReduceContext({ reason: "before_user_turn" });
  this.ctx.startTurn();
  this.ctx.log.append({ role: "user", content: userInput });
  ...
}
```

如果 append 后立刻超窗，再由现有 `truncateToBudget()` 兜底。

新增 Engine API：

```ts
getContextPolicy(): ContextPolicy;
setContextPolicy(policy: Partial<ContextPolicy>): void;
getContextStatus(): Promise<ContextPolicyStatus>;
runContextReduction(mode?: ContextPolicyMode): Promise<ContextReductionResult>;
```

`runContextReduction()` 供 `/context` 菜单里的“立即执行一次”使用，第一阶段可以不开放立即执行，只做配置。

## 38. TUI `/context` 菜单设计

### 38.1 Slash command

修改：

- `packages/tui/src/commands.ts`
- `packages/tui/src/CommandRegistry.ts`
- `packages/tui/src/App.tsx`

新增：

```ts
| { name: "context" }
```

`/help` 增加：

```text
/context    — configure context trimming/compression
```

### 38.2 菜单组件

新增：

```text
packages/tui/src/ContextMenu.tsx
```

交互要求：

一级菜单：

```text
Context management
❯ Mode: Trim only
  Mode: Compress summary
  Trigger at: 70%
  Reduce to: 30%
  Apply and close
  Cancel
```

也可以设计为二级菜单：

```text
/context
  Strategy
    Trim
    Compress
  Thresholds
    Trigger at 70%
    Reduce to 30%
```

用户明确要求“二级菜单是两个参数”，推荐实现为：

一级：

```text
Context
❯ Strategy: trim/compress
  Thresholds: 70% -> 30%
  Close
```

进入 `Thresholds` 后：

```text
Thresholds
❯ Start at: 70%
  Target:   30%
  Save
```

按键：

- ↑↓ 移动。
- Enter 进入或切换。
- Esc 返回上级；顶层 Esc 关闭。
- 左右键在百分比选项中切换。

### 38.3 用户可见文案

模式说明：

```text
Trim: remove oldest turns when context reaches 70%, down to 30%.
Compress: summarize oldest turns when context reaches 70%, down to 30%; falls back to trim if summarization fails.
```

状态显示：

```text
Current usage: 42% (54K / 128K)
Policy: compress at 70% -> 30%
```

配置成功后插入 assistant message：

```text
Context policy updated: compress at 70% -> 30%.
```

压缩发生时插入 warning/status 或 timeline event：

```text
Context compressed: 91K -> 38K, summarized 42 messages.
```

## 39. 配置持久化

第一阶段建议使用独立文件：

```text
.deepicode/context.json
```

格式：

```json
{
  "version": 1,
  "enabled": true,
  "mode": "trim",
  "triggerRatio": 0.7,
  "targetRatio": 0.3
}
```

理由：

- 不扩大现有 `DeepicodeConfig` 的加载风险。
- 方便单独测试。
- 用户可手动编辑。

后续可以合并进主 config。

新增模块：

```text
packages/core/src/context/policy.ts
packages/core/src/context/policy-store.ts
```

加载顺序：

1. 默认值。
2. `.deepicode/context.json`。
3. 环境变量覆盖：
   - `DEEPICODE_CONTEXT_MODE=trim|compress`
   - `DEEPICODE_CONTEXT_TRIGGER=0.7`
   - `DEEPICODE_CONTEXT_TARGET=0.3`

TUI 保存时写 `.deepicode/context.json`。

## 40. 事件与日志

LoopEvent 增加或复用 `status`：

```ts
{
  role: "status",
  content: "context_compressed",
  metadata: {
    mode: "compress",
    beforeTokens,
    afterTokens,
    removedMessages,
    summaryTokens,
    triggerRatio,
    targetRatio
  }
}
```

RuntimeLogger 事件：

- `context.policy.load`
- `context.policy.update`
- `context.reduction.check`
- `context.trim.start`
- `context.trim.done`
- `context.compress.start`
- `context.compress.done`
- `context.compress.error`
- `context.compress.fallback_trim`

日志要求：

- 不记录完整消息内容。
- 可以记录 message count、token count、mode、durationMs。
- summarizer 错误记录 errorClass，不记录 prompt 全文。

## 41. 安全与正确性边界

1. 不压缩 `ImmutablePrefix`。
2. 不压缩当前用户输入。
3. 不压缩未闭合 tool_call / tool result 组。
4. 压缩摘要不能覆盖原始 session JSONL；原始历史仍保留在磁盘。
5. 压缩产生的 summary 写入当前上下文和后续 messages snapshot，但要能被识别为 summary。
6. summarizer 不带 tools，避免压缩过程触发工具调用。
7. summarizer 请求失败、超时或返回空摘要时 fallback trim。
8. 如果 targetRatio 低于 prefix+scratch 最小可达比例，显示 warning，不要死循环。
9. 多次压缩应合并旧 summary，而不是堆叠多个 summary。
10. 用户切回 trim 后，已有 summary 保留；可后续增加 “clear summary” 功能。

## 42. 实施阶段

### CTX-10：策略类型、配置加载和菜单解析

目标：

- 新增 `ContextPolicy` 类型和默认值。
- 新增 `.deepicode/context.json` loader/saver。
- 支持 env override。
- 校验 `targetRatio < triggerRatio`。
- `/context` 命令解析和 autocomplete 注册。

测试：

- 默认是 `trim 70% -> 30%`。
- 非法配置 fallback 默认值并给出错误。
- env override 生效。
- `/context` 被正确解析。

目标测试：

```bash
bun test packages/core/__tests__/context-policy.test.ts
bun test packages/tui/__tests__/commands.test.ts
bun run typecheck
```

### CTX-20：ContextManager 参数化裁剪

目标：

- 将 `truncateToBudget()` 改造为可按 targetRatio 裁剪。
- 新增 `trimToTarget(targetTokens)`。
- 保持当前默认行为不回归。
- 处理 prefix/scratch 不可达 target 的情况。

测试：

- 超过 70% 时可裁到 30%。
- 未超过 trigger 不裁剪。
- tool 组不被切坏。
- 无 user message 极端情况仍不死循环。
- prefix 超窗仍抛配置错误。

目标测试：

```bash
bun test packages/core/__tests__/context-manager.test.ts
bun run typecheck
```

### CTX-30：摘要区和 summarizer 接口

目标：

- 新增 `ContextSummary` 区域。
- `buildMessages()` 顺序变为 prefix + summary + log + scratch。
- 新增 `ContextSummarizer` 接口。
- 实现 fake summarizer 用于测试。
- 暂不接真实 LLM。

测试：

- summary 位于 prefix 后、log 前。
- replace summary 不改变 immutable prefix fingerprint。
- 多次 replace 只保留一个 summary。
- summary tokens 计入 budget。

目标测试：

```bash
bun test packages/core/__tests__/context-summary.test.ts
```

### CTX-40：Engine 自动 trim/compress 触发

目标：

- `ReasonixEngine` 增加 `getContextPolicy()`、`setContextPolicy()`、`getContextStatus()`。
- `submit()` 前检查 budget。
- mode=`trim` 时自动裁剪。
- mode=`compress` 时使用 summarizer；失败 fallback trim。
- 产生 status event 和 runtime logs。

测试：

- 低于 70% 不触发。
- 高于 70% 触发 trim。
- compress 成功后安装 summary 并删除旧轮次。
- compress 失败 fallback trim。
- 当前用户输入不被压缩。
- 不调用工具。

目标测试：

```bash
bun test packages/core/__tests__/engine-context-policy.test.ts
```

### CTX-50：真实 LLM summarizer

目标：

- 用当前 provider client 实现真实 summarizer。
- maxTokens 受 targetRatio 约束。
- timeout 和 AbortSignal 生效。
- summarizer 不带 tools。
- 记录 usage，但不污染普通 stats 或明确单独统计。

测试：

- fake SSE summary 路径。
- summarizer HTTP 错误 fallback trim。
- abort 时停止 summarizer。
- 空摘要 fallback trim。

目标测试：

```bash
bun test packages/core/__tests__/context-summarizer.test.ts
```

### CTX-60：TUI `/context` 菜单

目标：

- 新增 `ContextMenu.tsx`。
- `/context` 打开菜单。
- 支持 strategy 和 thresholds 二级菜单。
- 保存后调用 engine/set policy，并写入 `.deepicode/context.json`。
- 菜单不影响输入历史和 slash autocomplete。

测试：

- 菜单打开/关闭。
- strategy 切换。
- trigger/target 切换。
- 保存后调用 setter。
- Esc 返回/关闭。

目标测试：

```bash
bun test packages/tui/__tests__/context-menu.test.ts
bun test packages/tui/__tests__/commands.test.ts
```

### CTX-70：文档和验收

目标：

- README 或 TEST.md 增加 `/context` 说明。
- TODO 增加当前 CTX 阶段，DONE 记录已完成阶段。
- 手工验收 70% -> 30% 的 trim 和 compress。

手工验收：

1. 启动 TUI。
2. 输入 `/context`。
3. 选择 `trim`，设置 `70% -> 30%`，保存。
4. 用测试 fixture 或长会话制造上下文超过 70%，确认自动裁剪到约 30%。
5. 切换 `compress`，重复长会话，确认出现 summary。
6. 模拟 summarizer 失败，确认 fallback trim。
7. 退出并重启，确认 `.deepicode/context.json` 配置仍生效。

## 43. 建议领取顺序

1. `CTX-10`：策略类型、配置加载和 `/context` 命令入口。
2. `CTX-20`：参数化裁剪。
3. `CTX-30`：summary 区域和 summarizer 接口。
4. `CTX-40`：Engine 自动触发与 fallback。
5. `CTX-50`：真实 LLM summarizer。
6. `CTX-60`：TUI `/context` 菜单。
7. `CTX-70`：文档和验收。

每次只领取一个阶段。完成后更新 `DONE.md` 和 `TODO.md`，并至少运行对应目标测试、`bun run typecheck`、`git diff --check`。
