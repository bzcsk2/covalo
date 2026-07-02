import type { HookManager, ToolCallHooks, BeforeToolCallContext, ToolCallResult } from "@covalo/security"
import type { BridgedHook } from "./hook-bridge.js"
import { parseEccHooks } from "./hook-bridge.js"
import type { ResolvedContentPack, ContentPackDiagnostic } from "./types.js"
import { spawn } from "node:child_process"
import { resolve, relative, isAbsolute } from "node:path"

export interface EccHookAdapterOptions {
  hookManager: HookManager
  hookTimeoutMs?: number
  stdoutMaxLen?: number
  stderrMaxLen?: number
  diagnosticCallback?: (diag: ContentPackDiagnostic) => void
}

// ECC tool name -> Deepreef tool name mapping for matchers
const TOOL_NAME_MAP: Record<string, string> = {
  Read: "read_file",
  Write: "write_file",
  Edit: "edit",
  MultiEdit: "edit",
  Bash: "bash",
  Grep: "grep",
  Glob: "glob",
  TodoWrite: "todo_write",
  ListDir: "list_dir",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
  Skill: "Skill",
  Task: "task_create",
  AskUser: "ask_user_question",
  Notebook: "notebook_edit",
  Sleep: "sleep",
}

const TIMEOUT_DEFAULT = 30_000
const STDOUT_MAX_DEFAULT = 10_000
const STDERR_MAX_DEFAULT = 10_000

function eccToDeepreefToolName(eccName: string): string {
  return TOOL_NAME_MAP[eccName] ?? eccName
}

/**
 * Check if a tool name matches an ECC matcher pattern.
 * ECC uses compound matchers like "Edit|Write" or single names like "Bash".
 */
function matchToolMatcher(matcher: string, toolName: string): boolean {
  if (!matcher || matcher === "*") return true
  const parts = matcher.split("|").map(p => p.trim())
  const covaloName = eccToDeepreefToolName(toolName)
  return parts.some(part => {
    return part === toolName || part === covaloName || eccToDeepreefToolName(part) === toolName || eccToDeepreefToolName(part) === covaloName
  })
}

// Keep track of which lifecycle hooks have already been triggered
// to prevent loop hooks from firing on every event
const executedLifecyclePhases = new Map<ResolvedContentPack, Set<string>>()

/**
 * Create a ToolCallHooks adapter that bridges ECC command hooks
 * into the Deepreef HookManager lifecycle.
 *
 * Security: ECC hooks are recognized but NOT executed by default.
 * Execution requires:
 *   1. hooks.enabled === true
 *   2. hooks.allowCommandHooks === true
 *   3. Hook ID is in the allowlist (must be explicitly configured)
 */
