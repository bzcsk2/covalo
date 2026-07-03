import { access, constants } from "node:fs/promises"
import { accessSync } from "node:fs"
import { resolve, dirname, delimiter } from "node:path"
import { fileURLToPath } from "node:url"
import type { LspLanguageConfig } from "./config.js"

export interface ServerResolverResult {
  server: LspLanguageConfig
  source: "user-config" | "env" | "path" | "package-local" | "npx-fallback"
  available: boolean
  resolvedPath?: string
  installHint?: string
  configHint?: string
}

const INSTALL_HINTS: Record<string, string> = {
  typescript: "npm i -g typescript-language-server typescript",
  typescriptreact: "npm i -g typescript-language-server typescript",
  javascript: "npm i -g typescript-language-server typescript",
  javascriptreact: "npm i -g typescript-language-server typescript",
  python: "pip install pyright",
  go: "go install golang.org/x/tools/gopls@latest",
  rust: "rustup component add rust-analyzer",
  json: "npm i -g vscode-langservers-extracted",
  css: "npm i -g vscode-langservers-extracted",
  html: "npm i -g vscode-langservers-extracted",
}

function getConfigHint(): string {
  return "Create .covalo/lsp.json to customize language server configuration. See docs/lsp-configuration.md"
}

function getInstallHint(language: string): string | undefined {
  return INSTALL_HINTS[language]
}

const LANGUAGE_ENV_ALIASES: Record<string, string> = {
  typescript: "TYPESCRIPT",
  typescriptreact: "TYPESCRIPT",
  javascript: "JAVASCRIPT",
  javascriptreact: "JAVASCRIPT",
}

function getEnvCommand(language: string): string | undefined {
  const alias = LANGUAGE_ENV_ALIASES[language] ?? language.toUpperCase().replace(/[^A-Z0-9]/g, "_")
  const key = `COVALO_LSP_SERVER_${alias}`
  return process.env[key]
}

const WINDOWS_SHIMS = ["", ".cmd", ".exe", ".ps1"]

function tryAccessSync(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function tryAccess(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const whichCache = new Map<string, string | null>()

async function which(command: string): Promise<string | null> {
  const cached = whichCache.get(command)
  if (cached !== undefined) return cached

  const pathDirs = (process.env.PATH ?? "").split(delimiter)
  const isWin = process.platform === "win32"
  const shims = isWin ? WINDOWS_SHIMS : [""]

  for (const dir of pathDirs) {
    for (const shim of shims) {
      const candidate = command + shim
      const fullPath = resolve(dir, candidate)
      if (await tryAccess(fullPath)) {
        whichCache.set(command, fullPath)
        return fullPath
      }
    }
  }
  whichCache.set(command, null)
  return null
}

function resolvePackageLocalBin(command: string): string | null {
  try {
    const thisFile = fileURLToPath(import.meta.url)
    let dir = dirname(thisFile)
    const isWin = process.platform === "win32"
    const shims = isWin ? WINDOWS_SHIMS : [""]
    for (let i = 0; i < 10; i++) {
      for (const shim of shims) {
        const candidate = resolve(dir, "node_modules", ".bin", command + shim)
        if (tryAccessSync(candidate)) return candidate
      }
      const parent = resolve(dir, "..")
      if (parent === dir) break
      dir = parent
    }
  } catch {
    return null
  }
  return null
}

export async function resolveServer(
  command: string | undefined,
  args: string[] | undefined,
  language: string,
  cwd: string,
): Promise<ServerResolverResult> {
  const envCommand = getEnvCommand(language)
  const effectiveCommand = envCommand ?? command

  const result: ServerResolverResult = {
    server: { command: effectiveCommand ?? "", args: args ?? [] },
    source: "path",
    available: false,
  }

  if (!effectiveCommand) {
    result.installHint = getInstallHint(language)
    result.configHint = getConfigHint()
    return result
  }

  const source: ServerResolverResult["source"] = envCommand ? "env" : "user-config"

  // 1. Check PATH (with platform-appropriate shims on Windows)
  const pathResolved = await which(effectiveCommand)
  if (pathResolved) {
    result.server = { command: pathResolved, args: args ?? [] }
    result.source = source
    result.available = true
    result.resolvedPath = pathResolved
    return result
  }

  // 2. Check package-local node_modules/.bin
  const localBin = resolvePackageLocalBin(effectiveCommand)
  if (localBin) {
    result.server = { command: localBin, args: args ?? [] }
    result.source = "package-local"
    result.available = true
    result.resolvedPath = localBin
    return result
  }

  // 3. npx fallback (only if explicitly enabled)
  if (process.env.COVALO_LSP_ALLOW_NPX === "1") {
    const npxPath = await which("npx")
    if (npxPath) {
      result.server = { command: npxPath, args: ["--yes", effectiveCommand, ...(args ?? [])] }
      result.source = "npx-fallback"
      result.available = true
      result.resolvedPath = npxPath
      return result
    }
  }

  result.installHint = getInstallHint(language)
  result.configHint = getConfigHint()
  return result
}
