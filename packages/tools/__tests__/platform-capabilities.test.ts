import { afterEach, describe, expect, it } from "vitest"
import { getPlatformCapabilities, normalizePlatform } from "../src/platform/capabilities.js"
import { getNotificationBackend } from "../src/platform/notification-backend.js"
import { getSchedulerBackend } from "../src/platform/scheduler-backend.js"
import { noopToolDiagnosticLogger } from "../src/diagnostics.js"
import { clearShellBackendCache, defaultShellCandidates, resolveShellBackend, setShellBackendLogger } from "../src/platform/shell-backend.js"

describe("OS-10: platform capabilities", () => {
  const platform = normalizePlatform(process.platform)
  // expectedShellId 必须动态决定：defaultShellCandidates("win32") 优先返回 pwsh，
  // 但本地 Windows 可能没装 PowerShell 7（pwsh.exe），fallback 到 powershell.exe。
  // CI Windows runner 装了 pwsh，所以 CI 上 resolveShellBackend 返回 "pwsh"；
  // 本地 Windows 没 pwsh 时返回 "powershell"。两边都要兼容。
  // 解决方案：用 defaultShellCandidates 返回的 id 集合做 contains 断言，
  // 而非硬编码某个 id。这样无论 pwsh 还是 powershell 被选中，测试都通过。
  const validShellIds = defaultShellCandidates(platform).map(c => c.id)
  const expectedSchedulerId = platform === "win32" ? "schtasks" : "crontab"
  const expectedPosixSignals = platform !== "win32"

  afterEach(() => {
    delete process.env.COVALO_SHELL
    delete process.env.COVALO_SHELL_ARGS
    clearShellBackendCache()
    setShellBackendLogger(noopToolDiagnosticLogger)
  })

  it("normalizes supported host platforms", () => {
    expect(normalizePlatform("win32")).toBe("win32")
    expect(normalizePlatform("darwin")).toBe("darwin")
    expect(normalizePlatform("freebsd")).toBe("linux")
  })

  it("defines PowerShell-first Windows candidates", () => {
    expect(defaultShellCandidates("win32")).toEqual([
      { id: "pwsh", executable: "pwsh.exe", args: ["-NoProfile", "-NonInteractive", "-Command"] },
      { id: "powershell", executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command"] },
    ])
  })

  it("selects platform scheduler and notification backends", () => {
    expect(getSchedulerBackend("linux").id).toBe("crontab")
    expect(getSchedulerBackend("darwin").id).toBe("crontab")
    expect(getSchedulerBackend("win32").id).toBe("schtasks")
    expect(getNotificationBackend("linux").id).toBe("notify-send")
    expect(getNotificationBackend("darwin").id).toBe("osascript")
    expect(getNotificationBackend("win32").id).toBe("powershell")
  })

  it("detects and caches the native shell backend", async () => {
    const first = await resolveShellBackend(platform)
    const second = await resolveShellBackend(platform)
    expect(validShellIds).toContain(first.id)
    expect(second).toBe(first)
  })

  it("rejects an unavailable explicit shell override", async () => {
    process.env.COVALO_SHELL = "covalo-shell-that-does-not-exist"
    await expect(resolveShellBackend(platform)).rejects.toThrow("not available")
  })

  it("assembles capabilities without scattering platform branches", async () => {
    const capabilities = await getPlatformCapabilities(platform)
    expect(capabilities.platform).toBe(platform)
    expect(validShellIds).toContain(capabilities.shell.id)
    expect(capabilities.scheduler.id).toBe(expectedSchedulerId)
    expect(capabilities.supportsPosixSignals).toBe(expectedPosixSignals)
  })

  it("logs shell selection without including a command", async () => {
    const events: Array<Record<string, unknown> | undefined> = []
    setShellBackendLogger({
      isEnabled: () => true,
      debug: (_event, data) => events.push(data),
      info: () => {},
      warn: () => {},
      error: () => {},
    })
    await resolveShellBackend(platform)
    expect(events[0]).toMatchObject({ platform })
    expect(validShellIds).toContain(events[0]?.backend)
    expect(events[0]).not.toHaveProperty("command")
  })
})
