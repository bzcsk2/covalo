# TODO

最后整理：2026-06-24。

本文件只保留当前下一步工作。历史长文已移到 `docs/archive/`。

## P0：TUI 中英文切换整改

目标：把当前 `/lang` 从“能切换少量字符串”整改为“主要 TUI 用户可见文本都能在中文/英文之间一致切换，并且切换后立即生效、持久化、可测试”。

### 0.1 当前检查结论

当前已经具备基础设施：

- `packages/tui/src/i18n/strings.ts` 定义 `Locale = 'zh-CN' | 'en'` 和 `Strings`。
- `packages/tui/src/i18n/en.ts`、`packages/tui/src/i18n/zh-CN.ts` 已有一批翻译。
- `packages/tui/src/i18n/index.ts` 提供 `t()`、`setLocale()`、`getLocale()`、`toggleLocale()`。
- `packages/tui/src/i18n/persist.ts` 读写 `.deepreef/lang.json`。
- `packages/tui/src/App.tsx` 已支持 `/lang` 和语言选择菜单。

主要问题：

- `Strings` 覆盖面太小，只覆盖输入框、权限、部分卡片、部分命令和状态栏。
- `/lang` 切换依赖 `setLocale()` 修改模块变量，缺少显式 React locale state/context；切换能触发局部重渲染，但不是可靠的全局响应式机制。
- `CommandRegistry.ts` 的 slash command 描述仍是硬编码英文，自动补全不会随语言切换。
- `commands.ts` 的 `buildHelpText()` 仍有大量硬编码英文，包括 `/theme`、`/thinking`、`/workflow`、`/goal`、`Agents`、`Current`、deprecated note。
- `App.tsx` 中 `/thinking`、`/harness`、`/goal`、workflow instruction、status error 等用户反馈仍有大量硬编码英文。
- `WelcomeScreen.tsx` 默认混用中文和英文：中文 slogan、中文标签、英文 `/lang can switch to English`。
- `WorkflowStatusBar.tsx`、`status/format.ts`、`PermissionPrompt.tsx`、`QuestionPrompt.tsx`、`ContextModal.tsx`、`SkillModal.tsx`、`SearchOverlay.tsx`、Agent/Worker 可视化组件仍有硬编码英文。
- 目前缺少“中英文字典 key 完整一致”“切换后 UI 文案变化”“`.deepreef/lang.json` 持久化/损坏恢复”的专项测试。

### 0.2 实施原则

- 不要把模型输出、工具输出、用户输入、文件内容翻译；只翻译 DeepReef 自身 UI 文案。
- 不要在组件里写新的用户可见硬编码字符串；统一进 i18n 字典。
- 保留命令名、工具名、provider/model id、文件路径、错误原文。
- 中文文案用简体中文；英文文案保持简短，适合终端窄屏。
- 字典必须类型安全：新增 key 时 `en.ts` 和 `zh-CN.ts` 必须同时补齐。
- 语言切换应立即刷新当前 TUI，不要求重启。
- `.deepreef/lang.json` 仍作为当前阶段持久化路径；未来统一配置系统再迁移。

### 0.3 Phase A：修复 locale 状态模型

涉及文件：

- `packages/tui/src/i18n/index.ts`
- `packages/tui/src/i18n/persist.ts`
- `packages/tui/src/App.tsx`
- 可选新增：`packages/tui/src/i18n/context.tsx`

任务：

- 在 App 级维护 `locale` state，初始值来自 `getLocale()` 或 `loadLang()`。
- `/lang` 选择后同时调用 `setLocale(next)` 和 `setLocaleState(next)`，保证整棵 TUI 立即重渲染。
- 避免只依赖 `t()` 的模块级变量改变。
- 清理 `setLocale(next as any)`，改成类型安全的 `Locale`。
- 为损坏的 `.deepreef/lang.json` 保持安全 fallback，不抛出。

验收：

- 启动 TUI 后执行 `/lang`，欢迎页、状态栏、命令补全、modal 文案能立即切换。
- `.deepreef/lang.json` 写入 `{ "lang": "en" }` 或 `{ "lang": "zh-CN" }` 后下次启动生效。
- `.deepreef/lang.json` 损坏或 lang 非法时回退默认语言，不影响启动。

### 0.4 Phase B：扩展 i18n 字典结构

涉及文件：

- `packages/tui/src/i18n/strings.ts`
- `packages/tui/src/i18n/en.ts`
- `packages/tui/src/i18n/zh-CN.ts`

建议新增 key 分组，保持当前 flat `Strings` 也可以，但 key 命名要按模块聚合：

- slash/help：
  - `helpTitle`
  - `helpAgents`
  - `helpCurrent`
  - `helpDeprecatedAgentNote`
  - `cmdTheme`
  - `cmdThinking`
  - `cmdWorkflow`
  - `cmdTalk`
  - `cmdGoal`
  - `cmdGoalSet`
  - `cmdGoalEdit`
  - `cmdGoalPause`
  - `cmdGoalResume`
  - `cmdGoalClear`
  - `cmdGoalBudget`
  - `cmdGoalNoBudget`
