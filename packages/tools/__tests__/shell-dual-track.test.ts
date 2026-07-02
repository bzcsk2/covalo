import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  BackgroundTaskManager,
  getBackgroundTaskManagerFor,
  disposeBackgroundTaskManagerFor,
  __resetBackgroundTaskManagers,
} from "../src/shell-dual-track/background-task-manager.js"
import { createDualTrackBashTool, sleepCommand, spawnTestShell } from "../src/shell-dual-track/bash-dual-track.js"
import { createBashTool } from "../src/shell-exec.js"

function makeCtx(cwd: string) {
  return { cwd, sessionId: "test-session", signal: new AbortController().signal } as const
}

describe("BackgroundTaskManager.adopt", () => {
  let workDir: string
  let mgr: BackgroundTaskManager

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "drf32-adopt-"))
    mgr = new BackgroundTaskManager(workDir, "adopt-test")
  })

  afterEach(() => {
    mgr.dispose()
  })

  it("adopts a running child and returns taskId", async () => {
    const child = spawnTestShell(sleepCommand(2), workDir)
    const result = mgr.adopt(child, {
      command: "sleep 2",
      label: "sleep test",
      prefixOutput: "prior line 1\nprior line 2",
      hardTimeoutMs: 60_000,
      backend: "bash",
      reason: "soft_timeout",
    })

    expect(result.taskId).toMatch(/^bg_/)
    expect(result.error).toBeUndefined()

    const status = mgr.getStatus(result.taskId)
    expect(status?.status).toBe("running")

    const out = mgr.getOutput(result.taskId, 100)
    expect(out).toMatch(/prior line/)

    await new Promise((r) => setTimeout(r, 4_000))
    const finalStatus = mgr.getStatus(result.taskId)
    expect(["completed", "failed"]).toContain(finalStatus?.status)
  }, 15_000)

  it("getOutputSince returns incremental cursor", async () => {
    const child = spawnTestShell("echo line1 && echo line2", workDir)
    const result = mgr.adopt(child, {
      command: "echo test",
      hardTimeoutMs: 60_000,
      backend: "bash",
    })
    expect(result.taskId).toBeTruthy()

    await new Promise((r) => setTimeout(r, 1_500))

    const first = mgr.getOutputSince(result.taskId, 0)
    expect(first).not.toBeNull()
    expect(first!.cursor).toBeGreaterThanOrEqual(0)

    const second = mgr.getOutputSince(result.taskId, first!.cursor)
    expect(second!.output).toBe("")
    expect(second!.cursor).toBe(first!.cursor)
  }, 10_000)
})

