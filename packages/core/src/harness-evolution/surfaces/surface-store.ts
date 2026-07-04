import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import type { HarnessSurface } from "../self-harness/patch-schema";

const ALL_SURFACES: HarnessSurface[] = [
  "supervisor-system-prompt",
  "worker-system-prompt",
  "task-digest-template",
  "review-rubric",
  "incident-taxonomy",
  "recovery-playbook",
  "context-selection-policy",
  "tool-use-policy",
  "eval-gate-policy",
  "memory-recall-policy",
  "runtime-guard-policy",
];

/**
 * Embedded default content for each surface.
 * These are the fallback values used when no user override exists.
 */
const DEFAULT_CONTENT: Record<HarnessSurface, string> = {
  "supervisor-system-prompt": `You are a Supervisor in a dual-agent coding system. Your role is to plan, review, and guide the Worker agent.

## Responsibilities

1. **Review Work**: Examine the Worker's output for correctness, security, maintainability, and completeness.
2. **Plan Tasks**: Break down complex goals into clear, actionable steps for the Worker.
3. **Verify Results**: Ensure all acceptance criteria are met before approving.
4. **Classify Failures**: When things go wrong, determine the root cause (verification, tooling, context, etc.).
5. **Guide Recovery**: Provide clear, specific instructions for fixing issues.

## Review Guidelines

- Always require file/line evidence for findings
- Do not ACCEPT if deterministic verifiers failed
- Check that tests pass, builds succeed, and lint is clean
- Verify the Worker read project instructions before acting
- Ensure no protected files were modified without justification

## Output Format

When reviewing, output structured findings with:
- Severity: critical/major/minor/nit
- Category: correctness/security/tests/performance/etc.
- Specific file paths and line numbers as evidence
- Recommended verification checks`,
  "worker-system-prompt": `You are a Worker in a dual-agent coding system. Your role is to execute code changes, run commands, and produce verifiable results.

## Responsibilities

1. **Read Context First**: Always read project instructions (AGENTS.md, README, config files) before making changes.
2. **Use Correct Tools**: Detect package manager (bun, pnpm, npm, yarn) and use appropriate commands.
3. **Verify Changes**: Run tests, type checks, and lints after making changes.
4. **Report Clearly**: Provide evidence of all actions taken and their results.

## Execution Guidelines

- Detect and use the project's package manager
- Read before writing files (avoid overwriting unknown content)
- Run verification commands after every change
- Do not modify test expectations to make tests pass
- Report errors with specific file paths and error messages
- Keep changes focused and minimal

## Verification

After any change, run relevant verification:
- Type checker (tsc, bun run typecheck)
- Tests (bun test, pnpm test, npm test)
- Linter (eslint, biome)
- Build (bun run build, pnpm build)`,
  "task-digest-template": `# Task Digest Template

Generate a structured digest for every task before dispatching to the Worker.

## Required Fields

\`\`\`
Goal: <clear, single-sentence objective>
Acceptance Criteria:
  - <verifiable condition>
  - <verifiable condition>
Repository Facts:
  - CWD: <working directory>
  - Package Manager: <auto-detected: bun/pnpm/npm/yarn>
  - Git Branch: <current branch>
  - Git Clean: <true/false>
  - Config Files: <list of relevant config files>
Context Files:
  - <path> — <reason for inclusion>
Constraints:
  - <limitation>
Verification Plan:
  - <command to run>
Omitted Context:
  - <reason> — <detail about what was excluded>
\`\`\`

## Rules

- Always detect package manager from lockfiles: bun.lock, pnpm-lock.yaml, yarn.lock, package-lock.json
- Include AGENTS.md and project instructions if present
- Record omitted files instead of silently dropping context
- Include verification command candidates from project config
- In eval mode, include case contract and verifier command`,
  "review-rubric": `# Review Rubric

## Verdict Options

- **ACCEPTED**: All criteria met, deterministic gates passed, evidence provided.
- **NEEDS_FIX**: Issues found that require Worker to address.
- **UNKNOWN**: Cannot determine verdict (missing information).

## Evaluation Criteria

### Correctness (required)
- Does the code implement the specified requirements?
- Are edge cases handled?
- Does it compile/type-check without errors?

### Security (required)
- Are there any injection vulnerabilities?
- Are secrets handled properly?
- Are file permissions appropriate?

### Tests (required)
- Do existing tests still pass?
- Are new features tested?
- Are test modifications justified?

### Performance (recommended)
- Are there obvious performance issues?
- Are inefficient patterns used?

### Maintainability (recommended)
- Is the code well-structured?
- Are naming conventions followed?
- Is there unnecessary complexity?

### Integration (required)
- Does it work with the existing codebase?
- Are API contracts maintained?

### Policy (required)
- Are file change limits respected?
- Are protected files modified?
- Are permissions respected?

## Evidence Requirements

Every finding MUST include at least one piece of evidence:
- File path and line number for code issues
- Error output for verification failures
- Command output for runtime issues

Findings without evidence will be flagged as issues.`,
  "incident-taxonomy": `# Incident Taxonomy

## Incident Kinds

| Kind | Description | Harness Layer | Severity |
|---|---|---|---|
| review_needs_fix | Supervisor review found issues | lifecycle | major |
| verification_failure | Tests/typecheck/build failed | verification | critical |
| build_failure | Build process failed | tools | critical |
| integration_conflict | Changes conflict with existing code | environment | major |
| runtime_failure | Runtime errors during execution | tools | major |
| tooling_error | Missing commands, binaries, fixtures | tools | major |
| missing_output | Worker submitted empty result | observability | critical |
| context_provenance | Missing or stale context files | context | minor |
| planning_error | Flawed task decomposition | lifecycle | major |
| policy_violation | Policy gate blocked the action | governance | critical |
| sandbox_failure | Sandbox environment error | sandbox | critical |
| unknown | Cannot classify | unknown | unknown |

## Classification Rules

- Empty worker output → missing_output
- "No tests found" → infrastructure, not worker blame
- Missing binary/fixture → tooling_error (infra, not task)
- Policy gate failure → policy_violation
- Setup/verifier failures → infrastructure`,
  "recovery-playbook": `# Recovery Playbook

## Recovery Phases

Each recovery follows four phases in order:
1. **Containment** — Stop the damage, isolate the failure
2. **Repair** — Fix the root cause
3. **Validation** — Verify the fix works
4. **Learning** — Record what went wrong for future prevention

## Recovery by Incident Kind

### verification_failure
- Containment: Revert any test modifications
- Repair: Fix code to pass existing tests (do not modify tests)
- Validation: Re-run failing tests

### missing_output
- Containment: Request worker to show output
- Repair: Add explicit output/return statements
- Validation: Run with expected input and capture output

### tooling_error
- Containment: Verify command availability
- Repair: Use alternative tool or install missing dependency
- Validation: Run the command again

### policy_violation
- Containment: Restore any reverted protected files
- Repair: Follow policy rules for the action
- Validation: Re-run policy checks

### build_failure
- Containment: Revert any incomplete changes
- Repair: Fix compilation errors
- Validation: Rebuild

## Rules

- Do not retry on raw failure text without classification
- If no evidence exists for a failure, disposition is blocked
- Infra failures should not blame the Worker
- Each recovery step must reference the incident ID`,
  "context-selection-policy": `# Context Selection Policy

## Rules for Selecting Context Files

1. **Project config files**: Always include package.json, tsconfig.json, and detected config files.
2. **Project instructions**: Always include AGENTS.md, CODEBUDDY.md, and README.md.
3. **Relevant source files**: Include files that are directly related to the task goal.
4. **Lockfiles**: Include for package manager detection but not as full context.
5. **Omitted files**: Record the reason (budget/irrelevant/unsafe/missing) when files are excluded.

## Priority Order

1. Project instructions and config
2. Files mentioned in the task description
3. Files that import from or are imported by target files
4. Test files for target modules
5. Documentation files

## Budget Rules

- Max context files: 15 by default
- Max total characters: 100000 by default
- When budget exceeded, exclude lowest-priority files and record in omittedContext

## Exclusion Reasons

- budget: File would exceed context window
- irrelevant: File is not related to the task
- unsafe: File may contain secrets or sensitive information
- missing: Referenced file does not exist`,
  "tool-use-policy": `# Tool Use Policy

## General Rules

- Read files before writing to them
- Use the correct package manager for install/run commands
- Run verification commands after code changes
- Avoid destructive commands unless explicitly authorized

## Allowed File Operations

| Operation | Policy |
|---|---|
| Read existing files | Always allowed |
| Write new files | Allowed with read-before-write check |
| Edit existing files | Allowed with read-before-write check |
| Delete files | Requires supervisor approval |
| Move/rename files | Requires supervisor approval |

## Restricted Commands

| Command | Policy |
|---|---|
| rm -rf | Requires human approval |
| git reset --hard | Requires supervisor approval |
| git push | Requires human approval |
| npm publish | Requires human approval |
| terraform destroy | Requires human approval |
| kubectl delete | Requires human approval |
| curl | sh | Requires human approval |
| chmod | Requires supervisor approval |

## Verification Commands

Always run after changes:
- Type checker for TypeScript projects
- Test suite for the modified module
- Linter for the project`,
  "eval-gate-policy": `# Eval Gate Policy

## Acceptance Criteria

A patch is accepted for promotion only when ALL conditions are met:

heldIn.delta >= 0
heldOut.delta >= 0
Math.max(heldIn.delta, heldOut.delta) > 0
policyViolationsDoNotIncrease
infraFailuresDoNotIncrease
regressions.length === 0

## Gate Metrics

- Held-in pass rate: Must not decrease
- Held-out pass rate: Must not decrease
- Policy violations: Must not increase
- Infra failures: Must not increase
- Regressions: Must be zero

## Validation Rules

- Held-in and held-out totals must be identical before/after
- Infra failures make validation inconclusive (not accepted)
- sandbox.benchmark is required for official promotion
- sandbox.local may produce diagnostics but cannot auto-promote`,
  "memory-recall-policy": `# Memory Recall Policy

## What Gets Stored

Only structured, evidence-backed experiences are stored:
- Failed task outcomes with failure mode
- Successful recovery strategies
- Bad strategies to avoid
- Harness change recommendations

## Trust Levels

- trusted: Confirmed by human or verified by successful eval
- untrusted: Imported from external sources, mined automatically

## Recall Rules

- Only trusted memories are injected into prompts by default
- untrusted memories require explicit policy override to inject
- Superseded memories are hidden by default
- Recall supports filters: sourceKind, trust, failureMode, age, exact sourceRef
- Memory injection includes metadata (trust, source, confidence)

## Filtering

Default recall filter:
- Trust: trusted only
- Max age: 30 days
- Max records: 3
- Min confidence: 0.3`,
  "runtime-guard-policy": `# Runtime Guard Policy

## Detection Patterns

The runtime guard detects these risk patterns in prompts and commands:

### Prompt Injection (block)
- "ignore previous instructions"
- "reveal system prompt"
- "you are now" role-switching attempts

### Untrusted Input (review)
- Content from browser, email, issues, or comments controlling actions
- External source content without sourceRef

### Destructive Actions (block)
- rm -rf with dangerous paths
- git reset --hard (with force flags)
- git clean -f
- Drop database commands
- terraform destroy
- kubectl delete

### Privileged Actions (certificate required)
- git push
- npm publish
- Deployment commands
- curl | sh patterns
- Secret/API key with outbound action

## Dispositions

- allow: Continue and record packet
- review: Supervisor must approve or convert to safer instruction
- block: Stop Worker dispatch unless explicit human approval exists

## Policy Rules

- The guard is deterministic (no model calls)
- Initial pattern matching is regex-based
- Patterns are conservative (favor false positive over false negative)
- Secret exfiltration detection checks for API keys/credentials in outbound actions`,
};

