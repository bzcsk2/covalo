export interface FuzzyEditResult {
  edited: string
  replacedCount: number
  method: string
}

export function fuzzyReplaceOnce(haystack: string, needle: string, replacement: string): FuzzyEditResult | null {
  if (needle.length === 0) return null
  // Pass 1: exact match
  const allOccurrences = findAllOccurrences(haystack, needle)
  if (allOccurrences.length === 1) {
    return { edited: haystack.slice(0, allOccurrences[0]) + replacement + haystack.slice(allOccurrences[0] + needle.length), replacedCount: 1, method: "exact" }
  }
  if (allOccurrences.length >= 2) {
    // 歧义：不猜测，让模型提供更多上下文
    return null
  }

  // Pass 2: trimmed variants (trim entire needle, or trim right sides of lines)
  const trimmedNeedle = needle.trim()
  if (trimmedNeedle) {
    const trimmedOccurrences = findAllOccurrences(haystack, trimmedNeedle)
    if (trimmedOccurrences.length === 1) {
      return { edited: haystack.slice(0, trimmedOccurrences[0]) + replacement + haystack.slice(trimmedOccurrences[0] + trimmedNeedle.length), replacedCount: 1, method: "trimmed_full" }
    }
    if (trimmedOccurrences.length >= 2) return null
  }

  const rightTrimmed = trimRightLines(needle)
  if (rightTrimmed && rightTrimmed !== needle) {
    const rightTrimmedOccurrences = findAllOccurrences(haystack, rightTrimmed)
    if (rightTrimmedOccurrences.length === 1) {
      return { edited: haystack.slice(0, rightTrimmedOccurrences[0]) + replacement + haystack.slice(rightTrimmedOccurrences[0] + rightTrimmed.length), replacedCount: 1, method: "trimmed_lines" }
    }
    if (rightTrimmedOccurrences.length >= 2) return null
  }

  // Pass 3: trimmedBoundary — left+right trim each line (preserves line structure)
  const boundaryResult = trimmedBoundaryPass(haystack, needle, replacement)
  if (boundaryResult) return boundaryResult

  // Pass 4: blockAnchor — use distinctive first+last lines as anchors
  const blockResult = blockAnchorPass(haystack, needle, replacement)
  if (blockResult) return blockResult

  // Pass 5: contextAware — use first+last lines as anchors with approximate middle
  const contextResult = contextAwarePass(haystack, needle, replacement)
  if (contextResult) return contextResult

  // Pass 6: escapeNormalized — normalize literal escape sequences
  const escapeResult = escapeNormalizedPass(haystack, needle, replacement)
  if (escapeResult) return escapeResult

  // Pass 7: Flexible whitespace match using regex (most aggressive — last resort)
  try {
    const trimmed = needle.trim()
    if (trimmed) {
      const parts = trimmed.split(/\s+/)
      if (parts.length > 1) {
        const escapedParts = parts.map(escapeRegExp)
        const flexRegex = new RegExp(escapedParts.join('\\s+'), 'g')
        const allMatches = [...haystack.matchAll(flexRegex)]
        if (allMatches.length !== 1) return null  // ambiguous: reject like Pass 1-6
        const match = allMatches[0]
        if (match && match.index !== undefined) {
          return {
            edited: haystack.slice(0, match.index) + replacement + haystack.slice(match.index + match[0].length),
            replacedCount: 1,
            method: "flexible_whitespace"
          }
        }
      }
    }
  } catch (e) {
    // Ignore regex compilation errors
  }

  return null
}

function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function trimRightLines(s: string): string {
  return s
    .split("\n")
    .map((l) => l.replace(/\s+$/u, ""))
    .join("\n")
}

function trimBothLines(s: string): string {
  return s
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
}