describe("dual-track bash tool — background long commands", () => {
  let workDir: string

  beforeEach(() => {
    __resetBackgroundTaskManagers()
    workDir = mkdtempSync(join(tmpdir(), "drf32-bg-"))
  })

  afterEach(() => {
    __resetBackgroundTaskManagers()
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("starts npm test classified as long in background", async () => {
    const tool = createDualTrackBashTool()
    const r = await tool.execute({ command: "npm test" }, makeCtx(workDir) as any)
    expect(r.isError).toBe(false)
    const p = JSON.parse(r.content as string)
    expect(p.mode).toBe("background")
    expect(p.taskId).toMatch(/^bg_/)
    expect(p.classifiedAs).toBe("long")
  })

  it("list action returns running tasks", async () => {
    const tool = createDualTrackBashTool()
    const start = await tool.execute(
      { command: sleepCommand(30), background: true },
      makeCtx(workDir) as any,
    )
    const started = JSON.parse(start.content as string)
    expect(started.mode).toBe("background")

    const listed = await tool.execute({ action: "list" }, makeCtx(workDir) as any)
    const listParsed = JSON.parse(listed.content as string)
    expect(listParsed.tasks.length).toBeGreaterThanOrEqual(1)
    expect(listParsed.tasks.some((t: { taskId: string }) => t.taskId === started.taskId)).toBe(true)
  }, 15_000)

  it("check action with since cursor returns incremental output", async () => {
    const tool = createDualTrackBashTool()
    const start = await tool.execute(
      { command: sleepCommand(15), background: true },
      makeCtx(workDir) as any,
    )
    const started = JSON.parse(start.content as string)

    const check1 = await tool.execute(
      { action: "check", task_id: started.taskId, since: 0 },
      makeCtx(workDir) as any,
    )
    const c1 = JSON.parse(check1.content as string)
    expect(c1.mode).toBe("check")
    expect(typeof c1.cursor).toBe("number")

    const check2 = await tool.execute(
      { action: "check", task_id: started.taskId, since: c1.cursor },
      makeCtx(workDir) as any,
    )
    const c2 = JSON.parse(check2.content as string)
    expect(c2.cursor).toBeGreaterThanOrEqual(c1.cursor)
  }, 20_000)

  it("stop action kills running task", async () => {
    const tool = createDualTrackBashTool()
    const start = await tool.execute(
      { command: sleepCommand(30), background: true },
      makeCtx(workDir) as any,
    )
    const started = JSON.parse(start.content as string)

    const stopped = await tool.execute(
      { action: "stop", task_id: started.taskId },
      makeCtx(workDir) as any,
    )
    expect(stopped.isError).toBe(false)

    const check = await tool.execute(
      { action: "check", task_id: started.taskId },
      makeCtx(workDir) as any,
    )
    const c = JSON.parse(check.content as string)
    expect(c.status).toBe("killed")
  }, 15_000)
})

describe("dual-track bash tool — soft timeout escalate", () => {
  let workDir: string

  beforeEach(() => {
    __resetBackgroundTaskManagers()
    workDir = mkdtempSync(join(tmpdir(), "drf32-escalate-"))
  })

  afterEach(() => {
    __resetBackgroundTaskManagers()
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("escalates a 12s sleep to background after ~8s", async () => {
    const tool = createDualTrackBashTool()
    const start = Date.now()
    const r = await tool.execute({ command: sleepCommand(12) }, makeCtx(workDir) as any)
    const elapsed = Date.now() - start

    expect(r.isError).toBe(false)
    expect(elapsed).toBeGreaterThan(7_000)
    expect(elapsed).toBeLessThan(12_000)

    const p = JSON.parse(r.content as string)
    expect(p.mode).toBe("escalated")
    expect(p.taskId).toMatch(/^bg_/)
    expect(p.reason).toBe("soft_timeout")
  }, 20_000)

  it("does NOT escalate short echo command", async () => {
    const tool = createDualTrackBashTool()
    const start = Date.now()
    const r = await tool.execute({ command: "echo hello" }, makeCtx(workDir) as any)
    const elapsed = Date.now() - start

    expect(r.isError).toBe(false)
    expect(elapsed).toBeLessThan(3_000)
    const p = JSON.parse(r.content as string)
    expect(p.mode).toBe("foreground")
    expect(p.stdout.trim()).toBe("hello")
  })

  it("when background full, soft timeout does NOT escalate and command completes in foreground", async () => {
    // Fill background capacity with dummy tasks via the session's manager
    const mgr = getBackgroundTaskManagerFor("test-session", workDir)
    // Create 8 dummy child processes to fill MAX_CONCURRENT (8)
    const dummies: import("node:child_process").ChildProcess[] = []
    for (let i = 0; i < 8; i++) {
      const dummy = spawnTestShell(sleepCommand(30), workDir)
      dummies.push(dummy)
      mgr.adopt(dummy, {
        command: "dummy",
        label: `dummy-${i}`,
        hardTimeoutMs: 60_000,
        backend: "bash",
      })
    }

    const tool = createDualTrackBashTool()
    // A command that would normally escalate (auto classification)
    const start = Date.now()
    // Use timeout_ms to ensure it doesn't hang forever
    const r = await tool.execute(
      { command: "echo 'adopt failure test'", timeout_ms: 10_000 },
      makeCtx(workDir) as any,
    )
    const elapsed = Date.now() - start

    expect(r.isError).toBe(false)
    // Should complete in foreground since adopt was prevented
    expect(elapsed).toBeLessThan(5_000)
    const p = JSON.parse(r.content as string)
    expect(p.mode).toBe("foreground")
    expect(p.stdout).toContain("adopt failure test")

    // Cleanup dummies
    for (const d of dummies) {
      try { d.kill("SIGKILL") } catch { /* ignore */ }
    }
  }, 15_000)

  it("does NOT escalate when background:false is explicit", async () => {
    const tool = createDualTrackBashTool()
    const start = Date.now()
    const r = await tool.execute(
      { command: sleepCommand(3), background: false, timeout_ms: 10_000 },
      makeCtx(workDir) as any,
    )
    const elapsed = Date.now() - start

    expect(r.isError).toBe(false)
    expect(elapsed).toBeGreaterThan(2_500)
    const p = JSON.parse(r.content as string)
    expect(p.mode).toBe("foreground")
  }, 15_000)
})

describe("createBashTool dualTrack option", () => {
  it("createBashTool({ dualTrack: true }) returns dual-track tool", () => {
    const tool = createBashTool({ dualTrack: true })
    expect(tool.parameters.properties).toHaveProperty("action")
    expect(tool.parameters.properties).toHaveProperty("task_id")
  })

  it("createBashTool() default remains foreground-only", () => {
    const tool = createBashTool()
    expect(tool.parameters.properties).not.toHaveProperty("action")
  })

  it("dual-track bash delegates commands to sandboxProvider instead of host background", async () => {
    const tool = createBashTool({ dualTrack: true })
    const calls: any[] = []
    const sandboxProvider = {
      id: "bwrap",
      async canRun() {
        return { available: true, official: true, providerId: "bwrap" }
      },
      async run(input: any) {
        calls.push(input)
        return { stdout: "dual-sandbox-ok\n", stderr: "", exitCode: 0, timedOut: false }
      },
    }
    const r = await tool.execute(
      { command: "sleep 10", background: true },
      { cwd: process.cwd(), sessionId: "dual-sandbox-test", signal: new AbortController().signal, sandboxProvider } as any,
    )
    const p = JSON.parse(r.content as string)
    expect(r.isError).toBe(false)
    expect(calls).toHaveLength(1)
    expect(p.mode).toBe("foreground")
    expect(p.backend).toBe("sandbox")
    expect(p.stdout.trim()).toBe("dual-sandbox-ok")
  })
})

// P1-fix: disposeBackgroundTaskManagerFor 回归测试
describe("P1-fix: disposeBackgroundTaskManagerFor", () => {
  beforeEach(() => {
    __resetBackgroundTaskManagers()
  })

  afterEach(() => {
    __resetBackgroundTaskManagers()
  })

  it("disposes existing manager and removes it from cache", () => {
    const workDir = mkdtempSync(join(tmpdir(), "p1-dispose-"))
    const sessionId = "p1-dispose-test"
    // 通过 getBackgroundTaskManagerFor 创建实例
    const mgr = getBackgroundTaskManagerFor(sessionId, workDir)
    expect(mgr).toBeDefined()
    // 再次获取应返回同一实例
    expect(getBackgroundTaskManagerFor(sessionId, workDir)).toBe(mgr)

    // dispose 后再获取应返回新实例
    disposeBackgroundTaskManagerFor(sessionId)
    const mgr2 = getBackgroundTaskManagerFor(sessionId, workDir)
    expect(mgr2).not.toBe(mgr)

    rmSync(workDir, { recursive: true, force: true })
  })

  it("is a no-op when session has no manager (does not create new instance)", () => {
    // session 从未创建过 manager
    disposeBackgroundTaskManagerFor("never-existed-session")
    // 不应抛错，也不应在缓存中创建条目
    // 验证：getBackgroundTaskManagerFor 后应返回全新实例（而非被 dispose 留下的）
    const workDir = mkdtempSync(join(tmpdir(), "p1-noop-"))
    const mgr = getBackgroundTaskManagerFor("never-existed-session", workDir)
    expect(mgr).toBeDefined()
    expect(mgr.list()).toHaveLength(0)
    rmSync(workDir, { recursive: true, force: true })
  })
})
