/**
 * CL-52: Slash command parsing and routing — pure logic, no React dependency.
 * Testable without rendering any Ink components.
 */

import { AGENTS, defaultAgentRegistry } from "@covalo/core"
import type { Strings } from "./i18n/strings.js"

export type SlashCommand =
  | { name: "exit" }
  | { name: "help" }
  | { name: "model" }
  | { name: "sessions" }
  | { name: "skill" }
  | { name: "agent" }
  | { name: "thinking"; mode: string }
  | { name: "lang" }
  | { name: "status" }
  | { name: "context" }
  | { name: "harness"; subcommand?: "status" | "strict" | "normal" | "loose" | "project" | "doctor" | "mine" | "propose" | "validate" | "promote" | "history" | "rollback"; arg?: string }
  | { name: "theme"; themeName?: string }
  | { name: "reset" }
  | { name: "alone" }
  | { name: "subagent" }
  | { name: "loop" }
  | { name: "talk"; role?: "worker" | "supervisor" }
  | { name: "cases" }
  | { name: "eval"; legacy?: boolean; models?: string[]; cases?: string[]; limit?: number; dryRun?: boolean }
  | { name: "eval-start"; category: string; suite: string; env?: string }
  | { name: "eval-cancel" }
  | { name: "config"; subcommand?: "open" | "reload" | "set"; path?: string; value?: string }

const THINKING_MODES = ["off", "high", "max"]

/**
 * CL-52: Parse a slash command from user input.
 * Returns null if the input is not a slash command.
 */
export function parseSlashCommand(text: string): SlashCommand | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith("/")) return null

  if (trimmed === "/exit" || trimmed === "/bye") return { name: "exit" }
  if (trimmed === "/help") return { name: "help" }
  if (trimmed === "/model") return { name: "model" }
  if (trimmed === "/sessions") return { name: "sessions" }
  if (trimmed === "/skill") return { name: "skill" }
  if (trimmed === "/agent") return { name: "agent" }
  if (trimmed === "/lang") return { name: "lang" }
  if (trimmed === "/status") return { name: "status" }
  if (trimmed === "/context") return { name: "context" }
  if (trimmed.startsWith("/theme")) {
    const parts = trimmed.split(/\s+/)
    const themeName = parts[1]
    return { name: "theme", themeName }
  }

  if (trimmed.startsWith("/thinking")) {
    const parts = trimmed.split(/\s+/)
    const mode = parts[1]
    return { name: "thinking", mode: mode ?? "" }
  }

  if (trimmed.startsWith("/harness")) {
    const parts = trimmed.split(/\s+/)
    const sub = parts[1]
    // New harness evolution subcommands
    if (sub === "doctor" || sub === "mine" || sub === "propose" || sub === "validate" || sub === "promote" || sub === "history") {
      return { name: "harness" as const, subcommand: sub as any, arg: parts.slice(2).join(" ") }
    }
    if (sub === "rollback") {
      return { name: "harness" as const, subcommand: "rollback" as const, arg: parts[2] }
    }
    // Legacy harness mode switching
    if (sub === "status" || sub === "strict" || sub === "normal" || sub === "loose") {
      return { name: "harness" as const, subcommand: sub as "status" | "strict" | "normal" | "loose" }
    }
    if (sub === "project") {
      return { name: "harness" as const, subcommand: "project" as const, arg: parts[2] }
    }
    return { name: "harness" as const }
  }

  if (trimmed === "/reset") return { name: "reset" }

  if (trimmed.startsWith("/talk")) {
    const parts = trimmed.split(/\s+/)
    const role = parts[1] as "worker" | "supervisor" | undefined
    if (role && role !== "worker" && role !== "supervisor") return null
    return { name: "talk", role }
  }

  if (trimmed.startsWith("/eval-start")) {
    const parts = trimmed.split(/\s+/).slice(1)
    if (parts.length >= 2) {
      const envIndex = parts.indexOf('--env')
      const env = envIndex >= 0 && envIndex + 1 < parts.length ? parts[envIndex + 1] : undefined
      return { name: "eval-start", category: parts[0], suite: parts[1], env }
    }
    return { name: "eval" }
  }

  if (trimmed === "/eval-cancel") {
    return { name: "eval-cancel" }
  }

  if (trimmed.startsWith("/eval")) {
    const parts = trimmed.split(/\s+/).slice(1)
    const result: { name: "eval"; legacy?: boolean; models?: string[]; cases?: string[]; limit?: number; dryRun?: boolean } = { name: "eval" }
    if (parts.length === 0) return result
    let i = 0
    let hasFlags = false
    while (i < parts.length) {
      const flag = parts[i]
      if (flag === "--legacy") {
        result.legacy = true
        hasFlags = true
        i++
      } else if (flag === "--dry-run") {
        result.dryRun = true
        hasFlags = true
        i++
      } else if (flag === "--models" || flag === "--cases") {
        const val = parts[i + 1]
        if (val && !val.startsWith("--")) {
          const list = val.split(",").map(s => s.trim()).filter(Boolean)
          if (flag === "--models") result.models = list
          else result.cases = list
          i += 2
        } else { i++ }
        hasFlags = true
      } else if (flag === "--limit") {
        const val = parts[i + 1]
        const num = val ? parseInt(val, 10) : NaN
        if (!isNaN(num) && num > 0) result.limit = num
        i += 2
        hasFlags = true
      } else {
        i++
      }
    }
    if (!hasFlags) {
      return { name: "eval" }
    }
    return result
  }

  if (trimmed === "/cases") return { name: "cases" }

  // First-class mode switch aliases
  if (trimmed === "/alone") return { name: "alone" }
  if (trimmed === "/subagent") return { name: "subagent" }
  if (trimmed === "/loop") return { name: "loop" }

  if (trimmed.startsWith("/config")) {
    const parts = trimmed.split(/\s+/)
    if (parts.length === 1) return { name: "config" }
    const sub = parts[1]
    if (sub === "open") return { name: "config", subcommand: "open" }
    if (sub === "reload") return { name: "config", subcommand: "reload" }
    // /config <section>.<key> <value> — e.g. /config workflow.max_rounds 10
    if (parts.length >= 3 && parts[2]) {
      return { name: "config", subcommand: "set", path: parts[1], value: parts.slice(2).join(" ") }
    }
    // /config <section> — display section
    return { name: "config", path: parts[1] }
  }

  return null
}

