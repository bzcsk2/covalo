/**
 * QuestionPrompt — question panel for user interaction.
 * Adapted from OpenCode (MIT License).
 * Source: packages/opencode/src/cli/cmd/tui/routes/session/question.tsx
 *
 * 修复：自定义输入的 backspace 和字符追加逻辑（原代码误用 useInput 的 input 参数）。
 */

import { Box, Text, useInput } from '@deepreef/ink';
import React, { useState, useCallback, useMemo } from 'react';
import type { QuestionRequest } from '@deepreef/core';
import {
  createQuestionBodyState,
  questionSingle,
  questionConfirm,
  questionInfo,
  questionCustom,
  questionInput,
  questionTotal,
  questionMove,
  questionSelect,
  questionSave,
  questionSubmit,
  questionReject,
  questionHint,
  questionSetEditing,
  questionSetSubmitting,
  questionStoreCustom,
  type QuestionBodyState,
} from './question-state.js';
import { Card } from './reasonix/Card.js';
import { CardHeader } from './reasonix/CardHeader.js';
import { FG, TONE } from './reasonix/tokens.js';
import { t } from './i18n/index.js';

interface QuestionPromptProps {
  request: QuestionRequest;
  onReply: (requestId: string, answers: string[][]) => void;
  onReject: (requestId: string) => void;
}

