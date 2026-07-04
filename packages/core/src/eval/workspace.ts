import { mkdir, cp, rm, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import type { EvalCaseManifest, SetupResult, SetupCommandResult } from "./types";
import type { SandboxProvider, SandboxCommand } from "../sandbox/types";
import { runMaterializers, initDefaultMaterializers } from "./materialize/shared";

export interface WorkspaceInfo {
  workspaceDir: string;
  caseDir: string;
  initialisedAt: string;
  sandboxProvider?: SandboxProvider;
  setupResult: SetupResult | null;
}

let _sandboxProvider: SandboxProvider | null = null;

export function setEvalSandboxProvider(provider: SandboxProvider | null): void {
  _sandboxProvider = provider;
}

export function getEvalSandboxProvider(): SandboxProvider | null {
  return _sandboxProvider;
}

function getCovaloRoot(): string {
  return process.env.COVALO_ROOT ?? resolve(".covalo");
}

function getEvalsDir(): string {
  return join(getCovaloRoot(), "evals");
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
  provider?: SandboxProvider | null,
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

  let setupResult: SetupResult | null = null;
  if (manifest.setup && manifest.setup.length > 0) {
    const runner = provider ?? _sandboxProvider;
    if (!runner) {
      throw new Error(`Setup requires a sandbox provider but none is available for case ${manifest.id}`);
    }

    const setupStarted = new Date().toISOString();
    const commandResults: SetupCommandResult[] = [];
    let allPassed = true;

    for (const cmd of manifest.setup) {
      const cmdStart = new Date().toISOString();
      const sandboxCmd: SandboxCommand = {
        command: cmd,
        cwd: workspaceDir,
        timeoutMs: 300_000,
        allowNetwork: manifest.network ?? false,
        readRoots: [workspaceDir],
        writeRoots: [workspaceDir],
      };
      const result = await runner.run(sandboxCmd);
      const cmdEnd = new Date().toISOString();
      const passed = result.exitCode === 0 && !result.timedOut;
      if (!passed) allPassed = false;
      commandResults.push({
        command: cmd,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt: cmdStart,
        finishedAt: cmdEnd,
      });
    }

    setupResult = {
      commands: commandResults,
      allPassed,
      startedAt: setupStarted,
      finishedAt: new Date().toISOString(),
    };

    if (!allPassed) {
      throw new SetupFailedError(setupResult);
    }
  }

  const { execSync } = await import("node:child_process");
  // A1: 跨平台兼容 — 去掉 POSIX-only 的 2>/dev/null（用 stdio:"pipe" 抑制输出），
  // 拆分 && 链为独立调用（Windows cmd.exe 的 && 行为与 POSIX 不同）。
  execSync("git init", { cwd: workspaceDir, stdio: "pipe" });
  execSync("git config user.email eval@covalo", { cwd: workspaceDir, stdio: "pipe" });
  execSync("git config user.name covalo-eval", { cwd: workspaceDir, stdio: "pipe" });
  execSync("git add -A", { cwd: workspaceDir, stdio: "pipe" });
  execSync("git commit -m baseline --allow-empty", { cwd: workspaceDir, stdio: "pipe" });

  return {
    workspaceDir,
    caseDir,
    initialisedAt: new Date().toISOString(),
    sandboxProvider: _sandboxProvider ?? undefined,
    setupResult,
  };
}

export class SetupFailedError extends Error {
  setupResult: SetupResult;
  constructor(setupResult: SetupResult) {
    super("Setup failed");
    this.name = "SetupFailedError";
    this.setupResult = setupResult;
  }
}

export { getCaseWorkspaceDir };
export { getFixtureDir };
export { getCovaloRoot, getEvalsDir };

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
