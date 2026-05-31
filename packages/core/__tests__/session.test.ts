import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdir, writeFile, rm, readFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { AsyncSessionWriter, SessionLoader } from "../src/session.js"

describe("AsyncSessionWriter", () => {
  let tmpDir: string
  let sessionPath: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `deepicode-session-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
})

describe("SessionLoader.read", () => {
  let sessDir: string

  beforeEach(() => {
    sessDir = join(tmpdir(), `deepicode-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
})

describe("SessionLoader.list", () => {
  let sessDir: string

  beforeEach(() => {
    sessDir = join(tmpdir(), `deepicode-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
    dirA = join(tmpdir(), `deepicode-session-a-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    dirB = join(tmpdir(), `deepicode-session-b-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
    sessDir = join(tmpdir(), `deepicode-session-sys-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
    tmpDir = join(tmpdir(), `deepicode-session-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionDir = join(tmpDir, ".deepicode", "sessions")
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
    tmpDir = join(tmpdir(), `deepicode-loadsession-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionDir = join(tmpDir, ".deepicode", "sessions")
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
    tmpDir = join(tmpdir(), `deepicode-recover-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    sessionDir = join(tmpDir, ".deepicode", "sessions")
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
    tmpDir = join(tmpdir(), `deepicode-enqueue-${Date.now()}-${Math.random().toString(36).slice(2)}`)
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
