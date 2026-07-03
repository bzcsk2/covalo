import type { SubagentDefinition } from "./types.js"
import { BUILTIN_SUBAGENTS } from "./definition.js"

export class SubagentRegistry {
  private definitions: Map<string, SubagentDefinition> = new Map()

  constructor() {
    this.registerBuiltins()
  }

  private registerBuiltins(): void {
    for (const def of BUILTIN_SUBAGENTS) {
      this.definitions.set(def.name, { ...def })
    }
  }

  register(def: SubagentDefinition): void {
    const existing = this.definitions.get(def.name)
    if (existing) {
      this.definitions.set(def.name, { ...def })
    } else {
      this.definitions.set(def.name, { ...def })
    }
  }

  get(name: string): SubagentDefinition | undefined {
    return this.definitions.get(name)
  }

  resolve(name: string): SubagentDefinition {
    const def = this.definitions.get(name)
    if (!def) {
      throw new Error(`Unknown subagent type: "${name}". Available: ${[...this.definitions.keys()].join(", ")}`)
    }
    return { ...def }
  }

  getAll(): SubagentDefinition[] {
    return [...this.definitions.values()].map(d => ({ ...d }))
  }

  has(name: string): boolean {
    return this.definitions.has(name)
  }

  getEffectiveTools(def: SubagentDefinition): string[] | undefined {
    if (def.tools && def.tools.length > 0 && def.tools[0] === "*") return undefined
    const allowed = def.tools ? [...def.tools] : undefined
    const disallowed = def.disallowedTools ?? []
    if (!allowed) return undefined
    return allowed.filter(t => !disallowed.includes(t))
  }
}
// SA-1: defaultSubagentRegistry 已删除（engine 构造函数自建 new SubagentRegistry()）
