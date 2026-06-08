import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("CLI memory integration (Deepreef native)", () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cli-memory-test-"))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("@deepreef/memory exports MemoryService class", async () => {
    const mod = await import("@deepreef/memory")
    expect(mod).toBeDefined()
    expect(typeof mod.MemoryService).toBe("function")
  })

  it("@deepreef/memory exports all agent tool creators", async () => {
    const mod = await import("@deepreef/memory")
    expect(typeof mod.createMemoryRecallTool).toBe("function")
    expect(typeof mod.createMemorySaveTool).toBe("function")
    expect(typeof mod.createMemorySmartSearchTool).toBe("function")
    expect(typeof mod.createMemoryForgetTool).toBe("function")
    expect(typeof mod.createMemoryTimelineTool).toBe("function")
    expect(typeof mod.createMemoryStatusTool).toBe("function")
  })

  it("@deepreef/memory exports migration tools", async () => {
    const mod = await import("@deepreef/memory")
    expect(typeof mod.createMemoryMigrateTool).toBe("function")
    expect(typeof mod.migrateFromAgentMemory).toBe("function")
  })

  it("@deepreef/memory exports bridge class", async () => {
    const mod = await import("@deepreef/memory")
    expect(typeof mod.DeepreefMemoryBridge).toBe("function")
  })

  it("MemoryService can be created and started", async () => {
    const { MemoryService } = await import("@deepreef/memory")
    const svc = new MemoryService({ dataDir: tempDir })
    await svc.start()
    // MemoryService exposes .config after construction
    expect((svc as any).config).toBeDefined()
    await svc.stop()
  })
})
