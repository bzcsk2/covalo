// Free Auto routing — penalty, cooldown and retryable-error classification
// Adapted from freellmapi server/src/services/router.ts, ratelimit.ts, routes/proxy.ts

/* ── 429 Penalty (copied from freellmapi/services/router.ts) ── */
// Key: route key (e.g. "kilo:nvidia/nemotron-3-super-120b-a12b:free") → { count, lastHit, penalty }
const rateLimitPenalties = new Map<string, { count: number; lastHit: number; penalty: number }>()

const PENALTY_PER_429 = 3
const MAX_PENALTY = 10
const DECAY_INTERVAL_MS = 2 * 60 * 1000
const DECAY_AMOUNT = 1

export function recordRateLimitHit(routeKey: string) {
  const existing = rateLimitPenalties.get(routeKey)
  const now = Date.now()
  if (existing) {
    existing.count++
    existing.lastHit = now
    existing.penalty = Math.min(existing.penalty + PENALTY_PER_429, MAX_PENALTY)
  } else {
    rateLimitPenalties.set(routeKey, { count: 1, lastHit: now, penalty: PENALTY_PER_429 })
  }
}

export function recordSuccess(routeKey: string) {
  const existing = rateLimitPenalties.get(routeKey)
  if (existing) {
    existing.penalty = Math.max(0, existing.penalty - 1)
    if (existing.penalty === 0) {
      rateLimitPenalties.delete(routeKey)
    }
  }
}

export function getPenalty(routeKey: string): number {
  const entry = rateLimitPenalties.get(routeKey)
  if (!entry) return 0
  const now = Date.now()
  const elapsed = now - entry.lastHit
  const decaySteps = Math.floor(elapsed / DECAY_INTERVAL_MS)
  if (decaySteps > 0) {
    entry.penalty = Math.max(0, entry.penalty - (decaySteps * DECAY_AMOUNT))
    entry.lastHit = now
    if (entry.penalty === 0) {
      rateLimitPenalties.delete(routeKey)
      return 0
    }
  }
  return entry.penalty
}

/* ── Cooldown (copied from freellmapi/services/ratelimit.ts) ── */
// cooldowns keyed by "provider:model"
const cooldowns = new Map<string, number>()
const cooldownHits = new Map<string, number[]>()
const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR
const COOLDOWN_DURATIONS = [
  2 * MINUTE,
  10 * MINUTE,
  HOUR,
  DAY,
]

function getNextCooldownDuration(routeKey: string): number {
  const now = Date.now()
  const hits = (cooldownHits.get(routeKey) ?? []).filter(t => t > now - DAY)
  hits.push(now)
  cooldownHits.set(routeKey, hits)
  const idx = Math.min(hits.length - 1, COOLDOWN_DURATIONS.length - 1)
  return COOLDOWN_DURATIONS[idx]!
}

const TRANSIENT_COOLDOWN_MS = 60 * 1000 // 60s for 429 (provider-wide, longer than per-key)
export const PAYMENT_REQUIRED_COOLDOWN_MS = DAY // 402/401/403: process lifetime

export function setCooldown(routeKey: string, durationMs: number, isProvider = false) {
  // Provider-level cooldown: use a broader key so all models on this provider
  // share the same cooldown
  const key = isProvider ? `provider:${routeKey}` : routeKey
  cooldowns.set(key, Date.now() + durationMs)
}

export function isOnCooldown(routeKey: string, isProvider = false): boolean {
  const key = isProvider ? `provider:${routeKey}` : routeKey
  const expiry = cooldowns.get(key)
  if (!expiry) return false
  if (Date.now() > expiry) {
    cooldowns.delete(key)
    return false
  }
  return true
}

export function setProviderCooldown(provider: string, durationMs: number) {
  setCooldown(provider, durationMs, true)
}

export function isProviderOnCooldown(provider: string): boolean {
  return isOnCooldown(provider, true)
}

// 429: provider-level short cooldown; 402/401/403: long cooldown for the candidate
export function applyCooldown(routeKey: string, provider: string, status: number) {
  if (status === 429) {
    setProviderCooldown(provider, TRANSIENT_COOLDOWN_MS)
    recordRateLimitHit(routeKey)
  } else if (status === 402 || status === 401 || status === 403) {
    setCooldown(routeKey, PAYMENT_REQUIRED_COOLDOWN_MS)
  } else if (status >= 500 || status === 408) {
    const duration = getNextCooldownDuration(routeKey)
    setCooldown(routeKey, duration)
  }
}

/* ── Health tracking (not from freellmapi — new for Free Auto) ── */

export interface FreeRouteHealth {
  consecutiveFailures: number
  cooldownUntil: number
  lastLatencyMs?: number
  lastSuccessAt?: number
}

const routeHealth = new Map<string, FreeRouteHealth>()

export function getRouteHealth(routeKey: string): FreeRouteHealth | undefined {
  return routeHealth.get(routeKey)
}

export function recordRouteSuccess(routeKey: string, latencyMs: number) {
  routeHealth.set(routeKey, {
    consecutiveFailures: 0,
    cooldownUntil: 0,
    lastLatencyMs: latencyMs,
    lastSuccessAt: Date.now(),
  })
}

export function recordRouteFailure(routeKey: string) {
  const existing = routeHealth.get(routeKey) ?? { consecutiveFailures: 0, cooldownUntil: 0 }
  routeHealth.set(routeKey, {
    ...existing,
    consecutiveFailures: existing.consecutiveFailures + 1,
  })
}

/* ── Retryable error classification (copied from freellmapi/routes/proxy.ts) ── */

export function isRetryableError(err: any): boolean {
  const msg = (err.message ?? "").toLowerCase()
  const status = err.status ?? (err.body ? extractStatus(err.body) : 0)

  // Non-retryable statuses
  if (status === 400) return false
  if (status === 401 || status === 403) return false

  // Retryable statuses
  if (status === 402 || status === 408 || status === 429) return true
  if (status === 500 || status === 502 || status === 503 || status === 504) return true

  return (
    msg.includes("rate limit") || msg.includes("too many requests")
    || msg.includes("quota") || msg.includes("resource_exhausted")
    || msg.includes("timeout") || msg.includes("etimedout")
    || msg.includes("econnrefused") || msg.includes("econnreset")
    || msg.includes("unavailable") || msg.includes("internal server error")
    || msg.includes("payload too large") || msg.includes("request body too large")
    || msg.includes("empty completion")
    || msg.includes("stream ended unexpectedly")
    || msg.includes("stream stalled")
    || msg.includes("payment required")
    || msg.includes("insufficient_quota")
    || msg.includes("insufficient credit")
    || msg.includes("insufficient balance")
    || msg.includes("not found") || msg.includes("no endpoints found")
  )
}

function extractStatus(body: unknown): number {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>
    if (typeof b.status === "number") return b.status
  }
  return 0
}

/* ── Task classification ── */
export interface RoutingInput {
  hasTools: boolean
  messageCount: number
  estimatedInputLength: number
  toolCallRounds: number
}

export function classifyTask(input: RoutingInput): "coding" | "complex" | "simple" {
  if (input.hasTools) {
    return "coding"
  }
  if (input.estimatedInputLength > 4000 || input.messageCount > 10) {
    return "complex"
  }
  return "simple"
}
