import { pluginSource, type PluginConfigItem } from "./config.js"

export interface PluginHooks {
  [key: string]: (...args: unknown[]) => unknown
}

export interface PluginServer {
  (...args: unknown[]): PluginHooks | Promise<PluginHooks>
}

export interface PluginModule {
  id: string
  server: PluginServer
  [key: string]: unknown
}

export interface PluginLoaded extends PluginConfigItem {
  mod: PluginModule
  hooks?: PluginHooks
}

export type PluginLoadError =
  | { type: "import_failed"; spec: string; cause: string }
  | { type: "missing_id"; spec: string }
  | { type: "server_not_function"; spec: string }
  | { type: "server_threw"; spec: string; cause: string }
  | { type: "hooks_not_object"; spec: string }
  | { type: "duplicate_id"; id: string; spec: string }
  | { type: "load_error"; spec: string; cause: string }

export interface PluginLoadResult {
  loaded: PluginLoaded[]
  errors: PluginLoadError[]
}

async function importPlugin(spec: string): Promise<{ mod: unknown; error?: string }> {
  try {
    const mod = await import(spec)
    const exported = mod.default ?? mod
    return { mod: exported }
  } catch (e) {
    return { mod: null, error: e instanceof Error ? e.message : String(e) }
  }
}

function isHooksObject(value: unknown): value is PluginHooks {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (typeof record[key] !== "function") return false
  }
  return true
}

async function callServer(
  server: PluginServer,
  spec: string,
): Promise<{ hooks?: PluginHooks; error?: PluginLoadError }> {
  try {
    const result = await server()
    if (!isHooksObject(result)) {
      return { error: { type: "hooks_not_object", spec } }
    }
    return { hooks: result }
  } catch (e) {
    return { error: { type: "server_threw", spec, cause: e instanceof Error ? e.message : String(e) } }
  }
}

function validatePlugin(mod: unknown, spec: string): { plugin?: PluginModule; error?: PluginLoadError } {
  if (!mod || typeof mod !== "object") {
    return { error: { type: "import_failed", spec, cause: "Module is not an object" } }
  }

  const record = mod as Record<string, unknown>

  if (typeof record.id !== "string" || !record.id) {
    return { error: { type: "missing_id", spec } }
  }

  if (typeof record.server !== "function") {
    return { error: { type: "server_not_function", spec } }
  }

  // P3: 保留原模块对象而非只构造 { id, server }，使 plugin 上声明的
  // shutdown 等额外字段能被 PluginRuntime.dispose() 调用到。
  return { plugin: record as unknown as PluginModule }
}

export async function loadPlugins(items: PluginConfigItem[]): Promise<PluginLoadResult> {
  const loaded: PluginLoaded[] = []
  const errors: PluginLoadError[] = []
  const seenIds = new Set<string>()

  for (const item of items) {
    if (item.source === "npm") {
      errors.push({ type: "import_failed", spec: item.spec, cause: "npm_plugin_not_installed" })
      continue
    }

    const { mod, error: importError } = await importPlugin(item.spec)
    if (importError) {
      errors.push({ type: "import_failed", spec: item.spec, cause: importError })
      continue
    }

    const { plugin, error: validateError } = validatePlugin(mod, item.spec)
    if (validateError) {
      errors.push(validateError)
      continue
    }

    if (seenIds.has(plugin!.id)) {
      errors.push({ type: "duplicate_id", id: plugin!.id, spec: item.spec })
      continue
    }

    seenIds.add(plugin!.id)

    const { hooks, error: serverError } = await callServer(plugin!.server, item.spec)
    if (serverError) {
      errors.push(serverError)
      continue
    }

    loaded.push({ ...item, mod: plugin!, hooks })
  }

  return { loaded, errors }
}
