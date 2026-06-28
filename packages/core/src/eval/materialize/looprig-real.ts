import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import type { EvalCaseManifest } from "../types";
import type { Materializer } from "./shared";

const LR_PREFIX = "__lr__";
const CACHE_DIR = join(homedir(), ".cache", "looprig", "looprig-real");

export const looprigRealMaterializer: Materializer = {
  canHandle(manifest: EvalCaseManifest): boolean {
    return manifest.fixtureSource.startsWith(LR_PREFIX);
  },

  async materialize(
    manifest: EvalCaseManifest,
    workspaceDir: string,
  ): Promise<void> {
    const commitId = manifest.fixtureSource.slice(LR_PREFIX.length);
    const sourceMeta = manifest.sourceMeta as Record<string, unknown> | undefined;
    const repoPath = sourceMeta?.sourceRepoPath as string | undefined;
    const baseCommit = sourceMeta?.sourceCommit as string | undefined;

    if (!repoPath || !existsSync(repoPath)) {
      console.error(`[lr-materializer] Invalid repoPath for ${manifest.id}: ${repoPath}`);
      return;
    }
    if (!baseCommit) {
      console.error(`[lr-materializer] No baseCommit for ${manifest.id}`);
      return;
    }

    const cacheDir = join(CACHE_DIR, "repo");
    try {
      if (!existsSync(cacheDir)) {
        mkdirSync(CACHE_DIR, { recursive: true });
        execSync(
          `git clone --local "${repoPath}" "${cacheDir}"`,
          { stdio: "pipe", timeout: 120000 },
        );
      }
    } catch (e) {
      console.error(`[lr-materializer] Failed to cache repo: ${e}`);
      return;
    }

    try {
      execSync(`git clone "${cacheDir}" "${workspaceDir}"`, {
        stdio: "pipe",
        timeout: 60000,
      });
    } catch (e) {
      console.error(`[lr-materializer] Failed to clone from cache for ${manifest.id}: ${e}`);
      return;
    }

    try {
      execSync(`git checkout ${baseCommit}`, {
        cwd: workspaceDir,
        stdio: "pipe",
        timeout: 30000,
      });
    } catch (e) {
      console.error(`[lr-materializer] Failed to checkout ${baseCommit} for ${manifest.id}: ${e}`);
    }
  },
};
