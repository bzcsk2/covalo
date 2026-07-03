import { readFileSync } from "node:fs"

export interface EccHookEntry {
  id: string
  description: string
  matcher: string
  type: "command"
  command: string
  async?: boolean
  timeout?: number
}

export interface EccHookManifest {
  hooks: {
    PreToolUse?: Array<{ matcher: string; hooks: Array<{ id?: string; description?: string; type: string; command: string; async?: boolean; timeout?: number }>; description?: string; id?: string }>
    PostToolUse?: Array<{ matcher: string; hooks: Array<{ id?: string; description?: string; type: string; command: string; async?: boolean; timeout?: number }>; description?: string; id?: string }>
    PostToolUseFailure?: Array<{ matcher: string; hooks: Array<{ id?: string; description?: string; type: string; command: string; async?: boolean; timeout?: number }>; description?: string; id?: string }>
    Stop?: Array<{ matcher: string; hooks: Array<{ id?: string; description?: string; type: string; command: string; async?: boolean; timeout?: number }>; description?: string; id?: string }>
    SessionStart?: Array<{ matcher: string; hooks: Array<{ id?: string; description?: string; type: string; command: string; async?: boolean; timeout?: number }>; description?: string; id?: string }>
    SessionEnd?: Array<{ matcher: string; hooks: Array<{ id?: string; description?: string; type: string; command: string; async?: boolean; timeout?: number }>; description?: string; id?: string }>
    PreCompact?: Array<{ matcher: string; hooks: Array<{ id?: string; description?: string; type: string; command: string; async?: boolean; timeout?: number }>; description?: string; id?: string }>
  }
}

export type DeepreefHookPhase = "beforeToolUse" | "afterToolUse" | "onGenerationComplete" | "onStartup" | "onShutdown"

export interface BridgedHook {
  id: string
  phase: DeepreefHookPhase
  toolMatcher: string
  command: string
  timeout?: number
}

const PHASE_MAP: Record<string, DeepreefHookPhase> = {
  PreToolUse: "beforeToolUse",
  PostToolUse: "afterToolUse",
  PostToolUseFailure: "afterToolUse",
  Stop: "onGenerationComplete",
  SessionStart: "onStartup",
  SessionEnd: "onShutdown",
}

export function parseEccHooks(filePath: string): { hooks: BridgedHook[]; warnings: string[] } {
  const warnings: string[] = []
  try {
    const raw = readFileSync(filePath, "utf8")
    const manifest = JSON.parse(raw) as EccHookManifest
    if (!manifest.hooks) {
      return { hooks: [], warnings: ["No hooks section found"] }
    }
    const bridged: BridgedHook[] = []
    for (const [eccPhase, entries] of Object.entries(manifest.hooks)) {
      const covaloPhase = PHASE_MAP[eccPhase]
      if (!covaloPhase) {
        warnings.push(`Unknown ECC hook phase "${eccPhase}", skipping`)
        continue
      }
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        const matcher = entry.matcher ?? "*"
        const entryId = entry.id // Hook ID is on the outer entry, not the inner hook
        const hooks = entry.hooks ?? []
        for (const hook of hooks) {
          if (hook.type !== "command") {
            warnings.push(`Non-command hook type "${hook.type}" not supported, skipping`)
            continue
          }
          if (!hook.command) continue
          // Use entry.id as primary ID, fall back to inner hook.id
          const hookId = entryId
            ? `ecc:${entryId}`
            : hook.id
              ? `ecc:${hook.id}`
              : `ecc:${matcher}:${hook.command.slice(0, 40)}`
          bridged.push({
            id: hookId,
            phase: covaloPhase,
            toolMatcher: matcher,
            command: hook.command,
            timeout: hook.timeout ?? 30,
          })
        }
      }
    }
    return { hooks: bridged, warnings }
  } catch (e) {
    return { hooks: [], warnings: [`Failed to parse ECC hooks: ${e instanceof Error ? e.message : String(e)}`] }
  }
}

// Phase 2.2: executeEccHookCommand 已删除（被 executeHookCommandSafe 取代）。
// 详见 docs/unintegrated_code_audit_20260703.md §3.10a。
