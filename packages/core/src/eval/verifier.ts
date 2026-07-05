import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { EvalCaseManifest, VerifierResult, FileAssertion } from "./types";
import type { SandboxProvider, SandboxCommand } from "../sandbox/types";
import { resolveWithinRoot, UnsafeEvalPathError } from "./path-guards";

let _sandboxProvider: SandboxProvider | null = null;

export function setSandboxProvider(provider: SandboxProvider | null): void {
  _sandboxProvider = provider;
}

export function getSandboxProvider(): SandboxProvider | null {
  return _sandboxProvider;
}

export async function runVerifier(
  manifest: EvalCaseManifest,
  workspaceDir: string,
): Promise<VerifierResult> {
  switch (manifest.verifier.type) {
    case "command":
      return runCommandVerifier(manifest, workspaceDir);
    case "file-assert":
      return runFileAssertVerifier(manifest, workspaceDir);
    case "script":
      return runScriptVerifier(manifest, workspaceDir);
    default:
      return {
        passed: false,
        verdict: "error",
        stdout: "",
        stderr: "",
        exitCode: null,
        details: [`Unknown verifier type: ${(manifest.verifier as { type: string }).type}`],
      };
  }
}

async function runCommandVerifier(
  manifest: EvalCaseManifest,
  workspaceDir: string,
): Promise<VerifierResult> {
  const command = manifest.verifier.command;
  if (!command) {
    return {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr: "",
      exitCode: null,
      details: ["No command specified for command verifier"],
    };
  }

  const provider = _sandboxProvider;
  if (provider) {
    return runCommandViaProvider(provider, command, manifest, workspaceDir);
  }

  return runCommandDirect(command, manifest, workspaceDir);
}

async function runCommandViaProvider(
  provider: SandboxProvider,
  command: string,
  manifest: EvalCaseManifest,
  workspaceDir: string,
): Promise<VerifierResult> {
  const timeout = manifest.verifier.timeoutMs ?? 60_000;
  const sandboxCmd: SandboxCommand = {
    command,
    cwd: workspaceDir,
    timeoutMs: timeout,
    allowNetwork: false,
    readRoots: [workspaceDir],
    writeRoots: [workspaceDir],
  };

  let result;
  try {
    result = await provider.run(sandboxCmd);
  } catch (err) {
    const stderr = err instanceof Error ? err.message : String(err);
    const errName = err instanceof Error ? err.name : "UnknownError";
    return {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr,
      exitCode: null,
      details: [
        "Sandbox provider threw during command verifier",
        errName,
      ],
    };
  }

  const fileResults = await runFileAssertions(
    manifest.verifier.fileAssertions ?? [],
    workspaceDir,
  );

  const passed = result.exitCode === 0 && fileResults.passed;
  const details: string[] = [];
  if (result.exitCode === 0) {
    details.push("Command executed successfully via sandbox provider");
  } else {
    details.push(`Command failed with exit code ${result.exitCode}`);
    if (result.timedOut) details.push("Command timed out");
  }
  details.push(...fileResults.details);

  return {
    passed,
    verdict: passed ? "pass" : result.timedOut ? "error" : "fail",
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    details,
  };
}

/**
 * Check whether direct command verifier execution is allowed.
 * Default is off (fail-closed). Set COVALO_ALLOW_DIRECT_VERIFIER=1 to enable.
 */
function isDirectVerifierAllowed(): boolean {
  return process.env.COVALO_ALLOW_DIRECT_VERIFIER === "1";
}

/**
 * Validate and resolve a verifier script path.
 * Returns the resolved absolute path if valid, or an error string.
 */
