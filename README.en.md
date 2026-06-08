# deepicode

<p align="center">
  <a href="./README.md">中文</a> |
  <strong>English</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/runtime-Bun-FF5E5B?style=flat-square" />
  <img src="https://img.shields.io/badge/model-DeepSeek_V4-4B8BF5?style=flat-square" />
  <img src="https://img.shields.io/badge/license-MIT-yellow?style=flat-square" />
  <img src="https://img.shields.io/badge/version-0.1.0-blue?style=flat-square" />
  <img src="https://img.shields.io/badge/test-43_pass_0_fail-green?style=flat-square" />
</p>

---

**Spending other people's money is easy. Spending your own — every token counts.**

deepicode isn't another LLM wrapper. It's a terminal-native coding agent that **exploits DeepSeek's pricing model to its absolute limit**. We redesigned the entire context engine around one fact: DeepSeek prefix-cache hits cost ¥1/M tokens, misses cost ¥4/M. That 4x gap is why deepicode exists.

---

## Why Your Token Bill Matters

A regular coding agent burns through ¥10-50 a day. Not because you're using too many tokens — but because you're **paying cache-miss prices for the same system prompt, every single call**.

Here's what deepicode does:

```
Every API call:
  ┌─────────────────────────────┐
  │ System Prompt (never changes) │  ← 100% cache hit → ¥0.5/M
  │ Tool Definitions (rarely change)│  ← 100% cache hit → ¥0.5/M
  │ Conversation History (append-only)│ ← partial miss → ¥2~4/M
  │ Current Tool Results (per-turn) │  ← unavoidable miss
  └─────────────────────────────┘

Regular agent: change one tool definition → entire prefix shifts → full miss pricing
deepicode: SHA-256 fingerprint detection → only actually-changed segments trigger a miss
```

This isn't a 10-20% micro-optimization. Over a 50-turn session, deepicode can **cut API costs by 60-80%** compared to a naive agent.

---

## Know the Price Before You Pay

Every time you submit input, deepicode analyzes task complexity and estimates the cost:

```text
╭─ Cost Estimate ──────────────────────────╮
│  chat-fast        ~¥0.008 ~ ¥0.015       │  ← Q&A, file lookup
│  chat-full        ~¥0.02  ~ ¥0.06        │  ← coding, debugging
│  reasoner-budget  ~¥0.08  ~ ¥0.35        │  ← medium refactors
│  reasoner         ~¥0.30  ~ ¥1.20        │  ← architecture changes
├───────────────────────────────────────────┤
│ Auto-recommendation: chat-full            │
│ 3s countdown · arrow keys to switch · ↵   │
╰───────────────────────────────────────────╯
```

**Transparent pricing** — you see what this turn will cost before committing. For indie devs and small teams, saving a coffee's worth of API fees every month adds up.

---

## Auto Mode + Budget Cap

Don't want to choose every time? Let the auto-router decide:

```text
Auto Tier:
  Simple Q&A / single-file search  → deepseek-chat (flash)   cheapest
  Routine coding / debugging       → deepseek-chat (full)    balanced
  Multi-module refactor / arch     → deepseek-reasoner       worth it
  Agentic multi-turn detected      → auto-apply 2-3x chain multiplier
```

Set a monthly budget cap — deepicode auto-downgrades to flash when you're approaching the limit. **Let code manage your spend, not your willpower.**

---

## Skills · MCP · Subagents — Agent Platform, Not Just Agent

### Skills System

Skills are reusable domain knowledge packages. Each Skill is a standalone instruction file loaded on demand — database optimization tasks auto-load `postgres-patterns`, frontend work auto-loads `frontend-design`. No more copy-pasting long system prompts — deepicode remembers and activates the right knowledge at the right time.

```text
User: "Optimize this SQL query for me"
  → Agent auto-matches postgres-patterns skill
  → Injects PostgreSQL indexing & query plan knowledge
  → Gets to work

User: "Design a login page"
  → Auto-matches frontend-design skill
  → Injects UI/UX best practices
  → Produces design-compliant code
```

### MCP (Model Context Protocol)

Connect external tools and data sources via MCP. Supabase databases, Serena code analysis, Playwright browser automation — all registered as MCP Servers. The Agent auto-discovers and invokes them.

```text
deepicode                    MCP Servers
   │                            │
   ├── mcp:supabase ────────────┤  Database queries
   ├── mcp:serena ──────────────┤  Code symbol analysis
   ├── mcp:playwright ──────────┤  Browser automation testing
   ├── mcp:context7 ────────────┤  Real-time documentation
   └── mcp:your-custom-server ──┤  Arbitrary extensions
```

### Subagents

Complex tasks can be delegated to isolated sub-agents. The main Agent handles planning and result synthesis. Background sub-agents can read, write, search, and analyze, but cannot bypass interactive confirmation to run `exec` tools.

