import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"

/**
 * Migrate data from ~/.agentmemory to ~/.deepreef/memory.
 * Copies all state/*.json files preserving scope/key structure.
 */
export interface MigrationResult {
  migrated: number
  skipped: number
  errors: string[]
  sourceDir: string
  targetDir: string
}

export async function migrateFromAgentMemory(targetDir?: string): Promise<MigrationResult> {
  const sourceDir = join(homedir(), ".agentmemory", "state")
  const destDir = targetDir ?? join(homedir(), ".deepreef", "memory")

  const result: MigrationResult = {
    migrated: 0,
    skipped: 0,
    errors: [],
    sourceDir,
    targetDir: destDir,
  }

  if (!existsSync(sourceDir)) {
    result.errors.push(`Source not found: ${sourceDir}`)
    return result
  }

  const scopes = readdirSync(sourceDir, { withFileTypes: true }).filter(d => d.isDirectory())
  for (const scopeDir of scopes) {
    const scopePath = join(sourceDir, scopeDir.name)
    const files = readdirSync(scopePath).filter(f => f.endsWith(".json"))
    for (const file of files) {
      const key = file.replace(/\.json$/, "")
      const targetPath = join(destDir, "state", scopeDir.name, file)
      if (existsSync(targetPath)) {
        result.skipped++
        continue
      }
      try {
        mkdirSync(join(destDir, "state", scopeDir.name), { recursive: true })
        const data = readFileSync(join(scopePath, file), "utf-8")
        writeFileSync(targetPath, data, "utf-8")
        result.migrated++
      } catch (e) {
        result.errors.push(`${scopeDir.name}/${file}: ${String(e)}`)
      }
    }
  }

  return result
}

export function createMemoryMigrateTool() {
  return {
    name: "memory_migrate",
    description: "Migrate memory data from ~/.agentmemory to ~/.deepreef/memory",
    parameters: { type: "object" as const, properties: {} },
    concurrency: "exclusive" as const,
    approval: "write" as const,
    async execute() {
      const result = await migrateFromAgentMemory()
      return {
        content: JSON.stringify(result, null, 2),
        isError: result.errors.length > 0,
      }
    },
  }
}
