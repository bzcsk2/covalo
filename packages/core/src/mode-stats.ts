import type { ThinkingMode } from "./provider-thinking.js"

export type ModeSwitchLog = {
  timestamp: number
  from: ThinkingMode
  to: ThinkingMode
  reason: string
}

export type ModeStats = {
  totalSwitches: number
  switchesByReason: Record<string, number>
  timeInMode: Record<ThinkingMode, number>
  lastSwitch: ModeSwitchLog | null
}

export function createModeStats(): ModeStats {
  return {
    totalSwitches: 0,
    switchesByReason: {},
    timeInMode: { off: 0, low: 0, medium: 0, high: 0, max: 0 },
    lastSwitch: null,
  }
}

export function logModeSwitch(
  stats: ModeStats,
  from: ThinkingMode,
  to: ThinkingMode,
  reason: string,
  now: number = Date.now()
): void {
  const entry: ModeSwitchLog = { timestamp: now, from, to, reason }
  stats.totalSwitches++
  stats.switchesByReason[reason] = (stats.switchesByReason[reason] ?? 0) + 1
  if (stats.lastSwitch) {
    const elapsed = now - stats.lastSwitch.timestamp
    stats.timeInMode[stats.lastSwitch.to] += elapsed
  }
  stats.lastSwitch = entry
}

export function getModeSummary(stats: ModeStats): string {
  const lines: string[] = []
  lines.push(`Total switches: ${stats.totalSwitches}`)
  lines.push(`Time in mode:`)
  for (const [mode, ms] of Object.entries(stats.timeInMode)) {
    if (ms > 0) lines.push(`  ${mode}: ${(ms / 1000).toFixed(1)}s`)
  }
  if (Object.keys(stats.switchesByReason).length > 0) {
    lines.push(`Switches by reason:`)
    for (const [reason, count] of Object.entries(stats.switchesByReason)) {
      lines.push(`  ${reason}: ${count}`)
    }
  }
  return lines.join("\n")
}
