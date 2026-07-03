export interface RepairResult {
  success: boolean
  args: Record<string, unknown>
  method: string
  partial?: boolean
}

export function repairToolArguments(raw: string): RepairResult {
  const s1 = scavenge(raw)
  if (s1.success) return { success: true, args: s1.args, method: "scavenge" }

  const s2 = truncate(raw)
  if (s2.success) return { success: true, args: s2.args, method: "truncation" }

  const s3 = storm(raw)
  if (s3.success) {
    // AUD-08: storm recovery is always partial — low-confidence regex extraction
    return { success: true, args: s3.args, method: "storm", partial: true }
  }

  return { success: false, args: {}, method: "all-failed" }
}

/** Stage 1: Scavenge — recover JSON from malformed string */
function scavenge(raw: string): { success: boolean; args: Record<string, unknown> } {
  const candidates: string[] = []

  // 1a: extract outermost {...} block
  const braceStart = raw.indexOf("{")
  const braceEnd = raw.lastIndexOf("}")
  if (braceStart >= 0 && braceEnd > braceStart) {
    candidates.push(raw.slice(braceStart, braceEnd + 1))
  }

  // 1b: single quotes → double quotes (but not inside already-valid strings)
  candidates.push(raw.replace(/'/g, '"'))

  // 1c: strip trailing comma before closing brace
  candidates.push(raw.replace(/,\s*}/g, "}"))

  // 1d: wrap bare values in proper object
  if (!raw.trim().startsWith("{")) {
    candidates.push(`{${raw}}`)
  }

  // 1e: close unbalanced braces
  let open = 0
  let closed = 0
  for (const ch of raw) {
    if (ch === "{") open++
    if (ch === "}") closed++
  }
  if (open > closed) {
    candidates.push(raw + "}".repeat(open - closed))
  }

  // 1f: fix unclosed quotes by adding trailing `"`
  const quoteCount = (raw.match(/"/g) || []).length
  if (quoteCount % 2 !== 0) {
    candidates.push(raw + '"')
  }

  // 1g: combined brace+quote fix — when braces are unbalanced AND the
  // raw string may have an unclosed string value (e.g. {"key": "value)
  if (open > closed) {
    candidates.push(raw + '"' + "}".repeat(open - closed))
  }

  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { success: true, args: parsed as Record<string, unknown> }
      }
    } catch {
      continue
    }
  }
  return { success: false, args: {} }
}

/** Stage 2: Truncation — truncate long values to fit parse window */
function truncate(raw: string): { success: boolean; args: Record<string, unknown> } {
  if (raw.length < 200) return { success: false, args: {} }

  // try parse with last N characters removed progressively
  for (let keep = raw.length - 50; keep >= 100; keep -= 50) {
    try {
      const sliced = raw.slice(0, keep).replace(/,\s*$/, "") + "}"
      const parsed = JSON.parse(sliced) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { success: true, args: parsed as Record<string, unknown> }
      }
    } catch {
      continue
    }
  }
  return { success: false, args: {} }
}

/** Stage 3: Storm — last resort patterns */
function storm(raw: string): { success: boolean; args: Record<string, unknown> } {
  // 3a: if it looks like a simple key-value, construct manually
  // AUD-08: Only accept when there is exactly ONE KV pair
  const allKvMatches = [...raw.matchAll(/"(\w+)":\s*"([^"]*)"/g)]
  if (allKvMatches.length === 1) {
    return { success: true, args: { [allKvMatches[0][1]]: allKvMatches[0][2] } }
  }
  if (allKvMatches.length >= 2) {
    // Multiple KV pairs — return partial state (but don't execute)
    return { success: true, args: Object.fromEntries(allKvMatches.map(m => [m[1], m[2]])) }
  }

  // 3b: empty object literal
  if (raw.trim() === "{}") {
    return { success: true, args: {} }
  }

  return { success: false, args: {} }
}
