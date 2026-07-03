import { access, constants } from "node:fs/promises"
import { accessSync } from "node:fs"
import { resolve, dirname } from "node:path"
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
  return INSTALL_HINTS[INSTALL_HINTS[language] ? language : Object.keys(INSTALL_HINTS).find(k => k === language) ?? ""]
}

const whichCache = new Map<string, string | null>()

async function which(command: string): Promise<string | null> {
  const cached = whichCache.get(command)
  if (cached !== undefined) return cached

  const pathDirs = (process.env.PATH ?? "").split(":")
  for (const dir of pathDirs) {
    const fullPath = resolve(dir, command)
    try {
      await access(fullPath, constants.X_OK)
      whichCache.set(command, fullPath)
      return fullPath
    } catch {
      continue
    }
  }
  whichCache.set(command, null)
  return null
}

function resolvePackageLocalBin(command: string): string | null {
  try {
    const thisFile = fileURLToPath(import.meta.url)
    let dir = dirname(thisFile)
    for (let i = 0; i < 10; i++) {
      const candidate = resolve(dir, "node_modules", ".bin", command)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        const parent = resolve(dir, "..")
        if (parent === dir) break
        dir = parent
      }
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
  const result: ServerResolverResult = {
    server: { command: command ?? "", args: args ?? [] },
    source: "path",
    available: false,
  }

  if (!command) {
    result.installHint = getInstallHint(language)
    result.configHint = getConfigHint()
    return result
  }

  // 1. Check PATH
  const pathResolved = await which(command)
  if (pathResolved) {
    result.server = { command: pathResolved, args: args ?? [] }
    result.source = "path"
    result.available = true
    result.resolvedPath = pathResolved
    return result
  }

  // 2. Check package-local node_modules/.bin
  const localBin = resolvePackageLocalBin(command)
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
      result.server = { command: npxPath, args: ["--yes", command, ...(args ?? [])] }
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