export function createEccHookAdapter(
  cp: ResolvedContentPack,
  workspaceRoot: string,
  options: EccHookAdapterOptions,
): ToolCallHooks | null {
  const hookAssets = cp.assets.hooks
  if (hookAssets.length === 0) return null

  const hookOptions = cp.options.hooks ?? {}
  if (hookOptions.enabled !== true) {
    options.diagnosticCallback?.({
      type: "info",
      pluginId: cp.id,
      message: `ECC hooks recognized but not executed (disabled by config)`,
    })
    return null
  }

  // Must explicitly allow command hooks
  if (hookOptions.allowCommandHooks !== true) {
    options.diagnosticCallback?.({
      type: "info",
      pluginId: cp.id,
      message: `ECC hooks recognized but not executed (allowCommandHooks not enabled)`,
    })
    return null
  }

  // Parse all hook files
  const allBridged: BridgedHook[] = []
  const warnings: string[] = []

  for (const asset of hookAssets) {
    const result = parseEccHooks(asset.path)
    allBridged.push(...result.hooks)
    warnings.push(...result.warnings)
  }

  if (allBridged.length === 0) {
    for (const w of warnings) {
      options.diagnosticCallback?.({ type: "warn", pluginId: cp.id, message: w })
    }
    return null
  }

  // Allowlist must be explicitly configured (default deny-all for security)
  const allowlist = hookOptions.allowlist
  if (!allowlist || allowlist.length === 0) {
    options.diagnosticCallback?.({
      type: "warn",
      pluginId: cp.id,
      message: `No hook allowlist configured; all ${allBridged.length} hooks blocked by default`,
    })
    return null
  }

  // Filter by allowlist using hook ID (from manifest hook.id)
  const bridged = allBridged.filter(h => allowlist.includes(h.id) || allowlist.includes("*"))
  const denied = allBridged.filter(h => !allowlist.includes(h.id) && !allowlist.includes("*"))
  for (const d of denied) {
    options.diagnosticCallback?.({
      type: "info",
      pluginId: cp.id,
      message: `ECC hook "${d.id}" not in allowlist, skipped`,
    })
  }

  if (bridged.length === 0) {
    options.diagnosticCallback?.({
      type: "warn",
      pluginId: cp.id,
      message: `No ECC hooks passed allowlist filtering`,
    })
    return null
  }

  // Create the adapter
  const timeoutMs = options.hookTimeoutMs ?? TIMEOUT_DEFAULT
  const stdoutMax = options.stdoutMaxLen ?? STDOUT_MAX_DEFAULT
  const stderrMax = options.stderrMaxLen ?? STDERR_MAX_DEFAULT

  const adapter: ToolCallHooks = {}

  // --- beforeToolCall ---
  const beforeHooks = bridged.filter(h => h.phase === "beforeToolUse")
  if (beforeHooks.length > 0) {
    adapter.beforeToolCall = async (context: BeforeToolCallContext) => {
      const matchedHooks = beforeHooks.filter(h => matchToolMatcher(h.toolMatcher, context.toolName))

      for (const hook of matchedHooks) {
        try {
          const result = await executeHookCommandSafe(
            hook.command,
            workspaceRoot,
            cp.rootDir,
            timeoutMs,
            stdoutMax,
            stderrMax,
          )
          if (result.error) {
            options.diagnosticCallback?.({
              type: "error",
              pluginId: cp.id,
              message: `Before hook "${hook.id}" failed: ${result.error}`,
            })
            return "deny" // fail-safe: deny on hook failure
          }
        } catch (e) {
          options.diagnosticCallback?.({
            type: "error",
            pluginId: cp.id,
            message: `Before hook "${hook.id}" threw: ${e instanceof Error ? e.message : String(e)}`,
          })
          return "deny" // fail-safe: deny on exception
        }
      }
      return // no opinion
    }
  }

  // --- afterToolCall ---
  const afterHooks = bridged.filter(h => h.phase === "afterToolUse")
  if (afterHooks.length > 0) {
    adapter.afterToolCall = async (toolName: string, result: ToolCallResult) => {
      const matchedHooks = afterHooks.filter(h => matchToolMatcher(h.toolMatcher, toolName))

      for (const hook of matchedHooks) {
        try {
          await executeHookCommandSafe(
            hook.command,
            workspaceRoot,
            cp.rootDir,
            timeoutMs,
            stdoutMax,
            stderrMax,
          )
        } catch {
          // after hooks must not break the flow
        }
      }
    }
  }

  // --- onLoopEvent ---
  // Lifecycle hooks dispatch by event type, not all-at-once.
  // Event type mapping:
  //   "startup" → onStartup phase
  //   "shutdown" → onShutdown phase
  //   "generation_complete" / "stop" → onGenerationComplete phase
  const lifecycleByPhase = new Map<string, BridgedHook[]>()
  for (const h of bridged) {
    if (h.phase === "onStartup" || h.phase === "onShutdown" || h.phase === "onGenerationComplete") {
      const list = lifecycleByPhase.get(h.phase) ?? []
      list.push(h)
      lifecycleByPhase.set(h.phase, list)
    }
  }

  if (lifecycleByPhase.size > 0) {
    if (!executedLifecyclePhases.has(cp)) {
      executedLifecyclePhases.set(cp, new Set())
    }
    const executed = executedLifecyclePhases.get(cp)!

    adapter.onLoopEvent = async (event: Record<string, unknown>) => {
      // Deepreef emits event.role, not event.type
      // Common roles: "done", "startup", "shutdown", "tool_start", etc.
      const role = (event.role ?? event.type ?? event.eventType ?? "") as string
      let targetPhase: string | null = null

      if (role === "startup") {
        targetPhase = "onStartup"
      } else if (role === "shutdown" || role === "sessionEnd") {
        targetPhase = "onShutdown"
      } else if (role === "done" || role === "stop" || role === "complete") {
        targetPhase = "onGenerationComplete"
      }

      if (!targetPhase || executed.has(targetPhase)) return

      const hooks = lifecycleByPhase.get(targetPhase)
      if (!hooks) return

      executed.add(targetPhase)

      for (const hook of hooks) {
        try {
          await executeHookCommandSafe(
            hook.command,
            workspaceRoot,
            cp.rootDir,
            timeoutMs,
            stdoutMax,
            stderrMax,
          )
        } catch {
          // loop_event hooks must not break the flow
        }
      }
    }
  }

  options.diagnosticCallback?.({
    type: "info",
    pluginId: cp.id,
    message: `Registered ${bridged.length} ECC command hooks from ${cp.name}`,
  })

  return adapter
}

