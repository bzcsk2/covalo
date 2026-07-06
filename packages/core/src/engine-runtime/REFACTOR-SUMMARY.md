# Engine Runtime Refactoring — PR 1–7 Summary

## Goal

Split the monolithic `engine.ts` (~1940 lines) into focused runtime services and policy modules,
without changing behavior, prompts, tool schemas, or TUI copy.

## Completed Boundaries

### PR-1: Protocol Boundary
- Created `packages/protocol/` package
- Migrated stable protocol types: `ChatMessage`, `ToolSpec`, `AgentTool`, `ToolContext`, `QuestionInfo`, `SubagentRunOptions`
- `LoopEvent` / `AgentConfig` remain in core
- No behavioral change

### PR-2: Core Tools Runtime Decoupling
- Introduced `ToolRuntimeHooks` interface
- 6th constructor param on `ReasonixEngine`
- Dynamic imports replaced with explicit hooks
- Unblocked test injection of tool behaviors

### PR-3: CLI Bootstrap Split
- `createCovaloRuntime()` factory extracted
- Pipe / TUI mode initialization separated from engine construction
- Reduced `cli.ts` surface

### PR-4: Engine Runtime Services
- 5 runtime classes extracted from `engine.ts`:

| Runtime | Responsibility |
|---|---|
| `EngineInstructionRuntime` | Pending instruction queue (enqueue/take/clear) |
| `EngineSessionRuntime` | Session ID, writer, stats, drain |
| `EngineToolRuntime` | Tool registry, permission engine, hooks |
| `EngineSupervisorRuntime` | Subagent registry, questions, child engines |
| `EngineGovernanceRuntime` | Strictness, policy, branch budget, mode decision, verification gate |

- 3 helper functions extracted: `buildSupervisorLoopModePrompt`, `buildActiveSkillsPrompt`, `injectExperienceRecall`
- Backward-compatible getters on `ReasonixEngine` for test-accessed properties

### PR-5: Checkpoint Policy
- `recoverCheckpoint()` — checkpoint recovery at submit start (loadV2 + applySnapshot + mode signals)
- `saveFinalCheckpoint()` — final checkpoint save on shutdown

### PR-6: Branch Budget Policy
- `configureBranchBudget()` — map effectivePolicy.branchBudget to tracker enabled/disabled + workspace root

### PR-7: Read-Before-Write Policy
- `configureReadBeforeWrite()` — map `block`/`warn`/`off` to `ReadTracker` strictness

## engine.ts Metrics

| Metric | Before | After |
|---|---|---|
| Lines | ~1940 | ~1517 |
| Reduction | — | ~22% |
| Runtime service files | 0 | 5 |
| Policy modules | 0 | 3 |
| Helper modules | 0 | 3 |

## Test Stability

- 2600 pass / 34 pre-existing failures (edit tool, eval fixtures — untouched)
- typecheck, build, smoke:cli, pack:dry-run all green

## Remaining Cleanup Applied (PR-4 follow-up)

Removed 6 unused methods from extracted runtimes:
- `session-runtime.ts`: `loadMessages`, `incrementToolCalls`, `getWriterStatus`, `enqueueToWriter`
- `governance-runtime.ts`: `resetForSubmit`
- `supervisor-runtime.ts`: `clearDelegatedEvents`

## Next Candidates (Not Started)

- `ToolRuntimePolicy` / shell policy extraction
- `loop.ts` policy pipeline skeleton
- Context Manager refactor (PR-8+)
