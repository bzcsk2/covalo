/**
 * S1-6: Wildcard matcher with ReDoS protection.
 *
 * Shared wildcard matching function used by both permission/service.ts and
 * permission/rules.ts. Replaces the two divergent inline implementations
 * with a single hardened implementation that:
 *   - limits pattern length
 *   - limits wildcard count
 *   - collapses consecutive `*`
 *   - preserves the legacy semantics where `*` matches `/`
 */

const MAX_WILDCARDS = 16
const MAX_PATTERN_LEN = 512
const MAX_VALUE_LEN = 4096

export function matchWildcard(pattern: string, value: string): boolean {
  if (pattern === "*") return true
  if (pattern === value) return true
  if (pattern.length > MAX_PATTERN_LEN) return pattern === value
  if (value.length > MAX_VALUE_LEN) return false

  const starCount = (pattern.match(/\*/g) ?? []).length
  const qCount = (pattern.match(/\?/g) ?? []).length
  if (starCount + qCount > MAX_WILDCARDS) return pattern === value

  // Collapse consecutive `*` into a single `*`
  const collapsed = pattern.replace(/\*+/g, "*")

  const regexStr = "^" + collapsed
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
    + "$"

  try {
    return new RegExp(regexStr).test(value)
  } catch {
    return pattern === value
  }
}
