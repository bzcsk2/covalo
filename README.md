# Covalo

<p align="center">
  <strong>English</strong> |
  <a href="./README.zh.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun_1.3+-orange?style=flat-square" alt="Bun" />
  <img src="https://img.shields.io/badge/language-TypeScript-blue?style=flat-square" alt="TypeScript" />
  <img src="https://img.shields.io/badge/status-pre--1.0-yellow?style=flat-square" alt="Status" />
  <img src="https://img.shields.io/badge/TUI-Ink%2FReact-blue?style=flat-square" alt="TUI" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" alt="License" />
</p>

**Covalo is a terminal-native AI loop agent for making cheap, free, and local models complete real engineering work through supervised execution loops.**

Most coding agents assume a strong frontier model is always available. Covalo takes a different position: use stronger models for planning, supervision, and recovery; use cheaper or local models for the bulk of the execution; keep the loop observable, resumable, and governed by explicit safety boundaries.

> The goal is not to replace good models. The goal is to make low-cost models useful enough to keep working.

---

## What Covalo Is

Covalo is a TypeScript/Bun CLI and TUI agent runtime with:

- a cache-aware agent loop optimized for low-cost model usage
- a Supervisor / Worker workflow for long-running engineering tasks
- adjustable harness levels for weak, local, or unreliable models
- a terminal UI built with Ink and React
- 30+ built-in tools for file operations, search, editing, shell, web, tasks, workflow, MCP, and notebooks
- Skills, MCP, and plugin/content-pack integration
- deny-first permission handling for shell commands and file modifications
- session persistence and recovery for interrupted work

Covalo is currently **pre-1.0**. Core CLI, tools, security, plugin, skills, MCP, and workflow foundations are implemented, but public APIs and configuration formats may still change.

---

## Core Idea: Supervisor + Worker Loop

Covalo avoids the fragile pattern of one agent wandering through an unbounded loop. The intended workflow is a fixed two-role execution structure:

```text
Supervisor plans
  -> Worker executes
  -> Worker reports
  -> Supervisor reviews evidence
  -> continue, correct, escalate, or ask the human
```

### Worker

The Worker is the execution agent. It can use a local model, a free model, or a low-cost API model. In normal chat it behaves like a regular coding agent. In workflow mode, it follows Supervisor instructions and reports progress through structured checkpoints.

### Supervisor

The Supervisor uses a stronger model. It is responsible for planning, reviewing Worker reports, reading immutable evidence bundles, detecting failure loops, and producing the next structured instruction. When the workflow cannot safely continue, the Supervisor stops and asks the user.

---

## Quick Start

### Install the CLI

```bash
npm install -g covalo
```

You can also use Bun:

```bash
bun install -g covalo
```

### Start inside a project

```bash
cd your-project
covalo
```

Inside Covalo, run:

```text
/help
/model
/workflow
```

`/help` is the main usage entry point. Ask it for command details, model setup, workflow usage, harness levels, or troubleshooting.

### Develop from source

```bash
git clone https://github.com/bzcsk2/covalo.git
cd covalo
bun install
bun run dev
```

---

## Common Commands

| Command | Purpose |
| --- | --- |
| `/model` | Switch chat target without losing state; configure providers, API keys, and local models. |
| `/workflow` | Start the Supervisor / Worker workflow. |
| `/sessions` | List and restore previous sessions after exit or crash. |
| `/skill` | Browse and activate built-in engineering skills. |
| `/status` | Inspect runtime, model, provider, tool, and session state. |
| `/context` | Adjust context strategy. |
| `/thinking` | Adjust reasoning intensity. |
| `/harness` | Adjust execution constraints for weak or local models. |
| `/help` | Show command help and usage guidance. |

---

## Why Covalo Exists

### Low-cost model economics

Most AI coding tools rely on expensive models to compensate for weak orchestration. Covalo focuses on orchestration first:

- put expensive intelligence where it matters: planning, review, recovery, verification
- let cheap/free/local models do repeatable implementation work
- keep the loop recoverable when the Worker fails
- reduce wasted tokens with cache-aware context management and tool-call repair

### Local and weak-model reliability

Covalo treats model weakness as a runtime condition, not a fatal limitation. The harness system lets the user choose stricter execution rails for weaker models:

- smaller steps
- stronger verification gates
- more frequent reports
- bounded retries
- Supervisor escalation on repeated failure

