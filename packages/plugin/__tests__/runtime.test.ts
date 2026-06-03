import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { PluginRuntime } from "../src/runtime.js"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("Plugin Runtime", () => {
  const tmpDir = join(tmpdir(), "plugin-runtime-test-" + Date.now())
  let pluginDir: string
  let counter = 0

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true })
    pluginDir = join(tmpDir, `runtime-${counter++}`)
    mkdirSync(pluginDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("initializes with empty config", async () => {
    mkdirSync(join(pluginDir, ".deepicode"), { recursive: true })
    writeFileSync(join(pluginDir, ".deepicode", "plugins.json"), "[]")

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".deepicode", "plugins.json"),
    })
    await runtime.init()

    const status = runtime.getStatus()
    expect(status.initialized).toBe(true)
    expect(status.loadedPlugins).toHaveLength(0)
    expect(status.tools).toHaveLength(0)
    expect(status.hooks).toHaveLength(0)
    expect(status.errors).toHaveLength(0)
  })

  it("loads plugins from config", async () => {
    const pluginPath = join(pluginDir, "my-plugin.ts")
    writeFileSync(
      pluginPath,
      `export default {
        id: "my-plugin",
        server: () => ({
          greet: (args) => "Hello, " + args.name
        })
      }`,
    )

    mkdirSync(join(pluginDir, ".deepicode"), { recursive: true })
    writeFileSync(join(pluginDir, ".deepicode", "plugins.json"), JSON.stringify([pluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".deepicode", "plugins.json"),
    })
    await runtime.init()

    const status = runtime.getStatus()
    expect(status.initialized).toBe(true)
    expect(status.loadedPlugins).toContain("my-plugin")
    expect(status.tools).toContain("my-plugin.greet")
    expect(status.errors).toHaveLength(0)
  })

  it("returns tool specs", async () => {
    const pluginPath = join(pluginDir, "my-plugin.ts")
    writeFileSync(
      pluginPath,
      `export default {
        id: "my-plugin",
        server: () => ({
          greet: (args) => "Hello, " + args.name
        })
      }`,
    )

    mkdirSync(join(pluginDir, ".deepicode"), { recursive: true })
    writeFileSync(join(pluginDir, ".deepicode", "plugins.json"), JSON.stringify([pluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".deepicode", "plugins.json"),
    })
    await runtime.init()

    const toolSpecs = runtime.getToolSpecs()
    expect(toolSpecs.length).toBe(1)
    expect(toolSpecs[0].type).toBe("function")
    expect(toolSpecs[0].function.name).toBe("my-plugin.greet")
  })

  it("gets tool by name", async () => {
    const pluginPath = join(pluginDir, "my-plugin.ts")
    writeFileSync(
      pluginPath,
      `export default {
        id: "my-plugin",
        server: () => ({
          greet: (args) => "Hello, " + args.name,
          add: (args) => args.a + args.b
        })
      }`,
    )

    mkdirSync(join(pluginDir, ".deepicode"), { recursive: true })
    writeFileSync(join(pluginDir, ".deepicode", "plugins.json"), JSON.stringify([pluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".deepicode", "plugins.json"),
    })
    await runtime.init()

    const greetTool = runtime.getTool("my-plugin.greet")
    expect(greetTool).toBeDefined()
    expect(greetTool?.name).toBe("my-plugin.greet")

    const addTool = runtime.getTool("my-plugin.add")
    expect(addTool).toBeDefined()
    expect(addTool?.name).toBe("my-plugin.add")

    const nonExistent = runtime.getTool("non-existent")
    expect(nonExistent).toBeUndefined()
  })

  it("dispose cleans up", async () => {
    const pluginPath = join(pluginDir, "my-plugin.ts")
    writeFileSync(
      pluginPath,
      `export default {
        id: "my-plugin",
        server: () => ({
          greet: (args) => "Hello, " + args.name
        })
      }`,
    )

    mkdirSync(join(pluginDir, ".deepicode"), { recursive: true })
    writeFileSync(join(pluginDir, ".deepicode", "plugins.json"), JSON.stringify([pluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".deepicode", "plugins.json"),
    })
    await runtime.init()

    const statusBefore = runtime.getStatus()
    expect(statusBefore.loadedPlugins.length).toBeGreaterThan(0)

    runtime.dispose()

    const statusAfter = runtime.getStatus()
    expect(statusAfter.initialized).toBe(false)
    expect(statusAfter.loadedPlugins).toHaveLength(0)
    expect(statusAfter.tools).toHaveLength(0)
  })

  it("handles missing config gracefully", async () => {
    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".deepicode", "nonexistent.json"),
    })
    await runtime.init()

    const status = runtime.getStatus()
    expect(status.initialized).toBe(true)
    expect(status.errors.length).toBeGreaterThan(0)
    expect(status.errors[0].type).toBe("file_not_found")
  })

  it("can be initialized only once", async () => {
    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".deepicode", "plugins.json"),
    })

    await runtime.init()
    await runtime.init() // Should be no-op

    const status = runtime.getStatus()
    expect(status.initialized).toBe(true)
  })
})
