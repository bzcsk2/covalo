import type { EvalCaseManifest, VerifierResult } from "./types";

export interface ClassifiedVerifierResult {
  verdict: "task_fail" | "task_pass" | "verifier_contract_failure" | "setup_failure" | "sandbox_failure";
  reason: string;
  evidence: {
    command?: string;
    exitCode?: number | null;
    stdoutSnippet?: string;
    stderrSnippet?: string;
  };
  scoreEligible: boolean;
}

export function detectInfraFailureFromOutput(
  stdout: string,
  stderr: string,
): { isInfra: boolean; reason: string } | null {
  const combined = `${stdout}\n${stderr}`;

  if (combined.includes("No tests found")) {
    return { isInfra: true, reason: "No tests found in verifier output" };
  }
  if (combined.includes("command not found")) {
    return { isInfra: true, reason: "Required command not found" };
  }
  if (combined.includes("ModuleNotFoundError")) {
    return { isInfra: true, reason: "Required Python module not found" };
  }
  if (combined.includes("Script not found")) {
    return { isInfra: true, reason: "Verifier script not found" };
  }
  return null;
}

export function detectVerifierContractFailure(
  details: string[],
): { isContractFailure: boolean; reason: string } | null {
  const joined = details.join("\n");
  if (
    joined.includes("Unsafe file assertion path") ||
    joined.includes("unsafe file assertion path")
  ) {
    return { isContractFailure: true, reason: "Unsafe file assertion path in manifest" };
  }
  return null;
}

function extractEvidence(
  verifierResult: VerifierResult,
  manifest: EvalCaseManifest,
): ClassifiedVerifierResult["evidence"] {
  return {
    command: manifest.verifier.command ?? manifest.verifier.scriptPath,
    exitCode: verifierResult.exitCode,
    stdoutSnippet: verifierResult.stdout
      ? verifierResult.stdout.slice(0, 300)
      : undefined,
    stderrSnippet: verifierResult.stderr
      ? verifierResult.stderr.slice(0, 300)
      : undefined,
  };
}

export function classifyVerifierResult(
  verifierResult: VerifierResult,
  manifest: EvalCaseManifest,
): ClassifiedVerifierResult {
  const { stdout, stderr, exitCode, details } = verifierResult;
  const combined = `${stdout}\n${stderr}`;

  const contractFailure = detectVerifierContractFailure(details);
  if (contractFailure) {
    return {
      verdict: "verifier_contract_failure",
      reason: contractFailure.reason,
      evidence: extractEvidence(verifierResult, manifest),
      scoreEligible: false,
    };
  }

  const infra = detectInfraFailureFromOutput(stdout, stderr);
  if (infra) {
    const verdict =
      combined.includes("command not found")
        ? "setup_failure"
        : "verifier_contract_failure";
    return {
      verdict,
      reason: infra.reason,
      evidence: extractEvidence(verifierResult, manifest),
      scoreEligible: false,
    };
  }

  if (verifierResult.verdict === "error") {
    return {
      verdict: "verifier_contract_failure",
      reason: verifierResult.details.join("; ") || "Infra error during verifier execution",
      evidence: extractEvidence(verifierResult, manifest),
      scoreEligible: false,
    };
  }

  if (exitCode === null) {
    return {
      verdict: "sandbox_failure",
      reason: "Verifier command timed out or sandbox infrastructure failure",
      evidence: extractEvidence(verifierResult, manifest),
      scoreEligible: false,
    };
  }

  if (
    combined.includes("ImportError") &&
    (manifest.requiredPythonModules ?? []).length > 0
  ) {
    return {
      verdict: "verifier_contract_failure",
      reason: "Required Python module import failed",
      evidence: extractEvidence(verifierResult, manifest),
      scoreEligible: false,
    };
  }

  if (verifierResult.verdict === "fail") {
    return {
      verdict: "task_fail",
      reason: verifierResult.details.join("; ") || "Task verification failed",
      evidence: extractEvidence(verifierResult, manifest),
      scoreEligible: true,
    };
  }

  if (verifierResult.verdict === "pass") {
    return {
      verdict: "task_pass",
      reason: "Task verification passed",
      evidence: extractEvidence(verifierResult, manifest),
      scoreEligible: true,
    };
  }

  return {
    verdict: "verifier_contract_failure",
    reason: `Unhandled verifier result: verdict=${verifierResult.verdict}`,
    evidence: extractEvidence(verifierResult, manifest),
    scoreEligible: false,
  };
}
