import { describe, it, expect } from "vitest"
import { containsEmbeddedToolCalls } from "../src/tool-calls/text-parsers.js"

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
