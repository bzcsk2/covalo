import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { initDefaultProviders, diagnoseEnvironment } from "@covalo/core"
import { resolveEvalEnvironment } from "@covalo/core/sandbox/types.js"
import {
  ensureTool,
  isToolInstalled,
  getInstalledVersion,
  getToolchainInfo,
  getToolManifest,
  cleanToolchain,
  getBenchmarkToolchainStatus,
} from "@covalo/core/eval/profile/index.js"

interface ToolCheck {
  name: string
  found: boolean
  version?: string
  path?: string
  source?: "managed" | "host" | "fallback" | "missing"
  expected?: string
}

/**
 * Tier 1a: 平台感知的工具探测。
 *
 * 之前 `command -v ${name} 2>/dev/null` 是 POSIX shell 内建命令，Windows 下 spawnSync
 * 默认走 cmd.exe，根本不认识 `command -v`，导致 `covalo eval doctor` 在 Windows 上
 * 全部报 missing — 即便用户机器上装了 node/bun/git。
 *
 * 现在：
 * - POSIX 用 `command -v`，stderr 重定向到 /dev/null
 * - Windows 用 `where`（cmd.exe 内建），stderr 重定向到 nul
 * - Windows 上额外尝试 `${name}.exe` 后缀（where 通常自动处理，显式再试一次以兼容少数情况）
 */
function findOnPath(name: string): string | null {
  const isWin = process.platform === "win32"
  const cmd = isWin ? `where ${name} 2>nul` : `command -v ${name} 2>/dev/null`
  try {
    const out = execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).toString().trim().split(/\r?\n/)[0]
    return out || null
  } catch {
    return null
  }
}

async function checkTool(name: string, expected?: string): Promise<ToolCheck> {
  const isWin = process.platform === "win32"
  const probeName = isWin ? `${name}.exe` : name
  const out = findOnPath(probeName) ?? findOnPath(name)
  if (!out) return { name, found: false, source: "missing", expected }
  let version = ""
  try {
    const v = execSync(`"${out}" --version`, { encoding: "utf-8", stdio: "pipe" }).toString().trim()
    version = v.split("\n")[0] ?? ""
  } catch {}
  return { name, found: true, version: version || "ok", path: out, source: "host", expected }
}

function checkBwrap(): ToolCheck {
  // Tier 1a: Windows 下 bwrap 物理上不可用，短路返回 missing，避免走 Unix 路径检查误导。
  if (process.platform === "win32") {
    return { name: "bwrap", found: false, source: "missing", expected: "Linux only (or WSL bridge)" }
  }
  const paths = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", join(homedir(), ".covalo", "bin", "bwrap")]
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const v = execSync(`${p} --version 2>/dev/null`, { encoding: "utf-8", stdio: "pipe" }).toString().trim()
        return { name: "bwrap", found: true, version: v || "ok", path: p, source: "managed" }
      } catch {
        return { name: "bwrap", found: true, path: p, source: "managed" }
      }
    }
  }
  try {
    const out = execSync("command -v bwrap 2>/dev/null", { encoding: "utf-8", stdio: "pipe" }).toString().trim()
    if (out) {
      const v = execSync("bwrap --version 2>/dev/null", { encoding: "utf-8", stdio: "pipe" }).toString().trim()
      return { name: "bwrap", found: true, version: v || "ok", path: out, source: "host" }
    }
  } catch {}
  return { name: "bwrap", found: false, source: "missing", expected: "system or bundled" }
}


