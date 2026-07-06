/**
 * Question tool — adapted from OpenCode (MIT License).
 * Source: packages/opencode/src/tool/question.ts
 *
 * Asks the user questions and waits for their response.
 */

import type { AgentTool, QuestionInfo } from "@covalo/protocol"
import { safeStringify } from "./safe-stringify.js"

const QUESTION_DESCRIPTION = `Use this tool when you need to ask the user questions during execution. This allows you to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take.

Usage notes:
- When \`custom\` is enabled (default), a "Type your own answer" option is added automatically; don't include "Other" or catch-all options
- Answers are returned as arrays of labels; set \`multiple: true\` to allow selecting more than one
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label`

export function createAskUserQuestionTool(): AgentTool {
  return {
    name: "Question",
    description: QUESTION_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "Complete question" },
              header: { type: "string", description: "Very short label (max 30 chars)" },
              options: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "Display text (1-5 words, concise)" },
                    description: { type: "string", description: "Explanation of choice" },
                  },
                  required: ["label", "description"],
                },
                description: "Available choices",
              },
              multiple: { type: "boolean", description: "Allow selecting multiple choices" },
              custom: { type: "boolean", description: "Allow typing a custom answer (default: true)" },
            },
            required: ["question", "header", "options"],
          },
          description: "Questions to ask",
        },
      },
      required: ["questions"],
    },
    concurrency: "exclusive",
    approval: "read",
    async execute(args, ctx) {
      if (!Array.isArray(args.questions) || args.questions.length === 0) {
        return { content: safeStringify({ error: "questions array is required" }), isError: true }
      }

      // Validate questions
      for (const q of args.questions) {
        if (typeof q.question !== "string" || !q.question.trim()) {
          return { content: safeStringify({ error: "question text is required" }), isError: true }
        }
        if (typeof q.header !== "string" || !q.header.trim()) {
          return { content: safeStringify({ error: "question header is required" }), isError: true }
        }
        if (!Array.isArray(q.options) || q.options.length === 0) {
          return { content: safeStringify({ error: "at least one option is required" }), isError: true }
        }
      }

      // Use askUser if available, otherwise return question JSON
      if (ctx.askUser) {
        const questions: QuestionInfo[] = args.questions.map((q: Record<string, unknown>) => ({
          question: q.question as string,
          header: q.header as string,
          options: (q.options as Array<{ label: string; description: string }>).map(o => ({
            label: o.label,
            description: o.description,
          })),
          multiple: q.multiple as boolean | undefined,
          custom: q.custom as boolean | undefined,
        }))

        try {
          const answers = await ctx.askUser(questions)
          const formatted = questions
            .map((q, i) => `"${q.question}"="${answers[i]?.length ? answers[i].join(", ") : "Unanswered"}"`)
            .join(", ")

          return {
            content: safeStringify({
              answers,
              message: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
            }),
            isError: false,
          }
        } catch (e) {
          // User rejected or error
          return {
            content: safeStringify({ error: "Question was dismissed by user", rejected: true }),
            isError: true,
          }
        }
      }

      // Fallback: return question JSON (for backward compatibility)
      const result: Record<string, unknown> = {
        type: "question",
        questions: args.questions,
      }
      return { content: safeStringify(result), isError: false }
    },
  }
}

/**
 * Backward-compatible alias for the Question tool.
 */
export function createAskUserQuestionAlias(): AgentTool {
  const tool = createAskUserQuestionTool()
  return { ...tool, name: "AskUserQuestion" }
}
