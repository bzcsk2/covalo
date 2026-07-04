import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { AsyncSessionWriter, SessionLoader } from "../src/session.js"
import { CheckpointEngine } from "../src/checkpoint/checkpoint-engine.js"
import { ContextManager } from "../src/context/manager.js"
import { SurfaceStore } from "../src/harness-evolution/surfaces/surface-store.js"
import type { ChatMessage } from "../src/types.js"

async function makeTempDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `covalo-mc-phase2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

// ============================================================
// SPEC-05: createSummaryContent 保留工具行为事实，不保留 reasoning_content
// ============================================================
describe("SPEC-05: createSummaryContent 保留工具行为事实", () => {
  // 通过 reflect 访问私有方法 createSummaryContent
  function createSummary(messages: ChatMessage[]): string {
    const cm = new ContextManager({ window: 10000, maxRounds: 5 } as any)
    const fn = (cm as unknown as { createSummaryContent: (m: ChatMessage[]) => string }).createSummaryContent
    return fn.call(cm, messages)
  }

  it("assistant 消息带 tool_calls 时，摘要包含 [tool_call: ...]", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: JSON.stringify({ path: "src/index.ts" }) },
          },
        ],
      },
    ]
    const summary = createSummary(messages)
    expect(summary).toContain("[tool_call: read_file(path=src/index.ts)]")
  })

  it("tool 消息 is_error=true 时，摘要包含 [tool_result: ... error]", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "File not found",
        tool_call_id: "call_1",
        name: "read_file",
        is_error: true,
      },
    ]
    const summary = createSummary(messages)
    expect(summary).toContain("[tool_result: read_file error]")
  })

  it("tool 消息 is_error=false 时，摘要包含 [tool_result: ... ok]", () => {
    const messages: ChatMessage[] = [
      {
        role: "tool",
        content: "ok",
        tool_call_id: "call_1",
        name: "bash",
        is_error: false,
      },
    ]
    const summary = createSummary(messages)
    expect(summary).toContain("[tool_result: bash ok]")
  })

  it("reasoning_content 不出现在摘要中", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "thinking...",
        reasoning_content: "internal reasoning chain that should not leak",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "ls", arguments: "{}" },
          },
        ],
      },
    ]
    const summary = createSummary(messages)
    expect(summary).not.toContain("internal reasoning chain")
    expect(summary).toContain("[tool_call: ls]")
  })

  it("参数摘要长度受限，不写入完整大 JSON", () => {
    const bigArg = "x".repeat(500)
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "edit", arguments: JSON.stringify({ path: bigArg }) },
          },
        ],
      },
    ]
    const summary = createSummary(messages)
    // clip(path, 60) — 参数值最多 60 字符 + 前缀
    expect(summary).not.toContain(bigArg)
    expect(summary).toContain("[tool_call: edit(path=")
    expect(summary.length).toBeLessThan(500)
  })

  it("参数不在 safeKeys 列表时，只保留工具名", () => {
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: JSON.stringify({ query_text: "abc", options: { deep: true } }) },
          },
        ],
      },
    ]
    const summary = createSummary(messages)
    // query_text 不在 safeKeys (path/file/filePath/command/cwd/pattern/query)
    expect(summary).toContain("[tool_call: search]")
    expect(summary).not.toContain("query_text")
  })
})

// ============================================================
// SPEC-06: AsyncSessionWriter 字节上限 + messages coalescing
// ============================================================
describe("SPEC-06: AsyncSessionWriter 字节上限 + messages coalescing", () => {
  let tmpDir: string
  let sessionPath: string

  beforeEach(async () => {
    tmpDir = await makeTempDir()
    sessionPath = path.join(tmpDir, "session.jsonl")
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it("连续 enqueue 100 条 messages，未 flush 时只保留最新一条", async () => {
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()
    for (let i = 0; i < 100; i++) {
      writer.enqueue({
        ts: i,
        type: "messages",
        payload: { index: i, messages: [{ role: "user", content: `msg-${i}` }] },
      })
    }
    // 给 flush 一点时间
    await writer.drain()
    const content = await fs.readFile(sessionPath, "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)
    const messagesLines = lines.filter(l => l.includes('"type":"messages"'))
    // coalescing 后只 flush 了最新一条 messages（其他被丢弃）
    expect(messagesLines.length).toBe(1)
  })

  it("queueBytes 在 flush 后归零", async () => {
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()
    for (let i = 0; i < 10; i++) {
      writer.enqueue({ ts: i, type: "event", payload: { n: i } })
    }
    await writer.drain()
    const status = writer.getStatus()
    expect(status.queueBytes).toBe(0)
    expect(status.queueSize).toBe(0)
  })

  it("readDetailed 仍能恢复最后一条 messages", async () => {
    const sessionId = "spec06-readback"
    // SessionLoader.sessionDir 默认指向 process.cwd()/.covalo/sessions，
    // 这里用静态方法 + 自定义 sessionDir 来验证
    const origDir = SessionLoader.sessionDir
    const sessDir = path.join(tmpDir, "sessions")
    SessionLoader.sessionDir = sessDir
    await fs.mkdir(sessDir, { recursive: true })
    const sessionPath2 = path.join(sessDir, `${sessionId}.jsonl`)

    try {
      const writer = new AsyncSessionWriter(sessionPath2)
      await writer.init()
      writer.enqueue({ ts: 1, type: "messages", payload: [{ role: "user", content: "old" }] })
      writer.enqueue({ ts: 2, type: "messages", payload: [{ role: "user", content: "new" }] })
      await writer.drain()

      const result = await SessionLoader.readDetailed(sessionId)
      expect(result.status).toBe("ok")
      expect(result.messages.length).toBeGreaterThan(0)
      expect(result.messages[0].content).toBe("new")
    } finally {
      SessionLoader.sessionDir = origDir
    }
  })

  it("SessionWriterStatus 暴露 queueBytes 字段", async () => {
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()
    const status = writer.getStatus()
    expect(typeof status.queueBytes).toBe("number")
    expect(status.queueBytes).toBe(0)
  })
})

// ============================================================
// SPEC-07: CheckpointEngine.save 实例级 promise chain 串行化
// ============================================================
describe("SPEC-07: CheckpointEngine.save 实例级 promise chain 串行化", () => {
  let tmp: string

  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("并发调用 Promise.all([save(a), save(b)]) 不抛错", async () => {
    const engine = new CheckpointEngine(tmp, "spec07-concurrent")
    const results = await Promise.all([
      engine.save({ trigger: "tool_failed", currentStepId: "step-a" }),
      engine.save({ trigger: "step_completed", currentStepId: "step-b" }),
    ])
    expect(results).toHaveLength(2)
    expect(results[0]).toBeDefined()
    expect(results[1]).toBeDefined()
  })

  it("并发 save 后 checkpoint 文件仍是合法 JSON", async () => {
    const engine = new CheckpointEngine(tmp, "spec07-json")
    await Promise.all([
      engine.save({ trigger: "tool_failed" }),
      engine.save({ trigger: "step_completed", currentStepId: "x" }),
      engine.save({ trigger: "tool_failed", appendTool: { toolName: "ls", success: true, signature: "ls", at: 1 } }),
    ])
    const raw = JSON.parse(await fs.readFile(engine.checkpointPath, "utf-8"))
    expect(raw.runtimeV2).toBeDefined()
  })

  it("两次 input 的效果按调用顺序体现在 runtimeV2 中", async () => {
    const engine = new CheckpointEngine(tmp, "spec07-order")
    // 顺序触发：先 step-a，再 step-b
    await engine.save({ trigger: "step_completed", currentStepId: "step-a" })
    await engine.save({ trigger: "step_completed", currentStepId: "step-b" })
    const state = engine.getV2State()
    // 最后一次 save 的 currentStepId 应该是 step-b
    expect(state.currentStepId).toBe("step-b")
    expect(state.lastTrigger).toBe("step_completed")
  })

  it("不同 session 的 CheckpointEngine 不互相等待", async () => {
    const engine1 = new CheckpointEngine(tmp, "session-1")
    const engine2 = new CheckpointEngine(tmp, "session-2")
    const [r1, r2] = await Promise.all([
      engine1.save({ trigger: "tool_failed" }),
      engine2.save({ trigger: "step_completed" }),
    ])
    expect(r1).toBeDefined()
    expect(r2).toBeDefined()
    // 两个 session 的 checkpoint 文件互不干扰
    const f1 = await fs.readFile(path.join(tmp, "session-1.checkpoint.json"), "utf-8")
    const f2 = await fs.readFile(path.join(tmp, "session-2.checkpoint.json"), "utf-8")
    expect(f1).not.toBe(f2)
  })
})

// ============================================================
// SPEC-13: SurfaceStore cache 完整实现
// ============================================================
describe("SPEC-13: SurfaceStore cache 完整实现", () => {
  let tmp: string

  beforeEach(async () => { tmp = await makeTempDir() })
  afterEach(async () => { await fs.rm(tmp, { recursive: true, force: true }) })

  it("get() 第二次命中 cache 返回相同内容", async () => {
    const store = new SurfaceStore(tmp)
    const surface = "supervisor-system-prompt" as const
    const content1 = await store.get(surface)
    const content2 = await store.get(surface)
    expect(content1).toBe(content2)
    expect(content1).toContain("Supervisor")
  })

  it("getHash() 第二次命中 cache 返回相同 hash", async () => {
    const store = new SurfaceStore(tmp)
    const surface = "worker-system-prompt" as const
    const hash1 = await store.getHash(surface)
    const hash2 = await store.getHash(surface)
    expect(hash1).toBe(hash2)
    expect(hash1.length).toBe(16)
  })

  it("getHash() 不调用 get() 时也能通过 cache 计算正确 hash", async () => {
    const store = new SurfaceStore(tmp)
    const surface = "task-digest-template" as const
    const hash = await store.getHash(surface)
    expect(hash.length).toBe(16)
    // 后续 get() 应该命中 cache 并返回与 hash 一致的内容
    const content = await store.get(surface)
    const { createHash } = await import("node:crypto")
    const expectedHash = createHash("sha256").update(content).digest("hex").slice(0, 16)
    expect(hash).toBe(expectedHash)
  })

  it("writeOverride() 后 cache 被 invalidate，下次 get 返回新内容", async () => {
    const store = new SurfaceStore(tmp)
    const surface = "review-rubric" as const
    const original = await store.get(surface)

    await store.writeOverride(surface, "# Custom Override\nNew content")
    const after = await store.get(surface)
    expect(after).not.toBe(original)
    expect(after).toContain("Custom Override")
  })

  it("getAll() / getAllHashes() 也能利用 cache", async () => {
    const store = new SurfaceStore(tmp)
    const all1 = await store.getAll()
    const all2 = await store.getAll()
    expect(Object.keys(all1).length).toBeGreaterThan(0)
    // 内容应该一致（cache 命中）
    for (const key of Object.keys(all1)) {
      expect(all1[key as keyof typeof all1]).toBe(all2[key as keyof typeof all2])
    }
  })
})
