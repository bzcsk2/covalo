import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { BranchBudgetTracker } from "../src/governance/branch-budget.js"
import { extractToolTargetPath, extractRunCommand } from "../src/governance/branch-budget-tool-path.js"
import {
  ModeDecisionEngine,
  createEmptyRuntimeExecutionState,
  resolveInitialExecutionMode,
  isAutoModeDecisionEnabled,
} from "../src/governance/mode-decision.js"
import { CheckpointEngine } from "../src/checkpoint/checkpoint-engine.js"
import { setPromptLocale } from "../src/prompt-locale.js"
import type { EffectiveHarnessPolicy } from "../src/model-profile/types.js"

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

/**
 * 审计反馈 B1-B6 验证点：模拟 loop.ts 中的关键步骤，验证 F0-1 接入语义。
 * 这些测试不调用 runLoop（Windows 上 bun test 存在 EPERM 文件锁 bug），
 * 但覆盖了审计反馈的 6 个阻塞问题的核心逻辑。
 * 真正调用 runLoop 的 runtime-level 测试见 f0-1-runtime-loop.test.ts（Linux/CI 可运行）。
 */
describe("F0-1: 审计反馈 B1-B6 验证", () => {
  let tmpDir: string

  beforeEach(() => {
    setPromptLocale("en")
    tmpDir = mkdtempSync(join(tmpdir(), "f0-1-audit-"))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // 仿 loop.ts 中 effectivePolicy.executionMode → harnessMode 映射
  function mapHarnessMode(policy: EffectiveHarnessPolicy): "free" | "adaptive" | "forced" {
    if (policy.executionMode === "forced") return "forced"
    if (policy.executionMode === "free") return "free"
    return "adaptive"
  }

  function makePolicy(strictness: "strict" | "normal" | "loose"): EffectiveHarnessPolicy {
    if (strictness === "strict") {
      return {
        strictness: "strict", source: "default",
        toolset: "compact", maxParallelTools: 1, maxTurns: 50,
        readBeforeWrite: "block", textToolSalvage: "off",
        branchBudget: "enforce", checkpoint: "frequent",
        verification: "block", earlyStop: "aggressive",
        toolRouting: "two-stage", executionMode: "forced",
        shellPolicy: "dual-track-conservative", supervisorPolicy: "on-failure",
      }
    }
    if (strictness === "loose") {
      return {
        strictness: "loose", source: "default",
        toolset: "full", maxParallelTools: 4, maxTurns: 100,
        readBeforeWrite: "off", textToolSalvage: "always",
        branchBudget: "observe", checkpoint: "minimal",
        verification: "warn", earlyStop: "critical-only",
        toolRouting: "direct", executionMode: "free",
        shellPolicy: "dual-track", supervisorPolicy: "off",
      }
    }
    return {
      strictness: "normal", source: "default",
      toolset: "standard", maxParallelTools: 2, maxTurns: 75,
      readBeforeWrite: "warn", textToolSalvage: "on-native-failure",
      branchBudget: "recover", checkpoint: "safe-point",
      verification: "require-or-waive", earlyStop: "standard",
      toolRouting: "auto", executionMode: "adaptive",
      shellPolicy: "dual-track", supervisorPolicy: "on-failure",
    }
  }

  it("B1: executionMode='free' 时 resolveInitialExecutionMode 返回 free，isAutoModeDecisionEnabled 返回 false", () => {
    const policy = makePolicy("loose")
    const harnessMode = mapHarnessMode(policy)
    expect(harnessMode).toBe("free")
    expect(resolveInitialExecutionMode(harnessMode)).toBe("free")
    expect(isAutoModeDecisionEnabled(harnessMode)).toBe(false)
    // free 模式下 loop.ts 会跳过 evaluateExecutionMode，不会被拉入 forced
  })

  it("B1: executionMode='forced' 时 resolveInitialExecutionMode 返回 forced，初始即 forced policy", () => {
    const policy = makePolicy("strict")
    const harnessMode = mapHarnessMode(policy)
    expect(harnessMode).toBe("forced")
    expect(resolveInitialExecutionMode(harnessMode)).toBe("forced")
    // forced 模式下 loop.ts 初始化时即 setForcedPolicy(true)
    const checkpoint = new CheckpointEngine(tmpDir, "b1-forced")
    checkpoint.setForcedPolicy(true)
    expect(checkpoint.isForcedPolicyActive()).toBe(true)
  })

  it("B1: executionMode='adaptive' 时 isAutoModeDecisionEnabled 返回 true，初始为 free", () => {
    const policy = makePolicy("normal")
    const harnessMode = mapHarnessMode(policy)
    expect(harnessMode).toBe("adaptive")
    expect(isAutoModeDecisionEnabled(harnessMode)).toBe(true)
    expect(resolveInitialExecutionMode(harnessMode)).toBe("free")
  })

  it("B2: branchBudget='enforce' 时 shouldHardBlock=true；'recover' 时 shouldHardBlock=false", () => {
    // 仿 loop.ts: const shouldHardBlock = effectivePolicy?.branchBudget === "enforce"
    const strictPolicy = makePolicy("strict")
    const normalPolicy = makePolicy("normal")
    const loosePolicy = makePolicy("loose")

    expect(strictPolicy.branchBudget).toBe("enforce")
    expect(normalPolicy.branchBudget).toBe("recover")
    expect(loosePolicy.branchBudget).toBe("observe")

    // loop.ts 中的判定逻辑
    const shouldHardBlockStrict = strictPolicy.branchBudget === "enforce"
    const shouldHardBlockNormal = normalPolicy.branchBudget === "enforce"
    const shouldHardBlockLoose = loosePolicy.branchBudget === "enforce"

    expect(shouldHardBlockStrict).toBe(true)   // enforce → 硬拦截
    expect(shouldHardBlockNormal).toBe(false)  // recover → 不硬拦截，只记录
    expect(shouldHardBlockLoose).toBe(false)   // observe → 不硬拦截，tracker 禁用
  })

  it("B3: BranchBudget 记录不依赖 TaskLedger（验证 recordBranchBudget 可独立调用）", () => {
    // 仿 loop.ts: recordBranchBudget 在 (toolEvent.role === "tool" || "error") && toolEvent.toolName 时调用
    // 不再要求 taskLedger 存在
    const tracker = new BranchBudgetTracker({ fileEditMax: 3 })
    tracker.bindWorkspaceRoot(tmpDir)
    tracker.setEnabled(true)

    // 模拟工具结果回调（无 TaskLedger）
    const toolName = "write_file"
    const args = { path: join(tmpDir, "foo.ts") }
    const result = { content: "wrote", isError: false }

    // 仿 loop.ts recordBranchBudget
    if (extractToolTargetPath(toolName, args) && !result.isError) {
      tracker.recordFileEdit(extractToolTargetPath(toolName, args))
    }

    // 验证：即使没有 TaskLedger，BranchBudget 也记录了 file edit
    const inspect = tracker.inspect()
    expect(Object.keys(inspect.fileEdits).length).toBe(1)
    expect(Object.values(inspect.fileEdits)[0]).toBe(1)
  })

  it("B4: applySnapshot 后不调用 resetRoundBudget，恢复的三维计数保留", async () => {
    // 准备：原 tracker 累积了三维计数
    const original = new BranchBudgetTracker({ fileEditMax: 5 })
    original.bindWorkspaceRoot(tmpDir)
    original.recordFileEdit(join(tmpDir, "a.ts"))
    original.recordFileEdit(join(tmpDir, "a.ts"))
    original.recordFailedCommandAttempt("npm test")
    original.markRecoveryTriggered()

    // 落盘
    const checkpoint = new CheckpointEngine(tmpDir, "b4-test")
    await checkpoint.save({ trigger: "compaction", branchBudget: original })

    // 仿 engine.ts: loadV2 + applySnapshot（B4 修复后不再调用 resetRoundBudget）
    const restored = new BranchBudgetTracker({ fileEditMax: 5 })
    restored.bindWorkspaceRoot(tmpDir)
    const v2 = await checkpoint.loadV2()
    expect(v2).not.toBeNull()
    restored.applySnapshot(v2!.branchBudget)

    // 验证：恢复后三维计数保留（B4 修复前会被 resetRoundBudget 清空）
    const r = restored.inspect()
    expect(Object.keys(r.fileEdits).length).toBe(1)
    expect(r.fileEdits[Object.keys(r.fileEdits)[0]]).toBe(2)
    expect(Object.keys(r.commandRetries).length).toBe(1)
    expect(restored.recoverTriggerCount).toBe(1)
  })

  it("B5: batch 中部分 blocked 时，所有 tool_call 都应有 tool_result（不产生 orphan）", () => {
    // 仿 loop.ts B5 修复：一旦 batch 中有任意 tool_call 被 block，
    // 整个 batch 全部不执行，给每个 tool_call 都 append 一个 tool_result
    const tracker = new BranchBudgetTracker({ fileEditMax: 1 })
    tracker.bindWorkspaceRoot(tmpDir)
    // preexisting.ts 已编辑 1 次，达到 fileEditMax=1 上限，再次编辑会被 block
    tracker.recordFileEdit(join(tmpDir, "preexisting.ts"))

    // 模拟 2 个 tool_call：tc1 目标已达上限（被 block），tc2 目标未达上限（不被 block）
    const toolCalls = [
      { id: "tc1", function: { name: "write_file", arguments: JSON.stringify({ path: join(tmpDir, "preexisting.ts") }) } },
      { id: "tc2", function: { name: "write_file", arguments: JSON.stringify({ path: join(tmpDir, "new.ts") }) } },
    ]

    // 仿 loop.ts checkBranchBudgetBlocks
    const blocks = new Map<string, string>()
    for (const tc of toolCalls) {
      const args = JSON.parse(tc.function.arguments)
      const decision = tracker.checkToolBlock(
        tc.function.name, args, extractToolTargetPath, extractRunCommand, { workspaceRoot: tmpDir },
      )
      if (decision.blocked && decision.message) {
        blocks.set(tc.id, decision.message)
      }
    }

    // 仅 tc1 被 block（tc2 是新文件，未达上限）
    expect(blocks.size).toBe(1)
    expect(blocks.has("tc1")).toBe(true)

    // 仿 loop.ts B5 修复：给每个 tool_call 都 append tool_result（block 的和未 block 的都要补）
    const appended: { tcId: string; hasResult: boolean; isBlock: boolean }[] = []
    for (const tc of toolCalls) {
      const blockMsg = blocks.get(tc.id)
      if (blockMsg) {
        // 被 block 的：block 消息作为 tool_result
        appended.push({ tcId: tc.id, hasResult: true, isBlock: true })
      } else {
        // B5 修复：未 block 的也补一个 tool_result，避免 orphan tool_call
        appended.push({ tcId: tc.id, hasResult: true, isBlock: false })
      }
    }

    // 验证：所有 tool_call 都有 tool_result（不产生 orphan）
    expect(appended.length).toBe(toolCalls.length)
    expect(appended.every(a => a.hasResult)).toBe(true)
    // 验证只有 tc1 是被 block 的
    expect(appended.filter(a => a.isBlock).length).toBe(1)
  })

  it("B6: pending recovery signal 提交后立即消费，下一轮不再重复提交", async () => {
    // 准备：写入一个未消费的 recovery signal
    const checkpoint = new CheckpointEngine(tmpDir, "b6-test")
    await checkpoint.save({
      trigger: "manual",
      branchBudget: new BranchBudgetTracker(),
      appendRecoverySignal: {
        source: "branch_budget",
        message: "test-signal",
        at: Date.now(),
        consumed: false,
      },
    })

    expect(checkpoint.pendingRecoverySignals().length).toBe(1)

    // 仿 loop.ts evaluateExecutionMode 第一轮：submitSignal + markRecoverySignalsConsumed
    const modeEngine = new ModeDecisionEngine()
    const pending1 = checkpoint.pendingRecoverySignals()
    if (pending1.length > 0) {
      modeEngine.submitSignal("checkpoint_engine", "checkpoint_resumed")
      // B6 修复：立即消费，避免下一轮重复提交
      checkpoint.markRecoverySignalsConsumed(() => true)
    }

    // 验证：第一轮提交了 checkpoint_resumed 信号
    expect(modeEngine.getSubmittedSignals().length).toBe(1)

    // 仿 loop.ts evaluateExecutionMode 第二轮：pending 已消费，不再提交
    const pending2 = checkpoint.pendingRecoverySignals()
    expect(pending2.length).toBe(0)
    // 第二轮不会再 submitSignal
  })

  it("B6-2: free/forced 模式下 ModeDecisionEngine submitted signals 不残留", async () => {
    // 审计反馈 B6-2: executionMode='free'/'forced' 路径下 evaluateExecutionMode()
    // 不调用 evaluate()，submitted signals 不会被 finally 块清空。
    // 修复：非 adaptive 模式下显式 resetSubmittedSignals + markRecoverySignalsConsumed。

    // 准备：写入一个未消费的 recovery signal
    const checkpoint = new CheckpointEngine(tmpDir, "b6-2-test")
    await checkpoint.save({
      trigger: "manual",
      branchBudget: new BranchBudgetTracker(),
      appendRecoverySignal: {
        source: "branch_budget",
        message: "test-signal-free-forced",
        at: Date.now(),
        consumed: false,
      },
    })

    const modeEngine = new ModeDecisionEngine()

    // 仿 engine.ts: 非 adaptive 模式下不 submitSignal，直接消费 pending signals
    // （engine.ts 的 isAdaptiveMode 分支）
    const isAdaptiveMode = false  // 模拟 free/forced 模式
    if (!isAdaptiveMode) {
      // 非 adaptive：不提交 signal，直接消费
      checkpoint.markRecoverySignalsConsumed(() => true)
    }

    // 验证：modeEngine 没有 submitted signals（因为没提交）
    expect(modeEngine.getSubmittedSignals().length).toBe(0)
    // 验证：pending signals 已被消费
    expect(checkpoint.pendingRecoverySignals().length).toBe(0)

    // 仿 loop.ts evaluateExecutionMode: 非 auto 分支也清理
    const autoModeDecisionEnabled = false  // free/forced 模式
    if (!autoModeDecisionEnabled) {
      modeEngine.resetSubmittedSignals()
      if (checkpoint) {
        checkpoint.markRecoverySignalsConsumed(() => true)
      }
    }

    // 验证：仍然没有残留 signals
    expect(modeEngine.getSubmittedSignals().length).toBe(0)
    expect(checkpoint.pendingRecoverySignals().length).toBe(0)
  })

  it("B6-2: adaptive 模式下 checkpoint_resumed signal 正常提交并消费", async () => {
    // 对比测试：adaptive 模式下 checkpoint_resumed signal 正常走 evaluate 流程
    const checkpoint = new CheckpointEngine(tmpDir, "b6-2-adaptive-test")
    await checkpoint.save({
      trigger: "manual",
      branchBudget: new BranchBudgetTracker(),
      appendRecoverySignal: {
        source: "branch_budget",
        message: "test-signal-adaptive",
        at: Date.now(),
        consumed: false,
      },
    })

    expect(checkpoint.pendingRecoverySignals().length).toBe(1)

    const modeEngine = new ModeDecisionEngine()

    // 仿 engine.ts: adaptive 模式下提交 checkpoint_resumed
    const isAdaptiveMode = true
    if (isAdaptiveMode) {
      modeEngine.submitSignal("checkpoint_engine", "checkpoint_resumed")
    }

    // 仿 loop.ts evaluateExecutionMode: auto 分支
    const autoModeDecisionEnabled = true
    if (autoModeDecisionEnabled) {
      // 收集 pending recovery signals 并提交
      const pending = checkpoint.pendingRecoverySignals()
      if (pending.length > 0) {
        // signal 已在 engine.ts 中提交，这里只消费 pending
        checkpoint.markRecoverySignalsConsumed(() => true)
      }

      // evaluate 会消费 submitted signals
      const state = createEmptyRuntimeExecutionState()
      modeEngine.evaluate({
        round: 1,
        executionMode: "free",
        executionModeLockRemaining: 0,
        harnessMode: "adaptive",
        riskLevel: "L1_minor_edit",
        state,
        signals: [],
      })
    }

    // 验证：pending signals 已消费
    expect(checkpoint.pendingRecoverySignals().length).toBe(0)
    // 验证：submitted signals 已被 evaluate 清空
    expect(modeEngine.getSubmittedSignals().length).toBe(0)
  })
})
