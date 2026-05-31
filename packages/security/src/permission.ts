export type PermissionDecision = "deny" | "allow" | "ask"

export interface DenyRule {
  toolName: string | RegExp
  args?: Record<string, unknown>
  reason?: string
}

export interface AllowRule {
  toolName: string | RegExp
  args?: Record<string, unknown>
}

export interface PermissionCheck {
  decision: PermissionDecision
  reason?: string
  rule?: DenyRule | AllowRule
}

function matchToolName(rule: string | RegExp, name: string): boolean {
  if (typeof rule === "string") return rule === name
  return rule.test(name)
}

function matchArgs(pattern: Record<string, unknown>, actual: Record<string, unknown>): boolean {
  for (const [key, val] of Object.entries(pattern)) {
    if (actual[key] !== val) return false
  }
  return true
}

export class PermissionEngine {
  private denyRules: DenyRule[] = []
  private allowRules: AllowRule[] = []

  addDenyRule(rule: DenyRule): void {
    this.denyRules.push(rule)
  }

  removeDenyRule(toolName: string): void {
    this.denyRules = this.denyRules.filter(r => {
      if (typeof r.toolName === "string") return r.toolName !== toolName
      return true // keep RegExp rules — use clear() to remove all
    })
  }

  addAllowRule(rule: AllowRule): void {
    this.allowRules.push(rule)
  }

  removeAllowRule(toolName: string): void {
    this.allowRules = this.allowRules.filter(r => {
      if (typeof r.toolName === "string") return r.toolName !== toolName
      return true
    })
  }

  clear(): void {
    this.denyRules = []
    this.allowRules = []
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

    if (tier === "exec") {
      return { decision: "ask", reason: `Tool "${toolName}" requires confirmation (tier: ${tier})` }
    }

    return { decision: "allow" }
  }
}
