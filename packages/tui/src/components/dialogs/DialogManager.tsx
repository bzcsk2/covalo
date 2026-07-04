/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 *
 * Priority-ordered dialog renderer for Deepreef TUI.
 * Adapted from gemini-cli/packages/cli/src/ui/components/DialogManager.tsx.
 *
 * Renders the highest-priority open dialog and blocks input to underlying
 * components when a dialog is active.
 *
 * Priority order:
 * 1. Permission dialog (highest — security critical)
 * 2. Question dialog
 * 3. Theme picker (future)
 * 4. Settings (future)
 */

import React from 'react';
import type { QuestionRequest, PermissionReply } from '@covalo/core';
import type { TuiPermissionPrompt, PermissionOriginRole } from '../../bridge.js';
import { PermissionPrompt } from '../../PermissionPrompt.js';
import { QuestionPrompt } from '../../QuestionPrompt.js';

export interface DialogManagerProps {
  /** SPEC S0-1: pending permission prompt 含 originRole，用于定向 respondPermissionForRequest() */
  permissionRequest: TuiPermissionPrompt | null;
  /** Pending question request, or null if none */
  questionRequest: QuestionRequest | null;
  /** SPEC S0-1: callback 显式回传 requestId + originRole */
  onPermissionReply: (requestId: string, originRole: PermissionOriginRole, reply: PermissionReply, message?: string) => void;
  /** Callback when user answers a question */
  onQuestionReply: (requestId: string, answers: string[][]) => void;
  /** Callback when user rejects a question */
  onQuestionReject: (requestId: string) => void;
  /** Terminal width in columns (for responsive layout) */
  terminalWidth: number;
}

/**
 * Returns the currently active dialog kind based on priority.
 * Permission takes precedence over question (security critical).
 */
function resolveActiveDialog(
  permissionRequest: TuiPermissionPrompt | null,
  questionRequest: QuestionRequest | null,
): 'permission' | 'question' | null {
  if (permissionRequest) return 'permission';
  if (questionRequest) return 'question';
  return null;
}

/**
 * DialogManager renders the highest-priority open dialog.
 *
 * When a dialog is active, keyboard events should not pass through to
 * the underlying input — this is enforced by rendering the dialog on top
 * and by the parent App disabling input when `hasActiveDialog` is true.
 */
export function DialogManager({
  permissionRequest,
  questionRequest,
  onPermissionReply,
  onQuestionReply,
  onQuestionReject,
  terminalWidth: _terminalWidth,
}: DialogManagerProps): React.ReactElement | null {
  const activeDialog = resolveActiveDialog(permissionRequest, questionRequest);

  if (activeDialog === 'permission' && permissionRequest) {
    return <PermissionPrompt request={permissionRequest} onSelect={onPermissionReply} />;
  }

  if (activeDialog === 'question' && questionRequest) {
    return (
      <QuestionPrompt
        request={questionRequest}
        onReply={onQuestionReply}
        onReject={onQuestionReject}
      />
    );
  }

  return null;
}

/**
 * Returns true if any dialog is currently active (for input blocking).
 */
export function hasActiveDialog(
  permissionRequest: TuiPermissionPrompt | null,
  questionRequest: QuestionRequest | null,
): boolean {
  return resolveActiveDialog(permissionRequest, questionRequest) !== null;
}
