# Operations

Last consolidated: 2026-06-25.

This document is the operational reference for installing, running, configuring, diagnosing, and safely using DeepReef.

## Installation and startup

Install the published CLI:

```bash
npm install -g @deepreef/cli
```

or:

```bash
bun install -g @deepreef/cli
```

Run from source:

```bash
git clone https://github.com/bzcsk2/DeepReef.git
cd DeepReef
bun install
bun run dev
```

Top-level CLI commands:

```bash
deepreef                         # start interactive TUI
deepreef --help                  # show help
deepreef --version               # show version
deepreef config <subcommand>     # manage config
```

## TUI commands

Common slash commands:

| Command | Purpose |
| --- | --- |
| `/help` | Show help. |
| `/model` | Switch provider/model/base URL/API key for the current role. |
| `/workflow` | Start or control the Supervisor/Worker loop. |
| `/goal` | View or manage the active loop goal. |
| `/sessions` | Browse and restore sessions. |
| `/skill` | Browse and enable skills. |
| `/status` | Show runtime status. |
| `/context` | Adjust context policy. |
| `/thinking` | Adjust thinking mode. |
| `/harness` | Adjust weak-model execution constraints. |
| `/lang` | Switch Chinese/English UI language. |
| `/config` | Show or change configuration. |

Goal commands are only meaningful in loop/workflow mode:

```text
/goal
/goal <objective>
/goal edit <new objective>
/goal pause
/goal resume
/goal clear
/goal budget <tokens>
/goal no-budget
```

Goal state is persisted with the session:

```text
.deepreef/sessions/<sessionId>/goal.json
```

## Configuration

DeepReef now has a unified TOML configuration system. Config is validated with Zod and loaded from defaults, user config, project config, and CLI/TUI overrides.

Effective priority, from low to high:

```text
built-in defaults
  < user config: ~/.deepreef/config.toml
  < project config: <project>/.deepreef/config.toml
  < CLI overrides
  < TUI/session-level temporary overrides
```

Runtime state is not static config. Sessions, active goal state, mailbox entries, token usage, and workflow phase remain runtime/session data.

### Config CLI

```bash
deepreef config path
deepreef config print
deepreef config print --redact
deepreef config print --json
deepreef config validate
deepreef config doctor
deepreef config edit
deepreef config init
deepreef config init --template local-first
deepreef config init --template safe-readonly
deepreef config init --template autonomous-coding
```

Use `--project` with `init` or `edit` to target the project config instead of the user config.

### Config shape

The canonical in-code schema uses camelCase keys. The parser also normalizes snake_case input, but new docs and examples should prefer camelCase.

Minimal example:

```toml
version = 1

[workflow]
defaultMode = "loop"
maxRounds = 6
structuredProtocol = true
requireJsonDecisions = true
legacyTextFallback = true
askUserOnBlocked = true
autoResumeAfterAskUser = false
maxConsecutiveErrors = 2
supervisorInterventionErrorThreshold = 2

[goal]
enabled = true
autoContinue = true
maxAutoContinuations = 10
maxConsecutiveBlockedTurns = 3
maxConsecutiveTurnErrors = 2
defaultTokenBudget = 0
completionAuditRequired = true
blockedAuditRequired = true
injectContinuationPrompt = true
injectObjectiveUpdatedPrompt = true
injectBudgetLimitPrompt = true

[tools]
approvalPolicy = "on-request"
sandbox = "workspace-write"
dangerousToolsEnabled = false

[tools.supervisor.loop]
allow = []
deny = ["bash", "edit_file", "apply_patch", "write_file", "AgentTool"]

[tools.worker.loop]
allow = []
deny = ["update_goal"]

[logging]
level = "info"
path = ".deepreef/logs"
eventsJsonl = true
mailboxJsonl = true
workflowJsonl = true
redactSecrets = true
```

Provider example:

```toml
[providers.local]
type = "openai-compatible"
baseUrl = "http://localhost:11434/v1"
apiKey = "none"
model = "qwen2.5-coder:7b"
local = true
free = false
timeoutMs = 30000
maxRetries = 3
headers = {}

[agents.worker]
provider = "local"
reasoningEffort = "medium"
temperature = 0.1
topP = 1
maxOutputTokens = 8192
contextStrategy = "full"
contextTurns = 20
```

