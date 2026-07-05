import { describe, test, expect } from "bun:test";
import { classifyVerifierResult } from "../verifier-classifier";
import type { VerifierResult, EvalCaseManifest } from "../types";

function makeManifest(): EvalCaseManifest {
  return {
    id: "x",
    category: "coding-basics",
    suite: "smoke",
    title: "x",
    description: "x",
    fixtureSource: "x",
    taskPrompt: "x",
    expectedVerification: [],
    verifier: { type: "file-assert", fileAssertions: [] },
  };
}

describe("verifier-classifier", () => {
  test("unsafe file assertion path is classified as verifier_contract_failure", () => {
    const result: VerifierResult = {
      passed: false,
      verdict: "fail",
      stdout: "",
      stderr: "",
      exitCode: 1,
      details: ["ERROR: unsafe file assertion path ../secret.txt"],
    };
    const classified = classifyVerifierResult(result, makeManifest());
    expect(classified.verdict).toBe("verifier_contract_failure");
    expect(classified.scoreEligible).toBe(false);
  });

  test("command not found is setup_failure", () => {
    const result: VerifierResult = {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr: "command not found: pytest",
      exitCode: null,
      details: [],
    };
    const classified = classifyVerifierResult(result, makeManifest());
    expect(classified.verdict).toBe("setup_failure");
    expect(classified.scoreEligible).toBe(false);
  });

  test("ModuleNotFoundError is verifier_contract_failure", () => {
    const result: VerifierResult = {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr: "ModuleNotFoundError: numpy",
      exitCode: null,
      details: [],
    };
    const classified = classifyVerifierResult(result, { ...makeManifest(), requiredPythonModules: ["numpy"] });
    expect(classified.verdict).toBe("verifier_contract_failure");
    expect(classified.scoreEligible).toBe(false);
  });

  test("verifier error with details is verifier_contract_failure", () => {
    const result: VerifierResult = {
      passed: false,
      verdict: "error",
      stdout: "",
      stderr: "",
      exitCode: null,
      details: ["Command timed out"],
    };
    const classified = classifyVerifierResult(result, makeManifest());
    expect(classified.verdict).toBe("verifier_contract_failure");
    expect(classified.scoreEligible).toBe(false);
  });

  test("normal fail is task_fail", () => {
    const result: VerifierResult = {
      passed: false,
      verdict: "fail",
      stdout: "FAIL",
      stderr: "",
      exitCode: 1,
      details: ["test failed"],
    };
    const classified = classifyVerifierResult(result, makeManifest());
    expect(classified.verdict).toBe("task_fail");
    expect(classified.scoreEligible).toBe(true);
  });
});