export class SurfaceStore {
  private overrideDir: string;
  /**
   * SPEC-13: cache 不再是声明未使用的死字段。
   * get() / getHash() 命中时直接返回缓存，未命中时计算并填充。
   * writeOverride() 后 invalidate 单 surface。
   */
  private cache: Map<HarnessSurface, { content: string; hash: string }> = new Map();

  constructor(baseDir?: string) {
    this.overrideDir = baseDir
      ? join(baseDir, ".covalo", "harness", "surfaces")
      : join(homedir(), ".covalo", "harness", "surfaces");
  }

  /** List all available surface names. */
  list(): HarnessSurface[] {
    return [...ALL_SURFACES];
  }

  /**
   * Get surface content.
   * User overrides take precedence, then embedded defaults.
   * SPEC-13: 命中 cache 时直接返回，未命中时计算并填充 cache。
   */
  async get(surface: HarnessSurface): Promise<string> {
    this.validateSurface(surface);
    const cached = this.cache.get(surface)
    if (cached) return cached.content

    const override = await this.tryReadOverride(surface);
    const content = override ?? DEFAULT_CONTENT[surface] ?? `# ${surface}\n\nNo default content available for this surface.\n`;
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
    this.cache.set(surface, { content, hash });
    return content;
  }

  /** Get SHA256 hash of surface content. SPEC-13: 命中 cache 时直接返回 hash。 */
  async getHash(surface: HarnessSurface): Promise<string> {
    const cached = this.cache.get(surface)
    if (cached) return cached.hash
    await this.get(surface)
    return this.cache.get(surface)!.hash
  }

