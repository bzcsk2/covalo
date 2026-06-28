import { mkdir, cp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { EvalCaseManifest } from "./types";
import type { SandboxProvider } from "../sandbox/types";
import { runMaterializers, initDefaultMaterializers } from "./materialize/shared";

export interface WorkspaceInfo {
  workspaceDir: string;
  caseDir: string;
  initialisedAt: string;
  sandboxProvider?: SandboxProvider;
}

let _sandboxProvider: SandboxProvider | null = null;

export function setEvalSandboxProvider(provider: SandboxProvider | null): void {
  _sandboxProvider = provider;
}

export function getEvalSandboxProvider(): SandboxProvider | null {
  return _sandboxProvider;
}

function getDeepReefRoot(): string {
  return process.env.DEEPRREF_ROOT ?? resolve(".deepreef");
}

function getEvalsDir(): string {
  return join(getDeepReefRoot(), "evals");
}

function getFixtureDir(): string {
  const pkgDir = resolve(
    import.meta.dirname ?? __dirname,
    "..",
  );
  return join(pkgDir, "eval", "fixtures");
}

function getCaseWorkspaceDir(caseDir: string): string {
  return join(caseDir, "workspace");
}

export async function createCaseWorkspace(
  runId: string,
  manifest: EvalCaseManifest,
): Promise<WorkspaceInfo> {
  const caseDir = join(getEvalsDir(), runId, "cases", manifest.id);
  const workspaceDir = join(caseDir, "workspace");

  await mkdir(workspaceDir, { recursive: true });

  const fixturePath = join(getFixtureDir(), manifest.fixtureSource);
  if (existsSync(fixturePath)) {
    await cp(fixturePath, workspaceDir, {
      recursive: true,
      force: true,
    });
  }

  const isMaterialized = manifest.fixtureSource.startsWith("__");
  if (isMaterialized) {
    await initDefaultMaterializers();
    await runMaterializers(manifest, workspaceDir);
  }

  const { execSync } = await import("node:child_process");
  execSync("git init 2>/dev/null", { cwd: workspaceDir, stdio: "pipe" });
  execSync("git config user.email eval@deepreef && git config user.name deepreef-eval", { cwd: workspaceDir, stdio: "pipe" });
  execSync("git add -A && git commit -m baseline --allow-empty 2>/dev/null", { cwd: workspaceDir, stdio: "pipe" });

  if (manifest.setup && manifest.setup.length > 0) {
    for (const cmd of manifest.setup) {
      execSync(cmd, { cwd: workspaceDir, stdio: "pipe" });
    }
  }

  return {
    workspaceDir,
    caseDir,
    initialisedAt: new Date().toISOString(),
    sandboxProvider: _sandboxProvider ?? undefined,
  };
}

export { getCaseWorkspaceDir };
export { getFixtureDir };
export { getDeepReefRoot, getEvalsDir };

export async function writeCaseArtifact(
  caseDir: string,
  filename: string,
  content: string,
): Promise<void> {
  await writeFile(join(caseDir, filename), content, "utf-8");
}

export async function readCaseArtifact(
  caseDir: string,
  filename: string,
): Promise<string | null> {
  const filePath = join(caseDir, filename);
  if (!existsSync(filePath)) return null;
  return await readFile(filePath, "utf-8");
}

export async function cleanupCaseWorkspace(caseDir: string): Promise<void> {
  const workspaceDir = join(caseDir, "workspace");
  if (existsSync(workspaceDir)) {
    await rm(workspaceDir, { recursive: true, force: true });
  }
}
