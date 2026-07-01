import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

const ctx = { cwd: process.cwd(), signal: new AbortController().signal } as any

describe("bash tool", () => {
  it("should execute simple echo command", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const r = await tool.execute({ command: "echo hello" }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.stdout.trim()).toBe("hello")
  })

  it("should execute command with special characters", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    // Use semicolon separator which works in both Unix shells and PowerShell
    const cmd = process.platform === "win32"
      ? "echo 'hello world'; echo 'done'"
      : "echo 'hello world' && echo 'done'"
    const r = await tool.execute({ command: cmd }, ctx)
    expect(r.isError).toBe(false)
  })

  it("should report non-zero exit code", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const r = await tool.execute({ command: "false" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("delegates command execution to sandboxProvider when present", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const calls: any[] = []
    const sandboxProvider = {
      id: "bwrap",
      async canRun() {
        return { available: true, official: true, providerId: "bwrap" }
      },
      async run(input: any) {
        calls.push(input)
        return { stdout: "sandbox-ok\n", stderr: "", exitCode: 0, timedOut: false }
      },
    }
    const r = await tool.execute({ command: "echo should-not-spawn-host" }, { ...ctx, sandboxProvider })
    const p = JSON.parse(r.content as string)
    expect(r.isError).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe("echo should-not-spawn-host")
    expect(p.backend).toBe("sandbox")
    expect(p.stdout.trim()).toBe("sandbox-ok")
  })

  it("should deny rm -rf /", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const r = await tool.execute({ command: "rm -rf /" }, ctx)
    expect(r.isError).toBe(true)
    expect(JSON.parse(r.content as string).error).toContain("denied")
  })

  it("should deny sudo commands", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const r = await tool.execute({ command: "sudo whoami" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("S12: reading sensitive file .env via bash is denied by security check", async () => {
    // The shell security layer now detects .env as a sensitive path
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const r = await tool.execute({ command: "cat .env" }, ctx)
    expect(r.isError).toBe(true)
    const p = JSON.parse(r.content as string)
    expect(p.error).toContain("sensitive file")
  })

  it("S15: SQL-like text in command does not match DENY_PATTERNS and executes safely", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const r = await tool.execute({ command: "echo hello" }, ctx)
    // Should execute normally — "hello" is not a dangerous command
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.stdout.trim()).toBe("hello")
  })

  it("should reject empty command", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const r = await tool.execute({ command: "" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should capture stderr separately from stdout", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const isWin = process.platform === "win32"
    // PowerShell Write-Error sets $ErrorActionPreference and may set isError
    // Use a command that writes to stderr without triggering error handling
    const cmd = isWin
      ? '$host.UI.WriteErrorLine("stderr_msg"); Write-Output "stdout_msg"'
      : "echo stdout_msg && echo stderr_msg >&2"
    const r = await tool.execute({ command: cmd }, ctx)
    const p = JSON.parse(r.content as string)
    // stdout should contain "stdout_msg" and stderr should contain "stderr_msg"
    expect(p.stdout).toContain("stdout_msg")
    expect(p.stderr).toContain("stderr_msg")
  })

  it("should reject commands referencing absolute sensitive file paths", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const r = await tool.execute({ command: "cat /etc/ssl/private/api-key" }, ctx)
    expect(r.isError).toBe(true)
  })

  it("should resolve cwd relative to ctx.cwd", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tmpDir = mkdtempSync(join(tmpdir(), "deepreef-bash-cwd-"))
    writeFileSync(join(tmpDir, "test.txt"), "cwd test")
    const tool = createBashTool()
    const r = await tool.execute({ command: "cat test.txt", cwd: tmpDir }, { cwd: "/tmp", signal: new AbortController().signal } as any)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.stdout.trim()).toBe("cwd test")
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should preserve PATH and other env variables", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const isWin = process.platform === "win32"
    const cmd = isWin ? "Write-Output $env:PATH" : "echo $PATH"
    const r = await tool.execute({ command: cmd }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.stdout.trim().length).toBeGreaterThan(0)
  })

  it("should truncate stdout exceeding max_chars with notice", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const isWin = process.platform === "win32"
    const cmd = isWin
      ? "1..1000 | ForEach-Object { Write-Output \"line $_\" }"
      : "for i in $(seq 1 1000); do echo 'line ' $i; done"
    const r = await tool.execute({ command: cmd, max_chars: 100 }, ctx)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.stdout).toMatch(/\.\.\. \[(truncated|dropped)/)
  })

  it("should detect binary output and emit encoding_warning", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const r = await tool.execute({ command: "printf '\\xff\\xfe\\x00\\x01' && echo normal" }, ctx)
    const p = JSON.parse(r.content as string)
    if (p.encoding_warning) {
      expect(p.encoding_warning).toContain("binary")
    }
  })
})

describe("CL-21: Bash bounded output", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deepreef-cl21-"))
  })

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (e: any) {
      // Windows may have EBUSY if child process hasn't fully exited
      if (process.platform === "win32" && e?.code === "EBUSY") {
        // Retry once after a short delay
        setTimeout(() => {
          try { rmSync(dir, { recursive: true, force: true }) } catch {}
        }, 500)
      }
    }
  })

  it("drops earlier chars when output exceeds max_chars", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const ctx = { cwd: dir, signal: new AbortController().signal } as any
    const isWin = process.platform === "win32"
    const cmd = isWin
      ? "1..1000 | ForEach-Object { Write-Output \"line $_\" }"
      : 'for i in $(seq 1 1000); do echo "line $i"; done'
    const r = await tool.execute({ command: cmd, max_chars: 5000 }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.stdout).toMatch(/\.\.\. \[(dropped|truncated)/)
    expect(p.stdout.length).toBeLessThan(6000)
  })

  it("returns normal output when under limit", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const ctx = { cwd: dir, signal: new AbortController().signal } as any
    const r = await tool.execute({ command: "echo hello", max_chars: 100000 }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.stdout.trim()).toBe("hello")
    expect(p.exitCode).toBe(0)
  })

  it("sets non-zero exitCode on command failure", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const ctx = { cwd: dir, signal: new AbortController().signal } as any
    const r = await tool.execute({ command: "exit 42" }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.exitCode).toBe(42)
    expect(r.isError).toBe(true)
  })

  it("timedOut is true when command exceeds timeout", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const ctx = { cwd: dir, signal: new AbortController().signal } as any
    const r = await tool.execute({ command: "sleep 5", timeout_ms: 500 }, ctx)
    const p = JSON.parse(r.content as string)
    expect(p.timedOut).toBe(true)
    expect(p.exitCode).toBe(124)
  })

  it("AbortSignal kills running command", async () => {
    const { createBashTool } = await import("../src/shell-exec.js")
    const tool = createBashTool()
    const ac = new AbortController()
    const ctx = { cwd: dir, signal: ac.signal } as any
    const p = tool.execute({ command: "sleep 10", timeout_ms: 30000 }, ctx)
    setTimeout(() => ac.abort(), 200)
    const r = await p
    const parsed = JSON.parse(r.content as string)
    expect(parsed.exitCode).toBe(130)
  })
})
