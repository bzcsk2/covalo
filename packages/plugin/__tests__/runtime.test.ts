import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { PluginRuntime } from "../src/runtime.js"
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
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
    mkdirSync(join(pluginDir, ".covalo"), { recursive: true })
    writeFileSync(join(pluginDir, ".covalo", "plugins.json"), "[]")

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".covalo", "plugins.json"),
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

    mkdirSync(join(pluginDir, ".covalo"), { recursive: true })
    writeFileSync(join(pluginDir, ".covalo", "plugins.json"), JSON.stringify([pluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".covalo", "plugins.json"),
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

    mkdirSync(join(pluginDir, ".covalo"), { recursive: true })
    writeFileSync(join(pluginDir, ".covalo", "plugins.json"), JSON.stringify([pluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".covalo", "plugins.json"),
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

    mkdirSync(join(pluginDir, ".covalo"), { recursive: true })
    writeFileSync(join(pluginDir, ".covalo", "plugins.json"), JSON.stringify([pluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".covalo", "plugins.json"),
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

    mkdirSync(join(pluginDir, ".covalo"), { recursive: true })
    writeFileSync(join(pluginDir, ".covalo", "plugins.json"), JSON.stringify([pluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".covalo", "plugins.json"),
    })
    await runtime.init()

    const statusBefore = runtime.getStatus()
    expect(statusBefore.loadedPlugins.length).toBeGreaterThan(0)

    await runtime.dispose()

    const statusAfter = runtime.getStatus()
    expect(statusAfter.initialized).toBe(false)
    expect(statusAfter.loadedPlugins).toHaveLength(0)
    expect(statusAfter.tools).toHaveLength(0)
  })

  it("handles missing config gracefully", async () => {
    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".covalo", "nonexistent.json"),
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
      configPath: join(pluginDir, ".covalo", "plugins.json"),
    })

    await runtime.init()
    await runtime.init() // Should be no-op

    const status = runtime.getStatus()
    expect(status.initialized).toBe(true)
  })

  it("P3: dispose dispatches shutdown loop event to hookManager", async () => {
    const receivedEvents: string[] = []
    const fakeHookManager = {
      runOnLoopEvent: async (event: Record<string, unknown>) => {
        receivedEvents.push(String(event.role))
      },
      drain: async () => {},
      removeHooks: () => {},
      onHookError: undefined,
    }
    const runtime = new PluginRuntime({
      hookManager: fakeHookManager as unknown as import("@covalo/security").HookManager,
    })
    await runtime.init()
    await runtime.dispose()

    // dispose 应派发 { role: "shutdown" } 事件
    expect(receivedEvents).toContain("shutdown")
    expect(runtime.getStatus().initialized).toBe(false)
  })

  it("P3: dispose calls plugin shutdown callback when hookManager present", async () => {
    const markerPath = join(pluginDir, "shutdown-with-hooks.txt")
    const pluginPath = join(pluginDir, "plugin-with-shutdown-hooks.ts")
    writeFileSync(
      pluginPath,
      `import { writeFileSync } from "node:fs"
       export default {
         id: "plugin-with-shutdown-hooks",
         server: () => ({ greet: () => "hi" }),
         shutdown: async () => {
           writeFileSync(${JSON.stringify(markerPath)}, "called")
         }
       }`,
    )

    mkdirSync(join(pluginDir, ".covalo"), { recursive: true })
    writeFileSync(join(pluginDir, ".covalo", "plugins.json"), JSON.stringify([pluginPath]))

    const fakeHookManager = {
      addHooks: () => {},
      runOnLoopEvent: async () => {},
      drain: async () => {},
      removeHooks: () => {},
      onHookError: undefined,
    }
    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".covalo", "plugins.json"),
      hookManager: fakeHookManager as unknown as import("@covalo/security").HookManager,
    })

    await runtime.init()
    await runtime.dispose()

    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, "utf8")).toBe("called")
  })

  it("P3: dispose calls plugin shutdown callback even without hookManager", async () => {
    const markerPath = join(pluginDir, "shutdown-no-hooks.txt")
    const pluginPath = join(pluginDir, "plugin-with-shutdown-no-hooks.ts")
    writeFileSync(
      pluginPath,
      `import { writeFileSync } from "node:fs"
       export default {
         id: "plugin-with-shutdown-no-hooks",
         server: () => ({ greet: () => "hi" }),
         shutdown: async () => {
           writeFileSync(${JSON.stringify(markerPath)}, "called")
         }
       }`,
    )

    mkdirSync(join(pluginDir, ".covalo"), { recursive: true })
    writeFileSync(join(pluginDir, ".covalo", "plugins.json"), JSON.stringify([pluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".covalo", "plugins.json"),
    })

    await runtime.init()
    await runtime.dispose()

    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, "utf8")).toBe("called")
  })

  it("P3: plugin shutdown error does not block other plugins or cleanup", async () => {
    const markerPath = join(pluginDir, "shutdown-after-error.txt")
    const badPluginPath = join(pluginDir, "bad-plugin.ts")
    const goodPluginPath = join(pluginDir, "good-plugin.ts")
    writeFileSync(
      badPluginPath,
      `export default {
         id: "bad-plugin",
         server: () => ({ greet: () => "hi" }),
         shutdown: () => { throw new Error("boom") }
       }`,
    )
    writeFileSync(
      goodPluginPath,
      `import { writeFileSync } from "node:fs"
       export default {
         id: "good-plugin",
         server: () => ({ greet: () => "hi" }),
         shutdown: async () => {
           writeFileSync(${JSON.stringify(markerPath)}, "called")
         }
       }`,
    )

    mkdirSync(join(pluginDir, ".covalo"), { recursive: true })
    writeFileSync(join(pluginDir, ".covalo", "plugins.json"), JSON.stringify([badPluginPath, goodPluginPath]))

    const runtime = new PluginRuntime({
      workspaceRoot: pluginDir,
      configPath: join(pluginDir, ".covalo", "plugins.json"),
    })

    await runtime.init()
    await runtime.dispose()

    // bad-plugin 抛错后 good-plugin 仍应被执行
    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, "utf8")).toBe("called")
    // 清理仍完成
    expect(runtime.getStatus().initialized).toBe(false)
  })
})
