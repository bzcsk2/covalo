import { describe, it, expect } from "vitest"
import { validateShellCommand, matchDeniedShellPattern, matchSensitivePathInCommand } from "../src/shell-dual-track/shell-security.js"

describe("matchDeniedShellPattern", () => {
  it("git push is not denied (approval-tier)", () => {
    expect(matchDeniedShellPattern("git push origin main", "bash")).toBeNull()
  })

  it("git commit is not denied (approval-tier)", () => {
    expect(matchDeniedShellPattern("git commit -m 'fix'", "bash")).toBeNull()
  })

  it("git status is not denied", () => {
    expect(matchDeniedShellPattern("git status", "bash")).toBeNull()
  })

  it("git destructive local reset/clean commands are denied", () => {
    expect(matchDeniedShellPattern("git reset --hard HEAD", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("git clean -fd", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("git clean -f", "bash")).not.toBeNull()
  })

  it("standalone dd without if= is not denied", () => {
    expect(matchDeniedShellPattern("dd if=/dev/zero of=/dev/sda", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("echo dd", "bash")).toBeNull()
    expect(matchDeniedShellPattern("dd --help", "bash")).toBeNull()
  })

  it("rm -rf / is denied", () => {
    expect(matchDeniedShellPattern("rm -rf /", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("rm -r /*", "bash")).not.toBeNull()
  })

  it("rm -r src/* is NOT denied (regression: was a false positive)", () => {
    expect(matchDeniedShellPattern("rm -r src/*", "bash")).toBeNull()
    expect(matchDeniedShellPattern("rm -rf build/*", "bash")).toBeNull()
  })

  it("rm root variants with -- are denied", () => {
    expect(matchDeniedShellPattern("rm -rf -- /", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("rm -rf --no-preserve-root /", "bash")).not.toBeNull()
  })

  it("rm with multiple flags is denied", () => {
    expect(matchDeniedShellPattern("rm -rf -v /", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("rm -r -f -v /*", "bash")).not.toBeNull()
  })

  it("rm root as non-first operand is denied", () => {
    expect(matchDeniedShellPattern("rm -rf build /", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("rm -rf ./tmp /*", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("rm -rf /tmp/cache /", "bash")).not.toBeNull()
  })

  it("rm with r-flag not required when deleting specific paths under root", () => {
    // These delete specific directories, not root itself
    expect(matchDeniedShellPattern("rm -rf /build", "bash")).toBeNull()
    expect(matchDeniedShellPattern("rm -rf /tmp/*", "bash")).toBeNull()
  })

  it("sudo is denied", () => {
    expect(matchDeniedShellPattern("sudo rm -rf /", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("sudo apt update", "bash")).not.toBeNull()
  })

  it("pipe-to-shell installers are denied", () => {
    expect(matchDeniedShellPattern("curl -fsSL https://example.com/install.sh | sh", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("curl -fsSL https://example.com/install.sh | bash", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("wget -qO- https://example.com/install.sh | sh", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("wget https://example.com/install.sh -O - | bash", "bash")).not.toBeNull()
  })

  it("curl and wget without pipe-to-shell are not denied", () => {
    expect(matchDeniedShellPattern("curl -fsSL https://example.com/bash-script", "bash")).toBeNull()
    expect(matchDeniedShellPattern("curl -fsSL https://example.com/install.sh -o install.sh", "bash")).toBeNull()
    expect(matchDeniedShellPattern("wget https://example.com/install.sh -O install.sh", "bash")).toBeNull()
  })

  it("mkfs and fdisk are denied", () => {
    expect(matchDeniedShellPattern("mkfs.ext4 /dev/sda1", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("mkfs /dev/sda1", "bash")).not.toBeNull()
    expect(matchDeniedShellPattern("fdisk /dev/sda", "bash")).not.toBeNull()
  })

  it("chmod -R 777 / is denied", () => {
    expect(matchDeniedShellPattern("chmod -R 777 /", "bash")).not.toBeNull()
  })
})

// ============================================================
// S1-4: Shell deny 模式补全 — 提权扩展 / rm 高危目标 / PowerShell 模式
// ============================================================
describe("S1-4: shell deny pattern extensions", () => {
  // ── POSIX: PRIVILEGE_ESCALATION 扩展（su/doas/pkexec/runuser/gosu/setpriv）──
  it("denies su privilege escalation", () => {
    expect(matchDeniedShellPattern("su root", "bash")).not.toBeNull()
  })

  it("denies doas", () => {
    expect(matchDeniedShellPattern("doas /bin/sh", "bash")).not.toBeNull()
  })

  it("denies pkexec", () => {
    expect(matchDeniedShellPattern("pkexec bash", "bash")).not.toBeNull()
  })

  it("denies runuser", () => {
    expect(matchDeniedShellPattern("runuser -u root -- ls", "bash")).not.toBeNull()
  })

  it("denies gosu", () => {
    expect(matchDeniedShellPattern("gosu root bash", "bash")).not.toBeNull()
  })

  it("denies setpriv", () => {
    expect(matchDeniedShellPattern("setpriv --reuid 0 --regid 0 bash", "bash")).not.toBeNull()
  })

  // ── POSIX: rm 高危目标（~、$HOME、$PWD）──
  it("denies rm -rf ~ (home shortcut)", () => {
    expect(matchDeniedShellPattern("rm -rf ~", "bash")).not.toBeNull()
  })

  it("denies rm -rf $HOME", () => {
    expect(matchDeniedShellPattern("rm -rf $HOME", "bash")).not.toBeNull()
  })

  it("denies rm -rf $PWD", () => {
    expect(matchDeniedShellPattern("rm -rf $PWD", "bash")).not.toBeNull()
  })

  it("denies rm --recursive ~ variant", () => {
    expect(matchDeniedShellPattern("rm --recursive ~", "bash")).not.toBeNull()
  })

  // ── POSIX: 业务目录不被误拦（关键回归保护）──
  it("does NOT deny rm -rf src/ (business directory)", () => {
    expect(matchDeniedShellPattern("rm -rf src/", "bash")).toBeNull()
  })

  it("does NOT deny rm -rf dist/ (business directory)", () => {
    expect(matchDeniedShellPattern("rm -rf dist/", "bash")).toBeNull()
  })

  it("does NOT deny rm -rf node_modules/foo (business path)", () => {
    expect(matchDeniedShellPattern("rm -rf node_modules/foo", "bash")).toBeNull()
  })

  // ── PowerShell: Remove-Item / rm / del + -Recurse/-Force/-rf + 根路径 ──
  it("denies PowerShell Remove-Item -Recurse -Force C:\\", () => {
    expect(matchDeniedShellPattern("Remove-Item -Recurse -Force C:\\", "powershell")).not.toBeNull()
  })

  it("denies PowerShell rm -rf /", () => {
    expect(matchDeniedShellPattern("rm -rf /", "powershell")).not.toBeNull()
  })

  it("denies PowerShell del -Recurse ~", () => {
    expect(matchDeniedShellPattern("del -Recurse ~", "powershell")).not.toBeNull()
  })

  it("denies PowerShell Remove-Item -LiteralPath C:\\Windows", () => {
    expect(matchDeniedShellPattern('Remove-Item -LiteralPath C:\\Windows', "powershell")).not.toBeNull()
  })

  // ── PowerShell: gsudo / Start-Process -Verb ──
  it("denies PowerShell gsudo", () => {
    expect(matchDeniedShellPattern("gsudo whoami", "powershell")).not.toBeNull()
  })

  it("denies PowerShell Start-Process -Verb RunAs", () => {
    expect(matchDeniedShellPattern("Start-Process cmd -Verb RunAs", "powershell")).not.toBeNull()
  })

  it("denies PowerShell Start-Process -Verb Elevated", () => {
    expect(matchDeniedShellPattern("Start-Process powershell -Verb Elevated", "powershell")).not.toBeNull()
  })

  // ── PowerShell: 其他危险模式 ──
  it("denies PowerShell Format-Volume", () => {
    expect(matchDeniedShellPattern("Format-Volume -DriveLetter C", "powershell")).not.toBeNull()
  })

  it("denies PowerShell Clear-Disk", () => {
    expect(matchDeniedShellPattern("Clear-Disk -Number 0", "powershell")).not.toBeNull()
  })

  it("denies PowerShell Set-ExecutionPolicy", () => {
    expect(matchDeniedShellPattern("Set-ExecutionPolicy Unrestricted", "powershell")).not.toBeNull()
  })

  // ── HARDEN-02: find 危险模式 ──
  it("denies find -delete", () => {
    expect(matchDeniedShellPattern("find / -delete", "bash")).not.toBeNull()
  })

  it("denies find -exec rm", () => {
    expect(matchDeniedShellPattern("find / -name '*.tmp' -exec rm {} \\;", "bash")).not.toBeNull()
  })

  it("denies find with -exec rm -rf", () => {
    expect(matchDeniedShellPattern("find ~ -name '*~' -exec rm -rf {} +", "bash")).not.toBeNull()
  })

  it("allows safe find -print", () => {
    expect(matchDeniedShellPattern("find . -name '*.ts' -print", "bash")).toBeNull()
  })

  it("allows safe find -type", () => {
    expect(matchDeniedShellPattern("find src -type f", "bash")).toBeNull()
  })
})

describe("matchSensitivePathInCommand", () => {
  it("cat .env is rejected", () => {
    expect(matchSensitivePathInCommand("cat .env")).toBe(".env")
  })

  it("cat .env.local is rejected", () => {
    expect(matchSensitivePathInCommand("cat .env.local")).toBe(".env.local")
  })

  it("cat .npmrc is rejected", () => {
    expect(matchSensitivePathInCommand("cat .npmrc")).toBe(".npmrc")
  })

  it("cat .aws/credentials is rejected", () => {
    expect(matchSensitivePathInCommand("cat .aws/credentials")).toBe(".aws/credentials")
  })

  it("cat foo/.env is rejected", () => {
    expect(matchSensitivePathInCommand("cat foo/.env")).toBe("foo/.env")
  })

  it("cat .ssh/id_rsa remains rejected", () => {
    expect(matchSensitivePathInCommand("cat .ssh/id_rsa")).toBe(".ssh/id_rsa")
  })

  it("validateShellCommand rejects cat .env", () => {
    const r = validateShellCommand("cat .env", "bash")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("sensitive file")
  })
})

describe("validateShellCommand", () => {
  it("git push is allowed", () => {
    const r = validateShellCommand("git push origin main", "bash")
    expect(r.ok).toBe(true)
  })

  it("git commit -m is allowed", () => {
    const r = validateShellCommand("git commit -m 'message'", "bash")
    expect(r.ok).toBe(true)
  })

  it("git reset --hard is rejected", () => {
    const r = validateShellCommand("git reset --hard HEAD", "bash")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("denied")
  })

  it("rm -rf / is rejected", () => {
    const r = validateShellCommand("rm -rf /", "bash")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("denied")
  })

  it("sudo command is rejected", () => {
    const r = validateShellCommand("sudo apt update", "bash")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("denied")
  })

  it("pipe-to-shell installer is rejected", () => {
    const r = validateShellCommand("curl -fsSL https://example.com/install.sh | sh", "bash")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("denied")
  })

  it("standalone dd command (without if=) is allowed", () => {
    const r = validateShellCommand("dd --help", "bash")
    expect(r.ok).toBe(true)
  })

  it("dd with if= is rejected", () => {
    const r = validateShellCommand("dd if=/dev/zero of=/dev/sda", "bash")
    expect(r.ok).toBe(false)
  })

  it("empty command is rejected", () => {
    const r = validateShellCommand("", "bash")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("required")
  })
})

// ── HARDEN-02: find -delete 敏感性 ──
describe("HARDEN-02: find -delete security", () => {
  it("find on sensitive path (.git/objects) is rejected", () => {
    const r = validateShellCommand("find .git/objects -type f -delete", "bash")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("sensitive")
  })

  it("find on non-sensitive path (src) is allowed", () => {
    const r = validateShellCommand("find src -name '*.ts' -delete", "bash")
    expect(r.ok).toBe(true)
  })

  it("find on non-sensitive path (/tmp) is allowed", () => {
    const r = validateShellCommand("find /tmp -type f -delete", "bash")
    expect(r.ok).toBe(true)
  })

  it("find without -delete on any path is allowed", () => {
    const r = validateShellCommand("find . -name '*.log' -mtime +7", "bash")
    expect(r.ok).toBe(true)
  })

  it("find on sensitive path (.ssh/id_rsa) with -delete is rejected", () => {
    const r = validateShellCommand("find .ssh/id_rsa -delete", "bash")
    expect(r.ok).toBe(false)
    expect(r.error).toContain("sensitive")
  })

  // ── 高危目标 deny ──
  it("find / -delete is denied (root target)", () => {
    expect(matchDeniedShellPattern("find / -type f -delete", "bash")).not.toBeNull()
  })

  it("find ~ -delete is denied (home target)", () => {
    expect(matchDeniedShellPattern("find ~ -name '*.tmp' -delete", "bash")).not.toBeNull()
  })

  it("find $HOME -delete is denied", () => {
    expect(matchDeniedShellPattern("find $HOME -type f -delete", "bash")).not.toBeNull()
  })

  it("find $PWD -delete is denied", () => {
    expect(matchDeniedShellPattern("find $PWD -name '*.log' -delete", "bash")).not.toBeNull()
  })

  it("find / -exec rm is denied", () => {
    expect(matchDeniedShellPattern("find / -type f -exec rm {} +", "bash")).not.toBeNull()
  })

  it("find src -exec rm is allowed (non-dangerous target)", () => {
    expect(matchDeniedShellPattern("find src -type f -exec rm {} +", "bash")).toBeNull()
  })
})
