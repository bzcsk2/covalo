export type EvalEnvironmentId = "sandbox.benchmark" | "sandbox.local" | "diagnostic";

export type ScoreKind = "official" | "local-compatible";

export const ENV_ALIASES: Record<string, EvalEnvironmentId> = {
  sandbox: "sandbox.benchmark",
  localenv: "sandbox.local",
  container: "sandbox.local",
  diagnostic: "diagnostic",
};

export function resolveEvalEnvironment(input: string): EvalEnvironmentId {
  if (input === "sandbox.benchmark" || input === "sandbox.local" || input === "diagnostic") {
    return input as EvalEnvironmentId;
  }
  return ENV_ALIASES[input] ?? "sandbox.local";
}

export interface ToolchainTool {
  name: string;
  version?: string;
  source: "managed" | "host" | "fallback";
  path?: string;
  sha256?: string;
}

export interface ToolchainFingerprint {
  profile: string;
  tools: ToolchainTool[];
  path: string[];
  createdAt: string;
}

export interface EvalSandboxProfile {
  id: EvalEnvironmentId;
  toolchainProfile: string;
  officialScore: boolean;
  path: string[];
  toolchainFingerprint: ToolchainFingerprint | null;
  networkPolicy: {
    setup: boolean;
    agent: boolean;
    verifier: boolean;
  };
}

export type SandboxProviderId =
  | "soft-workspace"
  | "bwrap"
  | "seatbelt"
  | "docker"
  | "podman";

export interface SandboxCapabilities {
  available: boolean;
  official: boolean;
  providerId: SandboxProviderId;
  reason?: string;
}

export interface SandboxCommand {
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  allowNetwork?: boolean;
  readRoots: string[];
  writeRoots: string[];
  readonlyRoots?: string[];
}

export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  /**
   * Tier 1c: 实际执行命令的 shell（如 "/bin/sh"、"C:\Program Files\Git\bin\bash.exe"、"cmd.exe"）。
   * 用于 eval report 追溯，避免 "cmd.exe 跑出错误答案却当正确分数" 的隐患。
   * soft-workspace provider 总是填充此字段；其他 provider 可选填充。
   */
  shellUsed?: string;
}

export interface PreflightCheck {
  name: string;
  found: boolean;
  path?: string;
  version?: string;
}

export interface PreflightResult {
  providerId: SandboxProviderId;
  environmentId: EvalEnvironmentId;
  path: string;
  checks: PreflightCheck[];
  allFound: boolean;
  startedAt: string;
  finishedAt: string;
  error?: string;
}

export interface SandboxProvider {
  id: SandboxProviderId;
  canRun(): Promise<SandboxCapabilities>;
  run(input: SandboxCommand): Promise<SandboxResult>;
  runPreflight?(environmentId: EvalEnvironmentId): Promise<PreflightResult>;
  getProfile?(): EvalSandboxProfile | null;
  setProfile?(profile: EvalSandboxProfile): void;
}
