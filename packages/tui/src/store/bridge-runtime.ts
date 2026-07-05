import type { QuestionRequest } from '@covalo/core';
import type { TuiPermissionPrompt } from '../bridge.js';
import { SubscribeStore } from './subscribe-store.js';

export interface TokenUsage {
  input: number;
  output: number;
  cacheHit: number;
  cacheMiss: number;
}

export interface StatusUsageState {
  isLoading: boolean;
  tokens: TokenUsage;
  contextUsage: number;
  reasoningActive: boolean;
}

export interface PromptQueueState {
  messageQueue: string[];
  pendingInstructionCount: number;
}

export interface PermissionQuestionState {
  /** SPEC S0-1: 含 originRole，用于定向 respondPermissionForRequest() */
  permissionPrompt: TuiPermissionPrompt | null;
  questionPrompt: QuestionRequest | null;
}

export interface BridgeFeedbackState {
  warnings: string[];
  error: string | null;
}

export function createInitialStatusUsage(): StatusUsageState {
  return {
    isLoading: false,
    tokens: { input: 0, output: 0, cacheHit: 0, cacheMiss: 0 },
    contextUsage: 0,
    reasoningActive: false,
  };
}

export function createInitialPromptQueue(): PromptQueueState {
  return {
    messageQueue: [],
    pendingInstructionCount: 0,
  };
}

export function createInitialPermissionQuestion(): PermissionQuestionState {
  return {
    permissionPrompt: null,
    questionPrompt: null,
  };
}

export function createInitialBridgeFeedback(): BridgeFeedbackState {
  return {
    warnings: [],
    error: null,
  };
}

/**
 * 拆分后的 bridge 运行时状态（阶段 3）。
 */
export class BridgeRuntime {
  readonly statusUsage = new SubscribeStore<StatusUsageState>(createInitialStatusUsage());
  readonly promptQueue = new SubscribeStore<PromptQueueState>(createInitialPromptQueue());
  readonly permissionQuestion = new SubscribeStore<PermissionQuestionState>(createInitialPermissionQuestion());
  readonly feedback = new SubscribeStore<BridgeFeedbackState>(createInitialBridgeFeedback());

  /**
   * 将 bridge 局部 patch 写入对应子 store。
   */
  applyPatch(patch: {
    isLoading?: boolean;
    messageQueue?: string[];
    pendingInstructionCount?: number;
    tokens?: TokenUsage;
    contextUsage?: number;
    warnings?: string[];
    error?: string | null;
    /** SPEC S0-1: 含 originRole 的 TuiPermissionPrompt */
    permissionPrompt?: TuiPermissionPrompt | null;
    questionPrompt?: QuestionRequest | null;
    reasoningActive?: boolean;
  }): void {
    const statusPatch: Partial<StatusUsageState> = {};
    if (patch.isLoading !== undefined) statusPatch.isLoading = patch.isLoading;
    if (patch.tokens !== undefined) statusPatch.tokens = patch.tokens;
    if (patch.contextUsage !== undefined) statusPatch.contextUsage = patch.contextUsage;
    if (patch.reasoningActive !== undefined) statusPatch.reasoningActive = patch.reasoningActive;
    if (Object.keys(statusPatch).length > 0) {
      this.statusUsage.patch(statusPatch);
    }

    const queuePatch: Partial<PromptQueueState> = {};
    if (patch.messageQueue !== undefined) queuePatch.messageQueue = patch.messageQueue;
    if (patch.pendingInstructionCount !== undefined) {
      queuePatch.pendingInstructionCount = patch.pendingInstructionCount;
    }
    if (Object.keys(queuePatch).length > 0) {
      this.promptQueue.patch(queuePatch);
    }

    const permissionPatch: Partial<PermissionQuestionState> = {};
    if (patch.permissionPrompt !== undefined) permissionPatch.permissionPrompt = patch.permissionPrompt;
    if (patch.questionPrompt !== undefined) permissionPatch.questionPrompt = patch.questionPrompt;
    if (Object.keys(permissionPatch).length > 0) {
      this.permissionQuestion.patch(permissionPatch);
    }

    const feedbackPatch: Partial<BridgeFeedbackState> = {};
    if (patch.warnings !== undefined) feedbackPatch.warnings = patch.warnings;
    if (patch.error !== undefined) feedbackPatch.error = patch.error;
    if (Object.keys(feedbackPatch).length > 0) {
      this.feedback.patch(feedbackPatch);
    }
  }

  /**
   * @returns 轻量队列规模指标
   */
  getStats(): { warningsLength: number; messageQueueLength: number } {
    return {
      warningsLength: this.feedback.getSnapshot().warnings.length,
      messageQueueLength: this.promptQueue.getSnapshot().messageQueue.length,
    };
  }

  /**
   * 重置为初始状态（session 切换等）。
   */
  reset(): void {
    this.statusUsage.replace(createInitialStatusUsage());
    this.promptQueue.replace(createInitialPromptQueue());
    this.permissionQuestion.replace(createInitialPermissionQuestion());
    this.feedback.replace(createInitialBridgeFeedback());
  }
}
