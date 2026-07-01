import { existsSync } from "node:fs";
import { join, isAbsolute, normalize, sep } from "node:path";
import { execSync } from "node:child_process";
import { UnsafeEvalAssetPathError, EvalAssetExtractionError } from "../types";

export async function extractSafeTarGz(
  assetPath: string,
  workspaceDir: string,
): Promise<void> {
  if (!existsSync(assetPath)) {
    throw new Error(`Asset file not found: ${assetPath}`);
  }
  if (!existsSync(workspaceDir)) {
    throw new Error(`Workspace directory not found: ${workspaceDir}`);
  }

  const entries = listTarVerboseEntries(assetPath);
  for (const entry of entries) {
    validateTarEntry(entry, assetPath, workspaceDir);
  }

  try {
    execSync(`tar -xzf "${assetPath}" -C "${workspaceDir}"`, {
      stdio: "pipe",
      timeout: 60000,
    });
  } catch (e) {
    throw new EvalAssetExtractionError(
      `Failed to extract ${assetPath} to ${workspaceDir}: ${e}`,
    );
  }

  // Post-extraction scan: verify every extracted path is inside workspaceDir
  const entriesAfter = listTarEntries(assetPath);
  for (const entry of entriesAfter) {
    const resolved = join(workspaceDir, normalize(entry));
    if (!resolved.startsWith(workspaceDir + sep) && resolved !== workspaceDir) {
      throw new UnsafeEvalAssetPathError(
        `Extracted path escapes workspaceDir in ${assetPath}: ${entry}`,
      );
    }
  }
}

function listTarVerboseEntries(tarPath: string): string[] {
  try {
    const output = execSync(`tar -tvzf "${tarPath}" 2>/dev/null`, {
      stdio: "pipe",
      timeout: 30000,
      encoding: "utf-8",
    });
    return output.split("\n").filter(Boolean);
  } catch (e) {
    throw new EvalAssetExtractionError(
      `Failed to list entries in tar archive ${tarPath}: ${e}`,
    );
  }
}

function listTarEntries(tarPath: string): string[] {
  try {
    const output = execSync(`tar -tzf "${tarPath}" 2>/dev/null`, {
      stdio: "pipe",
      timeout: 30000,
      encoding: "utf-8",
    });
    return output.split("\n").filter(Boolean);
  } catch (e) {
    throw new EvalAssetExtractionError(
      `Failed to list entries in tar archive ${tarPath}: ${e}`,
    );
  }
}

function validateTarEntry(
  verboseEntry: string,
  archivePath: string,
  workspaceDir: string,
): void {
  // verbose format: "permissions user/group size date time name"
  // symlinks:       "lrwxr-xr-x user/group size date time linkname -> target"
  const parts = verboseEntry.split(/\s+/);
  const permissions = parts[0] || "";

  // Extract the filename (last column before "->" for symlinks)
  const arrowIdx = verboseEntry.indexOf(" -> ");
  const entryName = arrowIdx >= 0
    ? verboseEntry.slice(0, arrowIdx).split(/\s+/).pop() || ""
    : parts[parts.length - 1] || "";

  const normalized = normalize(entryName);

  if (isAbsolute(normalized)) {
    throw new UnsafeEvalAssetPathError(
      `Tar entry is absolute path in ${archivePath}: ${entryName}`,
    );
  }

  if (normalized.includes("..")) {
    throw new UnsafeEvalAssetPathError(
      `Tar entry contains ".." in ${archivePath}: ${entryName}`,
    );
  }

  if (/^[A-Za-z]:[/\\]/.test(normalized)) {
    throw new UnsafeEvalAssetPathError(
      `Tar entry contains Windows drive letter in ${archivePath}: ${entryName}`,
    );
  }

  // Symlink target validation: ensure symlink target is within workspaceDir
  if (arrowIdx >= 0 && permissions.startsWith("l")) {
    const symTarget = verboseEntry.slice(arrowIdx + 4).trim();

    // Resolve the symlink target to an absolute path.
    // For absolute targets, resolve relative to filesystem root.
    // For relative targets, resolve relative to the symlink's parent directory.
    const resolvedTarget = isAbsolute(symTarget)
      ? normalize(symTarget)
      : normalize(join(workspaceDir, normalize(entryName), "..", symTarget));

    const resolvedWs = normalize(workspaceDir);

    if (resolvedTarget !== resolvedWs && !resolvedTarget.startsWith(resolvedWs + sep)) {
      throw new UnsafeEvalAssetPathError(
        `Symlink in ${archivePath} points outside workspaceDir: ${entryName} -> ${symTarget}`,
      );
    }
  }
}