```text
User: "Audit this PR for security and generate tests"
   │
   ▼
  Main Agent (plan + orchestrate)
   │
   ├── Subagent 1: security-reviewer  → vulnerability scanning
   ├── Subagent 2: tdd-guide          → test case generation
   └── Subagent 3: code-reviewer      → code quality audit
   │
   ▼
  Combined result → complete audit report + test suite
```

> **Current status**: Skills, dynamic MCP tool discovery and invocation, and isolated sub-agents are integrated. There are 34 statically registered Agent Tools. LSP requires a configured language server in `.deepicode/lsp.json`; browser interaction requires Playwright.

Minimal LSP configuration:

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

---

## Architecture

### Kernel-Shell Separation

Engine and UI are fully decoupled — `CoreEngine` pushes events to consumers via `AsyncGenerator<LoopEvent>`. The shell simply consumes the event stream:

- **Engine iterates independently** — prefix-cache strategy, token budget, and repair pipeline improvements don't touch the UI
- **Shell extends independently** — CLI / TUI / Web / IDE plugins all implement the same `LoopEvent` consumer
- **Test without UI** — full engine behavior is verifiable by `for await (const event of engine.submit(...))`

```text
CLI (readline)           TUI (Ink/React)          IDE Plugin
      │                        │                       │
      └────────────────────────┼───────────────────────┘
                               │
                    AsyncGenerator<LoopEvent>
                               │
                      ┌────────┴────────┐
                      │   CoreEngine    │
                      │   (engine.ts)   │
                      └────────┬────────┘
                               │
          ┌────────────────────┼────────────────────┐
          │                    │                    │
   DeepSeekClient      ContextManager      StreamingToolExecutor
   (SSE streaming)     (3-zone context)    (parallel/sequential dispatch)
```

### Three-Zone Context

This is deepicode's cost-saving core. DeepSeek's prefix-cache matches on **byte prefix of the request messages array**: same prefix → cache hit pricing (cheap); different prefix → cache miss pricing (expensive).

```
Messages array sent to API:
┌──────────────────────────────────────┐
│ [0] system prompt            ▲       │
│     (ImmutablePrefix)        │ never  │  ← 100% cache hit
│ [1] tool definitions         ▼       │
├──────────────────────────────────────┤
│ [2] user: "Check file A for me"      │
│ [3] assistant: "File A contains..."  │  ← AppendOnlyLog
│ [4] tool: read_file result           │     append-only, never mutate
│ [5] assistant: "I suggest..."        │     prefix continuity preserved
├──────────────────────────────────────┤
│ [6] ...current turn temp results...  │  ← VolatileScratch
│                     cleared per turn │     never breaks prefix
└──────────────────────────────────────┘
```

**Key design decisions**:

- `ImmutablePrefix` uses SHA-256 fingerprint (system prompt + toolSpecs + fewShots) — tool schema changes are auto-detected with cache miss warnings
- `AppendOnlyLog` only calls `push()`, never `splice()` or `shift()` — mutating history shifts the entire prefix
- `VolatileScratch` cleared each turn via `startTurn()` — transient state never affects the next turn's prefix match

### Streaming Tool Execution

Tool dispatch starts before the model finishes output. Current strategy favors stability — tools execute after the full tool call is received. Next upgrade is **eager dispatch**:

```text
Model outputs: { "name": "read_file", "arguments": { "path":...

   │                            │
   │  arguments fully parseable │  ← immediately create Promise, execute concurrently
   │  (incremental JSON verify) │     without waiting for rest of output
   │                            │
   ▼                            ▼
   read_file("a.ts")     read_file("b.ts")    ← shared tools run in parallel
        │                      │
        └──────────┬───────────┘
                   ▼
              merge results, continue
```

### Multi-Strategy Editing

`edit` tool strategy chain: **Hash-Anchored → 4-pass Fuzzy → Feedback**.

```
┌─ Hash-Anchored ──────────────────────┐
│ Async streaming read → chunk match  │
│ → write to temp file → atomic       │
│ rename → preserve permissions       │
└──────────┬───────────────────────────┘
           │ old_string exact match failed
           ▼
┌─ Fuzzy Fallback ─────────────────────┐
│ Pass 1: exact                        │
│ Pass 2: trimmed_lines (strip trailing│
│         whitespace per line)         │
│ Pass 3: trimmed_full (strip all ws)  │
│ Pass 4: flexible_whitespace (regex)  │
│ [Pass 5-9 planned]                   │
└──────────┬───────────────────────────┘
           │ all passes exhausted
           ▼
        return [Error] old_string not found
        → model receives feedback → retries
```

### Stale-Read Protection

Agents often span multiple API turns between "read file → think → edit". During that time, the file may be modified by the user or git operations.

```
read_file("a.ts")  →  recordRead(mtime=10:30:01, size=4096)
                         │
         ... model thinks + multiple tool rounds ...
                         │
       edit("a.ts", ...) →  checkStale("a.ts")
                         │
                    ┌────┴────┐
                    │ mtime changed? │
                    │ size changed?  │
                    └────┬────┘
                    yes → reject edit → require re-read
                    no  → execute edit
```

