import { SubagentRegistry } from "../subagent/index.js"
import { QuestionService } from "../question/service.js"
import {
  createSupervisorGuidanceState,
  SupervisorBudgetTracker,
  loadSupervisorPool,
  type SupervisorGuidanceConfig,
} from "../supervisor/index.js"
import type { QuestionInfo, QuestionAnswer } from "../question/types.js"
import type { LoopEvent, ChatClient, CoreEngine } from "../interface.js"
import type { ModelTarget } from "../model-target.js"
import type { RuntimeLogger } from "../runtime-logger.js"
import { resolveModelTarget } from "../model-target.js"
import type { DeepreefConfig } from "../config.js"

export class EngineSupervisorRuntime {
  subagentRegistry = new SubagentRegistry()
  questionService = new QuestionService()
  supervisorGuidanceState = createSupervisorGuidanceState()
  emitOrchestration?: (event: LoopEvent) => void
  delegatedEvents: LoopEvent[] = []
  delegatedEventWaiters = new Set<() => void>()
  activeChildEngines = new Set<CoreEngine>()
  childClientFactory?: (target: ModelTarget, logger: RuntimeLogger) => ChatClient

  setOnOrchestrationEvent(handler: (event: LoopEvent) => void): void {
    this.emitOrchestration = handler
  }

  setChildClientFactory(factory: (target: ModelTarget, logger: RuntimeLogger) => ChatClient): void {
    this.childClientFactory = factory
  }

  enqueueDelegatedEvent(event: LoopEvent): void {
    this.delegatedEvents.push(event)
    for (const wake of this.delegatedEventWaiters) wake()
    this.delegatedEventWaiters.clear()
  }

  waitForDelegatedEvent(): { promise: Promise<void>; cancel: () => void } {
    let wake!: () => void
    const promise = new Promise<void>(resolve => { wake = resolve })
    this.delegatedEventWaiters.add(wake)
    return { promise, cancel: () => this.delegatedEventWaiters.delete(wake) }
  }

  respondQuestion(requestId: string, answers: QuestionAnswer[]): void {
    if (this.questionService.list().some(request => request.id === requestId)) {
      this.questionService.reply({ requestId, answers })
      return
    }
    for (const child of this.activeChildEngines) child.respondQuestion(requestId, answers)
  }

  rejectQuestion(requestId: string): void {
    if (this.questionService.list().some(request => request.id === requestId)) {
      this.questionService.reject(requestId)
      return
    }
    for (const child of this.activeChildEngines) child.rejectQuestion(requestId)
  }

  listPendingQuestions(): Array<{ id: string; sessionId: string; questions: QuestionInfo[] }> {
    return this.questionService.list()
  }

  async askUserFromTool(sessionId: string, questions: QuestionInfo[]): Promise<QuestionAnswer[]> {
    return this.questionService.ask({
      sessionId,
      questions,
    })
  }

  interruptQuestions(): void {
    this.questionService.interrupt()
  }

  clearDelegatedEvents(): void {
    this.delegatedEvents = []
  }

  buildSupervisorGuidanceConfig(config: DeepreefConfig): SupervisorGuidanceConfig {
    const pool = loadSupervisorPool()
    const hasEnabled = pool.candidates.some(c => c.enabled)
    return {
      pool,
      budget: new SupervisorBudgetTracker(),
      state: this.supervisorGuidanceState,
      supervisorConfigured: hasEnabled,
      resolveTarget: (targetId) => resolveModelTarget(targetId, config, config.modelTargets),
    }
  }
}
