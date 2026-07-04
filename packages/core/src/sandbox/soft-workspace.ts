import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import type { SandboxProvider, SandboxCommand, SandboxResult, SandboxCapabilities } from "./types";

/**
 * SoftWorkspaceProvider — 轻量工作区隔离（非安全沙箱）。
 * 提供基本的 cwd 包含检测和以工作区为 HOME 的环境隔离。
 * 不提供 OS 级安全边界，仅适用于诊断和开发测试。
 */
export class SoftWorkspaceProvider implements SandboxProvider {
  id = "soft-workspace" as const;

  async canRun(): Promise<SandboxCapabilities> {
    return {
      available: true,
      official: false,
      providerId: "soft-workspace",
      reason:
        "soft-workspace: directory isolation with cwd containment against read/write roots. " +
        "NOT an OS-level sandbox — provides no security boundary. " +
        "Scores are diagnostic only.",
    };
  }

  /**
   * 验证 cwd 在至少一个允许根目录下，否则抛出错误。
   * 使用 path.relative 而非 startsWith 来避免路径边界误判（如 /tmp/work2 误认为属于 /tmp/work）。
   */
  private resolveContainedCwd(cwd: string, allowRoots: string[]): string {
    if (allowRoots.length === 0) return cwd;

    const resolved = resolveReal(cwd);
    for (const root of allowRoots) {
      const resolvedRoot = resolveReal(root);
      const rel = relative(resolvedRoot, resolved);
      if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
        return resolved;
      }
    }
    throw new SandboxCwdError(
      `cwd ${cwd} is outside all allowed roots: ${allowRoots.join(", ")}`
    );
  }

  async run(input: SandboxCommand): Promise<SandboxResult> {
    const timeout = input.timeoutMs ?? 60_000;
    const allRoots = [...(input.readRoots ?? []), ...(input.writeRoots ?? [])];
    let safeCwd: string;
    try {
      safeCwd = this.resolveContainedCwd(input.cwd, allRoots);
    } catch (e) {
      return {
        stdout: "",
        stderr: e instanceof Error ? e.message : String(e),
        exitCode: 1,
        timedOut: false,
      };
    }

    // Tier 1c: 解析实际使用的 shell。
    // - POSIX: 用 /bin/sh（系统自带）
    // - Windows: 优先用 Git for Windows 自带的 bash.exe（绝大多数装了 git 的开发机都有），
    //   提供真正的 POSIX 语义（eval case 命令大概率按 POSIX shell 语义写）。
    //   找不到就退化为 cmd.exe，并在 shellUsed 字段标注以便追溯。
    const shellUsed = resolvePosixShell();
    const isWin = process.platform === "win32";

    // Tier 1b: Windows 环境隔离。
    // 之前只覆盖 HOME，Windows 工具大多看 USERPROFILE/APPDATA，隔离在 Windows 上不生效。
    // 现在补上 USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP，并提前创建目录避免子进程报错。
    const winEnv: Record<string, string> = {};
    if (isWin) {
      const appdataDir = join(safeCwd, ".appdata");
      const localAppdataDir = join(safeCwd, ".localappdata");
      const tmpDir = join(safeCwd, ".tmp");
      for (const d of [appdataDir, localAppdataDir, tmpDir]) {
        if (!existsSync(d)) {
          try { mkdirSync(d, { recursive: true }); } catch {}
        }
      }
      Object.assign(winEnv, {
        USERPROFILE: safeCwd,
        APPDATA: appdataDir,
        LOCALAPPDATA: localAppdataDir,
        TEMP: tmpDir,
        TMP: tmpDir,
      });
    }

    try {
      const result = spawnSync(input.command, [], {
        cwd: safeCwd,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        timeout,
        stdio: "pipe",
        // Tier 1c: Windows 下若找到 Git bash 就用它，否则退化为 cmd.exe（shell:true）。
        // POSIX 下显式传 "/bin/sh"，避免某些环境默认 shell 不一致。
        shell: shellUsed ?? (isWin ? true : "/bin/sh"),
        env: {
          ...process.env,
          ...input.env,
          HOME: safeCwd,
          ...winEnv,
        },
      });
      return {
        stdout: result.stdout?.toString() ?? "",
        stderr: result.stderr?.toString() ?? "",
        exitCode: result.status ?? 1,
        timedOut: result.error?.message?.includes("timed out") ?? false,
        // Tier 1c: 记录实际使用的 shell，便于 eval report 追溯。
        shellUsed: shellUsed ?? (isWin ? "cmd.exe" : "/bin/sh"),
      };
    } catch (err: unknown) {
      const error = err as Error & { stdout?: string; stderr?: string; status?: number; killed?: boolean; signal?: string };
      return {
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        exitCode: error.status ?? 1,
        timedOut: !!(error.killed || error.signal === "SIGTERM"),
        shellUsed: shellUsed ?? (isWin ? "cmd.exe" : "/bin/sh"),
      };
    }
  }
}

/**
 * Tier 1c: 解析 POSIX shell 路径。
 *
 * Windows 上绝大多数装了 git 的开发机都有 `C:\Program Files\Git\bin\bash.exe`，
 * 这不算"额外装沙箱"，是开发者机器本来就有的东西。
 * 用它执行 eval case 命令可以提供真正的 POSIX 语义（`&&`、`export`、heredoc 等），
 * 避免 cmd.exe 跑出错误结果却当正确分数的隐患。
 *
 * 找不到就返回 null，调用方退化为 cmd.exe（shell:true），并在 shellUsed 字段标注。
 */
function resolvePosixShell(): string | null {
  if (process.platform !== "win32") return "/bin/sh";
  const candidates: (string | null)[] = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    process.env.ProgramFiles ? join(process.env.ProgramFiles, "Git", "bin", "bash.exe") : null,
    process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Git", "bin", "bash.exe") : null,
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

export class SandboxCwdError extends Error {
  readonly path: string;
  constructor(message: string) {
    super(message);
    this.name = "SandboxCwdError";
    this.path = message;
  }
}

function resolveReal(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // 路径不存在时取最近存在的父目录
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    for (let i = parts.length; i > 0; i--) {
      const candidate = "/" + parts.slice(0, i).join("/");
      try {
        return realpathSync(candidate);
      } catch {
        continue;
      }
    }
    return p;
  }
}
