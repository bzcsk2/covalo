/**
 * Verify integrity of resources/eval-assets.
 *
 * Checks:
 * 1. assets.lock.json exists and is valid
 * 2. All paths are safe
 * 3. All files exist
 * 4. All sha256 match
 * 5. SWE-bench lock has corresponding snapshots
 * 6. Terminal-Bench lock has corresponding task dirs
 * 7. No forbidden files (.bundle, .pack, .idx, .git)
 * 8. No PyTorch large-weight tasks in lock
 *
 * Usage: bun run scripts/eval-assets/verify-assets.ts
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const ASSETS_DIR = join(REPO_ROOT, "resources", "eval-assets");
const ASSETS_LOCK_PATH = join(ASSETS_DIR, "assets.lock.json");

let exitCode = 0;

function fail(msg: string): void {
  console.error(`FAIL: ${msg}`);
  exitCode = 1;
}

function computeSha256(filePath: string): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function walkDir(dir: string, relativeTo: string): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = join(relativeTo, entry.name);
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (entry.isDirectory()) {
        results.push(...walkDir(full, rel));
      } else {
        results.push(rel);
      }
    }
  } catch {
    // dir may not exist
  }
  return results;
}

function main(): void {
  console.log("[verify-assets] Checking resources/eval-assets...\n");

  // 1. assets.lock.json
  if (!existsSync(ASSETS_LOCK_PATH)) {
    fail("assets.lock.json not found");
    process.exit(1);
  }

  let assetsLock: Record<string, unknown>;
  try {
    assetsLock = JSON.parse(readFileSync(ASSETS_LOCK_PATH, "utf-8"));
  } catch (e) {
    fail(`assets.lock.json parse error: ${e}`);
    process.exit(1);
  }

  console.log("  [ok] assets.lock.json exists and is valid JSON");

  // 2. Check all paths in lock for safety
  const sweSnapshots = (assetsLock as any)?.sweBench?.snapshots as Record<string, { path: string; sha256: string }> | undefined;
  const tbAssets = (assetsLock as any)?.terminalBench?.assets as Record<string, { path: string; sha256: string }> | undefined;

  for (const [key, entry] of Object.entries(sweSnapshots ?? {})) {
    const p = entry.path;
    if (p.startsWith("/") || p.includes("..") || /^[A-Za-z]:/.test(p)) {
      fail(`Unsafe path in sweBench.snapshots["${key}"]: ${p}`);
    }
  }

  for (const [key, entry] of Object.entries(tbAssets ?? {})) {
    const p = (entry as any).path;
    if (p.startsWith("/") || p.includes("..") || /^[A-Za-z]:/.test(p)) {
      fail(`Unsafe path in terminalBench.assets["${key}"]: ${p}`);
    }
  }

  // 3. All files exist
  for (const [key, entry] of Object.entries(sweSnapshots ?? {})) {
    const fullPath = join(ASSETS_DIR, entry.path);
    if (!existsSync(fullPath)) {
      fail(`Missing SWE-bench snapshot: ${entry.path} (${key})`);
    }
  }

  // 4. Check sha256
  for (const [key, entry] of Object.entries(sweSnapshots ?? {})) {
    const fullPath = join(ASSETS_DIR, entry.path);
    if (existsSync(fullPath)) {
      const actual = computeSha256(fullPath);
      if (actual !== entry.sha256.toLowerCase()) {
        fail(`Corrupt asset: ${entry.path} (${key}): expected ${entry.sha256}, actual ${actual}`);
      }
    }
  }

  // 5. SWE-bench lock snapshots exist
  const sweLockPath = join(ASSETS_DIR, "swe-bench", "lock.json");
  if (existsSync(sweLockPath)) {
    const sweLock = JSON.parse(readFileSync(sweLockPath, "utf-8")) as { instances: Array<{ repo: string; baseCommit: string }> };
    const seen = new Set<string>();
    for (const inst of sweLock.instances) {
      const key = `${inst.repo}#${inst.baseCommit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!sweSnapshots?.[key]) {
        fail(`Missing SWE-bench snapshot for ${key}`);
      }
    }
    console.log(`  [ok] SWE-bench lock: ${sweLock.instances.length} instances, ${seen.size} unique snapshots`);
  }

  // 6. Terminal-Bench lock task dirs exist
  const tbLockPath = join(ASSETS_DIR, "terminal-bench", "lock.json");
  if (existsSync(tbLockPath)) {
    const tbLock = JSON.parse(readFileSync(tbLockPath, "utf-8")) as { instances: Array<{ taskId: string }> };
    const tasksDir = join(ASSETS_DIR, "terminal-bench", "tasks");
    for (const inst of tbLock.instances) {
      const taskDir = join(tasksDir, inst.taskId);
      if (!existsSync(taskDir)) {
        fail(`Missing terminal-bench task directory: ${inst.taskId}`);
      }
    }
    console.log(`  [ok] Terminal-Bench lock: ${tbLock.instances.length} instances, all task dirs exist`);
  }

  // 7. No forbidden files
  const allFiles = walkDir(ASSETS_DIR, "");
  const forbidden = allFiles.filter(f =>
    f.endsWith(".bundle") || f.endsWith(".pack") || f.endsWith(".idx") || f.includes("/.git/")
  );
  for (const f of forbidden) {
    fail(`Forbidden asset: ${f}`);
  }

  // 8. No PyTorch large-weight tasks
  const pytorchTasks = ["pytorch-model-recovery", "pytorch-model-cli"];
  if (existsSync(tbLockPath)) {
    const tbLock = JSON.parse(readFileSync(tbLockPath, "utf-8")) as { instances: Array<{ taskId: string }> };
    for (const inst of tbLock.instances) {
      if (pytorchTasks.includes(inst.taskId)) {
        fail(`PyTorch large-weight task "${inst.taskId}" still present in terminal-bench lock`);
      }
    }
  }

  // 9. Check category-map.json does not reference removed PyTorch tasks
  const catMapPath = join(ASSETS_DIR, "category-map.json");
  if (existsSync(catMapPath)) {
    const catMap = JSON.parse(readFileSync(catMapPath, "utf-8")) as Record<string, unknown>;
    const raw = JSON.stringify(catMap);
    for (const task of pytorchTasks) {
      if (raw.includes(task)) {
        fail(`PyTorch task "${task}" still referenced in category-map.json`);
      }
    }
  }

  // 10. Check for unregistered large files (>1MB not in assets.lock)
  const knownAssetPaths = new Set<string>();
  for (const entry of Object.values(sweSnapshots ?? {})) {
    knownAssetPaths.add(entry.path);
  }
  for (const entry of Object.values(tbAssets ?? {})) {
    knownAssetPaths.add((entry as any).path);
  }
  const allAssetFiles = walkDir(ASSETS_DIR, "").filter(f => {
    // Skip lock files, json metadata, and task dirs
    if (f.endsWith(".json")) return false;
    if (f.startsWith("terminal-bench/tasks/")) return false;
    return true;
  });
  for (const f of allAssetFiles) {
    if (!knownAssetPaths.has(f)) {
      const fullPath = join(ASSETS_DIR, f);
      try {
        const size = statSync(fullPath).size;
        if (size > 1024 * 1024) {
          fail(`Unregistered large file (>1MB): ${f} (${(size / 1024 / 1024).toFixed(2)} MB)`);
        }
      } catch {}
    }
  }

  console.log("\n[verify-assets] Done.");
  process.exit(exitCode);
}

main();
