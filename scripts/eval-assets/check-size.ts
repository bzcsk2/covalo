/**
 * Size gate for resources/eval-assets.
 *
 * Checks:
 * - Total size <= 35M (target) / 45M (temporary max)
 * - Single SWE snapshot <= 8M
 * - No forbidden file types
 *
 * Usage: bun run scripts/eval-assets/check-size.ts
 */

import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const ASSETS_DIR = join(REPO_ROOT, "resources", "eval-assets");

const TOTAL_SIZE_TARGET = 35 * 1024 * 1024;
const TOTAL_SIZE_MAX = 45 * 1024 * 1024;
const SNAPSHOT_SIZE_MAX = 8 * 1024 * 1024;
const NPM_PACKED_MAX = 30 * 1024 * 1024;
const NPM_UNPACKED_MAX = 60 * 1024 * 1024;

let exitCode = 0;

function formatSize(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2) + " MB";
}

function walkDir(dir: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (entry.isDirectory()) {
        results.push(...walkDir(full));
      } else {
        results.push(full);
      }
    }
  } catch {
    // dir may not exist
  }
  return results;
}

function main(): void {
  console.log("[check-size] Checking resources/eval-assets size...\n");

  if (!existsSync(ASSETS_DIR)) {
    console.error("[check-size] resources/eval-assets not found");
    process.exit(1);
  }

  const allFiles = walkDir(ASSETS_DIR);

  // Check for forbidden file types
  let hasForbidden = false;
  for (const f of allFiles) {
    if (f.endsWith(".bundle") || f.endsWith(".pack") || f.endsWith(".idx") || f.includes("/.git/")) {
      console.error(`FAIL: Forbidden file type in assets: ${f}`);
      hasForbidden = true;
      exitCode = 1;
    }
  }
  if (!hasForbidden) {
    console.log("  [ok] No forbidden file types (.bundle, .pack, .idx, .git)");
  }

  // Check individual SWE snapshot sizes
  const snapshotsDir = join(ASSETS_DIR, "swe-bench", "snapshots");
  if (existsSync(snapshotsDir)) {
    const snapshots = walkDir(snapshotsDir).filter(f => f.endsWith(".tar.gz"));
    for (const sn of snapshots) {
      const size = statSync(sn).size;
      if (size > SNAPSHOT_SIZE_MAX) {
        console.error(`FAIL: Snapshot exceeds 8MB: ${sn} (${formatSize(size)})`);
        exitCode = 1;
      }
    }
    if (snapshots.length > 0) {
      const maxSize = Math.max(...snapshots.map(s => statSync(s).size));
      console.log(`  [ok] ${snapshots.length} snapshots, max: ${formatSize(maxSize)}`);
    }
  }

  // Check total size
  let totalSize = 0;
  for (const f of allFiles) {
    try {
      totalSize += statSync(f).size;
    } catch {
      // skip
    }
  }

  console.log(`  Total assets size: ${formatSize(totalSize)}`);

  if (totalSize > TOTAL_SIZE_MAX) {
    console.error(`FAIL: Total size ${formatSize(totalSize)} exceeds max ${formatSize(TOTAL_SIZE_MAX)}`);
    exitCode = 1;
  } else if (totalSize > TOTAL_SIZE_TARGET) {
    console.log(`  WARN: Total size ${formatSize(totalSize)} exceeds target ${formatSize(TOTAL_SIZE_TARGET)} (within ${formatSize(TOTAL_SIZE_MAX)} max)`);
  } else {
    console.log(`  [ok] Within target ${formatSize(TOTAL_SIZE_TARGET)}`);
  }

  // Check npm pack --dry-run sizes
  console.log("");
  try {
    const packOutput = execSync("npm pack --dry-run --json 2>/dev/null", {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      stdio: "pipe",
      timeout: 30000,
    }).trim();
    const packData = JSON.parse(packOutput);
    const packInfo = Array.isArray(packData) ? packData[0] : packData;
    const packedSize = packInfo.size || 0;
    const unpackedSize = packInfo.unpackedSize || 0;
    if (packedSize > NPM_PACKED_MAX) {
      console.error(`FAIL: npm packed size ${formatSize(packedSize)} exceeds max ${formatSize(NPM_PACKED_MAX)}`);
      exitCode = 1;
    } else {
      console.log(`  [ok] npm packed size: ${formatSize(packedSize)} (max ${formatSize(NPM_PACKED_MAX)})`);
    }
    if (unpackedSize > NPM_UNPACKED_MAX) {
      console.error(`FAIL: npm unpacked size ${formatSize(unpackedSize)} exceeds max ${formatSize(NPM_UNPACKED_MAX)}`);
      exitCode = 1;
    } else {
      console.log(`  [ok] npm unpacked size: ${formatSize(unpackedSize)} (max ${formatSize(NPM_UNPACKED_MAX)})`);
    }
  } catch {
    console.log("  [skip] npm pack --dry-run not available (not in package dir?)");
  }

  console.log("\n[check-size] Done.");
  process.exit(exitCode);
}

main();
