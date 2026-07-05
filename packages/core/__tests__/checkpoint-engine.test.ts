import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, it, expect, beforeEach, afterEach } from "vitest"

import { CheckpointEngine, isResilienceV2Enabled } from "../src/checkpoint/checkpoint-engine.js"
import { BranchBudgetTracker } from "../src/governance/branch-budget.js"
import {
  RUNTIME_CHECKPOINT_VERSION,
  isRuntimeCheckpointV2,
  type RuntimeCheckpointV2,
} from "../src/checkpoint/runtime-checkpoint.js"
import type { SessionCheckpointEnvelope } from "../src/checkpoint/checkpoint-envelope.js"

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "covalo-ce-"))
}

function buildV1Envelope(): SessionCheckpointEnvelope {
  return {
    version: 1,
    sessionId: "sess-1",
    status: "running",
    userGoal: "demo",
    messageCount: 5,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

describe("isResilienceV2Enabled", () => {
  it("硬编码为始终开启", () => {
    expect(isResilienceV2Enabled()).toBe(true)
  })
})

describe("CheckpointEngine - save", () => {
  let tmp: string
  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("首次 save 时若文件不存在则生成最小 v1 壳 + v2 字段", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    await engine.save({ trigger: "tool_failed" })

    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, "utf-8"))
    expect(raw.version).toBe(1)
    expect(isRuntimeCheckpointV2(raw.runtimeV2)).toBe(true)
    expect(raw.runtimeV2.lastTrigger).toBe("tool_failed")
    expect(raw.runtimeV2.runtimeVersion).toBe(RUNTIME_CHECKPOINT_VERSION)
  })

  it("已有 v1 checkpoint 时只追加 runtimeV2，不破坏 v1 字段", async () => {
    const v1 = buildV1Envelope()
    const engine = new CheckpointEngine(tmp, "sess-1")
    await fs.writeFile(engine.checkpointPath, JSON.stringify(v1, null, 2), "utf-8")

    await engine.save({
      trigger: "step_completed",
      verificationPending: true,
    })

    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, "utf-8"))
    expect(raw.version).toBe(1)
    expect(raw.sessionId).toBe("sess-1")
    expect(raw.userGoal).toBe("demo")
    expect(raw.runtimeV2.verificationPending).toBe(true)
  })

  it("合并 branchBudget 快照", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    const budget = new BranchBudgetTracker()
    budget.recordFileEdit("a.ts")
    budget.recordFileEdit("a.ts")
    budget.recordFailedCommandAttempt("npm test")
    budget.markRecoveryTriggered()

    await engine.save({ trigger: "tool_failed", branchBudget: budget })
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, "utf-8"))
    expect(raw.runtimeV2.branchBudget.fileEdits["a.ts"]).toBe(2)
    expect(raw.runtimeV2.branchBudget.commandRetries["npm test"]).toBe(1)
    expect(raw.runtimeV2.branchBudget.recoverTriggers).toBe(1)
  })

  it("多次 appendTool 累积并限制最大条数", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    for (let i = 0; i < 30; i++) {
      await engine.save({
        trigger: "step_completed",
        appendTool: { toolName: "read_file", success: true, signature: `sig-${i}`, at: i },
      })
    }
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, "utf-8"))
    expect(raw.runtimeV2.recentTools.length).toBeLessThanOrEqual(20)
    const last = raw.runtimeV2.recentTools[raw.runtimeV2.recentTools.length - 1]
    expect(last.signature).toBe("sig-29")
  })

  it("appendFailure 同签名累加 count，不重复入列", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    await engine.save({
      trigger: "tool_failed",
      appendFailure: { signature: "edit_file:x", count: 1, lastError: "boom", at: 1 },
    })
    await engine.save({
      trigger: "tool_failed",
      appendFailure: { signature: "edit_file:x", count: 2, lastError: "boom2", at: 2 },
    })
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, "utf-8"))
    expect(raw.runtimeV2.recentFailures.length).toBe(1)
    expect(raw.runtimeV2.recentFailures[0].count).toBe(2)
    expect(raw.runtimeV2.recentFailures[0].lastError).toBe("boom2")
  })
})

