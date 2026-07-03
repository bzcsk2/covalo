import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { BranchBudgetTracker } from "../src/governance/branch-budget.js"
import { extractToolTargetPath, extractRunCommand } from "../src/governance/branch-budget-tool-path.js"
import { ModeDecisionEngine, createEmptyRuntimeExecutionState } from "../src/governance/mode-decision.js"
import { CheckpointEngine } from "../src/checkpoint/checkpoint-engine.js"
import { setPromptLocale } from "../src/prompt-locale.js"

/**
 * F0-1 集成测试：验证 BranchBudgetTracker / ModeDecisionEngine / CheckpointEngine
 * 三件套在 loop 接入后的协作链路。
 *
 * 不调用 runLoop（需 mock ChatClient/toolExecutor），而是模拟 loop.ts 中的关键步骤：
 * 1. submit 开始时 loadV2 恢复 BranchBudgetTracker 快照
 * 2. 工具执行前 checkToolBlock 硬拦截
 * 3. 工具结果回调中 recordFileEdit / recordFailedCommandAttempt
 * 4. turn 开始时 evaluateExecutionMode
 * 5. safe point 调用 checkpointEngine.save
 * 6. shutdown 时落盘
 */
describe("F0-1: governance/checkpoint 三件套集成", () => {
  let tmpDir: string

  beforeEach(() => {
    setPromptLocale("en")
    tmpDir = mkdtempSync(join(tmpdir(), "f0-1-integration-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("BranchBudgetTracker 超限 → ModeDecisionEngine 触发 enter_forced → CheckpointEngine 启用 forced policy", async () => {
    // 三件套实例化（仿 engine.ts 构造函数）
    const tracker = new BranchBudgetTracker({ fileEditMax: 2 })
    const modeEngine = new ModeDecisionEngine()
    const checkpoint = new CheckpointEngine(tmpDir, "test-session")

    tracker.bindWorkspaceRoot(tmpDir)
    expect(tracker.isEnabled()).toBe(true)
    expect(checkpoint.isForcedPolicyActive()).toBe(false)

    // 模拟工具结果回调：同一文件编辑 3 次（超过 fileEditMax=2）
    const filePath = join(tmpDir, "src/foo.ts")
    for (let i = 0; i < 3; i++) {
      tracker.recordFileEdit(filePath)
    }

    // BranchBudgetTracker.shouldBranchRecover 应触发
    const recover = tracker.shouldBranchRecover()
    expect(recover.triggered).toBe(true)
    expect(recover.dimension).toBe("file_edit")

    // 模拟 loop.ts evaluateExecutionMode：提交 recovery_pending 信号
    modeEngine.submitSignal("branch_budget", "recovery_pending", {
      dimension: recover.dimension,
      key: recover.key,
    })

    // 评估前为 free
    let state = createEmptyRuntimeExecutionState({
      recoveryPending: true,
      verificationPending: false,
    })
    const decision = modeEngine.evaluate({
      round: 1,
      executionMode: "free",
      executionModeLockRemaining: 0,
      harnessMode: "adaptive",
      riskLevel: "L1_minor_edit",
      state,
      signals: [],
    })

    // G2 修复后，recovery_pending 应触发 enter_forced
    expect(decision.action).toBe("enter_forced")
    if (decision.action === "enter_forced") {
      expect(decision.primaryReason).toBe("recovery_pending")
    }

    // 应用决策（仿 loop.ts evaluateExecutionMode 中的 apply 逻辑）
    checkpoint.setForcedPolicy(true)

    // forced policy 启用后，step_completed trigger 应真实落盘
    expect(checkpoint.isForcedPolicyActive()).toBe(true)
    expect(checkpoint.shouldPersistOnTrigger("step_completed")).toBe(true)

    // 落盘 checkpoint
    await checkpoint.save({
      trigger: "step_completed",
      branchBudget: tracker,
    })

    // 验证文件已写入
    expect(existsSync(checkpoint.checkpointPath)).toBe(true)
    const raw = JSON.parse(readFileSync(checkpoint.checkpointPath, "utf8"))
    expect(raw.runtimeV2).toBeDefined()
    expect(raw.runtimeV2.branchBudget.recoverTriggers).toBe(0) // markRecoveryTriggered 未调用
    expect(raw.runtimeV2.lastTrigger).toBe("step_completed")
  })

  it("CheckpointEngine loadV2 恢复 BranchBudgetTracker 快照（跨 submit 持久化）", async () => {
    const tracker = new BranchBudgetTracker({ fileEditMax: 3 })
    const checkpoint = new CheckpointEngine(tmpDir, "restore-test")
    tracker.bindWorkspaceRoot(tmpDir)

    // 第一次 submit：记录 2 次文件编辑 + 1 次命令失败
    tracker.recordFileEdit(join(tmpDir, "a.ts"))
    tracker.recordFileEdit(join(tmpDir, "a.ts"))
    tracker.recordFailedCommandAttempt("npm test")

    // 落盘
    await checkpoint.save({
      trigger: "tool_failed",
      branchBudget: tracker,
    })

    // 模拟新 submit：新的 BranchBudgetTracker 实例
    const restoredTracker = new BranchBudgetTracker({ fileEditMax: 3 })
    restoredTracker.bindWorkspaceRoot(tmpDir)
    const v2 = await checkpoint.loadV2()
    expect(v2).not.toBeNull()
    restoredTracker.applySnapshot(v2!.branchBudget)

    // 验证计数已恢复
    const inspect = restoredTracker.inspect()
    const aTsKey = Object.keys(inspect.fileEdits)[0]
    expect(inspect.fileEdits[aTsKey]).toBe(2)
    expect(inspect.commandRetries["npm test"]).toBe(1)

    // 继续累加应基于恢复值
    const next = restoredTracker.recordFileEdit(join(tmpDir, "a.ts"))
    expect(next).toBe(3)
    // 第 3 次已达上限，应该被拦截
    expect(restoredTracker.wouldBlockFileEdit(join(tmpDir, "a.ts"))).toBe(true)
  })

  it("工具批次前 checkToolBlock 硬拦截 write_file 达上限的调用", () => {
    const tracker = new BranchBudgetTracker({ fileEditMax: 2 })
    tracker.bindWorkspaceRoot(tmpDir)

    // 记录 2 次编辑（达上限）
    const filePath = join(tmpDir, "block-me.ts")
    tracker.recordFileEdit(filePath)
    tracker.recordFileEdit(filePath)

    // 模拟 loop.ts checkBranchBudgetBlocks
    const toolName = "write_file"
    const args = { path: filePath }
    const decision = tracker.checkToolBlock(
      toolName,
      args,
      extractToolTargetPath,
      extractRunCommand,
      { workspaceRoot: tmpDir },
    )

    expect(decision.blocked).toBe(true)
    expect(decision.dimension).toBe("file_edit")
    expect(decision.message).toContain("[BranchBudget/Blocked]")
  })

  it("工具批次前 checkToolBlock 硬拦截 bash 失败重试达上限", () => {
    const tracker = new BranchBudgetTracker({ commandRetryMax: 2 })
    tracker.bindWorkspaceRoot(tmpDir)

    // 同一命令失败 2 次（达上限）
    tracker.recordFailedCommandAttempt("npm run build")
    tracker.recordFailedCommandAttempt("npm run build")

    const decision = tracker.checkToolBlock(
      "bash",
      { command: "npm run build" },
      extractToolTargetPath,
      extractRunCommand,
      { workspaceRoot: tmpDir },
    )

    expect(decision.blocked).toBe(true)
    expect(decision.dimension).toBe("command_retry")
    expect(decision.message).toContain("command failed 2/2")
  })

  it("disabled BranchBudgetTracker 不拦截工具调用", () => {
    const tracker = new BranchBudgetTracker({ fileEditMax: 1 })
    tracker.bindWorkspaceRoot(tmpDir)
    tracker.recordFileEdit(join(tmpDir, "x.ts"))
    // 已达上限，但 disable 后不应拦截
    tracker.setEnabled(false)

    const decision = tracker.checkToolBlock(
      "write_file",
      { path: join(tmpDir, "x.ts") },
      extractToolTargetPath,
      extractRunCommand,
      { workspaceRoot: tmpDir },
    )
    expect(decision.blocked).toBe(false)
  })

  it("free policy 下 step_completed 不落盘，forced policy 下才落盘", async () => {
    const tracker = new BranchBudgetTracker()
    const checkpoint = new CheckpointEngine(tmpDir, "policy-test")
    tracker.bindWorkspaceRoot(tmpDir)

    // free policy（默认）
    expect(checkpoint.shouldPersistOnTrigger("step_completed")).toBe(false)
    expect(checkpoint.shouldPersistOnTrigger("verification_started")).toBe(false)

    // 但 tool_failed / final_draft 在 free 下也落盘
    expect(checkpoint.shouldPersistOnTrigger("tool_failed")).toBe(true)
    expect(checkpoint.shouldPersistOnTrigger("final_draft")).toBe(true)
    expect(checkpoint.shouldPersistOnTrigger("verification_failed")).toBe(true)
    expect(checkpoint.shouldPersistOnTrigger("compaction")).toBe(true)

    // 启用 forced policy
    checkpoint.setForcedPolicy(true)
    expect(checkpoint.shouldPersistOnTrigger("step_completed")).toBe(true)
    expect(checkpoint.shouldPersistOnTrigger("verification_started")).toBe(true)

    // 关闭 forced policy
    checkpoint.setForcedPolicy(false)
    expect(checkpoint.shouldPersistOnTrigger("step_completed")).toBe(false)
  })

  it("exit_forced 时关闭 forced policy，恢复 free 落盘策略", async () => {
    const tracker = new BranchBudgetTracker()
    const modeEngine = new ModeDecisionEngine()
    const checkpoint = new CheckpointEngine(tmpDir, "exit-forced-test")
    tracker.bindWorkspaceRoot(tmpDir)

    // 进入 forced
    checkpoint.setForcedPolicy(true)
    expect(checkpoint.isForcedPolicyActive()).toBe(true)

    // 模拟稳定状态：所有 pending 清零，stableRounds 达到阈值
    const state = createEmptyRuntimeExecutionState({
      lastToolSuccess: true,
      recoveryPending: false,
      verificationPending: false,
      pendingStepCount: 0,
      plannedWriteTargets: 0,
      stableRounds: 2,
      branchDebt: 0,
      forcedTaskBearingRoundsSinceEntry: 1,
    })
    const decision = modeEngine.evaluate({
      round: 5,
      executionMode: "forced",
      executionModeLockRemaining: 0,
      harnessMode: "adaptive",
      riskLevel: "L1_minor_edit",
      state,
      signals: [],
    })

    expect(decision.action).toBe("exit_forced")

    // 应用 exit_forced：关闭 forced policy
    if (decision.action === "exit_forced") {
      checkpoint.setForcedPolicy(false)
    }
    expect(checkpoint.isForcedPolicyActive()).toBe(false)
    expect(checkpoint.shouldPersistOnTrigger("step_completed")).toBe(false)
  })

  it("recovery signal 写入 checkpoint 并可被 pendingRecoverySignals 读出", async () => {
    const tracker = new BranchBudgetTracker({ fileEditMax: 1 })
    const checkpoint = new CheckpointEngine(tmpDir, "recovery-signal-test")
    tracker.bindWorkspaceRoot(tmpDir)

    // 触发 recovery
    tracker.recordFileEdit(join(tmpDir, "fail.ts"))
    const decision = tracker.shouldBranchRecover()
    expect(decision.triggered).toBe(true)
    const signal = tracker.buildRecoverySignal(decision)
    expect(signal).not.toBeNull()

    // 落盘带 recovery signal
    await checkpoint.save({
      trigger: "tool_failed",
      branchBudget: tracker,
      appendRecoverySignal: signal!,
    })

    // 读出未消费的 recovery signals
    const pending = checkpoint.pendingRecoverySignals()
    expect(pending.length).toBe(1)
    expect(pending[0].source).toBe("branch_budget")

    // 模拟 loop evaluateExecutionMode：如果有 pending signals，submit checkpoint_resumed
    const modeEngine = new ModeDecisionEngine()
    if (pending.length > 0) {
      modeEngine.submitSignal("checkpoint_engine", "checkpoint_resumed")
    }

    // checkpoint_resumed 应触发 enter_forced
    const state = createEmptyRuntimeExecutionState()
    const modeDecision = modeEngine.evaluate({
      round: 1,
      executionMode: "free",
      executionModeLockRemaining: 0,
      harnessMode: "adaptive",
      riskLevel: "L1_minor_edit",
      state,
      signals: [],
    })
    expect(modeDecision.action).toBe("enter_forced")
    if (modeDecision.action === "enter_forced") {
      expect(modeDecision.primaryReason).toBe("checkpoint_resumed")
    }

    // 消费后 pending 应为空
    checkpoint.markRecoverySignalsConsumed(() => true)
    expect(checkpoint.pendingRecoverySignals().length).toBe(0)
  })

  it("resetRoundBudget 清空 round 维度但保留 recoverTriggers", () => {
    const tracker = new BranchBudgetTracker({ fileEditMax: 3 })
    tracker.bindWorkspaceRoot(tmpDir)

    tracker.recordFileEdit(join(tmpDir, "a.ts"))
    tracker.recordFailedCommandAttempt("npm test")
    tracker.markRecoveryTriggered()
    expect(tracker.recoverTriggerCount).toBe(1)

    // resetRoundBudget 清空三维计数
    tracker.resetRoundBudget()
    const inspect = tracker.inspect()
    expect(Object.keys(inspect.fileEdits).length).toBe(0)
    expect(Object.keys(inspect.commandRetries).length).toBe(0)

    // recoverTriggers 保留
    expect(tracker.recoverTriggerCount).toBe(1)
  })

  it("snapshot 往返：save → loadV2 → applySnapshot 后状态一致", async () => {
    const original = new BranchBudgetTracker({ fileEditMax: 5, commandRetryMax: 3, errorRepeatMax: 4 })
    original.bindWorkspaceRoot(tmpDir)
    original.recordFileEdit(join(tmpDir, "a.ts"))
    original.recordFileEdit(join(tmpDir, "a.ts"))
    original.recordFileEdit(join(tmpDir, "b.ts"))
    original.recordFailedCommandAttempt("npm test")
    original.recordFailedCommandAttempt("npm test")
    original.recordError("Error: foo")
    original.markRecoveryTriggered()

    const checkpoint = new CheckpointEngine(tmpDir, "roundtrip-test")
    await checkpoint.save({ trigger: "compaction", branchBudget: original })

    const restored = new BranchBudgetTracker({ fileEditMax: 5, commandRetryMax: 3, errorRepeatMax: 4 })
    restored.bindWorkspaceRoot(tmpDir)
    const v2 = await checkpoint.loadV2()
    expect(v2).not.toBeNull()
    restored.applySnapshot(v2!.branchBudget)

    const o = original.inspect()
    const r = restored.inspect()
    expect(r.fileEdits).toEqual(o.fileEdits)
    expect(r.commandRetries).toEqual(o.commandRetries)
    expect(r.errorRepeats).toEqual(o.errorRepeats)
    expect(restored.recoverTriggerCount).toBe(original.recoverTriggerCount)
  })
})