export async function evalDoctor(args: string[]): Promise<void> {
  const jsonOutput = args.includes("--json")
  initDefaultProviders()

  const toolchainInfo = getToolchainInfo()
  const benchmarkToolchainStatus = getBenchmarkToolchainStatus()

  const benchmarkDiag = await diagnoseEnvironment("sandbox.benchmark" as any)
  const localDiag = await diagnoseEnvironment("sandbox.local" as any)

  const benchmarkTools: ToolCheck[] = await Promise.all([
    checkBwrap(),
    checkTool("node", "22.17.0"),
    checkTool("bun", "1.3.1"),
    checkTool("python3"),
    checkTool("git", "2.45.x"),
    checkTool("rg", "14.1.1"),
    checkTool("jq", "1.7.1"),
  ])

  const localTools: ToolCheck[] = await Promise.all([
    checkTool("node"),
    checkTool("bun"),
    checkTool("python3"),
    checkTool("git"),
    checkTool("rg"),
    checkTool("jq"),
  ])

  // Merge managed toolchain info into the checks
  const managedToolNames = new Set(["node", "bun", "rg", "jq"])
  for (const t of benchmarkTools) {
    if (managedToolNames.has(t.name)) {
      const tc = toolchainInfo[t.name]
      if (tc?.installed) {
        t.found = true
        t.source = "managed"
        t.version = tc.version ?? t.version
        t.path = tc.path ?? t.path
      } else {
        // Reset host-found managed tools so officialScore requires managed install
        t.found = false
        t.source = "missing"
      }
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify({
      environments: {
        "sandbox.benchmark": {
          provider: benchmarkDiag,
          tools: benchmarkTools,
          toolchain: toolchainInfo,
          networkIsolation: benchmarkDiag.providerId === "bwrap",
          officialScore: benchmarkDiag.official && benchmarkToolchainStatus.ready,
          benchmarkToolchainStatus,
        },
        "sandbox.local": {
          provider: localDiag,
          tools: localTools,
          networkIsolation: localDiag.providerId === "bwrap",
          officialScore: false,
        },
      },
    }, null, 2))
    return
  }

  console.log("Covalo Eval Doctor\n")

  console.log("sandbox.benchmark:")
  console.log(`  provider:        ${benchmarkDiag.available ? benchmarkDiag.providerId : "unavailable"} ${benchmarkDiag.official ? "(official)" : "(diagnostic)"}`)
  for (const t of benchmarkTools) {
    const status = t.found ? (t.source === "managed" ? "installed" : "found") : "missing"
    const version = t.version ? ` ${t.version}` : ""
    const expected = t.expected ? ` (expected: ${t.expected})` : ""
    console.log(`  ${t.name.padEnd(20)} ${status}${version}${expected}`)
  }
  const canBenchmark = benchmarkDiag.official && benchmarkToolchainStatus.ready
  if (canBenchmark) {
    console.log(`  ${"agent network off".padEnd(20)} supported (bwrap)`)
  }
  console.log()

  console.log("sandbox.local:")
  console.log(`  provider:        ${localDiag.available ? localDiag.providerId : "unavailable"}`)
  for (const t of localTools) {
    const status = t.found ? `host ${t.version || ""}` : "missing" + (t.name === "rg" || t.name === "jq" ? " (optional)" : "")
    console.log(`  ${t.name.padEnd(20)} ${status}`)
  }
  console.log()

  if (!benchmarkDiag.available && !localDiag.available) {
    console.log("⚠ No sandbox provider available. Eval will not run.")
  } else {
    console.log(benchmarkDiag.official ? "✓ Official benchmark scoring available" : "⚠ Diagnostic mode only")
  }
}

