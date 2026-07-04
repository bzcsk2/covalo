import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { rm, mkdir } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AgentScoreStore } from "../src/scoring/store.js"
import type { AgentRunScore } from "../src/scoring/types.js"

describe("SPEC-04: AgentScoreStore.append", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-score-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("连续 append 三条 score，list() 返回 3 条且顺序不变", () => {
    const store = new AgentScoreStore({ basePath: join(tmpDir, "scores") })

    const s1: AgentRunScore = { workflowId: "w1", score: 0.8, model: "m1", signature: "sig1" } as any
    const s2: AgentRunScore = { workflowId: "w1", score: 0.9, model: "m2", signature: "sig2" } as any
    const s3: AgentRunScore = { workflowId: "w1", score: 0.7, model: "m3", signature: "sig3" } as any

    store.append(s1)
    store.append(s2)
    store.append(s3)

    const list = store.list("w1")
    expect(list).toHaveLength(3)
    expect(list[0].signature).toBe("sig1")
    expect(list[1].signature).toBe("sig2")
    expect(list[2].signature).toBe("sig3")
  })

  it("append 到不存在的工作流文件时自动创建目录", () => {
    const store = new AgentScoreStore({ basePath: join(tmpDir, "deep", "nested", "scores") })

    const score: AgentRunScore = { workflowId: "new-wf", score: 1.0, model: "m1", signature: "sig" } as any
    store.append(score)

    const list = store.list("new-wf")
    expect(list).toHaveLength(1)
    expect(list[0].signature).toBe("sig")
  })

  it("latest 返回最后一条", () => {
    const store = new AgentScoreStore({ basePath: join(tmpDir, "scores") })

    store.append({ workflowId: "w2", score: 0.5, model: "m1", signature: "sig-a" } as any)
    store.append({ workflowId: "w2", score: 0.9, model: "m2", signature: "sig-b" } as any)

    const latest = store.latest("w2")
    expect(latest).not.toBeNull()
    expect(latest!.signature).toBe("sig-b")
  })
})