function blockAnchorPass(haystack: string, needle: string, replacement: string): FuzzyEditResult | null {
  const needleLines = needle.split("\n")
  const nonEmptyNeedleLines = needleLines.filter(l => l.trim().length > 0)
  const firstAnchor = nonEmptyNeedleLines[0]?.trim()
  const lastAnchor = nonEmptyNeedleLines[nonEmptyNeedleLines.length - 1]?.trim()
  if (!firstAnchor || !lastAnchor || firstAnchor === lastAnchor) return null

  const haystackLines = haystack.split("\n")
  const nonEmptyLineCount = nonEmptyNeedleLines.length
  const threshold = Math.max(3, Math.floor(nonEmptyLineCount * 0.55))

  // Find all candidate regions
  const candidates: { firstIdx: number; lastIdx: number }[] = []

  for (let i = 0; i < haystackLines.length; i++) {
    if (haystackLines[i].trim() !== firstAnchor) continue
    for (let j = i + 1; j < haystackLines.length; j++) {
      if (haystackLines[j].trim() === lastAnchor && j - i + 1 >= nonEmptyLineCount) {
        const regionLines = haystackLines.slice(i, j + 1)
        const trimmedNeedle = needleLines.map(l => l.trim())
        const trimmedRegion = regionLines.map(l => l.trim())

        let matches = 0
        for (let k = 0; k < trimmedNeedle.length && k < trimmedRegion.length; k++) {
          if (trimmedNeedle[k] && trimmedRegion[k] && trimmedNeedle[k] === trimmedRegion[k]) matches++
        }

        if (matches >= threshold) {
          candidates.push({ firstIdx: i, lastIdx: j })
        }
        break
      }
    }
  }

  if (candidates.length !== 1) return null

  const { firstIdx, lastIdx } = candidates[0]
  const before = haystackLines.slice(0, firstIdx).join("\n")
  const after = haystackLines.slice(lastIdx + 1).join("\n")
  const prefix = before ? before + "\n" : ""
  const suffix = after ? "\n" + after : ""

  return {
    edited: prefix + replacement + suffix,
    replacedCount: 1,
    method: "blockAnchor",
  }
}

function escapeNormalizedPass(haystack: string, needle: string, replacement: string): FuzzyEditResult | null {
  const normalized = needle
    .replace(/\\\\n/g, "\n")
    .replace(/\\\\t/g, "\t")
    .replace(/\\\\"/g, '"')
    .replace(/\\\\'/g, "'")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")

  if (normalized === needle) return null

  const occurrences = findAllOccurrences(haystack, normalized)
  if (occurrences.length === 1) {
    return {
      edited: haystack.slice(0, occurrences[0]) + replacement + haystack.slice(occurrences[0] + normalized.length),
      replacedCount: 1,
      method: "escapeNormalized",
    }
  }
  return null
}

function trimmedBoundaryPass(haystack: string, needle: string, replacement: string): FuzzyEditResult | null {
  const trimmed = trimBothLines(needle)
  if (trimmed === needle) return null

  const occurrences = findAllOccurrences(haystack, trimmed)
  if (occurrences.length === 1) {
    return {
      edited: haystack.slice(0, occurrences[0]) + replacement + haystack.slice(occurrences[0] + trimmed.length),
      replacedCount: 1,
      method: "trimmedBoundary",
    }
  }
  return null
}

function contextAwarePass(haystack: string, needle: string, replacement: string): FuzzyEditResult | null {
  const lines = needle.split("\n")
  if (lines.length < 3) return null

  const firstLine = lines[0].trim()
  const lastLine = lines[lines.length - 1].trim()
  if (!firstLine || !lastLine) return null
  if (firstLine === lastLine && lines.length > 2) return null

  const haystackLines = haystack.split("\n")
  const threshold = Math.max(2, Math.floor(lines.length * 0.4))

  // Find all candidate regions
  const candidates: { firstIdx: number; lastIdx: number }[] = []

  for (let i = 0; i < haystackLines.length; i++) {
    if (haystackLines[i].trim() !== firstLine) continue
    for (let j = i + 1; j < haystackLines.length; j++) {
      if (haystackLines[j].trim() === lastLine && j - i + 1 >= lines.length) {
        const regionLines = haystackLines.slice(i, j + 1)

        let matchingLines = 0
        for (let k = 0; k < lines.length && k < regionLines.length; k++) {
          const nTrimmed = lines[k].trim()
          const hTrimmed = regionLines[k].trim()
          if (nTrimmed && hTrimmed && nTrimmed === hTrimmed) matchingLines++
        }

        if (matchingLines >= threshold) {
          candidates.push({ firstIdx: i, lastIdx: j })
        }
        break
      }
    }
  }

  if (candidates.length !== 1) return null

  const { firstIdx, lastIdx } = candidates[0]
  const start = haystackLines.slice(0, firstIdx).join("\n")
  const end = haystackLines.slice(lastIdx + 1).join("\n")
  const prefix = start ? start + "\n" : ""
  const suffix = end ? "\n" + end : ""

  return {
    edited: prefix + replacement + suffix,
    replacedCount: 1,
    method: "contextAware",
  }
}

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0) return []
  const indices: number[] = []
  let searchFrom = 0
  while (true) {
    const idx = haystack.indexOf(needle, searchFrom)
    if (idx < 0) break
    indices.push(idx)
    searchFrom = idx + needle.length
  }
  return indices
}
