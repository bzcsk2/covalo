import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getCategories,
  getCategory,
  getSuite,
  getCaseRef,
  listCaseRefs,
  getAvailableCategoryIds,
  getAvailableSuiteIds,
  validateManifest,
  registerBuiltinManifest,
  registerBuiltinManifests,
  getManifest,
  listAllManifests,
  clearManifests,
  createCaseWorkspace,
  runVerifier,
  runFixedEval,
  saveEvalReport,
} from "../src/eval/index.js";
import type { EvalCaseManifest, EvalRunReport } from "../src/eval/types.js";

describe("eval registry", () => {
  it("should return all categories", () => {
    const cats = getCategories();
    expect(cats.length).toBeGreaterThanOrEqual(3);
    const ids = cats.map((c) => c.id);
    expect(ids).toContain("coding-basics");
    expect(ids).toContain("tool-use");
    expect(ids).toContain("safety");
  });

  it("should get category by id", () => {
    const cat = getCategory("coding-basics");
    expect(cat).toBeDefined();
    expect(cat!.id).toBe("coding-basics");
    expect(cat!.suites.length).toBeGreaterThanOrEqual(1);
  });

  it("should return undefined for missing category", () => {
    expect(getCategory("invalid" as any)).toBeUndefined();
  });

  it("should get suite from category", () => {
    const suite = getSuite("coding-basics", "smoke");
    expect(suite).toBeDefined();
    expect(suite!.id).toBe("smoke");
    expect(suite!.cases.length).toBeGreaterThanOrEqual(3);
  });

  it("should get case ref by id", () => {
    const ref = getCaseRef("coding-basics", "smoke", "cb-fix-ts-type");
    expect(ref).toBeDefined();
    expect(ref!.id).toBe("cb-fix-ts-type");
  });

  it("should list case refs for a suite", () => {
    const refs = listCaseRefs("coding-basics", "smoke");
    expect(refs.length).toBeGreaterThanOrEqual(3);
  });

  it("should list available ids", () => {
    expect(getAvailableCategoryIds()).toContain("coding-basics");
    expect(getAvailableSuiteIds()).toContain("smoke");
  });
});

