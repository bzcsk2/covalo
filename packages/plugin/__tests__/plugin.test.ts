import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { readPluginConfig } from "../src/config.js"
import { loadPlugins } from "../src/loader.js"
import { mkdirSync, writeFileSync, unlinkSync, rmSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

describe("Plugin Config", () => {
  const tmpDir = join(tmpdir(), "plugin-config-test-" + Date.now())
  let configPath: string

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true })
    configPath = join(tmpDir, "plugins.json")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reads relative path plugins", () => {
    writeFileSync(configPath, JSON.stringify(["./my-plugin.ts"]))
    const result = readPluginConfig(configPath)
    expect(result.items.length).toBe(1)
    expect(result.items[0].source).toBe("file")
    expect(result.items[0].spec).toContain("my-plugin.ts")
  })

  it("reads absolute path plugins", () => {
    writeFileSync(configPath, JSON.stringify(["/absolute/path/plugin.ts"]))
    const result = readPluginConfig(configPath)
    expect(result.items.length).toBe(1)
    expect(result.items[0].spec).toBe("/absolute/path/plugin.ts")
  })

  it("reads file:// URL plugins", () => {
    writeFileSync(configPath, JSON.stringify([pathToFileURL(join(tmpDir, "plugin.ts")).href]))
    const result = readPluginConfig(configPath)
    expect(result.items.length).toBe(1)
    expect(result.items[0].spec).toContain("plugin.ts")
  })

  it("skips disabled plugins", () => {
    writeFileSync(configPath, JSON.stringify([{ spec: "./plugin.ts", options: { enabled: false } }]))
    const result = readPluginConfig(configPath)
    expect(result.items.length).toBe(0)
  })

  it("returns error for missing config file", () => {
    const result = readPluginConfig("/nonexistent/plugins.json")
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("file_not_found")
  })

  it("returns error for malformed JSON", () => {
    writeFileSync(configPath, "not json")
    const result = readPluginConfig(configPath)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("malformed_json")
  })

  it("returns error for non-array config", () => {
    writeFileSync(configPath, JSON.stringify({ not: "array" }))
    const result = readPluginConfig(configPath)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("malformed_json")
  })

  it("returns error for duplicate specs", () => {
    writeFileSync(configPath, JSON.stringify(["./plugin.ts", "./plugin.ts"]))
    const result = readPluginConfig(configPath)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("duplicate_spec")
  })

  it("returns error for npm plugin not installed", () => {
    writeFileSync(configPath, JSON.stringify(["some-npm-plugin"]))
    const result = readPluginConfig(configPath)
    expect(result.items.length).toBe(1)
    expect(result.items[0].source).toBe("npm")
  })

  it("supports tuple format with options", () => {
    writeFileSync(configPath, JSON.stringify([["./plugin.ts", { option1: "value1" }]]))
    const result = readPluginConfig(configPath)
    expect(result.items.length).toBe(1)
    expect(result.items[0].options.option1).toBe("value1")
  })

  it("supports object format with spec and options", () => {
    writeFileSync(configPath, JSON.stringify([{ spec: "./plugin.ts", options: { option1: "value1" } }]))
    const result = readPluginConfig(configPath)
    expect(result.items.length).toBe(1)
    expect(result.items[0].options.option1).toBe("value1")
  })
})

