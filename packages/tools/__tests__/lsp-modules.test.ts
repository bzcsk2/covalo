import { describe, it, expect } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readLspConfig, normalizeConfig, getLanguageConfig, getRequestTimeout, getIdleTimeout, getInstallHint, DEFAULT_LSP_CONFIG } from "../src/lsp/config.js"
import { inferLanguage, getFileExtensions, LANGUAGE_EXTENSIONS } from "../src/lsp/language.js"
import {
  normalizeLocation,
  normalizeLocationArray,
  normalizeHover,
  normalizeDiagnostics,
  normalizeCompletion,
  normalizeDocumentSymbols,
  normalizeWorkspaceSymbols,
  normalizeRenameEdit,
  normalizeSignatureHelp,
  formatNormalizedItems,
} from "../src/lsp/normalize.js"

describe("LSP Config", () => {
  const cwd = mkdtempSync(join(tmpdir(), "lsp-config-test-"))

  it("should return default config when no config file exists", async () => {
    const result = await readLspConfig(cwd)
    expect(result.config.version).toBe(1)
    expect(result.config.languages?.typescript).toBeDefined()
    expect(result.config.languages?.python).toBeDefined()
    expect(result.configPath).toBeNull()
  })

  it("should read config from .covalo/lsp.json", async () => {
    mkdirSync(join(cwd, ".covalo"), { recursive: true })
    writeFileSync(join(cwd, ".covalo", "lsp.json"), JSON.stringify({
      version: 1,
      languages: {
        typescript: { command: "typescript-language-server", args: ["--stdio"] },
      },
    }))
    const result = await readLspConfig(cwd)
    expect(result.config.languages?.typescript?.command).toBe("typescript-language-server")
  })

  it("should normalize config with defaults", () => {
    const config = normalizeConfig({})
    expect(config.version).toBe(1)
    expect(config.requestTimeoutMs).toBe(8000)
    expect(config.idleTimeoutMs).toBe(300000)
  })

  it("should clamp config values to valid ranges", () => {
    const config = normalizeConfig({ requestTimeoutMs: 100, idleTimeoutMs: 500000 })
    expect(config.requestTimeoutMs).toBe(1000)
    expect(config.idleTimeoutMs).toBe(500000)
  })

  it("should get language config", () => {
    const config = {
      languages: {
        typescript: { command: "typescript-language-server", args: ["--stdio"] },
      },
    }
    expect(getLanguageConfig(config, "typescript")?.command).toBe("typescript-language-server")
    expect(getLanguageConfig(config, "python")).toBeUndefined()
  })

  it("should get request timeout from config", () => {
    expect(getRequestTimeout({})).toBe(8000)
    expect(getRequestTimeout({ requestTimeoutMs: 5000 })).toBe(5000)
  })

  it("should get idle timeout from config", () => {
    expect(getIdleTimeout({})).toBe(300000)
    expect(getIdleTimeout({ idleTimeoutMs: 600000 })).toBe(600000)
  })

  it("should return install hints for known languages", () => {
    expect(getInstallHint("typescript")).toContain("npm")
    expect(getInstallHint("python")).toContain("pip")
    expect(getInstallHint("go")).toContain("go install")
    expect(getInstallHint("rust")).toContain("rustup")
  })
})

describe("LSP Language", () => {
  it("should infer TypeScript from .ts", () => {
    expect(inferLanguage("file.ts")).toBe("typescript")
    expect(inferLanguage("file.tsx")).toBe("typescriptreact")
    expect(inferLanguage("file.mts")).toBe("typescript")
  })

  it("should infer JavaScript from .js", () => {
    expect(inferLanguage("file.js")).toBe("javascript")
    expect(inferLanguage("file.jsx")).toBe("javascriptreact")
    expect(inferLanguage("file.mjs")).toBe("javascript")
  })

  it("should infer Python from .py", () => {
    expect(inferLanguage("file.py")).toBe("python")
    expect(inferLanguage("file.pyi")).toBe("python")
  })

  it("should infer Go from .go", () => {
    expect(inferLanguage("file.go")).toBe("go")
  })

  it("should infer Rust from .rs", () => {
    expect(inferLanguage("file.rs")).toBe("rust")
  })

  it("should infer JSON from .json", () => {
    expect(inferLanguage("file.json")).toBe("json")
    expect(inferLanguage("file.jsonc")).toBe("json")
  })

  it("should return empty string for unknown extensions", () => {
    expect(inferLanguage("file.xyz")).toBe("")
    expect(inferLanguage("file.unknown")).toBe("")
  })

  it("should get file extensions for language", () => {
    const tsExtensions = getFileExtensions("typescript")
    expect(tsExtensions).toContain(".ts")
    expect(tsExtensions).toContain(".mts")
  })
})

