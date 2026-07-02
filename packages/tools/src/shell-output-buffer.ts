import type { ToolProgressUpdate } from "@covalo/core"

export interface BoundedBuffer {
  text: string
  max: number
  dropped: number
}

export function truncateOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return text.slice(-maxChars) + `\n... [truncated: ${text.length - maxChars} more chars]`
}

export function pushBounded(buf: BoundedBuffer, chunk: string): void {
  buf.text += chunk
  if (buf.text.length > buf.max * 2) {
    const excess = buf.text.length - buf.max
    buf.text = buf.text.slice(excess)
    buf.dropped += excess
  }
}

export function finalizeBounded(buf: BoundedBuffer): { text: string; dropped: number } {
  if (buf.dropped > 0) {
    return {
      text: buf.text.slice(-buf.max) + `\n... [dropped ${buf.dropped} earlier chars]`,
      dropped: buf.dropped,
    }
  }
  if (buf.text.length > buf.max) {
    return {
      text: buf.text.slice(-buf.max) + `\n... [truncated: ${buf.text.length - buf.max} more chars]`,
      dropped: buf.text.length - buf.max,
    }
  }
  return { text: buf.text, dropped: 0 }
}

export function createProgressThrottle(report?: (update: ToolProgressUpdate) => void): (update: ToolProgressUpdate) => void {
  if (!report) return () => {}
  let lastContent = ""
  let lastTs = 0
  const MIN_INTERVAL = 200
  return (update) => {
    const now = Date.now()
    if (update.content !== lastContent && now - lastTs >= MIN_INTERVAL) {
      lastContent = update.content
      lastTs = now
      report(update)
    }
  }
}
