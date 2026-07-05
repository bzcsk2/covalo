import { resolve, relative, isAbsolute } from "node:path";

export class UnsafeEvalPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeEvalPathError";
  }
}

export function resolveWithinRoot(
  rootDir: string,
  candidatePath: string,
  label: string,
): string {
  if (!candidatePath || typeof candidatePath !== "string") {
    throw new UnsafeEvalPathError(`${label} must be a non-empty string`);
  }

  if (candidatePath.includes("\0")) {
    throw new UnsafeEvalPathError(`${label} contains NUL character`);
  }

  const root = resolve(rootDir);
  const resolved = resolve(root, candidatePath);
  const rel = relative(root, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UnsafeEvalPathError(`${label} must stay within ${root}`);
  }

  return resolved;
}

export function isWithinRoot(rootDir: string, candidatePath: string): boolean {
  try {
    resolveWithinRoot(rootDir, candidatePath, "path");
    return true;
  } catch {
    return false;
  }
}
