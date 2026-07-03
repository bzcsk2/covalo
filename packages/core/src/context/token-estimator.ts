/**
 * Internal context budget estimator — simple, deterministic, synchronous.
 * Used for fold/trim decisions only. Not for displaying token usage to users.
 */

export interface FoldDecision {
  action: "none" | "suggest" | "force"
  ratio: number
  used: number
  total: number
}

const MSG_OVERHEAD = 10

/**
 * 轻量启发式 token 估算：区分 CJK 与其他字符。
 * CJK 统一按每 1.5 字符计为一个 token，
 * 其余按每 4 字符计为一个 token。
 */
function estimateTextTokens(text: string): number {
  let cjk = 0
  let other = 0

  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      cjk++
    } else {
      other++
    }
  }

  return Math.ceil(cjk / 1.5 + other / 4)
}

/**
 * Estimate context budget from messages (internal use only).
 * Returns estimated tokens for budget protection, not for user display.
 */
export function estimateTokens(messages: Array<{ role?: string; content?: string | null; reasoning_content?: string | null }>): number {
  let total = 0
  for (const msg of messages) {
    total += MSG_OVERHEAD
    if (msg.content) total += estimateTextTokens(msg.content)
    if (msg.reasoning_content) total += estimateTextTokens(msg.reasoning_content)
  }
  return total
}

export function getFoldDecision(used: number, total: number): FoldDecision {
  const ratio = total > 0 ? used / total : 0
  if (ratio <= 0.65) return { action: "none", ratio, used, total }
  if (ratio <= 0.80) return { action: "suggest", ratio, used, total }
  return { action: "force", ratio, used, total }
}