describe("CheckpointEngine - restore", () => {
  let tmp: string
  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("loadV2 返回 null 当文件不存在", async () => {
    const engine = new CheckpointEngine(tmp, "missing")
    expect(await engine.loadV2()).toBeNull()
  })

  it("loadV2 返回 null 当文件只有 v1 字段（向后兼容）", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    await fs.writeFile(engine.checkpointPath, JSON.stringify(buildV1Envelope(), null, 2), "utf-8")
    expect(await engine.loadV2()).toBeNull()
  })

  it("save → loadV2 完整往返保留状态", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    const budget = new BranchBudgetTracker()
    budget.recordFileEdit("x.ts")
    budget.recordFailedCommandAttempt("ls")
    budget.markRecoveryTriggered()

    await engine.save({
      trigger: "step_completed",
      branchBudget: budget,
      currentStepId: "step-02",
      currentStepTitle: "编辑文件",
      verificationPending: true,
      appendTool: { toolName: "edit_file", success: true, signature: "sig-1", at: 10 },
      appendRecoverySignal: {
        source: "branch_budget",
        message: "switch strategy",
        at: 11,
        consumed: false,
      },
    })

    const engine2 = new CheckpointEngine(tmp, "sess-1")
    const v2 = await engine2.loadV2()
    expect(v2).not.toBeNull()
    const r = v2 as RuntimeCheckpointV2
    expect(r.currentStepId).toBe("step-02")
    expect(r.verificationPending).toBe(true)
    expect(r.branchBudget.fileEdits["x.ts"]).toBe(1)
    expect(r.branchBudget.commandRetries["ls"]).toBe(1)
    expect(r.branchBudget.recoverTriggers).toBe(1)
    expect(r.recentTools[0].toolName).toBe("edit_file")
    expect(r.recoverySignals[0].message).toBe("switch strategy")
  })

  it("损坏的 JSON → loadV2 返回 null 而不抛", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    await fs.writeFile(engine.checkpointPath, "{not valid json", "utf-8")
    expect(await engine.loadV2()).toBeNull()
  })

  it("runtimeV2 schema 版本错误（不是 2） → loadV2 返回 null", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    const bad = {
      ...buildV1Envelope(),
      runtimeV2: {
        runtimeVersion: 99,
        branchBudget: { fileEdits: {}, commandRetries: {}, errorRepeats: {}, recoverTriggers: 0 },
        recentTools: [],
        recentFailures: [],
        recoverySignals: [],
        verificationPending: false,
        lastTrigger: "manual",
        v2UpdatedAt: "2026-01-01",
      },
    }
    await fs.writeFile(engine.checkpointPath, JSON.stringify(bad, null, 2), "utf-8")
    expect(await engine.loadV2()).toBeNull()
  })
})

describe("CheckpointEngine - recovery signals", () => {
  let tmp: string
  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("pendingRecoverySignals 仅返回未消费的", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    await engine.save({
      trigger: "tool_failed",
      appendRecoverySignal: { source: "branch_budget", message: "a", at: 1, consumed: false },
    })
    await engine.save({
      trigger: "tool_failed",
      appendRecoverySignal: { source: "branch_budget", message: "b", at: 2, consumed: false },
    })
    expect(engine.pendingRecoverySignals().length).toBe(2)

    engine.markRecoverySignalsConsumed(s => s.message === "a")
    expect(engine.pendingRecoverySignals().map(s => s.message)).toEqual(["b"])
  })

  it("discardPendingRecoverySignals marks all unconsumed without returning them", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    await engine.save({
      trigger: "tool_failed",
      appendRecoverySignal: { source: "branch_budget", message: "a", at: 1, consumed: false },
    })
    await engine.save({
      trigger: "tool_failed",
      appendRecoverySignal: { source: "branch_budget", message: "b", at: 2, consumed: false },
    })
    engine.discardPendingRecoverySignals()
    expect(engine.pendingRecoverySignals()).toEqual([])
  })

  it("resetMemory 清空内存状态但不影响磁盘文件", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    await engine.save({
      trigger: "tool_failed",
      appendRecoverySignal: { source: "branch_budget", message: "x", at: 1, consumed: false },
    })
    engine.resetMemory()
    expect(engine.getV2State().recoverySignals).toEqual([])
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, "utf-8"))
    expect(raw.runtimeV2.recoverySignals.length).toBe(1)
  })
})