### Terminal-native engineering

Covalo is built for developers working in repositories, not for generic chatbot sessions. It emphasizes:

- file-aware edits
- shell execution with permission checks
- resumable sessions
- TUI observability
- project-local configuration
- fast model/provider switching

---

## Architecture

Covalo uses a kernel/shell separation:

```text
packages/core      -> agent loop, API adaptation, context, cache, retry, workflow primitives
packages/tui       -> Ink/React terminal UI, input, status, model picker, workflow display
packages/tools     -> file, shell, search, edit, web, MCP, workflow, task, notebook tools
packages/plugin    -> plugin/content-pack runtime, hooks, schema validation
packages/security  -> deny-first PermissionEngine, HookManager, FileSnapshot
packages/cli       -> command-line entry point
```

The engine emits events through an async stream, so the CLI, TUI, tests, and future IDE/web shells can consume the same runtime without coupling UI rendering to agent execution.

```text
CLI / TUI / future IDE shell
             │
             ▼
     AsyncGenerator<LoopEvent>
             │
             ▼
        CoreEngine
             │
   ┌─────────┼─────────┐
   │         │         │
 Model   Context    Tools
 Client  Manager   Executor
```

---

## Built-in Capabilities

### Tools

Covalo includes tools for:

- reading, writing, editing, and listing files
- grep and project search
- shell execution with policy checks
- TODO/task tracking
- web access
- MCP tool discovery and invocation
- workflow control
- notebook-style operations

### Editing safety

Covalo uses layered edit safeguards:

- hash-anchored editing
- fuzzy fallback matching
- stale-read protection
- file snapshots for rollback
- dangerous command blocking
- SSRF-aware web request handling

### Skills and MCP

Skills are reusable domain instruction packages. MCP support lets Covalo connect to external tools and data sources through JSON-RPC 2.0 / stdio MCP servers.

---

## Model Providers

Covalo is designed around multiple model classes:

| Class | Intended role |
| --- | --- |
| Free gateway models | Low-cost Worker execution, exploration, simple implementation. |
| Local OpenAI-compatible models | Private or continuous Worker execution. |
| API models with user keys | Supervisor, recovery, review, or higher-quality execution. |
| Custom OpenAI-compatible endpoints | vLLM, Ollama, llama.cpp, local gateways, or internal routers. |

Provider configuration is available through `/model`. Local models are routed through OpenAI-compatible configuration.

Covalo does not require one fixed provider. The runtime state is effectively:

```ts
{
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}
```

---

## Safety Model

Covalo is an agent that can read files, edit files, run commands, and call tools. Treat it as a powerful local development assistant, not as a sandboxed security boundary.

Key safeguards:

- deny-first permission engine
- explicit authorization for shell and write operations
- dangerous command blocking
- file snapshots for rollback
- stale-read checks before edits
- isolated sub-agent permissions
- API key files ignored by Git

Do not run Covalo in a repository where you are not willing to review agent-generated changes.

---

## Development

```bash
bun install
bun run typecheck
bun test
bun run build
npm pack --dry-run
```

Before publishing, run `npm pack --dry-run` and confirm the package name is `covalo` and the `covalo` binary is included.

The package is published as `covalo` and exposes the `covalo` binary. The `looprig` binary is kept as a compatibility alias.

---

## Documentation

Current primary docs:

- [Chinese README](./README.zh.md)
- [Roadmap](./ROADMAP.md)
- [Changelog](./CHANGELOG.md)
- [Contributing](./CONTRIBUTING.md)
- [Security Policy](./SECURITY.md)

Additional design and implementation notes live under [`docs/`](./docs). Some files in `docs/` are development notes rather than polished user documentation.

---

## Roadmap

See [ROADMAP.md](./ROADMAP.md).

Near-term focus:

- harden npm installation and package smoke tests
- stabilize Supervisor / Worker workflow behavior
- document provider configuration and harness levels
- improve Windows terminal compatibility
- add reliability benchmarks for weak/local models

---

## Contributing

Issues and pull requests are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), then check open issues and roadmap items.

Covalo is especially interested in contributions around:

- local model presets
- weak-model workflow reliability
- terminal UI polish
- provider adapters
- MCP examples
- documentation and examples
- safety hardening

---

## License

MIT License. See [LICENSE](./LICENSE).
