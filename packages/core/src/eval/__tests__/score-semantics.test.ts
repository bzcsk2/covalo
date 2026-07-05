import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { runFixedEval } from "../runner";
import { clearManifests, registerBuiltinManifests } from "../loader";
import { WEAK_MODEL_MANIFESTS } from "../fixtures/index";
import type { SandboxProvider } from "../../sandbox/types";

const TEST_DIR = join(tmpdir(), `score-semantics-test-${randomUUID()}`);

function makeProvider(verdict: "pass" | "fail" | "error" | "timeout", stdout = "", stderr = ""): SandboxProvider {
  return {
    id: "test-provider",
    name: "TestProvider",
    capabilities: { sandbox: false, official: false },
    metadata: { version: "0.0.0" },
    async run() {
      if (verdict === "timeout") {
        return { exitCode: null, stdout, stderr, timedOut: true };
      }
      const exitCode = verdict === "pass" ? 0 : 1;
      return { exitCode, stdout, stderr, timedOut: false };
    },
    async runCommand() {
      return { exitCode: 0, stdout: "" };
    },
    async isAllowed() {
      return { allowed: true };
    },
  } as unknown as SandboxProvider;
}

describe("score-semantics", () => {
  beforeAll(() => {
    clearManifests();
    registerBuiltinManifests(WEAK_MODEL_MANIFESTS);
    process.env.COVALO_ROOT = TEST_DIR;
  });

  afterAll(() => {
    delete process.env.COVALO_ROOT;
    try { require("node:fs").rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  });

  test("verifier pass produces score and scoreEligible=true", async () => {
    const provider = makeProvider("pass");
    const report = await runFixedEval({
      categoryId: "weak-model",
      suiteId: "smoke",
      environmentId: "sandbox.local",
      sandboxProvider: provider,
      executeWorker: async () => "done",
      executeSupervisor: async () => JSON.stringify({ dimensions: { taskCompletion: 100 } }),
    });
    const result = report.suiteSummary.results[0];
    expect(result.verdict).toBe("pass");
    expect(result.scoreEligible).toBe(true);
    expect(result.score).not.toBeNull();
    expect(result.score!.finalScore).toBeGreaterThanOrEqual(0);
  });

  test("verifier error (timeout) produces infra_error and score not eligible", async () => {
    const provider = makeProvider("timeout", "", "timed out");
    const report = await runFixedEval({
      categoryId: "weak-model",
      suiteId: "smoke",
      environmentId: "sandbox.local",
      sandboxProvider: provider,
      executeWorker: async () => "done",
      executeSupervisor: async () => JSON.stringify({ dimensions: { taskCompletion: 50 } }),
    });
    const result = report.suiteSummary.results[0];
    expect(result.verdict).toBe("infra_error");
    expect(result.scoreEligible).toBe(false);
  });

  test("command not found produces setup_failure and score not eligible", async () => {
    const provider = makeProvider("fail", "", "command not found: pytest");
    const report = await runFixedEval({
      categoryId: "weak-model",
      suiteId: "smoke",
      environmentId: "sandbox.local",
      sandboxProvider: provider,
      executeWorker: async () => "done",
      executeSupervisor: async () => JSON.stringify({ dimensions: { taskCompletion: 50 } }),
    });
    const result = report.suiteSummary.results[0];
    expect(result.verdict).toBe("infra_error");
    expect(result.scoreEligible).toBe(false);
  });

  test("ModuleNotFoundError produces verifier_contract_failure and score not eligible", async () => {
    const provider = makeProvider("fail", "", "ModuleNotFoundError: numpy");
    const report = await runFixedEval({
      categoryId: "weak-model",
      suiteId: "smoke",
      environmentId: "sandbox.local",
      sandboxProvider: provider,
      executeWorker: async () => "done",
      executeSupervisor: async () => JSON.stringify({ dimensions: { taskCompletion: 50 } }),
    });
    const result = report.suiteSummary.results[0];
    expect(result.verdict).toBe("infra_error");
    expect(result.scoreEligible).toBe(false);
  });
});
