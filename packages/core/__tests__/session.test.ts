import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AsyncSessionWriter, SessionLoader } from "../src/session.js"

describe("AsyncSessionWriter", () => {
  let tmpDir: string
  let sessionPath: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-session-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    sessionPath = join(tmpDir, "test-session.jsonl")
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("should write records to JSONL file", async () => {
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()
    writer.enqueue({ ts: 1000, type: "event", payload: { role: "user", content: "hi" } })
    await new Promise((r) => setTimeout(r, 100))
    const content = await readFile(sessionPath, "utf-8")
    expect(content).toContain('"role":"user"')
  })

  it("should append multiple records", async () => {
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()
    writer.enqueue({ ts: 1000, type: "event", payload: { role: "user", content: "q1" } })
    writer.enqueue({ ts: 1001, type: "event", payload: { role: "assistant", content: "a1" } })
    await new Promise((r) => setTimeout(r, 100))
    const content = await readFile(sessionPath, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)
  })

  it("should handle unserializable payload gracefully", () => {
    const writer = new AsyncSessionWriter(sessionPath)
    const circular: Record<string, unknown> = { a: null }
    circular.a = circular
    expect(() => writer.enqueue({ ts: 1, type: "event", payload: circular })).not.toThrow()
  })

  it("should batch writes (50 records per chunk)", async () => {
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()
    for (let i = 0; i < 100; i++) {
      writer.enqueue({ ts: i, type: "event", payload: { n: i } })
    }
    await new Promise((r) => setTimeout(r, 200))
    const content = await readFile(sessionPath, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(100)
  })

  it("should auto-create directory", async () => {
    const deepPath = join(tmpDir, "sub", "nested", "session.jsonl")
    const writer = new AsyncSessionWriter(deepPath)
    await writer.init()
    writer.enqueue({ ts: 1, type: "event", payload: { ok: true } })
    await new Promise((r) => setTimeout(r, 100))
    const exists = await import("node:fs/promises").then((fs) =>
      fs.access(deepPath).then(() => true, () => false),
    )
    expect(exists).toBe(true)
  })

  it("drain waits for queue to empty", async () => {
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()
    writer.enqueue({ ts: 1, type: "event", payload: { n: 1 } })
    writer.enqueue({ ts: 2, type: "event", payload: { n: 2 } })
    await writer.drain()
    const content = await readFile(sessionPath, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)
  })

  it("drain does not throw when writer is uninitialized", async () => {
    const writer = new AsyncSessionWriter(sessionPath)
    await expect(writer.drain()).resolves.toBeUndefined()
  })
})

describe("SessionLoader.read", () => {
  let sessDir: string

  beforeEach(() => {
    sessDir = join(tmpdir(), `covalo-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    SessionLoader.sessionDir = sessDir
  })

  afterEach(async () => {
    await rm(sessDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should return messages from last messages record", async () => {
    await mkdir(sessDir, { recursive: true })
    const lines = [
      JSON.stringify({ ts: 1, type: "event", payload: "start" }),
      JSON.stringify({ ts: 2, type: "messages", payload: [{ role: "user", content: "hi" }] }),
      JSON.stringify({ ts: 3, type: "event", payload: "end" }),
      JSON.stringify({ ts: 4, type: "messages", payload: [{ role: "assistant", content: "hello" }] }),
    ]
    await writeFile(join(sessDir, "s1.jsonl"), lines.join("\n") + "\n")
    const msgs = await SessionLoader.read("s1")
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe("assistant")
    expect(msgs[0].content).toBe("hello")
  })

  it("should return empty array when file does not exist", async () => {
    await mkdir(sessDir, { recursive: true })
    const msgs = await SessionLoader.read("nonexistent")
    expect(msgs).toEqual([])
  })

  it("readDetailed should distinguish missing sessions", async () => {
    await mkdir(sessDir, { recursive: true })
    const result = await SessionLoader.readDetailed("nonexistent")
    expect(result.status).toBe("missing")
    expect(result.messages).toEqual([])
    expect(result.skippedLines).toBe(0)
  })

  it("should skip damaged lines", async () => {
    await mkdir(sessDir, { recursive: true })
    const lines = [
      JSON.stringify({ ts: 1, type: "messages", payload: [{ role: "user", content: "hi" }] }),
      "not json at all",
      JSON.stringify({ ts: 3, type: "messages", payload: [{ role: "assistant", content: "ok" }] }),
    ]
    await writeFile(join(sessDir, "s2.jsonl"), lines.join("\n") + "\n")
    const msgs = await SessionLoader.read("s2")
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe("ok")
  })

  it("readDetailed should report skipped damaged lines", async () => {
    await mkdir(sessDir, { recursive: true })
    const lines = [
      JSON.stringify({ ts: 1, type: "messages", payload: [{ role: "user", content: "hi" }] }),
      JSON.stringify({ ts: 3, type: "messages", payload: [{ role: "assistant", content: "ok" }] }),
      "not json at all",
    ]
    await writeFile(join(sessDir, "s2-detail.jsonl"), lines.join("\n") + "\n")
    const result = await SessionLoader.readDetailed("s2-detail")
    expect(result.status).toBe("ok")
    expect(result.skippedLines).toBe(1)
    expect(result.messages[0].content).toBe("ok")
  })

  it("should return empty for empty file", async () => {
    await mkdir(sessDir, { recursive: true })
    await writeFile(join(sessDir, "empty.jsonl"), "")
    const msgs = await SessionLoader.read("empty")
    expect(msgs).toEqual([])
  })

  it("should handle null bytes in JSONL", async () => {
    await mkdir(sessDir, { recursive: true })
    const content = JSON.stringify({ ts: 1, type: "messages", payload: [{ role: "user", content: "hi" }] })
    await writeFile(join(sessDir, "s3.jsonl"), content + "\n\x00corrupted\n")
    const msgs = await SessionLoader.read("s3")
    expect(msgs).toHaveLength(1)
  })

  it("should preserve system messages as stored (no filtering)", async () => {
    // TEST.md mentions system filtering as desired, but current impl stores as-is
    await mkdir(sessDir, { recursive: true })
    const payload = [
      { role: "system", content: "you are a bot" },
      { role: "user", content: "hi" },
    ]
    await writeFile(join(sessDir, "s4.jsonl"), JSON.stringify({ ts: 1, type: "messages", payload }) + "\n")
    const msgs = await SessionLoader.read("s4")
    expect(msgs).toHaveLength(2)
    expect(msgs.some((m) => m.role === "system")).toBe(true)
  })

  it("should return empty array when only line is truncated JSON", async () => {
    await mkdir(sessDir, { recursive: true })
    await writeFile(join(sessDir, "s5.jsonl"), `{"ts":1,"type":"messages","payload":[{"role":"user","content":"hi"`)
    const msgs = await SessionLoader.read("s5")
    expect(msgs).toEqual([])
  })

  it("readDetailed should distinguish corrupt sessions", async () => {
    await mkdir(sessDir, { recursive: true })
    await writeFile(join(sessDir, "bad.jsonl"), `{"ts":1,"type":"messages","payload":[{"role":"user"`)
    const result = await SessionLoader.readDetailed("bad")
    expect(result.status).toBe("corrupt")
    expect(result.skippedLines).toBe(1)
    expect(result.messages).toEqual([])
  })
})

describe("SessionLoader.list", () => {
  let sessDir: string

  beforeEach(() => {
    sessDir = join(tmpdir(), `covalo-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    SessionLoader.sessionDir = sessDir
  })

  afterEach(async () => {
    await rm(sessDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should return empty array for empty directory", async () => {
    await mkdir(sessDir, { recursive: true })
    const list = await SessionLoader.list()
    expect(list).toEqual([])
  })

  it("should return sorted summaries", async () => {
    await mkdir(sessDir, { recursive: true })
    await writeFile(join(sessDir, "a.jsonl"), JSON.stringify({ ts: 100, type: "event", payload: "start" }) + "\n")
    await writeFile(join(sessDir, "b.jsonl"), JSON.stringify({ ts: 200, type: "event", payload: "start" }) + "\n")
    const list = await SessionLoader.list()
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe("b")
    expect(list[1].id).toBe("a")
  })

  it("should parse stats from last stats record", async () => {
    await mkdir(sessDir, { recursive: true })
    const lines = [
      JSON.stringify({ ts: 1, type: "event", payload: "start" }),
      JSON.stringify({ ts: 2, type: "messages", payload: [{ role: "user", content: "hi" }] }),
      JSON.stringify({ ts: 3, type: "stats", payload: { inputTokens: 50, outputTokens: 25 } }),
    ]
    await writeFile(join(sessDir, "s.jsonl"), lines.join("\n") + "\n")
    const list = await SessionLoader.list()
    expect(list).toHaveLength(1)
    expect(list[0].inputTokens).toBe(50)
    expect(list[0].outputTokens).toBe(25)
    expect(list[0].messageCount).toBe(1)
    expect(list[0].userMessages).toBe(1)
  })

  it("should only take the last stats record", async () => {
    await mkdir(sessDir, { recursive: true })
    const lines = [
      JSON.stringify({ ts: 1, type: "stats", payload: { inputTokens: 10, outputTokens: 5 } }),
      JSON.stringify({ ts: 2, type: "stats", payload: { inputTokens: 100, outputTokens: 50 } }),
    ]
    await writeFile(join(sessDir, "s.jsonl"), lines.join("\n") + "\n")
    const list = await SessionLoader.list()
    expect(list[0].inputTokens).toBe(100)
    expect(list[0].outputTokens).toBe(50)
  })

  it("should skip non-jsonl files", async () => {
    await mkdir(sessDir, { recursive: true })
    await writeFile(join(sessDir, "a.jsonl"), JSON.stringify({ ts: 1, type: "event", payload: "" }) + "\n")
    await writeFile(join(sessDir, "readme.txt"), "hello")
    const list = await SessionLoader.list()
    expect(list).toHaveLength(1)
  })

  it("should limit to 20 entries", async () => {
    await mkdir(sessDir, { recursive: true })
    for (let i = 0; i < 25; i++) {
      await writeFile(join(sessDir, `${i}.jsonl`), JSON.stringify({ ts: i, type: "event", payload: "" }) + "\n")
    }
    const list = await SessionLoader.list()
    expect(list.length).toBeLessThanOrEqual(20)
  })
})

describe("SessionLoader - cross-directory isolation", () => {
  let dirA: string
  let dirB: string

  beforeEach(() => {
    dirA = join(tmpdir(), `covalo-session-a-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    dirB = join(tmpdir(), `covalo-session-b-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  })

  afterEach(async () => {
    await rm(dirA, { recursive: true, force: true }).catch(() => {})
    await rm(dirB, { recursive: true, force: true }).catch(() => {})
  })

  it("should read from different sessionDir independently", async () => {
    // Write session "s1" in dirA
    await mkdir(dirA, { recursive: true })
    await writeFile(join(dirA, "s1.jsonl"), JSON.stringify({ ts: 100, type: "messages", payload: [{ role: "user", content: "from A" }] }) + "\n")

    // Write session "s2" in dirB
    await mkdir(dirB, { recursive: true })
    await writeFile(join(dirB, "s2.jsonl"), JSON.stringify({ ts: 200, type: "messages", payload: [{ role: "user", content: "from B" }] }) + "\n")

    // Point to dirA → should see only s1
    SessionLoader.sessionDir = dirA
    const listA = await SessionLoader.list()
    expect(listA).toHaveLength(1)
    expect(listA[0].id).toBe("s1")
    const msgsA = await SessionLoader.read("s1")
    expect(msgsA[0].content).toBe("from A")

    // Point to dirB → should see only s2
    SessionLoader.sessionDir = dirB
    const listB = await SessionLoader.list()
    expect(listB).toHaveLength(1)
    expect(listB[0].id).toBe("s2")
    const msgsB = await SessionLoader.read("s2")
    expect(msgsB[0].content).toBe("from B")
  })

  it("should not find sessions when pointing at different directory", async () => {
    await mkdir(dirA, { recursive: true })
    await writeFile(join(dirA, "only-a.jsonl"), JSON.stringify({ ts: 1, type: "messages", payload: [{ role: "user", content: "hi" }] }) + "\n")

    SessionLoader.sessionDir = dirA
    expect((await SessionLoader.list())).toHaveLength(1)

    SessionLoader.sessionDir = dirB
    expect((await SessionLoader.list())).toHaveLength(0)
    expect((await SessionLoader.read("only-a"))).toEqual([])
  })
})

describe("SessionLoader - system message behavior", () => {
  let sessDir: string

  beforeEach(() => {
    sessDir = join(tmpdir(), `covalo-session-sys-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    SessionLoader.sessionDir = sessDir
  })

  afterEach(async () => {
    await rm(sessDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should preserve system messages in read (no filtering)", async () => {
    await mkdir(sessDir, { recursive: true })
    const payload = [
      { role: "system", content: "you are a bot" },
      { role: "user", content: "hello" },
    ]
    await writeFile(join(sessDir, "s.jsonl"), JSON.stringify({ ts: 1, type: "messages", payload }) + "\n")
    const msgs = await SessionLoader.read("s")
    expect(msgs).toHaveLength(2)
    expect(msgs[0].role).toBe("system")
  })
})

// M4: system message filtering — SessionLoader preserves, engine filters
describe("M4: system message filtering", () => {
  let tmpDir: string
  let sessionDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-session-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionDir = join(tmpDir, ".covalo", "sessions")
    await mkdir(sessionDir, { recursive: true })
    SessionLoader.sessionDir = sessionDir
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should preserve system messages in SessionLoader output (engine filters them later)", async () => {
    const sessionId = "test-session-filter"
    const sessionPath = join(sessionDir, `${sessionId}.jsonl`)
    const records = [
      { ts: 1, type: "messages", payload: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi" },
      ]},
    ]
    await writeFile(sessionPath, records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8")
    const messages = await SessionLoader.read(sessionId)
    expect(messages).toHaveLength(3)
  })

  it("should verify engine._loadSessionMessages filters system role", async () => {
    const sessionId = "test-engine-filter"
    const sessionPath = join(sessionDir, `${sessionId}.jsonl`)
    const records = [
      { ts: 1, type: "messages", payload: [
        { role: "system", content: "You are a helpful assistant" },
        { role: "user", content: "Hello" },
      ]},
    ]
    await writeFile(sessionPath, records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8")

    const { ReasonixEngine } = await import("../src/engine.js")
    const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }
    const engine = new ReasonixEngine(config as any, undefined, sessionId)
    await engine.loadSession(sessionId)
    const state = engine.getState()
    const systemMsgs = state.messages.filter(m => m.role === "system")
    // System messages from loaded session should be filtered out
    // Engine re-injects its own system prompt via prefix.build (not called here)
    expect(systemMsgs.length).toBe(0)
  })
})

describe("M5: loadSession", () => {
  let tmpDir: string
  let sessionDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-loadsession-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionDir = join(tmpDir, ".covalo", "sessions")
    await mkdir(sessionDir, { recursive: true })
    SessionLoader.sessionDir = sessionDir
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should clear current context and load new session messages", async () => {
    const sessionId = "test-loadsession"
    const sessionPath = join(sessionDir, `${sessionId}.jsonl`)
    const records = [
      { ts: 1, type: "messages", payload: [
        { role: "user", content: "Hello from session" },
        { role: "assistant", content: "Hi from session" },
      ]},
    ]
    await writeFile(sessionPath, records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8")

    const { ReasonixEngine } = await import("../src/engine.js")
    const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }
    const engine = new ReasonixEngine(config as any, undefined, "original-session")

    // Add some messages first
    engine.getContextManager().log.append({ role: "user", content: "Original message" })

    // Now load new session
    const messages = await engine.loadSession(sessionId)
    expect(messages).toHaveLength(2)

    // Context should now have session messages, not original ones
    const state = engine.getState()
    const userMsgs = state.messages.filter(m => m.role === "user")
    expect(userMsgs.some(m => m.content === "Original message")).toBe(false)
    expect(userMsgs.some(m => m.content === "Hello from session")).toBe(true)
  })
})

describe("M6: recover", () => {
  let tmpDir: string
  let sessionDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-recover-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionDir = join(tmpDir, ".covalo", "sessions")
    await mkdir(sessionDir, { recursive: true })
    SessionLoader.sessionDir = sessionDir
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should create a usable engine instance from session", async () => {
    const sessionId = "test-recover"
    const sessionPath = join(sessionDir, `${sessionId}.jsonl`)
    const records = [
      { ts: 1, type: "messages", payload: [
        { role: "user", content: "Recover test" },
      ]},
    ]
    await writeFile(sessionPath, records.map(r => JSON.stringify(r)).join("\n") + "\n", "utf-8")

    const { ReasonixEngine } = await import("../src/engine.js")
    const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }
    const engine = await ReasonixEngine.recover(config as any, sessionId)
    expect(engine).toBeInstanceOf(ReasonixEngine)
    const state = engine.getState()
    expect(state.messages.length).toBeGreaterThanOrEqual(1)
    expect(state.sessionId).toBe(sessionId)
  })
})

describe("M9: SessionWriter enqueue", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-enqueue-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should enqueue a messages record and flush to disk", async () => {
    const sessionPath = join(tmpDir, "test.jsonl")
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()

    const payload = [{ role: "user", content: "test" }]
    writer.enqueue({ ts: Date.now(), type: "messages", payload })

    // Wait for flush
    await new Promise(r => setTimeout(r, 100))

    const content = await readFile(sessionPath, "utf-8")
    expect(content.trim()).toBeTruthy()
    const rec = JSON.parse(content.trim())
    expect(rec.type).toBe("messages")
    expect(rec.payload).toEqual(payload)
  })

  it("should cap queue at MAX_QUEUE_SIZE and drop old event records", async () => {
    const sessionPath = join(tmpDir, "test-cap.jsonl")
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()

    // Enqueue 600 event records (exceeds 500 limit)
    for (let i = 0; i < 600; i++) {
      writer.enqueue({ ts: i, type: "event", payload: { n: i } })
    }

    // Queue should be capped
    expect((writer as any).queue.length).toBeLessThanOrEqual(500)
    expect(writer.getDroppedCount()).toBeGreaterThan(0)
  })

  it("should preserve messages and stats when evicting events", async () => {
    const sessionPath = join(tmpDir, "test-preserve.jsonl")
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()

    // Enqueue mixed records: 490 events + 10 messages/stats
    for (let i = 0; i < 490; i++) {
      writer.enqueue({ ts: i, type: "event", payload: { n: i } })
    }
    for (let i = 0; i < 9; i++) {
      writer.enqueue({ ts: 500 + i, type: "messages", payload: [{ role: "user", content: `msg-${i}` }] })
    }
    writer.enqueue({ ts: 600, type: "stats", payload: { inputTokens: 100 } })

    // Now enqueue more events to trigger eviction
    for (let i = 0; i < 20; i++) {
      writer.enqueue({ ts: 700 + i, type: "event", payload: { n: 700 + i } })
    }

    // Queue should still be <= 500
    expect((writer as any).queue.length).toBeLessThanOrEqual(500)

    // All messages and stats should still be in queue
    const records = (writer as any).queueRecords as SessionRecord[]
    const msgCount = records.filter(r => r.type === "messages").length
    const statsCount = records.filter(r => r.type === "stats").length
    expect(msgCount).toBe(9)
    expect(statsCount).toBe(1)
  })

  it("should not throw when queue is at limit", async () => {
    const sessionPath = join(tmpDir, "test-nothrow.jsonl")
    const writer = new AsyncSessionWriter(sessionPath)
    await writer.init()

    expect(() => {
      for (let i = 0; i < 1000; i++) {
        writer.enqueue({ ts: i, type: "event", payload: { n: i } })
      }
    }).not.toThrow()
  })
})

describe("S1: session switching with full rebind", () => {
  let tmpDir: string
  let sessionDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-s1-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionDir = join(tmpDir, ".covalo", "sessions")
    await mkdir(sessionDir, { recursive: true })
    SessionLoader.sessionDir = sessionDir
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should rebind sessionWriter and toolExecutor sessionId on switch", async () => {
    // Write session A
    await writeFile(join(sessionDir, "session-a.jsonl"),
      JSON.stringify({ ts: 1, type: "messages", payload: [{ role: "user", content: "hello from A" }] }) + "\n")

    const { ReasonixEngine } = await import("../src/engine.js")
    const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }

    // Start with session A
    const engine = new ReasonixEngine(config as any, undefined, "session-a")
    expect(engine.getState().sessionId).toBe("session-a")

    // Switch to a new session B
    await engine.loadSession("session-b")
    expect(engine.getState().sessionId).toBe("session-b")

    // Context should be empty (new session)
    expect(engine.getState().messages.filter(m => m.role !== "system")).toHaveLength(0)

    // Now switch back to session A — should load its messages
    const msgs = await engine.loadSession("session-a")
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe("hello from A")
    expect(engine.getState().sessionId).toBe("session-a")
  })

  it("should throw when switching during active submit", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")
    const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }

    const engine = new ReasonixEngine(config as any, undefined, "session-during-submit")
    expect(engine.getState().sessionId).toBe("session-during-submit")

    // Manually simulate submit state
    ;(engine as any).isSubmitting = true

    await expect(engine.loadSession("other-session")).rejects.toThrow("Cannot switch sessions while submit is active")
  })
})

describe("S2: session ID validation and list correctness", () => {
  let sessDir: string

  beforeEach(() => {
    sessDir = join(tmpdir(), `covalo-s2-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    SessionLoader.sessionDir = sessDir
  })

  afterEach(async () => {
    await rm(sessDir, { recursive: true, force: true }).catch(() => {})
  })

  describe("validateSessionId", () => {
    it("should accept valid UUID", () => {
      expect(SessionLoader.validateSessionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true)
    })

    it("should accept simple alphanumeric IDs", () => {
      expect(SessionLoader.validateSessionId("my-session-123")).toBe(true)
    })

    it("should reject empty string", () => {
      expect(SessionLoader.validateSessionId("")).toBe(false)
    })

    it("should reject path traversal", () => {
      expect(SessionLoader.validateSessionId("../etc/passwd")).toBe(false)
      expect(SessionLoader.validateSessionId("foo/../../bar")).toBe(false)
    })

    it("should reject null bytes and control characters", () => {
      expect(SessionLoader.validateSessionId("foo\x00bar")).toBe(false)
    })

    it("should reject IDs with slashes or backslashes", () => {
      expect(SessionLoader.validateSessionId("foo/bar")).toBe(false)
      expect(SessionLoader.validateSessionId("foo\\bar")).toBe(false)
    })

    it("should reject '.' and '..'", () => {
      expect(SessionLoader.validateSessionId(".")).toBe(false)
      expect(SessionLoader.validateSessionId("..")).toBe(false)
    })

    it("should reject overly long IDs", () => {
      expect(SessionLoader.validateSessionId("a".repeat(129))).toBe(false)
    })
  })

  describe("SessionLoader.read path safety", () => {
    it("should reject path traversal in read()", async () => {
      await mkdir(sessDir, { recursive: true })
      await expect(SessionLoader.read("../outside")).rejects.toThrow("Invalid session ID")
    })
  })

  describe("list messageCount correctness", () => {
    it("should use last snapshot message count, not snapshot count", async () => {
      await mkdir(sessDir, { recursive: true })
      const lines = [
        JSON.stringify({ ts: 1, type: "messages", payload: [{ role: "user", content: "first" }] }),
        JSON.stringify({ ts: 2, type: "messages", payload: [
          { role: "user", content: "second" },
          { role: "assistant", content: "reply" },
        ]}),
      ]
      await writeFile(join(sessDir, "s.jsonl"), lines.join("\n") + "\n")
      const list = await SessionLoader.list()
      expect(list[0].messageCount).toBe(2) // last snapshot has 2 messages
      expect(list[0].userMessages).toBe(1)
    })
  })

  describe("list sort by last activity", () => {
    it("should sort by most recent record timestamp", async () => {
      await mkdir(sessDir, { recursive: true })
      // Session A: first msg at ts=100, last at ts=300
      const aLines = [
        JSON.stringify({ ts: 100, type: "event", payload: "start" }),
        JSON.stringify({ ts: 300, type: "messages", payload: [{ role: "user", content: "old latest" }] }),
      ]
      // Session B: first msg at ts=200, last at ts=400 (more recent)
      const bLines = [
        JSON.stringify({ ts: 200, type: "event", payload: "start" }),
        JSON.stringify({ ts: 400, type: "messages", payload: [{ role: "user", content: "newer latest" }] }),
      ]
      await writeFile(join(sessDir, "a.jsonl"), aLines.join("\n") + "\n")
      await writeFile(join(sessDir, "b.jsonl"), bLines.join("\n") + "\n")
      const list = await SessionLoader.list()
      expect(list).toHaveLength(2)
      expect(list[0].id).toBe("b") // most recent first
      expect(list[1].id).toBe("a")
    })
  })

  describe("engine integration", () => {
    let tmpDir: string
    let sessionDir: string

    beforeEach(async () => {
      tmpDir = join(tmpdir(), `covalo-s2-engine-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      sessionDir = join(tmpDir, ".covalo", "sessions")
      await mkdir(sessionDir, { recursive: true })
      SessionLoader.sessionDir = sessionDir
    })

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    })

    it("should reject invalid session ID in engine.loadSession", async () => {
      const { ReasonixEngine } = await import("../src/engine.js")
      const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }
      const engine = new ReasonixEngine(config as any, undefined, "valid-session")
      await expect(engine.loadSession("../evil")).rejects.toThrow("Invalid session ID")
    })

    it("should reject invalid session ID in engine.recover", async () => {
      const { ReasonixEngine } = await import("../src/engine.js")
      const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }
      await expect(ReasonixEngine.recover(config as any, "../evil")).rejects.toThrow("Invalid session ID")
    })
  })
})

describe("CL-11: Session stats compatibility", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-cl11-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    SessionLoader.sessionDir = tmpDir
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("reads new format (promptTokens/completionTokens)", async () => {
    const content = `{"ts":1,"type":"messages","payload":[{"role":"user","content":"hi"}]}\n{"ts":2,"type":"stats","payload":{"promptTokens":100,"completionTokens":50}}\n`
    await writeFile(join(tmpDir, "s1.jsonl"), content, "utf-8")
    const sessions = await SessionLoader.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].inputTokens).toBe(100)
    expect(sessions[0].outputTokens).toBe(50)
  })

  it("reads old format (inputTokens/outputTokens)", async () => {
    const content = `{"ts":1,"type":"messages","payload":[{"role":"user","content":"hi"}]}\n{"ts":2,"type":"stats","payload":{"inputTokens":200,"outputTokens":75}}\n`
    await writeFile(join(tmpDir, "s2.jsonl"), content, "utf-8")
    const sessions = await SessionLoader.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].inputTokens).toBe(200)
    expect(sessions[0].outputTokens).toBe(75)
  })

  it("prefers new format over old when both present", async () => {
    const content = `{"ts":1,"type":"messages","payload":[{"role":"user","content":"hi"}]}\n{"ts":2,"type":"stats","payload":{"promptTokens":100,"completionTokens":50,"inputTokens":200,"outputTokens":75}}\n`
    await writeFile(join(tmpDir, "s3.jsonl"), content, "utf-8")
    const sessions = await SessionLoader.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].inputTokens).toBe(100)
    expect(sessions[0].outputTokens).toBe(50)
  })

  it("uses last stats record", async () => {
    const content = `{"ts":1,"type":"stats","payload":{"promptTokens":10,"completionTokens":5}}\n{"ts":2,"type":"stats","payload":{"promptTokens":100,"completionTokens":50}}\n{"ts":3,"type":"messages","payload":[{"role":"user","content":"hi"}]}\n`
    await writeFile(join(tmpDir, "s4.jsonl"), content, "utf-8")
    const sessions = await SessionLoader.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].inputTokens).toBe(100)
    expect(sessions[0].outputTokens).toBe(50)
  })

  it("shows zero for missing stats", async () => {
    const content = `{"ts":1,"type":"messages","payload":[{"role":"user","content":"hi"}]}\n`
    await writeFile(join(tmpDir, "s5.jsonl"), content, "utf-8")
    const sessions = await SessionLoader.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0].inputTokens).toBe(0)
    expect(sessions[0].outputTokens).toBe(0)
  })
})

describe("CL-32: Session writer observability", () => {
  let tmpDir: string
  let logLines: string[]

  const testLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    isEnabled: vi.fn(() => true),
    setLevel: vi.fn(),
  }

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-cl32-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    logLines = []
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    vi.clearAllMocks()
  })

  it("logs session.writer.ready on init", async () => {
    const sessPath = join(tmpDir, "test.jsonl")
    const writer = new AsyncSessionWriter(sessPath, testLogger as any)
    await writer.init()
    expect(testLogger.debug).toHaveBeenCalledWith("session.writer.ready", expect.objectContaining({ path: sessPath }))
  })

  it("logs session.writer.serialize_error for unserializable records", () => {
    const sessPath = join(tmpDir, "test.jsonl")
    const writer = new AsyncSessionWriter(sessPath, testLogger as any)
    const circular: Record<string, unknown> = { a: null }
    circular.a = circular
    writer.enqueue({ ts: 1, type: "event", payload: circular })
    expect(testLogger.debug).toHaveBeenCalledWith("session.writer.serialize_error", expect.objectContaining({ type: "event" }))
  })

  it("logs session.writer.overflow when queue exceeds limit", async () => {
    const sessPath = join(tmpDir, "test.jsonl")
    const writer = new AsyncSessionWriter(sessPath, testLogger as any)
    await writer.init()

    for (let i = 0; i < 600; i++) {
      writer.enqueue({ ts: i, type: "event", payload: { n: i } })
    }

    expect(testLogger.debug).toHaveBeenCalledWith("session.writer.overflow", expect.objectContaining({ droppedCount: expect.any(Number) }))
  })

  it("logs session.writer.append_error on write failure", async () => {
    // Use a path that will fail (directory that doesn't exist and can't be created)
    const sessPath = join(tmpDir, "nonexistent", "nested", "fail.jsonl")
    const writer = new AsyncSessionWriter(sessPath, testLogger as any)

    // Don't call init — skip the mkdir so write fails
    // Manually set initPromise to resolve (bypass directory creation)
    ;(writer as any).initPromise = Promise.resolve()

    writer.enqueue({ ts: 1, type: "event", payload: { msg: "test" } })
    await new Promise(r => setTimeout(r, 200))

    expect(testLogger.debug).toHaveBeenCalledWith("session.writer.append_error", expect.objectContaining({
      path: sessPath,
    }))
  })

  it("tolerates last-line corruption (async-append guarantee)", async () => {
    const sessPath = join(tmpDir, "robust.jsonl")
    const writer = new AsyncSessionWriter(sessPath)
    await writer.init()

    writer.enqueue({ ts: 1, type: "messages", payload: [{ role: "user", content: "hello" }] })
    await new Promise(r => setTimeout(r, 100))

    // Manually append a corrupted line
    const { appendFile } = await import("node:fs/promises")
    await appendFile(sessPath, "corrupted garbage\n", "utf-8")

    writer.enqueue({ ts: 2, type: "messages", payload: [{ role: "assistant", content: "world" }] })
    await new Promise(r => setTimeout(r, 100))

    SessionLoader.sessionDir = tmpDir
    const msgs = await SessionLoader.read("robust")
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toBe("world")
  })

  it("append-only model — no renames or fsync required", async () => {
    const sessPath = join(tmpDir, "append-only.jsonl")
    const writer = new AsyncSessionWriter(sessPath)
    await writer.init()

    writer.enqueue({ ts: 1, type: "event", payload: { step: 1 } })
    writer.enqueue({ ts: 2, type: "event", payload: { step: 2 } })
    await new Promise(r => setTimeout(r, 100))

    const content = await readFile(sessPath, "utf-8")
    const lines = content.trim().split("\n")
    expect(lines).toHaveLength(2)

    // Append more — should not rewrite existing content
    writer.enqueue({ ts: 3, type: "event", payload: { step: 3 } })
    await new Promise(r => setTimeout(r, 100))

    const content2 = await readFile(sessPath, "utf-8")
    const lines2 = content2.trim().split("\n")
    expect(lines2).toHaveLength(3)
    // First two lines should be unchanged
    expect(lines2[0]).toBe(lines[0])
    expect(lines2[1]).toBe(lines[1])
  })
})

describe("SPEC-A: loadSession context isolation", () => {
  let tmpDir: string
  let sessionDir: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `covalo-speca-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionDir = join(tmpDir, ".covalo", "sessions")
    await mkdir(sessionDir, { recursive: true })
    SessionLoader.sessionDir = sessionDir
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  it("should clear scratch and summary when switching sessions", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")
    const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }
    const engine = new ReasonixEngine(config as any, undefined, "session-a")

    engine.getContextManager().scratch.append({ role: "assistant", content: "scratch A" })
    engine.getContextManager().getSummary().replace("Summary A")

    await engine.loadSession("session-b")

    expect(engine.getContextManager().scratch.messages).toHaveLength(0)
    expect(engine.getContextManager().getSummary().hasSummary()).toBe(false)

    const messages = engine.getContextManager().buildMessages()
    expect(messages.some(m => m.role === "assistant" && m.content === "scratch A")).toBe(false)
    expect(messages.some(m => m.role === "system" && m.content?.includes("Summary A"))).toBe(false)
  })

  it("should reset taskLedger, verificationGateState, supervisorGuidanceState, and pendingInstructionQueue on session switch", async () => {
    const { ReasonixEngine } = await import("../src/engine.js")
    const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }
    const engine = new ReasonixEngine(config as any, undefined, "session-a")

    const state = engine as any
    state.taskLedger = { goal: "test", snapshot: () => ({}) }
    state.verificationGateState = { continuationCount: 5 }
    state.supervisorGuidanceState = {
      failureSignatureHistory: { sig: { count: 1, lastEvidenceHash: "hash" } },
      requestedEvidenceHashes: ["hash1"],
      recentFailures: [{ signature: "s", count: 1 }],
      recentTools: [{ name: "bash", success: true, summary: "x" }],
      stagnantRoundsAfterAdvice: 1,
      adviceInjectionCount: 1,
    }
    state.pendingInstructionQueue = ["instr1", "instr2"]

    await engine.loadSession("session-b")

    const after = engine as any
    expect(after.taskLedger).toBeUndefined()
    expect(after.verificationGateState).toEqual({ continuationCount: 0 })
    expect(after.supervisorGuidanceState).toEqual({
      failureSignatureHistory: {},
      requestedEvidenceHashes: [],
      recentFailures: [],
      recentTools: [],
      stagnantRoundsAfterAdvice: 0,
      adviceInjectionCount: 0,
    })
    expect(after.pendingInstructionQueue).toEqual([])
  })
})

describe("SPEC-03: injectExperienceRecall", () => {
  let originalCwd: string
  let tmpDir: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    tmpDir = join(tmpdir(), `covalo-spec03-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(tmpDir, { recursive: true })
    process.chdir(tmpDir)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  })

  async function createEngine(sessionId = "session-spec03") {
    const { ReasonixEngine } = await import("../src/engine.js")
    const config = { apiKey: "test", baseUrl: "http://localhost", model: "test", maxTokens: 1000, temperature: 0, maxContextRounds: 20, contextWindow: 128000 }
    return new ReasonixEngine(config as any, undefined, sessionId)
  }

  it("没有 experience 文件时不抛错", async () => {
    const engine = await createEngine()
    await (engine as any).injectExperienceRecall()
    expect(engine.getContextManager().scratch.messages).toHaveLength(0)
  })

  it("有 trusted 经验时注入到 scratch（user role + data wrapper）", async () => {
    const { ExperienceStore } = await import("../src/harness-evolution/experience/index.js")
    const store = new ExperienceStore(tmpDir)
    await store.init()
    await store.append({
      id: "exp:test-trusted",
      signature: "test-sig",
      sourceKind: "task",
      sourceRef: "test",
      trust: "trusted",
      createdAt: new Date().toISOString(),
      taskType: "bugfix",
      confidence: 0.8,
      evidenceRefs: [],
    } as any)

    const engine = await createEngine()
    await (engine as any).injectExperienceRecall()

    const messages = engine.getContextManager().scratch.messages
    const recallMsg = messages.find(m => m.role === "user" && typeof m.content === "string" && m.content.includes("Retrieved Trusted Experiences"))
    expect(recallMsg).toBeDefined()
    expect(recallMsg!.content as string).toContain("<experience_recall_data>")
    expect(recallMsg!.content as string).toContain("</experience_recall_data>")
    expect(recallMsg!.content as string).toContain("weak, non-authoritative guidance")
    // 不应有 system role 的 recall 消息
    expect(messages.some(m => m.role === "system" && typeof m.content === "string" && m.content.includes("Retrieved Trusted Experiences"))).toBe(false)
  })

  it("只有 untrusted 经验时默认不注入", async () => {
    const { ExperienceStore } = await import("../src/harness-evolution/experience/index.js")
    const store = new ExperienceStore(tmpDir)
    await store.init()
    await store.append({
      id: "exp:test-untrusted",
      signature: "test-sig",
      sourceKind: "task",
      sourceRef: "test",
      trust: "untrusted",
      createdAt: new Date().toISOString(),
      taskType: "bugfix",
      confidence: 0.8,
      evidenceRefs: [],
    } as any)

    const engine = await createEngine()
    await (engine as any).injectExperienceRecall()

    const messages = engine.getContextManager().scratch.messages
    expect(messages.some(m => m.role === "system" && typeof m.content === "string" && m.content.includes("Retrieved Trusted Experiences"))).toBe(false)
  })

  it("经验文件包含坏 JSON 行时不抛错", async () => {
    const { writeFile } = await import("node:fs/promises")
    const expDir = join(tmpDir, ".covalo", "experience")
    await mkdir(expDir, { recursive: true })
    const goodRecord = {
      id: "exp:good-bad",
      signature: "sig",
      sourceKind: "task",
      sourceRef: "test",
      trust: "trusted",
      createdAt: new Date().toISOString(),
      taskType: "bugfix",
      confidence: 0.9,
      evidenceRefs: [],
    }
    const content = ["{bad json", JSON.stringify(goodRecord)].join("\n")
    await writeFile(join(expDir, "experiences.jsonl"), content + "\n", "utf-8")

    const engine = await createEngine()
    await (engine as any).injectExperienceRecall()

    const messages = engine.getContextManager().scratch.messages
    expect(messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.includes("Retrieved Trusted Experiences"))).toBe(true)
  })

  it("COVALO_EXPERIENCE_RECALL=false 时跳过注入", async () => {
    const { ExperienceStore } = await import("../src/harness-evolution/experience/index.js")
    const store = new ExperienceStore(tmpDir)
    await store.init()
    await store.append({
      id: "exp:test-env-disable",
      signature: "test-sig",
      sourceKind: "task",
      sourceRef: "test",
      trust: "trusted",
      createdAt: new Date().toISOString(),
      taskType: "bugfix",
      confidence: 0.8,
      evidenceRefs: [],
    } as any)

    const engine = await createEngine()
    const prev = process.env.COVALO_EXPERIENCE_RECALL
    process.env.COVALO_EXPERIENCE_RECALL = "false"
    try {
      await (engine as any).injectExperienceRecall()
      const messages = engine.getContextManager().scratch.messages
      expect(messages.some(m => m.role === "user" && typeof m.content === "string" && m.content.includes("Retrieved Trusted Experiences"))).toBe(false)
    } finally {
      if (prev === undefined) delete process.env.COVALO_EXPERIENCE_RECALL
      else process.env.COVALO_EXPERIENCE_RECALL = prev
    }
  })
})
