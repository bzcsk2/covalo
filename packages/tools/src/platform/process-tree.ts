import { spawn, type ChildProcess } from "node:child_process"
import { normalizePlatform } from "./capabilities.js"
import type { SupportedPlatform } from "./shell-backend.js"

export function spawnProcess(
  command: string,
  args: string[],
  options: Parameters<typeof spawn>[2] = {},
  platform: SupportedPlatform = normalizePlatform(),
): ChildProcess {
  return spawn(command, args, { ...options, detached: options.detached ?? platform !== "win32" })
}

export function terminateProcessTree(child: ChildProcess, force = false, platform: SupportedPlatform = normalizePlatform()): void {
  if (!child.pid) return
  if (platform === "win32") {
    // On Windows, taskkill /T without /F sends WM_CLOSE which only works for
    // GUI apps.  Console processes (like most MCP servers) will never exit,
    // so we always use /F to guarantee termination.  The `force` parameter
    // is not meaningful on Windows; it exists for Unix SIGTERM vs SIGKILL.
    const args = ["/PID", String(child.pid), "/T", "/F"]
    const killer = spawn("taskkill.exe", args, { stdio: "ignore" })
    killer.on("error", () => { try { child.kill() } catch {} })
    return
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM")
  } catch {
    try { child.kill(force ? "SIGKILL" : "SIGTERM") } catch {}
  }
}
