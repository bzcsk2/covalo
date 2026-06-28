import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { EvalCaseManifest, EvalCategoryId, EvalSuiteId } from "../types";

export interface LooprigRealInstance {
  taskId: string;
  commitId: string;
  baseCommit: string;
  category: EvalCategoryId;
  suite: EvalSuiteId;
  title: string;
  description: string;
  verifierCommand: string;
}

interface LooprigRealLock {
  version: string;
  source: {
    kind: string;
    repoPath: string;
    datasetName: string;
    datasetVersion: string;
  };
  instances: LooprigRealInstance[];
}

let _lock: LooprigRealLock | null = null;

function loadLock(): LooprigRealLock {
  const lockPath = join(
    import.meta.dirname ?? __dirname,
    "..",
    "curated",
    "looprig-real.lock.json",
  );
  return JSON.parse(readFileSync(lockPath, "utf-8")) as LooprigRealLock;
}

function getRepoPath(): string {
  const lock = loadLock();
  return lock.source.repoPath;
}

function getCommitMessage(commitId: string): string {
  try {
    const repoPath = getRepoPath();
    const msg = execSync(`git log --format="%s" -1 ${commitId}`, {
      cwd: repoPath,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();
    return msg;
  } catch {
    return "";
  }
}

export function buildCaseId(taskId: string): string {
  return `lr-${taskId}`;
}

export function buildManifest(
  instance: LooprigRealInstance,
  lock: LooprigRealLock,
): EvalCaseManifest {
  const caseId = buildCaseId(instance.taskId);
  const commitShort = instance.commitId.slice(0, 12);
  const commitMsg = getCommitMessage(instance.commitId);
  const repoPath = lock.source.repoPath;

  const diffFiles = (() => {
    try {
      const out = execSync(
        `git diff --name-only ${instance.baseCommit}..${instance.commitId} -- .`,
        { cwd: repoPath, stdio: "pipe", timeout: 10000 },
      ).toString().trim();
      return out ? out.split("\n") : [];
    } catch {
      return [];
    }
  })();

  const taskPrompt = [
    `你需要在 workspace 中修复一个 LoopRig 仓库的真实 bug。`,
    ``,
    `Bug 描述：${instance.description}`,
    `Commit 信息：${commitMsg}`,
    `修复 commit：${commitShort}`,
    ``,
    diffFiles.length > 0 ? `涉及的文件：\n${diffFiles.map((f) => `  - \`${f}\``).join("\n")}` : "",
    ``,
    `你的任务是修改相关源文件，使以下验证命令通过：`,
    `\`${instance.verifierCommand}\``,
    ``,
    `注意：`,
    `- 只修改必要的文件，不要修改无关代码`,
    `- 验证命令必须返回 exit code 0`,
  ].filter(Boolean).join("\n");

  return {
    id: caseId,
    category: instance.category,
    suite: instance.suite,
    title: instance.title,
    description: instance.description,
    fixtureSource: `__lr__${instance.commitId}`,
    sourceMeta: {
      sourceKind: "looprig-real",
      sourceId: instance.taskId,
      sourceRepoPath: repoPath,
      sourceCommit: instance.baseCommit,
      sourceDataset: lock.source.datasetName,
      sourceInstanceId: instance.commitId,
    },
    setup: [],
    taskPrompt,
    expectedVerification: [
      `验证命令应通过：${instance.verifierCommand}`,
    ],
    verifier: {
      type: "command",
      command: instance.verifierCommand,
    },
    scoring: {
      requireCleanGitDiff: true,
      maxChangedFiles: Math.max(10, diffFiles.length + 2),
    },
  };
}

export function loadLooprigRealManifests(): EvalCaseManifest[] {
  if (!_lock) {
    _lock = loadLock();
  }
  const lock = _lock!;
  return lock.instances.map((inst) => buildManifest(inst, lock));
}
