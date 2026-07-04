import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  initDefaultProviders,
  detectBestProvider,
  getProvider,
  listProviders,
  registerProvider,
  clearProviders,
  diagnoseEnvironment,
  execInSandbox,
  execViaProvider,
  SoftWorkspaceProvider,
  BwrapProvider,
  resolveBundledBwrap,
  getBwrapDiagnostics,
} from "../src/sandbox/index.js";
import type { SandboxProvider, SandboxCapabilities, SandboxCommand, SandboxResult } from "../src/sandbox/types.js";

let tmpDir: string;

class MockProvider implements SandboxProvider {
  id: SandboxProvider["id"];
  canRunCalls = 0;
  runCalls = 0;
  private _available: boolean;
  private _official: boolean;

  constructor(id: string = "mock-test", available = true, official = false) {
    this.id = id as SandboxProvider["id"];
    this._available = available;
    this._official = official;
  }

  async canRun(): Promise<SandboxCapabilities> {
    this.canRunCalls++;
    return { available: this._available, official: this._official, providerId: this.id };
  }

  async run(input: SandboxCommand): Promise<SandboxResult> {
    this.runCalls++;
    return { stdout: `exec: ${input.command}`, stderr: "", exitCode: 0, timedOut: false };
  }
}

class UnavailableProvider implements SandboxProvider {
  id = "unavailable" as const;
  async canRun(): Promise<SandboxCapabilities> {
    return { available: false, official: false, providerId: this.id, reason: "not available" };
  }
  async run(_input: SandboxCommand): Promise<SandboxResult> {
    return { stdout: "", stderr: "failed", exitCode: 1, timedOut: false };
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sandbox-test-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearProviders();
});

describe("provider-registry", () => {
  it("should register and retrieve a provider", () => {
    const p = new MockProvider();
    registerProvider(p);
    expect(getProvider("mock-test")).toBe(p);
  });

  it("should return undefined for unregistered provider", () => {
    expect(getProvider("mock-test")).toBeUndefined();
  });

  it("should list all providers", () => {
    const a = new MockProvider("mock-a");
    const b = new MockProvider("mock-b");
    registerProvider(a);
    registerProvider(b);
    expect(listProviders()).toHaveLength(2);
  });

  it("should init default providers (soft-workspace + bwrap)", () => {
    initDefaultProviders();
    expect(getProvider("soft-workspace")).toBeDefined();
    expect(getProvider("bwrap")).toBeDefined();
  });

  it("should re-register provider under same id (last wins)", () => {
    const a = new MockProvider();
    const b = new MockProvider();
    registerProvider(a);
    registerProvider(b);
    expect(getProvider("mock-test")).toBe(b);
  });

  it("detectBestProvider('sandbox.local') prefers bwrap boundary when available", async () => {
    initDefaultProviders();
    const { provider, capabilities } = await detectBestProvider("sandbox.local");
    expect(["bwrap", "soft-workspace"]).toContain(provider.id);
    expect(capabilities.available).toBe(true);
    expect(capabilities.official).toBe(false);
    if (provider.id === "bwrap") {
      expect(capabilities.reason).toContain("OS-level sandbox");
    }
  });

  it("detectBestProvider('sandbox.benchmark') prefers bwrap over soft-workspace when bwrap available", async () => {
    initDefaultProviders();
    const { provider, capabilities } = await detectBestProvider("sandbox.benchmark");
    // bwrap may or may not be available on this machine
    if (provider.id === "bwrap") {
      expect(capabilities.official).toBe(true);
    } else {
      // A2: bwrap 不可用时回退到 soft-workspace — 走 detectBestProvider 的
      // sandbox.benchmark 分支，直接返回 soft-workspace.canRun() 的 caps，
      // reason 不含 "falling back"（那是 fallback 路径才有的标记）。
      expect(provider.id).toBe("soft-workspace");
      expect(capabilities.official).toBe(false);
      expect(capabilities.reason).toContain("diagnostic only");
    }
  });

  it("detectBestProvider('sandbox.benchmark') falls back to soft-workspace when bwrap unavailable", async () => {
    registerProvider(new UnavailableProvider());
    registerProvider(new SoftWorkspaceProvider());
    const providers = listProviders();
    Object.defineProperty(providers[0], "id", { value: "bwrap" });

    const { provider, capabilities } = await detectBestProvider("sandbox.benchmark");
    expect(provider.id).toBe("soft-workspace");
    expect(capabilities.official).toBe(false);
  });

  it("detectBestProvider('diagnostic') falls back to soft-workspace", async () => {
    registerProvider(new SoftWorkspaceProvider());
    const { provider } = await detectBestProvider("diagnostic");
    expect(provider.id).toBe("soft-workspace");
  });

  it("detectBestProvider throws when no providers registered", async () => {
    await expect(detectBestProvider("sandbox.benchmark")).rejects.toThrow("No provider available");
  });

  it("detectBestProvider('sandbox.benchmark') returns unavailable provider when it's the only one", async () => {
    registerProvider(new UnavailableProvider());
    await expect(detectBestProvider("sandbox.benchmark")).rejects.toThrow("No provider available");
  });
});

