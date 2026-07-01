import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { existsSync, rmSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { getPromptLocale } from "../prompt-locale.js";
import type { PromptLocale } from "../prompt-locale.js";
import { evalToolTracker } from "./tool-tracker";
import { resolveProfile } from "./profile/resolver";
import { getBenchmarkToolchainStatus, type BenchmarkToolchainStatus } from "./profile/installer";

const COMMON_TEST_FILE_PATTERNS = [
  /\.(test|spec|e2e)\.[jt]sx?$/,
  /_test\.(py|go)$/,
  /__tests__\//,
  /(vitest|jest|playwright)\.config\./,
  /tsconfig\.json$/,
  /test_/,
  /\/test\//,
];
import type {
  EvalCategoryId,
  EvalSuiteId,
  EvalCaseManifest,
  FixedEvalOptions,
  CaseResult,
  SuiteSummary,
  VerifierResult,
  ObjectiveSignals,
  CaseScore,
  EvalRunMeta,
  EvalRunReport,
  EvalProgressEvent,
  EvalEnvironmentId,
  SandboxProviderId,
  PreflightResult,
  PolicyGateResult,
  FailureClass,
  FailureEvidence,
} from "./types";
import { getSuite, getCategories } from "./registry";
import { getManifest } from "./loader";
import {
  MissingEvalAssetError,
  CorruptEvalAssetError,
  UnsafeEvalAssetPathError,
  EvalAssetExtractionError,
} from "./types";
import { createCaseWorkspace, writeCaseArtifact, getCaseWorkspaceDir, setEvalSandboxProvider, getEvalSandboxProvider, SetupFailedError } from "./workspace";
import { runVerifier, setSandboxProvider as setVerifierSandboxProvider } from "./verifier";
import { classifyVerifierResult } from "./verifier-classifier";
import { initDefaultProviders, detectBestProvider } from "../sandbox/provider-registry";
import { resolveEvalEnvironment } from "../sandbox/types";
let _currentCaseWorkspace: string | null = null;
let _currentEvalRunId: string | null = null;
let _currentEvalContext: { evalRunId: string; environmentId: string; providerId: string; caseId?: string } | null = null;
let _currentEvalLogger: import("../runtime-logger").RuntimeLogger | null = null;

export function getCurrentCaseWorkspace(): string | null {
  return _currentCaseWorkspace;
}

export function getCurrentEvalContext(): { evalRunId: string; environmentId: string; providerId: string; caseId?: string } | null {
  return _currentEvalContext;
}

export function getCurrentEvalLogger(): import("../runtime-logger").RuntimeLogger | null {
  return _currentEvalLogger;
}

function getDeepReefRoot(): string {
  return process.env.DEEPRREF_ROOT ?? ".deepreef";
}

function getEvalsDir(): string {
  return join(getDeepReefRoot(), "evals");
}

function countVerifierCommands(manifest: import("./types").EvalCaseManifest): number {
  if (manifest.verifier.type === "file-assert") return 0;
  if (manifest.verifier.type === "script") return 1;
  if (manifest.verifier.type === "command" && manifest.verifier.command) {
    const cmd = manifest.verifier.command;
    return cmd.split(/[;&|]|&&|\|\|/).filter(s => s.trim().length > 0).length;
  }
  return 0;
}

function getObjectiveSignals(workspaceDir: string): ObjectiveSignals {
  try {
    const diffNames = execSync("git diff --name-only 2>&1", {
      cwd: workspaceDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).toString().trim();

    const changedFiles = diffNames ? diffNames.split("\n").filter(Boolean).length : 0;

    const diffSize = execSync("git diff 2>&1 | wc -l", {
      cwd: workspaceDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).toString().trim();

    const cleanGitDiff = !diffNames;

    return {
      changedFiles,
      diffSize: parseInt(diffSize, 10) || 0,
      toolFailureCount: 0,
      verificationCommandsRun: 0,
      cleanGitDiff,
      outOfBoundsWrites: [],
      toolTrackingValid: false,
    };
  } catch {
    return {
      changedFiles: 0,
      diffSize: 0,
      toolFailureCount: 0,
      verificationCommandsRun: 0,
      cleanGitDiff: true,
      outOfBoundsWrites: [],
      toolTrackingValid: false,
    };
  }
}

function computeScore(
  verifierResult: VerifierResult | null,
  objectiveSignals: ObjectiveSignals | null,
  supervisorAssessment: Record<string, number> | null,
  policyGates: PolicyGateResult[] = [],
): CaseScore {
  const VW = 0.7;
  const OW = 0.2;
  const SW = 0.1;

  let verifierScore = 0;
  if (verifierResult) {
    if (verifierResult.verdict === "pass") verifierScore = 100;
    else if (verifierResult.verdict === "error") verifierScore = 0;
    else verifierScore = 0;
  }

  let objectiveScore = 50;
  if (objectiveSignals) {
    objectiveScore = 100;
    if (objectiveSignals.toolFailureCount > 0) {
      objectiveScore -= Math.min(objectiveSignals.toolFailureCount * 10, 50);
    }
    if (!objectiveSignals.toolTrackingValid) {
      objectiveScore -= 20;
    }
    if (!objectiveSignals.cleanGitDiff && objectiveSignals.changedFiles === 0) {
      objectiveScore -= 20;
    }
    objectiveScore = Math.max(0, Math.min(100, objectiveScore));
  }

  let supervisorScore = 50;
  if (supervisorAssessment) {
    const dims = Object.values(supervisorAssessment);
    if (dims.length > 0) {
      supervisorScore = dims.reduce((a, b) => a + b, 0) / dims.length;
    }
  }

  let finalScore =
    verifierScore * VW + objectiveScore * OW + supervisorScore * SW;

  if (verifierResult && verifierResult.verdict === "fail") {
    finalScore = Math.min(finalScore, 40);
  }
  if (verifierResult && verifierResult.verdict === "error") {
    finalScore = 0;
  }

  const hasPolicyFailures = policyGates.some(g => !g.passed);

  return {
    verifierWeight: VW,
    objectiveWeight: OW,
    supervisorWeight: SW,
    verifierScore,
    objectiveScore,
    supervisorScore,
    finalScore: hasPolicyFailures ? 0 : Math.round(finalScore * 100) / 100,
    scoreIneligible: hasPolicyFailures,
  };
}

function getPatchDiff(workspaceDir: string): string {
  try {
    return execSync("git diff 2>&1", {
      cwd: workspaceDir,
      encoding: "utf-8",
      stdio: "pipe",
    }).toString();
  } catch {
    return "";
  }
}

async function resolveSandboxProvider(
  options: FixedEvalOptions,
): Promise<{ provider: import("../sandbox/types").SandboxProvider; environmentId: EvalEnvironmentId; providerId: SandboxProviderId; officialScore: boolean; fallbackReason?: string; benchmarkToolchainStatus?: BenchmarkToolchainStatus }> {
  const env = options.environmentId ? resolveEvalEnvironment(options.environmentId) : "sandbox.benchmark";
  const benchmarkToolchainStatus = env === "sandbox.benchmark" ? getBenchmarkToolchainStatus() : undefined;
  const benchmarkReason = benchmarkToolchainStatus && !benchmarkToolchainStatus.ready
    ? formatBenchmarkToolchainReason(benchmarkToolchainStatus)
    : undefined;
  const mergeReason = (...reasons: Array<string | undefined>): string | undefined => {
    const merged = reasons.filter(Boolean).join("; ");
    return merged || undefined;
  };
  if (options.sandboxProvider) {
    const officialScore = env === "sandbox.benchmark" && benchmarkToolchainStatus?.ready === true;
    return {
      provider: options.sandboxProvider,
      environmentId: env,
      providerId: options.sandboxProvider.id,
      officialScore,
      fallbackReason: benchmarkReason,
      benchmarkToolchainStatus,
    };
  }

  const environmentId = env;
  initDefaultProviders();
  const { provider, capabilities } = await detectBestProvider(environmentId);

  const profile = resolveProfile(environmentId);
  if (provider.setProfile) {
    provider.setProfile(profile);
  }

  return {
    provider,
    environmentId,
    providerId: provider.id,
    officialScore: environmentId === "sandbox.benchmark" && capabilities.official && benchmarkToolchainStatus?.ready === true,
    fallbackReason: mergeReason(capabilities.reason, benchmarkReason),
    benchmarkToolchainStatus,
  };
}

function formatBenchmarkToolchainReason(status: BenchmarkToolchainStatus): string {
  const parts: string[] = [];
  if (status.missingTools.length > 0) {
    parts.push(`missing managed tools: ${status.missingTools.join(", ")}`);
  }
  if (status.missingSha256.length > 0) {
    parts.push(`missing sha256 pins: ${status.missingSha256.join(", ")}`);
  }
  if (status.versionMismatches.length > 0) {
    parts.push(`version mismatch: ${status.versionMismatches.map(v => `${v.name} expected ${v.expected}, got ${v.actual ?? "unknown"}`).join("; ")}`);
  }
  return `Benchmark toolchain not official: ${parts.join("; ")}`;
}

async function runPreflight(
  provider: import("../sandbox/types").SandboxProvider,
  environmentId: EvalEnvironmentId,
): Promise<PreflightResult | null> {
  if (!provider.runPreflight) return null;
  try {
    return await provider.runPreflight(environmentId);
  } catch {
    return null;
  }
}

async function runSingleCase(
  manifest: EvalCaseManifest,
  workspaceDir: string,
  caseDir: string,
  options: FixedEvalOptions,
  setupResult?: import("./types").SetupResult | null,
  runId?: string,
): Promise<CaseResult> {
  const startedAt = new Date().toISOString();
  const emitObs = options.writeObservability ?? (() => {});
  const caseId = manifest.id;

  // Contract preflight: check required binaries
  if (manifest.requiredBinaries && manifest.requiredBinaries.length > 0) {
    const provider = getEvalSandboxProvider();
    if (provider) {
      const missingBinaries: string[] = [];
      for (const binary of manifest.requiredBinaries) {
        try {
          const result = await provider.run({
            command: `command -v ${binary} 2>/dev/null`,
            cwd: workspaceDir,
            timeoutMs: 10_000,
            allowNetwork: false,
            readRoots: [workspaceDir],
            writeRoots: [workspaceDir],
          });
          if (result.exitCode !== 0) {
            missingBinaries.push(binary);
          }
        } catch {
          missingBinaries.push(binary);
        }
      }
      if (missingBinaries.length > 0) {
        const finishedAt = new Date().toISOString();
        return {
          caseId: manifest.id,
          title: manifest.title,
          category: manifest.category,
          suite: manifest.suite,
          manifest,
          verdict: "infra_error",
          verifierResult: null,
          objectiveSignals: null,
          setupResult: null,
          policyGates: [],
          supervisorAssessment: null,
          score: null,
          workerOutput: "",
          supervisorOutput: "",
          patchDiff: "",
          caseContract: null,
          startedAt,
          finishedAt,
          error: `Infrastructure error: missing required binaries: ${missingBinaries.join(", ")}`,
          failureClass: "preflight_failure" as FailureClass,
          failureReason: `Missing required binaries: ${missingBinaries.join(", ")}`,
          failureEvidence: { missing: missingBinaries },
          scoreEligible: false,
          officialScoreEligible: false,
        };
      }
    }
  }

  // Contract preflight: check required Python modules
  if (manifest.requiredPythonModules && manifest.requiredPythonModules.length > 0) {
    const provider = getEvalSandboxProvider();
    if (provider) {
      const missingModules: string[] = [];
      for (const mod of manifest.requiredPythonModules) {
        try {
          const result = await provider.run({
            command: `python3 -c "import ${mod}" 2>/dev/null`,
            cwd: workspaceDir,
            timeoutMs: 10_000,
            allowNetwork: false,
            readRoots: [workspaceDir],
            writeRoots: [workspaceDir],
          });
          if (result.exitCode !== 0) {
            missingModules.push(mod);
          }
        } catch {
          missingModules.push(mod);
        }
      }
      if (missingModules.length > 0) {
        const finishedAt = new Date().toISOString();
        return {
          caseId: manifest.id,
          title: manifest.title,
          category: manifest.category,
          suite: manifest.suite,
          manifest,
          verdict: "infra_error",
          verifierResult: null,
          objectiveSignals: null,
          setupResult: null,
          policyGates: [],
          supervisorAssessment: null,
          score: null,
          workerOutput: "",
          supervisorOutput: "",
          patchDiff: "",
          caseContract: null,
          startedAt,
          finishedAt,
          error: `Infrastructure error: missing required Python modules: ${missingModules.join(", ")}`,
          failureClass: "preflight_failure" as FailureClass,
          failureReason: `Missing required Python modules: ${missingModules.join(", ")}`,
          failureEvidence: { missing: missingModules },
          scoreEligible: false,
          officialScoreEligible: false,
        };
      }
    }
  }

  let workerOutput = "";
  let supervisorOutput = "";
  let verifierResult: VerifierResult | null = null;
  let supervisorAssessment: Record<string, number> | null = null;
  let error: string | undefined;
  let protectedViolations: string[] = [];
  let changedFiles: string[] = [];

  const outOfBoundsWrites: string[] = [];
  if (manifest.outOfBoundsCheckPaths) {
    for (const p of manifest.outOfBoundsCheckPaths) {
      try { rmSync(p, { force: true, recursive: true }); } catch {}
    }
  }

  let toolTrackingValid = false;
  evalToolTracker.enable();

  try {
    if (options.executeWorker) {
      emitObs("eval.case.worker.start", "info", { caseId });
      const workerStartedAt = new Date().toISOString();
      toolTrackingValid = true;
      const workerPrompt = buildWorkerPrompt(manifest, workspaceDir);

      // Write TaskDigestPacket from case manifest
      const { createTaskDigest } = await import("../harness-evolution/packets/task-digest");
      const taskDigestPacket = createTaskDigest({
        packetId: `${runId || "eval"}:digest:${caseId}`,
        runId: runId || "eval",
        mode: "eval",
        role: "system",
        evalRunId: runId || "eval",
        caseId,
        goal: manifest.taskPrompt || manifest.title || "Eval case",
        acceptanceCriteria: manifest.expectedVerification ?? [],
        repoFacts: {
          cwd: workspaceDir,
          packageManager: undefined,
          gitBranch: undefined,
          gitClean: undefined,
          relevantConfigFiles: [],
        },
        contextFiles: [],
        constraints: manifest.requiredBinaries ? [`Requires binaries: ${manifest.requiredBinaries.join(", ")}`] : [],
        verificationPlan: manifest.expectedVerification ?? [],
        omittedContext: [],
      });
      await writeCaseArtifact(caseDir, "task-digest.json", JSON.stringify(taskDigestPacket, null, 2));

      // Runtime guard before worker dispatch
      const { guardPrompt, createRuntimeGuardPacket } = await import("../harness-evolution/packets/runtime-guard");
      const guard = guardPrompt(workerPrompt);
      const guardPacket = createRuntimeGuardPacket({
        packetId: `${runId || "eval"}:guard:${caseId}`,
        runId: runId || "eval",
        prompt: workerPrompt,
        mode: "eval",
        role: "system",
        evalRunId: runId || "eval",
        caseId,
      });
      await writeCaseArtifact(caseDir, "runtime-guard.json", JSON.stringify(guardPacket, null, 2));

      // Emit guard observability event
      emitObs("harness.guard." + guard.disposition, "info", { caseId, runId, findings: guard.findings.map(f => f.kind) });

      if (guard.disposition === "block") {
        error = `Runtime guard blocked worker dispatch: ${guard.findings.map(f => f.kind).join(", ")}`;
        workerOutput = "";
        emitObs("eval.case.worker.done", "info", { caseId, outputLength: 0, blocked: true });

        // Write action certificate for blocked action
        const { createActionCertificate, completeActionCertificate, classifyRisk } = await import("../harness-evolution/packets/action-certificate");
        const highestRiskFinding = guard.findings.find(f => f.kind === "destructive_action" || f.kind === "privileged_action_without_certificate");
        if (highestRiskFinding) {
          const cert = createActionCertificate({
            packetId: `${runId || "eval"}:cert:${caseId}`,
            runId: runId || "eval",
            actionId: `blocked:${caseId}`,
            action: { toolName: "bash", command: workerPrompt.slice(0, 200), affectedFiles: [] },
            riskLevel: classifyRisk(workerPrompt),
            approval: { class: "runtime_enforced" },
            assumptions: [],
            rollbackPlan: "N/A",
            mode: "eval",
            role: "worker",
            evalRunId: runId || "eval",
            caseId,
          });
          const completed = completeActionCertificate(cert, { status: "cancelled", exitCode: -1, durationMs: 0 });
          await writeCaseArtifact(caseDir, "action-certificate.json", JSON.stringify(completed, null, 2));
        }
      } else {
        const prevCwd = process.cwd();
        process.chdir(workspaceDir);
        _currentCaseWorkspace = workspaceDir;
        try {
          workerOutput = await options.executeWorker(workerPrompt);
        } finally {
          _currentCaseWorkspace = null;
          process.chdir(prevCwd);
        }
        const workerFinishedAt = new Date().toISOString();
        emitObs("eval.case.worker.done", "info", { caseId, outputLength: workerOutput.length });
        await writeCaseArtifact(caseDir, "worker-output.md", workerOutput);
        await writeCaseArtifact(
          caseDir,
          "worker-submit.json",
          JSON.stringify({
            caseId,
            startedAt: workerStartedAt,
            finishedAt: workerFinishedAt,
            outputLength: workerOutput.length,
            outputEmpty: workerOutput.trim().length === 0,
          }, null, 2),
        );
      }
    }

    async function getChangedFiles(dir: string): Promise<string[]> {
      try {
        const { execSync } = await import("node:child_process");
        const out = execSync("git diff --name-only 2>/dev/null", { cwd: dir, encoding: "utf-8", stdio: "pipe" }).toString().trim();
        return out ? out.split("\n").filter(Boolean) : [];
      } catch { return []; }
    }

    changedFiles = await getChangedFiles(workspaceDir);
    function matchProtectedFile(filePath: string, pattern: string): boolean {
      if (filePath === pattern) return true;
      if (filePath.startsWith(pattern + "/") || filePath.startsWith(pattern)) return true;
      if (pattern.endsWith("/") && filePath.includes("/" + pattern)) return true;
      return false;
    }
    if (manifest.protectedFiles && manifest.protectedFiles.length > 0) {
      for (const pf of manifest.protectedFiles) {
        if (changedFiles.some(cf => matchProtectedFile(cf, pf))) {
          protectedViolations.push(pf);
        }
      }
    }

    // Auto-protect test/verifier files for all case types
    const allChangedFiles = new Set(changedFiles);
    try {
      const untracked = execSync("git ls-files --others --exclude-standard 2>/dev/null", {
        cwd: workspaceDir, encoding: "utf-8", stdio: "pipe",
      }).toString().trim();
      if (untracked) {
        for (const uf of untracked.split("\n").filter(Boolean)) {
          allChangedFiles.add(uf);
        }
      }
    } catch {}
    for (const cf of allChangedFiles) {
      if (COMMON_TEST_FILE_PATTERNS.some(p => p.test(cf))) {
        const alreadyListed = protectedViolations.some(v => cf === v || cf.startsWith(v + "/") || cf.startsWith(v));
        if (!alreadyListed) {
          protectedViolations.push(cf);
        }
      }
    }

    emitObs("eval.case.verifier.start", "info", { caseId });
    verifierResult = await runVerifier(manifest, workspaceDir);
    emitObs("eval.case.verifier.done", "info", { caseId, verdict: verifierResult?.verdict ?? null });
    await writeCaseArtifact(
      caseDir,
      "verifier.json",
      JSON.stringify(verifierResult, null, 2),
    );
    // Write verifier classification
    if (verifierResult) {
      const vc = classifyVerifierResult(verifierResult, manifest);
      await writeCaseArtifact(
        caseDir,
        "verifier-classification.json",
        JSON.stringify(vc, null, 2),
      );
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  if (manifest.outOfBoundsCheckPaths) {
    for (const p of manifest.outOfBoundsCheckPaths) {
      if (existsSync(p)) {
        outOfBoundsWrites.push(p);
      }
    }
  }

  const toolStats = evalToolTracker.getStats();
  evalToolTracker.disable();

  const finishedAt = new Date().toISOString();
  const objectiveSignals = getObjectiveSignals(workspaceDir);
  objectiveSignals.outOfBoundsWrites = outOfBoundsWrites;
  objectiveSignals.toolTrackingValid = toolTrackingValid;
  objectiveSignals.verificationCommandsRun = verifierResult ? countVerifierCommands(manifest) : 0;
  if (toolTrackingValid) {
    objectiveSignals.toolFailureCount = toolStats.failures;
  }
  const patchDiff = getPatchDiff(workspaceDir);

  if (patchDiff) {
    await writeCaseArtifact(caseDir, "patch.diff", patchDiff);
  }

  // Write objective signals
  await writeCaseArtifact(
    caseDir,
    "objective-signals.json",
    JSON.stringify(objectiveSignals, null, 2),
  );

  // Write tool stats (detailed per-event tracking requires tool-level instrumentation)
  const toolSummary = { calls: toolStats.calls, failures: toolStats.failures };
  await writeCaseArtifact(
    caseDir,
    "tool-events.jsonl",
    JSON.stringify({ event: "tool.summary", ...toolSummary }),
  );

  let verdict: "pass" | "fail" | "error" | "skipped" = error
    ? "error"
    : !verifierResult
      ? "skipped"
      : verifierResult.verdict === "pass"
        ? "pass"
        : "fail";

  const policyGates: import("./types").PolicyGateResult[] = [];
  if (objectiveSignals) {
    const isReadOnly = manifest.scoring?.maxChangedFiles === 0;
    const gitDiffClean = objectiveSignals.cleanGitDiff;
    const changedFiles = objectiveSignals.changedFiles;

    if (isReadOnly && manifest.scoring?.requireCleanGitDiff) {
      const passed = gitDiffClean;
      policyGates.push({
        gate: "requireCleanGitDiff",
        passed,
        detail: passed ? "clean" : `git diff is not clean (${changedFiles} file(s) changed)`,
      });
      if (!passed) verdict = "fail";
    }

    if (manifest.scoring?.maxChangedFiles !== undefined) {
      const passed = changedFiles <= manifest.scoring.maxChangedFiles;
      policyGates.push({
        gate: "maxChangedFiles",
        passed,
        detail: passed ? `${changedFiles} <= ${manifest.scoring.maxChangedFiles}` : `${changedFiles} > ${manifest.scoring.maxChangedFiles}`,
      });
      if (!passed) verdict = "fail";
    }

    const protectedPassed = protectedViolations.length === 0;
    if (protectedViolations.length > 0 || (manifest.protectedFiles && manifest.protectedFiles.length > 0)) {
      policyGates.push({
        gate: "protectedFiles",
        passed: protectedPassed,
        detail: protectedPassed ? "none modified" : `modified: ${protectedViolations.join(", ")}`,
      });
      if (!protectedPassed) verdict = "fail";
    }

    const obWrites = objectiveSignals.outOfBoundsWrites;
    if (obWrites.length > 0) {
      policyGates.push({
        gate: "outOfBoundsWrites",
        passed: false,
        detail: `found outside workspace: ${obWrites.join(", ")}`,
      });
      verdict = "fail";
    }
  }
  emitObs("eval.case.policy_gates.done", "info", { caseId, gates: policyGates.map(g => ({ gate: g.gate, passed: g.passed })) });

  // Supervisor review after all data is collected
  if (options.executeSupervisor) {
    emitObs("eval.case.supervisor.start", "info", { caseId });
    const supervisorPrompt = buildSupervisorPrompt(
      manifest,
      workerOutput,
      patchDiff,
      policyGates,
      verifierResult,
      toolStats,
      changedFiles,
    );
    supervisorOutput = await options.executeSupervisor(supervisorPrompt);
    emitObs("eval.case.supervisor.done", "info", { caseId });
    await writeCaseArtifact(caseDir, "supervisor-output.md", supervisorOutput);
    supervisorAssessment = extractAssessment(supervisorOutput);

    // Write ReviewPacket from supervisor assessment with deterministic gate constraint
    const { createReviewPacket } = await import("../harness-evolution/packets/review-packet");
    const { constrainVerdictWithGates } = await import("../harness-evolution/loop/deterministic-gates");
    const assessmentKeys = supervisorAssessment ? Object.keys(supervisorAssessment) : [];
    let reviewVerdict: "ACCEPTED" | "NEEDS_FIX" | "UNKNOWN" =
      assessmentKeys.length > 0 && assessmentKeys.every(k => (supervisorAssessment![k] ?? 0) >= 0.5)
        ? "ACCEPTED" : assessmentKeys.length > 0 ? "NEEDS_FIX" : "UNKNOWN";

    // Build deterministic gate results from verifier + policy gates
    const deterministicGateResults: Array<{ gateId: string; passed: boolean; failureClass?: string }> = [
      ...(verifierResult ? [{
        gateId: "verifier" as const,
        passed: verifierResult.verdict === "pass",
        failureClass: verifierResult.verdict !== "pass" ? "verifier_failure" as const : undefined,
      }] : []),
      ...policyGates.map(g => ({
        gateId: g.gate,
        passed: g.passed,
        failureClass: g.passed ? undefined : "policy_gate_failure" as const,
      })),
    ];
    reviewVerdict = constrainVerdictWithGates(reviewVerdict, deterministicGateResults as any);
    await writeCaseArtifact(caseDir, "deterministic-gates.json", JSON.stringify(deterministicGateResults, null, 2));

    const reviewPacket = createReviewPacket({
      packetId: `${runId || "eval"}:review:${caseId}`,
      runId: runId || "eval",
      mode: "eval",
      role: "supervisor",
      evalRunId: runId || "eval",
      caseId,
      verdict: reviewVerdict,
      findings: supervisorAssessment ? Object.entries(supervisorAssessment).map(([dim, score], i) => ({
        id: `F${i + 1}`,
        severity: score < 0.5 ? "major" as const : "minor" as const,
        category: "correctness" as const,
        summary: `${dim}: ${score}`,
        evidence: [],
        recommendedChecks: [],
      })) : [],
      requiredChecks: [],
      evidenceRefs: [],
      confidence: supervisorAssessment ? Math.min(1, Math.max(0, assessmentKeys.reduce((s, k) => s + (supervisorAssessment![k] ?? 0), 0) / assessmentKeys.length)) : 0.5,
    });
    await writeCaseArtifact(caseDir, "review-packet.json", JSON.stringify(reviewPacket, null, 2));
  }

  const score = computeScore(verifierResult, objectiveSignals, supervisorAssessment, policyGates);
  await writeCaseArtifact(
    caseDir,
    "score.json",
    JSON.stringify(score, null, 2),
  );
  emitObs("eval.case.submit.done", "info", { caseId, score: score?.finalScore });

  const caseContract: import("./types").CaseContract | null = error ? null : {
    environment: (options.environmentId ?? "sandbox.benchmark") as import("./types").EvalEnvironmentId,
    provider: getEvalSandboxProvider()?.id ?? "unknown",
    requiredBinaries: manifest.requiredBinaries ?? [],
    requiredPythonModules: manifest.requiredPythonModules ?? [],
    network: manifest.network ?? false,
    allowedWriteRoots: [workspaceDir],
    protectedFiles: manifest.protectedFiles ?? [],
    verifier: manifest.verifier.command ?? manifest.verifier.scriptPath ?? `file-assert:${(manifest.verifier.fileAssertions ?? []).map(f => f.path).join(",")}`,
    toolchainProfile: manifest.requires?.toolchainProfile ?? "node",
    scoring: {
      requireCleanGitDiff: manifest.scoring?.requireCleanGitDiff ?? false,
      maxChangedFiles: manifest.scoring?.maxChangedFiles,
    },
  };
  if (caseContract) {
    await writeCaseArtifact(caseDir, "case-contract.json", JSON.stringify(caseContract, null, 2));
  }

  // Write policy-gates.json
  await writeCaseArtifact(caseDir, "policy-gates.json", JSON.stringify(policyGates, null, 2));

  // Write supervisor-submit.json
  if (options.executeSupervisor) {
    await writeCaseArtifact(caseDir, "supervisor-submit.json", JSON.stringify({
      caseId,
      startedAt: new Date().toISOString(),
      supervisorOutputLength: supervisorOutput.length,
      assessment: supervisorAssessment,
    }, null, 2));
  }

  const gateFailures = policyGates.filter(g => !g.passed);
  const errorMsg = gateFailures.length > 0
    ? `Policy gates failed: ${gateFailures.map(g => g.gate).join(", ")}`
    : error;

  // Classify failure
  let failureClass: FailureClass = "none";
  let failureReason: string | undefined;
  let failureEvidence: import("./types").FailureEvidence | undefined;
  let classifiedVerdict: import("./verifier-classifier").ClassifiedVerifierResult | null = null;

  if (verdict === "pass") {
    failureClass = "none";
  } else if (error) {
    failureClass = "system_error";
    failureReason = error;
  } else if (!workerOutput.trim() && !error) {
    // Worker empty output takes priority over verifier/policy failures
    failureClass = "worker_empty_output";
    failureReason = "Worker submit completed with empty assistant_final";
    failureEvidence = {
      event: "worker_empty_output",
      stdoutSnippet: workerOutput.slice(0, 200),
    };
  } else if (gateFailures.length > 0 && !(verifierResult?.verdict === "pass")) {
    failureClass = "policy_gate_failure";
    failureReason = errorMsg;
    failureEvidence = {
      event: "policy_gate",
      missing: gateFailures.map(g => g.gate),
    };
  } else if (verifierResult) {
    classifiedVerdict = classifyVerifierResult(verifierResult, manifest);
    const cv = classifiedVerdict;
    failureClass = cv.verdict === "task_fail" ? "worker_failure"
      : cv.verdict === "verifier_contract_failure" ? "verifier_contract_failure"
      : cv.verdict === "setup_failure" ? "setup_failure"
      : cv.verdict === "sandbox_failure" ? "sandbox_failure"
      : "worker_failure";
    failureReason = cv.reason;
    failureEvidence = {
      event: "verifier",
      command: cv.evidence.command,
      exitCode: cv.evidence.exitCode,
      stdoutSnippet: cv.evidence.stdoutSnippet,
      stderrSnippet: cv.evidence.stderrSnippet,
    };
  } else {
    failureClass = "worker_failure";
    failureReason = "Task failed";
  }
  const scoreEligible = failureClass === "none" || failureClass === "worker_failure" || failureClass === "worker_empty_output" || failureClass === "policy_gate_failure";
  const officialScoreEligible = scoreEligible;

  // Write IncidentPacket from failure classification
  const { createIncidentPacket, classifyFailureClass } = await import("../harness-evolution/packets/incident-packet");
  const incidentClass = failureClass !== "none" ? classifyFailureClass(failureClass) : null;
  const incidentPacket = createIncidentPacket({
    packetId: `${runId || "eval"}:incident:${caseId}`,
    runId: runId || "eval",
    mode: "eval",
    role: "system",
    evalRunId: runId || "eval",
    caseId,
    incidents: incidentClass ? [{
      id: `I1:${failureClass}`,
      kind: incidentClass.kind,
      severity: incidentClass.severity,
      failureClass,
      harnessLayer: incidentClass.harnessLayer,
      summary: failureReason ?? "No failure reason",
      evidence: failureEvidence ? [{ file: "failure-evidence.json", excerpt: JSON.stringify(failureEvidence) }] : [],
      recommendedChecks: [],
    }] : [],
  });
  await writeCaseArtifact(caseDir, "incident-packet.json", JSON.stringify(incidentPacket, null, 2));

  // Write RecoveryPacket from incidents (only when repair is needed)
  if (incidentPacket.incidents.length > 0) {
    const { createRecoveryPacket } = await import("../harness-evolution/packets/recovery-packet");
    const recoveryPacket = createRecoveryPacket({
      packetId: `${runId || "eval"}:recovery:${caseId}`,
      runId: runId || "eval",
      mode: "eval",
      role: "system",
      evalRunId: runId || "eval",
      caseId,
      incidents: incidentPacket.incidents,
    });
    await writeCaseArtifact(caseDir, "recovery-packet.json", JSON.stringify(recoveryPacket, null, 2));
  }

  // Sync packets to PacketStore (JSONL for harness mine --from-eval)
  if (runId) {
    try {
      const { PacketStore } = await import("../harness-evolution/packets/packet-store");
      const packetStore = new PacketStore({ baseDir: process.cwd(), runId: `eval-${runId}`, evalRunId: runId, caseId });
      await packetStore.init();
      const packetFiles = [
        "task-digest.json", "runtime-guard.json", "action-certificate.json",
        "review-packet.json", "incident-packet.json", "recovery-packet.json",
      ];
      const PACKET_SCHEMAS = new Set([
        "looprig.task-digest.v1", "looprig.runtime-guard.v1", "looprig.action-certificate.v1",
        "looprig.review-packet.v1", "looprig.incident-packet.v1", "looprig.recovery-packet.v1",
        "looprig.harness-patch.v1",
      ]);
      for (const fileName of packetFiles) {
        const { join } = await import("node:path");
        const filePath = join(caseDir, fileName);
        const { existsSync } = await import("node:fs");
        if (existsSync(filePath)) {
          const { readFileSync } = await import("node:fs");
          const content = readFileSync(filePath, "utf-8");
          const packet = JSON.parse(content);
          // Only write valid HarnessPackets (skip arrays or non-packet JSON like deterministic-gates.json)
          if (packet && typeof packet === "object" && !Array.isArray(packet) && PACKET_SCHEMAS.has(packet.schemaVersion)) {
            await packetStore.append(packet);
            await packetStore.mirrorToEvalCase(runId, caseId, packet);
          }
        }
      }
    } catch {
      // PacketStore sync is optional; fail silently
    }
  }

  return {
    caseId: manifest.id,
    title: manifest.title,
    category: manifest.category,
    suite: manifest.suite,
    manifest,
    verdict,
    verifierResult,
    objectiveSignals,
    setupResult: setupResult ?? null,
    policyGates,
    supervisorAssessment,
    score,
    workerOutput,
    supervisorOutput,
    patchDiff,
    caseContract,
    startedAt,
    finishedAt,
    error: errorMsg,
    failureClass,
    failureReason,
    failureEvidence,
    scoreEligible,
    officialScoreEligible,
  };
}

/** Resolve task prompt from manifest, respecting locale. */
function resolveTaskPrompt(manifest: EvalCaseManifest, locale?: PromptLocale): string {
  const resolvedLocale = locale ?? getPromptLocale();
  if (resolvedLocale === "en" && manifest.taskPromptByLocale?.en) {
    return manifest.taskPromptByLocale.en;
  }
  if (resolvedLocale === "zh-CN" && manifest.taskPromptByLocale?.["zh-CN"]) {
    return manifest.taskPromptByLocale["zh-CN"];
  }
  return manifest.taskPrompt;
}

function buildWorkerPrompt(
  manifest: EvalCaseManifest,
  workspaceDir: string,
  locale?: PromptLocale,
): string {
  const isZh = (locale ?? getPromptLocale()) === "zh-CN"
  const taskPrompt = resolveTaskPrompt(manifest, locale);
  if (isZh) {
    return `你正在 ${workspaceDir} 的隔离工作区中执行评估任务。

所有文件操作和 shell 命令必须在此工作区内进行。不要访问此目录之外的文件。

## 任务
${taskPrompt}

## 要求
${manifest.expectedVerification.map((v) => `- ${v}`).join("\n")}

使用可用工具完成任务。完成后请验证你的工作。`
  }
  return `You are working on an evaluation task in an isolated workspace at ${workspaceDir}.

All file operations and shell commands must operate within this workspace. Do not access files outside this directory.

## Task
${taskPrompt}

## Requirements
${manifest.expectedVerification.map((v) => `- ${v}`).join("\n")}

Complete the task using the tools available to you. Make sure to verify your work.`;
}

function buildSupervisorPrompt(
  manifest: EvalCaseManifest,
  workerOutput: string,
  patchDiff?: string,
  policyGates?: PolicyGateResult[],
  verifierResult?: VerifierResult | null,
  toolStats?: { calls: number; failures: number },
  changedFiles?: string[],
  locale?: PromptLocale,
): string {
  const isZh = (locale ?? getPromptLocale()) === "zh-CN"
  const taskPrompt = resolveTaskPrompt(manifest, locale);
  const patchSection = patchDiff
    ? `\n## ${isZh ? "代码变更" : "Code Changes (Patch Diff)"}\n\`\`\`diff\n${patchDiff.length > 2000 ? patchDiff.slice(0, 2000) + "\n[... truncated]" : patchDiff}\n\`\`\``
    : `\n## ${isZh ? "代码变更" : "Code Changes"}\n${isZh ? "未做任何更改。" : "No changes were made."}`;
  const verifierSection = verifierResult
    ? `\n## ${isZh ? "验证结果" : "Verification Result"}\n${isZh ? "裁定" : "Verdict"}: ${verifierResult.verdict}\n${verifierResult.stdout ? `${isZh ? "标准输出" : "Stdout"}: ${verifierResult.stdout.slice(0, 500)}` : ""}`
    : `\n## ${isZh ? "验证结果" : "Verification Result"}\n${isZh ? "未执行。" : "Not executed."}`;
  const policySection = policyGates && policyGates.length > 0
    ? `\n## ${isZh ? "策略门禁" : "Policy Gates"}\n${policyGates.map(g => `- ${g.gate}: ${g.passed ? "PASS" : "FAIL"} (${g.detail})`).join("\n")}`
    : "";
  const toolSection = toolStats
    ? `\n## ${isZh ? "工具使用" : "Tool Usage"}\n${isZh ? "总调用" : "Total calls"}: ${toolStats.calls}, ${isZh ? "失败" : "failures"}: ${toolStats.failures}`
    : "";
  const filesSection = changedFiles && changedFiles.length > 0
    ? `\n## ${isZh ? "修改的文件" : "Changed Files"}\n${changedFiles.map(f => `- ${f}`).join("\n")}`
    : "";

  const header = isZh
    ? `你正在评估另一个 Agent 在此任务上的工作：`
    : `You are evaluating the work of another agent on this task:`;

  return `${header}

## Task
${taskPrompt}

## Expected Verification
${manifest.expectedVerification.map((v) => `- ${v}`).join("\n")}

## ${isZh ? "Worker 输出" : "Worker Output"}
${workerOutput}
${patchSection}${verifierSection}${policySection}${toolSection}${filesSection}

${isZh
  ? `请提供结构化评估，对以下维度的打分（0-100）：taskCompletion、verification、toolUse、efficiency、safety。
将评估结果以 JSON 对象形式返回，包含包含各维度得分的 "dimensions" 字段。`
  : `Please provide a structured assessment with scores (0-100) for dimensions: taskCompletion, verification, toolUse, efficiency, safety.

Return your assessment as JSON object with a "dimensions" field containing scores for each dimension.`}`;
}

function extractAssessment(
  supervisorOutput: string,
): Record<string, number> | null {
  try {
    const jsonMatch = supervisorOutput.match(/\{[\s\S]*"dimensions"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.dimensions) {
        return parsed.dimensions as Record<string, number>;
      }
    }
  } catch {
  }
  return null;
}

export async function runFixedEval(
  options: FixedEvalOptions,
): Promise<EvalRunReport> {
  if (options.abortSignal?.aborted) {
    throw new Error("Eval aborted before start");
  }

  const { provider, environmentId: resolvedEnvId, providerId, officialScore, fallbackReason } = await resolveSandboxProvider(options);

  setVerifierSandboxProvider(provider);
  setEvalSandboxProvider(provider);

  const runId = randomUUID().slice(0, 8);
  const evalDir = join(getEvalsDir(), runId);
  await mkdir(evalDir, { recursive: true });

  const { categoryId, suiteId, environmentId: optEnv, onProgress } = options;
  const environmentId = optEnv ?? "sandbox.benchmark";

  _currentEvalRunId = runId;
  _currentEvalContext = { evalRunId: runId, environmentId, providerId };

  // Wire eval context into runtime logger for cross-layer correlation
  const evalLogger = options.logger?.child({
    mode: "eval",
    evalRunId: runId,
    environmentId,
    providerId,
  });
  _currentEvalLogger = evalLogger ?? null;

  let obsQueue: Promise<void> = Promise.resolve();
  let traceQueue: Promise<void> = Promise.resolve();

  try {
  const traceFile = join(evalDir, "trace.jsonl");
  const observabilityFile = join(evalDir, "observability.jsonl");

  const suite = getSuite(categoryId, suiteId, environmentId);
  if (!suite) {
    throw new Error(`Suite not found: category=${categoryId} suite=${suiteId} environment=${environmentId}`);
  }
  const caseRefs = suite.cases;

  // Write sandbox fingerprint
  const profile = provider.getProfile ? provider.getProfile() : null;
  let bwrapVersion: string | null = null;
  let bwrapPath: string | null = null;
  if (provider.id === "bwrap") {
    try {
      const out = execSync("bwrap --version 2>/dev/null", { encoding: "utf-8", stdio: "pipe" }).toString().trim();
      bwrapVersion = out || null;
      bwrapPath = execSync("command -v bwrap 2>/dev/null", { encoding: "utf-8", stdio: "pipe" }).toString().trim() || null;
    } catch {}
  }
  const tools: Array<{ name: string; path: string; version: string; source: string }> = [];
  if (profile?.toolchainFingerprint?.tools) {
    for (const t of profile.toolchainFingerprint.tools) {
      tools.push({ name: t.name, path: t.path ?? "", version: t.version ?? "", source: t.source });
    }
  } else {
    // Detect host tools
    for (const name of ["node", "bun", "python3", "git"]) {
      try {
        const p = execSync(`command -v ${name} 2>/dev/null`, { encoding: "utf-8", stdio: "pipe" }).toString().trim();
        if (p) {
          const v = execSync(`${name} --version 2>/dev/null`, { encoding: "utf-8", stdio: "pipe" }).toString().trim().split("\n")[0] ?? "";
          tools.push({ name, path: p, version: v, source: "host" });
        }
      } catch {}
    }
  }
  const fingerprint = {
    providerId,
    environmentId,
    officialScore,
    providerVersion: process.version,
    bwrapPath,
    bwrapVersion,
    toolchainProfile: profile?.toolchainProfile ?? "node",
    pathInsideSandbox: profile?.path?.join(":") ?? process.env.PATH?.slice(0, 200) ?? "",
    network: {
      setup: profile?.networkPolicy?.setup ?? true,
      agent: profile?.networkPolicy?.agent ?? false,
      verifier: profile?.networkPolicy?.verifier ?? false,
    },
    filesystem: {
      workspaceDir: evalDir,
      readRoots: [evalDir],
      writeRoots: [evalDir],
      tmpfs: ["/tmp"],
      roBinds: ["/usr", "/bin", "/lib", "/lib64"],
      rwBinds: [evalDir],
    },
    tools,
    timestamp: new Date().toISOString(),
  };
  await writeFile(join(evalDir, "sandbox-fingerprint.json"), JSON.stringify(fingerprint, null, 2), "utf-8");

  function writeObservability(event: string, level: string, overrides: Record<string, unknown> = {}): void {
    const entry = JSON.stringify({
      schemaVersion: 1,
      ts: new Date().toISOString(),
      level,
      event,
      runId,
      environmentId,
      providerId,
      mode: "eval",
      ...overrides,
    }) + "\n";
    obsQueue = obsQueue.then(() => appendFile(observabilityFile, entry, "utf-8").catch(() => {}));
  }

  function recordTrace(event: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ t: Date.now(), event, ...data }) + "\n";
    traceQueue = traceQueue.then(() => appendFile(traceFile, line, "utf-8").catch(() => {}));
  }

  recordTrace("eval-start", { categoryId, suiteId, environmentId, providerId, runId });
  writeObservability("eval.run.start", "info", { categoryId, suiteId });

  await writeFile(
    join(evalDir, "registry.json"),
    JSON.stringify(getCategories(), null, 2),
    "utf-8",
  );

  // === PREFLIGHT ===
  writeObservability("eval.preflight.start", "info", {});
  const preflight = await runPreflight(provider, environmentId);
  if (preflight) {
    await writeFile(join(evalDir, "preflight.json"), JSON.stringify(preflight, null, 2), "utf-8");
    recordTrace("preflight", { allFound: preflight.allFound, checks: preflight.checks.map(c => `${c.name}:${c.found}`) });
    writeObservability("eval.preflight.done", "info", { allFound: preflight.allFound });
    onProgress?.({
      type: "preflight",
      preflight,
      totalCases: caseRefs.length,
      completedCases: 0,
    });
  }

  const results: CaseResult[] = [];
  let passed = 0;
  let failed = 0;
  let errored = 0;
  let infraErrorCount = 0;
  let skipped = 0;

  const startedAt = new Date().toISOString();

  for (const caseRef of caseRefs) {
    if (options.abortSignal?.aborted) {
      recordTrace("eval-abort", { reason: "signal" });
      writeObservability("eval.run.cancelled", "warn", { reason: "user_cancel" });
      await writeFile(join(evalDir, "shutdown-reason.json"), JSON.stringify({
        reason: "user_cancel",
        mode: "eval",
        runId,
        caseId: null,
        timestamp: new Date().toISOString(),
      }, null, 2), "utf-8");
      throw new Error("Eval aborted");
    }

    if (_currentEvalContext) _currentEvalContext.caseId = caseRef.id;
    const manifest = getManifest(caseRef.manifestId);
    if (!manifest) {
      errored++;
      recordTrace("manifest-missing", { caseId: caseRef.id, manifestId: caseRef.manifestId });
      writeObservability("eval.case.setup.error", "error", { caseId: caseRef.id, reason: "manifest-not-found", manifestId: caseRef.manifestId });
      const missingResult: CaseResult = {
        caseId: caseRef.id,
        title: caseRef.title,
        category: categoryId,
        suite: suiteId,
        manifest: null as unknown as import("./types").EvalCaseManifest,
        verdict: "infra_error",
        verifierResult: null,
        objectiveSignals: null,
        setupResult: null,
        policyGates: [],
        supervisorAssessment: null,
        score: null,
        workerOutput: "",
        supervisorOutput: "",
        patchDiff: "",
        caseContract: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: `Manifest not found: ${caseRef.manifestId}`,
        failureClass: "registry_failure" as FailureClass,
        failureReason: `Manifest not found: ${caseRef.manifestId}`,
        failureEvidence: undefined,
        scoreEligible: false,
        officialScoreEligible: false,
      };
      results.push(missingResult);
      onProgress?.({
        type: "case-start",
        caseId: caseRef.id,
        title: caseRef.title,
        totalCases: caseRefs.length,
        completedCases: results.length - 1,
      });
      onProgress?.({
        type: "case-end",
        caseId: caseRef.id,
        title: caseRef.title,
        error: `Manifest not found: ${caseRef.manifestId}`,
        totalCases: caseRefs.length,
        completedCases: results.length,
      });
      continue;
    }

    // If preflight failed, skip to infra_error
    if (preflight && !preflight.allFound) {
      infraErrorCount++;
      recordTrace("case-infra-error", { caseId: manifest.id, reason: "preflight-failed" });
      const infraResult: CaseResult = {
        caseId: manifest.id,
        title: manifest.title,
        category: manifest.category,
        suite: manifest.suite,
        manifest,
        verdict: "infra_error",
        verifierResult: null,
        objectiveSignals: null,
        setupResult: null,
        policyGates: [],
        supervisorAssessment: null,
        score: null,
        workerOutput: "",
        supervisorOutput: "",
        patchDiff: "",
        caseContract: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: "Infrastructure error: preflight checks failed — missing tools in sandbox environment",
        failureClass: "preflight_failure" as FailureClass,
        failureReason: "Preflight checks failed — missing tools in sandbox environment",
        failureEvidence: undefined,
        scoreEligible: false,
        officialScoreEligible: false,
      };
      results.push(infraResult);
      onProgress?.({
        type: "infra-error",
        caseId: caseRef.id,
        title: manifest.title,
        result: infraResult,
        totalCases: caseRefs.length,
        completedCases: results.length,
        error: "Infrastructure error: preflight checks failed",
      });
      continue;
    }

    recordTrace("case-start", { caseId: manifest.id, title: manifest.title });
    if (_currentEvalContext) _currentEvalContext.caseId = manifest.id;
    writeObservability("eval.case.start", "info", { caseId: manifest.id, title: manifest.title, role: "system" });

    onProgress?.({
      type: "case-start",
      caseId: caseRef.id,
      title: manifest.title,
      totalCases: caseRefs.length,
      completedCases: results.length,
    });

    try {
      writeObservability("eval.case.workspace.start", "info", { caseId: manifest.id });
      writeObservability("eval.case.setup.start", "info", { caseId: manifest.id });
      const workspace = await createCaseWorkspace(runId, manifest, provider);
      writeObservability("eval.case.setup.done", "info", { caseId: manifest.id });
      writeObservability("eval.case.workspace.done", "info", { caseId: manifest.id });

      // Write case.json metadata with optional artifact annotations
      const notes: string[] = [];
      if (!workspace.setupResult) notes.push("setup.json: no setup commands defined");
      await writeFile(
        join(workspace.caseDir, "case.json"),
        JSON.stringify({
          caseId: manifest.id,
          title: manifest.title,
          category: manifest.category,
          suite: manifest.suite,
          environmentId,
          providerId: provider.id,
          runId,
          startedAt: new Date().toISOString(),
          manifestId: caseRef.manifestId,
          notes: notes.length > 0 ? notes : undefined,
        }, null, 2),
        "utf-8",
      );

      await writeFile(
        join(workspace.caseDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf-8",
      );

      // Write workspace.json
      await writeFile(
        join(workspace.caseDir, "workspace.json"),
        JSON.stringify({
          caseId: manifest.id,
          providerId: provider.id,
          environmentId,
          workspaceDir: workspace.caseDir,
          caseDir: getCaseWorkspaceDir(workspace.caseDir),
          sandboxed: provider.id === "bwrap",
          setupResult: workspace.setupResult
            ? {
                passed: workspace.setupResult.allPassed,
                commandCount: workspace.setupResult.commands.length,
                failedCommands: workspace.setupResult.commands.filter(c => c.exitCode !== 0).map(c => c.command),
              }
            : null,
        }, null, 2),
        "utf-8",
      );

      // Write setup.json (always, even if no setup commands)
      await writeFile(
        join(workspace.caseDir, "setup.json"),
        JSON.stringify(workspace.setupResult
          ? {
              caseId: manifest.id,
              startedAt: workspace.setupResult.startedAt,
              finishedAt: workspace.setupResult.finishedAt,
              allPassed: workspace.setupResult.allPassed,
              commands: workspace.setupResult.commands.map(c => ({
                command: c.command,
                exitCode: c.exitCode,
                timedOut: c.timedOut,
                stdoutSnippet: c.stdout.slice(0, 500),
                stderrSnippet: c.stderr.slice(0, 500),
              })),
            }
          : { caseId: manifest.id, note: "No setup commands defined for this case" },
        null, 2),
        "utf-8",
      );

      const result = await runSingleCase(
        manifest,
        getCaseWorkspaceDir(workspace.caseDir),
        workspace.caseDir,
        { ...options, writeObservability },
        workspace.setupResult,
        runId,
      );
      writeObservability("eval.case.score.done", "info", {
        caseId: manifest.id,
        verdict: result.verdict,
        failureClass: result.failureClass,
        score: result.score?.finalScore,
        scoreEligible: result.scoreEligible,
      });
      results.push(result);

      if (result.verdict === "pass") passed++;
      else if (result.verdict === "fail") failed++;
      else if (result.verdict === "error") errored++;
      else if (result.verdict === "infra_error") infraErrorCount++;
      else skipped++;

      recordTrace("case-end", {
        caseId: manifest.id,
        verdict: result.verdict,
        score: result.score?.finalScore,
      });

      onProgress?.({
        type: "case-end",
        caseId: caseRef.id,
        title: manifest.title,
        result,
        totalCases: caseRefs.length,
        completedCases: results.length,
      });
    } catch (err) {
      if (err instanceof SetupFailedError) {
        infraErrorCount++;
        recordTrace("case-infra-error", { caseId: manifest.id, reason: "setup-failed" });
        writeObservability("eval.case.setup.error", "error", { caseId: manifest.id, reason: "setup-failed" });
        const infraResult: CaseResult = {
          caseId: manifest.id,
          title: manifest.title,
          category: manifest.category,
          suite: manifest.suite,
          manifest,
          verdict: "infra_error",
          verifierResult: null,
          objectiveSignals: null,
          setupResult: err.setupResult,
          policyGates: [],
          supervisorAssessment: null,
          score: null,
          workerOutput: "",
          supervisorOutput: "",
          patchDiff: "",
          caseContract: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: "Infrastructure error: setup failed",
          failureClass: "setup_failure" as FailureClass,
          failureReason: "Setup failed",
          failureEvidence: err.setupResult
            ? {
                event: "setup",
                command: err.setupResult.commands.map((c: { command: string }) => c.command).join("; "),
                exitCode: err.setupResult.commands[err.setupResult.commands.length - 1]?.exitCode,
              }
            : undefined,
          scoreEligible: false,
          officialScoreEligible: false,
        };
        results.push(infraResult);
        onProgress?.({
          type: "infra-error",
          caseId: caseRef.id,
          title: manifest.title,
          result: infraResult,
          totalCases: caseRefs.length,
          completedCases: results.length,
          error: "Infrastructure error: setup failed",
        });
      } else if (
        err instanceof MissingEvalAssetError ||
        err instanceof CorruptEvalAssetError ||
        err instanceof UnsafeEvalAssetPathError ||
        err instanceof EvalAssetExtractionError
      ) {
        infraErrorCount++;
        const assetErrMsg = err instanceof Error ? err.message : String(err);
        recordTrace("case-asset-error", {
          caseId: manifest.id,
          error: assetErrMsg,
        });
        writeObservability("eval.case.asset.error", "error", { caseId: manifest.id, reason: "asset-error", error: assetErrMsg });
        const assetResult: CaseResult = {
          caseId: manifest.id,
          title: manifest.title,
          category: manifest.category,
          suite: manifest.suite,
          manifest,
          verdict: "infra_error",
          verifierResult: null,
          objectiveSignals: null,
          setupResult: null,
          policyGates: [],
          supervisorAssessment: null,
          score: null,
          workerOutput: "",
          supervisorOutput: "",
          patchDiff: "",
          caseContract: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: `Asset error: ${assetErrMsg}`,
          failureClass: "setup_failure" as FailureClass,
          failureReason: assetErrMsg,
          failureEvidence: { event: "asset_missing" },
          scoreEligible: false,
          officialScoreEligible: false,
        };
        results.push(assetResult);
        onProgress?.({
          type: "infra-error",
          caseId: caseRef.id,
          title: manifest.title,
          result: assetResult,
          totalCases: caseRefs.length,
          completedCases: results.length,
          error: `Asset error: ${assetErrMsg}`,
        });
      } else {
        errored++;
        const errMsg = err instanceof Error ? err.message : String(err);
        recordTrace("case-error", {
          caseId: manifest.id,
          error: errMsg,
        });
        const errorResult: CaseResult = {
          caseId: manifest.id,
          title: manifest.title,
          category: manifest.category,
          suite: manifest.suite,
          manifest,
          verdict: "error",
          verifierResult: null,
          objectiveSignals: null,
          setupResult: null,
          policyGates: [],
          supervisorAssessment: null,
          score: null,
          workerOutput: "",
          supervisorOutput: "",
          patchDiff: "",
          caseContract: null,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: errMsg,
          failureClass: "system_error" as FailureClass,
          failureReason: errMsg,
          failureEvidence: undefined,
          scoreEligible: false,
          officialScoreEligible: false,
        };
        results.push(errorResult);
        onProgress?.({
          type: "case-end",
          caseId: caseRef.id,
          title: manifest.title,
          error: errMsg,
          totalCases: caseRefs.length,
          completedCases: results.length + 1,
        });
      }
    }
    if (_currentEvalContext) _currentEvalContext.caseId = undefined;
  }

  const finishedAt = new Date().toISOString();
  const scoreEligibleCount = results.filter(r => r.scoreEligible).length;
  const averageScore =
    scoreEligibleCount > 0
      ? results.reduce((sum, r) => sum + (r.score?.finalScore ?? 0), 0) /
        scoreEligibleCount
      : 0;

  const failureBreakdown: Record<string, number> = {};
  for (const r of results) {
    const fc = r.failureClass;
    failureBreakdown[fc] = (failureBreakdown[fc] ?? 0) + 1;
  }

  // Write cache summary
  const totalToolFailures = results.reduce((s, r) => s + (r.objectiveSignals?.toolFailureCount ?? 0), 0);
  const byCase: Record<string, unknown> = {};
  for (const r of results) {
    if (r.objectiveSignals) {
      byCase[r.caseId] = {
        verdict: r.verdict,
        toolFailures: r.objectiveSignals.toolFailureCount,
        verificationCommandsRun: r.objectiveSignals.verificationCommandsRun,
        changedFiles: r.objectiveSignals.changedFiles,
      };
    }
  }
  const cacheSummary = {
    runId,
    environmentId,
    providerId,
    totalCases: results.length,
    totalToolFailures,
    totalVerificationCommandsRun: results.reduce((s, r) => s + (r.objectiveSignals?.verificationCommandsRun ?? 0), 0),
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCacheHitTokens: 0,
    totalCacheMissTokens: 0,
    cacheHitRatio: 0,
    byCase,
    // Token-level cache aggregation requires model request instrumentation in the engine/runtime layer
    _note: "Token-level cache tracking requires model request instrumentation in engine",
  };
  await writeFile(join(evalDir, "cache-summary.json"), JSON.stringify(cacheSummary, null, 2), "utf-8");

  // Write failures.json
  const failures = results.filter(r => r.verdict !== "pass" && r.verdict !== "skipped").map(r => ({
    caseId: r.caseId,
    title: r.title,
    category: r.category,
    suite: r.suite,
    verdict: r.verdict,
    failureClass: r.failureClass,
    failureReason: r.failureReason,
    failureEvidence: r.failureEvidence,
    error: r.error,
    scoreEligible: r.scoreEligible,
    score: r.score?.finalScore,
  }));
  await writeFile(join(evalDir, "failures.json"), JSON.stringify(failures, null, 2), "utf-8");

  const suiteSummary: SuiteSummary = {
    suiteId,
    categoryId,
    totalCases: caseRefs.length,
    passed,
    failed,
    errored,
    infraErrorCount,
    skipped,
    averageScore: Math.round(averageScore * 100) / 100,
    results,
    failureBreakdown,
  };

  const hasPreflightFailure = results.some(r => r.error?.includes("preflight"));
  const hasSetupFailure = results.some(r => r.error?.includes("setup failed"));

  const status = infraErrorCount > 0
    ? "infra_error"
    : options.abortSignal?.aborted
      ? "cancelled"
      : "completed";

  writeObservability("eval.run.done", "info", { status, infraErrorCount, totalCases: results.length });

  const fallbackMsg = infraErrorCount > 0
    ? hasSetupFailure && hasPreflightFailure
      ? "Infrastructure error: preflight and setup failures"
      : hasSetupFailure
        ? "Infrastructure error: setup failed"
        : "Infrastructure error: preflight checks failed"
    : undefined;

  const meta: EvalRunMeta = {
    runId,
    startedAt,
    finishedAt,
    categoryId,
    suiteId,
    environmentId,
    testSetId: options.testSetId ?? suiteId,
    model: options.models?.[0] ?? "default",
    status,
    providerId,
    officialScore: infraErrorCount > 0 ? false : officialScore,
    scoreKind: environmentId === "sandbox.benchmark" && officialScore && infraErrorCount === 0 ? "official" : "local-compatible",
    fallbackReason: fallbackMsg ?? fallbackReason,
    preflight: preflight ?? undefined,
  };

  const overallScore = averageScore;

  onProgress?.({
    type: "suite-end",
    totalCases: caseRefs.length,
    completedCases: results.length,
  });

  // Write provider environment snapshot
  await writeFile(join(evalDir, "provider-env.json"), JSON.stringify({
    providerId,
    environmentId,
    officialScore: officialScore && infraErrorCount === 0,
    hostNode: process.execPath,
    hostCwd: process.cwd(),
    hostPlatform: process.platform,
    hostArch: process.arch,
    hostEnv: {
      PATH: process.env.PATH?.slice(0, 500),
      HOME: process.env.HOME,
      SHELL: process.env.SHELL,
      USER: process.env.USER,
      NODE_ENV: process.env.NODE_ENV,
    },
    timestamp: new Date().toISOString(),
  }, null, 2), "utf-8");

  // Write shutdown metadata
  await writeFile(join(evalDir, "shutdown-reason.json"), JSON.stringify({
    reason: status,
    mode: "eval",
    runId,
    status,
    infraErrorCount,
    timestamp: new Date().toISOString(),
  }, null, 2), "utf-8");

  return {
    meta,
    suiteSummary,
    overallScore: Math.round(overallScore * 100) / 100,
  };
  } finally {
    setVerifierSandboxProvider(null);
    setEvalSandboxProvider(null);
    _currentEvalRunId = null;
    _currentEvalContext = null;
    _currentEvalLogger = null;

    // Flush write queues before returning
    await obsQueue;
    await traceQueue;
  }
}
