import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { ReasonixEngine } from "../src/engine.js"
import type { LoopEvent } from "../src/interface.js"
import { createWriteFileTool, createReadFileTool, createEditTool, createBashTool } from "@deepreef/tools"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join, resolve } from "node:path"

function g(gen: AsyncGenerator<any>): AsyncGenerator<any> { return gen }

class MockClient {
  private generators: Array<AsyncGenerator<any>> = []
  setGenerators(gs: Array<AsyncGenerator<any>>): void { this.generators = [...gs] }
  chatCompletionsStream(): AsyncGenerator<any> {
    return this.generators.shift() ?? g((async function* () {})())
  }
}

const mockClient = new MockClient()

function makeEngine() {
  return new ReasonixEngine({
    apiKey: "sk-test",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-flash",
    maxTokens: 256,
    temperature: 0.1,
  }, undefined, undefined, mockClient as any)
}

function genWrite(path: string, content: string) {
  return g((async function* () {
    yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-w", name: "write_file", arguments: JSON.stringify({ path, content }) }
    yield { type: "usage", usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 } }
    yield { type: "done", finishReason: "tool_calls" }
  })())
}

function genRead(path: string) {
  return g((async function* () {
    yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-r", name: "read_file", arguments: JSON.stringify({ path }) }
    yield { type: "usage", usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 } }
    yield { type: "done", finishReason: "tool_calls" }
  })())
}

function genText(text: string) {
  return g((async function* () {
    yield { type: "text_delta", delta: text }
    yield { type: "usage", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }
    yield { type: "done", finishReason: "stop" }
  })())
}

function genBash(cmd: string) {
  return g((async function* () {
    yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-b", name: "bash", arguments: JSON.stringify({ command: cmd }) }
    yield { type: "usage", usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 } }
    yield { type: "done", finishReason: "tool_calls" }
  })())
}

function genEdit(path: string, oldStr: string, newStr: string) {
  return g((async function* () {
    yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-e", name: "edit", arguments: JSON.stringify({ path, old_string: oldStr, new_string: newStr }) }
    yield { type: "usage", usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 } }
    yield { type: "done", finishReason: "tool_calls" }
  })())
}

function genTool(name: string, args: Record<string, unknown>) {
  return g((async function* () {
    yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-1", name, arguments: JSON.stringify(args) }
    yield { type: "usage", usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 } }
    yield { type: "done", finishReason: "tool_calls" }
  })())
}

