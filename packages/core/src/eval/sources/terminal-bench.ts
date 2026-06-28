import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { EvalCaseManifest, EvalCategoryId, EvalSuiteId } from "../types";

interface LockInstance {
  taskId: string;
  category: EvalCategoryId;
  suite: EvalSuiteId;
  scenario?: string;
}

interface TerminalBenchLock {
  version: string;
  source: {
    kind: string;
    repoPath: string;
    tasksDir: string;
    commit: string;
    datasetName: string;
    datasetVersion: string;
  };
  instances: LockInstance[];
}

let _lock: TerminalBenchLock | null = null;

function loadLock(): TerminalBenchLock {
  const lockPath = join(
    import.meta.dirname ?? __dirname,
    "..",
    "curated",
    "terminal-bench.lock.json",
  );
  return JSON.parse(readFileSync(lockPath, "utf-8")) as TerminalBenchLock;
}

function readTaskYaml(taskPath: string): Record<string, unknown> {
  const yamlPath = join(taskPath, "task.yaml");
  if (!existsSync(yamlPath)) return {};
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed: Record<string, unknown> = {};
  const lines = raw.split("\n");
  let currentKey: string | null = null;
  let currentValue: string[] = [];
  for (const line of lines) {
    const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)/);
    if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      if (currentKey) {
        parsed[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue.join("\n");
      }
      currentKey = keyMatch[1];
      const val = keyMatch[2].trim();
      currentValue = val ? [val] : [];
    } else if (currentKey && (line.startsWith("  ") || line.startsWith("\t"))) {
      currentValue.push(line.replace(/^[ \t]+/, ""));
    } else if (currentKey && line.trim()) {
      currentValue.push(line);
    }
  }
  if (currentKey) {
    parsed[currentKey] = currentValue.length === 1 ? currentValue[0] : currentValue.join("\n");
  }
  return parsed;
}

function generateTaskPrompt(taskYaml: Record<string, unknown>): string {
  const instruction = (taskYaml.instruction as string) ?? "";
  const category = (taskYaml.category as string) ?? "";
  const rawTags = taskYaml.tags;
  let tags: string[] = [];
  if (Array.isArray(rawTags)) {
    tags = rawTags;
  } else if (typeof rawTags === "string") {
    tags = rawTags.replace(/^\[|\]$/g, "").split(",").map((t: string) => t.trim()).filter(Boolean);
  }
  const parts = [instruction.trim()];
  if (tags.length > 0) {
    parts.push(`\nTags: ${tags.join(", ")}`);
  }
  if (category) {
    parts.push(`\nCategory: ${category}`);
  }
  return parts.join("\n");
}

const RECOVERY_TASK_PREFIX = `[恢复场景 - 监督恢复评测]

本任务是一个监督恢复（Supervisor Recovery）评测场景。
关键规则：

1. 你的初次尝试很可能会失败——这不意味着任务结束。
2. 失败后，Supervisor 会提供分析反馈和提示。
3. 你必须根据 Supervisor 的反馈调整方案并重试。
4. 最终状态必须通过 verifier 检查才算成功。

核心评测目标：不是"一次做对"，而是"从失败中恢复"。

--- 以下为原始任务说明 ---

`;

const VERIFIER_SETUP_COMMANDS: Record<string, string[]> = {
  "fix-pandas-version": [
    "pip install pandas==2.0.0 pyarrow==14.0.0 2>&1 || pip3 install pandas==2.0.0 pyarrow==14.0.0 2>&1",
  ],
  "csv-to-parquet": [
    "pip install pandas pyarrow 2>&1 || pip3 install pandas pyarrow 2>&1",
  ],
  "pytorch-model-cli": [
    "pip install torch 2>&1 || pip3 install torch 2>&1",
  ],
  "pytorch-model-recovery": [
    "pip install torch 2>&1 || pip3 install torch 2>&1",
  ],
  "mnist-learning-fix": [
    "pip install torch torchvision 2>&1 || pip3 install torch torchvision 2>&1",
  ],
  "model-extraction-relu-logits": [
    "pip install torch 2>&1 || pip3 install torch 2>&1",
  ],
  "predict-customer-churn": [
    "pip install pandas scikit-learn 2>&1 || pip3 install pandas scikit-learn 2>&1",
  ],
  "hello-world": [],
  "password-recovery": [],
};