- command autocomplete：
  - 每条 slash command 的 description。
- App command feedback：
  - `failedLoadStatus`
  - `thinkingModeSet`
  - `thinkingModeCurrent`
  - `harnessStatus`
  - `harnessSetSession`
  - `harnessSetProject`
  - `harnessProjectUsage`
  - `workflowInstructionQueued`
  - `inputTargetSwitched`
- goal：
  - `goalSet`
  - `goalReplaced`
  - `goalUpdated`
  - `goalNoActive`
  - `goalNoActiveToEdit`
  - `goalPause`
  - `goalResume`
  - `goalClear`
  - `goalInvalidBudget`
  - `goalBudgetSet`
  - `goalBudgetRemoved`
  - `goalStatusLine`
- welcome：
  - `welcomeTagline`
  - `welcomePanelAgent`
  - `welcomePanelComponents`
  - `welcomeThinking`
  - `welcomeContext`
  - `welcomeSubagent`
  - `welcomeProvider`
  - `welcomeSkills`
  - `welcomeMcp`
  - `welcomeDiagnostics`
  - `welcomeHelpHint`
  - `welcomeLangHint`
  - `contextModeTrim`
  - `contextModeCompact`
- modal/common：
  - `modalEscClose`
  - `selectHint`
  - `loadingSkills`
  - `skillsAvailable`
  - `noSkillsFound`
  - `skillEnabled`
  - `skillDisabled`
  - `skillNoDescription`
  - `skillFooterHint`
  - `contextLoading`
  - `contextLoaded`
  - `contextSaved`
  - `contextReducing`
  - `contextSubtitle`
  - `contextModeDescription`
  - `contextTriggerDescription`
  - `contextTargetDescription`
  - `contextRunNow`
  - `contextRunDescription`
  - `contextFooterHint`
- permission/question/search/status/workflow：
  - permission action labels and tool kind labels。
  - question placeholder、summary、submitting、no answer。
  - search no match。
  - status section titles and Yes/No。
  - workflow phase/lifecycle/role status labels。

验收：

- `en.ts` 和 `zh-CN.ts` 实现同一个 `Strings` interface，无 `as any` 绕过。
- 旧 key 保持兼容或一次性迁移调用点。
- `bun run typecheck` 能通过。

### 0.5 Phase C：迁移核心 TUI 调用点

优先级从高到低：

1. 命令和帮助：
   - `packages/tui/src/CommandRegistry.ts`
   - `packages/tui/src/commands.ts`
   - `packages/tui/__tests__/commands.test.ts`
   - `packages/tui/__tests__/status-command.test.ts`
2. App 命令反馈：
   - `packages/tui/src/App.tsx`
3. 首屏和底部状态：
   - `packages/tui/src/WelcomeScreen.tsx`
   - `packages/tui/src/StatusBar.tsx`
   - `packages/tui/src/BridgeConnected.tsx`
4. Workflow：
   - `packages/tui/src/components/workflow/WorkflowStatusBar.tsx`
   - `packages/tui/src/workflow-mode-router.ts`
5. Modal：
   - `packages/tui/src/ModelPicker.tsx`
   - `packages/tui/src/SkillModal.tsx`
   - `packages/tui/src/ContextModal.tsx`
   - `packages/tui/src/SessionPicker.tsx`
6. Prompt 和 overlay：
   - `packages/tui/src/PermissionPrompt.tsx`
   - `packages/tui/src/QuestionPrompt.tsx`
   - `packages/tui/src/SearchOverlay.tsx`
   - `packages/tui/src/CommandAutocomplete.tsx`
7. Agent/Worker 可视化：
   - `packages/tui/src/components/agents/AgentGroupDisplay.tsx`
   - `packages/tui/src/components/agents/AgentProgressDisplay.tsx`
   - `packages/tui/src/components/workers/WorkerActivityPanel.tsx`
   - `packages/tui/src/components/shared/VirtualizedTranscript.tsx`

迁移要求：

- 用户可见文案必须从 `t()` 或 locale context 读取。
- 只保留不可翻译的 protocol/status id，例如 `worker`、`supervisor`、`loop`、provider id、model id、tool name。
- 如果 UI 显示 status id，需要用 display label 包一层，例如 `workflowPhaseLabel(phase, t())`。
- 不要翻译测试 fixture 里的模型输出和工具输出。

### 0.6 Phase D：补齐测试

建议新增或更新：

- `packages/tui/__tests__/i18n.test.ts`
  - `en` 和 `zhCN` key 完整性。
  - `setLocale/getLocale/toggleLocale` 行为。
  - `loadLang/saveLang` 正常、缺文件、损坏文件、非法 lang。
- `packages/tui/__tests__/commands.test.ts`
  - `buildHelpText(..., zhCN)` 包含中文标题和中文命令说明。
  - `buildHelpText(..., en)` 包含英文标题和英文命令说明。
  - `CommandRegistry` 描述来自字典，而不是静态英文常量。
