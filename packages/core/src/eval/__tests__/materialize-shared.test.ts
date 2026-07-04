import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { patchTestPaths } from "../materialize/shared";

describe("materialize-shared", () => {
  const root = join(tmpdir(), `materialize-shared-${randomUUID()}`);

  test("replaces /app/ with ./ in python tests", async () => {
    const testsDir = join(root, "tests");
    mkdirSync(testsDir, { recursive: true });
    writeFileSync(join(testsDir, "test_a.py"), 'assert "/app/data" in PATH', "utf-8");
    patchTestPaths(root);
    const content = await Bun.file(join(testsDir, "test_a.py")).text();
    expect(content).toContain("./data");
    expect(content).not.toContain("/app/");
  });

  test("does nothing when tests dir missing", async () => {
    const emptyRoot = join(tmpdir(), `materialize-shared-empty-${randomUUID()}`);
    expect(() => patchTestPaths(emptyRoot)).not.toThrow();
  });
});
