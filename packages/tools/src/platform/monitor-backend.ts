import { spawn } from "node:child_process"
import { freemem, totalmem } from "node:os"
import { normalizePlatform } from "./capabilities.js"
import type { SupportedPlatform } from "./shell-backend.js"

export function sampleMemory(): { backend: "node:os"; totalBytes: number; freeBytes: number; usedBytes: number } {
  const totalBytes = totalmem()
  const freeBytes = freemem()
  return { backend: "node:os", totalBytes, freeBytes, usedBytes: totalBytes - freeBytes }
}

export async function sampleProcesses(signal?: AbortSignal, platform: SupportedPlatform = normalizePlatform()): Promise<unknown> {
  if (platform === "win32") {
    const raw = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Process | Select-Object -First 20 Id,ProcessName,CPU,WorkingSet64 | ConvertTo-Json -Compress"], signal)
    return { backend: "powershell", processes: parseJsonArray(raw) }
  }
  const args = platform === "darwin" ? ["-axo", "pid=,comm=,%mem=,%cpu="] : ["-eo", "pid=,comm=,%mem=,%cpu=", "--sort=-%mem"]
  const raw = await run("ps", args, signal)
  const processes = raw.trim().split("\n").filter(Boolean).slice(0, 20).map(line => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)$/)
    return match ? { pid: Number(match[1]), command: match[2], memoryPercent: Number(match[3]), cpuPercent: Number(match[4]) } : { line }
  })
  return { backend: "ps", processes }
}

export async function sampleDisk(signal?: AbortSignal, platform: SupportedPlatform = normalizePlatform()): Promise<unknown> {
  if (platform === "win32") {
    // Use Get-CimInstance Win32_LogicalDisk instead of Get-PSDrive to avoid
    // enumerating potentially hung network drive providers.
    const raw = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,Size,FreeSpace | ConvertTo-Json -Compress"], signal)
    return { backend: "powershell", filesystems: parseJsonArray(raw) }
  }
  const raw = await run("df", ["-kP"], signal)
  const lines = raw.trim().split("\n").slice(1)
  return {
    backend: "df",
    filesystems: lines.map(line => {
      const parts = line.trim().split(/\s+/)
      return { filesystem: parts[0], totalKb: Number(parts[1]), usedKb: Number(parts[2]), availableKb: Number(parts[3]), capacity: parts[4], mount: parts.slice(5).join(" ") }
    }),
  }
}

function run(command: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { signal, timeout: 5_000 })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", chunk => { stdout += String(chunk) })
    proc.stderr.on("data", chunk => { stderr += String(chunk) })
    proc.once("error", reject)
    proc.once("close", code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with ${code}`)))
  })
}

function parseJsonArray(raw: string): unknown[] {
  const value = JSON.parse(raw || "[]")
  return Array.isArray(value) ? value : value ? [value] : []
}