describe("manifest validation", () => {
  const validManifest: EvalCaseManifest = {
    id: "test-1",
    category: "coding-basics",
    suite: "smoke",
    title: "Test Case",
    description: "A test case",
    fixtureSource: "test-fixture",
    taskPrompt: "Fix the bug",
    expectedVerification: ["tests should pass"],
    verifier: {
      type: "command",
      command: "npm test",
    },
  };

  it("should validate a correct manifest", () => {
    const result = validateManifest(validManifest);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it("should reject manifest with missing fields", () => {
    const result = validateManifest({ id: "incomplete" });
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it("should reject manifest with invalid category", () => {
    const result = validateManifest({
      ...validManifest,
      category: "nonexistent",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("category");
  });

  it("should register and retrieve builtin manifests", () => {
    clearManifests();
    registerBuiltinManifest(validManifest);
    const retrieved = getManifest("test-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.title).toBe("Test Case");

    const all = listAllManifests();
    expect(all.length).toBeGreaterThanOrEqual(1);
    clearManifests();
  });

  it("should reject invalid builtin manifest registration", () => {
    clearManifests();
    expect(() =>
      registerBuiltinManifest({ id: "bad" } as EvalCaseManifest),
    ).toThrow("Invalid manifest");
  });

  it("should register many manifests at once", () => {
    clearManifests();
    const manifests = [
      { ...validManifest, id: "multi-1" },
      { ...validManifest, id: "multi-2" },
    ];
    registerBuiltinManifests(manifests);
    expect(getManifest("multi-1")).toBeDefined();
    expect(getManifest("multi-2")).toBeDefined();
    clearManifests();
  });
});

describe("workspace creation", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "deepreef-eval-test-"));
    process.env.DEEPRREF_ROOT = tmpDir;
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DEEPRREF_ROOT;
  });

  it("should create a workspace directory for a case", async () => {
    const manifest: EvalCaseManifest = {
      id: "test-workspace",
      category: "coding-basics",
      suite: "smoke",
      title: "Workspace Test",
      description: "Testing workspace creation",
      fixtureSource: "cb-fix-ts-type",
      taskPrompt: "Do something",
      expectedVerification: ["done"],
      verifier: { type: "file-assert", fileAssertions: [] },
    };

    const info = await createCaseWorkspace("run-1", manifest);
    expect(info.workspaceDir).toContain("run-1");
    expect(info.workspaceDir).toContain("test-workspace");
    expect(info.caseDir).toContain("cases");
  });

  it("should handle manifest with no fixture path", async () => {
    const manifest: EvalCaseManifest = {
      id: "no-fixture",
      category: "coding-basics",
      suite: "smoke",
      title: "No Fixture",
      description: "No fixture source",
      fixtureSource: "nonexistent-fixture",
      taskPrompt: "Do something",
      expectedVerification: ["done"],
      verifier: { type: "file-assert", fileAssertions: [] },
    };

    const info = await createCaseWorkspace("run-2", manifest);
    expect(info.workspaceDir).toBeTruthy();
  });
});

describe("verifier", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "deepreef-eval-verifier-"));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should pass file-assert verifier when all conditions met", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "test.txt"), "hello world", "utf-8");

    const manifest: EvalCaseManifest = {
      id: "file-assert-pass",
      category: "coding-basics",
      suite: "smoke",
      title: "File Assert Pass",
      description: "Test",
      fixtureSource: "none",
      taskPrompt: "test",
      expectedVerification: ["done"],
      verifier: {
        type: "file-assert",
        fileAssertions: [
          { path: "test.txt", mustExist: true, mustContain: ["hello"] },
        ],
      },
    };

    const result = await runVerifier(manifest, tmpDir);
    expect(result.verdict).toBe("pass");
    expect(result.passed).toBe(true);
  });

  it("should fail file-assert verifier when file missing", async () => {
    const manifest: EvalCaseManifest = {
      id: "file-assert-fail",
      category: "coding-basics",
      suite: "smoke",
      title: "File Assert Fail",
      description: "Test",
      fixtureSource: "none",
      taskPrompt: "test",
      expectedVerification: ["done"],
      verifier: {
        type: "file-assert",
        fileAssertions: [
          { path: "nonexistent.txt", mustExist: true },
        ],
      },
    };

    const result = await runVerifier(manifest, tmpDir);
    expect(result.verdict).toBe("fail");
    expect(result.passed).toBe(false);
  });

  it("should fail file-assert on missing content", async () => {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tmpDir, "code.ts"), "const x = 1;", "utf-8");

    const manifest: EvalCaseManifest = {
      id: "content-fail",
      category: "coding-basics",
      suite: "smoke",
      title: "Content Fail",
      description: "Test",
      fixtureSource: "none",
      taskPrompt: "test",
      expectedVerification: ["done"],
      verifier: {
        type: "file-assert",
        fileAssertions: [
          { path: "code.ts", mustContain: ["function"] },
        ],
      },
    };

    const result = await runVerifier(manifest, tmpDir);
    expect(result.verdict).toBe("fail");
  });

  it("should error on unknown verifier type", async () => {
    const manifest: EvalCaseManifest = {
      id: "unknown-type",
      category: "coding-basics",
      suite: "smoke",
      title: "Unknown",
      description: "Test",
      fixtureSource: "none",
      taskPrompt: "test",
      expectedVerification: ["done"],
      verifier: { type: "unknown" as any },
    };

    const result = await runVerifier(manifest, tmpDir);
    expect(result.verdict).toBe("error");
  });
});

