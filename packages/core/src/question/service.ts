/**
 * QuestionService — adapted from OpenCode (MIT License).
 * Source: packages/opencode/src/question/index.ts
 *
 * Manages pending questions, reply/reject semantics, and cleanup.
 */

import type { QuestionInfo, QuestionRequest, QuestionAnswer } from "./types.js"
import { createQuestionId } from "./id.js"

export class RejectedError extends Error {
  constructor() {
    super("The user dismissed this question")
    this.name = "RejectedError"
  }
}

export class QuestionNotFoundError extends Error {
  constructor(requestId: string) {
    super(`Question not found: ${requestId}`)
    this.name = "QuestionNotFoundError"
  }
}

interface PendingEntry {
  info: QuestionRequest
  resolve: (answers: QuestionAnswer[]) => void
  reject: (error: RejectedError) => void
}

export interface QuestionServiceInterface {
  ask(input: {
    sessionId: string
    questions: QuestionInfo[]
    tool?: { toolCallId: string; toolName: string }
    parentSessionId?: string
    /** WF-1: 外部传入的 requestId。用于 WorkflowCoordinator 让 ask_user 事件的
     * requestId 与 pending map 的 requestId 一致。不传则自动生成。 */
    requestId?: string
  }): Promise<QuestionAnswer[]>
  reply(input: { requestId: string; answers: QuestionAnswer[] }): void
  reject(requestId: string): void
  list(): QuestionRequest[]
  interrupt(): void
  shutdown(): void
}

export class QuestionService implements QuestionServiceInterface {
  private pending = new Map<string, PendingEntry>()

  async ask(input: {
    sessionId: string
    questions: QuestionInfo[]
    tool?: { toolCallId: string; toolName: string }
    parentSessionId?: string
    /** WF-1: 外部传入的 requestId，不传则自动生成 */
    requestId?: string
  }): Promise<QuestionAnswer[]> {
    const id = input.requestId ?? createQuestionId()
    const request: QuestionRequest = {
      id,
      sessionId: input.sessionId,
      questions: input.questions,
      tool: input.tool,
      parentSessionId: input.parentSessionId,
    }

    return new Promise<QuestionAnswer[]>((resolve, reject) => {
      this.pending.set(id, { info: request, resolve, reject })
      // Note: Event emission happens at Engine level, not here
    })
  }

  reply(input: { requestId: string; answers: QuestionAnswer[] }): void {
    const entry = this.pending.get(input.requestId)
    if (!entry) {
      throw new QuestionNotFoundError(input.requestId)
    }
    this.pending.delete(input.requestId)
    entry.resolve(input.answers)
  }

  reject(requestId: string): void {
    const entry = this.pending.get(requestId)
    if (!entry) {
      throw new QuestionNotFoundError(requestId)
    }
    this.pending.delete(requestId)
    entry.reject(new RejectedError())
  }

  list(): QuestionRequest[] {
    return Array.from(this.pending.values(), (x) => x.info)
  }

  interrupt(): void {
    for (const [id, entry] of this.pending) {
      entry.reject(new RejectedError())
    }
    this.pending.clear()
  }

  shutdown(): void {
    this.interrupt()
  }
}
