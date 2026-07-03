import { describe, it, expect, vi } from "vitest"
import { HookManager } from "../src/hooks.js"

describe("HookManager", () => {
  it("should call beforeToolCall and return deny", async () => {
    const hooks = new HookManager()
    hooks.addHooks({
      beforeToolCall: async () => "deny",
    })
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBe("deny")
  })

  it("should call beforeToolCall and return allow", async () => {
    const hooks = new HookManager()
    hooks.addHooks({
      beforeToolCall: async () => "allow",
    })
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBe("allow")
  })

  it("should return undefined when no hooks registered", async () => {
    const hooks = new HookManager()
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBeUndefined()
  })

  it("should fail-safe to deny when beforeToolCall throws", async () => {
    const hooks = new HookManager()
    hooks.addHooks({
      beforeToolCall: async () => { throw new Error("hook error") },
    })
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBe("deny")
  })

  it("should call afterToolCall", async () => {
    const hooks = new HookManager()
    const spy = vi.fn()
    hooks.addHooks({ afterToolCall: spy })
    await hooks.runAfterToolCall("bash", { content: "ok", isError: false })
    expect(spy).toHaveBeenCalledWith("bash", { content: "ok", isError: false })
  })

  it("should resolve when afterToolCall is not registered", async () => {
    const hooks = new HookManager()
    await hooks.runAfterToolCall("bash", { content: "ok", isError: false })
    // Should not throw
  })

  it("should call onLoopEvent", async () => {
    const hooks = new HookManager()
    const spy = vi.fn()
    hooks.addHooks({ onLoopEvent: spy })
    await hooks.runOnLoopEvent({ role: "assistant_delta", content: "hi" })
    expect(spy).toHaveBeenCalledWith({ role: "assistant_delta", content: "hi" })
  })

  it("should support removeHooks", async () => {
    const hooks = new HookManager()
    const h = { beforeToolCall: async () => "deny" as const }
    hooks.addHooks(h)
    hooks.removeHooks(h)
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBeUndefined()
  })

  it("should support clear", async () => {
    const hooks = new HookManager()
    hooks.addHooks({ beforeToolCall: async () => "deny" as const })
    hooks.clear()
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBeUndefined()
  })

  it("should stop at first deny in multi-hook chain", async () => {
    const hooks = new HookManager()
    const spy = vi.fn()
    hooks.addHooks({
      beforeToolCall: async () => "deny" as const,
    })
    hooks.addHooks({
      beforeToolCall: async () => { spy(); return "allow" as const },
    })
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBe("deny")
    expect(spy).not.toHaveBeenCalled()
  })

  it("should stop at first allow in multi-hook chain", async () => {
    const hooks = new HookManager()
    const spy = vi.fn()
    hooks.addHooks({
      beforeToolCall: async () => "allow" as const,
    })
    hooks.addHooks({
      beforeToolCall: async () => { spy(); return "deny" as const },
    })
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBe("allow")
    expect(spy).not.toHaveBeenCalled()
  })

  it("should continue through non-returning hooks in multi-hook chain", async () => {
    const hooks = new HookManager()
    const spy1 = vi.fn()
    const spy2 = vi.fn()
    hooks.addHooks({
      beforeToolCall: async () => { spy1() },
    })
    hooks.addHooks({
      beforeToolCall: async () => { spy2(); return "deny" as const },
    })
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBe("deny")
    expect(spy1).toHaveBeenCalled()
    expect(spy2).toHaveBeenCalled()
  })

  it("should call all afterToolCall hooks in chain", async () => {
    const hooks = new HookManager()
    const spy1 = vi.fn()
    const spy2 = vi.fn()
    hooks.addHooks({ afterToolCall: spy1 })
    hooks.addHooks({ afterToolCall: spy2 })
    await hooks.runAfterToolCall("bash", { content: "ok", isError: false })
    expect(spy1).toHaveBeenCalledWith("bash", { content: "ok", isError: false })
    expect(spy2).toHaveBeenCalledWith("bash", { content: "ok", isError: false })
  })

  it("M14: should survive afterToolCall exception and continue to next hook", async () => {
    const hooks = new HookManager()
    const spy = vi.fn()
    hooks.addHooks({
      afterToolCall: async () => { throw new Error("hook failed") },
    })
    hooks.addHooks({ afterToolCall: spy })
    // Source already has try-catch in runAfterToolCall — exception is swallowed
    await hooks.runAfterToolCall("bash", { content: "ok", isError: false })
    expect(spy).toHaveBeenCalledWith("bash", { content: "ok", isError: false })
  })

  // ─── P5: Hook Observability Enhancement ──────────────────────────

  it("P5: onHookError called when beforeToolCall throws", async () => {
    const hooks = new HookManager()
    const errorSpy = vi.fn()
    hooks.setErrorObserver(errorSpy)
    hooks.addHooks({
      beforeToolCall: async () => { throw new Error("before failed") },
    })
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBe("deny")
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(errorSpy.mock.calls[0][1]).toBe("before")
  })

  it("P5: onHookError called when afterToolCall throws", async () => {
    const hooks = new HookManager()
    const errorSpy = vi.fn()
    hooks.setErrorObserver(errorSpy)
    hooks.addHooks({
      afterToolCall: async () => { throw new Error("after failed") },
    })
    await hooks.runAfterToolCall("bash", { content: "ok", isError: false })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(errorSpy.mock.calls[0][1]).toBe("after")
  })

  it("P5: onHookError called when onLoopEvent throws", async () => {
    const hooks = new HookManager()
    const errorSpy = vi.fn()
    hooks.setErrorObserver(errorSpy)
    hooks.addHooks({
      onLoopEvent: async () => { throw new Error("loop failed") },
    })
    // Should not throw — error is caught and reported
    await hooks.runOnLoopEvent({ role: "test" })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0][0]).toBeInstanceOf(Error)
    expect(errorSpy.mock.calls[0][1]).toBe("loop_event")
  })

  it("P5: afterToolCall exception does not interrupt remaining hooks", async () => {
    const hooks = new HookManager()
    const errorSpy = vi.fn()
    const spy1 = vi.fn()
    const spy2 = vi.fn()
    hooks.setErrorObserver(errorSpy)
    hooks.addHooks({ afterToolCall: async () => { throw new Error("fail") } })
    hooks.addHooks({ afterToolCall: spy1 })
    hooks.addHooks({ afterToolCall: spy2 })
    await hooks.runAfterToolCall("bash", { content: "ok", isError: false })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(spy1).toHaveBeenCalled()
    expect(spy2).toHaveBeenCalled()
  })

  it("P5: onLoopEvent exception does not interrupt remaining hooks", async () => {
    const hooks = new HookManager()
    const errorSpy = vi.fn()
    const spy1 = vi.fn()
    const spy2 = vi.fn()
    hooks.setErrorObserver(errorSpy)
    hooks.addHooks({ onLoopEvent: async () => { throw new Error("fail") } })
    hooks.addHooks({ onLoopEvent: spy1 })
    hooks.addHooks({ onLoopEvent: spy2 })
    await hooks.runOnLoopEvent({ role: "test" })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(spy1).toHaveBeenCalled()
    expect(spy2).toHaveBeenCalled()
  })

  it("P5: no error observer — errors are silently swallowed (backward compat)", async () => {
    const hooks = new HookManager()
    hooks.addHooks({
      afterToolCall: async () => { throw new Error("fail") },
      onLoopEvent: async () => { throw new Error("fail") },
    })
    // Should not throw even without error observer
    await hooks.runAfterToolCall("bash", { content: "ok", isError: false })
    await hooks.runOnLoopEvent({ role: "test" })
  })


  // ─── T1: Hook fail-safe deny reason ───────────────────────────────

  it("T1: lastHookDenyReason is set when beforeToolCall throws", async () => {
    const hooks = new HookManager()
    hooks.addHooks({
      beforeToolCall: async () => { throw new Error("custom hook failure") },
    })
    const result = await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(result).toBe("deny")
    expect(hooks.lastHookDenyReason).toContain("beforeToolCall hook failed")
    expect(hooks.lastHookDenyReason).toContain("custom hook failure")
  })

  it("T1: lastHookDenyReason is undefined on successful hook", async () => {
    const hooks = new HookManager()
    hooks.addHooks({
      beforeToolCall: async () => "allow",
    })
    await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(hooks.lastHookDenyReason).toBeUndefined()
  })

  it("T1: lastHookDenyReason is consumed by resolveDenyMessage", async () => {
    const hooks = new HookManager()
    hooks.addHooks({
      beforeToolCall: async () => { throw new Error("hook error") },
    })
    await hooks.runBeforeToolCall({ toolName: "bash", args: {}, tier: "exec", permissionDecision: "ask" })
    expect(hooks.lastHookDenyReason).toBeTruthy()
    const reason = hooks.lastHookDenyReason
    hooks.lastHookDenyReason = undefined
    expect(reason).toContain("beforeToolCall hook failed")
    expect(hooks.lastHookDenyReason).toBeUndefined()
  })
})
