import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync } from "node:fs"
import { join, resolve } from "node:path"
import { homedir } from "node:os"
import { randomUUID } from "node:crypto"

export interface MemoryStoreEntry<T = unknown> {
  key: string
  value: T
  scope: string
  updatedAt: string
}

export interface MemoryUpdateOp {
  op: "set" | "delete" | "append"
  path: string
  value?: unknown
}

export class MemoryStore {
  private baseDir: string
  /** Per-key lock chain to prevent concurrent set/update/delete races on the same scope/key */
  private locks = new Map<string, Promise<void>>()

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? resolve(homedir(), ".covalo", "memory")
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true })
    }
  }

  private validatePathComponent(name: string, label: string): void {
    if (name.includes("/") || name.includes("\\") || name === ".." || name.includes("..")) {
      throw new Error(`Invalid ${label}: ${name}`)
    }
  }

  private scopeDir(scope: string): string {
    this.validatePathComponent(scope, "scope")
    const d = resolve(this.baseDir, "state", scope)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  private filePath(scope: string, key: string): string {
    this.validatePathComponent(key, "key")
    return resolve(this.scopeDir(scope), `${key}.json`)
  }

  private validateAccess(scope: string, key: string): void {
    this.validatePathComponent(scope, "scope")
    this.validatePathComponent(key, "key")
  }

  /**
   * Per-key async lock to serialize concurrent set/update/delete on the same scope/key.
   * Uses a promise chain so queued operations execute strictly in order.
   */
  private async withKeyLock<T>(scope: string, key: string, fn: () => Promise<T>): Promise<T> {
    const lockKey = `${scope}\0${key}`
    const prev = this.locks.get(lockKey) ?? Promise.resolve()
    let release!: () => void
    const next = new Promise<void>((resolve) => { release = resolve })
    // Chain: wait for previous, run fn, then release
    this.locks.set(lockKey, prev.then(() => next, () => next))
    await prev
    try {
      return await fn()
    } finally {
      release()
      // Clean up lock entry only if it's still the current chain tail
      if (this.locks.get(lockKey) === next) {
        this.locks.delete(lockKey)
      }
    }
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    this.validateAccess(scope, key)
    try {
      const raw = readFileSync(this.filePath(scope, key), "utf8")
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    return this.withKeyLock(scope, key, async () => {
      this.validateAccess(scope, key)
      const path = this.filePath(scope, key)
      const data = JSON.stringify(value, null, 2)
      // Use unique temp file to prevent cross-key or concurrent collisions
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
      writeFileSync(tmp, data, "utf8")
      try {
        renameSync(tmp, path)
      } catch {
        writeFileSync(path, data, "utf8")
        try { unlinkSync(tmp) } catch { /* best-effort cleanup */ }
      }
      return value
    })
  }

  async update<T = unknown>(scope: string, key: string, ops: MemoryUpdateOp[]): Promise<T> {
    return this.withKeyLock(scope, key, async () => {
      this.validateAccess(scope, key)
      // Read inside the lock to prevent lost updates
      let current = await this.get<Record<string, unknown>>(scope, key) ?? {} as Record<string, unknown>
      for (const op of ops) {
        if (op.op === "set") {
          this.setNested(current, op.path, op.value)
        } else if (op.op === "delete") {
          this.deleteNested(current, op.path)
        } else if (op.op === "append") {
          const arr = this.getNested(current, op.path) as unknown[]
          if (!Array.isArray(arr)) {
            this.setNested(current, op.path, [op.value])
          } else {
            arr.push(op.value)
          }
        }
      }
      // Write back inside the same lock
      const path = this.filePath(scope, key)
      const data = JSON.stringify(current, null, 2)
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
      writeFileSync(tmp, data, "utf8")
      try {
        renameSync(tmp, path)
      } catch {
        writeFileSync(path, data, "utf8")
        try { unlinkSync(tmp) } catch {}
      }
      return current as T
    })
  }

  async delete(scope: string, key: string): Promise<void> {
    return this.withKeyLock(scope, key, async () => {
      this.validateAccess(scope, key)
      try {
        unlinkSync(this.filePath(scope, key))
      } catch {
        // Already deleted
      }
    })
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    this.validatePathComponent(scope, "scope")
    const dir = this.scopeDir(scope)
    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".json"))
      const results: T[] = []
      for (const f of files) {
        try {
          const raw = readFileSync(join(dir, f), "utf8")
          results.push(JSON.parse(raw) as T)
        } catch {
          // Skip corrupted entries
        }
      }
      return results
    } catch {
      return []
    }
  }

  async close(): Promise<void> {
    // No-op for file-based store
  }

  private setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
    const parts = path.split(".")
    let current = obj
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current) || typeof current[parts[i]] !== "object") {
        current[parts[i]] = {}
      }
      current = current[parts[i]] as Record<string, unknown>
    }
    current[parts[parts.length - 1]] = value
  }

  private deleteNested(obj: Record<string, unknown>, path: string): void {
    const parts = path.split(".")
    let current = obj
    for (let i = 0; i < parts.length - 1; i++) {
      if (!(parts[i] in current)) return
      current = current[parts[i]] as Record<string, unknown>
    }
    delete current[parts[parts.length - 1]]
  }

  private getNested(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split(".")
    let current: unknown = obj
    for (const part of parts) {
      if (current && typeof current === "object" && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part]
      } else {
        return undefined
      }
    }
    return current
  }
}