describe("TT2: E2E tool chains through engine", () => {
  let tmpDir: string

  beforeEach(() => { tmpDir = mkdtempSync(join(process.cwd(), ".deepreef-test-e2e-")) })
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

  it("write_file → read_file chain", async () => {
    mockClient.setGenerators([
      genWrite(join(tmpDir, "hello.txt"), "hello world"),
      genRead(join(tmpDir, "hello.txt")),
      genText("done"),
    ])
    const engine = makeEngine()
    engine.registerTool(createWriteFileTool())
    engine.registerTool(createReadFileTool())
    const events: LoopEvent[] = []
    for await (const e of engine.submit("write and read")) events.push(e)
    expect(readFileSync(join(tmpDir, "hello.txt"), "utf-8")).toBe("hello world")
    const tools = events.filter((e) => e.role === "tool")
    expect(tools).toHaveLength(2)
    expect(tools[0].toolName).toBe("write_file")
    expect(tools[1].toolName).toBe("read_file")
    expect(tools[1].content).toContain("hello world")
    expect(events.some((e) => e.role === "done")).toBe(true)
  })

  it("write_file → edit → read_file chain", async () => {
    const filePath = join(tmpDir, "edit-me.txt")
    mockClient.setGenerators([
      genWrite(filePath, "hello world"),
      genEdit(filePath, "world", "deepreef"),
      genRead(filePath),
      genText("done"),
    ])
    const engine = makeEngine()
    engine.registerTool(createWriteFileTool())
    engine.registerTool(createEditTool())
    engine.registerTool(createReadFileTool())
    const events: LoopEvent[] = []
    for await (const e of engine.submit("write edit read")) events.push(e)
    expect(readFileSync(filePath, "utf-8")).toBe("hello deepreef")
    const tools = events.filter((e) => e.role === "tool")
    expect(tools).toHaveLength(3)
    expect(tools[0].toolName).toBe("write_file")
    expect(tools[1].toolName).toBe("edit")
    expect(tools[2].toolName).toBe("read_file")
    expect(tools[2].content).toContain("hello deepreef")
  })

  it("bash execution through engine", async () => {
    mockClient.setGenerators([
      genBash(`echo "hello from bash"`),
      genText("bash done"),
    ])
    const engine = makeEngine()
    engine.permissionEngine.addAllowRule({ toolName: "bash" })
    engine.registerTool(createBashTool())
    const events: LoopEvent[] = []
    for await (const e of engine.submit("run bash")) events.push(e)
    const toolEvent = events.find((e) => e.role === "tool")
    expect(toolEvent).toBeDefined()
    const result = JSON.parse(toolEvent!.content!)
    expect(result.stdout?.trim()).toBe("hello from bash")
    expect(result.exitCode).toBe(0)
  })

  it("bash → read_file cross-verification chain", async () => {
    const filePath = join(tmpDir, "bash-created.txt")
    // Use cross-platform command: Node.js writeFileSync to avoid shell syntax issues
    const writeCmd = process.platform === "win32"
      ? `node -e "require('fs').writeFileSync('${filePath.replace(/\\/g, '\\\\')}', 'created by bash')"`
      : `echo "created by bash" > ${filePath}`
    mockClient.setGenerators([
      genBash(writeCmd),
      genRead(filePath),
      genText("verified"),
    ])
    const engine = makeEngine()
    engine.permissionEngine.addAllowRule({ toolName: "bash" })
    engine.registerTool(createBashTool())
    engine.registerTool(createReadFileTool())
    const events: LoopEvent[] = []
    for await (const e of engine.submit("bash then read")) events.push(e)
    const tools = events.filter((e) => e.role === "tool")
    expect(tools).toHaveLength(2)
    expect(tools[1].content).toContain("created by bash")
    expect(readFileSync(filePath, "utf-8").trim()).toBe("created by bash")
  })

  it("tool error recovery: failing tool returns isError", async () => {
    mockClient.setGenerators([
      g((async function* () {
        yield { type: "tool_call_end", toolCallIndex: 0, id: "tc-err", name: "failing_tool", arguments: "{}" }
        yield { type: "usage", usage: { promptTokens: 5, completionTokens: 0, totalTokens: 5 } }
        yield { type: "done", finishReason: "tool_calls" }
      })()),
      genText("recovered"),
    ])
    const engine = makeEngine()
    engine.registerTool({
      name: "failing_tool", description: "fails",
      parameters: { type: "object", properties: {} },
      concurrency: "shared", approval: "read",
      async execute() { return { content: JSON.stringify({ error: "something went wrong" }), isError: true } },
    })
    const events: LoopEvent[] = []
    for await (const e of engine.submit("trigger error")) events.push(e)
    const errorEvent = events.find((e) => e.role === "error" && e.toolName === "failing_tool")
    expect(errorEvent).toBeDefined()
    expect(errorEvent!.severity).toBe("error")
    expect(errorEvent!.content).toContain("something went wrong")
    expect(events.find((e) => e.role === "tool" && e.toolName === "failing_tool")).toBeUndefined()
  })

  it("engine interrupt during tool execution", async () => {
    mockClient.setGenerators([
      genTool("slow_tool", {}),
    ])
    const engine = makeEngine()
    let executed = false
    engine.registerTool({
      name: "slow_tool", description: "slow",
      parameters: { type: "object", properties: {} },
      concurrency: "shared", approval: "read",
      async execute() {
        executed = true
        await new Promise((r) => setTimeout(r, 1000))
        return { content: "done", isError: false }
      },
    })
    const events: LoopEvent[] = []
    const iter = engine.submit("interrupt test")
    setTimeout(() => engine.interrupt(), 50)
    for await (const e of iter) events.push(e)
    expect(executed).toBe(true)
  })

  it("5-turn tool chain: write → edit → bash → bash → read", async () => {
    const filePath = join(tmpDir, "chain.txt")
    // Cross-platform shell commands: cat/grep are Unix-specific.
    // On Windows the shell backend uses PowerShell, which has
    // "cat" as an alias for Get-Content but no "grep".
    const catCmd = process.platform === "win32"
      ? `Get-Content ${filePath}`
      : `cat ${filePath}`
    const grepCmd = process.platform === "win32"
      ? `(Select-String -Pattern "edited" -Path "${filePath}").Matches.Count`
      : `grep -c "edited" ${filePath}`
    mockClient.setGenerators([
      genWrite(filePath, "step1\nstep2\nstep3"),
      genEdit(filePath, "step2", "edited"),
      genBash(catCmd),
      genBash(grepCmd),
      genRead(filePath),
      genText("chain complete"),
    ])
    const engine = makeEngine()
    engine.permissionEngine.addAllowRule({ toolName: "bash" })
    engine.registerTool(createWriteFileTool())
    engine.registerTool(createEditTool())
    engine.registerTool(createBashTool())
    engine.registerTool(createReadFileTool())
    const events: LoopEvent[] = []
    for await (const e of engine.submit("5 step chain")) events.push(e)
    const tools = events.filter((e) => e.role === "tool")
    expect(tools).toHaveLength(5)
    expect(tools[0].toolName).toBe("write_file")
    expect(tools[1].toolName).toBe("edit")
    expect(tools[2].toolName).toBe("bash")
    expect(tools[3].toolName).toBe("bash")
    expect(tools[4].toolName).toBe("read_file")
    expect(readFileSync(filePath, "utf-8")).toBe("step1\nedited\nstep3")
    expect(events.some((e) => e.role === "done")).toBe(true)
  })

  it("exec-tier tool asks permission then allows on confirm", async () => {
    mockClient.setGenerators([
      genBash(`echo "test"`),
      genText("done"),
    ])
    const engine = makeEngine()
    engine.registerTool(createBashTool())
    const events: LoopEvent[] = []
    // Auto-confirm: when permission_ask is yielded, respond immediately
    const submitPromise = (async () => {
      for await (const e of engine.submit("run bash")) {
        events.push(e)
        if (e.role === "permission_ask") engine.respondPermission(true)
      }
    })()
    await submitPromise
    const permEvents = events.filter((e) => e.role === "permission_ask")
    expect(permEvents.length).toBe(1)
    expect(permEvents[0].toolName).toBe("bash")
    // After confirmation, tool should execute (no error)
    const errorEvents = events.filter((e) => e.role === "error")
    expect(errorEvents.length).toBe(0)
  })

  it("should survive write_file with empty content", async () => {
    const filePath = join(tmpDir, "empty.txt")
    mockClient.setGenerators([
      genWrite(filePath, ""),
      genText("ok"),
    ])
    const engine = makeEngine()
    engine.registerTool(createWriteFileTool())
    const events: LoopEvent[] = []
    for await (const e of engine.submit("empty file")) events.push(e)
    expect(existsSync(filePath)).toBe(true)
    expect(readFileSync(filePath, "utf-8")).toBe("")
  })
})
