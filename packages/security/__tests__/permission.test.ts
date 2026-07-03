import { describe, it, expect } from "vitest"
import { PermissionEngine } from "../src/permission.js"

describe("PermissionEngine", () => {
  it("should default to 'ask' for exec tier", () => {
    const engine = new PermissionEngine()
    const result = engine.decide("bash", {}, "exec")
    expect(result.decision).toBe("ask")
  })

  it("should default to 'allow' for read tier", () => {
    const engine = new PermissionEngine()
    const result = engine.decide("read_file", {}, "read")
    expect(result.decision).toBe("allow")
  })

  it("should default to 'ask' for write tier", () => {
    const engine = new PermissionEngine()
    const result = engine.decide("edit", {}, "write")
    expect(result.decision).toBe("ask")
  })

  it("should deny matching deny rules", () => {
    const engine = new PermissionEngine()
    engine.addDenyRule({ toolName: "bash", reason: "No bash allowed" })
    const result = engine.decide("bash", {}, "exec")
    expect(result.decision).toBe("deny")
    expect(result.reason).toContain("No bash allowed")
  })

  it("should deny with exact args matching", () => {
    const engine = new PermissionEngine()
    engine.addDenyRule({ toolName: "bash", args: { command: "ls" }, reason: "ls denied" })
    const result = engine.decide("bash", { command: "ls" }, "exec")
    expect(result.decision).toBe("deny")
  })

  it("should NOT deny when args don't match", () => {
    const engine = new PermissionEngine()
    engine.addDenyRule({ toolName: "bash", args: { command: "rm" } })
    const result = engine.decide("bash", { command: "ls" }, "exec")
    expect(result.decision).toBe("ask")
  })

  it("should allow matching allow rules", () => {
    const engine = new PermissionEngine()
    engine.addAllowRule({ toolName: "bash" })
    const result = engine.decide("bash", {}, "exec")
    expect(result.decision).toBe("allow")
  })

  it("should prioritize deny over allow", () => {
    const engine = new PermissionEngine()
    engine.addAllowRule({ toolName: "bash" })
    engine.addDenyRule({ toolName: "bash", reason: "override" })
    const result = engine.decide("bash", {}, "exec")
    expect(result.decision).toBe("deny")
  })

  it("should support regex tool names in deny rules", () => {
    const engine = new PermissionEngine()
    engine.addDenyRule({ toolName: /^rm/, reason: "rm tools denied" })
    expect(engine.decide("rm_file", {}, "exec").decision).toBe("deny")
    expect(engine.decide("rmdir", {}, "exec").decision).toBe("deny")
    expect(engine.decide("read_file", {}, "exec").decision).toBe("ask")
  })

  it("should support removeDenyRule", () => {
    const engine = new PermissionEngine()
    engine.addDenyRule({ toolName: "bash", reason: "no" })
    engine.removeDenyRule("bash")
    const result = engine.decide("bash", {}, "exec")
    expect(result.decision).toBe("ask")
  })

  it("should support clear", () => {
    const engine = new PermissionEngine()
    engine.addDenyRule({ toolName: "bash" })
    engine.clear()
    const result = engine.decide("bash", {}, "exec")
    expect(result.decision).toBe("ask")
  })

  it("should correctly remove deny rules by string name", () => {
    const engine = new PermissionEngine()
    engine.addDenyRule({ toolName: "bash", reason: "no" })
    engine.removeDenyRule("bash")
    expect(engine.decide("bash", {}, "exec").decision).toBe("ask")
  })

  it("S10: isAllowed returns true when decision is allow", () => {
    const engine = new PermissionEngine()
    expect(engine.isAllowed("read_file", {}, "read")).toBe(true)
    engine.addDenyRule({ toolName: "read_file" })
    expect(engine.isAllowed("read_file", {}, "read")).toBe(false)
  })

  it("S10: isDenied returns true when decision is deny", () => {
    const engine = new PermissionEngine()
    expect(engine.isDenied("read_file", {}, "read")).toBe(false)
    engine.addDenyRule({ toolName: "read_file" })
    expect(engine.isDenied("read_file", {}, "read")).toBe(true)
  })

  it("S11: fromJSON restores allow and deny rules", () => {
    const engine = PermissionEngine.fromJSON({
      allowRules: [{ toolName: "bash" }],
      denyRules: [{ toolName: "rm", reason: "no rm" }],
    })
    expect(engine.decide("bash", {}, "exec").decision).toBe("allow")
    expect(engine.decide("rm", {}, "exec").decision).toBe("deny")
  })

  it("S11: toJSON exports rules for serialization", () => {
    const engine = new PermissionEngine()
    engine.addAllowRule({ toolName: "bash" })
    engine.addDenyRule({ toolName: "rm", reason: "no rm" })
    const json = engine.toJSON()
    expect(json.allowRules).toHaveLength(1)
    expect(json.allowRules[0].toolName).toBe("bash")
    expect(json.denyRules).toHaveLength(1)
    expect(json.denyRules[0].reason).toBe("no rm")
  })

  it("S11: fromJSON handles empty rules", () => {
    const engine = PermissionEngine.fromJSON({})
    expect(engine.decide("bash", {}, "exec").decision).toBe("ask")
  })
})
