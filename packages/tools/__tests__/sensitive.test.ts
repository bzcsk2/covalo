import { describe, it, expect } from "vitest"
import { isSensitive, isWriteProtected, SENSITIVE_READ_PATTERNS, SENSITIVE_WRITE_PATTERNS } from "../src/sensitive.js"

describe("isSensitive", () => {
  it("should detect api-key file", () => {
    expect(isSensitive("/path/to/api-key")).toBe(true)
  })

  it("should detect .env file", () => {
    expect(isSensitive("/path/to/.env")).toBe(true)
  })

  it("should detect .env.production", () => {
    expect(isSensitive("/path/to/.env.production")).toBe(true)
  })

  it("should detect .git directory access", () => {
    expect(isSensitive("/path/to/.git/config")).toBe(true)
  })

  it("should detect id_rsa", () => {
    expect(isSensitive("/path/to/id_rsa")).toBe(true)
  })

  it("should detect known_hosts", () => {
    expect(isSensitive("/path/to/known_hosts")).toBe(true)
  })

  it("should detect .pem files", () => {
    expect(isSensitive("/path/to/cert.pem")).toBe(true)
  })

  it("should detect .key files", () => {
    expect(isSensitive("/path/to/private.key")).toBe(true)
  })

  it("should detect .npmrc", () => {
    expect(isSensitive("/path/to/.npmrc")).toBe(true)
  })

  it("should detect AWS credentials file", () => {
    expect(isSensitive("/path/to/.aws/credentials")).toBe(true)
  })

  it("should NOT flag normal source files", () => {
    expect(isSensitive("/path/to/src/index.ts")).toBe(false)
  })

  it("should NOT flag ordinary text files", () => {
    expect(isSensitive("/path/to/readme.md")).toBe(false)
  })

  it("should normalize backslashes to forward slashes", () => {
    expect(isSensitive("C:\\path\\.env")).toBe(true)
  })

  // FIX-04: 新增路径模式
  it("should detect .kube/config", () => {
    expect(isSensitive("/home/user/.kube/config")).toBe(true)
  })

  it("should detect kubeconfig file", () => {
    expect(isSensitive("/home/user/kubeconfig")).toBe(true)
  })

  it("should detect .terraform directory", () => {
    expect(isSensitive("/home/user/project/.terraform/state")).toBe(true)
  })

  it("should detect .tfstate file", () => {
    expect(isSensitive("/home/user/prod.tfstate")).toBe(true)
  })

  it("should detect .tfstate.backup file", () => {
    expect(isSensitive("/home/user/prod.tfstate.backup")).toBe(true)
  })

  it("should detect .gpg file", () => {
    expect(isSensitive("/home/user/secret.gpg")).toBe(true)
  })

  it("should detect .asc file", () => {
    expect(isSensitive("/home/user/secret.asc")).toBe(true)
  })

  it("should detect gcloud credentials", () => {
    expect(isSensitive("/home/user/.config/gcloud/application_default_credentials.json")).toBe(true)
  })

  it("should detect Windows path with .kube", () => {
    expect(isSensitive("C:\\Users\\x\\.kube\\config")).toBe(true)
  })
})

describe("SENSITIVE_READ_PATTERNS", () => {
  it("should have at least 22 patterns", () => {
    expect(SENSITIVE_READ_PATTERNS.length).toBeGreaterThanOrEqual(22)
  })
})

describe("SENSITIVE_WRITE_PATTERNS", () => {
  it("should be a superset of read patterns (includes lockfiles etc.)", () => {
    expect(SENSITIVE_WRITE_PATTERNS.length).toBeGreaterThan(SENSITIVE_READ_PATTERNS.length)
  })

  // FIX-04: 新增路径在 write patterns 中也有效
  it("should redirect write to .kube/config", () => {
    expect(isWriteProtected("/home/user/.kube/config")).toBe(true)
  })

  it("should redirect write to .terraform", () => {
    expect(isWriteProtected("/home/user/project/.terraform/state")).toBe(true)
  })
})
