import { afterEach, describe, expect, it } from "bun:test"
import type { ScrollBoxHandle } from "@deepreef/ink"
import { isMouseTrackingEnabled } from "../src/fullscreen.js"
import { applyMessageScrollKey } from "../src/useMessageScroll.js"

function makeScroll(overrides: Partial<ScrollBoxHandle> = {}) {
  const calls: Array<[string, number?]> = []
  const scroll: ScrollBoxHandle = {
    scrollTo: y => calls.push(["scrollTo", y]),
    scrollBy: dy => calls.push(["scrollBy", dy]),
    scrollToElement: () => {},
    scrollToBottom: () => calls.push(["scrollToBottom"]),
    getScrollTop: () => 50,
    getPendingDelta: () => 0,
    getScrollHeight: () => 200,
    getFreshScrollHeight: () => 200,
    getViewportHeight: () => 40,
    getViewportTop: () => 0,
    isSticky: () => true,
    subscribe: () => () => {},
    setClampBounds: () => {},
    ...overrides,
  }
  return { scroll, calls }
}

afterEach(() => {
  delete process.env.DEEPREEF_ENABLE_MOUSE
})

describe("message scrolling", () => {
  it("enables mouse tracking by default and supports explicit opt-out", () => {
    expect(isMouseTrackingEnabled()).toBe(true)
    process.env.DEEPREEF_ENABLE_MOUSE = "0"
    expect(isMouseTrackingEnabled()).toBe(false)
  })

  it("scrolls upward without restoring sticky auto-follow", () => {
    const { scroll, calls } = makeScroll()
    expect(applyMessageScrollKey(scroll, { wheelUp: true })).toBe(true)
    expect(calls).toEqual([["scrollBy", -3]])
  })

  it("keeps scrolling down while away from bottom", () => {
    const { scroll, calls } = makeScroll()
    expect(applyMessageScrollKey(scroll, { wheelDown: true })).toBe(true)
    expect(calls).toEqual([["scrollBy", 3]])
  })

  it("restores sticky auto-follow when scrolling reaches bottom", () => {
    const { scroll, calls } = makeScroll({ getScrollTop: () => 158 })
    expect(applyMessageScrollKey(scroll, { wheelDown: true })).toBe(true)
    expect(calls).toEqual([["scrollToBottom"]])
  })

  it("does not consume ordinary up arrow history navigation", () => {
    const { scroll, calls } = makeScroll()
    expect(applyMessageScrollKey(scroll, { upArrow: true })).toBe(false)
    expect(calls).toEqual([])
  })
})
