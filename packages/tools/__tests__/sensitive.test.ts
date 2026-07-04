import { describe, it, expect } from "vitest"
import { isSensitive, SENSITIVE_READ_PATTERNS, SENSITIVE_WRITE_PATTERNS } from "../src/sensitive.js"

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
})

describe("SENSITIVE_READ_PATTERNS", () => {
  it("should have at least 15 patterns", () => {
    expect(SENSITIVE_READ_PATTERNS.length).toBeGreaterThanOrEqual(15)
  })
})

describe("SENSITIVE_WRITE_PATTERNS", () => {
  it("should be a superset of read patterns (includes lockfiles etc.)", () => {
    expect(SENSITIVE_WRITE_PATTERNS.length).toBeGreaterThan(SENSITIVE_READ_PATTERNS.length)
  })
})
