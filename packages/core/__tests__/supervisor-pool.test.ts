import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  DEFAULT_SUPERVISOR_POOL,
  SUPERVISOR_POOL_FILE,
  loadSupervisorPool,
  mergeSupervisorPool,
  parseSupervisorPoolConfig,
} from "../src/supervisor/pool.js"

describe("DEFAULT_SUPERVISOR_POOL", () => {
  it("包含 deepseek 与 mimo 候选", () => {
    const ids = DEFAULT_SUPERVISOR_POOL.candidates.map((c) => c.id)
    expect(ids).toContain("zen-deepseek")
    expect(ids).toContain("zen-mimo")
  })

  it("ADV-HAR-04: 所有候选默认禁用，用户必须显式配置", () => {
    for (const c of DEFAULT_SUPERVISOR_POOL.candidates) {
      expect(c.enabled).toBe(false)
    }
  })

  it("StepFun 默认禁用", () => {
    const stepfun = DEFAULT_SUPERVISOR_POOL.candidates.find((c) => c.id === "stepfun-3.5")
    expect(stepfun).toBeDefined()
    expect(stepfun!.enabled).toBe(false)
    expect(stepfun!.costClass).toBe("free-tier")
  })

  it("候选使用显式 target 而非虚拟路由", () => {
    for (const c of DEFAULT_SUPERVISOR_POOL.candidates) {
      expect(c.target).not.toMatch(/free-auto|virtual/)
      expect(c.target.length).toBeGreaterThan(0)
    }
  })
})

describe("parseSupervisorPoolConfig", () => {
  it("校验合法配置", () => {
    const result = parseSupervisorPoolConfig({
      candidates: [
        {
          id: "custom",
          target: "supervisor.custom",
          priority: 80,
          capabilities: {
            structuredJson: true,
            reasoningText: false,
            maxEvidenceTokens: 4096,
          },
          costClass: "free",
          enabled: true,
        },
      ],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.config.candidates[0]!.id).toBe("custom")
    }
  })

  it("拒绝空 candidates", () => {
    const result = parseSupervisorPoolConfig({ candidates: [] })
    expect(result.ok).toBe(false)
  })
})

describe("mergeSupervisorPool", () => {
  it("用户条目按 ID 覆盖默认", () => {
    const merged = mergeSupervisorPool(DEFAULT_SUPERVISOR_POOL, {
      candidates: [
        {
          id: "zen-deepseek",
          target: "supervisor.zen-free",
          priority: 200,
          capabilities: {
            structuredJson: true,
            reasoningText: true,
            maxEvidenceTokens: 8192,
          },
          costClass: "free",
          enabled: false,
        },
      ],
    })
    const deepseek = merged.candidates.find((c) => c.id === "zen-deepseek")
    expect(deepseek!.priority).toBe(200)
    expect(deepseek!.enabled).toBe(false)
    expect(merged.candidates.length).toBe(DEFAULT_SUPERVISOR_POOL.candidates.length)
  })
})

describe("loadSupervisorPool", () => {
  it("ADV-HAR-04: 无文件时返回空池（无候选）", () => {
    const dir = mkdtempSync(join(tmpdir(), "covalo-pool-"))
    const pool = loadSupervisorPool(dir)
    expect(pool.candidates.length).toBe(0)
  })

  it("从 .covalo/supervisor-pool.json 加载并合并", () => {
    const dir = mkdtempSync(join(tmpdir(), "covalo-pool-"))
    const configDir = join(dir, ".covalo")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(
      join(configDir, "supervisor-pool.json"),
      JSON.stringify({
        candidates: [
          {
            id: "zen-mimo",
            target: "supervisor.mimo-free",
            priority: 95,
            capabilities: {
              structuredJson: true,
              reasoningText: true,
              maxEvidenceTokens: 8192,
            },
            costClass: "free",
            enabled: true,
          },
        ],
      }),
      "utf8",
    )

    const pool = loadSupervisorPool(dir)
    const mimo = pool.candidates.find((c) => c.id === "zen-mimo")
    expect(mimo!.priority).toBe(95)
    expect(pool.candidates.find((c) => c.id === "zen-deepseek")).toBeDefined()
  })

  it("ADV-HAR-04: 解析失败时返回空池", () => {
    const dir = mkdtempSync(join(tmpdir(), "covalo-pool-"))
    const configDir = join(dir, ".covalo")
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, "supervisor-pool.json"), "{ invalid", "utf8")

    const pool = loadSupervisorPool(dir)
    expect(pool.candidates.length).toBe(0)
  })
})

describe("SUPERVISOR_POOL_FILE", () => {
  it("路径为 .covalo/supervisor-pool.json", () => {
    expect(SUPERVISOR_POOL_FILE).toBe(".covalo/supervisor-pool.json")
  })
})
