import type { EngineStatusSnapshot } from "@deepreef/core"
import { t } from "../i18n/index.js"

export interface FormatOptions {
  width?: number
  useUnicode?: boolean
}

const BOX_CHARS = {
  unicode: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    teeRight: "├",
    teeLeft: "┤",
    teeDown: "┬",
    teeUp: "┴",
    cross: "┼",
  },
  ascii: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    teeRight: "+",
    teeLeft: "+",
    teeDown: "+",
    teeUp: "+",
    cross: "+",
  },
}

function createBox(width: number, useUnicode: boolean) {
  const chars = useUnicode ? BOX_CHARS.unicode : BOX_CHARS.ascii
  return {
    horizontalLine: () => chars.horizontal.repeat(width - 2),
    topBorder: () => `${chars.topLeft}${chars.horizontal.repeat(width - 2)}${chars.topRight}`,
    bottomBorder: () => `${chars.bottomLeft}${chars.horizontal.repeat(width - 2)}${chars.bottomRight}`,
    separator: () => `${chars.teeRight}${chars.horizontal.repeat(width - 2)}${chars.teeLeft}`,
    content: (text: string) => {
      const padded = text.padEnd(width - 4)
      return `${chars.vertical} ${padded.slice(0, width - 4)} ${chars.vertical}`
    },
  }
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`
  }
  return tokens.toString()
}

function formatCost(cost: number): string {
  if (cost >= 1) {
    return `$${cost.toFixed(2)}`
  }
  if (cost >= 0.01) {
    return `$${cost.toFixed(3)}`
  }
  return `$${cost.toFixed(4)}`
}

export function formatStatusCodex(snapshot: EngineStatusSnapshot, options: FormatOptions = {}): string {
  const { width = 80, useUnicode = true } = options
  const box = createBox(width, useUnicode)

  const sessionId = snapshot.sessionId.length > 20
    ? snapshot.sessionId.slice(0, 20) + "..."
    : snapshot.sessionId

  const usedTokens = snapshot.context.prefixTokens + snapshot.context.logTokens + snapshot.context.scratchTokens
  const leftPercent = ((snapshot.context.window - usedTokens) / snapshot.context.window * 100).toFixed(1)
  const usedFormatted = formatTokens(usedTokens)
  const totalFormatted = formatTokens(snapshot.context.window)

  const cacheRate = snapshot.stats.cacheHitTokens + snapshot.stats.cacheMissTokens > 0
    ? ((snapshot.stats.cacheHitTokens / (snapshot.stats.cacheHitTokens + snapshot.stats.cacheMissTokens)) * 100).toFixed(1)
    : "0.0"

  const lines = [
    box.topBorder(),
    box.content(t().statusSectionStatus),
    box.separator(),
    box.content(`Session:    ${sessionId}`),
    box.content(`Agent:      ${snapshot.currentAgent}`),
    box.content(`Submitting: ${snapshot.isSubmitting ? t().statusYes : t().statusNo}`),
    box.separator(),
    box.content(t().statusSectionContext),
    box.content(`Window:     ${leftPercent}% left (${usedFormatted} / ${totalFormatted})`),
    box.content(`Cache:      ${cacheRate}% hit rate`),
    box.separator(),
    box.content(t().statusSectionStats),
    box.content(`API Calls:  ${snapshot.stats.apiCalls}`),
    box.content(`Tool Calls: ${snapshot.stats.toolCalls}`),
    box.content(`Cost:       ${formatCost(snapshot.stats.totalCost)}`),
    ...(snapshot.sessionWriter ? [
      box.separator(),
      box.content(t().statusSectionSessionWriter),
      box.content(`Queue:      ${snapshot.sessionWriter.queueSize}`),
      box.content(`Dropped:    ${snapshot.sessionWriter.droppedCount}`),
      box.content(`Flushing:   ${snapshot.sessionWriter.flushing ? t().statusYes : t().statusNo}`),
      ...(snapshot.sessionWriter.lastError
        ? [box.content(`Last Error: ${snapshot.sessionWriter.lastError.slice(0, 40)}`)]
        : []),
    ] : []),
    box.separator(),
    box.content(snapshot.timestamp),
    box.bottomBorder(),
  ]

  return lines.join("\n")
}

export function formatStatusAscii(snapshot: EngineStatusSnapshot, options: FormatOptions = {}): string {
  return formatStatusCodex(snapshot, { ...options, useUnicode: false })
}

export function formatStatusCompact(snapshot: EngineStatusSnapshot): string {
  return `Session: ${snapshot.sessionId.slice(0, 8)} | Agent: ${snapshot.currentAgent} | Tokens: ${formatTokens(snapshot.context.totalTokens)} | Cost: ${formatCost(snapshot.stats.totalCost)}`
}

export function formatStatus(snapshot: EngineStatusSnapshot, options: FormatOptions = {}): string {
  return formatStatusCodex(snapshot, options)
}
