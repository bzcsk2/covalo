import { describe, expect, it } from "vitest"

import {
  ModeDecisionEngine,
  DEFAULT_EXECUTION_MODE_CONFIG,
  createEmptyRuntimeExecutionState,
  formatForcedReasonHuman,
  resolveInitialExecutionMode,
  isAutoModeDecisionEnabled,
  shouldEnterForcedMode,
  shouldExitForcedMode,
  sortSignalsByPrecedence,
} from "../src/governance/mode-decision.js"
import type { ModeDecisionContext, ModeSignal } from "../src/governance/mode-decision.js"

const cfg = DEFAULT_EXECUTION_MODE_CONFIG

function state(overrides: Parameters<typeof createEmptyRuntimeExecutionState>[0] = {}) {
  return createEmptyRuntimeExecutionState(overrides)
}

function context(overrides: Partial<ModeDecisionContext> = {}): ModeDecisionContext {
  const runtimeState = overrides.state ?? state()
  return {
    round: runtimeState.round,
    executionMode: "free",
    executionModeLockRemaining: 0,
    harnessMode: "adaptive",
    riskLevel: "L0_observation",
    state: runtimeState,
    signals: [],
    ...overrides,
  }
}

describe("sortSignalsByPrecedence", () => {
  it("按优先级排序，recovery_pending 纳入 enter 信号（G2 修复）", () => {
    const signals: ModeSignal[] = [
      "pending_steps",
      "recovery_pending",
      "checkpoint_resumed",
      "multi_write",
    ]
    expect(sortSignalsByPrecedence(signals)).toEqual([
      "checkpoint_resumed",
      "pending_steps",
      "recovery_pending",
      "multi_write",
    ])
  })

  it("verification_pending 仍被排除（不触发 enter_forced）", () => {
    const signals: ModeSignal[] = ["verification_pending", "tool_failure"]
    expect(sortSignalsByPrecedence(signals)).toEqual(["tool_failure"])
  })
})

describe("formatForcedReasonHuman", () => {
  it("无信号时返回 free", () => {
    expect(formatForcedReasonHuman([])).toBe("free")
  })

  it("多信号用 + 连接", () => {
    expect(formatForcedReasonHuman(["checkpoint_resumed", "tool_failure"])).toBe(
      "forced because checkpoint_resumed + tool_failure",
    )
  })
})

describe("resolveInitialExecutionMode", () => {
  it("forced/strict 初始为 forced", () => {
    expect(resolveInitialExecutionMode("forced")).toBe("forced")
    expect(resolveInitialExecutionMode("strict")).toBe("forced")
  })

  it("free/adaptive 初始为 free", () => {
    expect(resolveInitialExecutionMode("free")).toBe("free")
    expect(resolveInitialExecutionMode("adaptive")).toBe("free")
  })
})

describe("isAutoModeDecisionEnabled", () => {
  it("adaptive/strict 启用自动决策", () => {
    expect(isAutoModeDecisionEnabled("adaptive")).toBe(true)
    expect(isAutoModeDecisionEnabled("strict")).toBe(true)
  })

  it("free/forced 不启用 adaptive 决策", () => {
    expect(isAutoModeDecisionEnabled("free")).toBe(false)
    expect(isAutoModeDecisionEnabled("forced")).toBe(false)
  })
})

describe("shouldEnterForcedMode", () => {
  it("tool failure 触发", () => {
    const reasons = shouldEnterForcedMode(state({ lastToolSuccess: false }), cfg)
    expect(reasons).toContain("tool_failure")
  })

  it("verification pending 触发 verification_failure", () => {
    const reasons = shouldEnterForcedMode(state({ verificationPending: true }), cfg)
    expect(reasons).toContain("verification_failure")
  })

  it("checkpoint resumed 优先级最高", () => {
    const reasons = shouldEnterForcedMode(
      state({ checkpointResumedThisSession: true, lastToolSuccess: false }),
      cfg,
    )
    expect(reasons[0]).toBe("checkpoint_resumed")
  })
})

describe("shouldExitForcedMode", () => {
  it("verification pending 阻塞退出", () => {
    expect(
      shouldExitForcedMode(
        state({ verificationPending: true }),
        cfg,
        0,
        [],
      ),
    ).toBe(false)
  })

  it("recovery pending 阻塞退出", () => {
    expect(
      shouldExitForcedMode(state({ recoveryPending: true }), cfg, 0, []),
    ).toBe(false)
  })

  it("稳定且无 pending 时可退出", () => {
    expect(shouldExitForcedMode(state(), cfg, 0, [])).toBe(true)
  })
})