describe("Plugin Loader", () => {
  const tmpDir = join(tmpdir(), "plugin-loader-test-" + Date.now())
  let pluginPath: string
  let counter = 0

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true })
    pluginPath = join(tmpDir, `test-plugin-${counter++}.ts`)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("loads a valid plugin with hooks", async () => {
    writeFileSync(
      pluginPath,
      `export default {
        id: "test-plugin",
        server: () => ({ hook1: () => "result1", hook2: () => "result2" })
      }`,
    )
    const result = await loadPlugins([{ spec: pluginPath, options: {}, source: "file", deprecated: false }])
    expect(result.loaded.length).toBe(1)
    expect(result.loaded[0].mod.id).toBe("test-plugin")
    expect(result.loaded[0].hooks).toBeDefined()
    expect(typeof result.loaded[0].hooks!.hook1).toBe("function")
    expect(typeof result.loaded[0].hooks!.hook2).toBe("function")
    expect(result.errors.length).toBe(0)
  })

  it("rejects plugin without id", async () => {
    writeFileSync(
      pluginPath,
      `export default {
        server: () => ({ hooks: {} })
      }`,
    )
    const result = await loadPlugins([{ spec: pluginPath, options: {}, source: "file", deprecated: false }])
    expect(result.loaded.length).toBe(0)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("missing_id")
  })

  it("rejects plugin with non-function server", async () => {
    writeFileSync(
      pluginPath,
      `export default {
        id: "test-plugin",
        server: "not a function"
      }`,
    )
    const result = await loadPlugins([{ spec: pluginPath, options: {}, source: "file", deprecated: false }])
    expect(result.loaded.length).toBe(0)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("server_not_function")
  })

  it("rejects plugin when server throws", async () => {
    writeFileSync(
      pluginPath,
      `export default {
        id: "test-plugin",
        server: () => { throw new Error("server failed") }
      }`,
    )
    const result = await loadPlugins([{ spec: pluginPath, options: {}, source: "file", deprecated: false }])
    expect(result.loaded.length).toBe(0)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("server_threw")
  })

  it("rejects plugin when server returns non-object", async () => {
    writeFileSync(
      pluginPath,
      `export default {
        id: "test-plugin",
        server: () => "not an object"
      }`,
    )
    const result = await loadPlugins([{ spec: pluginPath, options: {}, source: "file", deprecated: false }])
    expect(result.loaded.length).toBe(0)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("hooks_not_object")
  })

  it("rejects plugin when server returns object with non-function values", async () => {
    writeFileSync(
      pluginPath,
      `export default {
        id: "test-plugin",
        server: () => ({ hook1: "not a function" })
      }`,
    )
    const result = await loadPlugins([{ spec: pluginPath, options: {}, source: "file", deprecated: false }])
    expect(result.loaded.length).toBe(0)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("hooks_not_object")
  })

  it("rejects duplicate plugin ids", async () => {
    const pluginPath2 = join(tmpDir, `test-plugin-dup-${counter++}.ts`)
    writeFileSync(
      pluginPath,
      `export default {
        id: "test-plugin",
        server: () => ({ hook1: () => "result1" })
      }`,
    )
    writeFileSync(
      pluginPath2,
      `export default {
        id: "test-plugin",
        server: () => ({ hook2: () => "result2" })
      }`,
    )
    const result = await loadPlugins([
      { spec: pluginPath, options: {}, source: "file", deprecated: false },
      { spec: pluginPath2, options: {}, source: "file", deprecated: false },
    ])
    expect(result.loaded.length).toBe(1)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("duplicate_id")
  })

  it("skips npm plugins with error", async () => {
    const result = await loadPlugins([{ spec: "some-npm-plugin", options: {}, source: "npm", deprecated: false }])
    expect(result.loaded.length).toBe(0)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("import_failed")
    expect(result.errors[0].cause).toBe("npm_plugin_not_installed")
  })

  it("handles import errors gracefully", async () => {
    const result = await loadPlugins([
      { spec: "/nonexistent/plugin.ts", options: {}, source: "file", deprecated: false },
    ])
    expect(result.loaded.length).toBe(0)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0].type).toBe("import_failed")
  })

  it("loads multiple plugins in order", async () => {
    const pluginPath2 = join(tmpDir, `test-plugin-multi-${counter++}.ts`)
    writeFileSync(
      pluginPath,
      `export default {
        id: "plugin-1",
        server: () => ({ hook1: () => "result1" })
      }`,
    )
    writeFileSync(
      pluginPath2,
      `export default {
        id: "plugin-2",
        server: () => ({ hook2: () => "result2" })
      }`,
    )
    const result = await loadPlugins([
      { spec: pluginPath, options: {}, source: "file", deprecated: false },
      { spec: pluginPath2, options: {}, source: "file", deprecated: false },
    ])
    expect(result.loaded.length).toBe(2)
    expect(result.loaded[0].mod.id).toBe("plugin-1")
    expect(result.loaded[1].mod.id).toBe("plugin-2")
    expect(result.errors.length).toBe(0)
  })
})
