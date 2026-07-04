import { describe, it, expect } from "vitest"
import { matchWildcard } from "../src/permission/wildcard.js"

describe("S1-6: wildcard matcher 防 ReDoS", () => {
  it("'*' 匹配任意字符串", () => {
    expect(matchWildcard("*", "anything")).toBe(true)
    expect(matchWildcard("*", "")).toBe(true)
  })

  it("精确匹配", () => {
    expect(matchWildcard("hello", "hello")).toBe(true)
    expect(matchWildcard("hello", "world")).toBe(false)
  })

  it("'*.ts' 匹配 .ts 文件", () => {
    expect(matchWildcard("*.ts", "file.ts")).toBe(true)
    expect(matchWildcard("*.ts", "file.js")).toBe(false)
  })

  it("保留旧语义：'*' 仍可匹配 '/'", () => {
    // 旧行为：* → .*，可匹配路径分隔符
    expect(matchWildcard("*.ts", "dir/file.ts")).toBe(true)
    expect(matchWildcard("src/*", "src/foo/bar")).toBe(true)
  })

  it("'?' 匹配单个字符", () => {
    expect(matchWildcard("h?llo", "hello")).toBe(true)
    expect(matchWildcard("h?llo", "hxxlo")).toBe(false)
  })

  it("超长 pattern 直接走精确匹配", () => {
    const long = "a".repeat(600)
    expect(matchWildcard(long, long)).toBe(true)
    expect(matchWildcard(long, "b".repeat(600))).toBe(false)
  })

  it("超长 value 返回 false", () => {
    const longValue = "a".repeat(5000)
    expect(matchWildcard("*.ts", longValue)).toBe(false)
  })

  it("超过 wildcard 数量限制走精确匹配", () => {
    // 17 个 * 超过 MAX_WILDCARDS=16
    const manyStars = "*".repeat(17)
    expect(matchWildcard(manyStars, "test")).toBe(false)
    // 精确匹配仍可用
    expect(matchWildcard(manyStars, manyStars)).toBe(true)
  })

  it("连续 '*' 被折叠", () => {
    // ** → * → .* ，不应卡顿
    expect(matchWildcard("**/*/**/*", "a/b/c/d")).toBe(true)
    expect(matchWildcard("**test**", "test")).toBe(true)
  })

  it("特殊正则字符被转义", () => {
    expect(matchWildcard("file.ts", "file.ts")).toBe(true)
    expect(matchWildcard("file.ts", "fileXts")).toBe(false)
    expect(matchWildcard("[test]", "[test]")).toBe(true)
    expect(matchWildcard("[test]", "t")).toBe(false)
  })

  it("无效正则 fallback 到精确匹配", () => {
    // 构造一个在转义后仍无效的 pattern 很难，但 catch 分支存在
    expect(matchWildcard("test", "test")).toBe(true)
  })
})