function resolveVerifierScriptPath(
  workspaceDir: string,
  scriptPath: string,
): { resolved: string } | { error: string } {
  if (!scriptPath || typeof scriptPath !== "string") {
    return { error: "scriptPath must be a non-empty string" };
  }

  // Reject NUL character
  if (scriptPath.includes("\0")) {
    return { error: "scriptPath contains NUL character" };
  }

  // Reject shell metacharacters
  // eslint-disable-next-line no-control-regex
  const shellMeta = /[;&|<>`]|\$\(|\n|\r/;
  if (shellMeta.test(scriptPath)) {
    return { error: "scriptPath contains shell metacharacters" };
  }

  const resolved = resolve(workspaceDir, scriptPath);
  const rel = relative(workspaceDir, resolved);

  // Must be contained within workspaceDir
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `scriptPath must be within workspace directory` };
  }

  return { resolved };
}

/**
 * Warn via process.stderr when direct verifier override is used.
 */
function emitDirectVerifierWarning(kind: string): void {
  // Use stderr to avoid interfering with structured output
  process.stderr.write(
    `[covalo] WARN: Direct ${kind} verifier execution enabled by COVALO_ALLOW_DIRECT_VERIFIER=1. ` +
    `This mode is intended only for trusted local evals.\n`,
  );
}

async function runCommandDirect(
  command: string,
  manifest: EvalCaseManifest,
  workspaceDir: string,
): Promise<VerifierResult> {
  // Fail-closed: no sandbox provider → disabled by default
  if (!isDirectVerifierAllowed()) {
    return {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr: "",
      exitCode: null,
      details: [
        "Direct command verifier disabled; configure sandbox provider or " +
        "set COVALO_ALLOW_DIRECT_VERIFIER=1 for trusted local evals.",
      ],
    };
  }

  emitDirectVerifierWarning("command");

  const timeout = manifest.verifier.timeoutMs ?? 60_000;
  try {
    const { execSync } = await import("node:child_process");
    const output = execSync(command, {
      cwd: workspaceDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout,
      stdio: "pipe",
    });

    const stdout = output?.toString() ?? "";
    const details: string[] = [
      "Command executed successfully",
      "Direct verifier execution enabled by COVALO_ALLOW_DIRECT_VERIFIER=1",
    ];

    const fileResults = await runFileAssertions(
      manifest.verifier.fileAssertions ?? [],
      workspaceDir,
    );
    details.push(...fileResults.details);
    const passed = fileResults.passed;

    return {
      passed,
      verdict: passed ? "pass" : "fail",
      stdout,
      stderr: "",
      exitCode: 0,
      details,
    };
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string; status?: number; killed?: boolean; signal?: string };
    const stderr = error.stderr ?? "";
    const stdout = error.stdout ?? "";
    const exitCode = error.status ?? 1;

    const isTimeout = error.killed || error.signal === "SIGTERM";
    if (isTimeout) {
      return {
        passed: false,
        verdict: "error",
        stdout,
        stderr,
        exitCode,
        details: [`Command timed out after ${timeout}ms`],
      };
    }

    const details: string[] = [`Command failed with exit code ${exitCode}`];
    if (stderr) {
      details.push(`stderr: ${stderr.slice(0, 500)}`);
    }

    return {
      passed: false,
      verdict: "fail",
      stdout,
      stderr,
      exitCode,
      details,
    };
  }
}

async function runFileAssertVerifier(
  manifest: EvalCaseManifest,
  workspaceDir: string,
): Promise<VerifierResult> {
  const assertions = manifest.verifier.fileAssertions ?? [];
  if (assertions.length === 0) {
    return {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr: "",
      exitCode: null,
      details: ["file-assert verifier with empty assertions — must specify at least one file assertion"],
    };
  }
  const result = await runFileAssertions(assertions, workspaceDir);

  return {
    passed: result.passed,
    verdict: result.passed ? "pass" : "fail",
    stdout: "",
    stderr: "",
    exitCode: result.passed ? 0 : 1,
    details: result.details,
  };
}

async function runScriptVerifier(
  manifest: EvalCaseManifest,
  workspaceDir: string,
): Promise<VerifierResult> {
  const scriptPath = manifest.verifier.scriptPath;
  if (!scriptPath) {
    return {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr: "",
      exitCode: null,
      details: ["No scriptPath specified for script verifier"],
    };
  }

  // Validate and resolve scriptPath — prevents shell injection
  const pathResult = resolveVerifierScriptPath(workspaceDir, scriptPath);
  if ("error" in pathResult) {
    return {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr: "",
      exitCode: null,
      details: [`Invalid scriptPath: ${pathResult.error}`],
    };
  }
  const resolvedScriptPath = pathResult.resolved;

  const provider = _sandboxProvider;
  if (provider) {
    const timeout = manifest.verifier.timeoutMs ?? 60_000;
    // Use validated resolved path for sandbox provider
    let result;
    try {
      result = await provider.run({
        command: `bun run ${resolvedScriptPath}`,
        cwd: workspaceDir,
        timeoutMs: timeout,
        allowNetwork: false,
        readRoots: [workspaceDir],
        writeRoots: [workspaceDir],
      });
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      const errName = err instanceof Error ? err.name : "UnknownError";
      return {
        passed: false,
        verdict: "error",
        stdout: "",
        stderr,
        exitCode: null,
        details: [
          "Sandbox provider threw during script verifier",
          errName,
        ],
      };
    }

    if (result.exitCode === 0) {
      return {
        passed: true,
        verdict: "pass",
        stdout: result.stdout,
        stderr: "",
        exitCode: 0,
        details: ["Script executed successfully via sandbox provider"],
      };
    }
    return {
      passed: false,
      verdict: result.timedOut ? "error" : "fail",
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      details: [`Script failed: exit ${result.exitCode}`],
    };
  }

  // Fail-closed: no sandbox provider → disabled by default
  if (!isDirectVerifierAllowed()) {
    return {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr: "",
      exitCode: null,
      details: [
        "Direct script verifier disabled; configure sandbox provider or " +
        "set COVALO_ALLOW_DIRECT_VERIFIER=1 for trusted local evals.",
      ],
    };
  }

  emitDirectVerifierWarning("script");

  try {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync("bun", ["run", resolvedScriptPath], {
      cwd: workspaceDir,
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
      stdio: "pipe",
    });

    return {
      passed: true,
      verdict: "pass",
      stdout: output?.toString() ?? "",
      stderr: "",
      exitCode: 0,
      details: ["Script executed successfully"],
    };
  } catch (err: unknown) {
    const error = err as Error & { stdout?: string; stderr?: string; status?: number };
    const msg = (error as Error).message;
    const isSetupError =
      msg.includes("ENOENT") ||
      msg.includes("not found") ||
      msg.includes("not recognized") ||
      msg.includes("Cannot find");
    return {
      passed: false,
      verdict: isSetupError ? "error" : "fail",
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      exitCode: error.status ?? 1,
      details: [`Script failed: ${msg}`],
    };
  }
}

interface FileAssertionResult {
  passed: boolean;
  details: string[];
}

async function runFileAssertions(
  assertions: FileAssertion[],
  workspaceDir: string,
): Promise<FileAssertionResult> {
  const details: string[] = [];

  for (const assertion of assertions) {
    let fullPath: string;
    try {
      fullPath = resolveWithinRoot(workspaceDir, assertion.path, "file assertion path");
    } catch (err) {
      details.push(`ERROR: unsafe file assertion path ${assertion.path}`);
      return { passed: false, details };
    }
    const exists = existsSync(fullPath);

    if (assertion.mustExist === true && !exists) {
      details.push(`FAIL: File ${assertion.path} must exist but not found`);
      return { passed: false, details };
    }
    if (assertion.mustExist === false && exists) {
      details.push(`FAIL: File ${assertion.path} must not exist but found`);
      return { passed: false, details };
    }

    if (!exists) {
      details.push(`SKIP: File ${assertion.path} does not exist, skipping content checks`);
      continue;
    }

    if (assertion.mustContain && assertion.mustContain.length > 0) {
      const stat = await readFile(fullPath, "utf-8");
      for (const content of assertion.mustContain) {
        if (!stat.includes(content)) {
          details.push(`FAIL: File ${assertion.path} must contain "${content}"`);
          return { passed: false, details };
        }
        details.push(`PASS: File ${assertion.path} contains "${content}"`);
      }
    }

    if (assertion.mustNotContain && assertion.mustNotContain.length > 0) {
      const stat = await readFile(fullPath, "utf-8");
      for (const content of assertion.mustNotContain) {
        if (stat.includes(content)) {
          details.push(`FAIL: File ${assertion.path} must not contain "${content}"`);
          return { passed: false, details };
        }
        details.push(`PASS: File ${assertion.path} does not contain "${content}"`);
      }
    }
  }

  details.push("All file assertions passed");
  return { passed: true, details };
}
