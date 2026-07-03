import { describe, it, expect, vi, beforeEach } from "vitest"
import { WorkflowCoordinator } from "../src/workflow-coordinator/coordinator.js"
import type { WorkflowSupervisorAdvice } from "../src/workflow-coordinator/types.js"
import { QuestionService } from "../src/question/service.js"

import { setPromptLocale } from "../src/prompt-locale.js"
describe("WorkflowCoordinator", () => {
  beforeEach(() => setPromptLocale("en"));
  it("resumes a user-interrupted workflow with the user's instruction", async () => {
    const supervisorInputs: string[] = []
    let supervisorMessage = ""
    let supervisorCalls = 0
    let coordinator: WorkflowCoordinator
    const runtime = {
      getSupervisor: () => ({
        submit: async function* (input: string) {
          supervisorInputs.push(input)
          supervisorCalls++
          supervisorMessage = supervisorCalls === 1 ? "Initial plan" : supervisorCalls === 2 ? "Resumed plan" : JSON.stringify({
            version: 1,
            workflowId: "wf-1",
            iteration: 1,
            basedOnLedgerVersion: 0,
            decision: "approve",
            diagnosis: "done",
            nextActions: [],
            constraints: [],
            verification: [],
            completionAudit: [{ requirement: "fix interrupt recovery", status: "proven", evidence: ["completed"] }],
          })
          yield { role: "assistant_final", content: supervisorMessage }
          if (supervisorCalls === 1) coordinator.interrupt()
        },
        getState: () => ({ messages: [{ role: "assistant", content: supervisorMessage }] }),
      }),
      getWorker: () => ({
        submit: async function* () {
          yield { role: "assistant_final", content: "done" }
        },
        getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
      }),
    }

    coordinator = new WorkflowCoordinator({ runtime: runtime as any })
    coordinator.startWorkflow({ goal: "fix interrupt recovery" })
    for await (const _event of coordinator.runWorkflow()) { /* consume */ }

    expect(coordinator.getState()?.currentPhase).toBe("blocked")
    expect(coordinator.getState()?.blockedReason).toBe("Interrupted by user")

    coordinator.resumeInterruptedWorkflow("continue from the latest state")
    for await (const _event of coordinator.runWorkflow()) { /* consume */ }

    expect(supervisorInputs[1]).toContain("User instruction for this workflow:\ncontinue from the latest state")
    expect(supervisorInputs[1]).toContain("Previous Plan:\nInitial plan")
    expect(coordinator.getState()?.iteration).toBe(1)
    expect(coordinator.getState()?.currentPhase).toBe("completed")
  })

  it("does not resume a workflow blocked for a non-interrupt reason", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "test" })
    coordinator.transition("blocked", "Max rounds reached")

    expect(() => coordinator.resumeInterruptedWorkflow("continue")).toThrow(
      "Only a workflow interrupted by the user can be resumed",
    )
  })

  it("carries user instructions added during a running workflow into Supervisor analysis", async () => {
    const supervisorInputs: string[] = []
    let supervisorCalls = 0
    let supervisorMessage = ""
    const runtime = {
      getSupervisor: () => ({
        submit: async function* (input: string) {
          supervisorInputs.push(input)
          supervisorCalls++
          supervisorMessage = supervisorCalls === 1 ? "Plan with updated user instruction" : JSON.stringify({
            version: 1,
            workflowId: "wf-1",
            iteration: 1,
            basedOnLedgerVersion: 0,
            decision: "approve",
            diagnosis: "done",
            nextActions: [],
            constraints: [],
            verification: [],
            completionAudit: [{ requirement: "handle user instruction", status: "proven", evidence: ["instruction applied"] }],
          })
          yield { role: "assistant_final", content: supervisorMessage }
        },
        getState: () => ({ messages: [{ role: "assistant", content: supervisorMessage }] }),
      }),
      getWorker: () => ({
        submit: async function* () {
          yield { role: "assistant_final", content: "done" }
        },
        getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
      }),
    }

    const coordinator = new WorkflowCoordinator({ runtime: runtime as any })
    coordinator.startWorkflow({ goal: "test" })
    coordinator.addUserInstruction("change the goal emphasis and report current status")
    for await (const _event of coordinator.runWorkflow()) { /* consume */ }

    expect(supervisorInputs[0]).toContain("User instruction for this workflow:\nchange the goal emphasis and report current status")
  })

  it("carries Supervisor review into a real second workflow iteration", async () => {
    const supervisorInputs: string[] = []
    const workerInputs: string[] = []
    let supervisorCalls = 0
    let workerCalls = 0
    let supervisorMessage = ""
    let workerMessage = ""
    const workerEngine = {
      setThinkingMode: vi.fn(),
      updateConfig: vi.fn(),
      setHarnessStrictness: vi.fn(),
    }

    const runtime = {
      getSupervisor: () => ({
        submit: async function* (input: string) {
          supervisorInputs.push(input)
          supervisorCalls++
          supervisorMessage = supervisorCalls === 1
            ? "Plan iteration one"
            : supervisorCalls === 2
              ? "continue: inspect the remaining rendering path"
              : supervisorCalls === 3
                ? "Plan iteration two using the previous report"
                : JSON.stringify({
                    version: 1,
                    workflowId: "wf-1",
                    iteration: 2,
                    basedOnLedgerVersion: 0,
                    decision: "approve",
                    diagnosis: "done",
                    nextActions: [],
                    constraints: [],
                    verification: [],
                    completionAudit: [{ requirement: "fix rendering", status: "proven", evidence: ["tests pass"] }],
                  })
          yield { role: "assistant_final", content: supervisorMessage }
        },
        getState: () => ({ messages: [{ role: "assistant", content: supervisorMessage }] }),
      }),
      getWorker: () => ({
        submit: async function* (input: string) {
          workerInputs.push(input)
          workerCalls++
          workerMessage = workerCalls % 2 === 0
            ? `Report ${workerCalls / 2}`
            : `Work ${Math.ceil(workerCalls / 2)}`
          yield { role: "assistant_final", content: workerMessage }
        },
        getState: () => ({ messages: [{ role: "assistant", content: workerMessage }] }),
      }),
    }

    const coordinator = new WorkflowCoordinator({ runtime: runtime as any, config: { maxRounds: 3 } })
    coordinator.startWorkflow({ goal: "fix rendering" })
    for await (const _event of coordinator.runWorkflow()) { /* consume */ }

    expect(coordinator.getState()?.currentPhase).toBe("completed")
    expect(coordinator.getState()?.iteration).toBe(2)
    expect(supervisorInputs[2]).toContain("iteration 2")
    expect(supervisorInputs[2]).toContain("Previous Worker Report:\nReport 1")
    expect(supervisorInputs[2]).toContain("Your Previous Review:\ncontinue: inspect the remaining rendering path")
    expect(workerInputs[2]).toContain("Plan iteration two using the previous report")
    expect(workerInputs[2]).toContain("Supervisor feedback from the previous iteration")
  })

  it("scores Worker reports and carries score adjustments into the next Worker iteration", async () => {
    const workerInputs: string[] = []
    const emittedEvents: any[] = []
    let supervisorCalls = 0
    let workerCalls = 0
    let supervisorMessage = ""
    let workerMessage = ""
    const workerEngine = {
      setThinkingMode: vi.fn(),
      updateConfig: vi.fn(),
      setHarnessStrictness: vi.fn(),
    }

    const firstWorkerReport = JSON.stringify({
      version: 1,
      workflowId: "wf-score",
      iteration: 1,
      basedOnLedgerVersion: 0,
      summary: "Only read the files; tests were not run.",
      completedSteps: ["read files"],
      changedFiles: [],
      verification: { passed: false, commands: [], summary: "not run" },
      blockers: ["missing verification"],
      requestsSupervisor: false,
    })
    const secondWorkerReport = JSON.stringify({
      version: 1,
      workflowId: "wf-score",
      iteration: 2,
      basedOnLedgerVersion: 0,
      summary: "Implemented and verified.",
      completedSteps: ["implement", "run tests"],
      changedFiles: ["src/app.ts"],
      verification: { passed: true, commands: ["bun test"], summary: "passed" },
      blockers: [],
      requestsSupervisor: false,
    })

    const runtime = {
      getConfig: () => ({
        workerModelTarget: "worker:test",
        supervisorModelTarget: "supervisor:test",
      }),
      getSupervisor: () => ({
        submit: async function* () {
          supervisorCalls++
          supervisorMessage = supervisorCalls === 1
            ? JSON.stringify({
                version: 1,
                workflowId: "wf-score",
                iteration: 1,
                goal: "fix scoring",
                summary: "Initial plan",
                steps: [{ id: "read", description: "read files" }, { id: "test", description: "run tests" }],
                constraints: [],
                risks: [],
              })
            : supervisorCalls === 2
              ? JSON.stringify({
                  version: 1,
                  workflowId: "wf-score",
                  iteration: 1,
                  basedOnLedgerVersion: 0,
                  decision: "continue",
                  diagnosis: "Verification missing",
                  nextActions: ["run tests"],
                  constraints: [],
                  verification: ["bun test"],
                  workerAssessment: {
                    summary: "Worker skipped verification.",
                    completed: false,
                    verificationPassed: false,
                    dimensions: {
                      taskCompletion: 45,
                      verification: 20,
                      communication: 40,
                    },
                    promptStrategies: [{ kind: "require_verification", rationale: "Tests were not run." }],
                  },
                })
              : supervisorCalls === 3
                ? JSON.stringify({
                    version: 1,
                    workflowId: "wf-score",
                    iteration: 2,
                    goal: "fix scoring",
                    summary: "Second plan",
                    steps: [{ id: "implement", description: "implement" }, { id: "test", description: "run tests" }],
                    constraints: [],
                    risks: [],
                  })
                : JSON.stringify({
                    version: 1,
                    workflowId: "wf-score",
                    iteration: 2,
                    basedOnLedgerVersion: 0,
                    decision: "approve",
                    diagnosis: "done",
                    nextActions: [],
                    constraints: [],
                    verification: ["bun test"],
                    completionAudit: [{ requirement: "fix scoring", status: "proven", evidence: ["bun test passed"] }],
                    workerAssessment: {
                      summary: "Worker completed and verified.",
                      completed: true,
                      verificationPassed: true,
                    },
                  })
          yield { role: "assistant_final", content: supervisorMessage }
        },
        getState: () => ({ messages: [{ role: "assistant", content: supervisorMessage }] }),
      }),
      getWorker: () => ({
        submit: async function* (input: string, _mode: string, phase: string) {
          workerInputs.push(input)
          workerCalls++
          workerMessage = phase === "worker_report"
            ? (workerCalls <= 2 ? firstWorkerReport : secondWorkerReport)
            : "working"
          yield { role: "assistant_final", content: workerMessage }
        },
        getState: () => ({
          messages: [{ role: "assistant", content: workerMessage }],
          stats: { toolCalls: 4 },
        }),
        getEngine: () => workerEngine,
      }),
    }

    const coordinator = new WorkflowCoordinator({
      runtime: runtime as any,
      config: { maxRounds: 3 },
      onEvent: event => emittedEvents.push(event),
    })
    coordinator.startWorkflow({ goal: "fix scoring", workflowId: "wf-score" })

    for await (const _event of coordinator.runWorkflow()) { /* consume */ }

    const scoreEvents = emittedEvents.filter(event => event.type === "run_score")
    const adjustmentEvents = emittedEvents.filter(event => event.type === "runtime_adjustment")
    expect(scoreEvents).toHaveLength(2)
    expect(adjustmentEvents).toHaveLength(2)
    expect(scoreEvents[0].score.overallScore).toBeLessThan(70)
    expect(coordinator.getState()?.lastRunScore?.evidence.summary).toContain("completed and verified")
    expect(coordinator.getState()?.lastRuntimeAdjustment?.recommendedHarness).toBeDefined()
    expect(workerEngine.setThinkingMode).toHaveBeenCalledWith("high")
    expect(workerEngine.updateConfig).toHaveBeenCalledWith({ maxTokens: 4096 })
    expect(workerEngine.setHarnessStrictness).toHaveBeenCalledWith("strict")
    expect(workerInputs[2]).toContain("Worker strategy adjustment from the previous run score")
    expect(workerInputs[2]).toContain("require_verification")
    expect(workerInputs[2]).toContain("Weakest dimensions")
  })

  it("blocks at max rounds without emitting a phantom next iteration", async () => {
    let supervisorMessage = ""
    let workerMessage = ""
    let supervisorCalls = 0
    const runtime = {
      getSupervisor: () => ({
        submit: async function* () {
          supervisorCalls++
          supervisorMessage = supervisorCalls === 1 ? "Plan one" : "continue"
          yield { role: "assistant_final", content: supervisorMessage }
        },
        getState: () => ({ messages: [{ role: "assistant", content: supervisorMessage }] }),
      }),
      getWorker: () => ({
        submit: async function* () {
          workerMessage = "done"
          yield { role: "assistant_final", content: workerMessage }
        },
        getState: () => ({ messages: [{ role: "assistant", content: workerMessage }] }),
      }),
    }
    const coordinator = new WorkflowCoordinator({ runtime: runtime as any, config: { maxRounds: 1 } })
    coordinator.startWorkflow({ goal: "test" })
    const events: any[] = []
    for await (const event of coordinator.runWorkflow()) events.push(event)

    expect(coordinator.getState()?.iteration).toBe(1)
    expect(coordinator.getState()?.blockedReason).toBe("Max rounds reached")
    expect(events.some(event => event.type === "iteration_change" && event.iteration === 2)).toBe(false)
  })

  it("yields phase events before role output so consumers can label each role", async () => {
    const roleEvent = { role: "assistant_final", content: "plan" } as const
    const runtime = {
      getSupervisor: () => ({
        submit: async function* () { yield roleEvent },
        getState: () => ({ messages: [{ role: "assistant", content: "approve" }] }),
      }),
      getWorker: () => ({
        submit: async function* () { yield { role: "assistant_final", content: "done" } },
        getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
      }),
    }
    const coordinator = new WorkflowCoordinator({ runtime: runtime as any })
    coordinator.startWorkflow({ goal: "test" })

    const events: any[] = []
    for await (const event of coordinator.runWorkflow()) events.push(event)

    const supervisorPhase = events.findIndex(event => event.type === "phase_change" && event.phase === "supervisor_analyse")
    const supervisorOutput = events.findIndex(event => event.role === "assistant_final" && event.content === "plan")
    const workerPhase = events.findIndex(event => event.type === "phase_change" && event.phase === "worker_do")
    const workerOutput = events.findIndex(event => event.role === "assistant_final" && event.content === "done")

    expect(supervisorPhase).toBeGreaterThanOrEqual(0)
    expect(supervisorOutput).toBeGreaterThan(supervisorPhase)
    expect(workerPhase).toBeGreaterThan(supervisorOutput)
    expect(workerOutput).toBeGreaterThan(workerPhase)
  })

  it("blocks instead of starting Worker when Supervisor analysis fails", async () => {
    let workerCalls = 0
    const runtime = {
      getSupervisor: () => ({
        submit: async function* () { yield { role: "error", content: "HTTP 400" } },
        getState: () => ({ messages: [] }),
      }),
      getWorker: () => ({
        submit: async function* () { workerCalls++ },
        getState: () => ({ messages: [] }),
      }),
    }
    const coordinator = new WorkflowCoordinator({ runtime: runtime as any })
    coordinator.startWorkflow({ goal: "test" })

    const events: any[] = []
    for await (const event of coordinator.runWorkflow()) events.push(event)

    expect(workerCalls).toBe(0)
    expect(coordinator.getState()?.currentPhase).toBe("blocked")
    expect(events).toContainEqual(expect.objectContaining({ type: "blocked", reason: "HTTP 400" }))
  })

  it("blocks instead of starting Worker when Supervisor returns no plan", async () => {
    let workerCalls = 0
    const runtime = {
      getSupervisor: () => ({
        submit: async function* () { yield { role: "done" } },
        getState: () => ({ messages: [{ role: "assistant", content: "" }] }),
      }),
      getWorker: () => ({
        submit: async function* () { workerCalls++ },
        getState: () => ({ messages: [] }),
      }),
    }
    const coordinator = new WorkflowCoordinator({ runtime: runtime as any })
    coordinator.startWorkflow({ goal: "test" })

    for await (const _event of coordinator.runWorkflow()) { /* consume */ }

    expect(workerCalls).toBe(0)
    expect(coordinator.getState()?.blockedReason).toBe("Supervisor did not produce a plan")
  })

  it("should create coordinator with default config", () => {
    const coordinator = new WorkflowCoordinator()
    const config = coordinator.getConfig()

    expect(config.maxRounds).toBe(9)
    expect(config.requireSupervisorPlan).toBe(true)
    expect(config.requireVerificationGate).toBe(true)
  })

  it("should create coordinator with custom config", () => {
    const coordinator = new WorkflowCoordinator({
      config: { maxRounds: 5, requireSupervisorPlan: false },
    })
    const config = coordinator.getConfig()

    expect(config.maxRounds).toBe(5)
    expect(config.requireSupervisorPlan).toBe(false)
    expect(config.requireVerificationGate).toBe(true)
  })

  it("should start workflow", () => {
    const coordinator = new WorkflowCoordinator()
    const state = coordinator.startWorkflow({ goal: "Fix all bugs" })

    expect(state.workflowId).toBeDefined()
    expect(state.goal).toBe("Fix all bugs")
    expect(state.iteration).toBe(0)
    expect(state.currentPhase).toBe("idle")
    expect(state.maxRounds).toBe(9)
  })

  it("should not start workflow if already in progress", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "Fix all bugs" })

    expect(() => coordinator.startWorkflow({ goal: "New goal" })).toThrow("Workflow already in progress")
  })

  it("should transition between phases", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "Fix all bugs" })

    coordinator.transition("supervisor_analyse")
    expect(coordinator.getState()?.currentPhase).toBe("supervisor_analyse")
    expect(coordinator.getState()?.iteration).toBe(1)

    coordinator.transition("worker_do")
    expect(coordinator.getState()?.currentPhase).toBe("worker_do")
    expect(coordinator.getState()?.iteration).toBe(1)

    coordinator.transition("worker_report")
    expect(coordinator.getState()?.currentPhase).toBe("worker_report")

    coordinator.transition("supervisor_check")
    expect(coordinator.getState()?.currentPhase).toBe("supervisor_check")
  })

  it("should track phase history", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "Fix all bugs" })

    coordinator.transition("supervisor_analyse")
    coordinator.transition("worker_do")
    coordinator.transition("worker_report")

    const state = coordinator.getState()
    expect(state?.phaseHistory).toEqual(["idle", "supervisor_analyse", "worker_do"])
  })

  it("should set supervisor plan", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "Fix all bugs" })

    coordinator.setSupervisorPlan("1. Analyze code\n2. Fix bugs\n3. Test")
    expect(coordinator.getState()?.supervisorPlan).toBe("1. Analyze code\n2. Fix bugs\n3. Test")
  })

  it("should set worker report", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "Fix all bugs" })

    coordinator.setWorkerReport("Fixed 5 bugs, all tests pass")
    expect(coordinator.getState()?.workerReport).toBe("Fixed 5 bugs, all tests pass")
  })

  it("should apply valid advice", () => {
    const coordinator = new WorkflowCoordinator()
    const state = coordinator.startWorkflow({ goal: "Fix all bugs" })

    coordinator.transition("supervisor_analyse")

    const advice: WorkflowSupervisorAdvice = {
      workflowId: state.workflowId,
      iteration: 1,
      ledgerVersion: 0,
      decision: "continue",
      feedback: "Good progress",
      timestamp: Date.now(),
      stale: false,
    }

    const applied = coordinator.applyAdvice(advice)
    expect(applied).toBe(true)
    expect(coordinator.getState()?.lastDecision).toBe("continue")
  })

  it("should reject advice with wrong workflowId", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "Fix all bugs" })
    coordinator.transition("supervisor_analyse")

    const advice: WorkflowSupervisorAdvice = {
      workflowId: "wrong-id",
      iteration: 1,
      ledgerVersion: 0,
      decision: "continue",
      timestamp: Date.now(),
      stale: false,
    }

    const applied = coordinator.applyAdvice(advice)
    expect(applied).toBe(false)
  })

  it("should reject advice with wrong iteration", () => {
    const coordinator = new WorkflowCoordinator()
    const state = coordinator.startWorkflow({ goal: "Fix all bugs" })
    coordinator.transition("supervisor_analyse")

    const advice: WorkflowSupervisorAdvice = {
      workflowId: state.workflowId,
      iteration: 2,
      ledgerVersion: 0,
      decision: "continue",
      timestamp: Date.now(),
      stale: false,
    }

    const applied = coordinator.applyAdvice(advice)
    expect(applied).toBe(false)
  })

  it("should reject stale advice", () => {
    const coordinator = new WorkflowCoordinator()
    const state = coordinator.startWorkflow({ goal: "Fix all bugs" })
    coordinator.transition("supervisor_analyse")

    const advice: WorkflowSupervisorAdvice = {
      workflowId: state.workflowId,
      iteration: 1,
      ledgerVersion: 0,
      decision: "continue",
      timestamp: Date.now(),
      stale: true,
    }

    const applied = coordinator.applyAdvice(advice)
    expect(applied).toBe(false)
  })

  it("should mark advice as stale if ledgerVersion mismatch", () => {
    const coordinator = new WorkflowCoordinator()
    const state = coordinator.startWorkflow({ goal: "Fix all bugs" })
    coordinator.transition("supervisor_analyse")

    const advice: WorkflowSupervisorAdvice = {
      workflowId: state.workflowId,
      iteration: 1,
      ledgerVersion: 5,
      decision: "continue",
      timestamp: Date.now(),
      stale: false,
    }

    const applied = coordinator.applyAdvice(advice)
    expect(applied).toBe(false)
    expect(advice.stale).toBe(true)
  })

  it("should apply revise advice and update goal", () => {
    const coordinator = new WorkflowCoordinator()
    const state = coordinator.startWorkflow({ goal: "Fix all bugs" })
    coordinator.transition("supervisor_analyse")

    const advice: WorkflowSupervisorAdvice = {
      workflowId: state.workflowId,
      iteration: 1,
      ledgerVersion: 0,
      decision: "revise",
      revisedGoal: "Fix critical bugs only",
      timestamp: Date.now(),
      stale: false,
    }

    const applied = coordinator.applyAdvice(advice)
    expect(applied).toBe(true)
    expect(coordinator.getState()?.goal).toBe("Fix critical bugs only")
  })

  it("should check if workflow can continue", () => {
    const coordinator = new WorkflowCoordinator({ config: { maxRounds: 2 } })
    coordinator.startWorkflow({ goal: "Fix all bugs" })

    expect(coordinator.canContinue()).toBe(true)

    coordinator.transition("supervisor_analyse")
    coordinator.transition("worker_do")
    coordinator.transition("worker_report")
    coordinator.transition("supervisor_check")

    coordinator.transition("supervisor_analyse")
    coordinator.transition("worker_do")
    coordinator.transition("worker_report")
    coordinator.transition("supervisor_check")

    expect(coordinator.canContinue()).toBe(false)
  })

  it("should check if workflow is finished", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "Fix all bugs" })

    expect(coordinator.isFinished()).toBe(false)

    coordinator.transition("completed")
    expect(coordinator.isFinished()).toBe(true)
  })

  it("should save and restore checkpoint", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "Fix all bugs" })
    coordinator.transition("supervisor_analyse")
    coordinator.setSupervisorPlan("Test plan")

    const checkpoint = coordinator.saveCheckpoint()
    expect(checkpoint.state.goal).toBe("Fix all bugs")
    expect(checkpoint.state.currentPhase).toBe("supervisor_analyse")
    expect(checkpoint.state.supervisorPlan).toBe("Test plan")

    const newCoordinator = new WorkflowCoordinator()
    newCoordinator.restoreCheckpoint(checkpoint)

    expect(newCoordinator.getState()?.goal).toBe("Fix all bugs")
    expect(newCoordinator.getState()?.currentPhase).toBe("supervisor_analyse")
    expect(newCoordinator.getState()?.supervisorPlan).toBe("Test plan")
  })

  it("should reset workflow", () => {
    const coordinator = new WorkflowCoordinator()
    coordinator.startWorkflow({ goal: "Fix all bugs" })
    coordinator.transition("supervisor_analyse")

    coordinator.reset()
    expect(coordinator.getState()).toBeNull()
  })

  it("should emit events", () => {
    const events: any[] = []
    const coordinator = new WorkflowCoordinator({
      onEvent: (event) => events.push(event),
    })

    coordinator.startWorkflow({ goal: "Fix all bugs" })
    coordinator.transition("supervisor_analyse")
    coordinator.transition("worker_do")

    expect(events).toHaveLength(4)
    expect(events[0].type).toBe("phase_change")
    expect(events[0].phase).toBe("idle")
    expect(events[1].type).toBe("iteration_change")
    expect(events[1].iteration).toBe(1)
    expect(events[2].type).toBe("phase_change")
    expect(events[2].phase).toBe("supervisor_analyse")
    expect(events[3].type).toBe("phase_change")
    expect(events[3].phase).toBe("worker_do")
  })

  it("should emit blocked event", () => {
    const events: any[] = []
    const coordinator = new WorkflowCoordinator({
      onEvent: (event) => events.push(event),
    })

    coordinator.startWorkflow({ goal: "Fix all bugs" })
    coordinator.transition("blocked", "Max rounds reached")

    const blockedEvent = events.find((e) => e.type === "blocked")
    expect(blockedEvent).toBeDefined()
    expect(blockedEvent.reason).toBe("Max rounds reached")
  })

  describe("parseDecision legacy behavior", () => {
    it('"approve" or "completed" in text → approve', () => {
      const coordinator = new WorkflowCoordinator()
      // Access private parseDecision via reflection for testing
      const parse = (coordinator as any).parseDecision.bind(coordinator)
      expect(parse("I approve this work")).toBe("approve")
      expect(parse("All tasks completed")).toBe("approve")
      expect(parse("The goal is completed and approved")).toBe("approve")
    })

    it('"ask_user" or "ask user" → ask_user', () => {
      const parse = (new WorkflowCoordinator() as any).parseDecision.bind(new WorkflowCoordinator())
      expect(parse("ask_user for clarification")).toBe("ask_user")
      expect(parse("I need to ask user about this")).toBe("ask_user")
    })

    it('"blocked" or "cannot continue" → blocked', () => {
      const parse = (new WorkflowCoordinator() as any).parseDecision.bind(new WorkflowCoordinator())
      expect(parse("Workflow blocked")).toBe("blocked")
      expect(parse("We cannot continue due to an issue")).toBe("blocked")
    })

    it('"revise" → revise', () => {
      const parse = (new WorkflowCoordinator() as any).parseDecision.bind(new WorkflowCoordinator())
      expect(parse("revise the approach")).toBe("revise")
    })

    it("fallback to continue for unknown text", () => {
      const parse = (new WorkflowCoordinator() as any).parseDecision.bind(new WorkflowCoordinator())
      expect(parse("keep going with the current plan")).toBe("continue")
      expect(parse("random text")).toBe("continue")
    })
  })

  it("should not transition if no workflow in progress", () => {
    const coordinator = new WorkflowCoordinator()
    const result = coordinator.transition("supervisor_analyse")
    expect(result.success).toBe(false)
    expect(result.error).toBe("No workflow in progress")
  })

  describe("coordinator state + goal integration", () => {
    it("does not write plan to mailbox by default", async () => {
      const { AgentCommController } = await import("../src/agent-comm/controller.js")
      const { Mailbox } = await import("../src/agent-comm/mailbox.js")
      const { rmSync, mkdirSync, existsSync } = await import("node:fs")
      const { resolve } = await import("node:path")
      const testDir = resolve(process.cwd(), ".covalo-test-coord-mailbox")
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
      mkdirSync(testDir, { recursive: true })

      const mailbox = new Mailbox(testDir)
      const agentComm = new AgentCommController({
        threadId: "test-thread",
        goalId: "test-goal",
        workflowId: "test-wf",
        iteration: 1,
      }, mailbox)

      const runtime = {
        getSupervisor: () => ({
          submit: async function* () { yield { role: "assistant_final", content: "Supervisor plan here" } },
          getState: () => ({ messages: [{ role: "assistant", content: "Supervisor plan here" }] }),
        }),
        getWorker: () => ({
          submit: async function* () { yield { role: "assistant_final", content: "done" } },
          getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
        }),
      }

      const coordinator = new WorkflowCoordinator({
        runtime: runtime as any,
        agentComm: agentComm as any,
        config: { requireSupervisorPlan: false },
      })
      coordinator.startWorkflow({ goal: "test", workflowId: "test-wf" })
      for await (const _event of coordinator.runWorkflow()) { /* consume */ }

      const messages = mailbox.read({ threadId: "test-thread" })
      const supervisorTasks = messages.filter(m => m.from === "supervisor" && m.to === "worker")
      expect(supervisorTasks).toHaveLength(0)

      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    })

    it("passes supervisorPlan directly to worker_do instead of reading mailbox by default", async () => {
      const { AgentCommController } = await import("../src/agent-comm/controller.js")
      const { Mailbox } = await import("../src/agent-comm/mailbox.js")
      const { rmSync, mkdirSync, existsSync } = await import("node:fs")
      const { resolve } = await import("node:path")
      const testDir = resolve(process.cwd(), ".covalo-test-coord-mailbox2")
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
      mkdirSync(testDir, { recursive: true })

      const mailbox = new Mailbox(testDir)
      const agentComm = new AgentCommController({
        threadId: "test-thread",
        goalId: "test-goal",
        workflowId: "test-wf",
        iteration: 1,
      }, mailbox)

      // Pre-write a task to the mailbox (simulating what supervisor_analyse would do)
      mailbox.send({
        threadId: "test-thread", goalId: "test-goal", workflowId: "test-wf",
        iteration: 1, from: "supervisor", to: "worker",
        kind: "task", delivery: "trigger_turn",
        content: "Mailbox task content",
      })

      const workerInputs: string[] = []
      const runtime = {
        getSupervisor: () => ({
          submit: async function* () { yield { role: "assistant_final", content: "Direct plan" } },
          getState: () => ({ messages: [{ role: "assistant", content: "Direct plan" }] }),
        }),
        getWorker: () => ({
          submit: async function* (input: string) {
            workerInputs.push(input)
            yield { role: "assistant_final", content: "done" }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
        }),
      }

      const coordinator = new WorkflowCoordinator({
        runtime: runtime as any,
        agentComm: agentComm as any,
        config: { requireSupervisorPlan: false },
      })
      coordinator.startWorkflow({ goal: "test", workflowId: "test-wf" })

      for await (const _event of coordinator.runWorkflow()) { /* consume */ }

      // The worker input should contain the coordinator plan, not stale mailbox content.
      const hasMailboxContent = workerInputs.some(i => i.includes("Mailbox task content"))
      const hasDirectPlan = workerInputs.some(i => i.includes("Direct plan"))
      expect(hasMailboxContent).toBe(false)
      expect(hasDirectPlan).toBe(true)

      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    })

    it("updates goal to complete on approve", async () => {
      const { GoalStore } = await import("../src/goal/store.js")
      const { rmSync, mkdirSync, existsSync } = await import("node:fs")
      const { resolve } = await import("node:path")
      const { randomUUID } = await import("node:crypto")
      const testDir = resolve(process.cwd(), ".covalo-test-coord-goal")
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
      mkdirSync(testDir, { recursive: true })

      const goalStore = new GoalStore(testDir)
      const threadId = randomUUID()
      goalStore.createGoal(threadId, "Test goal")

      const approveJson = JSON.stringify({
        version: 1,
        workflowId: threadId,
        iteration: 1,
        basedOnLedgerVersion: 0,
        decision: "approve",
        diagnosis: "All tasks completed",
        nextActions: [],
        constraints: [],
        verification: [],
        completionAudit: [{ requirement: "Test goal", status: "proven", evidence: ["completed"] }],
      })
      const runtime = {
        getSupervisor: () => ({
          submit: async function* () { yield { role: "assistant_final", content: approveJson } },
          getState: () => ({ messages: [{ role: "assistant", content: approveJson }] }),
        }),
        getWorker: () => ({
          submit: async function* () { yield { role: "assistant_final", content: "done" } },
          getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
        }),
      }

      const coordinator = new WorkflowCoordinator({
        runtime: runtime as any,
        goalStore,
        config: { requireSupervisorPlan: false },
      })
      coordinator.startWorkflow({ goal: "Test goal", workflowId: threadId })
      for await (const _event of coordinator.runWorkflow()) { /* consume */ }

      const goal = goalStore.getGoal(threadId)
      expect(goal?.status).toBe("complete")

      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    })
  })

  describe("supervisor_intervene 中途干预", () => {
    it("should transition to supervisor_intervene from worker_do", () => {
      const coordinator = new WorkflowCoordinator()
      coordinator.startWorkflow({ goal: "Fix all bugs" })

      coordinator.transition("supervisor_analyse")
      coordinator.transition("worker_do")

      const result = coordinator.transition("supervisor_intervene")
      expect(result.success).toBe(true)
      expect(coordinator.getState()?.currentPhase).toBe("supervisor_intervene")
    })

    it("should emit supervisor_intervene event", () => {
      const events: any[] = []
      const coordinator = new WorkflowCoordinator({
        onEvent: (event) => events.push(event),
      })

      coordinator.startWorkflow({ goal: "Fix all bugs" })
      coordinator.transition("supervisor_analyse")
      coordinator.transition("worker_do")
      coordinator.transition("supervisor_intervene")

      const interveneEvent = events.find((e) => e.type === "supervisor_intervene")
      expect(interveneEvent).toBeDefined()
      expect(interveneEvent.workflowId).toBeDefined()
    })

    it("should transition from supervisor_intervene back to worker_do", () => {
      const coordinator = new WorkflowCoordinator()
      coordinator.startWorkflow({ goal: "Fix all bugs" })

      coordinator.transition("supervisor_analyse")
      coordinator.transition("worker_do")
      coordinator.transition("supervisor_intervene")

      const result = coordinator.transition("worker_do")
      expect(result.success).toBe(true)
      expect(coordinator.getState()?.currentPhase).toBe("worker_do")
    })

    it("should transition from supervisor_intervene to supervisor_check", () => {
      const coordinator = new WorkflowCoordinator()
      coordinator.startWorkflow({ goal: "Fix all bugs" })

      coordinator.transition("supervisor_analyse")
      coordinator.transition("worker_do")
      coordinator.transition("supervisor_intervene")

      const result = coordinator.transition("supervisor_check")
      expect(result.success).toBe(true)
      expect(coordinator.getState()?.currentPhase).toBe("supervisor_check")
    })

    it("should track intervention count", () => {
      const coordinator = new WorkflowCoordinator()
      coordinator.startWorkflow({ goal: "Fix all bugs" })

      coordinator.transition("supervisor_analyse")
      coordinator.transition("worker_do")
      coordinator.transition("supervisor_intervene")
      coordinator.transition("worker_do")
      coordinator.transition("supervisor_intervene")

      expect(coordinator.getState()?.interventionCount).toBe(2)
    })

    it("should not transition to supervisor_intervene from supervisor_check", () => {
      const coordinator = new WorkflowCoordinator()
      coordinator.startWorkflow({ goal: "Fix all bugs" })

      coordinator.transition("supervisor_analyse")
      coordinator.transition("worker_do")
      coordinator.transition("worker_report")
      coordinator.transition("supervisor_check")

      const result = coordinator.transition("supervisor_intervene")
      expect(result.success).toBe(false)
    })
  })

  describe("Phase 1: Loop 完整 4 阶段推进回归测试", () => {
    it("完整推进 supervisor_analyse → worker_do → worker_report → supervisor_check", async () => {
      const phases: string[] = []
      const supervisorInputs: string[] = []
      const workerInputs: string[] = []
      let supervisorMessages: string[] = []

      const runtime = {
        getSupervisor: () => ({
          submit: async function* (input: string) {
            supervisorInputs.push(input)
            const content = supervisorInputs.length === 1
              ? "Plan: fix all bugs"
              : JSON.stringify({
                  version: 1, workflowId: "wf-1", iteration: 1,
                  basedOnLedgerVersion: 0, decision: "approve",
                  diagnosis: "done", nextActions: [], constraints: [],
                  verification: [],
                  completionAudit: [{ requirement: "fix bugs", status: "proven", evidence: ["tests pass"] }],
                })
            supervisorMessages.push(content)
            yield { role: "assistant_final", content }
          },
          getState: () => ({ messages: [{ role: "assistant", content: supervisorMessages[supervisorMessages.length - 1] ?? "" }] }),
        }),
        getWorker: () => ({
          submit: async function* (input: string) {
            workerInputs.push(input)
            yield { role: "assistant_final", content: "worker done" }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "worker done" }] }),
        }),
      }

      const coordinator = new WorkflowCoordinator({ runtime: runtime as any, config: { requireSupervisorPlan: false } })
      coordinator.startWorkflow({ goal: "fix bugs" })

      for await (const event of coordinator.runWorkflow()) {
        if (event.type === "phase_change") phases.push(event.phase)
      }

      // Verify full 4-phase progression
      expect(phases).toContain("supervisor_analyse")
      expect(phases).toContain("worker_do")
      expect(phases).toContain("worker_report")
      expect(phases).toContain("supervisor_check")
      expect(coordinator.getState()?.currentPhase).toBe("completed")

      // Worker inputs come from coordinator state, not mailbox
      expect(workerInputs[0]).toContain("Plan: fix all bugs")
    })

    it("Worker report 写入 state.workerReport 并被 Supervisor check 读取", async () => {
      const supervisorInputs: string[] = []
      let supervisorCalls = 0

      const runtime = {
        getSupervisor: () => ({
          submit: async function* (input: string) {
            supervisorInputs.push(input)
            supervisorCalls++
            const content = supervisorCalls === 1
              ? "Plan: refactor"
              : JSON.stringify({
                  version: 1, workflowId: "wf-1", iteration: 1,
                  basedOnLedgerVersion: 0, decision: "continue",
                  diagnosis: "more work needed", nextActions: [], constraints: [],
                  verification: [],
                })
            yield { role: "assistant_final", content }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "review done" }] }),
        }),
        getWorker: () => ({
          submit: async function* (input: string) {
            yield { role: "assistant_final", content: "Refactored all modules, tests pass" }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "Refactored all modules, tests pass" }] }),
        }),
      }

      const coordinator = new WorkflowCoordinator({ runtime: runtime as any, config: { requireSupervisorPlan: false } })
      coordinator.startWorkflow({ goal: "refactor" })
      for await (const _event of coordinator.runWorkflow()) { /* consume */ }

      // state.workerReport must be set
      const state = coordinator.getState()
      expect(state?.workerReport).toBe("Refactored all modules, tests pass")

      // Supervisor check input must contain the worker report
      const checkInput = supervisorInputs[1]
      expect(checkInput).toContain("Refactored all modules, tests pass")
      expect(checkInput).toContain("Report: Refactored all modules, tests pass")
    })

    it("workflowId === sessionId 时 goal/coordinator 使用同一 ID", async () => {
      const { rmSync, mkdirSync, existsSync } = await import("node:fs")
      const { resolve } = await import("node:path")
      const { GoalStore } = await import("../src/goal/store.js")
      const { randomUUID } = await import("node:crypto")

      const testDir = resolve(process.cwd(), ".covalo-test-regression-wfid")
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
      mkdirSync(testDir, { recursive: true })

      const goalStore = new GoalStore(testDir)
      const sessionId = "session-loop-001"
      goalStore.createGoal(sessionId, "loop regression test")

      const coordinator = new WorkflowCoordinator({ goalStore })
      coordinator.startWorkflow({ goal: "loop regression test", workflowId: sessionId })

      const state = coordinator.getState()
      expect(state?.workflowId).toBe(sessionId)

      const goal = goalStore.getGoal(sessionId)
      expect(goal).not.toBeNull()
      expect(goal!.objective).toBe("loop regression test")

      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    })

    it("mailbox 消息不污染默认 loop 主路径", async () => {
      const { Mailbox } = await import("../src/agent-comm/mailbox.js")
      const { AgentCommController } = await import("../src/agent-comm/controller.js")
      const { rmSync, mkdirSync, existsSync } = await import("node:fs")
      const { resolve } = await import("node:path")

      const testDir = resolve(process.cwd(), ".covalo-test-regression-mailbox")
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
      mkdirSync(testDir, { recursive: true })

      const mailbox = new Mailbox(testDir)
      const agentComm = new AgentCommController({
        threadId: "test-thread", goalId: "test-goal", workflowId: "test-wf", iteration: 1,
      }, mailbox)

      // Write stale mailbox content
      mailbox.send({
        threadId: "test-thread", goalId: "test-goal", workflowId: "test-wf",
        iteration: 1, from: "supervisor", to: "worker",
        kind: "task", delivery: "trigger_turn",
        content: "STALE MAILBOX TASK",
      })

      const workerInputs: string[] = []
      const runtime = {
        getSupervisor: () => ({
          submit: async function* () { yield { role: "assistant_final", content: "Direct coordinator plan" } },
          getState: () => ({ messages: [{ role: "assistant", content: "Direct coordinator plan" }] }),
        }),
        getWorker: () => ({
          submit: async function* (input: string) {
            workerInputs.push(input)
            yield { role: "assistant_final", content: "done" }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
        }),
      }

      const coordinator = new WorkflowCoordinator({
        runtime: runtime as any, agentComm: agentComm as any,
        config: { requireSupervisorPlan: false },
      })
      coordinator.startWorkflow({ goal: "test", workflowId: "test-wf" })
      for await (const _event of coordinator.runWorkflow()) { /* consume */ }

      // Default path uses coordinator state, not mailbox
      const hasStale = workerInputs.some(i => i.includes("STALE MAILBOX TASK"))
      expect(hasStale).toBe(false)

      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true })
    })

    it("Supervisor 工具错误时如有非空 plan 不阻断 Worker", async () => {
      let workerCalls = 0
      let supervisorInputCount = 0
      let supervisorContent = "Valid plan despite tool error"
      const runtime = {
        getSupervisor: () => ({
          submit: async function* (input: string) {
            supervisorInputCount++
            if (supervisorInputCount === 1) {
              yield { role: "error", content: "tool_not_allowed: send_message" }
              yield { role: "assistant_final", content: "Valid plan despite tool error" }
            } else {
              supervisorContent = JSON.stringify({
                version: 1, workflowId: "wf-1", iteration: 1,
                basedOnLedgerVersion: 0, decision: "approve",
                diagnosis: "done", nextActions: [], constraints: [],
                verification: [],
                completionAudit: [{ requirement: "fix bugs", status: "proven", evidence: ["done"] }],
              })
              yield { role: "assistant_final", content: supervisorContent }
            }
          },
          getState: () => ({ messages: [{ role: "assistant", content: supervisorContent }] }),
        }),
        getWorker: () => ({
          submit: async function* () {
            workerCalls++
            yield { role: "assistant_final", content: "done" }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
        }),
      }

      const coordinator = new WorkflowCoordinator({ runtime: runtime as any, config: { requireSupervisorPlan: false } })
      coordinator.startWorkflow({ goal: "test" })
      for await (const _event of coordinator.runWorkflow()) { /* consume */ }

      expect(workerCalls).toBeGreaterThanOrEqual(1)
      expect(coordinator.getState()?.currentPhase).toBe("completed")
    })
  })

  it("passes the correct workflowPhase to each submit call in the main loop path", async () => {
    const phases: Array<string | undefined> = []
    const runtime = {
      getSupervisor: () => ({
        submit: async function* (_input: string, _mode?: string, phase?: string) {
          phases.push(phase)
          yield { role: "assistant_final", content: "plan" }
        },
        getState: () => ({ messages: [{ role: "assistant", content: "plan" }] }),
      }),
      getWorker: () => ({
        submit: async function* (_input: string, _mode?: string, phase?: string) {
          phases.push(phase)
          yield { role: "assistant_final", content: "done" }
        },
        getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
      }),
    }

    phases.length = 0
    const coordinator = new WorkflowCoordinator({ runtime: runtime as any, config: { requireSupervisorPlan: false } })
    coordinator.startWorkflow({ goal: "test" })
    for await (const _event of coordinator.runWorkflow()) { /* consume */ }

    expect(phases).toContain("supervisor_analyse")
    expect(phases).toContain("worker_do")
    expect(phases).toContain("worker_report")
    expect(phases).toContain("supervisor_check")
  })

  describe("WF-1: ask_user 回复链集成", () => {
    it("supervisor_check ask_user → waiting_user → pending question → replyWorkflowQuestion → supervisor_analyse", async () => {
      // 审核反馈：原 canContinue() 对 waiting_user 返回 false，导致
      // runWaitingUser() 进不去，pending question 永远不会创建。
      // 修正后 waiting_user 可进入 runWaitingUser()，await ask() 创建 pending。
      const questionService = new QuestionService()
      let supervisorCalls = 0
      let workerCalls = 0
      const runtime = {
        getSupervisor: () => ({
          submit: async function* (_input: string, _mode?: string, phase?: string) {
            supervisorCalls++
            // 第 1 次：supervisor_analyse → 返回 plan
            // 第 2 次：supervisor_check → 返回 ask_user（legacy string，触发 ask_user 分支）
            // 第 3 次：supervisor_analyse（reply 后推进）→ 返回 approve with completionAudit
            let content: string
            if (phase === "supervisor_analyse" && supervisorCalls === 1) {
              content = "Initial plan"
            } else if (phase === "supervisor_check") {
              content = "I need to ask_user for clarification about the requirement"
            } else {
              content = JSON.stringify({
                version: 1,
                workflowId: "wf-ask-user",
                iteration: 1,
                basedOnLedgerVersion: 0,
                decision: "approve",
                diagnosis: "done",
                nextActions: [],
                constraints: [],
                verification: [],
                completionAudit: [{ requirement: "ask_user 闭环", status: "proven", evidence: ["user replied"] }],
              })
            }
            yield { role: "assistant_final", content }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "stub" }] }),
        }),
        getWorker: () => ({
          submit: async function* () {
            workerCalls++
            yield { role: "assistant_final", content: "done" }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
        }),
      }

      const coordinator = new WorkflowCoordinator({
        runtime: runtime as any,
        questionService,
        config: { requireSupervisorPlan: false, requireVerificationGate: false, maxRounds: 5 },
      })
      coordinator.startWorkflow({ goal: "test ask_user 闭环" })

      // 异步消费 workflow，模拟 TUI 在收到 ask_user 事件后回复
      const events: any[] = []
      const workflowPromise = (async () => {
        for await (const event of coordinator.runWorkflow()) {
          events.push(event)
          // 收到 ask_user 事件后，异步回复（模拟用户点击 UI）
          if (event.type === "ask_user" && event.requestId) {
            const requestId = event.requestId
            // 给 runWaitingUser 一点时间调 questionService.ask() 创建 pending
            setTimeout(() => {
              coordinator.replyWorkflowQuestion(requestId, [["yes"]])
            }, 10)
          }
        }
      })()

      await workflowPromise

      // 验证：workflow 完成（不是 blocked）
      const finalState = coordinator.getState()
      expect(finalState?.currentPhase).toBe("completed")

      // 验证：ask_user 事件被 emit，且 requestId 不为空
      const askUserEvent = events.find(e => e.type === "ask_user")
      expect(askUserEvent).toBeDefined()
      expect(askUserEvent.requestId).toBeTruthy()

      // 验证：worker 至少执行过一次
      expect(workerCalls).toBeGreaterThanOrEqual(1)
    })

    it("WF-1: rejectWorkflowQuestion → blocked", async () => {
      const questionService = new QuestionService()
      const runtime = {
        getSupervisor: () => ({
          submit: async function* (_input: string, _mode?: string, phase?: string) {
            if (phase === "supervisor_check") {
              yield { role: "assistant_final", content: "ask_user for clarification" }
            } else {
              yield { role: "assistant_final", content: "plan" }
            }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "stub" }] }),
        }),
        getWorker: () => ({
          submit: async function* () {
            yield { role: "assistant_final", content: "done" }
          },
          getState: () => ({ messages: [{ role: "assistant", content: "done" }] }),
        }),
      }

      const coordinator = new WorkflowCoordinator({
        runtime: runtime as any,
        questionService,
        config: { requireSupervisorPlan: false, requireVerificationGate: false, maxRounds: 5 },
      })
      coordinator.startWorkflow({ goal: "test reject" })

      const events: any[] = []
      const workflowPromise = (async () => {
        for await (const event of coordinator.runWorkflow()) {
          events.push(event)
          if (event.type === "ask_user" && event.requestId) {
            const requestId = event.requestId
            setTimeout(() => {
              coordinator.rejectWorkflowQuestion(requestId)
            }, 10)
          }
        }
      })()

      await workflowPromise

      // 验证：reject 后 workflow 进入 blocked（不是 completed）
      const finalState = coordinator.getState()
      expect(finalState?.currentPhase).toBe("blocked")
      expect(finalState?.blockedReason).toContain("User rejected")
    })
  })
})
