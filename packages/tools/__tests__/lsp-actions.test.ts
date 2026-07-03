import { describe, it, expect, beforeEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { createLspTool } from "../src/lsp.js"
import { pathToFileURL, fileURLToPath } from "node:url"

const fakeLspPath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-lsp.mjs")

const ctx = {
  cwd: mkdtempSync(join(tmpdir(), "lsp-actions-test-")),
  sessionId: "test-session",
  signal: new AbortController().signal,
  invokeTool: async (name: string, args: Record<string, unknown>) => ({ content: JSON.stringify({ name, args }), isError: false }),
  delegateTask: async (task: string, agent: string, files: string[]) => JSON.stringify({ task, agent, files }),
} as any

describe("LSP Actions", () => {
  beforeEach(() => {
    mkdirSync(join(ctx.cwd, ".covalo"), { recursive: true })
    writeFileSync(join(ctx.cwd, ".covalo", "lsp.json"), JSON.stringify({
      languages: {
        typescript: { command: process.execPath, args: [fakeLspPath] },
      },
    }))
  })

  describe("hover", () => {
    it("should return hover info", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "hover", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("hover")
      expect(p.items).toBeDefined()
      expect(p.items[0].contents).toBe("fake hover")
    })

    it("should handle missing line/column", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "hover", file_path: "test.ts" }, ctx)
      expect(r.isError).toBe(false)
    })
  })

  describe("definition", () => {
    it("should return definition", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "definition", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("definition")
      expect(p.items).toBeDefined()
    })

    it("should support goToDefinition alias", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "goToDefinition", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("definition")
    })
  })

  describe("declaration", () => {
    it("should return declaration", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "declaration", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("declaration")
    })
  })

  describe("type_definition", () => {
    it("should return type definition", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "type_definition", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("type_definition")
    })
  })

  describe("implementation", () => {
    it("should return implementation", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "implementation", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("implementation")
    })

    it("should support goToImplementation alias", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "goToImplementation", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("implementation")
    })
  })

  describe("references", () => {
    it("should return references", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "references", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("references")
      expect(p.items).toBeDefined()
      expect(p.items.length).toBe(2)
    })

    it("should support findReferences alias", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "findReferences", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("references")
    })
  })

  describe("document_symbols", () => {
    it("should return document symbols", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "document_symbols", file_path: "test.ts" }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("document_symbols")
      expect(p.items).toBeDefined()
      expect(p.items.length).toBe(2)
    })

    it("should support documentSymbol alias", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "documentSymbol", file_path: "test.ts" }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("document_symbols")
    })
  })

  describe("workspace_symbols", () => {
    it("should return workspace symbols", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "workspace_symbols", file_path: "test.ts", query: "" }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("workspace_symbols")
    })

    it("should support workspaceSymbol alias", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "workspaceSymbol", file_path: "test.ts", query: "" }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("workspace_symbols")
    })

    it("should require query parameter", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "workspace_symbols", file_path: "test.ts" }, ctx)
      expect(r.isError).toBe(true)
      const p = JSON.parse(r.content as string)
      expect(p.error).toContain("query is required")
    })
  })

  describe("completion", () => {
    it("should return completion items", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "completion", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("completion")
      expect(p.items).toBeDefined()
      expect(p.items.length).toBe(2)
    })
  })

  describe("signature_help", () => {
    it("should return signature help", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({ action: "signature_help", file_path: "test.ts", line: 0, column: 6 }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("signature_help")
      expect(p.items).toBeDefined()
      expect(p.items[0].kind).toBe("signatureHelp")
    })
  })

  describe("rename_preview", () => {
    it("should return rename preview", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({
        action: "rename_preview",
        file_path: "test.ts",
        line: 0,
        column: 6,
        new_name: "y",
      }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("rename_preview")
      expect(p.items).toBeDefined()
      expect(p.items[0].kind).toBe("workspaceEdit")
    })

    it("should require new_name parameter", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({
        action: "rename_preview",
        file_path: "test.ts",
        line: 0,
        column: 6,
      }, ctx)
      expect(r.isError).toBe(true)
      const p = JSON.parse(r.content as string)
      expect(p.error).toContain("new_name is required")
    })

    it("should require line and column parameters", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.ts"), "const x = 42")
      const r = await tool.execute({
        action: "rename_preview",
        file_path: "test.ts",
        new_name: "y",
      }, ctx)
      expect(r.isError).toBe(true)
      const p = JSON.parse(r.content as string)
      expect(p.error).toContain("line and column are required")
    })
  })

  describe("server_status", () => {
    it("should return server status", async () => {
      const tool = createLspTool()
      const r = await tool.execute({ action: "server_status", file_path: "test.ts" }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("server_status")
    })
  })

  describe("restart_server", () => {
    it("should return restart server status", async () => {
      const tool = createLspTool()
      const r = await tool.execute({ action: "restart_server", file_path: "test.ts" }, ctx)
      expect(r.isError).toBe(false)
      const p = JSON.parse(r.content as string)
      expect(p.status).toBe("ok")
      expect(p.action).toBe("restart_server")
    })
  })

  describe("error handling", () => {
    it("should reject invalid action", async () => {
      const tool = createLspTool()
      const r = await tool.execute({ action: "invalid_action", file_path: "test.ts" }, ctx)
      expect(r.isError).toBe(true)
      const p = JSON.parse(r.content as string)
      expect(p.error).toContain("Unsupported LSP action")
    })

    it("should reject missing action", async () => {
      const tool = createLspTool()
      const r = await tool.execute({ file_path: "test.ts" }, ctx)
      expect(r.isError).toBe(true)
      const p = JSON.parse(r.content as string)
      expect(p.error).toContain("action is required")
    })

    it("should reject missing file_path", async () => {
      const tool = createLspTool()
      const r = await tool.execute({ action: "hover" }, ctx)
      expect(r.isError).toBe(true)
      const p = JSON.parse(r.content as string)
      expect(p.error).toContain("file_path is required")
    })

    it("should reject non-existent file", async () => {
      const tool = createLspTool()
      const r = await tool.execute({ action: "hover", file_path: "nonexistent.ts" }, ctx)
      expect(r.isError).toBe(true)
      const p = JSON.parse(r.content as string)
      expect(p.error).toContain("File not found")
    })

    it("should reject unknown language", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.xyz"), "content")
      const r = await tool.execute({ action: "hover", file_path: "test.xyz" }, ctx)
      expect(r.isError).toBe(true)
      const p = JSON.parse(r.content as string)
      expect(p.error).toContain("Cannot infer language")
    })

    it("should return install hint for language without server", async () => {
      const tool = createLspTool()
      writeFileSync(join(ctx.cwd, "test.rb"), "x = 42")
      const r = await tool.execute({ action: "hover", file_path: "test.rb" }, ctx)
      expect(r.isError).toBe(true)
      const p = JSON.parse(r.content as string)
      expect(p.message).toContain("LSP server not found")
      expect(p.installHint).toBeUndefined()
    })
  })
})