/** Clean lifecycle state when content pack is disposed */
export function clearEccHookState(cp: ResolvedContentPack): void {
  executedLifecyclePhases.delete(cp)
}

/**
 * Check whether unsafe (sh -c) plugin hook execution is allowed.
 * Default is off (fail-closed). Set COVALO_ALLOW_UNSAFE_PLUGIN_HOOKS=1 to enable.
 */
function isUnsafePluginHookAllowed(): boolean {
  return process.env.COVALO_ALLOW_UNSAFE_PLUGIN_HOOKS === "1"
}

/**
 * Safely parse a hook command into executable + args for spawn().
 *
 * In safe mode:
 * - Rejects shell metacharacters
 * - Allows $CLAUDE_PLUGIN_ROOT/... or ${CLAUDE_PLUGIN_ROOT}/... prefix
 * - Allows relative paths (resolved against pluginRoot, must be contained)
 * - Returns { executable, args } for spawn(executable, args, { shell: false })
 *
 * In unsafe mode (env override), returns null to signal "use sh -c as-is".
 */
function parseHookCommand(
  command: string,
  pluginRoot: string,
): { executable: string; args: string[] } | { error: string } | null {
  // Unsafe mode: skip parsing, caller will use sh -c
  if (isUnsafePluginHookAllowed()) {
    return null
  }

  if (!command || typeof command !== "string") {
    return { error: "Hook command must be a non-empty string" }
  }

  // Reject NUL character
  if (command.includes("\0")) {
    return { error: "Hook command contains NUL character" }
  }

  // Reject shell metacharacters
  const shellMeta = /[;&|<>`]|\$\(|\n|\r/
  if (shellMeta.test(command)) {
    return { error: "Hook command contains shell metacharacters; rejected in safe mode" }
  }

  // Split into argv-style tokens (simple split on whitespace,
  // not shell-style parsing, since shell metacharacters are already rejected)
  const tokens = command.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return { error: "Empty hook command" }
  }

  const first = tokens[0]
  const rest = tokens.slice(1)
  let resolvedPath: string | null = null
  let restArgs: string[] = rest

  // Handle $CLAUDE_PLUGIN_ROOT/... or ${CLAUDE_PLUGIN_ROOT}/... prefix (without shell substitution)
  const dollarVarMatch = first.match(/^\$CLAUDE_PLUGIN_ROOT(\/.+)$/)
  const dollarBraceMatch = first.match(/^\$\{CLAUDE_PLUGIN_ROOT\}(\/.+)$/)

  if (dollarVarMatch) {
    resolvedPath = resolve(pluginRoot, dollarVarMatch[1])
  } else if (dollarBraceMatch) {
    resolvedPath = resolve(pluginRoot, dollarBraceMatch[1])
  } else if (first.includes("/") || first.startsWith(".")) {
    // Relative path — resolve against pluginRoot
    resolvedPath = resolve(pluginRoot, first)
  } else {
    // Safe mode: reject bare command names (e.g. "node", "python3", "bash")
    // Only pluginRoot-relative paths or $CLAUDE_PLUGIN_ROOT/... references are allowed.
    // Set COVALO_ALLOW_UNSAFE_PLUGIN_HOOKS=1 to allow PATH commands.
    return {
      error: `Hook command "${first}" is a bare command name; rejected in safe mode. ` +
        `Use a pluginRoot-relative path (e.g. ./scripts/hook.js) or ` +
        `$CLAUDE_PLUGIN_ROOT/scripts/hook.js instead.`,
    }
  }

  // Containment check: resolvedPath must be within pluginRoot
  const rel = relative(pluginRoot, resolvedPath!)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `Hook command resolves outside plugin root: ${command}` }
  }

  return {
    executable: resolvedPath!,
    args: restArgs,
  }
}

/**
 * Execute a hook command with security constraints:
 * - cwd fixed to workspace root
 * - minimal environment (PATH only)
 * - timeout enforcement (child process is killed on timeout)
 * - stdout/stderr length caps
 * - In safe mode (default): uses spawn(argv) instead of sh -c, rejects shell metacharacters
 * - In unsafe mode (COVALO_ALLOW_UNSAFE_PLUGIN_HOOKS=1): uses sh -c for backward compat
 */
async function executeHookCommandSafe(
  command: string,
  workspaceRoot: string,
  pluginRoot: string,
  timeoutMs: number,
  stdoutMax: number,
  stderrMax: number,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  // Try to parse the command safely
  const parsed = parseHookCommand(command, pluginRoot)

  // If parsing returned an error, fail closed
  if (parsed && "error" in parsed) {
    return { code: null, stdout: "", stderr: "", error: parsed.error }
  }

  // If parsed is null, use legacy sh -c mode (unsafe override)
  if (parsed === null) {
    return executeHookCommandUnsafe(command, workspaceRoot, pluginRoot, timeoutMs, stdoutMax, stderrMax)
  }

  // Safe mode: use spawn(executable, args, { shell: false })
  return executeHookCommandSpawn(parsed.executable, parsed.args, workspaceRoot, pluginRoot, timeoutMs, stdoutMax, stderrMax)
}

/**
 * Execute a hook command using spawn(executable, args, { shell: false }) — safe mode.
 */
async function executeHookCommandSpawn(
  executable: string,
  args: string[],
  workspaceRoot: string,
  pluginRoot: string,
  timeoutMs: number,
  stdoutMax: number,
  stderrMax: number,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const platform = process.platform
    const isWin = platform === "win32"

    const child = spawn(executable, args, {
      cwd: workspaceRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        HOME: process.env.HOME ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      detached: !isWin,
    })

    const killTree = () => {
      if (isWin && child.pid) {
        try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]) } catch { /* no-op */ }
      } else if (child.pid) {
        try { process.kill(-child.pid!, "SIGTERM") } catch { /* already dead */ }
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL") } catch { /* already dead */ }
        }, 1000)
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
      settle({
        code: null,
        stdout,
        stderr,
        error: `Hook command timed out after ${timeoutMs}ms: ${executable} ${args.join(" ")}`,
      })
    }, timeoutMs)

    const settle = (result: { code: number | null; stdout: string; stderr: string; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill("SIGKILL") } catch { /* no-op */ }
      resolve(result)
    }

    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length < stdoutMax) {
        stdout += data.toString("utf8").slice(0, stdoutMax - stdout.length)
      }
    })

    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < stderrMax) {
        stderr += data.toString("utf8").slice(0, stderrMax - stderr.length)
      }
    })

    child.on("close", (code) => {
      if (!timedOut) {
        if (stdout.length >= stdoutMax) stdout += "\n[output truncated]"
        if (stderr.length >= stderrMax) stderr += "\n[output truncated]"
        settle({ code, stdout, stderr })
      }
    })

    child.on("error", (err) => {
      if (!timedOut) {
        settle({ code: null, stdout, stderr, error: err.message })
      }
    })
  })
}

/**
 * Execute a hook command using sh -c (legacy unsafe mode).
 * Only used when COVALO_ALLOW_UNSAFE_PLUGIN_HOOKS=1 is set.
 */
async function executeHookCommandUnsafe(
  command: string,
  workspaceRoot: string,
  pluginRoot: string,
  timeoutMs: number,
  stdoutMax: number,
  stderrMax: number,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise((resolve) => {
    let stdout = ""
    let stderr = ""
    let timedOut = false
    let settled = false

    const platform = process.platform
    const isWin = platform === "win32"

    const child = spawn("sh", ["-c", command], {
      cwd: workspaceRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        HOME: process.env.HOME ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: !isWin,
    })

    const killTree = () => {
      if (isWin && child.pid) {
        try { spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"]) } catch { /* no-op */ }
      } else if (child.pid) {
        try { process.kill(-child.pid!, "SIGTERM") } catch { /* already dead */ }
        setTimeout(() => {
          try { process.kill(-child.pid!, "SIGKILL") } catch { /* already dead */ }
        }, 1000)
      }
    }

    const timer = setTimeout(() => {
      timedOut = true
      killTree()
      settle({
        code: null,
        stdout,
        stderr,
        error: `Hook command timed out after ${timeoutMs}ms: ${command.slice(0, 80)}`,
      })
    }, timeoutMs)

    const settle = (result: { code: number | null; stdout: string; stderr: string; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill("SIGKILL") } catch { /* no-op */ }
      resolve(result)
    }

    child.stdout?.on("data", (data: Buffer) => {
      if (stdout.length < stdoutMax) {
        stdout += data.toString("utf8").slice(0, stdoutMax - stdout.length)
      }
    })

    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < stderrMax) {
        stderr += data.toString("utf8").slice(0, stderrMax - stderr.length)
      }
    })

    child.on("close", (code) => {
      if (!timedOut) {
        if (stdout.length >= stdoutMax) stdout += "\n[output truncated]"
        if (stderr.length >= stderrMax) stderr += "\n[output truncated]"
        settle({ code, stdout, stderr })
      }
    })

    child.on("error", (err) => {
      if (!timedOut) {
        settle({ code: null, stdout, stderr, error: err.message })
      }
    })
  })
}
