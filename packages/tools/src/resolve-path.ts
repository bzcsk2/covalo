import { resolve, dirname, relative, isAbsolute, sep } from "node:path"
import { realpath } from "node:fs/promises"

export class PathContainmentError extends Error {
  constructor(path: string) {
    super(`Path is outside the project directory: ${path}`)
    this.name = "PathContainmentError"
  }
}

/**
 * Resolve user-provided path within cwd, with symlink containment checking.
 *
 * - If the target exists: resolves symlinks via realpath to verify containment,
 *   then returns the original resolved path (not the realpath-transformed one)
 *   to preserve user-facing path identity (e.g. short vs long names on Windows).
 * - If it does not exist: resolves the nearest existing parent to check containment,
 *   then returns the original resolved path (parent symlinks resolved, suffix appended).
 * - Throws PathContainmentError if the resolved path escapes cwd.
 */
export async function resolvePath(userPath: string, cwd: string): Promise<string> {
  const resolved = resolve(cwd, userPath)
  const realCwd = await realpath(cwd)

  try {
    const real = await realpath(resolved)
    ensureContained(real, realCwd)
    // Return original resolved path (may have short/DOS names) — containment already verified
    return resolved
  } catch {
    if (resolved === realCwd) return realCwd
    // Path doesn't exist yet — resolve nearest existing parent
    let parent = dirname(resolved)
    while (parent !== dirname(parent)) {
      try {
        const realParent = await realpath(parent)
        ensureContained(realParent, realCwd)
        const suffix = resolved.slice(parent.length)
        const result = resolve(realParent, suffix.replace(/^[/\\]/, ""))
        ensureContained(result, realCwd)
        return result
      } catch {
        parent = dirname(parent)
      }
    }
    // Fallback: cwd itself is the last parent
    ensureContained(resolved, realCwd)
    return resolved
  }
}

function ensureContained(absPath: string, basePath: string): void {
  const rel = relative(basePath, absPath)
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathContainmentError(absPath)
  }
}
