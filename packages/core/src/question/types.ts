/**
 * Question types — adapted from OpenCode (MIT License).
 * Source: packages/opencode/src/question/index.ts
 */

import type { QuestionOption, QuestionInfo, QuestionAnswer } from "@covalo/protocol"
export type { QuestionOption, QuestionInfo, QuestionAnswer }

export interface QuestionRequest {
  id: string
  sessionId: string
  questions: QuestionInfo[]
  tool?: { toolCallId: string; toolName: string }
  parentSessionId?: string
}

export interface QuestionReply {
  requestId: string
  answers: QuestionAnswer[]
}

export interface QuestionReject {
  requestId: string
}