describe("ModeDecisionEngine", () => {
  it("adaptive 下外部硬信号进入 forced", () => {
    const engine = new ModeDecisionEngine(cfg)
    const decision = engine.evaluate(context({
      harnessMode: "adaptive",
      riskLevel: "L0_observation",
      signals: ["checkpoint_resumed", "tool_failure"],
    }))

    expect(decision).toMatchObject({
      action: "enter_forced",
      primaryReason: "checkpoint_resumed",
      enteredBy: ["checkpoint_resumed", "tool_failure"],
    })
  })

  it("adaptive + L0 不因 state 噪声 alone 升级", () => {
    const engine = new ModeDecisionEngine(cfg)
    const decision = engine.evaluate(context({
      harnessMode: "adaptive",
      riskLevel: "L0_observation",
      state: state({ pendingStepCount: cfg.pendingStepsEnterThreshold }),
    }))
    expect(decision).toEqual({ action: "keep", mode: "free" })
  })

  it("free harness 始终保持 free", () => {
    const engine = new ModeDecisionEngine(cfg)
    expect(engine.evaluate(context({
      harnessMode: "free",
      state: state({ lastToolSuccess: false, checkpointResumedThisSession: true }),
    }))).toEqual({ action: "keep", mode: "free" })
  })

  it("forced harness 始终保持 forced", () => {
    const engine = new ModeDecisionEngine(cfg)
    expect(engine.evaluate(context({ harnessMode: "forced", executionMode: "forced" }))).toEqual({
      action: "keep",
      mode: "forced",
    })
    expect(engine.evaluate(context({ harnessMode: "forced", executionMode: "free" }))).toMatchObject({
      action: "enter_forced",
    })
  })

  it("mode lock 期间保持 forced", () => {
    const engine = new ModeDecisionEngine(cfg)
    expect(engine.evaluate(context({
      executionMode: "forced",
      executionModeLockRemaining: 1,
      state: state(),
    }))).toEqual({ action: "keep", mode: "forced" })
  })

  it("满足条件后 exit_forced", () => {
    const engine = new ModeDecisionEngine(cfg)
    expect(engine.evaluate(context({
      executionMode: "forced",
      harnessMode: "adaptive",
      executionModeLockRemaining: 0,
      state: state(),
    }))).toEqual({ action: "exit_forced", reason: "stable" })
  })

  it("verification_pending 信号阻塞 exit", () => {
    const engine = new ModeDecisionEngine(cfg)
    expect(engine.evaluate(context({
      executionMode: "forced",
      harnessMode: "adaptive",
      executionModeLockRemaining: 0,
      state: state(),
      signals: ["verification_pending"],
    }))).toEqual({ action: "keep", mode: "forced" })
  })

  it("submitSignal 在 evaluate 后清空", () => {
    const engine = new ModeDecisionEngine(cfg)
    engine.submitSignal("checkpoint_engine", "checkpoint_resumed")
    expect(engine.getSubmittedSignals()).toHaveLength(1)

    expect(engine.evaluate(context())).toMatchObject({
      action: "enter_forced",
      enteredBy: ["checkpoint_resumed"],
    })
    expect(engine.getSubmittedSignals()).toHaveLength(0)
    expect(engine.evaluate(context())).toEqual({ action: "keep", mode: "free" })
  })

  it("resetSubmittedSignals 清除残留", () => {
    const engine = new ModeDecisionEngine(cfg)
    engine.submitSignal("step_gate", "tool_failure")
    engine.resetSubmittedSignals()
    expect(engine.evaluate(context())).toEqual({ action: "keep", mode: "free" })
  })

  it("evaluate 异常时 fail-safe 进入 forced", () => {
    class ThrowingEngine extends ModeDecisionEngine {
      protected override evaluateOrThrow(): never {
        throw new Error("boom")
      }
    }
    const decision = new ThrowingEngine(cfg).evaluate(context())
    expect(decision).toMatchObject({
      action: "enter_forced",
      primaryReason: "engine_fail_safe",
      failSafe: true,
    })
  })

  it("forcedMinDwell 未满足时不 exit", () => {
    const engine = new ModeDecisionEngine(cfg)
    expect(engine.evaluate(context({
      executionMode: "forced",
      harnessMode: "adaptive",
      state: state({ forcedTaskBearingRoundsSinceEntry: cfg.forcedMinDwellRounds - 1 }),
    }))).toEqual({ action: "keep", mode: "forced" })
  })

  it("G2: recovery_pending 信号触发 enter_forced", () => {
    const engine = new ModeDecisionEngine(cfg)
    engine.submitSignal("branch_budget", "recovery_pending")
    const decision = engine.evaluate(context({
      harnessMode: "adaptive",
      riskLevel: "L0_observation",
      executionMode: "free",
    }))
    expect(decision).toMatchObject({
      action: "enter_forced",
      primaryReason: "recovery_pending",
      enteredBy: ["recovery_pending"],
    })
  })

  it("G2: recovery_pending 优先级低于 verification_failure", () => {
    const engine = new ModeDecisionEngine(cfg)
    engine.submitSignal("branch_budget", "recovery_pending")
    engine.submitSignal("verification_gate", "verification_failure")
    const decision = engine.evaluate(context({
      harnessMode: "adaptive",
      riskLevel: "L0_observation",
      executionMode: "free",
    }))
    expect(decision).toMatchObject({
      action: "enter_forced",
      primaryReason: "verification_failure",
      enteredBy: ["verification_failure", "recovery_pending"],
    })
  })
})
