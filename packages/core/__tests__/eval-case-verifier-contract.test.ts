import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getManifest,
  listAllManifests,
  registerBuiltinManifests,
  clearManifests,
  createCaseWorkspace,
  runVerifier,
  refreshRegistry,
} from "../src/eval/index.js";
import { ALL_MANIFESTS } from "../src/eval/fixtures/index.js";
import { getRealManifests } from "../src/eval/generated/manifests.js";
import type { EvalCaseManifest } from "../src/eval/types";

beforeAll(() => {
  if (listAllManifests().length === 0) {
    registerBuiltinManifests(ALL_MANIFESTS);
    const realManifests = getRealManifests();
    if (realManifests.length > 0) {
      registerBuiltinManifests(realManifests);
      refreshRegistry();
    }
  }
});

const FIXTURE_MANIFEST_IDS = [
  "cb-fix-ts-type",
  "cb-fix-json-cli",
  "cb-fix-test-fail",
  "tu-search-before-edit",
  "tu-run-verify",
  "tu-retry-on-fail",
];

describe("native sandbox fixture verifier contract", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "covalo-verifier-contract-"));
    process.env.COVALO_ROOT = tmpDir;
    // Direct verifier execution required for these fixtures running without sandbox
    process.env.COVALO_ALLOW_DIRECT_VERIFIER = "1";
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.COVALO_ROOT;
    delete process.env.COVALO_ALLOW_DIRECT_VERIFIER;
  });

  it("all sandbox fixtures are registered", () => {
    const all = listAllManifests();
    for (const id of FIXTURE_MANIFEST_IDS) {
      const m = getManifest(id);
      expect(m).toBeDefined();
      expect(m!.suite).toBe("smoke");
    }
  });

  it("each fixture verifier exists and has correct type", () => {
    for (const id of FIXTURE_MANIFEST_IDS) {
      const m = getManifest(id)!;
      expect(m.verifier.type).toBe("command");
      expect(m.verifier.command).toBeTruthy();
    }
  });

  it("each fixture declares requiredBinaries including bun", () => {
    for (const id of FIXTURE_MANIFEST_IDS) {
      const m = getManifest(id)!;
      expect(m.requiredBinaries).toBeDefined();
      expect(m.requiredBinaries!).toContain("bun");
    }
  });

  it("verifier output does not contain 'No tests found' when run against fixture workspace", async () => {
    for (const id of FIXTURE_MANIFEST_IDS) {
      const manifest = getManifest(id)!;
      const info = await createCaseWorkspace("test-run", manifest);
      const result = await runVerifier(manifest, info.workspaceDir);
      expect(result.stdout).not.toContain("No tests found");
      expect(result.stderr).not.toContain("No tests found");
      // Verifier must produce meaningful output — either test results or real errors
      expect(result.stdout + result.stderr).toMatch(
        /Ran .* tests|pass|fail|expect|SyntaxError|Error|FAIL|PASS|\btest\b/i,
      );
    }
  });

  it("baseline (unfixed) fixtures should fail for business-logic reasons, not infra", async () => {
    for (const id of FIXTURE_MANIFEST_IDS) {
      const manifest = getManifest(id)!;
      const info = await createCaseWorkspace("test-run", manifest);
      const result = await runVerifier(manifest, info.workspaceDir);
      expect(result.verdict).not.toBe("error");
    }
  });
});

describe("empty file-assert rejection", () => {
  it("validateManifest rejects file-assert with empty fileAssertions", async () => {
    const { validateManifest } = await import("../src/eval/loader.js");
    const result = validateManifest({
      id: "empty-file-assert",
      category: "coding-basics",
      suite: "smoke",
      title: "Empty file assert",
      description: "Should be rejected",
      fixtureSource: "test",
      taskPrompt: "test",
      expectedVerification: ["test"],
      verifier: {
        type: "file-assert",
        fileAssertions: [],
      },
    } as EvalCaseManifest);
    expect(result.success).toBe(false);
  });

  it("runVerifier returns error for empty file-assert even if schema skipped", async () => {
    // Bypass schema validation by directly calling runFileAssertVerifier
    const manifest: EvalCaseManifest = {
      id: "bypass-empty",
      category: "coding-basics",
      suite: "smoke",
      title: "Bypass test",
      description: "test",
      fixtureSource: "test",
      taskPrompt: "test",
      expectedVerification: ["test"],
      verifier: {
        type: "file-assert",
        fileAssertions: [],
      },
    };
    const workspace = mkdtempSync(join(tmpdir(), "verifier-empty-"));
    try {
      const result = await runVerifier(manifest, workspace);
      expect(result.verdict).toBe("error");
      expect(result.passed).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("requiredBinaries declaration coverage", () => {
  it("all native sandbox fixtures have requiredBinaries", () => {
    const all = listAllManifests();
    for (const m of all) {
      if (m.suite === "smoke" && !m.sourceMeta) {
        expect(m.requiredBinaries).toBeDefined();
        expect(m.requiredBinaries!.length).toBeGreaterThan(0);
      }
    }
  });

  it("terminal-bench manifests declare python3/pytest/pip", () => {
    const all = listAllManifests();
    const tb = all.filter((m) => m.sourceMeta?.sourceKind === "terminal-bench");
    for (const m of tb) {
      expect(m.requiredBinaries).toBeDefined();
      expect(m.requiredBinaries!).toContain("python3");
      expect(m.requiredBinaries!).toContain("pytest");
    }
  });

  it("swe-bench manifests declare python3/pip/git", () => {
    const all = listAllManifests();
    const swe = all.filter((m) => m.sourceMeta?.sourceKind === "swe-bench");
    for (const m of swe) {
      expect(m.requiredBinaries).toBeDefined();
      expect(m.requiredBinaries!).toContain("python3");
      expect(m.requiredBinaries!).toContain("git");
    }
  });


});