export function QuestionPrompt({ request, onReply, onReject }: QuestionPromptProps): React.ReactElement {
  const [state, setState] = useState<QuestionBodyState>(() =>
    createQuestionBodyState(request.id)
  );

  const isSingle = useMemo(() => questionSingle(request), [request]);
  const isConfirm = useMemo(() => questionConfirm(request, state), [request, state]);
  const info = useMemo(() => questionInfo(request, state), [request, state]);
  const hasCustom = useMemo(() => questionCustom(request, state), [request, state]);
  const input = useMemo(() => questionInput(state), [state]);
  const total = useMemo(() => questionTotal(request, state), [request, state]);
  const hint = useMemo(() => questionHint(request, state), [request, state]);

  const handleMove = useCallback((dir: -1 | 1) => {
    if (state.editing || state.submitting) return;
    setState(s => questionMove(s, request, dir));
  }, [request, state.editing, state.submitting]);

  const handleSelect = useCallback(() => {
    if (state.editing || state.submitting) return;
    const step = questionSelect(state, request);
    setState(step.state);
    if (step.reply) {
      setState(s => questionSetSubmitting(s, true));
      onReply(step.reply!.requestId, step.reply!.answers);
    }
  }, [request, state, onReply]);

  const handleSave = useCallback(() => {
    if (!state.editing || state.submitting) return;
    const step = questionSave(state, request);
    setState(step.state);
    if (step.reply) {
      setState(s => questionSetSubmitting(s, true));
      onReply(step.reply!.requestId, step.reply!.answers);
    }
  }, [request, state, onReply]);

  const handleReject = useCallback(() => {
    if (state.submitting) return;
    setState(s => questionSetSubmitting(s, true));
    onReject(request.id);
  }, [request.id, state.submitting, onReject]);

  const handleTab = useCallback((reverse?: boolean) => {
    if (isSingle || state.editing || state.submitting) return;
    const tabCount = request.questions.length + 1;
    const nextTab = reverse
      ? (state.tab - 1 + tabCount) % tabCount
      : (state.tab + 1) % tabCount;
    setState(s => ({
      ...s,
      tab: nextTab,
      selected: 0,
      editing: false,
    }));
  }, [isSingle, state.editing, state.submitting, state.tab, request.questions.length]);

  const handleCustomInput = useCallback((text: string) => {
    if (!state.editing) return;
    setState(s => questionStoreCustom(s, s.tab, text));
  }, [state.editing]);

  useInput((input, key) => {
    if (state.submitting) return;

    if (key.return) {
      if (state.editing) {
        handleSave();
      } else if (isConfirm) {
        // Submit all answers
        const reply = questionSubmit(request, state);
        setState(s => questionSetSubmitting(s, true));
        onReply(reply.requestId, reply.answers);
      } else {
        handleSelect();
      }
      return;
    }

    if (key.escape) {
      if (state.editing) {
        setState(s => questionSetEditing(s, false));
      } else {
        handleReject();
      }
      return;
    }

    if (key.tab) {
      handleTab(key.shift);
      return;
    }

    if (key.upArrow) {
      handleMove(-1);
      return;
    }

    if (key.downArrow) {
      handleMove(1);
      return;
    }

    // Number keys for direct selection
    if (!state.editing && input >= "1" && input <= "9") {
      const num = parseInt(input, 10);
      if (num <= total) {
        setState(s => ({
          ...s,
          selected: num - 1,
        }));
        // Auto-select on number key
        setTimeout(() => handleSelect(), 0);
      }
      return;
    }

    // Custom input handling
    if (state.editing && !key.ctrl && !key.meta) {
      const current = input; // memoized current custom input for active tab
      if (key.backspace || key.delete) {
        handleCustomInput(current.slice(0, -1));
      } else if (input.length === 1) {
        handleCustomInput(current + input);
      }
    }
  });

  // Render question tabs
  const renderTabs = () => {
    if (isSingle) return null;

    return (
      <Box flexDirection="row" marginBottom={1}>
        {request.questions.map((q, i) => (
          <Box key={i} marginRight={1}>
            <Text
              color={state.tab === i ? TONE.brand : FG.faint}
              bold={state.tab === i}
            >
              {`[${q.header}]`}
            </Text>
          </Box>
        ))}
        <Text
          color={state.tab === request.questions.length ? TONE.brand : FG.faint}
          bold={state.tab === request.questions.length}
        >
          {`[Confirm]`}
        </Text>
      </Box>
    );
  };

  // Render options
  const renderOptions = () => {
    if (!info || isConfirm) return null;

    const options = info.options.map((opt, i) => {
      const isSelected = state.selected === i;
      const isChecked = info.multiple && (state.answers[state.tab]?.includes(opt.label) ?? false);

      return (
        <Box key={i} flexDirection="row" marginLeft={1}>
          <Text
            color={isSelected ? TONE.brand : FG.body}
            bold={isSelected}
          >
            {isSelected ? '❯ ' : '  '}
            {isChecked ? '✓ ' : '  '}
            {opt.label}
          </Text>
          <Text color={FG.faint}>{` — ${opt.description}`}</Text>
        </Box>
      );
    });

    // Custom answer option
    if (hasCustom) {
      const isCustomSelected = state.selected === info.options.length;
      const customValue = questionInput(state);

      options.push(
        <Box key="custom" flexDirection="row" marginLeft={1}>
          <Text
            color={isCustomSelected ? TONE.brand : FG.body}
            bold={isCustomSelected}
          >
            {isCustomSelected ? '❯ ' : '  '}
            {state.editing ? '> ' : '  '}
            {state.editing ? customValue || t().questionTypeAnswer : t().questionTypeYourOwn}
          </Text>
        </Box>
      );
    }

    return <Box flexDirection="column">{options}</Box>;
  };

  // Render confirm screen
  const renderConfirm = () => {
    if (!isConfirm) return null;

    return (
      <Box flexDirection="column" marginLeft={1}>
        <Text color={TONE.brand} bold>{t().questionSummary}</Text>
        {request.questions.map((q, i) => {
          const answers = state.answers[i] ?? [];
          return (
            <Box key={i} flexDirection="row" marginLeft={1}>
              <Text color={FG.meta}>{`${q.header}: `}</Text>
              <Text color={FG.body}>
                {answers.length > 0 ? answers.join(', ') : t().questionNoAnswer}
              </Text>
            </Box>
          );
        })}
      </Box>
    );
  };

  return (
    <Card>
      <CardHeader
        glyph="?"
        tone={TONE.brand}
        title="Question"
        right={state.submitting ? <Text color={FG.faint}>{t().questionSubmitting}</Text> : undefined}
      />
      {renderTabs()}
      <Box flexDirection="column" marginLeft={1}>
        <Text color={FG.body} bold>{info?.question ?? t().questionConfirmAnswers}</Text>
      </Box>
      {renderOptions()}
      {renderConfirm()}
      <Box marginTop={1}>
        <Text color={FG.faint}>{hint}</Text>
      </Box>
    </Card>
  );
}
