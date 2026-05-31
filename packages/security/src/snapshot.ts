import { mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, relative } from "node:path"
import { createHash, randomUUID } from "node:crypto"

export class FileSnapshot {
  private patchesDir: string
  private sequence = 0

  constructor(patchesDir?: string) {
    this.patchesDir = patchesDir ?? join(process.cwd(), ".deepicode_patches")
  }

  async snapshot(filepath: string): Promise<string> {
    const id = snapshotId(filepath)
    const dir = join(this.patchesDir, id)
    await mkdir(dir, { recursive: true })
    const content = await readFile(filepath)
    const sequence = String(this.sequence++).padStart(8, "0")
    const snapPath = join(dir, `${Date.now()}_${sequence}_${randomUUID().slice(0, 8)}.snap`)
    await writeFile(snapPath, content)
    return id
  }

  async revert(filepath: string): Promise<boolean> {
    const id = snapshotId(filepath)
    const dir = join(this.patchesDir, id)
    if (!existsSync(dir)) return false
    const entries = await readdir(dir)
    const snaps = entries.filter(e => e.endsWith(".snap")).sort()
    if (snaps.length === 0) return false
    const snapPath = join(dir, snaps[snaps.length - 1])
    const content = await readFile(snapPath)
    await writeFile(filepath, content)
    return true
  }

  async list(filepath: string): Promise<string[]> {
    const id = snapshotId(filepath)
    const dir = join(this.patchesDir, id)
    if (!existsSync(dir)) return []
    const entries = await readdir(dir)
    return entries.filter(e => e.endsWith(".snap")).sort()
  }
}

function snapshotId(filepath: string): string {
  return createHash("sha256").update(filepath).digest("hex").slice(0, 16)
}