### Session Persistence

Every turn's full conversation is written to `.deepicode/sessions/<id>.jsonl` via async batch writes that never block the main loop.

```jsonl
{"ts":1717000000,"type":"event","payload":{"role":"reasoning_delta","content":"..."}}
{"ts":1710000001,"type":"event","payload":{"role":"assistant_delta","content":"..."}}
{"ts":1710000002,"type":"messages","payload":[...]}
{"ts":1710000003,"type":"stats","payload":{"promptTokens":120,...}}
```

---

## Quick Start

```bash
# Prerequisite: Bun >= 1.3
git clone https://github.com/bzcsk2/deepicode.git
cd deepicode
bun install

# Set API Key (choose one)
export DEEPSEEK_API_KEY="sk-your-key"
# Or create an api-key file in project root (git-ignored)

# Run
bun run dev
```

```bash
# Pipe input
echo "Refactor src/utils.ts for me" | bun run dev

# Help
bun run dev --help
```

Type `/exit` to quit, `/help` for commands.

---

## Tools

| Tool | Type | Description |
|------|------|-------------|
| `read_file` | shared | Read files with line slicing, size limits, sensitive file blocking |
| `write_file` | exclusive | Create or overwrite files |
| `edit` | exclusive | Text block replacement (hash-anchored + 4-pass fuzzy fallback) |
| `bash` | exclusive | Shell commands — auto-blocks `rm -rf /`, `sudo`, etc. |
| `list_dir` | shared | Directory listing |
| `grep` | shared | Regex code search |
| `todowrite` | shared | Structured task tracking |

Concurrency model: `shared` tools run in parallel; `exclusive` tools run sequentially. Reading files never blocks writing them.

---

## Project Structure

```text
deepicode/packages/
├── core/     # Kernel: reasoning engine
│   ├── engine.ts              # Main loop (AsyncGenerator)
│   ├── client.ts              # DeepSeek SSE client
│   ├── streaming-executor.ts  # Streaming tool executor
│   ├── session.ts             # JSONL async session persistence
│   └── context/               # Three-zone context management
├── tools/    # Tool layer (7 tools)
├── cli/      # readline interactive entry
├── shell/    # State management & event system (planned)
├── tui/      # Ink/React TUI (planned)
└── security/ # Permission engine (planned)
```

---

## Development Progress

| Phase | Content | Status |
|-------|---------|--------|
| 0 | Scaffolding & monorepo | ✅ |
| 1 | Core engine (SSE, context, streaming executor) | ✅ |
| 2 | **Intelligent tier system & cost estimation** | ⬜ |
| 3 | Shell enhancement (state, events) | ⬜ |
| 4 | Tool completion (9-pass fuzzy, session recovery) | 🔄 |
| 5 | Security layer (permission engine, git snapshots) | ⬜ |

More: [`TODO.md`](./TODO.md) · [`DONE.md`](./DONE.md)

---

## Development

```bash
bun test           # 43 pass / 0 fail
bun run typecheck  # TypeScript type check
```

---

## Docs

| Doc | Content |
|-----|---------|
| [Design](./Deepicode项目设计文档.md) | Architecture, context model, strategy system |
| [Implementation Plan](./Deepicode实施计划.md) | Phase-by-phase steps & acceptance criteria |
| [TODO](./TODO.md) | Current tasks & priorities |
| [DONE](./DONE.md) | Completed work & known limitations |
| [FindBug](./FindBug.md) | Agent-specific bug patterns & review guide |
| [ADVICE](./ADVICE.md) | Full audit findings & fix log |

---

## Contributing

Issues and PRs welcome. Fork → Feature Branch → Commit → PR.

---

## Free Providers

deepicode supports these free providers (no API key required):

| Provider | Description | Rate Limit |
|---|---|---|
| **Kilo (Free)** | Anonymous free tier via `api.kilo.ai`, Nemotron-3 Super 120B | ~200 req/hr/IP |
| **LLM7 (Free)** | Anonymous free aggregator, offers Qwen3 235B, Codestral, Mistral Small | ~100 req/hr |
| **Free Auto** | Smart routing across verified free models with serial failover on rate limits | Upstream-dependent |

Use `/model` command or select from the terminal. Anonymous free tier prompts/outputs may be logged by upstream providers — do not send sensitive information.

## License

MIT · [`LICENSE`](./LICENSE)

---

## Acknowledgments

Design inspired by:

- [Reasonix](https://github.com/bzcsk2/reasonix-core) — Cache-first engine
- [oh-my-pi](https://github.com/earendil-works/pi-mono) — Agent state management
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) — Streaming tool execution
- [OpenCode](https://github.com/opencode-ai/opencode) — Fuzzy Edit & Stale-read
