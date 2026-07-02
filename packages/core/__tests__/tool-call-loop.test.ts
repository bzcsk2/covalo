import { describe, expect, it } from "vitest"
import {
  DUPLICATE_TOOL_BLOCK_THRESHOLD,
  DUPLICATE_TOOL_WARNING_THRESHOLD,
  createDuplicateDetector,
  createToolCallIdNormalizer,
} from "../src/loop-helpers.js"
import type { ToolCall } from "../src/types.js"

function toolCall(name = "read_file", args = '{"path":"README.md"}'): ToolCall {
  return {
    id: crypto.randomUUID(),
    type: "function",
    function: { name, arguments: args },
  }
}

describe("duplicate tool-call detector", () => {
  it("warns on the third identical call and blocks the fifth", () => {
    const detector = createDuplicateDetector()

    for (let count = 1; count <= DUPLICATE_TOOL_BLOCK_THRESHOLD; count++) {
      const result = detector.check(toolCall())

      expect(result.count).toBe(count)
      expect(result.duplicate).toBe(count >= DUPLICATE_TOOL_WARNING_THRESHOLD)
      expect(result.blocked).toBe(count >= DUPLICATE_TOOL_BLOCK_THRESHOLD)
      expect(Boolean(result.warning)).toBe(count >= DUPLICATE_TOOL_WARNING_THRESHOLD)
    }
  })

  it("tracks different arguments independently", () => {
    const detector = createDuplicateDetector()

    for (let count = 1; count < DUPLICATE_TOOL_BLOCK_THRESHOLD; count++) {
      detector.check(toolCall())
    }

    const differentArgs = detector.check(toolCall("read_file", '{"path":"package.json"}'))
    expect(differentArgs).toMatchObject({ duplicate: false, blocked: false, count: 1 })
  })
})

describe("tool call ID normalizer (L8)", () => {
  it("creates independent per-loop normalizers with isolated seq", () => {
    const a = createToolCallIdNormalizer()
    const b = createToolCallIdNormalizer()

    // 各自独立计数
    expect(a.normalize(undefined, "tool")).toMatch(/^tool-1-/)
    expect(a.normalize(undefined, "tool")).toMatch(/^tool-2-/)

    // b 不受 a 影响，从 1 开始
    expect(b.normalize(undefined, "tool")).toMatch(/^tool-1-/)
  })

  it("reset only affects the current normalizer, not others", () => {
    const a = createToolCallIdNormalizer()
    const b = createToolCallIdNormalizer()

    a.normalize(undefined, "tool")
    b.normalize(undefined, "tool")
    b.normalize(undefined, "tool")

    // reset a 不影响 b
    a.reset()
    expect(a.normalize(undefined, "tool")).toMatch(/^tool-1-/)
    expect(b.normalize(undefined, "tool")).toMatch(/^tool-3-/)
  })

  it("preserves provided raw id and trims whitespace", () => {
    const n = createToolCallIdNormalizer()
    expect(n.normalize("  call_abc  ", "tool")).toBe("call_abc")
    // 提供了 raw id 不消耗 seq
    expect(n.normalize(undefined, "tool")).toMatch(/^tool-1-/)
  })
})