### Config troubleshooting

```bash
# Show config paths
deepreef config path

# Validate user/project/effective config
deepreef config validate

# Print effective config with secrets redacted
deepreef config print --redact

# Inspect likely config problems
deepreef config doctor
```

If config seems ineffective, check the target path, run `deepreef config validate`, reload from the TUI if applicable, and confirm a higher-priority project config is not overriding the user config.

## Model providers

DeepReef supports built-in provider families and arbitrary OpenAI-compatible endpoints. Use `/model` for interactive selection and role assignment.

| Family | Notes |
| --- | --- |
| DeepSeek | `deepseek-v4-flash-free`, `deepseek-v4-flash`, `deepseek-v4-pro`; user API key supported. |
| Mimo | `mimo-v2.5-free`, `mimo-v2.5-pro`, `mimo-v2.5`; user API key supported. |
| Qwen | Qwen models through vLLM, Ollama, llama.cpp, or OpenAI-compatible endpoints. |
| Gemma | Gemma models through vLLM, Ollama, llama.cpp, or OpenAI-compatible endpoints. |
| Kimi | Kimi model presets; user API key supported. |
| GLM/ZAI | GLM model presets; user API key supported. |
| Minimax | Minimax model presets. |
| Stepfun | `step-3.7-flash-free`, `step-3.7-flash`, `step-3.7-turbo`; user API key supported. |
| NVIDIA | Nemotron/NIM presets; NIM API key supported. |
| OpenAI | OpenAI-compatible presets such as `gpt-oss-120b`; user API key supported. |
| Custom | Any OpenAI-compatible endpoint. |

Thinking modes:

```text
/thinking off
/thinking high
/thinking max
```

Recommended split for DeepSeek-style usage:

- Supervisor: stronger model, higher thinking, review-heavy role.
- Worker: cheaper/free/local model, execution-heavy role, with stricter harness and evidence reporting.

Provider/model IDs change faster than architecture. Treat `packages/core/src/config.ts` as the source of truth when updating this section.

## Logging and diagnostics

The unified config has a `[logging]` section:

```toml
[logging]
level = "info"          # debug | info | warn | error
path = ".deepreef/logs"
eventsJsonl = true
mailboxJsonl = true
workflowJsonl = true
redactSecrets = true
```

Expected log layout:

```text
.deepreef/logs/
  runtime-YYYY-MM-DD.jsonl
  mailbox-YYYY-MM-DD.jsonl
  workflow-YYYY-MM-DD.jsonl
```

JSONL records are intended for `jq`:

```bash
# Inspect warnings/errors
cat .deepreef/logs/*.jsonl | jq 'select(.level == "warn" or .level == "error")'

# Inspect tool failures
cat .deepreef/logs/*.jsonl | jq 'select(.event == "tool.execute.done" and .isError == true)'

# Inspect API usage if present
cat .deepreef/logs/*.jsonl | jq 'select(.event == "api.usage")'
```

Sensitive fields such as API keys, authorization headers, tokens, cookies, passwords, and secrets should be redacted. Keep `redactSecrets = true` unless debugging a local-only throwaway environment.

## Tracing

Trace config exists under `[trace]`:

```toml
[trace]
enabled = true
includePrompts = false
includeToolArgs = true
includeToolResults = false
includeModelOutputs = false
```

If prompt or model-output capture is enabled, treat trace files as sensitive artifacts.

## Safety boundary

DeepReef is a local engineering agent. It can read and write files, run commands, access networks, and invoke extension tools. It is not a complete sandbox.

Current safety mechanisms include:

- deny-first permission engine,
- write and shell permission checks,
- dangerous command blocking,
- stale-read edit protection,
- file snapshots,
- web request SSRF protections,
- role/mode/workflow-phase tool filtering,
- configurable hard-deny tool policy.

Operational rules:

- Do not commit API keys or `.deepreef/` runtime/session data.
- Do not run autonomous coding mode in a repository whose changes you are unwilling to review.
- Prefer `safe-readonly` config for audits, onboarding, and repo exploration.
- Prefer project-level config for team/repo policy and user-level config for personal model/provider preferences.
