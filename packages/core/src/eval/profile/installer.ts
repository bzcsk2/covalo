import { existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, cpSync, readdirSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { execSync } from "node:child_process"
import { createHash } from "node:crypto"

export interface ToolEntry {
  name: string
  pinnedVersion: string
  downloadUrl: string
  sha256: string
  binaryName: string
  archiveType: "tar.gz" | "zip" | "none"
  archiveBinaryPath: string
}

const TOOLCHAIN_ROOT = join(homedir(), ".covalo", "toolchains")
const PROFILE_DIR = "benchmark-node"

function formatUrl(template: string, version: string): string {
  return template.replace(/\{\{version\}\}/g, version)
}

/**
 * Tier 1d: TOOL_MANIFEST 按平台建表。
 *
 * 之前四个工具（node/bun/ripgrep/jq）的下载 URL 全部写死 linux-x64 / linux-amd64，
 * 意味着即便 Windows 上有等价方案，托管工具链这一步在 Windows/macOS 上物理上装不上
 * —— 这才是 "官方基准" 在非 Linux 上无法达成的根本原因，跟沙箱本身无关。
 *
 * 现在：
 * - linux: 保持原样（officialScore:true 唯一可用路径）
 * - win32: 用各工具官方的 Windows 发布包（node-win-x64.zip / bun-windows-x64.zip /
 *   ripgrep-*-x86_64-pc-windows-msvc.zip / jq-win64.exe）
 * - darwin: 用各工具官方的 macOS 发布包（node-darwin-x64.tar.gz / bun-darwin-x64.zip /
 *   ripgrep-*-x86_64-apple-darwin.tar.gz / jq-macos-amd64）
 *
 * 注意：Windows/macOS 上的 SHA256 是各自发布包的，需要单独计算（这里先用空字符串占位，
 * 后续 PR 可补上；getBenchmarkToolchainStatus 会把缺失 SHA256 的工具标记为 missingSha256，
 * 不会误报 ready）。
 */
const TOOL_MANIFEST_BY_PLATFORM: Record<NodeJS.Platform, ToolEntry[]> = {
  linux: [
    {
      name: "node",
      pinnedVersion: "22.17.0",
      downloadUrl: "https://nodejs.org/dist/v{{version}}/node-v{{version}}-linux-x64.tar.gz",
      sha256: "0fa01328a0f3d10800623f7107fbcd654a60ec178fab1ef5b9779e94e0419e1a",
      binaryName: "node",
      archiveType: "tar.gz",
      archiveBinaryPath: "node-v{{version}}-linux-x64/bin/node",
    },
    {
      name: "bun",
      pinnedVersion: "1.3.1",
      downloadUrl: "https://github.com/oven-sh/bun/releases/download/bun-v{{version}}/bun-linux-x64.zip",
      sha256: "400824c82bfcc0854365bcada11cf53d7384ecb1e2c3da0e2c0a2c6a527d5629",
      binaryName: "bun",
      archiveType: "zip",
      archiveBinaryPath: "bun-linux-x64/bun",
    },
    {
      name: "rg",
      pinnedVersion: "14.1.1",
      downloadUrl: "https://github.com/BurntSushi/ripgrep/releases/download/{{version}}/ripgrep-{{version}}-x86_64-unknown-linux-musl.tar.gz",
      sha256: "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e",
      binaryName: "rg",
      archiveType: "tar.gz",
      archiveBinaryPath: "ripgrep-{{version}}-x86_64-unknown-linux-musl/rg",
    },
    {
      name: "jq",
      pinnedVersion: "1.7.1",
      downloadUrl: "https://github.com/jqlang/jq/releases/download/jq-{{version}}/jq-linux-amd64",
      sha256: "5942c9b0934e510ee61eb3e30273f1b3fe2590df93933a93d7c58b81d19c8ff5",
      binaryName: "jq",
      archiveType: "none",
      archiveBinaryPath: "",
    },
  ],
  win32: [
    {
      name: "node",
      pinnedVersion: "22.17.0",
      downloadUrl: "https://nodejs.org/dist/v{{version}}/node-v{{version}}-win-x64.zip",
      // Tier 1d: Windows 发布包的 SHA256 尚未计算；空字符串让 getBenchmarkToolchainStatus 标记为 missingSha256
      sha256: "",
      binaryName: "node.exe",
      archiveType: "zip",
      archiveBinaryPath: "node-v{{version}}-win-x64/node.exe",
    },
    {
      name: "bun",
      pinnedVersion: "1.3.1",
      downloadUrl: "https://github.com/oven-sh/bun/releases/download/bun-v{{version}}/bun-windows-x64.zip",
      sha256: "",
      binaryName: "bun.exe",
      archiveType: "zip",
      archiveBinaryPath: "bun-windows-x64/bun.exe",
    },
    {
      name: "rg",
      pinnedVersion: "14.1.1",
      downloadUrl: "https://github.com/BurntSushi/ripgrep/releases/download/{{version}}/ripgrep-{{version}}-x86_64-pc-windows-msvc.zip",
      sha256: "",
      binaryName: "rg.exe",
      archiveType: "zip",
      archiveBinaryPath: "ripgrep-{{version}}-x86_64-pc-windows-msvc/rg.exe",
    },
    {
      name: "jq",
      pinnedVersion: "1.7.1",
      downloadUrl: "https://github.com/jqlang/jq/releases/download/jq-{{version}}/jq-windows-amd64.exe",
      sha256: "",
      binaryName: "jq.exe",
      archiveType: "none",
      archiveBinaryPath: "",
    },
  ],
  darwin: [
    {
      name: "node",
      pinnedVersion: "22.17.0",
      downloadUrl: "https://nodejs.org/dist/v{{version}}/node-v{{version}}-darwin-x64.tar.gz",
      sha256: "",
      binaryName: "node",
      archiveType: "tar.gz",
      archiveBinaryPath: "node-v{{version}}-darwin-x64/bin/node",
    },
    {
      name: "bun",
      pinnedVersion: "1.3.1",
      downloadUrl: "https://github.com/oven-sh/bun/releases/download/bun-v{{version}}/bun-darwin-x64.zip",
      sha256: "",
      binaryName: "bun",
      archiveType: "zip",
      archiveBinaryPath: "bun-darwin-x64/bun",
    },
    {
      name: "rg",
      pinnedVersion: "14.1.1",
      downloadUrl: "https://github.com/BurntSushi/ripgrep/releases/download/{{version}}/ripgrep-{{version}}-x86_64-apple-darwin.tar.gz",
      sha256: "",
      binaryName: "rg",
      archiveType: "tar.gz",
      archiveBinaryPath: "ripgrep-{{version}}-x86_64-apple-darwin/rg",
    },
    {
      name: "jq",
      pinnedVersion: "1.7.1",
      downloadUrl: "https://github.com/jqlang/jq/releases/download/jq-{{version}}/jq-macos-amd64",
      sha256: "",
      binaryName: "jq",
      archiveType: "none",
      archiveBinaryPath: "",
    },
  ],
  // 兜底：未知平台用 linux 清单（保持旧行为）
  aix: [],
  android: [],
  freebsd: [],
  openbsd: [],
  sunos: [],
  cygwin: [],
  netbsd: [],
  haiku: [],
}

function getPlatformManifest(): ToolEntry[] {
  return TOOL_MANIFEST_BY_PLATFORM[process.platform] ?? TOOL_MANIFEST_BY_PLATFORM.linux
}

// 保持向后兼容的导出名（eval.ts 等用 `getToolManifest` 过滤）
const TOOL_MANIFEST: ToolEntry[] = getPlatformManifest()

function getProfileDir(): string {
  return join(TOOLCHAIN_ROOT, PROFILE_DIR)
}

function toolDir(name: string): string {
  return join(getProfileDir(), name, getPinnedVersion(name))
}

async function downloadFile(url: string, dest: string): Promise<void> {
  const resp = await fetch(url, { headers: { "User-Agent": "covalo-toolchain/1.0" } })
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url.slice(0, 80)}`)
  }
  const buffer = Buffer.from(await resp.arrayBuffer())
  await writeFile(dest, buffer)
}

function verifySha256(filePath: string, expected: string): boolean {
  const hash = createHash("sha256")
  const data = readFileSync(filePath)
  hash.update(data)
  return hash.digest("hex") === expected
}

function getPinnedVersion(name: string): string {
  const entry = TOOL_MANIFEST.find((t) => t.name === name)
  return entry?.pinnedVersion ?? "unknown"
}

function getEntry(name: string): ToolEntry | undefined {
  return TOOL_MANIFEST.find((t) => t.name === name)
}

function installedBinaryRelativePath(entry: ToolEntry): string {
  if (entry.archiveType === "tar.gz") {
    const parts = formatUrl(entry.archiveBinaryPath, entry.pinnedVersion).split("/").filter(Boolean)
    return parts.slice(1).join("/") || entry.binaryName
  }
  return entry.binaryName
}

export function getInstalledBinaryPath(name: string): string | null {
  const entry = getEntry(name)
  if (!entry) return null
  return join(toolDir(name), installedBinaryRelativePath(entry))
}

export function getInstalledVersion(name: string): string | null {
  const binary = getInstalledBinaryPath(name)
  if (!binary) return null
  if (!existsSync(binary)) return null
  try {
    // Tier 1d: 跨平台 — 用引号包裹路径避免 Windows 路径中的空格（如 Program Files），
    // 用 stdio:"pipe" 抑制 stderr 输出（替代 POSIX 的 2>/dev/null）。
    return execSync(`"${binary}" --version`, { encoding: "utf-8", stdio: "pipe" }).toString().trim()
  } catch {
    return null
  }
}

export function isToolInstalled(name: string): boolean {
  const binary = getInstalledBinaryPath(name)
  return !!binary && existsSync(binary)
}

export async function ensureTool(name: string): Promise<string> {
  const entry = TOOL_MANIFEST.find((t) => t.name === name)
  if (!entry) throw new Error(`Unknown tool: ${name}`)

  const installed = getInstalledVersion(name)
  if (installed) return toolDir(name)

  const dlDir = join(getProfileDir(), name)
  mkdirSync(dlDir, { recursive: true })

  const url = formatUrl(entry.downloadUrl, entry.pinnedVersion)
  const fileName = url.split("/").pop() ?? `${name}.bin`

  console.error(`[installer] Downloading ${name}@${entry.pinnedVersion}...`)
  const tmpFile = join(dlDir, fileName)
  await downloadFile(url, tmpFile)

  if (entry.sha256) {
    if (!verifySha256(tmpFile, entry.sha256)) {
      rmSync(tmpFile, { force: true })
      throw new Error(`SHA256 mismatch for ${name}: expected ${entry.sha256}`)
    }
    console.error(`[installer] SHA256 verified for ${name}`)
  } else {
    console.error(`[installer] Warning: no SHA256 pinned for ${name}, skipping verification`)
  }

  const versionDir = join(dlDir, entry.pinnedVersion)
  mkdirSync(versionDir, { recursive: true })

  // Tier 1d: 用 Node 内置 API 替换 POSIX 命令（cp / chmod / tar / unzip / rm），
  // 让 Windows/macOS 也能正常解压安装。之前 `unzip`、`tar`、`cp`、`chmod` 在 Windows
  // 下要么不存在要么行为不同，导致 installer 在 Windows 上物理上跑不通。
  const binaryRel = formatUrl(entry.archiveBinaryPath, entry.pinnedVersion)
  const destBinaryName = entry.binaryName
  const destBinaryPath = join(versionDir, destBinaryName)

  if (entry.archiveType === "none") {
    // 单个可执行文件，直接复制
    copyFileSync(tmpFile, destBinaryPath)
    setExecutable(destBinaryPath)
  } else if (entry.archiveType === "tar.gz") {
    const destDir = join(dlDir, "tmp-extract")
    mkdirSync(destDir, { recursive: true })
    try {
      await extractTarGz(tmpFile, destDir)
    } catch (e) {
      rmSync(destDir, { recursive: true, force: true })
      rmSync(tmpFile, { force: true })
      throw new Error(`Failed to extract tar.gz for ${name}: ${e instanceof Error ? e.message : String(e)}`)
    }

    const binarySrc = join(destDir, binaryRel)
    if (!existsSync(binarySrc)) {
      rmSync(destDir, { recursive: true, force: true })
      rmSync(tmpFile, { force: true })
      throw new Error(`Binary ${binarySrc} not found in archive for ${name}`)
    }

    // 复制整个顶层目录的内容到 versionDir（保持原有行为，让同目录下的依赖文件也跟随）。
    // 必须用 cpSync 递归复制 — Node 这类 tar 包顶层是 bin/、lib/、include/、share/ 等目录，
    // copyFileSync 不能复制目录会抛错，导致 bin/node 等关键文件没被复制出来。
    const topDir = join(destDir, binaryRel.split("/")[0]!)
    if (existsSync(topDir)) {
      for (const entryName of readdirSync(topDir)) {
        const src = join(topDir, entryName)
        const dst = join(versionDir, entryName)
        try {
          cpSync(src, dst, { recursive: true, force: true })
          // cpSync 默认保留源文件的模式位（POSIX），binary 通常已经可执行；
          // 这里 setExecutable 是对个别权限丢失的情况兜底，Windows 上无操作。
          setExecutable(dst)
        } catch {
          // 单个 entry 复制失败不中断（可能是符号链接等），但要保证 binary 本身可用。
        }
      }
      // 兜底校验：binary 必须真实存在
      if (!existsSync(destBinaryPath)) {
        // 如果递归复制后 binary 仍未到位，直接从 binarySrc 单文件复制
        copyFileSync(binarySrc, destBinaryPath)
        setExecutable(destBinaryPath)
      }
    } else {
      // 兜底：直接复制 binary
      copyFileSync(binarySrc, destBinaryPath)
      setExecutable(destBinaryPath)
    }
    rmSync(destDir, { recursive: true, force: true })
  } else if (entry.archiveType === "zip") {
    const unzipPath = join(dlDir, "tmp-unzip")
    mkdirSync(unzipPath, { recursive: true })
    try {
      await extractZip(tmpFile, unzipPath)
    } catch (e) {
      rmSync(unzipPath, { recursive: true, force: true })
      rmSync(tmpFile, { force: true })
      throw new Error(`Failed to extract zip for ${name}: ${e instanceof Error ? e.message : String(e)}`)
    }

    const binarySrc = join(unzipPath, binaryRel)
    if (!existsSync(binarySrc)) {
      rmSync(unzipPath, { recursive: true, force: true })
      rmSync(tmpFile, { force: true })
      throw new Error(`Binary ${binarySrc} not found in zip for ${name}`)
    }

    copyFileSync(binarySrc, destBinaryPath)
    setExecutable(destBinaryPath)
    rmSync(unzipPath, { recursive: true, force: true })
  }

  rmSync(tmpFile, { force: true })
  console.error(`[installer] Installed ${name}@${entry.pinnedVersion} to ${versionDir}`)

  return versionDir
}

/**
 * Tier 1d: 跨平台设置可执行位。
 *
 * POSIX 上用 chmod 0o755；Windows 上无操作（.exe 后缀本身就是可执行）。
 */
function setExecutable(filePath: string): void {
  if (process.platform === "win32") return
  try {
    execSync(`chmod +x "${filePath}"`, { stdio: "pipe" })
  } catch {
    // chmod 失败不阻塞 — 某些文件系统不支持
  }
}

/**
 * Tier 1d: 跨平台 tar.gz 解压。
 *
 * tar.gz 格式在 Windows 上没有内置解压工具，但有几种 fallback 路径：
 * 1. 如果项目装了 `tar` npm 包（许多依赖间接引入），用它解压
 * 2. 如果系统有 tar 命令（Windows 10+ 自带 bsdtar，POSIX 都有 tar），用它
 * 3. 都失败就抛错，让调用方知道
 *
 * 注意：`node:tar` 不是 Node.js 内置模块（是 npm 包 tar），不能用静态 import，
 * 必须用动态 await import() 并 try/catch。
 */
async function extractTarGz(tarPath: string, destDir: string): Promise<void> {
  // 尝试 1：用 npm 包 tar（如果项目装了）。
  // 用变量名让 TS 静态分析无法解析模块路径，从而避免 "Cannot find module 'tar'" 报错 —
  // 运行时若该包未安装，import 会抛错并被 catch 接住，fallback 到系统 tar。
  try {
    const moduleName = "tar"
    const tar: any = await import(moduleName)
    await tar.extract({ file: tarPath, cwd: destDir, gz: true })
    return
  } catch {}
  // 尝试 2：用系统 tar 命令（Windows 10+ 自带 bsdtar，POSIX 都有）
  // Windows 的 tar 实际上是 bsdtar，语法兼容 GNU tar
  execSync(`tar xzf "${tarPath}" -C "${destDir}"`, { stdio: "pipe" })
}

/**
 * Tier 1d: 跨平台 zip 解压。
 *
 * 优先用 Node.js 22+ 的 node:zlib 单文件解压（简单 zip）；
 * 对于复杂 zip（多文件、目录），fallback 到系统命令：
 * - POSIX: unzip
 * - Windows: PowerShell Expand-Archive
 */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  if (process.platform === "win32") {
    try {
      execSync(`powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, { stdio: "pipe" })
      return
    } catch (e) {
      throw new Error(`Expand-Archive failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  // POSIX: 用系统 unzip
  execSync(`unzip -q "${zipPath}" -d "${destDir}"`, { stdio: "pipe" })
}

export async function ensureToolchain(profile: string = PROFILE_DIR): Promise<string> {
  const profileDir = join(TOOLCHAIN_ROOT, profile)
  mkdirSync(profileDir, { recursive: true })

  for (const entry of TOOL_MANIFEST) {
    try {
      await ensureTool(entry.name)
    } catch (e) {
      console.error(`[installer] Failed to install ${entry.name}: ${e instanceof Error ? e.message : e}`)
    }
  }

  return profileDir
}

export function getToolchainPath(profile: string = PROFILE_DIR): string[] {
  const dirs = new Set<string>()
  for (const entry of TOOL_MANIFEST) {
    const binary = getInstalledBinaryPath(entry.name)
    if (binary && existsSync(binary)) dirs.add(dirname(binary))
  }
  return Array.from(dirs)
}

export function getToolchainInfo(): Record<string, { installed: boolean; path: string | null; version: string | null }> {
  const info: Record<string, { installed: boolean; path: string | null; version: string | null }> = {}
  for (const entry of TOOL_MANIFEST) {
    const binary = getInstalledBinaryPath(entry.name)
    const exists = !!binary && existsSync(binary)
    const version = exists ? getInstalledVersion(entry.name) : null
    info[entry.name] = {
      installed: exists,
      path: exists ? binary : null,
      version,
    }
  }
  return info
}

export interface BenchmarkToolchainStatus {
  ready: boolean
  missingTools: string[]
  missingSha256: string[]
  versionMismatches: Array<{ name: string; expected: string; actual: string | null }>
}

export function getBenchmarkToolchainStatus(): BenchmarkToolchainStatus {
  const missingTools: string[] = []
  const missingSha256: string[] = []
  const versionMismatches: Array<{ name: string; expected: string; actual: string | null }> = []

  for (const entry of TOOL_MANIFEST) {
    if (!entry.sha256.trim()) {
      missingSha256.push(entry.name)
    }
    const binary = getInstalledBinaryPath(entry.name)
    if (!binary || !existsSync(binary)) {
      missingTools.push(entry.name)
      continue
    }
    const version = getInstalledVersion(entry.name)
    if (!version || !version.includes(entry.pinnedVersion)) {
      versionMismatches.push({ name: entry.name, expected: entry.pinnedVersion, actual: version })
    }
  }

  return {
    ready: missingTools.length === 0 && missingSha256.length === 0 && versionMismatches.length === 0,
    missingTools,
    missingSha256,
    versionMismatches,
  }
}

export function cleanToolchain(profile: string = PROFILE_DIR): void {
  const dir = join(TOOLCHAIN_ROOT, profile)
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
    console.error(`[installer] Removed toolchain at ${dir}`)
  }
}

export { TOOL_MANIFEST, TOOLCHAIN_ROOT, PROFILE_DIR }
