import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { LspLogger, createLspLogger } from "../src/lsp/logger.js"
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function createTestRuntimeLogger(opts: { filePath: string; level: string; bindings: Record<string, unknown> }) {
  const records: string[] = []
  return {
    debug(event: string, data?: Record<string, unknown>) { this.write("debug", event, data) },
    info(event: string, data?: Record<string, unknown>) { this.write("info", event, data) },
    warn(event: string, data?: Record<string, unknown>) { this.write("warn", event, data) },
    error(event: string, _error?: unknown, data?: Record<string, unknown>) { this.write("error", event, data) },
    child(bindings: Record<string, unknown>) {
      return createTestRuntimeLogger({ ...opts, bindings: { ...opts.bindings, ...bindings } })
    },
    isEnabled() { return true },
    write(level: string, event: string, data?: Record<string, unknown>) {
      records.push(JSON.stringify({ ts: new Date().toISOString(), level, event, ...opts.bindings, ...data }) + "\n")
    },
    flush() {
      if (records.length > 0) {
        writeFileSync(opts.filePath, records.join(""), { flag: "a" })
        records.length = 0
      }
      return Promise.resolve()
    },
  }
}

describe("LspLogger", () => {
  const tmpDir = join(tmpdir(), "lsp-logger-test-" + Date.now())
  let logPath: string
  let logger: ReturnType<typeof createTestRuntimeLogger>
  let lspLogger: LspLogger

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true })
    logPath = join(tmpDir, "lsp.log")
    logger = createTestRuntimeLogger({ filePath: logPath, level: "debug", bindings: { sessionId: "test-session" } })
    lspLogger = createLspLogger(logger, {
      sessionId: "test-session",
      submitId: "submit-1",
      toolCallId: "tc-1",
    })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function readLogs(): string[] {
    if (!existsSync(logPath)) return []
    return readFileSync(logPath, "utf8").split("\n").filter(Boolean)
  }

  function parseLog(line: string): Record<string, unknown> {
    return JSON.parse(line)
  }

  it("logs server start with correct fields", () => {
    lspLogger.serverStart("typescript", "/workspace", "typescript-language-server")
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.event).toBe("lsp.server.start")
      expect(log.language).toBe("typescript")
      expect(log.workspaceRoot).toBe("/workspace")
      expect(log.command).toBe("typescript-language-server")
      expect(log.sessionId).toBe("test-session")
      expect(log.submitId).toBe("submit-1")
      expect(log.toolCallId).toBe("tc-1")
    })
  })

  it("logs server ready with pid and uptime", () => {
    lspLogger.serverReady("typescript", "/workspace", 12345, 150)
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.event).toBe("lsp.server.ready")
      expect(log.pid).toBe(12345)
      expect(log.uptimeMs).toBe(150)
    })
  })

  it("logs server exit with code and signal", () => {
    lspLogger.serverExit("typescript", "/workspace", 0, null)
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.event).toBe("lsp.server.exit")
      expect(log.code).toBe(0)
      expect(log.signal).toBeNull()
    })
  })

  it("logs server restart with reason", () => {
    lspLogger.serverRestart("typescript", "/workspace", "crash")
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.event).toBe("lsp.server.restart")
      expect(log.reason).toBe("crash")
    })
  })

  it("logs request start with method, language, filePath", () => {
    lspLogger.requestStart("textDocument/hover", "typescript", "src/index.ts")
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.event).toBe("lsp.request.start")
      expect(log.method).toBe("textDocument/hover")
      expect(log.language).toBe("typescript")
      expect(log.filePath).toBe("src/index.ts")
    })
  })

  it("logs request done with duration and result count", () => {
    lspLogger.requestDone("textDocument/hover", "typescript", "src/index.ts", 42, 1)
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.event).toBe("lsp.request.done")
      expect(log.durationMs).toBe(42)
      expect(log.resultCount).toBe(1)
    })
  })

  it("logs request timeout with timeout ms", () => {
    lspLogger.requestTimeout("textDocument/hover", "typescript", "src/index.ts", 5000)
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.event).toBe("lsp.request.timeout")
      expect(log.timeoutMs).toBe(5000)
    })
  })

  it("logs document open with version", () => {
    lspLogger.documentOpen("src/index.ts", "typescript", 1)
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.event).toBe("lsp.document.open")
      expect(log.version).toBe(1)
    })
  })

  it("logs document change with version", () => {
    lspLogger.documentChange("src/index.ts", "typescript", 2)
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.event).toBe("lsp.document.change")
      expect(log.version).toBe(2)
    })
  })

  it("child inherits context and adds overrides", () => {
    const child = lspLogger.child({ lspServerId: "ts-1", requestId: "req-1" })
    child.requestStart("textDocument/hover", "typescript", "src/index.ts")
    return logger.flush().then(() => {
      const lines = readLogs()
      expect(lines.length).toBe(1)
      const log = parseLog(lines[0])
      expect(log.sessionId).toBe("test-session")
      expect(log.submitId).toBe("submit-1")
      expect(log.toolCallId).toBe("tc-1")
      expect(log.lspServerId).toBe("ts-1")
      expect(log.requestId).toBe("req-1")
    })
  })

  it("does not log source code content", () => {
    const code = 'const secret = "password123"'
    lspLogger.documentOpen("src/index.ts", "typescript", 1)
    return logger.flush().then(() => {
      const lines = readLogs()
      const log = parseLog(lines[0])
      expect(log).not.toHaveProperty("content")
      expect(log).not.toHaveProperty("text")
      expect(log).not.toHaveProperty("source")
    })
  })

  it("only logs path, language, duration, result count", () => {
    lspLogger.requestDone("textDocument/hover", "typescript", "src/index.ts", 42, 3)
    return logger.flush().then(() => {
      const lines = readLogs()
      const log = parseLog(lines[0])
      const keys = Object.keys(log).sort()
      expect(keys).toContain("event")
      expect(keys).toContain("language")
      expect(keys).toContain("filePath")
      expect(keys).toContain("durationMs")
      expect(keys).toContain("resultCount")
      expect(keys).toContain("sessionId")
      expect(keys).toContain("submitId")
      expect(keys).toContain("toolCallId")
      expect(keys).toContain("ts")
      expect(keys).toContain("level")
    })
  })
})
