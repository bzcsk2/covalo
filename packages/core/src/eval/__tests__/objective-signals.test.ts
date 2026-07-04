import { describe, test, expect } from "bun:test";
import { getObjectiveSignals } from "../runner";

describe("objective-signals", () => {
  const repoDir = process.cwd();

  test("returns clean signals for clean workspace", async () => {
    const signals = await getObjectiveSignals(repoDir);
    expect(signals.changedFiles).toBeGreaterThanOrEqual(0);
    expect(signals.cleanGitDiff).toBe(false);
    expect(signals.gitSignalError).toBeUndefined();
  });

  test("includes gitSignalError when git fails", async () => {
    const signals = await getObjectiveSignals("/nonexistent/path/12345");
    expect(signals.gitSignalError).toBe("git command failed");
    expect(signals.cleanGitDiff).toBe(false);
    expect(signals.changedFiles).toBe(0);
  });
});