- `packages/tui/__tests__/workflow-components.test.ts`
  - `WorkflowStatusBar` 在 zh/en 下渲染 phase/lifecycle label。
- `packages/tui/__tests__/status-command.test.ts`
  - `formatStatus` 支持 zh/en section title，或明确保持英文并记录原因。

验收命令：

```bash
bun run typecheck
bun test packages/tui/__tests__/commands.test.ts
bun test packages/tui/__tests__/status-command.test.ts
bun test packages/tui/__tests__/workflow-components.test.ts
bun test packages/tui/__tests__/i18n.test.ts
```

如果新增测试文件名不同，以实际文件为准，但必须覆盖以上行为。

### 0.7 Phase E：人工验收清单

在 TUI 中手动验证：

- 默认中文启动，欢迎页全中文，无混入 `/lang can switch to English`。
- 执行 `/lang` 选择 English 后：
  - 欢迎页、状态栏、命令补全、帮助、modal 立即切换为英文。
  - 新追加的系统反馈消息为英文。
  - 已有历史消息不强制重写，保持当时内容即可。
- 再次执行 `/lang` 切回中文，以上区域立即切换中文。
- 重启后语言仍保持上次选择。
- `/help`、`/status`、`/thinking max`、`/harness status`、`/goal`、`/context`、`/skill`、`/model` 文案没有明显中英混杂。
- 终端宽度较窄时，中英文文案不溢出关键容器。

### 0.8 非目标

- 不翻译 AI 回复。
- 不翻译插件/技能包自身提供的第三方描述，除非插件系统未来提供 locale-aware metadata。
- 不在本阶段重构完整配置系统；语言仍使用 `.deepreef/lang.json`。
- 不做多语言 beyond `zh-CN` / `en`。

## P1：统一配置系统

目标：把当前分散的 last-config、role-config、model-targets、TUI settings、env 读取整理成统一 schema/control-plane。

建议范围：

- 新增用户级 `~/.deepreef/config.toml`。
- 新增项目级 `<project>/.deepreef/config.toml`。
- 定义 Zod schema、默认值合并、版本迁移。
- 增加 CLI 命令：
  - `deepreef config path`
  - `deepreef config print`
  - `deepreef config validate`
  - `deepreef config edit`
  - `deepreef config doctor`
- 明确优先级：

```text
CLI flags
  > TUI 临时设置
  > 项目级 .deepreef/config.toml
  > 用户级 ~/.deepreef/config.toml
  > 当前 .deepreef/last-config.json / role-config.json fallback
  > 内置默认值
```

注意：session、goal、mailbox、tokensUsed、workflow phase 属于运行状态，不应写进主配置。

## P2：Workflow 可靠性

目标：让 Supervisor/Worker loop 能稳定处理常规工程任务。

建议任务：

- 为真实小型项目补 workflow e2e fixture。
- 强化 Worker report 的结构化输出和证据字段。
- 完善 `runSupervisorAnalyse()` 对结构化 plan 的校验和 fallback。
- 让 `useMailboxWorkflow` 分支有明确启用条件或移出主链路。
- 增加 workflow resume / interrupted / waiting_user 测试。
- 明确 maxRounds、goal status、budget limited 三者的终止语义。

## P3：Goal 自动续跑与预算治理

目标：让 loop = goal 的语义更完整，同时避免不可控自动执行。

建议任务：

- 完整接入 `GoalRuntime` 的 continuation gate。
- usage/token/time accounting 接入真实 engine usage。
- `budget_limited` 后只允许收尾汇报，不开始新实质工作。
- `blocked` 保持连续三轮同一阻塞审计。
- 增加用户恢复 blocked/paused/usage_limited 的明确路径。

## P4：TUI 长会话性能

目标：长时间会话、长 workflow、长流式输出后 TUI 不明显变卡。

建议任务：

- 给 bridge runtime 的 warnings、messageQueue 等数组设置上限。
- TranscriptStore 做 round-aware trim，保护 streaming reasoning/tool/prompt。
- DeepiMessages 做渲染窗口化。
- 暴露 transcript/store/reader/timeline 数据规模指标。
- 增加长 timeline 回归测试。

历史专项建议见 [archive/TUI性能整改建议.md](archive/TUI性能整改建议.md)。

## P5：Provider 与本地模型体验

目标：降低本地/免费/便宜模型的配置和调参成本。

建议任务：

- 完善 provider profile 和 model capability profile。
- 给常见本地 OpenAI-compatible 服务补配置示例。
- 调整 harness strictness 与小模型推荐组合。
- 建立 benchmark matrix，记录 Worker 模型可靠性。

## P6：文档和发布

目标：让外部用户更容易安装、运行、定位问题和贡献。

建议任务：

- 补 plugin/content-pack authoring 文档。
- 补 MCP 示例。
- 补 memory 配置说明。
- 补 workflow 示例和失败排查。
- 保持 README、docs 和代码命令一致。
- 发布前固定执行 `bun run typecheck && bun test && bun run build && npm pack --dry-run`。
