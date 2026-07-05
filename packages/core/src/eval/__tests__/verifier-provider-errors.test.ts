import { describe, test, expect } from "bun:test";
import { setSandboxProvider, runVerifier } from "../verifier";

describe("verifier-provider-errors", () => {
  const throwingProvider = {
    id: "throwing",
    name: "Throwing",
    capabilities: { sandbox: false, official: false },
    metadata: { version: "0.0.0" },
    async run() {
      throw new Error("provider boom");
    },
  } as any;

  test("command verifier returns structured error when provider throws", async () => {
    setSandboxProvider(throwingProvider);
    try {
      const result = await runVerifier(
        {
          id: "x",
          category: "coding-basics",
          suite: "smoke",
          title: "x",
          description: "x",
          fixtureSource: "x",
          taskPrompt: "x",
          expectedVerification: [],
          verifier: { type: "command", command: "echo hello" },
        },
        "/tmp",
      );

      expect(result.verdict).toBe("error");
      expect(result.passed).toBe(false);
      expect(result.details).toContain("Sandbox provider threw during command verifier");
    } finally {
      setSandboxProvider(null);
    }
  });
});
