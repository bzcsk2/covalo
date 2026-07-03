# Covalo 文档

最后整合日期：2026-06-25。

本目录是 Covalo 维护者和编码代理的当前文档入口。根目录的 README 文件仍然是面向用户的安装和项目概览；`docs/` 目录用于存放架构、运维、开发、路线图和变更历史。

## 阅读顺序

1. [ARCHITECTURE.md](ARCHITECTURE.md) — 产品意图、运行时结构、包边界、工作流语义、当前实现状态及不变性约束。
2. [OPERATIONS.md](OPERATIONS.md) — 安装、CLI/TUI 命令、配置、模型提供商、日志记录、诊断及安全注意事项。
3. [DEVELOPMENT.md](DEVELOPMENT.md) — 本地环境搭建、验证命令、测试策略、发布检查和文档规则。
4. [ROADMAP.md](ROADMAP.md) — 当前路线图、近期完成里程碑、非目标及下一步工作。
5. [CHANGELOG.md](CHANGELOG.md) — 面向用户的变更和维护性变更。

## 整合内容

之前的文档集将当前事实、历史 DONE 日志、旧的 TODO 计划、提供商说明、日志说明和配置说明分散在多个文件中。有用的材料现已合并到上述精简文档集中：

| 原有内容 | 新位置 |
| --- | --- |
| `PROJECT_DESIGN.zh.md`、`STATUS.md`、`DONE.md` 部分内容 | `ARCHITECTURE.md` |
| `OPERATIONS.md`、`configuration.md`、`MODEL_PROVIDERS.md`、`LOGGING.md` | `OPERATIONS.md` |
| `DEVELOPMENT.md` | `DEVELOPMENT.md` |
| `TODO.md`、路线图状态说明 | `ROADMAP.md` |
| 公开变更记录 | `CHANGELOG.md` |

历史性的逐日实现日志和旧的重修计划不再被视为权威文档。将实现历史保留在 Git 提交和 PR 中，而不要重新引入冗长的 `DONE` 文件或归档文件。

## 审计与配置参考文档

以下文档记录未接入功能的审计结论和保留项的配置方法，供维护者参考：

- [unintegrated_code_audit_20260703.md](unintegrated_code_audit_20260703.md) — 未接入代码审计报告（含 Phase 1/2 已处理项和 Phase 3 搁置项）
- [self_harness_audit_20260703.md](self_harness_audit_20260703.md) — self-harness 模块接入状态审计
- [supervisor-configuration.md](supervisor-configuration.md) — Supervisor 候选池配置方法（ADV-HAR-04 默认禁用机制）
- [retained-features-status.md](retained-features-status.md) — 搁置功能状态说明（Mailbox workflow / GoalRuntime / Sandbox 主路径）

## 文档规则

- 除非某篇文档明确链接到权威来源，否则不要在多个文档中重复相同的事实。
- 不要将计划中的行为写成已完成的行为。
- 当代码行为发生变更时，更新最相关的文档，然后检查 `ARCHITECTURE.md` 或 `OPERATIONS.md` 是否需要一行调整。
- 保持命令、文件路径、包名、模型 ID 和环境变量的准确性。
- 优先使用简短表格和可执行命令，而非叙述性的状态日志。
- 对于编码代理的工作，从此文件开始，然后阅读 `ARCHITECTURE.md`、`DEVELOPMENT.md`，以及变更所涉及的主题文档。
