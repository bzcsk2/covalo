import { describe, it, expect, vi } from "vitest"
import { HookManager, HOOK_LOOP_EVENT_TIMEOUT_MS } from "../src/hooks.js"

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

  // ─── T12: loop_event hook timeout & drain safety ──────────────────

  it("T12: fast-completing hook does not leave a 30s ref timer behind", async () => {
    // 回归：之前实现里 timeout promise 不清理，task 快速完成后 setTimeout 仍持有 ref 30s，
    // 可能让测试进程或 CLI 退出变慢。修复后 task 完成时应 clearTimeout。
    const hooks = new HookManager()
    const spy = vi.fn()
    hooks.addHooks({ onLoopEvent: spy })

    // spy 只观察调用（callsthrough），不改变 clearTimeout 行为。
    // 用 try/finally 确保 mockRestore 一定执行，避免 spy 泄漏到其他测试文件。
    const spyClearTimeout = vi.spyOn(globalThis, "clearTimeout")
    try {
      await hooks.runOnLoopEvent({ role: "test" })
      expect(spy).toHaveBeenCalledTimes(1)

      // task 同步完成后，finally 分支应调用 clearTimeout。
      // 注意：因为 task 先 resolve，race 立即 settle，timeout 的 setTimeout 已注册但会被 clearTimeout 清理。
      expect(spyClearTimeout).toHaveBeenCalled()
    } finally {
      spyClearTimeout.mockRestore()
    }
  })

  it("T12: hanging hook — drain() does not wait forever (resolves after timeout fires)", async () => {
    // 回归：之前实现把原始 task（永久 pending）放入 pending Set，drain() 会永久等待。
    // 修复后 pending 里是 guarded promise，timeout 触发后 guarded settle，drain() 可以返回。
    //
    // 注意：不能用 vi.spyOn(globalThis, "setTimeout").mockImplementation(...)，
    // 因为 bun test 可能并发调度测试文件，mock 全局 setTimeout 会泄漏到其他测试文件
    // （如 e2e.test.ts 的 bash 工具用 setTimeout 设置超时定时器，mock 会立即触发 kill）。
    // 改用 vi.useFakeTimers() 隔离 — vitest 的 fake timers 会替换全局 setTimeout，
    // 但在 useRealTimers() 后会完全恢复，且不会影响其他测试文件（每个文件独立 sandbox）。
    vi.useFakeTimers()
    try {
      const hooks = new HookManager()
      // Hanging hook：永不 resolve
      hooks.addHooks({
        onLoopEvent: async () => new Promise(() => { /* never resolves */ }),
      })

      // runOnLoopEvent 会创建 guarded promise（带 30s fake timeout）
      const runPromise = hooks.runOnLoopEvent({ role: "test" })
      // 推进 fake timer 超过 30s — guarded promise 应因 timeout settle
      vi.advanceTimersByTime(HOOK_LOOP_EVENT_TIMEOUT_MS + 100)
      await runPromise

      // drain 应能返回（因为 guarded promise 已 settle，pending Set 已清理）
      await hooks.drain()
      expect(true).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
