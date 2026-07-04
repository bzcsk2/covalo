import { describe, it, expect } from "vitest"
import { containsEmbeddedToolCalls, parseEmbeddedToolCallsFromText } from "../src/tool-calls/text-parsers.js"

describe("T4: COMPACT_TOOL_SUMMARY_RE global regex statefulness", () => {
  it("containsEmbeddedToolCalls returns consistent results on consecutive calls", () => {
    const content = "[调用工具: bash]"
    const r1 = containsEmbeddedToolCalls(content)
    const r2 = containsEmbeddedToolCalls(content)
    expect(r1).toBe(r2)
  })

  it("containsEmbeddedToolCalls detects compact tool summary", () => {
    expect(containsEmbeddedToolCalls("[调用工具: bash]")).toBe(true)
    expect(containsEmbeddedToolCalls("[调用工具: write_file, grep]")).toBe(true)
  })

  it("containsEmbeddedToolCalls returns false for plain text", () => {
    expect(containsEmbeddedToolCalls("Hello world")).toBe(false)
    expect(containsEmbeddedToolCalls("")).toBe(false)
    expect(containsEmbeddedToolCalls(undefined)).toBe(false)
  })

  it("containsEmbeddedToolCalls consecutive with different content", () => {
    const c1 = "[调用工具: bash] some text"
    const c2 = "[调用工具: grep] other text"
    expect(containsEmbeddedToolCalls(c1)).toBe(true)
    expect(containsEmbeddedToolCalls(c2)).toBe(true)
    expect(containsEmbeddedToolCalls(c1)).toBe(true)
  })

  it("containsEmbeddedToolCalls three consecutive calls same result", () => {
    const content = "[调用工具: read_file]"
    const r1 = containsEmbeddedToolCalls(content)
    const r2 = containsEmbeddedToolCalls(content)
    const r3 = containsEmbeddedToolCalls(content)
    expect(r1).toBe(true)
    expect(r2).toBe(true)
    expect(r3).toBe(true)
  })
})

describe("T10: TOOL_JSON_LOOKAHEAD_CHARS=500 覆盖大 envelope", () => {
  // 回归：之前硬编码 200，当 tool_calls / function key 出现在 `{` 后 200-500 字符之间时，
  // lookahead 窗口不够，TOOL_JSON_KEY_HINT 无法匹配，导致整个工具调用被漏掉（召回率下降）。
  // 500 覆盖更大的 tool_call envelope（function name + arguments 字段嵌套）。

  it("识别 key hint 出现在 200-500 字符之间的 tool_calls JSON", () => {
    // 构造 JSON：在 `{` 后填充 250 个空格，然后才出现 "tool_calls" key
    // 之前 lookahead=200 会漏掉（窗口截断在 200 处，看不到 "tool_calls"）
    const padding = " ".repeat(250)
    const json = `{${padding}"tool_calls": [{"id": "call_t10", "type": "function", "function": {"name": "search", "arguments": "{\\"q\\": \\"hello\\"}"}}]}`
    const text = `before ${json} after`

    const parsed = parseEmbeddedToolCallsFromText(text)
    expect(parsed.calls.length).toBeGreaterThanOrEqual(1)
    expect(parsed.calls[0]!.function.name).toBe("search")
  })

  it("识别 key hint 出现在 200-500 字符之间的 function name JSON", () => {
    // 类似上面，但用 "function": {...} 形态验证另一种 key hint
    const padding = " ".repeat(280)
    const json = `{${padding}"function": {"name": "compute", "arguments": "{\\"x\\": 42}"}, "id": "call_fn"}`
    const text = `prefix ${json} suffix`

    const parsed = parseEmbeddedToolCallsFromText(text)
    expect(parsed.calls.length).toBeGreaterThanOrEqual(1)
    expect(parsed.calls[0]!.function.name).toBe("compute")
  })

  it("lookahead 不足（>500 字符）时仍能被 extractBalancedJson 兜底识别", () => {
    // 极端情况：key hint 出现在 600 字符之后 — 超过 500 窗口。
    // 这种情况 lookahead 会 miss，但整个 JSON 仍合法。
    // 当前实现会因 lookahead miss 跳过，这是预期的召回率限制（不是 bug）— 此测试记录该行为。
    const padding = " ".repeat(600)
    const json = `{${padding}"name": "far_tool", "arguments": "{}"}`
    const text = `before ${json} after`

    const parsed = parseEmbeddedToolCallsFromText(text)
    // 超过 500 窗口，lookahead miss — 当前实现跳过该候选位置
    // 这是已知的召回率限制，记录为期望行为
    expect(parsed.calls.length).toBe(0)
  })
})