describe("LSP Normalize", () => {
  describe("normalizeLocation", () => {
    it("should normalize Location with uri and range", () => {
      const result = normalizeLocation({
        uri: "file:///path/to/file.ts",
        range: { start: { line: 10, character: 5 }, end: { line: 10, character: 15 } },
      })
      expect(result).toEqual({
        kind: "location",
        file: "/path/to/file.ts",
        range: { start: { line: 10, column: 5 }, end: { line: 10, column: 15 } },
      })
    })

    it("should normalize Location with preview", () => {
      const result = normalizeLocation({
        uri: "file:///path/to/file.ts",
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        preview: "export function foo()",
      })
      expect(result?.preview).toBe("export function foo()")
    })

    it("should return null for invalid input", () => {
      expect(normalizeLocation(null)).toBeNull()
      expect(normalizeLocation(undefined)).toBeNull()
      expect(normalizeLocation("string")).toBeNull()
    })
  })

  describe("normalizeLocationArray", () => {
    it("should normalize array of locations", () => {
      const result = normalizeLocationArray([
        { uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
        { uri: "file:///b.ts", range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
      ])
      expect(result).toHaveLength(2)
      expect(result[0].file).toBe("/a.ts")
      expect(result[1].file).toBe("/b.ts")
    })

    it("should limit to 50 items", () => {
      const items = Array(100).fill({ uri: "file:///a.ts", range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } })
      const result = normalizeLocationArray(items)
      expect(result).toHaveLength(50)
    })
  })

  describe("normalizeHover", () => {
    it("should normalize Hover with string contents", () => {
      const result = normalizeHover({ contents: "string type" })
      expect(result).toEqual({ kind: "hover", contents: "string type" })
    })

    it("should normalize Hover with MarkedString", () => {
      const result = normalizeHover({ contents: { kind: "markdown", value: "**bold**" } })
      expect(result).toEqual({ kind: "hover", contents: "**bold**" })
    })

    it("should return null for invalid input", () => {
      expect(normalizeHover(null)).toBeNull()
      expect(normalizeHover({})).toBeNull()
    })
  })

  describe("normalizeDiagnostics", () => {
    it("should normalize diagnostics array", () => {
      const result = normalizeDiagnostics([
        { uri: "file:///a.ts", range: { start: { line: 0, character: 0 } }, severity: 1, message: "Error" },
        { uri: "file:///b.ts", range: { start: { line: 1, character: 5 } }, severity: 2, message: "Warning" },
      ])
      expect(result).toHaveLength(2)
      expect(result[0].severity).toBe("error")
      expect(result[1].severity).toBe("warning")
    })

    it("should map severity correctly", () => {
      const result = normalizeDiagnostics([
        { uri: "file:///a.ts", range: { start: { line: 0, character: 0 } }, severity: 1, message: "Error" },
        { uri: "file:///a.ts", range: { start: { line: 0, character: 0 } }, severity: 2, message: "Warning" },
        { uri: "file:///a.ts", range: { start: { line: 0, character: 0 } }, severity: 3, message: "Info" },
        { uri: "file:///a.ts", range: { start: { line: 0, character: 0 } }, severity: 4, message: "Hint" },
      ])
      expect(result[0].severity).toBe("error")
      expect(result[1].severity).toBe("warning")
      expect(result[2].severity).toBe("info")
      expect(result[3].severity).toBe("hint")
    })
  })

  describe("normalizeCompletion", () => {
    it("should normalize completion items", () => {
      const result = normalizeCompletion({
        items: [
          { label: "foo", detail: "function", kind: 3 },
          { label: "bar", detail: "variable", kind: 13 },
        ],
      })
      expect(result).toHaveLength(2)
      expect(result[0].label).toBe("foo")
      expect(result[0].detail).toBe("function")
    })

    it("should handle completion without items wrapper", () => {
      const result = normalizeCompletion([
        { label: "foo", detail: "function" },
      ])
      expect(result).toHaveLength(1)
      expect(result[0].label).toBe("foo")
    })
  })

  describe("normalizeDocumentSymbols", () => {
    it("should normalize document symbols", () => {
      const result = normalizeDocumentSymbols([
        { name: "Foo", kind: 5, location: { uri: "file:///a.ts", range: { start: { line: 0, character: 0 } } } },
        { name: "bar", kind: 12, location: { uri: "file:///a.ts", range: { start: { line: 1, character: 0 } } } },
      ])
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe("Foo")
      expect(result[0].kindLabel).toBe("class")
      expect(result[1].kindLabel).toBe("function")
    })
  })

  describe("normalizeWorkspaceSymbols", () => {
    it("should normalize workspace symbols", () => {
      const result = normalizeWorkspaceSymbols({
        symbols: [
          { name: "Foo", kind: 5, location: { uri: "file:///a.ts", range: { start: { line: 0, character: 0 } } } },
        ],
      })
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe("Foo")
    })
  })

  describe("normalizeRenameEdit", () => {
    it("should normalize rename edit with changes", () => {
      const result = normalizeRenameEdit({
        changes: { "file:///a.ts": [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "bar" }] },
      })
      expect(result).not.toBeNull()
      expect(result?.kind).toBe("workspaceEdit")
    })

    it("should return null for invalid input", () => {
      expect(normalizeRenameEdit(null)).toBeNull()
      expect(normalizeRenameEdit({})).toBeNull()
    })
  })

  describe("normalizeSignatureHelp", () => {
    it("should normalize signature help", () => {
      const result = normalizeSignatureHelp({
        activeSignature: 0,
        activeParameter: 1,
        signatures: [
          { label: "foo(a: string, b: number)", parameters: [{ label: [0, 10] }, { label: [12, 20] }] },
        ],
      })
      expect(result).not.toBeNull()
      expect(result?.activeSignature).toBe(0)
      expect(result?.activeParameter).toBe(1)
      expect(result?.signatures).toHaveLength(1)
    })

    it("should return null for invalid input", () => {
      expect(normalizeSignatureHelp(null)).toBeNull()
      expect(normalizeSignatureHelp({})).toBeNull()
    })
  })

  describe("formatNormalizedItems", () => {
    it("should format empty items", () => {
      expect(formatNormalizedItems([])).toBe("No results")
    })

    it("should format items", () => {
      const result = formatNormalizedItems([{ kind: "hover", contents: "test" }])
      expect(result).toContain("hover")
      expect(result).toContain("test")
    })
  })
})
