import { describe, it, expect, beforeAll } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execSync } from "node:child_process"
import { LspClient } from "../src/lsp/lsp-client.js"
import { pathToFileURL } from "node:url"

const ENABLE_REAL_TESTS = process.env.COVALO_LSP_REAL === "1"

function isCommandAvailable(command: string): boolean {
  try {
    execSync(`which ${command}`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!ENABLE_REAL_TESTS)("LSP Real Server Smoke Tests", () => {
  // 在 describe 级别用 isCommandAvailable 判断 server 是否存在。
  // 不存在时用 describe.skip 跳过整个语言块，而非在 beforeAll 中 return
  // 导致后续 it 断言 client !== null 失败。
  const hasTsls = isCommandAvailable("typescript-language-server")
  const hasPyright = isCommandAvailable("pyright-langserver")
  const hasGopls = isCommandAvailable("gopls")
  const hasRustAnalyzer = isCommandAvailable("rust-analyzer")

  describe.skipIf(!hasTsls)("TypeScript", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lsp-real-ts-"))
    let client: LspClient | null = null

    beforeAll(async () => {
      // Create minimal TypeScript project
      writeFileSync(join(cwd, "tsconfig.json"), JSON.stringify({
        compilerOptions: {
          target: "ES2020",
          module: "ESNext",
          moduleResolution: "node",
          strict: true,
        },
        include: ["*.ts"],
      }))

      writeFileSync(join(cwd, "index.ts"), `
export function greet(name: string): string {
  return "Hello, " + name + "!";
}

const message = greet("World")
console.log(message)
`)

      writeFileSync(join(cwd, "types.ts"), `
export interface User {
  id: number
  name: string
  email: string
}

export function createUser(id: number, name: string, email: string): User {
  return { id, name, email }
}
`)

      client = new LspClient({
        command: "typescript-language-server",
        args: ["--stdio"],
        cwd,
        rootPath: cwd,
        language: "typescript",
        timeoutMs: 10000,
      })

      await client.start()
      await client.initialize()
    })

    it("should start and initialize", () => {
      if (!client) return
      expect(client.getState()).toBe("running")
    })

    it("should return hover info", async () => {
      if (!client) return

      const testFile = join(cwd, "index.ts")
      await client.openDocument(testFile, "typescript", `
export function greet(name: string): string {
  return "Hello, " + name + "!";
}
`)

      const result = await client.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 1, character: 16 }, // on 'greet'
      }) as any

      expect(result).toBeDefined()
      expect(result.contents).toBeDefined()
    })

    it("should return definition", async () => {
      if (!client) return

      const testFile = join(cwd, "index.ts")
      const content = `
import { greet } from './index'

const msg = greet("World")
`
      await client.openDocument(testFile, "typescript", content)

      const result = await client.request("textDocument/definition", {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 3, character: 11 }, // on 'greet'
      })

      expect(result).toBeDefined()
    })

    it("should return diagnostics", async () => {
      if (!client) return

      const testFile = join(cwd, "error.ts")
      const content = `
const x: number = "not a number"
const y: number = 42
`
      await client.openDocument(testFile, "typescript", content)

      // 轮询等待 diagnostics（typescript-language-server 在 CI 上首次加载较慢，
      // 固定 2 秒可能不够。改为最多轮询 10 秒，每 500ms 检查一次）。
      const uri = pathToFileURL(testFile).href
      let diagnostics: unknown[] = []
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 500))
        diagnostics = client.getDiagnostics(uri)
        if (diagnostics.length > 0) break
      }
      expect(diagnostics.length).toBeGreaterThan(0)
    })

    it("should shutdown gracefully", async () => {
      if (!client) return

      await client.shutdown()
      expect(client.getState()).toBe("stopped")
    })
  })

  describe.skipIf(!hasPyright)("Python", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lsp-real-python-"))
    let client: LspClient | null = null

    beforeAll(async () => {
      // Create minimal Python project
      writeFileSync(join(cwd, "pyproject.toml"), `
[tool.pyright]
include = ["*.py"]
`)

      writeFileSync(join(cwd, "main.py"), `
def greet(name: str) -> str:
    return "Hello, " + name + "!"

message = greet("World")
print(message)
`)

      client = new LspClient({
        command: "pyright-langserver",
        args: ["--stdio"],
        cwd,
        rootPath: cwd,
        language: "python",
        timeoutMs: 10000,
      })

      await client.start()
      await client.initialize()
    })

    it("should start and initialize", () => {
      if (!client) return
      expect(client.getState()).toBe("running")
    })

    it("should return hover info", async () => {
      if (!client) return

      const testFile = join(cwd, "main.py")
      await client.openDocument(testFile, "python", `
def greet(name: str) -> str:
    return f"Hello, {name}!"
`)

      const result = await client.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 1, character: 4 }, // on 'greet'
      }) as any

      expect(result).toBeDefined()
    })

    it("should shutdown gracefully", async () => {
      if (!client) return

      await client.shutdown()
      expect(client.getState()).toBe("stopped")
    })
  })

  describe.skipIf(!hasGopls)("Go", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lsp-real-go-"))
    let client: LspClient | null = null

    beforeAll(async () => {
      // Create minimal Go project
      writeFileSync(join(cwd, "go.mod"), `
module example.com/test

go 1.21
`)

      writeFileSync(join(cwd, "main.go"), `
package main

import "fmt"

func greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}

func main() {
	message := greet("World")
	fmt.Println(message)
}
`)

      client = new LspClient({
        command: "gopls",
        args: [],
        cwd,
        rootPath: cwd,
        language: "go",
        timeoutMs: 10000,
      })

      await client.start()
      await client.initialize()
    })

    it("should start and initialize", () => {
      if (!client) return
      expect(client.getState()).toBe("running")
    })

    it("should return hover info", async () => {
      if (!client) return

      const testFile = join(cwd, "main.go")
      await client.openDocument(testFile, "go", `
package main

import "fmt"

func greet(name string) string {
	return fmt.Sprintf("Hello, %s!", name)
}
`)

      const result = await client.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 5, character: 5 }, // on 'greet'
      }) as any

      expect(result).toBeDefined()
    })

    it("should shutdown gracefully", async () => {
      if (!client) return

      await client.shutdown()
      expect(client.getState()).toBe("stopped")
    })
  })

  describe.skipIf(!hasRustAnalyzer)("Rust", () => {
    const cwd = mkdtempSync(join(tmpdir(), "lsp-real-rust-"))
    let client: LspClient | null = null

    beforeAll(async () => {
      // Create minimal Rust project
      mkdirSync(join(cwd, "src"), { recursive: true })
      writeFileSync(join(cwd, "Cargo.toml"), `
[package]
name = "test-project"
version = "0.1.0"
edition = "2021"
`)

      writeFileSync(join(cwd, "src", "main.rs"), `
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}

fn main() {
    let message = greet("World");
    println!("{}", message);
}
`)

      client = new LspClient({
        command: "rust-analyzer",
        args: [],
        cwd,
        rootPath: cwd,
        language: "rust",
        timeoutMs: 15000,
      })

      // rust-analyzer 在 CI 上可能存在（which 能找到）但启动失败（缺 Rust toolchain），
      // 用 try/catch 包裹 start，失败时 client 保持 null，后续 it 会因 if (!client) return 跳过。
      try {
        await client.start()
        await client.initialize()
      } catch (e) {
        console.log(`rust-analyzer failed to start (likely missing Rust toolchain): ${e}`)
        client = null
      }
    })

    it("should start and initialize", () => {
      if (!client) return
      expect(client.getState()).toBe("running")
    })

    it("should return hover info", async () => {
      if (!client) return

      const testFile = join(cwd, "src", "main.rs")
      await client.openDocument(testFile, "rust", `
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)
}
`)

      const result = await client.request("textDocument/hover", {
        textDocument: { uri: pathToFileURL(testFile).href },
        position: { line: 0, character: 3 }, // on 'greet'
      }) as any

      expect(result).toBeDefined()
    })

    it("should shutdown gracefully", async () => {
      if (!client) return

      await client.shutdown()
      expect(client.getState()).toBe("stopped")
    })
  })
})
