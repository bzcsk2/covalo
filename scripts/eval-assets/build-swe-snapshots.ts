/**
 * Build SWE-bench snapshots from upstream repos.
 *
 * Reads swe-bench/lock.json, for each unique repo+baseCommit:
 * 1. Clone/fetch repo to local build cache
 * 2. Checkout baseCommit
 * 3. Remove .git and caches
 * 4. Pack as reproducible tar.gz
 * 5. Compute sha256
 * 6. Update assets.lock.json
 *
 * Usage: bun run scripts/eval-assets/build-swe-snapshots.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream } from "node:fs";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const ASSETS_DIR = join(REPO_ROOT, "resources", "eval-assets");
const CACHE_DIR = join(REPO_ROOT, ".deepreef", "eval-build-cache", "repos");
const SWE_LOCK_PATH = join(ASSETS_DIR, "swe-bench", "lock.json");
const ASSETS_LOCK_PATH = join(ASSETS_DIR, "assets.lock.json");

interface SweInstance {
  instanceId: string;
  repo: string;
  baseCommit: string;
}

interface SweLock {
  instances: SweInstance[];
}

function safeRepoName(repo: string): string {
  return repo.replace(/\//g, "_");
}

function computeSha256(filePath: string): string {
  const hash = createHash("sha256");
  const data = readFileSync(filePath);
  hash.update(data);
  return hash.digest("hex");
}

async function buildSnapshots(): Promise<void> {
  console.log("[build-swe-snapshots] Reading lock file...");
  const lock = JSON.parse(readFileSync(SWE_LOCK_PATH, "utf-8")) as SweLock;

  const seen = new Set<string>();
  const snapshots: Array<{ repo: string; baseCommit: string }> = [];

  for (const inst of lock.instances) {
    const key = `${inst.repo}#${inst.baseCommit}`;
    if (!seen.has(key)) {
      seen.add(key);
      snapshots.push({ repo: inst.repo, baseCommit: inst.baseCommit });
    }
  }

  console.log(`[build-swe-snapshots] Found ${snapshots.length} unique snapshots to build.`);

  const snapshotsDir = join(ASSETS_DIR, "swe-bench", "snapshots");
  mkdirSync(snapshotsDir, { recursive: true });

  const assetsLock = existsSync(ASSETS_LOCK_PATH)
    ? JSON.parse(readFileSync(ASSETS_LOCK_PATH, "utf-8"))
    : { version: 1, createdAt: new Date().toISOString(), sweBench: { dataset: "SWE-bench_Lite", datasetVersion: "20240627", snapshots: {} }, terminalBench: { dataset: "terminal-bench-core", datasetVersion: "0.1.0", tasksRoot: "terminal-bench/tasks", assets: {} } };

  for (const { repo, baseCommit } of snapshots) {
    const safeName = safeRepoName(repo);
    const cachePath = join(CACHE_DIR, safeName);
    const outPath = join(snapshotsDir, safeName, `${baseCommit}.tar.gz`);

    if (existsSync(outPath)) {
      console.log(`  [skip] ${repo}#${baseCommit} already exists`);
      continue;
    }

    console.log(`  [build] ${repo}#${baseCommit}...`);

    mkdirSync(join(snapshotsDir, safeName), { recursive: true });

    if (!existsSync(cachePath)) {
      console.log(`    Cloning ${repo}...`);
      execSync(`git clone --bare "https://github.com/${repo}.git" "${cachePath}"`, {
        stdio: "pipe",
        timeout: 120000,
      });
    }

    console.log(`    Fetching latest...`);
    try {
      execSync(`git fetch origin "+refs/heads/*:refs/heads/*" --depth=100`, {
        cwd: cachePath,
        stdio: "pipe",
        timeout: 60000,
      });
    } catch {
      console.log(`    Fetch failed (may be offline), using cached data.`);
    }

    // Fetch the specific commit into the cache
    try {
      execSync(`git fetch origin "${baseCommit}"`, {
        cwd: cachePath,
        stdio: "pipe",
        timeout: 60000,
      });
    } catch {
      console.log(`    WARN: commit ${baseCommit} not found in remote, skipping.`);
      console.log(`    To remove this instance, delete it from swe-bench/lock.json`);
      continue;
    }

    // Verify the commit is now in the cache
    try {
      execSync(`git cat-file -e "${baseCommit}"`, { cwd: cachePath, stdio: "pipe" });
    } catch {
      console.log(`    WARN: commit ${baseCommit} not found after fetch, skipping.`);
      continue;
    }

    const workDir = join(CACHE_DIR, `tmp-${safeName}-${baseCommit}`);
    if (existsSync(workDir)) {
      execSync(`rm -rf "${workDir}"`, { stdio: "pipe" });
    }

    // Create workdir from scratch to avoid clone issues with non-branch refs
    mkdirSync(workDir, { recursive: true });
    execSync(`git init`, { cwd: workDir, stdio: "pipe" });
    execSync(`git remote add origin "${cachePath}"`, { cwd: workDir, stdio: "pipe" });
    execSync(`git fetch origin "${baseCommit}"`, { cwd: workDir, stdio: "pipe", timeout: 60000 });
    execSync(`git checkout "${baseCommit}"`, { cwd: workDir, stdio: "pipe", timeout: 30000 });

    const excludes = [
      ".git", ".github", ".pytest_cache", "__pycache__",
      ".mypy_cache", ".ruff_cache", ".tox", ".nox",
      "build", "dist",
    ];
    for (const ex of excludes) {
      execSync(`rm -rf "${join(workDir, ex)}" 2>/dev/null || true`, { stdio: "pipe" });
    }
    execSync(`find "${workDir}" -name '*.pyc' -delete 2>/dev/null || true`, { stdio: "pipe" });
    execSync(`find "${workDir}" -name '*.pyo' -delete 2>/dev/null || true`, { stdio: "pipe" });

    execSync(
      `tar --sort=name --mtime='UTC 2020-01-01' --owner=0 --group=0 --numeric-owner -czf "${outPath}" -C "${workDir}" .`,
      { stdio: "pipe", timeout: 60000 },
    );

    execSync(`rm -rf "${workDir}"`, { stdio: "pipe" });

    const sha256 = computeSha256(outPath);
    const sizeBytes = existsSync(outPath) ? readFileSync(outPath).length : 0;

    const refKey = `${repo}#${baseCommit}`;
    assetsLock.sweBench.snapshots[refKey] = {
      repo,
      baseCommit,
      path: `swe-bench/snapshots/${safeName}/${baseCommit}.tar.gz`,
      format: "tar.gz",
      sha256,
      sizeBytes,
    };

    console.log(`    sha256: ${sha256}, size: ${(sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  }

  assetsLock.createdAt = new Date().toISOString();
  writeFileSync(ASSETS_LOCK_PATH, JSON.stringify(assetsLock, null, 2) + "\n");
  console.log(`[build-swe-snapshots] Done. Updated ${ASSETS_LOCK_PATH}`);
}

buildSnapshots().catch((e) => {
  console.error("[build-swe-snapshots] Failed:", e);
  process.exit(1);
});