describe("CheckpointEngine - 写入原子性", () => {
  let tmp: string
  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("写入是先 tmp + rename，不会留下半写入的 tmp 文件", async () => {
    const engine = new CheckpointEngine(tmp, "sess-1")
    await engine.save({ trigger: "manual" })
    const files = await fs.readdir(tmp)
    expect(files.some(f => f.endsWith(".tmp"))).toBe(false)
    expect(files.length).toBe(1)
  })
})

describe("CheckpointEngine forced policy", () => {
  it("defaults to safe-point policy and persists on step_completed", async () => {
    const tmp = await makeTempDir()
    const engine = new CheckpointEngine(tmp)
    expect(engine.isForcedPolicyActive()).toBe(false)
    // FIX-H5: 默认 checkpointPolicy="safe-point"，step_completed 落盘（不再是 free policy）
    expect(engine.shouldPersistOnTrigger("step_completed")).toBe(true)
    expect(engine.shouldPersistOnTrigger("tool_failed")).toBe(true)
    // verification_started 不在 safe-point 集合中
    expect(engine.shouldPersistOnTrigger("verification_started")).toBe(false)
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it("forced policy does not override checkpointPolicy frequency", async () => {
    const tmp = await makeTempDir()
    const engine = new CheckpointEngine(tmp)
    engine.setForcedPolicy(true)

    expect(engine.isForcedPolicyActive()).toBe(true)
    // FIX-H5: forcedPolicyActive 不再影响 shouldPersistOnTrigger，频率由 checkpointPolicy 决定
    expect(engine.shouldPersistOnTrigger("step_completed")).toBe(true)
    // verification_started 在 safe-point 下不落盘，即使 forced
    expect(engine.shouldPersistOnTrigger("verification_started")).toBe(false)
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it("falls back to safe-point policy when forced policy is cleared", async () => {
    const tmp = await makeTempDir()
    const engine = new CheckpointEngine(tmp)
    engine.setForcedPolicy(true)
    engine.setForcedPolicy(false)

    expect(engine.isForcedPolicyActive()).toBe(false)
    // FIX-H5: 清除 forced 后回到 safe-point 默认（step_completed 仍落盘）
    expect(engine.shouldPersistOnTrigger("step_completed")).toBe(true)
    await fs.rm(tmp, { recursive: true, force: true })
  })
})

describe("SPEC-I: checkpoint persists taskLedger and verificationGate", () => {
  let tmp: string
  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("save 时传入 taskLedger 后 loadV2 恢复该字段", async () => {
    const engine = new CheckpointEngine(tmp, "sess-spece")
    const taskLedger = {
      goal: "test goal",
      plan: [{ title: "step1", status: "done" }],
      changedFiles: ["a.ts"],
      verificationPending: false,
      evictedFileCount: 0,
      evictedCommandCount: 0,
    }

    await engine.save({
      trigger: "step_completed",
      taskLedger,
    })

    const v2 = await engine.loadV2()
    expect(v2).not.toBeNull()
    expect(v2!.taskLedger).toBeDefined()
    expect(v2!.taskLedger!.goal).toBe("test goal")
    expect(v2!.taskLedger!.changedFiles).toEqual(["a.ts"])
  })

  it("save 时传入 verificationGate 后 loadV2 恢复该字段", async () => {
    const engine = new CheckpointEngine(tmp, "sess-spece")
    const verificationGate = { continuationCount: 3 }

    await engine.save({
      trigger: "step_completed",
      verificationGate,
    })

    const v2 = await engine.loadV2()
    expect(v2).not.toBeNull()
    expect(v2!.verificationGate).toBeDefined()
    expect(v2!.verificationGate!.continuationCount).toBe(3)
  })

  it("save 同时传入 taskLedger 和 verificationGate", async () => {
    const engine = new CheckpointEngine(tmp, "sess-spece")
    const taskLedger = {
      goal: "combined goal",
      plan: [],
      changedFiles: ["b.ts", "c.ts"],
      verificationPending: true,
      evictedFileCount: 1,
      evictedCommandCount: 0,
    }
    const verificationGate = { continuationCount: 5 }

    await engine.save({
      trigger: "tool_failed",
      taskLedger,
      verificationGate,
    })

    const v2 = await engine.loadV2()
    expect(v2).not.toBeNull()
    expect(v2!.taskLedger!.goal).toBe("combined goal")
    expect(v2!.taskLedger!.changedFiles).toEqual(["b.ts", "c.ts"])
    expect(v2!.taskLedger!.verificationPending).toBe(true)
    expect(v2!.verificationGate!.continuationCount).toBe(5)
  })

  it("不传 taskLedger/verificationGate 时不覆盖已有值", async () => {
    const engine = new CheckpointEngine(tmp, "sess-spece")
    const taskLedger = { goal: "first", plan: [], changedFiles: [], verificationPending: false, evictedFileCount: 0, evictedCommandCount: 0 }
    const verificationGate = { continuationCount: 1 }

    // 第一次 save 传入两个字段
    await engine.save({ trigger: "tool_failed", taskLedger, verificationGate })

    // 第二次 save 不传 taskLedger/verificationGate
    await engine.save({ trigger: "step_completed" })

    const v2 = await engine.loadV2()
    expect(v2).not.toBeNull()
    // 因为 save 用的是 undefined 检查，不传不会覆盖
    expect(v2!.taskLedger).toBeDefined()
    expect(v2!.taskLedger!.goal).toBe("first")
    expect(v2!.verificationGate).toBeDefined()
    expect(v2!.verificationGate!.continuationCount).toBe(1)
  })

  it("cloneV2 对 taskLedger 做深拷贝 — 外部 mutation 不影响内部状态", async () => {
    const engine = new CheckpointEngine(tmp, "sess-spece")
    const taskLedger = {
      goal: "deep copy test",
      plan: [{ id: "s1", text: "step 1", status: "pending" as const }],
      changedFiles: ["a.ts"],
      commandsRun: [{ commandHash: "h1", success: true }],
      verificationPending: false,
      lastVerification: { command: "npm test", exitCode: 0, summary: "passed" },
      blockers: ["blocker1"],
      evictedFileCount: 0,
      evictedCommandCount: 0,
    }

    await engine.save({ trigger: "tool_failed", taskLedger })

    const v2 = await engine.loadV2()
    expect(v2).not.toBeNull()
    expect(v2!.taskLedger!.plan).toHaveLength(1)

    // 外部 mutation
    v2!.taskLedger!.plan.push({ id: "s2", text: "injected", status: "done" as const })
    v2!.taskLedger!.changedFiles.push("injected.ts")
    v2!.taskLedger!.commandsRun.push({ commandHash: "injected", success: false })
    v2!.taskLedger!.blockers.push("injected-blocker")
    v2!.taskLedger!.lastVerification!.exitCode = 1
    v2!.taskLedger!.goal = "mutated"

    // 再次 loadV2 — 内部状态不应受影响
    const v2Again = await engine.loadV2()
    expect(v2Again).not.toBeNull()
    expect(v2Again!.taskLedger!.plan).toHaveLength(1)
    expect(v2Again!.taskLedger!.plan[0].id).toBe("s1")
    expect(v2Again!.taskLedger!.changedFiles).toEqual(["a.ts"])
    expect(v2Again!.taskLedger!.commandsRun).toHaveLength(1)
    expect(v2Again!.taskLedger!.commandsRun[0].commandHash).toBe("h1")
    expect(v2Again!.taskLedger!.blockers).toEqual(["blocker1"])
    expect(v2Again!.taskLedger!.lastVerification!.exitCode).toBe(0)
    expect(v2Again!.taskLedger!.goal).toBe("deep copy test")
  })
})