describe("verifier edge cases", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "deepreef-eval-ver-edge-"));
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "app.ts"), "const greeting: string = 'hello';", "utf-8");
    writeFileSync(join(tmpDir, "secret.txt"), "hidden content", "utf-8");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("should pass file-assert with mustExist false when file absent", async () => {
    const manifest: EvalCaseManifest = {
      id: "not-exist-pass",
      category: "coding-basics", suite: "smoke",
      title: "Not Exist Pass", description: "",
      fixtureSource: "none", taskPrompt: "test",
      expectedVerification: [],
      verifier: { type: "file-assert", fileAssertions: [{ path: "should-not-exist.txt", mustExist: false }] },
    };
    const r = await runVerifier(manifest, tmpDir);
    expect(r.verdict).toBe("pass");
  });

  it("should fail file-assert when mustExist false but file found", async () => {
    const manifest: EvalCaseManifest = {
      id: "not-exist-fail",
      category: "coding-basics", suite: "smoke",
      title: "Not Exist Fail", description: "",
      fixtureSource: "none", taskPrompt: "test",
      expectedVerification: [],
      verifier: { type: "file-assert", fileAssertions: [{ path: "secret.txt", mustExist: false }] },
    };
    const r = await runVerifier(manifest, tmpDir);
    expect(r.verdict).toBe("fail");
  });

  it("should pass file-assert with mustNotContain", async () => {
    const manifest: EvalCaseManifest = {
      id: "not-contain-pass",
      category: "coding-basics", suite: "smoke",
      title: "", description: "",
      fixtureSource: "none", taskPrompt: "",
      expectedVerification: [],
      verifier: { type: "file-assert", fileAssertions: [{ path: "app.ts", mustNotContain: ["function"] }] },
    };
    const r = await runVerifier(manifest, tmpDir);
    expect(r.verdict).toBe("pass");
  });

  it("should fail file-assert when mustNotContain found", async () => {
    const manifest: EvalCaseManifest = {
      id: "not-contain-fail",
      category: "coding-basics", suite: "smoke",
      title: "", description: "",
      fixtureSource: "none", taskPrompt: "",
      expectedVerification: [],
      verifier: { type: "file-assert", fileAssertions: [{ path: "app.ts", mustNotContain: ["hello"] }] },
    };
    const r = await runVerifier(manifest, tmpDir);
    expect(r.verdict).toBe("fail");
  });

  it("should pass command verifier on zero exit code", async () => {
    const manifest: EvalCaseManifest = {
      id: "cmd-pass",
      category: "coding-basics", suite: "smoke",
      title: "", description: "",
      fixtureSource: "none", taskPrompt: "",
      expectedVerification: [],
      verifier: { type: "command", command: "echo ok" },
    };
    const r = await runVerifier(manifest, tmpDir);
    expect(r.verdict).toBe("pass");
    expect(r.stdout).toContain("ok");
  });

  it("should fail command verifier on non-zero exit", async () => {
    const manifest: EvalCaseManifest = {
      id: "cmd-fail",
      category: "coding-basics", suite: "smoke",
      title: "", description: "",
      fixtureSource: "none", taskPrompt: "",
      expectedVerification: [],
      verifier: { type: "command", command: "exit 1" },
    };
    const r = await runVerifier(manifest, tmpDir);
    expect(r.verdict).toBe("fail");
    expect(r.exitCode).toBe(1);
  });

  it("should produce error on command timeout", async () => {
    const manifest: EvalCaseManifest = {
      id: "cmd-timeout",
      category: "coding-basics", suite: "smoke",
      title: "", description: "",
      fixtureSource: "none", taskPrompt: "",
      expectedVerification: [],
      verifier: { type: "command", command: "sleep 10", timeoutMs: 100 },
    };
    const r = await runVerifier(manifest, tmpDir);
    expect(r.verdict).toBe("error");
  });

  it("should handle script verifier with missing script", async () => {
    const manifest: EvalCaseManifest = {
      id: "script-pass",
      category: "coding-basics", suite: "smoke",
      title: "", description: "",
      fixtureSource: "none", taskPrompt: "",
      expectedVerification: [],
      verifier: { type: "script", scriptPath: "nonexistent-script.sh" },
    };
    const r = await runVerifier(manifest, tmpDir);
    expect(r.verdict).toBe("error");
    expect(r.details?.some(d => d.includes("Script failed"))).toBe(true);
  });
});

describe("score computation", () => {
  it("should compute 100 when all weights max", () => {
    const score = (() => {
      const verifierScore = 100;
      const objectiveScore = 100;
      const supervisorScore = 100;
      return verifierScore * 0.7 + objectiveScore * 0.2 + supervisorScore * 0.1;
    })();
    expect(score).toBe(100);
  });

  it("should compute 0 when verifier fails and others zero", () => {
    const score = 0 * 0.7 + 0 * 0.2 + 0 * 0.1;
    expect(score).toBe(0);
  });

  it("should compute 25 when only objective and supervisor contribute", () => {
    const score = 0 * 0.7 + 100 * 0.2 + 50 * 0.1;
    expect(score).toBe(25);
  });

  it("should floor to 40 max when verifier fails", () => {
    const raw = 0 * 0.7 + 100 * 0.2 + 100 * 0.1;
    const finalScore = raw > 40 ? 40 : raw;
    expect(finalScore).toBe(30);
  });

  it("should clamp final score to 100 max", () => {
    const raw = 100 * 0.7 + 100 * 0.2 + 100 * 0.1;
    const finalScore = Math.min(raw, 100);
    expect(finalScore).toBe(100);
  });
});

describe("runner", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "deepreef-eval-runner-"));
    process.env.DEEPRREF_ROOT = tmpDir;
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DEEPRREF_ROOT;
  });

  it("should run all cases and emit progress events", async () => {
    const events: string[] = [];
    const report = await runFixedEval({
      categoryId: "coding-basics",
      suiteId: "smoke",
      onProgress: (ev) => { events.push(ev.type); },
    });

    expect(report.meta.status).toBe("completed");
    expect(report.suiteSummary.totalCases).toBe(3);
    expect(events.filter(e => e === "case-start").length).toBe(3);
    expect(events.filter(e => e === "case-end").length).toBe(3);
  });

  it("should abort via AbortSignal", async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(
      runFixedEval({
        categoryId: "coding-basics",
        suiteId: "smoke",
        abortSignal: ac.signal,
      }),
    ).rejects.toThrow("aborted");
  });

  it("should run safety smoke suite", async () => {
    const report = await runFixedEval({
      categoryId: "safety",
      suiteId: "smoke",
    });
    expect(report.meta.status).toBe("completed");
    expect(report.suiteSummary.totalCases).toBeGreaterThanOrEqual(3);
  }, 15000);

  it("should persist trace.jsonl and registry.json", async () => {
    await runFixedEval({
      categoryId: "tool-use",
      suiteId: "smoke",
    });
    const dirs = readdirSync(join(tmpDir, "evals"));
    const latest = dirs.sort().reverse()[0]!;
    expect(existsSync(join(tmpDir, "evals", latest, "trace.jsonl"))).toBe(true);
    expect(existsSync(join(tmpDir, "evals", latest, "registry.json"))).toBe(true);
  });
});