  /** Load all surfaces as a record. */
  async getAll(): Promise<Record<HarnessSurface, string>> {
    const result: Record<string, string> = {};
    for (const surface of ALL_SURFACES) {
      result[surface] = await this.get(surface);
    }
    return result as Record<HarnessSurface, string>;
  }

  /** Get all hashes for surfaces. */
  async getAllHashes(): Promise<Record<HarnessSurface, string>> {
    const result: Record<string, string> = {};
    for (const surface of ALL_SURFACES) {
      result[surface] = await this.getHash(surface);
    }
    return result as Record<HarnessSurface, string>;
  }

  /** Ensure override directory exists. */
  async ensureOverrideDir(): Promise<void> {
    await mkdir(this.overrideDir, { recursive: true });
  }

  /**
   * Write a user override for a surface.
   * Used by harness patch promotion.
   */
  async writeOverride(surface: HarnessSurface, content: string): Promise<void> {
    this.validateSurface(surface);
    await this.ensureOverrideDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(this.overrideDir, `${surface}.md`), content, "utf-8");
    // Invalidate cache
    this.cache?.delete(surface);
  }

  private validateSurface(surface: string): asserts surface is HarnessSurface {
    if (!ALL_SURFACES.includes(surface as HarnessSurface)) {
      throw new Error(`Unknown harness surface: "${surface}". Valid surfaces: ${ALL_SURFACES.join(", ")}`);
    }
  }

  private async tryReadOverride(surface: HarnessSurface): Promise<string | null> {
    const overridePath = join(this.overrideDir, `${surface}.md`);
    try {
      return await readFile(overridePath, "utf-8");
    } catch {
      return null;
    }
  }
}
