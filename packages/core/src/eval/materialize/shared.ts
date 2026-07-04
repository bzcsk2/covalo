import { cp, mkdir, writeFile, readdir } from "node:fs/promises";
import { existsSync, writeFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalCaseManifest } from "../types";
import { MissingEvalAssetError } from "../types";

export interface Materializer {
  canHandle(manifest: EvalCaseManifest): boolean;
  materialize(
    manifest: EvalCaseManifest,
    workspaceDir: string,
  ): Promise<void>;
}

const materializers: Materializer[] = [];

export function registerMaterializer(m: Materializer): void {
  materializers.push(m);
}

export async function runMaterializers(
  manifest: EvalCaseManifest,
  workspaceDir: string,
): Promise<void> {
  for (const m of materializers) {
    if (m.canHandle(manifest)) {
      await m.materialize(manifest, workspaceDir);
      return;
    }
  }
  throw new MissingEvalAssetError(
    `No materializer found for fixture source "${manifest.fixtureSource}" in case ${manifest.id}`,
  );
}

export async function initDefaultMaterializers(): Promise<void> {
  const { terminalBenchMaterializer } = await import("./terminal-bench.js");
  registerMaterializer(terminalBenchMaterializer);
  try {
    const { sweBenchMaterializer } = await import("./swe-bench.js");
    registerMaterializer(sweBenchMaterializer);
  } catch (e) {
    console.error("[materializer] Failed to load SWE-bench materializer:", e);
  }

}

export async function copyToWorkspace(
  srcDir: string,
  dstDir: string,
  exclude: string[] = [],
): Promise<void> {
  await mkdir(dstDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });

  const excludeSet = new Set(exclude);
  for (const entry of entries) {
    if (excludeSet.has(entry.name)) continue;
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      await cp(src, dst, { recursive: true, force: true });
    } else {
      await cp(src, dst, { force: true });
    }
  }
}

export function patchTestPaths(
  workspaceDir: string,
): void {
  const testsDir = join(workspaceDir, "tests");
  if (!existsSync(testsDir)) return;

  const walk = (dir: string): string[] => {
    const entries = readdirSync(dir);
    let out: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        out = out.concat(walk(full));
      } else if (full.endsWith(".py")) {
        out.push(full);
      }
    }
    return out;
  };

  for (const file of walk(testsDir)) {
    const original = readFileSync(file, "utf-8");
    const patched = original.replace(/\/app\//g, "./");
    if (patched !== original) {
      writeFileSync(file, patched, "utf-8");
    }
  }
}

export function createTestRunner(
  workspaceDir: string,
): void {
  const runnerContent = `import os
import sys
import subprocess

os.chdir(os.path.dirname(os.path.abspath(__file__)))

test_dir = os.path.join(os.getcwd(), "tests")
test_file = os.path.join(test_dir, "test_outputs.py")

if not os.path.exists(test_file):
    print(f"Test file not found: {test_file}")
    sys.exit(0)

result = subprocess.run(
    [sys.executable, "-m", "pytest", test_file, "-rA"],
    capture_output=True,
    text=True,
    cwd=os.getcwd(),
)
print(result.stdout)
if result.stderr:
    print(result.stderr, file=sys.stderr)
sys.exit(result.returncode)
`;
  writeFileSync(join(workspaceDir, "__tb_runner.py"), runnerContent, "utf-8");
}