export async function evalPrepare(args: string[]): Promise<void> {
  const target = args[0]
  if (!target || (target !== "sandbox.benchmark" && target !== "sandbox.local")) {
    console.error("Usage: covalo eval prepare <sandbox.benchmark|sandbox.local>")
    process.exit(1)
  }

  const envId = resolveEvalEnvironment(target)
  initDefaultProviders()

  const diag = await diagnoseEnvironment(envId)
  if (!diag.available) {
    console.error(`Environment ${envId} is not available: ${diag.reason ?? "no provider"}`)
    process.exit(1)
  }

  console.log(`Preparing ${envId}...\n`)

  if (envId === "sandbox.benchmark") {
    // 用 getBenchmarkToolchainStatus() 作为唯一真实状态来源，避免和它语义冲突。
    // 注意：仅靠 isToolInstalled(t.name) 判定 ready 是不够的 —— 在 Windows/macOS 上
    // SHA256 暂为空字符串时，工具文件存在但 getBenchmarkToolchainStatus().ready 仍是 false。
    const preStatus = getBenchmarkToolchainStatus()
    if (preStatus.ready) {
      console.log("✓ Benchmark toolchain ready at ~/.covalo/toolchains/benchmark-node/")
      return
    }

    // 找出文件层面缺失的工具（missingTools），这些才需要真正下载。
    // missingSha256 / versionMismatches 不算下载缺失，不影响"文件是否就位"。
    if (preStatus.missingTools.length === 0) {
      // 工具文件都到位但 status 仍非 ready —— 多半是 missingSha256 或 versionMismatches
      console.log("⚠ Managed toolchain files are present but benchmark-ready status is false:")
      if (preStatus.missingSha256.length > 0) {
        console.log(`  missing SHA256 for: ${preStatus.missingSha256.join(", ")}`)
      }
      if (preStatus.versionMismatches.length > 0) {
        console.log(`  version mismatches: ${preStatus.versionMismatches.map(v => `${v.name} expected ${v.expected}, got ${v.actual ?? "unknown"}`).join("; ")}`)
      }
      console.log("\nBenchmark scoring is NOT available until these are resolved.")
      return
    }

    const missingManaged = getToolManifest.filter((t) => preStatus.missingTools.includes(t.name))
    console.log(`Downloading ${missingManaged.length} missing tools...\n`)
    for (const entry of missingManaged) {
      console.log(`  [${entry.name}] ensuring ${entry.name}@${entry.pinnedVersion}...`)
      try {
        await ensureTool(entry.name)
        const version = getInstalledVersion(entry.name)
        console.log(`  ✓ ${entry.name}@${version ?? entry.pinnedVersion} installed`)
      } catch (e) {
        console.error(`  ✗ Failed: ${e instanceof Error ? e.message : e}`)
      }
    }

    // 安装后重新读取状态，统一从 status 派生结论，避免和 getBenchmarkToolchainStatus 冲突。
    const postStatus = getBenchmarkToolchainStatus()
    if (postStatus.ready) {
      console.log("\n✓ Benchmark toolchain ready at ~/.covalo/toolchains/benchmark-node/")
    } else {
      if (postStatus.missingTools.length > 0) {
        console.log(`\n⚠ ${postStatus.missingTools.length} tool(s) still missing: ${postStatus.missingTools.join(", ")}`)
      }
      if (postStatus.missingSha256.length > 0) {
        console.log(`⚠ Installed but missing SHA256 (not benchmark-ready): ${postStatus.missingSha256.join(", ")}`)
      }
      if (postStatus.versionMismatches.length > 0) {
        console.log(`⚠ Version mismatches: ${postStatus.versionMismatches.map(v => `${v.name} expected ${v.expected}, got ${v.actual ?? "unknown"}`).join("; ")}`)
      }
      console.log("\nBenchmark scoring is NOT available until all of the above are resolved.")
    }
  }

  if (envId === "sandbox.local") {
    const tools = await Promise.all([
      checkTool("node"),
      checkTool("bun"),
      checkTool("python3"),
      checkTool("git"),
    ])
    const missing = tools.filter(t => !t.found)
    if (missing.length > 0) {
      console.log("Missing required tools for sandbox.local:")
      for (const t of missing) {
        console.log(`  - ${t.name}`)
      }
      console.log()
      console.log("Install missing tools via your package manager and try again.")
    } else {
      console.log("✓ All required local tools are available on PATH.")
    }
    console.log()
    console.log("Environment ready for diagnostic eval runs.")
  }
}

export async function evalCleanToolchains(args: string[]): Promise<void> {
  const force = args.includes("--force")
  if (!force) {
    console.log("This will remove all managed toolchains at ~/.covalo/toolchains/")
    console.log("Run with --force to confirm.")
    return
  }
  cleanToolchain()
  console.log("✓ Managed toolchain removed")
}

export async function evalCommand(subcommand: string, args: string[]): Promise<void> {
  switch (subcommand) {
    case "doctor":
      await evalDoctor(args)
      break
    case "prepare":
      await evalPrepare(args)
      break
    case "clean-toolchains":
      await evalCleanToolchains(args)
      break
    default:
      console.log(`Usage:
  covalo eval doctor [--json]           Check eval environment health
  covalo eval prepare <env>             Prepare an eval environment
  covalo eval clean-toolchains [--force] Remove managed toolchains
`)
  }
}
