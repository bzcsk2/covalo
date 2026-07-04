import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { getObjectiveSignals } from "../runner";

function initGitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "file.txt"), "hello", "utf-8");
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name test", { cwd: dir, stdio: "pipe" });
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m baseline --allow-empty", { cwd: dir, stdio: "pipe" });
}

describe("objective-signals", () => {
  test("clean workspace has cleanGitDiff=true and zero changes", async () => {
    const root = join(tmpdir(), `obj-signals-clean-${randomUUID()}`);
    initGitRepo(root);
    const signals = await getObjectiveSignals(root);
    expect(signals.changedFiles).toBe(0);
    expect(signals.trackedChangedFiles).toBe(0);
    expect(signals.untrackedFiles).toBe(0);
    expect(signals.cleanGitDiff).toBe(true);
    expect(signals.gitSignalError).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  test("tracked modified file increments trackedChangedFiles", async () => {
    const root = join(tmpdir(), `obj-signals-tracked-${randomUUID()}`);
    initGitRepo(root);
    writeFileSync(join(root, "file.txt"), "world", "utf-8");
    const signals = await getObjectiveSignals(root);
    expect(signals.trackedChangedFiles).toBeGreaterThanOrEqual(1);
    expect(signals.changedFiles).toBeGreaterThanOrEqual(1);
    expect(signals.cleanGitDiff).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("untracked file increments untrackedFiles", async () => {
    const root = join(tmpdir(), `obj-signals-untracked-${randomUUID()}`);
    initGitRepo(root);
    writeFileSync(join(root, "new.txt"), "new", "utf-8");
    const signals = await getObjectiveSignals(root);
    expect(signals.untrackedFiles).toBeGreaterThanOrEqual(1);
    expect(signals.changedFiles).toBeGreaterThanOrEqual(1);
    expect(signals.cleanGitDiff).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  test("git failure produces gitSignalError", async () => {
    const signals = await getObjectiveSignals("/nonexistent/path/12345");
    expect(signals.gitSignalError).toBe("git command failed");
    expect(signals.cleanGitDiff).toBe(false);
    expect(signals.changedFiles).toBe(0);
    expect(signals.trackedChangedFiles).toBe(0);
    expect(signals.untrackedFiles).toBe(0);
  });
});
