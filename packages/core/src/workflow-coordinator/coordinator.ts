import { randomUUID } from "node:crypto"
import type {
  WorkflowPhase,
  WorkflowDecision,
  WorkflowConfig,
  WorkflowLoopState,
  WorkflowEvidence,
  WorkflowSupervisorAdvice,
  WorkflowCheckpoint,
  WorkflowEvent,
} from "./types.js"
import { DEFAULT_WORKFLOW_CONFIG } from "./types.js"
import type { DualAgentRuntime } from "../dual-agent-runtime/dual-runtime.js"
import type { QuestionService } from "../question/service.js"
import type { LoopEvent } from "../interface.js"
import { parseSupervisorDecision, parseSupervisorPlan, type BlockerAuditState } from "./structured-protocol.js"
import type { AgentCommController } from "../agent-comm/controller.js"
import type { GoalStore } from "../goal/store.js"
import type { Mailbox } from "../agent-comm/mailbox.js"
import { AgentCommController as AgentCommControllerImpl } from "../agent-comm/controller.js"
import { buildContinuationPrompt, buildBudgetLimitPrompt, buildUsageLimitPrompt } from "../goal/steering.js"

export interface StartWorkflowOptions {
  goal: string
  workflowId?: string
  maxRounds?: number
  config?: Partial<WorkflowConfig>
}

export interface WorkflowCoordinatorOptions {
  config?: Partial<WorkflowConfig>
  onEvent?: (event: WorkflowEvent) => void
  runtime?: DualAgentRuntime
  questionService?: QuestionService
  agentComm?: AgentCommController
  goalStore?: GoalStore
  mailbox?: Mailbox
  useMailboxWorkflow?: boolean
}

export class WorkflowCoordinator {
  private state: WorkflowLoopState | null = null
  private config: WorkflowConfig
  private onEvent?: (event: WorkflowEvent) => void
  private runtime?: DualAgentRuntime
  private questionService?: QuestionService
  private abortController?: AbortController
  private pendingEvents: WorkflowEvent[] = []
  private agentComm?: AgentCommController
  private goalStore?: GoalStore
  private mailbox?: Mailbox
  private useMailboxWorkflow: boolean
  private blockerAuditState: BlockerAuditState | null = null

  constructor(options: WorkflowCoordinatorOptions = {}) {
    this.config = { ...DEFAULT_WORKFLOW_CONFIG, ...options.config }
    this.onEvent = options.onEvent
    this.runtime = options.runtime
    this.questionService = options.questionService
    this.agentComm = options.agentComm
    this.goalStore = options.goalStore
    this.mailbox = options.mailbox
    this.useMailboxWorkflow = options.useMailboxWorkflow ?? false
  }

  getCurrentGoal(): ReturnType<GoalStore["getGoal"]> {
    if (!this.goalStore || !this.state) return null
    return this.goalStore.getGoal(this.state.workflowId)
  }

  getGoalStore(): GoalStore | undefined {
    return this.goalStore
  }

  getCurrentThreadId(): string {
    return this.state?.workflowId ?? ""
  }

  getCurrentAgentComm(): AgentCommController | null {
    return this.getOrCreateController()
  }

  private getOrCreateController(): AgentCommController | null {
    if (this.agentComm) return this.agentComm
    if (!this.mailbox || !this.state) return null
    const goal = this.goalStore?.getGoal(this.state.workflowId)
    return new AgentCommControllerImpl({
      threadId: this.state.workflowId,
      workflowId: this.state.workflowId,
      goalId: goal?.goalId ?? "no-goal",
      iteration: this.state.iteration,
    }, this.mailbox)
  }

  getState(): WorkflowLoopState | null {
    return this.state ? { ...this.state } : null
  }

  getConfig(): WorkflowConfig {
    return { ...this.config }
  }

  setRuntime(runtime: DualAgentRuntime): void {
    this.runtime = runtime
  }

