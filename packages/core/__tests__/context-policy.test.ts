import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  DEFAULT_CONTEXT_POLICY,
  validateContextPolicy,
  mergeContextPolicy,
} from "../src/context/policy.js"
import { ContextPolicyStore } from "../src/context/policy-store.js"
import { readFile, writeFile, mkdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("ContextPolicy", () => {
  describe("DEFAULT_CONTEXT_POLICY", () => {
    it("should have correct default values", () => {
      expect(DEFAULT_CONTEXT_POLICY.mode).toBe("trim")
      expect(DEFAULT_CONTEXT_POLICY.triggerRatio).toBe(0.70)
      expect(DEFAULT_CONTEXT_POLICY.targetRatio).toBe(0.30)
    })
  })

  describe("validateContextPolicy", () => {
    it("should accept valid trim policy", () => {
      expect(validateContextPolicy({ mode: "trim" })).toBe(true)
    })

    it("should accept valid compress policy", () => {
      expect(validateContextPolicy({ mode: "compress" })).toBe(true)
    })

    it("should reject invalid mode", () => {
      expect(validateContextPolicy({ mode: "invalid" as any })).toBe(false)
    })

    it("should accept valid triggerRatio", () => {
      expect(validateContextPolicy({ triggerRatio: 0.8 })).toBe(true)
    })

    it("should reject triggerRatio too low", () => {
      expect(validateContextPolicy({ triggerRatio: 0.05 })).toBe(false)
    })

    it("should reject triggerRatio too high", () => {
      expect(validateContextPolicy({ triggerRatio: 0.99 })).toBe(false)
    })

    it("should accept valid targetRatio", () => {
      expect(validateContextPolicy({ targetRatio: 0.2 })).toBe(true)
    })

    it("should reject targetRatio too low", () => {
      expect(validateContextPolicy({ targetRatio: 0.01 })).toBe(false)
    })

    it("should reject targetRatio too high", () => {
      expect(validateContextPolicy({ targetRatio: 0.99 })).toBe(false)
    })

    it("should reject targetRatio >= triggerRatio", () => {
      expect(validateContextPolicy({ triggerRatio: 0.6, targetRatio: 0.6 })).toBe(false)
      expect(validateContextPolicy({ triggerRatio: 0.6, targetRatio: 0.7 })).toBe(false)
    })

    it("should accept empty object", () => {
      expect(validateContextPolicy({})).toBe(true)
    })
  })

  describe("mergeContextPolicy", () => {
    it("should merge with defaults", () => {
      const result = mergeContextPolicy(DEFAULT_CONTEXT_POLICY, {})
      expect(result).toEqual(DEFAULT_CONTEXT_POLICY)
    })

    it("should override mode", () => {
      const result = mergeContextPolicy(DEFAULT_CONTEXT_POLICY, { mode: "compress" })
      expect(result.mode).toBe("compress")
    })

    it("should override triggerRatio", () => {
      const result = mergeContextPolicy(DEFAULT_CONTEXT_POLICY, { triggerRatio: 0.8 })
      expect(result.triggerRatio).toBe(0.8)
    })

    it("should override targetRatio", () => {
      const result = mergeContextPolicy(DEFAULT_CONTEXT_POLICY, { targetRatio: 0.2 })
      expect(result.targetRatio).toBe(0.2)
    })

    it("should adjust targetRatio if >= triggerRatio", () => {
      const result = mergeContextPolicy(DEFAULT_CONTEXT_POLICY, { triggerRatio: 0.6, targetRatio: 0.6 })
      expect(result.targetRatio).toBeLessThan(result.triggerRatio)
    })

    it("should return base policy for invalid input", () => {
      const result = mergeContextPolicy(DEFAULT_CONTEXT_POLICY, { mode: "invalid" as any })
      expect(result).toEqual(DEFAULT_CONTEXT_POLICY)
    })
  })
})

describe("ContextPolicyStore", () => {
  let tmpDir: string
  let store: ContextPolicyStore

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `test-context-policy-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    store = new ContextPolicyStore(tmpDir)
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("should return default policy when no file exists", async () => {
    const policy = await store.load()
    expect(policy).toEqual(DEFAULT_CONTEXT_POLICY)
  })

  it("should load valid policy from file", async () => {
    const policyFile = join(tmpDir, ".deepicode", "context.json")
    await mkdir(join(tmpDir, ".deepicode"), { recursive: true })
    await writeFile(policyFile, JSON.stringify({ mode: "compress", triggerRatio: 0.8, targetRatio: 0.2 }))

    const loaded = await store.load()
    expect(loaded.mode).toBe("compress")
    expect(loaded.triggerRatio).toBe(0.8)
    expect(loaded.targetRatio).toBe(0.2)
  })

  it("should fallback to default for invalid JSON", async () => {
    const policyFile = join(tmpDir, ".deepicode", "context.json")
    await mkdir(join(tmpDir, ".deepicode"), { recursive: true })
    await writeFile(policyFile, "invalid json")

    const loaded = await store.load()
    expect(loaded).toEqual(DEFAULT_CONTEXT_POLICY)
  })

  it("should fallback to default for invalid policy", async () => {
    const policyFile = join(tmpDir, ".deepicode", "context.json")
    await mkdir(join(tmpDir, ".deepicode"), { recursive: true })
    await writeFile(policyFile, JSON.stringify({ mode: "invalid" }))

    const loaded = await store.load()
    expect(loaded).toEqual(DEFAULT_CONTEXT_POLICY)
  })

  it("should save policy to file", async () => {
    const policy = { mode: "compress" as const, triggerRatio: 0.8, targetRatio: 0.2 }
    const saved = await store.save(policy)
    expect(saved).toBe(true)

    const policyFile = join(tmpDir, ".deepicode", "context.json")
    const content = await readFile(policyFile, "utf-8")
    expect(JSON.parse(content)).toEqual(policy)
  })

  it("should return false when save fails", async () => {
    const fileAsWorkspace = join(tmpDir, "not-a-directory")
    await writeFile(fileAsWorkspace, "blocks nested .deepicode creation")

    const invalidStore = new ContextPolicyStore(fileAsWorkspace)
    const saved = await invalidStore.save(DEFAULT_CONTEXT_POLICY)
    expect(saved).toBe(false)
  })

  it("should return current policy without loading", () => {
    const current = store.getCurrentPolicy()
    expect(current).toEqual(DEFAULT_CONTEXT_POLICY)
  })

  it("should return correct file path", () => {
    const path = store.getFilePath()
    expect(path).toContain("context.json")
    expect(path).toContain(".deepicode")
  })
})
