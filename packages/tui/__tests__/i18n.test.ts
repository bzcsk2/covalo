import { describe, it, expect } from "bun:test"
import { dicts, setLocale, getLocale, t } from "../src/i18n/index.js"
import type { Strings } from "../src/i18n/strings.js"

describe("i18n dicts", () => {
  it("exports both locales", () => {
    expect(dicts.en).toBeDefined()
    expect(dicts["zh-CN"]).toBeDefined()
  })

  it("every key in strings.ts has a translation in both locales", () => {
    const enKeys = Object.keys(dicts.en) as (keyof Strings)[]
    const zhKeys = Object.keys(dicts["zh-CN"]) as (keyof Strings)[]
    expect(enKeys.length).toBe(zhKeys.length)
    // TypeScript ensures they match at compile time; runtime check:
    for (const k of enKeys) {
      expect(zhKeys).toContain(k)
    }
  })
})

describe("setLocale / getLocale", () => {
  it("has a valid default", () => {
    expect(["en", "zh-CN"]).toContain(getLocale())
  })

  it("round-trips locale", () => {
    setLocale("zh-CN")
    expect(getLocale()).toBe("zh-CN")
    setLocale("en")
    expect(getLocale()).toBe("en")
  })
})

describe("t() returns current locale strings", () => {
  it("returns English strings when locale is en", () => {
    setLocale("en")
    expect(t().cmdExit).toBe("exit")
    expect(t().statusSectionStatus).toBe("STATUS")
  })

  it("returns Chinese strings when locale is zh-CN", () => {
    setLocale("zh-CN")
    expect(t().cmdExit).toBe("退出")
    expect(t().statusSectionStatus).toBe("状态")
  })

  it("function-valued keys are callable", () => {
    setLocale("en")
    const loaded = t().loadedSkills(5)
    expect(loaded).toContain("5")
  })
})