  setQuestionService(questionService: QuestionService): void {
    this.questionService = questionService
  }

  startWorkflow(options: StartWorkflowOptions): WorkflowLoopState {
    if (this.state && this.state.currentPhase !== "completed" && this.state.currentPhase !== "failed") {
      throw new Error("Workflow already in progress")
    }

    const maxRounds = options.maxRounds ?? this.config.maxRounds
    this.pendingEvents = []

    this.state = {
      workflowId: options.workflowId ?? randomUUID(),
      iteration: 0,
      maxRounds,
      currentPhase: "idle",
      phaseHistory: [],
      ledgerVersion: 0,
      goal: options.goal,
      interventionCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.emitEvent({
      type: "phase_change",
      workflowId: this.state.workflowId,
      phase: "idle",
      iteration: 0,
      timestamp: Date.now(),
    })

    return this.getState()!
  }

  transition(to: WorkflowPhase, reason?: string): { success: boolean; error?: string } {
    if (!this.state) {
      return { success: false, error: "No workflow in progress" }
    }

    const from = this.state.currentPhase

    if (!this.isValidTransition(from, to)) {
      return { success: false, error: `Invalid transition from ${from} to ${to}` }
    }

    this.state.phaseHistory.push(from)
    this.state.currentPhase = to
    this.state.updatedAt = Date.now()

    if (to === "supervisor_analyse") {
      this.state.iteration++
      this.emitEvent({
        type: "iteration_change",
        workflowId: this.state.workflowId,
        iteration: this.state.iteration,
        timestamp: Date.now(),
      })
    }

    this.emitEvent({
      type: "phase_change",
      workflowId: this.state.workflowId,
      phase: to,
      iteration: this.state.iteration,
      reason,
      timestamp: Date.now(),
    })

    if (to === "blocked") {
      this.state.blockedReason = reason
      this.emitEvent({
        type: "blocked",
        workflowId: this.state.workflowId,
        reason,
        timestamp: Date.now(),
      })
    }

    if (to === "completed") {
      this.emitEvent({
        type: "completed",
        workflowId: this.state.workflowId,
        timestamp: Date.now(),
      })
    }

    if (to === "failed") {
      this.state.blockedReason = reason
      this.emitEvent({
        type: "failed",
        workflowId: this.state.workflowId,
        reason,
        timestamp: Date.now(),
      })
    }

    if (to === "supervisor_intervene") {
      this.state.interventionCount++
      this.emitEvent({
        type: "supervisor_intervene",
        workflowId: this.state.workflowId,
        phase: "supervisor_intervene",
        iteration: this.state.iteration,
        reason,
        adviceSummary: this.state.lastInterventionReason,
        timestamp: Date.now(),
      })
    }

    return { success: true }
  }

  getCurrentPhase(): WorkflowPhase {
    return this.state?.currentPhase ?? "idle"
  }

  setSupervisorPlan(plan: string): void {
    if (!this.state) {
      throw new Error("No workflow in progress")
    }
    this.state.supervisorPlan = plan
    this.state.updatedAt = Date.now()
  }

  setWorkerReport(report: string): void {
    if (!this.state) {
      throw new Error("No workflow in progress")
    }
    this.state.workerReport = report
    this.state.updatedAt = Date.now()
  }

  applyAdvice(advice: WorkflowSupervisorAdvice): boolean {
    if (!this.state) {
      throw new Error("No workflow in progress")
    }

    if (advice.workflowId !== this.state.workflowId) {
      return false
    }

    if (advice.iteration !== this.state.iteration) {
      return false
    }

    if (advice.stale) {
      return false
    }

    if (advice.ledgerVersion !== this.state.ledgerVersion) {
      advice.stale = true
      return false
    }

    this.state.lastDecision = advice.decision
    this.state.basedOnLedgerVersion = advice.ledgerVersion
    this.state.updatedAt = Date.now()

    if (advice.decision === "revise" && advice.revisedGoal) {
      this.state.goal = advice.revisedGoal
    }

    return true
  }

  private goalShouldContinue(): boolean {
    if (!this.goalStore) return true // no goal tracking, use legacy maxRounds
    const goal = this.goalStore.getGoal(this.state!.workflowId)
    if (!goal) return false
    return goal.status === "active"
  }

  canContinue(): boolean {
    if (!this.state) {
      return false
    }

    if (this.state.currentPhase === "completed" || this.state.currentPhase === "failed") {
      return false
    }

    if (this.state.currentPhase === "waiting_user") {
      return false
    }

    // Phase G: continuation is goal-driven when goalStore is present
    if (this.goalStore) {
      if (!this.goalShouldContinue()) return false
    }

    if (this.state.currentPhase === "supervisor_analyse") {
      return this.state.iteration <= this.state.maxRounds
    }
    return this.state.iteration < this.state.maxRounds
  }

  isFinished(): boolean {
    if (!this.state) {
      return false
    }
    return this.state.currentPhase === "completed" || this.state.currentPhase === "failed"
  }

  async *runWorkflow(): AsyncGenerator<WorkflowEvent> {
    if (!this.state) {
      throw new Error("No workflow in progress")
    }

    if (!this.runtime) {
      throw new Error("No runtime configured")
    }

    this.abortController = new AbortController()

    // A fresh workflow starts from idle. A resumed workflow has already been
    // moved from blocked to supervisor_analyse by resumeInterruptedWorkflow().
    if (this.state.currentPhase === "idle") {
      this.transition("supervisor_analyse")
    } else if (this.state.currentPhase !== "supervisor_analyse") {
      throw new Error(`Cannot run workflow from phase ${this.state.currentPhase}`)
    }
    yield* this.drainEvents()

    while (this.canContinue()) {
      if (this.abortController.signal.aborted) {
        break
      }

      const phase: WorkflowPhase = this.getCurrentPhase()

      if (phase === "supervisor_analyse") {
        yield* this.runSupervisorAnalyse()
      } else if (phase === "worker_do") {
        yield* this.runWorkerDo()
      } else if (phase === "worker_report") {
        yield* this.runWorkerReport()
      } else if (phase === "supervisor_check") {
        yield* this.runSupervisorCheck()
      } else if (phase === "supervisor_intervene") {
        yield* this.runSupervisorIntervene()
      } else if (phase === "waiting_user") {
        yield* this.runWaitingUser()
      } else {
        break
      }
      yield* this.drainEvents()
    }

    // If we exited the loop without finishing
    if (this.state && !this.isFinished()) {
      if (this.abortController?.signal.aborted) {
        this.transition("blocked", "Interrupted by user")
      } else if (this.goalStore) {
        const goal = this.goalStore.getGoal(this.state.workflowId)
        if (goal?.status === "budget_limited" || goal?.status === "usage_limited" || goal?.status === "paused") {
          this.transition("blocked", `Goal is ${goal.status}`)
        }
        // Active goal: just stop the generator, let caller decide to continue
      } else {
        this.transition("blocked", "Max rounds reached")
      }
    }
    yield* this.drainEvents()
  }

  private buildSteeringPrompt(): string {
    if (!this.goalStore || !this.state) return ""
    const goal = this.goalStore.getGoal(this.state.workflowId)
    if (!goal) return ""
    if (goal.status === "budget_limited") {
      return "\n\n" + buildBudgetLimitPrompt(goal)
    }
    if (goal.status === "usage_limited") {
      return "\n\n" + buildUsageLimitPrompt()
    }
    if (goal.status === "active") {
      return "\n\n" + buildContinuationPrompt(goal, this.state.iteration)
    }
    return ""
  }

  private async *runSupervisorAnalyse(): AsyncGenerator<WorkflowEvent> {
    const previousRound = this.state!.supervisorPlan || this.state!.workerReport || this.state!.supervisorFeedback
      ? `\n\nPrevious Plan:\n${this.state!.supervisorPlan ?? ""}\n\nPrevious Worker Report:\n${this.state!.workerReport ?? ""}\n\nYour Previous Review:\n${this.state!.supervisorFeedback ?? ""}`
      : ""
    const resumeInstruction = this.state!.resumeInstruction
      ? `\n\nUser instruction for this workflow:\n${this.state!.resumeInstruction}`
      : ""
    const steering = this.buildSteeringPrompt()
    const supervisorInput = `Analyse the following goal and create a plan for iteration ${this.state!.iteration}:\n\nGoal: ${this.state!.goal}${previousRound}${resumeInstruction}${steering}\n\nProvide an updated structured plan with concrete next steps, constraints, and risks. Incorporate the previous Worker report, review, and user instruction when present.`

    let errorMessage = ""
    for await (const event of this.runtime!.getSupervisor().submit(supervisorInput, "loop", "supervisor_analyse")) {
      yield event as any
      if (event.role === "error") errorMessage = event.content ?? "Supervisor analysis failed"
    }

    const supervisorState = this.runtime!.getSupervisor().getState()
    const plan = supervisorState.messages.findLast(m => m.role === "assistant")?.content?.trim() ?? ""

    // Phase 3: tool errors do not block Worker if a valid plan was produced.
    // Only block when both error and no plan, or when requireSupervisorPlan
    // is set and plan is genuinely empty.
    if (!plan) {
      this.transition("blocked", errorMessage || "Supervisor did not produce a plan")
      return
    }
    this.setSupervisorPlan(plan)
    this.state!.resumeInstruction = undefined

    // Mailbox workflow path is retained but disabled by default. The active
    // loop path passes plan/report through coordinator state.
    if (this.useMailboxWorkflow) {
      const ctrl = this.getOrCreateController()
      if (ctrl) {
        ctrl.followupTask("supervisor", plan)
      }
    }

    this.transition("worker_do")
  }

  private async *runWorkerDo(): AsyncGenerator<WorkflowEvent> {
    let taskContent = ""
    if (this.useMailboxWorkflow) {
      const ctrl = this.getOrCreateController()
      if (ctrl) {
        const pendingTasks = ctrl.readMailbox({ to: "worker", unreadOnly: true, limit: 1 })
        if (pendingTasks.length > 0) {
          taskContent = pendingTasks[0].content
          ctrl.markRead(pendingTasks[0].id)
        }
      }
    }

    const planContent = taskContent || this.state!.supervisorPlan || ""
    const workerInput = `Execute the following plan for iteration ${this.state!.iteration}:\n\n${planContent}\n\nGoal: ${this.state!.goal}${this.state!.supervisorFeedback ? `\n\nSupervisor feedback from the previous iteration:\n${this.state!.supervisorFeedback}` : ""}`

    let hasError = false
    let errorCount = 0

    for await (const event of this.runtime!.getWorker().submit(workerInput, "loop", "worker_do")) {
      yield event as any
      if (event.role === "error") {
        hasError = true
        errorCount++
      }
    }

    // Check if Supervisor intervention is needed
    // Trigger intervention on repeated errors or explicit request
    if (hasError && errorCount >= 2 && this.state!.iteration < this.state!.maxRounds) {
      this.state!.lastInterventionReason = `Worker encountered ${errorCount} errors during execution`
      this.transition("supervisor_intervene")
      return
    }

    this.transition("worker_report")
  }

  private async *runWorkerReport(): AsyncGenerator<WorkflowEvent> {
    const workerInput = "Generate a summary report of what was accomplished."

    for await (const event of this.runtime!.getWorker().submit(workerInput, "loop", "worker_report")) {
      yield event as any
    }

    const workerState = this.runtime!.getWorker().getState()
    const report = workerState.messages.findLast(m => m.role === "assistant")?.content ?? ""
    this.setWorkerReport(report)

    if (this.useMailboxWorkflow) {
      const ctrl = this.getOrCreateController()
      if (ctrl) {
        ctrl.sendMessage("worker", "supervisor", "report", report)
      }
    }

    this.transition("supervisor_check")
  }

  private async *runSupervisorCheck(): AsyncGenerator<WorkflowEvent> {
    let reportedContent = this.state!.workerReport ?? ""
    if (this.useMailboxWorkflow) {
      const ctrl = this.getOrCreateController()
      if (ctrl) {
        const pendingReports = ctrl.readMailbox({ to: "supervisor", unreadOnly: true, limit: 1 })
        if (pendingReports.length > 0) {
          reportedContent = pendingReports[0].content
          ctrl.markRead(pendingReports[0].id)
        }
      }
    }

    const steering = this.buildSteeringPrompt()
    const supervisorInput = `Review the following worker report and decide next action:\n\nPlan: ${this.state!.supervisorPlan ?? ""}\n\nReport: ${reportedContent}${steering}\n\nDecide: continue, revise, approve, ask_user, or blocked`

    for await (const event of this.runtime!.getSupervisor().submit(supervisorInput, "loop", "supervisor_check")) {
      yield event as any
    }

    const supervisorState = this.runtime!.getSupervisor().getState()
    const response = supervisorState.messages.findLast(m => m.role === "assistant")?.content ?? ""

    // Try structured protocol first
    const parsed = parseSupervisorDecision(response)
    let decision: WorkflowDecision
    let confidence: "high" | "low" = "high"

    if (parsed && parsed.confidence === "high") {
      decision = parsed.decision.decision
      this.state!.supervisorDecision = parsed.decision
    } else {
      // Fallback to legacy string matching
      decision = this.parseDecision(response)
      confidence = "low"
      this.emitEvent({
        type: "low_confidence_decision",
        workflowId: this.state!.workflowId,
        decision,
        iteration: this.state!.iteration,
        timestamp: Date.now(),
      })
    }

    this.state!.lastDecision = decision
    this.state!.supervisorFeedback = response
    this.state!.updatedAt = Date.now()

    // Phase F: enforce audit gates
    if (decision === "approve") {
      // Require structured completionAudit
      if (confidence === "low") {
        // Legacy approve cannot complete
        decision = "continue"
      } else if (parsed?.decision.completionAudit && parsed.decision.completionAudit.length > 0) {
        const allProven = parsed.decision.completionAudit.every(
          a => a.status === "proven" || a.status === "not_applicable"
        )
        const allHaveEvidence = parsed.decision.completionAudit
          .filter(a => a.status === "proven")
          .every(a => a.evidence.length > 0)
        if (allProven && allHaveEvidence) {
          if (this.goalStore) {
            try {
              this.goalStore.updateGoal(this.state!.workflowId, { status: "complete" })
            } catch { /* non-blocking */}
          }
          this.transition("completed")
        } else {
          decision = "continue"
        }
      } else {
        decision = "continue"
      }
      if (decision === "continue") {
        this.transition("supervisor_analyse")
      }
    } else if (decision === "ask_user") {
      const question = this.extractQuestion(response)
      yield* this.handleAskUser(question)
    } else if (decision === "blocked") {
      // Require 3+ consecutive same blocker via runtime audit
      let canBlock = false
      if (confidence === "high" && parsed?.decision.blockerAudit) {
        const ba = parsed.decision.blockerAudit
        if (ba && !ba.canMakeProgress) {
          const normalized = ba.blocker.toLowerCase().trim()
          if (this.blockerAuditState && this.blockerAuditState.normalizedBlocker === normalized) {
            this.blockerAuditState.consecutiveTurns++
            this.blockerAuditState.lastSeenAt = Date.now()
          } else {
            this.blockerAuditState = {
              normalizedBlocker: normalized,
              consecutiveTurns: 1,
              firstSeenAt: Date.now(),
              lastSeenAt: Date.now(),
            }
          }
          if (this.blockerAuditState.consecutiveTurns >= 3) {
            canBlock = true
          }
        } else if (ba && ba.canMakeProgress) {
          this.blockerAuditState = null
        }
      } else {
        // Legacy blocked: mark as continue
        decision = "continue"
      }
      if (canBlock) {
        if (this.goalStore) {
          try {
            this.goalStore.updateGoal(this.state!.workflowId, { status: "blocked" })
          } catch { /* non-blocking */}
        }
        this.transition("blocked", response)
      } else {
        // Keep blockerAuditState across rounds for accumulation
        decision = "continue"
        this.transition("supervisor_analyse")
      }
    } else if (this.state!.iteration >= this.state!.maxRounds) {
      this.transition("blocked", "Max rounds reached")
    } else {
      this.transition("supervisor_analyse")
    }
  }

  /**
   * 中途 Supervisor 干预 — 当 Worker 执行失败或需要指导时触发。
   * 与正式 supervisor_check 的区别：
   * - supervisor_check 在 WorkerReport 后执行，做出正式决策（approve/revise/continue）
   * - supervisor_intervene 在 WorkerDo 期间触发，提供中途指导（不决定是否完成）
   */
  private async *runSupervisorIntervene(): AsyncGenerator<WorkflowEvent> {
    if (!this.state) {
      return
    }

    const reason = this.state.lastInterventionReason ?? "Worker needs guidance"
    const workerState = this.runtime!.getWorker().getState()
    const recentMessages = workerState.messages.slice(-5)
    const contextSummary = recentMessages.map(m => `${m.role}: ${m.content?.slice(0, 200) ?? ""}`).join("\n")

    const supervisorInput = `The Worker is struggling and needs mid-workflow guidance.

Goal: ${this.state.goal}
Current Plan: ${this.state.supervisorPlan ?? "No plan yet"}
Intervention Reason: ${reason}

Recent Worker Context:
${contextSummary}

Provide brief guidance. Do NOT decide to approve or complete the workflow.
Return your guidance as structured advice.`

    for await (const event of this.runtime!.getSupervisor().submit(supervisorInput, "loop", "supervisor_intervene")) {
      yield event as any
    }

    const supervisorState = this.runtime!.getSupervisor().getState()
    const guidance = supervisorState.messages.findLast(m => m.role === "assistant")?.content ?? ""

    // Emit mid-workflow intervention event (distinct from formal supervisor_check decision)
    this.emitEvent({
      type: "supervisor_intervene",
      workflowId: this.state.workflowId,
      phase: "supervisor_intervene",
      iteration: this.state.iteration,
      adviceSummary: guidance.slice(0, 500),
      reason,
      timestamp: Date.now(),
    })

    this.state.interventionCount++
    this.state.lastInterventionReason = undefined
    this.state.updatedAt = Date.now()

    // After intervention, return to worker_do with the guidance
    this.transition("worker_do")
  }

  private async *runWaitingUser(): AsyncGenerator<WorkflowEvent> {
    if (!this.state || !this.questionService) {
      return
    }

    const requestId = this.state.waitingUserRequestId
    if (!requestId) {
      return
    }

    try {
      await this.questionService.ask({
        sessionId: this.state.workflowId,
        questions: [{
          question: this.state.waitingUserQuestion ?? "User input needed",
          header: "Workflow needs input",
          options: [],
        }],
      })

      this.transition("supervisor_analyse")
    } catch {
      this.transition("blocked", "User rejected question")
    }
  }

  private async *handleAskUser(question: string): AsyncGenerator<WorkflowEvent> {
    if (!this.state || !this.questionService) {
      return
    }

    const requestId = randomUUID()
    this.state.waitingUserRequestId = requestId
    this.state.waitingUserQuestion = question
    this.state.updatedAt = Date.now()

    this.emitEvent({
      type: "ask_user",
      workflowId: this.state.workflowId,
      requestId,
      question,
      timestamp: Date.now(),
    })

    this.transition("waiting_user")
  }

  private parseDecision(response: string): WorkflowDecision {
    const lower = response.toLowerCase()
    if (lower.includes("approve") || lower.includes("completed")) return "approve"
    if (lower.includes("ask_user") || lower.includes("ask user")) return "ask_user"
    if (lower.includes("blocked") || lower.includes("cannot continue")) return "blocked"
    if (lower.includes("revise")) return "revise"
    return "continue"
  }

  private extractQuestion(response: string): string {
    const questionMatch = response.match(/question[:\s]*(.+)/i)
    return questionMatch?.[1]?.trim() ?? "Supervisor needs user input"
  }

  saveCheckpoint(): WorkflowCheckpoint {
    if (!this.state) {
      throw new Error("No workflow in progress")
    }

    return {
      workflowId: this.state.workflowId,
      state: { ...this.state },
      savedAt: Date.now(),
    }
  }

  restoreCheckpoint(checkpoint: WorkflowCheckpoint): void {
    this.state = { ...checkpoint.state }
    this.state.updatedAt = Date.now()
  }

  reset(): void {
    this.state = null
    this.pendingEvents = []
    this.abortController?.abort()
    this.abortController = undefined
  }

  interrupt(): void {
    this.abortController?.abort()
  }

  addUserInstruction(instruction: string): WorkflowLoopState {
    if (!this.state) {
      throw new Error("No workflow in progress")
    }
    const trimmed = instruction.trim()
    if (!trimmed) {
      return this.getState()!
    }
    this.state.resumeInstruction = this.state.resumeInstruction
      ? `${this.state.resumeInstruction}\n\n${trimmed}`
      : trimmed
    this.state.updatedAt = Date.now()
    return this.getState()!
  }

  resumeInterruptedWorkflow(instruction: string): WorkflowLoopState {
    if (!this.state) {
      throw new Error("No workflow in progress")
    }
    if (this.state.currentPhase !== "blocked" || this.state.blockedReason !== "Interrupted by user") {
      throw new Error("Only a workflow interrupted by the user can be resumed")
    }

    this.pendingEvents = []
    this.state.resumeInstruction = instruction
    this.state.blockedReason = undefined
    // The interrupted iteration never completed, so retry it instead of
    // consuming another round from the workflow budget.
    this.state.iteration = Math.max(0, this.state.iteration - 1)
    const result = this.transition("supervisor_analyse")
    if (!result.success) {
      throw new Error(result.error)
    }
    return this.getState()!
  }

  private isValidTransition(from: WorkflowPhase, to: WorkflowPhase): boolean {
    const validTransitions: Record<WorkflowPhase, WorkflowPhase[]> = {
      idle: ["supervisor_analyse", "blocked", "completed", "failed"],
      supervisor_analyse: ["worker_do", "waiting_user", "blocked", "completed", "failed"],
      worker_do: ["worker_report", "supervisor_intervene", "waiting_user", "blocked", "completed", "failed"],
      worker_report: ["supervisor_check", "blocked", "completed", "failed"],
      supervisor_check: ["supervisor_analyse", "worker_do", "completed", "waiting_user", "blocked", "failed"],
      supervisor_intervene: ["worker_do", "supervisor_check", "waiting_user", "blocked", "completed", "failed"],
      waiting_user: ["supervisor_analyse", "worker_do", "blocked", "completed", "failed"],
      blocked: ["supervisor_analyse", "completed", "failed"],
      completed: [],
      failed: [],
    }

    return validTransitions[from]?.includes(to) ?? false
  }

  private emitEvent(event: WorkflowEvent): void {
    this.pendingEvents.push(event)
    if (this.onEvent) {
      this.onEvent(event)
    }
  }

  private *drainEvents(): Generator<WorkflowEvent> {
    while (this.pendingEvents.length > 0) {
      yield this.pendingEvents.shift()!
    }
  }
}