function buildVerifier(
  taskId: string,
  taskPath: string,
): EvalCaseManifest["verifier"] {
  const testDir = join(taskPath, "tests");
  const hasTests = existsSync(testDir);

  if (!hasTests) {
    return { type: "file-assert", fileAssertions: [] };
  }

  return {
    type: "command",
    command: `python3 -m pytest tests/test_outputs.py -rA 2>&1`,
  };
}

function buildSetupCommands(
  taskId: string,
  taskPath: string,
): string[] {
  const setupCommands: string[] = [];
  const setupShPath = join(taskPath, "setup.sh");
  if (existsSync(setupShPath)) {
    const content = readFileSync(setupShPath, "utf-8");
    const lines = content.split("\n").filter(
      (l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("git config") && !l.trim().startsWith("git clone"),
    );
    for (const line of lines) {
      const cmd = line.trim();
      if (cmd && !cmd.startsWith("#")) {
        setupCommands.push(cmd);
      }
    }
  }

  const verifierSetup = VERIFIER_SETUP_COMMANDS[taskId];
  if (verifierSetup) {
    setupCommands.push(...verifierSetup);
  }

  return setupCommands;
}

export function buildCaseId(taskId: string, scenario?: string): string {
  const base = `tb-${taskId}`;
  if (scenario === "recovery") return `${base}-recovery`;
  return base;
}

export function buildManifest(
  instance: LockInstance,
  lock: TerminalBenchLock,
): EvalCaseManifest {
  const taskId = instance.taskId;
  const scenario = instance.scenario;
  const caseId = buildCaseId(taskId, scenario);
  const taskPath = join(lock.source.repoPath, lock.source.tasksDir, taskId);
  const taskYaml = readTaskYaml(taskPath);

  const title = (taskYaml.title as string) ?? taskId;
  const description = (taskYaml.description as string) ?? taskId;
  const difficulty = (taskYaml.difficulty as string) ?? "medium";

  let suite = instance.suite;
  if (instance.suite === "standard") {
    if (difficulty === "hard") suite = "stress";
  }

  const sourceMeta: import("../types").RealCaseSourceMeta = {
    sourceKind: "terminal-bench",
    sourceId: taskId,
    sourceRepoPath: lock.source.repoPath,
    sourceCommit: lock.source.commit,
    sourceDataset: lock.source.datasetName,
    sourceTaskPath: taskPath,
    sourceInstanceId: scenario === "recovery" ? `${taskId}-recovery` : undefined,
  };

  let baseTaskPrompt = generateTaskPrompt(taskYaml);
  let baseVerifier = buildVerifier(taskId, taskPath);
  let baseScoring = {
    requireCleanGitDiff: false,
    maxChangedFiles: 10,
  };

  if (scenario === "recovery") {
    baseTaskPrompt = RECOVERY_TASK_PREFIX + baseTaskPrompt;
    baseScoring = {
      requireCleanGitDiff: false,
      maxChangedFiles: 10,
    };
  }

  return {
    id: caseId,
    category: instance.category,
    suite,
    title: scenario === "recovery" ? `${title} [恢复场景]` : title,
    description: scenario === "recovery" ? `${description} (监督恢复包装)` : description,
    fixtureSource: `__tb__${taskId}`,
    sourceMeta,
    setup: buildSetupCommands(taskId, taskPath),
    taskPrompt: baseTaskPrompt,
    expectedVerification: scenario === "recovery"
      ? ["恢复后 pytest 测试应全部通过"]
      : ["pytest 测试应全部通过"],
    verifier: baseVerifier,
    scoring: baseScoring,
  };
}

export function loadTerminalBenchManifests(): EvalCaseManifest[] {
  if (!_lock) {
    _lock = loadLock();
  }
  const lock = _lock!;

  const seen = new Set<string>();
  return lock.instances
    .map((inst) => {
      const caseId = buildCaseId(inst.taskId, inst.scenario);
      if (seen.has(caseId)) return null;
      seen.add(caseId);
      return buildManifest(inst, lock);
    })
    .filter((m): m is EvalCaseManifest => m !== null);
}

export { type LockInstance, type TerminalBenchLock };
