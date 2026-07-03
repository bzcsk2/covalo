/**
 * 任务意图推断 — 用于决定是否创建 TaskLedger。
 *
 * @experimental task-state.ts 是从 iceCoder 移植的实验性 intent classifier。
 * 当前生产路径使用 task-ledger.ts 的 shouldCreateLedger（基于消息长度/PLAN_HINTS/句子数量）。
 * 本模块保留作为未来更精细的 intent 分类基础，未接入生产路径，也不再公开 export。
 * 详见 docs/unintegrated_code_audit_20260703.md §3.6（Phase 2.2 选项 B）。
 *
 * DRF-40: 从 iceCoder task-state.ts 的 inferIntent / hasExecutableSideSignal 裁剪适配（MIT）
 * Source: iceCoder/src/harness/task-state.ts
 */

/** 任务意图分类 */
export type TaskIntent =
  | "edit"
  | "debug"
  | "refactor"
  | "test"
  | "docs"
  | "inspect"
  | "question"

/** 纯分析/疑问口吻（无明确执行侧信号） */
function isQuestionOnlyPrefix(text: string): boolean {
  const rawTrim = text.trim()
  const t = rawTrim.toLowerCase()
  return rawTrim.startsWith("分析一下")
    || rawTrim.startsWith("说明一下")
    || rawTrim.startsWith("解释一下")
    || rawTrim.startsWith("为什么")
    || rawTrim.startsWith("如何")
    || rawTrim.startsWith("怎么")
    || /^解释([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^说明([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^分析([\s\u3000，。、！？]|$)/.test(rawTrim)
    || /^(what|why|how)\b/i.test(t)
}

const EDIT_GOAL_CN = /修改|改|编辑|实现|新增|创建|生成/

/**
 * 是否包含明确要动工具/改代码/跑测的信号。
 */
export function hasExecutableSideSignal(text: string): boolean {
  const t = text.toLowerCase()
  return EDIT_GOAL_CN.test(t)
    || /运行\s*测试|跑测试|vitest|jest|pytest|mocha/i.test(t)
    || /\b(edit|modify|implement|create|update|fix|investigate|refactor)\b/i.test(t)
    || /\b(run|execute)\s+\S+/i.test(t)
    || /(?:^|[\s,;])(?:npm|pnpm|yarn|npx)\s+\S*test\b/i.test(t)
}

/**
 * 由用户自然语言推断任务意图。
 */
export function inferTaskIntent(text: string): TaskIntent {
  const t = text.toLowerCase()
  const rawTrim = text.trim()

  if (isQuestionOnlyPrefix(text) && !hasExecutableSideSignal(text)) {
    if (/查看|读取|搜索|解释|说明|read|search|explain|inspect/.test(t)) return "inspect"
    return "question"
  }

  if (EDIT_GOAL_CN.test(t) || /\b(edit|modify|implement|create|update)\b/.test(t)) return "edit"
  if (/测试|运行\s*测试|跑测试|verify|(?:^|[\s,;])(?:npm|pnpm|yarn|npx)\s+\S*test\b|vitest|jest|pytest|\btsc\b/.test(t)) {
    return "test"
  }
  if (/修复|失败|报错|错误|debug|fix|investigate/.test(t)) return "debug"
  if (/重构|refactor/.test(t)) return "refactor"
  if (/文档|readme|docs?/.test(t)) return "docs"
  if (/查看|读取|搜索|解释|说明|read|search|explain|inspect/.test(t)) return "inspect"
  return "question"
}

/**
 * 根据意图判断是否应创建 TaskLedger。
 * question/inspect 不创建；edit/debug/refactor/test 创建。
 */
export function shouldCreateLedgerByIntent(text: string): boolean {
  const intent = inferTaskIntent(text)
  return intent === "edit" || intent === "debug" || intent === "refactor" || intent === "test"
}