/**
 * CL-52: Validate a thinking mode argument.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateThinkingMode(mode: string): string | null {
  if (!mode || !THINKING_MODES.includes(mode)) {
    return `Usage: /thinking <mode>\nModes: ${THINKING_MODES.join(", ")}`
  }
  return null
}

/**
 * CL-52: Get the valid thinking modes list.
 */
export function getThinkingModes(): string[] {
  return [...THINKING_MODES]
}

/**
 * Cycle to the next agent.
 * Returns the next agent name and its label.
 */
export function toggleAgent(current: string): { next: string; label: string } {
  const agents = defaultAgentRegistry.list()
  const names = agents.map(a => a.name)
  if (names.length === 0) return { next: current, label: current }
  const idx = names.indexOf(current)
  const next = idx >= 0 && idx < names.length - 1 ? names[idx + 1] : names[0]
  const def = defaultAgentRegistry.get(next)
  return { next, label: def?.label ?? next }
}

/**
 * CL-52: Build the /help text.
 */
export function buildHelpText(activeAgent: string, cmdStrings: Strings): string {
  const agentList = defaultAgentRegistry.list()
    .map((a) => `${a.name} — ${a.label}`)
    .join("\n")
  const currentLabel = defaultAgentRegistry.get(activeAgent)?.label ?? AGENTS[activeAgent]?.label ?? activeAgent

  return [
    cmdStrings.helpTitle,
    `  /exit, /bye  — ${cmdStrings.cmdExit}`,
    `  /help        — ${cmdStrings.cmdHelp}`,
    `  /alone       — Switch to single-agent mode (default)`,
    `  /subagent    — Switch to subagent (supervisor dispatch) mode`,
    `  /loop        — Switch to dual-agent loop (worker/supervisor) mode`,
    `  /cases       — ${cmdStrings.cmdCases}`,
    `  /eval        — ${cmdStrings.cmdEval}`,
    `  /eval-start  — Run fixed eval: /eval-start <category> <suite> [--env <env>]`,
    `  /eval-cancel — Cancel the currently running eval`,
    `  /model       — ${cmdStrings.cmdModel}`,
    `  /sessions    — ${cmdStrings.cmdSessions}`,
    `  /agent       — ${cmdStrings.cmdAgent}`,
    `  /skill       — ${cmdStrings.cmdSkill}`,
    `  /lang        — ${cmdStrings.cmdLang}`,
    `  /status      — ${cmdStrings.cmdStatus}`,
    `  /context     — ${cmdStrings.cmdContext}`,
    `  /theme       — ${cmdStrings.cmdTheme}`,
    `  /thinking    — ${cmdStrings.cmdThinking}`,
    `  /reset       — ${cmdStrings.cmdReset}`,
    `  /talk [role] — ${cmdStrings.cmdTalk}`,
    `  /harness     — ${cmdStrings.cmdThinking}`,
    `    /harness doctor     — Check harness health`,
    `    /harness mine       — Mine weaknesses from eval`,
    `    /harness propose    — Propose harness patches`,
    `    /harness validate   — Validate a patch`,
    `    /harness promote    — Promote a patch`,
    `    /harness history    — Show evolution history`,
    `    /harness rollback   — Rollback a patch`,
    `  /config              — ${cmdStrings.cmdConfig}`,
    `  /config <key> <val>  — ${cmdStrings.cmdConfigSet}`,
    `  /config open         — ${cmdStrings.cmdConfigOpen}`,
    `  /config reload       — ${cmdStrings.cmdConfigReload}`,
    "",
    cmdStrings.helpAgents,
    agentList,
    "",
    `${cmdStrings.helpCurrent} ${currentLabel}`,
    "",
    cmdStrings.helpDeprecatedAgentNote,
  ].join("\n")
}

/**
 * CL-52: Format a skill list result for display.
 */
export function formatSkillList(resultContent: string, loadedStr: (count: number) => string): string {
  try {
    const d = JSON.parse(resultContent)
    const lines = d.skills
      .slice(0, 20)
      .map((s: { name: string; description: string }) => `  ${s.name} — ${s.description}`)
      .join("\n")
    const more = d.count > 20 ? `\n  ... and ${d.count - 20} more` : ""
    return `${loadedStr(d.count)}${lines}${more}`
  } catch {
    return resultContent
  }
}