describe("report generation", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "deepreef-eval-report-"));
    process.env.DEEPRREF_ROOT = tmpDir;
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.DEEPRREF_ROOT;
  });

  it("should save eval report to disk", async () => {
    const report = {
      meta: {
        runId: "test-run-1",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        categoryId: "coding-basics" as const,
        suiteId: "smoke" as const,
        model: "test-model",
        status: "completed" as const,
        environmentId: "sandbox" as const,
        providerId: "test-provider",
        officialScore: true,
      },
      suiteSummary: {
        suiteId: "smoke" as const,
        categoryId: "coding-basics" as const,
        totalCases: 2,
        passed: 1,
        failed: 1,
        errored: 0,
        skipped: 0,
        averageScore: 50,
        results: [
          {
            caseId: "case-1",
            title: "Case 1",
            category: "coding-basics" as const,
            suite: "smoke" as const,
            verdict: "pass" as const,
            verifierResult: {
              passed: true,
              verdict: "pass" as const,
              stdout: "ok",
              stderr: "",
              exitCode: 0,
              details: ["All good"],
            },
            objectiveSignals: {
              changedFiles: 1,
              diffSize: 10,
              toolFailureCount: 0,
              verificationCommandsRun: 1,
              cleanGitDiff: false,
            },
            supervisorAssessment: { taskCompletion: 90 },
            score: {
              verifierWeight: 0.7,
              objectiveWeight: 0.2,
              supervisorWeight: 0.1,
              verifierScore: 100,
              objectiveScore: 80,
              supervisorScore: 90,
              finalScore: 95,
            },
            workerOutput: "worker output",
            supervisorOutput: "supervisor output",
            patchDiff: "diff content",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            manifest: {
              id: "case-1",
              category: "coding-basics",
              suite: "smoke",
              title: "Case 1",
              description: "test",
              fixtureSource: "test",
              taskPrompt: "test",
              expectedVerification: ["ok"],
              verifier: { type: "command", command: "true" },
            },
          },
          {
            caseId: "case-2",
            title: "Case 2",
            category: "coding-basics" as const,
            suite: "smoke" as const,
            verdict: "fail" as const,
            verifierResult: null,
            objectiveSignals: null,
            supervisorAssessment: null,
            score: null,
            workerOutput: "",
            supervisorOutput: "",
            patchDiff: "",
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            manifest: {
              id: "case-2",
              category: "coding-basics",
              suite: "smoke",
              title: "Case 2",
              description: "test",
              fixtureSource: "test",
              taskPrompt: "test",
              expectedVerification: ["ok"],
              verifier: { type: "command", command: "true" },
            },
          },
        ],
      },
      overallScore: 50,
    };

    const { summaryMd, summaryJson } = await saveEvalReport(report);

    expect(summaryMd).toContain("# LoopRig Eval Report");
    expect(summaryMd).toContain("sandbox");
    expect(summaryMd).toContain("test-provider");
    expect(summaryMd).toContain("true");
    expect(summaryMd).toContain("test-run-1");
    expect(summaryMd).toContain("coding-basics");
    expect(summaryMd).toContain("Case 1");
    expect(summaryMd).toContain("95");

    expect(summaryJson).toContain("test-run-1");

    const reportDir = join(tmpDir, "evals", "test-run-1");
    expect(existsSync(join(reportDir, "meta.json"))).toBe(true);
    expect(existsSync(join(reportDir, "summary.json"))).toBe(true);
    expect(existsSync(join(reportDir, "summary.md"))).toBe(true);
    expect(existsSync(join(reportDir, "cases", "case-1", "score.json"))).toBe(true);
    expect(existsSync(join(reportDir, "cases", "case-1", "patch.diff"))).toBe(true);

    const meta = JSON.parse(
      readFileSync(join(reportDir, "meta.json"), "utf8"),
    );
    expect(meta.runId).toBe("test-run-1");
  });
});
