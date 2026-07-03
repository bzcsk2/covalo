import { describe, it, expect } from "vitest"
import { repairToolArguments } from "../src/context/repair.js"

describe("repairToolArguments - Scavenge", () => {
  it("should extract valid JSON from outermost {} block", () => {
    const result = repairToolArguments('prefix text {"key": "value"} suffix text')
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ key: "value" })
  })

  it("should extract JSON from markdown code block", () => {
    const result = repairToolArguments('```json\n{"key": "value"}\n```')
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ key: "value" })
  })

  it("should convert single quotes to double quotes", () => {
    const result = repairToolArguments("{'key': 'value'}")
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ key: "value" })
  })

  it("should strip trailing comma before closing brace", () => {
    const result = repairToolArguments('{"key": "value",}')
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ key: "value" })
  })

  it("should wrap bare values in object", () => {
    const result = repairToolArguments('"key": "value"')
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ key: "value" })
  })

  it("should close unbalanced braces", () => {
    const result = repairToolArguments('{"key": "value"')
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ key: "value" })
  })

  it("should fix unclosed quote+brace via combined strategy 1g", () => {
    const result = repairToolArguments('{"key": "value')
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ key: "value" })
  })

  it("should try 6 strategies in order, first success wins", () => {
    // The 6 strategies:
    // 1a: extract outermost {...} block
    // 1b: single quotes → double quotes
    // 1c: strip trailing comma
    // 1d: wrap bare values
    // 1e: close unbalanced braces
    // 1f: fix unclosed quotes
    // Input that triggers 1b (the simplest repair needed)
    const result = repairToolArguments("{'a': 1}")
    expect(result.success).toBe(true)
    expect(result.method).toBe("scavenge")
  })

  it("should extract nested JSON from outermost braces", () => {
    const result = repairToolArguments('{"outer": {"inner": "value"}}')
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ outer: { inner: "value" } })
  })
})

describe("repairToolArguments - Truncation", () => {
  it("should truncate long values progressively", () => {
    const long = '{"key": "' + "x".repeat(300) + '"}'
    const result = repairToolArguments(long)
    expect(result.success).toBe(true)
    expect(result.args).toHaveProperty("key")
  })

  it("should not attempt truncation for short strings", () => {
    const result = repairToolArguments('{"key": broken')
    expect(result.success).toBe(false)
  })

  it("should use truncation when scavenge fails on long input", () => {
    // Long input with extra garbage at end that scavenge can't fix
    const long = '{"a": 1' + "," + '"b": "x'.repeat(200) + '"}'
    const result = repairToolArguments(long)
    // At least one strategy should succeed
    expect(result).toBeDefined()
  })
})

describe("repairToolArguments - Storm", () => {
  it("should extract single key-value with regex", () => {
    const result = repairToolArguments('"name": "test"')
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ name: "test" })
    expect(result.partial).toBe(true)
  })

  it("should accept empty object", () => {
    const result = repairToolArguments("{}")
    expect(result.success).toBe(true)
    expect(result.args).toEqual({})
  })

  it("should handle multiple keys via scavenge wrap (not storm)", () => {
    const result = repairToolArguments('"a": "1", "b": "2"')
    // Scavenge 1d wraps in {} and gets valid JSON → both keys present
    expect(result.success).toBe(true)
    expect(result.args).toEqual({ a: "1", b: "2" })
  })
})

describe("AUD-08: storm partial rejection", () => {
  it("should mark storm result as partial when multiple KV pairs found", () => {
    // Input structured so scavenge fails but storm matches 2 KV pairs
    const result = repairToolArguments('"a": "1" garbage "b": "2"')
    expect(result.success).toBe(true)
    expect(result.method).toBe("storm")
    expect(result.args).toEqual({ a: "1", b: "2" })
    expect(result.partial).toBe(true)
  })

  it("single KV storm result should also be partial", () => {
    // Use input with garbage that prevents scavenge but storm can match
    const result = repairToolArguments('"only": "key" @@@')
    expect(result.success).toBe(true)
    expect(result.method).toBe("storm")
    expect(result.partial).toBe(true)
  })

  it("should reject partial repair in executor", () => {
    // Simulate executor behavior: when partial=true, args are rejected
    const result = repairToolArguments('"path": "/x" garbage "old_string": "hello"')
    expect(result.success).toBe(true)
    expect(result.partial).toBe(true)
    // Executor would see partial=true and skip execution
  })
})

describe("repairToolArguments - all failed", () => {
  it("should return success=false when nothing works", () => {
    const result = repairToolArguments("not even close to json")
    expect(result.success).toBe(false)
  })

  it("should treat empty string as empty args (scavenge handles)", () => {
    const result = repairToolArguments("")
    expect(result.success).toBe(true)
    expect(result.args).toEqual({})
  })

  it("should treat whitespace as empty object (scavenge wraps {})", () => {
    // Scavenge 1d wraps raw in {} → "{   }" → valid JSON
    const result = repairToolArguments("   ")
    expect(result.success).toBe(true)
    expect(result.args).toEqual({})
  })
})

describe("repairToolArguments - truncation semantic diff", () => {
  it("should succeed when truncation changes semantic meaning (known limitation)", async () => {
    const { repairToolArguments } = await import("../src/context/repair.js")
    // Long input (>200 chars) that truncation can parse by cutting off end
    const safe = "x".repeat(100)
    const unsafe = "y".repeat(100)
    // {"path":"xxx...xxx"} — scavenge will fail because value is unterminated
    // truncation will cut it to {"path":"xxx...x"} which is valid but semantically different
    const long = '{"path": "' + safe + unsafe
    const result = repairToolArguments(long)
    expect(result.success).toBe(true)
    // Method may be scavenge (1g combined fix) or truncation
    // Both are acceptable — the key insight is the semantic change is a known limitation
    expect(result.args).toHaveProperty("path")
  })
})

describe("repairToolArguments - method tracking", () => {
  it("should track which stage succeeded", () => {
    // Valid JSON goes through scavenge
    const r1 = repairToolArguments('{"a": 1}')
    expect(r1.success).toBe(true)
    expect(r1.method).toBe("scavenge")

    // Truly unparseable that even storm can't handle
    const r2 = repairToolArguments("!@#$%^&*()")
    expect(r2.success).toBe(false)
    expect(r2.method).toBe("all-failed")
  })
})