describe("soft-workspace", () => {
  it("canRun returns available=true, official=false", async () => {
    const p = new SoftWorkspaceProvider();
    const caps = await p.canRun();
    expect(caps.available).toBe(true);
    expect(caps.official).toBe(false);
    expect(caps.providerId).toBe("soft-workspace");
    expect(caps.reason).toContain("diagnostic only");
  });

  it("run executes a command successfully", async () => {
    const p = new SoftWorkspaceProvider();
    const result = await p.run({ command: "echo hello", cwd: tmpDir, readRoots: [tmpDir], writeRoots: [tmpDir] });
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("run returns error for failed command", async () => {
    const p = new SoftWorkspaceProvider();
    const result = await p.run({ command: "exit 42", cwd: tmpDir, readRoots: [tmpDir], writeRoots: [tmpDir] });
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
  });

  // A2: 跨平台验证 — 用 node -e 读 process.env，避免依赖 POSIX shell 的 $VAR 展开。
  // SoftWorkspaceProvider 实现里会显式设置 HOME: safeCwd 并合并 input.env，所以两个测试
  // 在 Windows / POSIX 上都应该通过。
  it("run sets HOME to cwd", async () => {
    const p = new SoftWorkspaceProvider();
    const result = await p.run({
      command: 'node -e "process.stdout.write(process.env.HOME || \\"\\")"',
      cwd: tmpDir,
      readRoots: [tmpDir],
      writeRoots: [tmpDir],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(tmpDir);
  });

  it("run passes env vars", async () => {
    const p = new SoftWorkspaceProvider();
    const result = await p.run({
      command: 'node -e "process.stdout.write(process.env.MY_VAR || \\"\\")"',
      cwd: tmpDir,
      readRoots: [tmpDir],
      writeRoots: [tmpDir],
      env: { MY_VAR: "custom_value" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("custom_value");
  });
});

describe("bwrap provider (integration)", () => {
  it("canRun detection works (returns available or unavailable)", async () => {
    const p = new BwrapProvider();
    const caps = await p.canRun();
    expect(caps.providerId).toBe("bwrap");
    expect(typeof caps.available).toBe("boolean");
    expect(typeof caps.official).toBe("boolean");
  });

  it("run works when bwrap is available", async () => {
    const p = new BwrapProvider();
    const caps = await p.canRun();
    if (!caps.available) return; // skip if bwrap not installed
    const result = await p.run({
      command: "echo hello-from-bwrap",
      cwd: tmpDir,
      readRoots: [tmpDir],
      writeRoots: [tmpDir],
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-from-bwrap");
  });

  it("binds profile PATH directories into the sandbox", async () => {
    const p = new BwrapProvider();
    const caps = await p.canRun();
    if (!caps.available) return; // skip if bwrap not installed

    const profileToolDir = mkdtempSync(join(tmpdir(), "bwrap-profile-path-"));
    const workspace = mkdtempSync(join(tmpdir(), "bwrap-profile-workspace-"));
    try {
      const toolPath = join(profileToolDir, "mytool");
      writeFileSync(toolPath, "#!/bin/sh\necho managed-ok\n");
      chmodSync(toolPath, 0o755);
      p.setProfile({
        id: "sandbox.benchmark",
        toolchainProfile: "node",
        officialScore: true,
        path: [profileToolDir],
        toolchainFingerprint: null,
        networkPolicy: { setup: false, agent: false, verifier: false },
      });

      const result = await p.run({
        command: "command -v mytool && mytool",
        cwd: workspace,
        readRoots: [workspace],
        writeRoots: [workspace],
        allowNetwork: false,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("/covalo/toolchains/0/mytool");
      expect(result.stdout).toContain("managed-ok");
    } finally {
      rmSync(profileToolDir, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("detect", () => {
  it("diagnoseEnvironment returns unavailable when no providers", async () => {
    const diag = await diagnoseEnvironment("sandbox.benchmark");
    expect(diag.available).toBe(false);
    expect(diag.official).toBe(false);
    expect(diag.providerId).toBe("none");
    expect(diag.reason).toBeDefined();
  });

  it("diagnoseEnvironment returns diagnostic provider for sandbox.local", async () => {
    initDefaultProviders();
    const diag = await diagnoseEnvironment("sandbox.local");
    expect(diag.available).toBe(true);
    expect(diag.official).toBe(false);
    expect(["bwrap", "soft-workspace"]).toContain(diag.providerId);
  });

  it("diagnoseEnvironment('sandbox.benchmark') handles bwrap-unavailable fallback", async () => {
    registerProvider(new UnavailableProvider());
    registerProvider(new SoftWorkspaceProvider());
    const providers = listProviders();
    Object.defineProperty(providers[0], "id", { value: "bwrap" });
    const diag = await diagnoseEnvironment("sandbox.benchmark");
    expect(diag.available).toBe(true);
    expect(diag.providerId).toBe("soft-workspace");
  });
});

describe("exec", () => {
  it("execViaProvider delegates to provider.run", async () => {
    const p = new MockProvider();
    const result = await execViaProvider(p, "test-cmd", tmpDir, "sandbox.benchmark");
    expect(result.stdout).toBe("exec: test-cmd");
    expect(p.runCalls).toBe(1);
  });

  it("execInSandbox resolves provider and executes", async () => {
    registerProvider(new SoftWorkspaceProvider());
    const result = await execInSandbox("echo works", tmpDir, "sandbox.local");
    expect(result.stdout.trim()).toBe("works");
    expect(result.exitCode).toBe(0);
  });

  it("execInSandbox returns error for invalid command", async () => {
    registerProvider(new SoftWorkspaceProvider());
    const result = await execInSandbox("exit 1", tmpDir, "sandbox.local");
    expect(result.exitCode).toBe(1);
  });
});

describe("bundled-bwrap", () => {
  it("resolveBundledBwrap returns a path or null depending on environment", () => {
    const result = resolveBundledBwrap();
    // On this machine we may have bundled bwrap; just verify type
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("getBwrapDiagnostics returns object with expected keys", () => {
    const diag = getBwrapDiagnostics();
    expect(diag).toHaveProperty("platform");
    expect(diag).toHaveProperty("arch");
    expect(diag).toHaveProperty("systemBwrap");
    expect(diag).toHaveProperty("bundledPath");
    expect(diag).toHaveProperty("bundledExists");
  });
});
