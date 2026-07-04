import { describe, it, expect } from "vitest"
import {
  createDuplicateDetector,
  createRepeatedFailureTracker,
  createToolCallIdNormalizer,
  DUPLICATE_TOOL_BLOCK_THRESHOLD,
  REPEATED_FAILURE_THRESHOLD,
} from "../src/loop-helpers.js"

describe("createToolCallIdNormalizer", () => {
  it("保留非空 rawId", () => {
    const n = createToolCallIdNormalizer()
    expect(n.normalize("call_abc", "bash")).toBe("call_abc")
  })

  it("空白 rawId 生成 toolName-seq-uuid 形式", () => {
    const n = createToolCallIdNormalizer()
    const id = n.normalize("   ", "bash")
    expect(id.startsWith("bash-1-")).toBe(true)
  })

  it("seq 单调递增", () => {
    const n = createToolCallIdNormalizer()
    const a = n.normalize(undefined, "read_file")
    const b = n.normalize(undefined, "read_file")
    expect(a).not.toBe(b)
  })

  it("reset 将 seq 归零", () => {
    const n = createToolCallIdNormalizer()
    n.normalize(undefined, "bash")
    n.reset()
    const id = n.normalize(undefined, "bash")
    expect(id.startsWith("bash-1-")).toBe(true)
  })

  it("实例间相互独立（per-engine 隔离）", () => {
    const a = createToolCallIdNormalizer()
    const b = createToolCallIdNormalizer()
    a.normalize(undefined, "bash")
    const idFromB = b.normalize(undefined, "bash")
    expect(idFromB.startsWith("bash-1-")).toBe(true)
  })
})

describe("createDuplicateDetector", () => {
  it("首次调用不报 duplicate", () => {
    const d = createDuplicateDetector()
    const out = d.check({ function: { name: "bash", arguments: '{"command":"ls"}' } } as any)
    expect(out.duplicate).toBe(false)
    expect(out.blocked).toBe(false)
    expect(out.count).toBe(1)
  })

  it("达到 warning 阈值报告 duplicate 但不 block", () => {
    const d = createDuplicateDetector()
    const tc = { function: { name: "bash", arguments: '{"command":"ls"}' } } as any
    for (let i = 0; i < DUPLICATE_TOOL_BLOCK_THRESHOLD - 2; i++) d.check(tc)
    const out = d.check(tc)
    expect(out.duplicate).toBe(true)
    expect(out.blocked).toBe(false)
  })

  it("达到 block 阈值报告 blocked", () => {
    const d = createDuplicateDetector()
    const tc = { function: { name: "bash", arguments: '{"command":"ls"}' } } as any
    for (let i = 0; i < DUPLICATE_TOOL_BLOCK_THRESHOLD - 1; i++) d.check(tc)
    const out = d.check(tc)
    expect(out.blocked).toBe(true)
    expect(out.count).toBe(DUPLICATE_TOOL_BLOCK_THRESHOLD)
  })

  it("不同 args 视为不同调用", () => {
    const d = createDuplicateDetector()
    const a = { function: { name: "bash", arguments: '{"command":"ls"}' } } as any
    const b = { function: { name: "bash", arguments: '{"command":"pwd"}' } } as any
    d.check(a)
    const out = d.check(b)
    expect(out.count).toBe(1)
    expect(out.duplicate).toBe(false)
  })
})

// ============================================================
// S2-1: RepeatedFailureTracker — 按 signature 计数的重复失败追踪
// ============================================================
describe("S2-1: createRepeatedFailureTracker", () => {
  it("首次失败 count=1 不 blocked", () => {
    const t = createRepeatedFailureTracker()
    const out = t.record("bash", { command: "npm test" }, "Error: ENOENT")
    expect(out.count).toBe(1)
    expect(out.threshold).toBe(REPEATED_FAILURE_THRESHOLD)
    expect(out.blocked).toBe(false)
  })

  it("相同 (tool, args, error) 累加计数，达阈值 blocked", () => {
    const t = createRepeatedFailureTracker()
    const args = { command: "npm test" }
    const err = "Error: ENOENT"
    t.record("bash", args, err)
    t.record("bash", args, err)
    const out = t.record("bash", args, err)
    expect(out.count).toBe(3)
    expect(out.blocked).toBe(true)
  })

  it("不同 error 内容视为不同 signature（调试流程可继续）", () => {
    const t = createRepeatedFailureTracker()
    const args = { command: "npm test" }
    t.record("bash", args, "Error: ENOENT at line 1")
    t.record("bash", args, "Error: ENOENT at line 2")
    const out = t.record("bash", args, "Error: ENOENT at line 3")
    expect(out.count).toBe(1)
    expect(out.blocked).toBe(false)
  })

  it("不同 args 视为不同 signature", () => {
    const t = createRepeatedFailureTracker()
    t.record("bash", { command: "npm test" }, "fail")
    t.record("bash", { command: "npm test" }, "fail")
    const out = t.record("bash", { command: "npm run build" }, "fail")
    expect(out.count).toBe(1)
    expect(out.blocked).toBe(false)
  })

  it("不同 toolName 视为不同 signature", () => {
    const t = createRepeatedFailureTracker()
    t.record("bash", { command: "x" }, "fail")
    t.record("bash", { command: "x" }, "fail")
    const out = t.record("edit", { command: "x" }, "fail")
    expect(out.count).toBe(1)
  })

  it("clear 后该 (tool, args) 下所有失败计数归零", () => {
    const t = createRepeatedFailureTracker()
    const args = { command: "npm test" }
    t.record("bash", args, "err1")
    t.record("bash", args, "err1")
    t.record("bash", args, "err2") // 不同 signature

    t.clear("bash", args)

    // clear 后再次失败应为 count=1
    const out = t.record("bash", args, "err1")
    expect(out.count).toBe(1)
    expect(out.blocked).toBe(false)
  })

  it("clear 只影响指定 (tool, args)，不影响其他", () => {
    const t = createRepeatedFailureTracker()
    const args1 = { command: "npm test" }
    const args2 = { command: "npm run build" }
    t.record("bash", args1, "err")
    t.record("bash", args1, "err")
    t.record("bash", args2, "err")
    t.record("bash", args2, "err")

    t.clear("bash", args1)

    const out2 = t.record("bash", args2, "err")
    expect(out2.count).toBe(3)
  })

  it("error 内容超过 300 字符也正确匹配（截断后哈希）", () => {
    const t = createRepeatedFailureTracker()
    const longErr = "x".repeat(500)
    t.record("bash", { command: "x" }, longErr)
    const out = t.record("bash", { command: "x" }, longErr)
    expect(out.count).toBe(2)

    // 第 301 字符后差异不应影响 signature
    const longErrSameHead = "x".repeat(300) + "y".repeat(200)
    const out2 = t.record("bash", { command: "x" }, longErrSameHead)
    expect(out2.count).toBe(3)
    expect(out2.blocked).toBe(true)
  })
})
