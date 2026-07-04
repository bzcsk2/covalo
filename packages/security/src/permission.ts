export type PermissionDecision = "deny" | "allow" | "ask"

export interface DenyRule {
  id?: string
  toolName: string | RegExp
  args?: Record<string, unknown>
  reason?: string
}

export interface AllowRule {
  id?: string
  toolName: string | RegExp
  args?: Record<string, unknown>
}

export interface PermissionCheck {
  decision: PermissionDecision
  reason?: string
  rule?: DenyRule | AllowRule
}

function escapeRegExp(value: string): string {
  return value.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&")
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = escapeRegExp(pattern)
    .replace(/\\\*/g, ".*")
    .replace(/\\\?/g, ".")
  return new RegExp(`^${escaped}$`)
}

function matchToolName(rule: string | RegExp, name: string): boolean {
  if (typeof rule !== "string") return rule.test(name)
  if (rule.includes("*") || rule.includes("?")) return wildcardToRegExp(rule).test(name)
  return rule === name
}

function matchArgs(pattern: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(pattern)) {
    if (!(key in actual)) return false
    const actualVal = actual[key]
    // Deep match for plain objects (recursive)
    if (val !== null && typeof val === "object" && !Array.isArray(val) &&
        actualVal !== null && typeof actualVal === "object" && !Array.isArray(actualVal)) {
      if (!matchArgs(val as Record<string, unknown>, actualVal as Record<string, unknown>)) return false
    }
    // Array equality
    else if (Array.isArray(val) && Array.isArray(actualVal)) {
      if (val.length !== actualVal.length) return false
      for (let i = 0; i < val.length; i++) {
        if (val[i] !== actualVal[i]) return false
      }
    }
    // Primitive comparison
    else if (actualVal !== val) return false
  }
  return true
}

export class PermissionEngine {
  private denyRules: DenyRule[] = []
  private allowRules: AllowRule[] = []
  private strictMode = false

  /** Default decision by tier. Unknown tiers default to "ask" (fail-closed). */
  private defaultDecisionByTier: Record<string, PermissionDecision> = {
    exec: "ask",
    write: "ask",
    edit: "ask",
    read: "allow",
  }

  setStrictMode(enabled: boolean): void {
    this.strictMode = enabled
  }

  isStrictMode(): boolean {
    return this.strictMode
  }

  addDenyRule(rule: DenyRule): void {
    this.denyRules.push(rule)
  }

  removeDenyRule(toolName: string): void {
    this.denyRules = this.denyRules.filter(r => {
      if (typeof r.toolName === "string") return r.toolName !== toolName
      return true // keep RegExp rules — use removeDenyRuleById() or clear()
    })
  }

  removeDenyRuleById(id: string): void {
    this.denyRules = this.denyRules.filter(r => r.id !== id)
  }

  addAllowRule(rule: AllowRule): void {
    this.allowRules.push(rule)
  }

  removeAllowRule(toolName: string): void {
    this.allowRules = this.allowRules.filter(r => {
      if (typeof r.toolName === "string") return r.toolName !== toolName
      return true // keep RegExp rules — use removeAllowRuleById() or clear()
    })
  }

  removeAllowRuleById(id: string): void {
    this.allowRules = this.allowRules.filter(r => r.id !== id)
  }

  clear(): void {
    this.denyRules = []
    this.allowRules = []
  }

  /**
   * Override the default decision for a given tier.
   * By default: exec=ask, write=ask, edit=ask, read=allow.
   * Unknown tiers default to "ask" for fail-closed safety.
   */
  setDefaultDecision(tier: string, decision: PermissionDecision): void {
    this.defaultDecisionByTier[tier] = decision
  }

  getDefaultDecision(tier: string): PermissionDecision {
    return this.defaultDecisionByTier[tier] ?? "ask"
  }

  isAllowed(toolName: string, args: Record<string, unknown>, tier: string): boolean {
    return this.decide(toolName, args, tier).decision === "allow"
  }

  isDenied(toolName: string, args: Record<string, unknown>, tier: string): boolean {
    return this.decide(toolName, args, tier).decision === "deny"
  }

  toJSON(): { allowRules: AllowRule[]; denyRules: DenyRule[] } {
    return {
      allowRules: this.allowRules.map(r => ({ ...r })),
      denyRules: this.denyRules.map(r => ({ ...r })),
    }
  }

  static fromJSON(json: { allowRules?: AllowRule[]; denyRules?: DenyRule[] }): PermissionEngine {
    const engine = new PermissionEngine()
    for (const rule of json.allowRules ?? []) engine.addAllowRule(rule)
    for (const rule of json.denyRules ?? []) engine.addDenyRule(rule)
    return engine
  }

  decide(toolName: string, args: Record<string, unknown>, tier: string): PermissionCheck {
    // S0-2 spec A: deny rules → allow rules → strictMode → default decision
    for (const rule of this.denyRules) {
      if (!matchToolName(rule.toolName, toolName)) continue
      if (rule.args && !matchArgs(rule.args, args)) continue
      return { decision: "deny", reason: rule.reason ?? `Denied by rule: ${rule.toolName}`, rule }
    }

    for (const rule of this.allowRules) {
      if (!matchToolName(rule.toolName, toolName)) continue
      if (rule.args && !matchArgs(rule.args, args)) continue
      return { decision: "allow", rule }
    }

    // strictMode: deny non-read tools not explicitly allowed
    if (this.strictMode && tier !== "read") {
      return { decision: "deny", reason: `Strict mode: tool "${toolName}" is not explicitly allowed (tier: ${tier})` }
    }

    const defaultDecision = this.getDefaultDecision(tier)
    if (defaultDecision === "ask") {
      return { decision: "ask", reason: `Tool "${toolName}" requires confirmation (tier: ${tier})` }
    }
    if (defaultDecision === "deny") {
      return { decision: "deny", reason: `Tool "${toolName}" is denied by default for tier: ${tier}` }
    }

    return { decision: "allow" }
  }
}
