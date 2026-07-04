import React from 'react';
import { Box, Text } from '@covalo/ink';
import type { QuestionRequest } from '@covalo/core';
import type { TuiPermissionPrompt, PermissionOriginRole } from './bridge.js';
import { DeepiPromptInput, type DeepiPromptInputHandle } from './DeepiPromptInput.js';
import { StatusBar } from './StatusBar.js';
import { PermissionPrompt } from './PermissionPrompt.js';
import { QuestionPrompt } from './QuestionPrompt.js';
import { TONE } from './reasonix/tokens.js';
import {
  useBridgeFeedback,
  usePermissionQuestion,
  usePromptQueue,
  useStatusUsage,
} from './store/BridgeRuntimeContext.js';
import { isBridgeRuntimeSplitEnabled } from './store/feature.js';
import { useOrchestrationLoop } from './components/orchestration/OrchestrationContext.js';

interface BridgeStatusBarProps {
  model: string;
  provider: string;
  agent: string;
  contextTotal: number;
  thinkingMode?: string;
  statusMessage?: string | null;
  cwd?: string;
  /** Legacy 路径由 App 传入 */
  legacy?: {
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens: number;
    cacheMissTokens: number;
    contextUsed: number;
    pendingInstructionCount?: number;
    reasoningActive?: boolean;
  };
}

/**
 * 状态栏：拆分模式下仅订阅 status / queue 相关 slice。
 */
export function BridgeStatusBar({
  model,
  provider,
  agent,
  contextTotal,
  thinkingMode,
  statusMessage,
  cwd,
  legacy,
}: BridgeStatusBarProps): React.ReactElement {
  const status = useStatusUsage();
  const queue = usePromptQueue();
  const split = isBridgeRuntimeSplitEnabled();
  // 编排 loop 轮次（保留自原 OrchestrationSummary 面板）。BridgeStatusBar 渲染在
  // OrchestrationStoreProvider 内部，故可在此安全订阅。
  const loop = useOrchestrationLoop();

  return (
    <StatusBar
      model={model}
      provider={provider}
      agent={agent}
      inputTokens={split ? status.tokens.input : legacy?.inputTokens ?? 0}
      outputTokens={split ? status.tokens.output : legacy?.outputTokens ?? 0}
      cacheHitTokens={split ? status.tokens.cacheHit : legacy?.cacheHitTokens ?? 0}
      cacheMissTokens={split ? status.tokens.cacheMiss : legacy?.cacheMissTokens ?? 0}
      contextUsed={split ? status.contextUsage : legacy?.contextUsed ?? 0}
      contextTotal={contextTotal}
      pendingInstructionCount={split ? queue.pendingInstructionCount : legacy?.pendingInstructionCount}
      statusMessage={statusMessage}
      thinkingMode={thinkingMode}
      reasoningActive={split ? status.reasoningActive : legacy?.reasoningActive}
      cwd={cwd}
      loopAttempt={loop.attempt}
    />
  );
}

type BridgeDeepiPromptInputProps = Omit<
  React.ComponentProps<typeof DeepiPromptInput>,
  'isLoading' | 'disabled' | 'queueCount'
> & {
  legacy?: {
    isLoading: boolean;
    disabled: boolean;
    queueCount: number;
  };
};

/**
 * 输入框：拆分模式下仅订阅 loading / queue / permission slice。
 */
export const BridgeDeepiPromptInput = React.forwardRef<DeepiPromptInputHandle, BridgeDeepiPromptInputProps>(
  function BridgeDeepiPromptInput({ legacy, ...props }, ref) {
    const status = useStatusUsage();
    const queue = usePromptQueue();
    const permission = usePermissionQuestion();
    const split = isBridgeRuntimeSplitEnabled();

    return (
      <DeepiPromptInput
        ref={ref}
        {...props}
        isLoading={split ? status.isLoading : legacy?.isLoading ?? false}
        disabled={split
          ? Boolean(permission.permissionPrompt || permission.questionPrompt)
          : legacy?.disabled ?? false}
        queueCount={split ? queue.messageQueue.length : legacy?.queueCount ?? 0}
      />
    );
  },
);

interface BridgeScrollAlertsProps {
  /** SPEC S0-1: 显式回传 requestId + originRole 用于定向 respondPermissionForRequest() */
  onPermissionSelect: (requestId: string, originRole: PermissionOriginRole, reply: 'once' | 'always' | 'reject', message?: string) => void;
  onQuestionReply: (requestId: string, answers: string[][]) => void;
  onQuestionReject: (requestId: string) => void;
  legacy?: {
    warnings: string[];
    error: string | null;
    permissionPrompt: TuiPermissionPrompt | null;
    questionPrompt: QuestionRequest | null;
  };
}

/**
 * 滚动区警告 / 错误 / 权限 / 追问：拆分模式下独立订阅。
 */
export function BridgeScrollAlerts({
  onPermissionSelect,
  onQuestionReply,
  onQuestionReject,
  legacy,
}: BridgeScrollAlertsProps): React.ReactElement {
  const feedback = useBridgeFeedback();
  const permission = usePermissionQuestion();
  const split = isBridgeRuntimeSplitEnabled();

  const warnings = split ? feedback.warnings : legacy?.warnings ?? [];
  const error = split ? feedback.error : legacy?.error ?? null;
  const permissionPrompt = split ? permission.permissionPrompt : legacy?.permissionPrompt ?? null;
  const questionPrompt = split ? permission.questionPrompt : legacy?.questionPrompt ?? null;

  return (
    <>
      {warnings.map((warning, index) => (
        <Box key={index} paddingX={1}>
          <Text color={TONE.warn as any}>⚠ {warning}</Text>
        </Box>
      ))}
      {error && (
        <Box paddingX={1} marginTop={1}>
          <Text color={TONE.err as any}>✗ {error}</Text>
        </Box>
      )}
      {permissionPrompt && (
        <PermissionPrompt
          request={permissionPrompt}
          onSelect={onPermissionSelect}
        />
      )}
      {questionPrompt && (
        <QuestionPrompt
          request={questionPrompt}
          onReply={onQuestionReply}
          onReject={onQuestionReject}
        />
      )}
    </>
  );
}
