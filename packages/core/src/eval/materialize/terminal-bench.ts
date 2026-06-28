import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { EvalCaseManifest } from "../types";
import { copyToWorkspace, patchTestPaths, createTestRunner, type Materializer } from "./shared";

const TB_PREFIX = "__tb__";

export const terminalBenchMaterializer: Materializer = {
  canHandle(manifest: EvalCaseManifest): boolean {
    return manifest.fixtureSource.startsWith(TB_PREFIX);
  },

  async materialize(
    manifest: EvalCaseManifest,
    workspaceDir: string,
  ): Promise<void> {
    const taskId = manifest.fixtureSource.slice(TB_PREFIX.length);
    const sourceMeta = manifest.sourceMeta;
    if (!sourceMeta || !sourceMeta.sourceTaskPath) {
      console.error(`[tb-materializer] No sourceTaskPath for ${manifest.id}`);
      return;
    }

    const taskPath = sourceMeta.sourceTaskPath;

    const excludeFiles = [
      "Dockerfile",
      "docker-compose.yaml",
      "task.yaml",
      "solution.sh",
      "solution.yaml",
      "run-tests.sh",
    ];

    await copyToWorkspace(taskPath, workspaceDir, excludeFiles);

    patchTestPaths(workspaceDir);
    createTestRunner(workspaceDir);
  },
};
