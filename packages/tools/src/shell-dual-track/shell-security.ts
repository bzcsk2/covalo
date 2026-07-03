/**
 * Shell 命令安全检查 — 复用 shell-exec 的危险模式与敏感路径规则。
 */

import { resolve } from "node:path"
import { isSensitive } from "../sensitive.js"
import type { ShellBackendId } from "../platform/shell-backend.js"

// Recursive root deletion
const RM_ROOT = /\brm\s+(?:-\S+\s+)*(?:-\S*[rR]\S*\s+)(?:-\S+\s+)*(?:\S+\s+)*\/(?:\*)?(?:\s|$)/
// Privileged escalation
const SUDO = /\bsudo\b/
// Disk formatting / partitioning
const DISK_FORMAT = /\bmkfs(?:\.[a-zA-Z]+)?\b/
const DISK_PARTITION = /\bfdisk\b/
// Raw block-device overwrite
const DD_IF = /\bdd\s+if=/
// Recursive world-writable chmod on root
const CHMOD_RECURSIVE_ROOT = /\bchmod\s+-R\s+777\s+\//
// Git destructive
const GIT_HARD_RESET = /\bgit\s+reset\s+--hard\b/
const GIT_CLEAN_FORCE = /\bgit\s+clean\s+-f[d]?\b/
// Pipe to shell
const CURL_BASH = /\bcurl\s+.*\|?\s*bash\b/
const WGET_SH = /\bwget\s+.*-O[^-].*\|?\s*sh\b/
// Network exfil
const EXFIL_MARKERS = /\b(?:nc\s+|ncat\s+|telnet\s+)(?:\S+\s+){1,2}\d+\b/
// System config mutation
const SYSTEMCTL = /\bsystemctl\s+(?:stop|disable|mask)\b/
const PASSWD = /\bpasswd\b/
const USERADD = /\buseradd\b/
const USERMOD = /\busermod\b/
const CHOWN_RECURSIVE = /\bchown\s+-R\b/
const MOUNT = /\bmount\b/
const UMOUNT = /\bumount\b/

const POSIX_DENY_PATTERNS = [
  RM_ROOT,
  SUDO,
  DISK_FORMAT,
  DD_IF,
  CHMOD_RECURSIVE_ROOT,
  DISK_PARTITION,
  GIT_HARD_RESET,
  GIT_CLEAN_FORCE,
  CURL_BASH,
  WGET_SH,
  EXFIL_MARKERS,
  SYSTEMCTL,
  PASSWD,
  USERADD,
  USERMOD,
  CHOWN_RECURSIVE,
  MOUNT,
  UMOUNT,
]

const POWERSHELL_DENY_PATTERNS = [
  /\b(?:Remove-Item|rm)\b[^;\n]*(?:-Recurse\b[^;\n]*)?(?:[A-Za-z]:\\|\/)\s*(?:-\w+\s*)*$/i,
  /\b(?:Remove-Item|rm)\b[^;\n]*-[FRS]\b/i,
  /\bFormat-Volume\b/i,
  /\bClear-Disk\b/i,
  /\bInitialize-Disk\b/i,
  /\bStart-Process\b[^;\n]*-Verb\s+RunAs\b/i,
  /\bInvoke-Expression\b/i,
  /\bInvoke-WebRequest\b[^;\n]*\|[^;\n]*Invoke-Expression\b/i,
  /\bSet-ExecutionPolicy\b/i,
  /\bAdd-LocalGroupMember\b/i,
  /\bSet-LocalUser\b/i,
]

/**
 * 检查命令是否匹配危险模式。
 *
 * @returns 匹配到的模式 source，未匹配则 null
 */
export function matchDeniedShellPattern(command: string, backend: ShellBackendId): string | null {
  const patterns = backend === "bash" ? POSIX_DENY_PATTERNS : POWERSHELL_DENY_PATTERNS
  for (const p of patterns) {
    if (p.test(command.trim())) return p.source
  }
  return null
}

/**
 * 检查命令是否引用敏感文件路径。
 *
 * Tokenizes the command into candidate path segments and checks each
 * against isSensitive. Supports leading dots (e.g. .env, .npmrc) which
 * word-boundary regexes cannot capture.
 *
 * @returns 敏感路径，未匹配则 null
 */
export function matchSensitivePathInCommand(command: string): string | null {
  // Split on whitespace, quotes, pipes, redirects, semicolons, etc.
  // Also split on = to capture --flag=/path forms
  const tokens = command.split(/[\s="'|&;<>()`$]+/).filter(Boolean)
  for (const token of tokens) {
    // Split by = to extract the value part (e.g., --file=/etc/shadow -> /etc/shadow)
    const eqParts = token.split("=")
    for (const part of eqParts) {
      if (!part || /^\d+$/.test(part)) continue
      if (isSensitive(part)) return part
    }
  }
  return null
}

export interface ShellSecurityCheckResult {
  ok: boolean
  error?: string
}

/**
 * 综合校验 shell 命令是否允许执行。
 *
 * @param command 原始命令
 * @param backend 当前平台 shell backend
 * @param cwd 工作目录（用于相对路径敏感检查，可选）
 */
export function validateShellCommand(
  command: string,
  backend: ShellBackendId,
  cwd?: string,
): ShellSecurityCheckResult {
  const trimmed = command.trim()
  if (!trimmed) {
    return { ok: false, error: "command is required" }
  }

  const denied = matchDeniedShellPattern(trimmed, backend)
  if (denied) {
    return { ok: false, error: `Command denied: matches dangerous pattern /${denied}/` }
  }

  const sensitive = matchSensitivePathInCommand(trimmed)
  if (sensitive) {
    const resolved = cwd ? resolve(cwd, sensitive) : sensitive
    if (isSensitive(resolved)) {
      return { ok: false, error: `Command references sensitive file: ${sensitive}` }
    }
  }

  return { ok: true }
}

/**
 * 判断命令是否不应静默进入后台（破坏性/危险操作）。
 */
export function isDestructiveShellCommand(command: string, backend: ShellBackendId): boolean {
  return matchDeniedShellPattern(command, backend) !== null
    || /\b(rm|del|Remove-Item|git\s+push)\b/i.test(command.trim())
}
