import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, mkdtempSync } from "node:fs"
import { resolve, join, dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { LastConfigSchema, RoleConfigSchema } from "./schemas/config.js"
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from "./types.js"
import type { ModelTarget } from "./model-target.js"

export type ApiKeySource = 'env' | 'project-file' | 'default' | 'none'

export interface DeepreefConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
  temperature: number
  maxContextRounds?: number
  contextWindow?: number
  provider?: string
  /** DRF-10: 项目级 ModelTarget 覆盖 */
  modelTargets?: Record<string, Partial<ModelTarget>>
}

export interface ProviderModel {
  label: string
  model: string
  contextWindow?: number
}

export interface ProviderInfo {
  baseUrl: string
  model: string
  requiresKey: boolean
  label: string
  models: ProviderModel[]
  defaultKey?: string
  contextWindow?: number
  /** Keyless providers (Kilo anonymous free tier) must send NO Authorization header */
  keyless?: boolean
}

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const MILLION_TOKEN_CONTEXT_WINDOW = 1_000_000

/** Free model display → real provider/model mapping */
export const FREE_MODEL_TARGETS: { label: string; provider: string; model: string }[] = [
  { label: 'deepseek-v4-flash-free', provider: 'zen', model: 'deepseek-v4-flash-free' },
  { label: 'mimo-v2.5-free', provider: 'zen', model: 'mimo-v2.5-free' },
  { label: 'step-3.7-flash-free', provider: 'kilo', model: 'step-3.7-flash-free' },
  { label: 'nemotron-3-super-120b-a12b-free', provider: 'kilo', model: 'nvidia/nemotron-3-super-120b-a12b:free' },
  { label: 'laguna-xs.2-free', provider: 'kilo', model: 'poolside/laguna-xs.2:free' },
]

const PROVIDER_ID_REGEX = /^[a-z][a-z0-9-]+$/

export function isValidProviderId(id: string): boolean {
  return PROVIDER_ID_REGEX.test(id)
}

function safeProviderId(id: string): boolean {
  return isValidProviderId(id) && id.length <= 32
}

export const PROVIDERS: Record<string, ProviderInfo> = {
  zen: {
    baseUrl: "https://opencode.ai/zen/v1",
    model: "deepseek-v4-flash-free",
    requiresKey: false,
    label: "Zen (Free)",
    contextWindow: MILLION_TOKEN_CONTEXT_WINDOW,
    models: [
      { label: "deepseek-v4-flash-free", model: "deepseek-v4-flash-free", contextWindow: MILLION_TOKEN_CONTEXT_WINDOW },
      { label: "mimo-v2.5-free", model: "mimo-v2.5-free", contextWindow: MILLION_TOKEN_CONTEXT_WINDOW },
    ],
    defaultKey: "public",
  },
  deepseek: {
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4",
    requiresKey: true,
    label: "DeepSeek",
    contextWindow: MILLION_TOKEN_CONTEXT_WINDOW,
    models: [
      { label: "pro", model: "deepseek-v4-pro", contextWindow: MILLION_TOKEN_CONTEXT_WINDOW },
      { label: "flash", model: "deepseek-v4-flash", contextWindow: MILLION_TOKEN_CONTEXT_WINDOW },
    ],
  },
  mimo: {
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5",
    requiresKey: true,
    label: "Mimo",
    contextWindow: MILLION_TOKEN_CONTEXT_WINDOW,
    models: [
      { label: "mimo-v2.5-pro", model: "mimo-v2.5-pro", contextWindow: MILLION_TOKEN_CONTEXT_WINDOW },
      { label: "mimo-v2.5", model: "mimo-v2.5", contextWindow: MILLION_TOKEN_CONTEXT_WINDOW },
    ],
  },
  kilo: {
    baseUrl: "https://api.kilo.ai/api/gateway/v1",
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    requiresKey: false,
    keyless: true,
    label: "Kilo (Free)",
    models: [
      { label: "Nemotron-3 Super 120B", model: "nvidia/nemotron-3-super-120b-a12b:free", contextWindow: 128_000 },
      { label: "Laguna XS 2", model: "poolside/laguna-xs.2:free", contextWindow: 128_000 },
      { label: "step-3.7-flash-free", model: "step-3.7-flash-free", contextWindow: MILLION_TOKEN_CONTEXT_WINDOW },
    ],
  },

  "openai-compatible": {
    baseUrl: "",
    model: "",
    requiresKey: false,
    keyless: true,
    label: "OpenAI Compatible (Local)",
    contextWindow: 128_000,
    models: [],
  },
  nvidia: {
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nemotron-3-super-120b-a12b",
    requiresKey: true,
    label: "NVIDIA NIM",
    contextWindow: 128_000,
    models: [
      { label: "Nemotron-3 Super 120B", model: "nvidia/nemotron-3-super-120b-a12b", contextWindow: 128_000 },
      { label: "Nemotron-3 Nano 30B", model: "nvidia/nemotron-3-nano-30b-a3b", contextWindow: 128_000 },
      { label: "Nemotron-3 Nano Omni Reasoning", model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", contextWindow: 128_000 },
      { label: "Llama 3.1 Nemotron 70B", model: "nvidia/llama-3.1-nemotron-70b-instruct", contextWindow: 128_000 },
      { label: "Llama 3.3 Nemotron Super 49B", model: "nvidia/llama-3.3-nemotron-super-49b-v1", contextWindow: 128_000 },
      { label: "Llama 3.1 Nemotron Ultra 253B", model: "nvidia/llama-3.1-nemotron-ultra-253b-v1", contextWindow: 128_000 },
    ],
  },
  qwen: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    requiresKey: true,
    label: "Qwen",
    contextWindow: 128_000,
    models: [
      { label: "Qwen-Plus", model: "qwen-plus", contextWindow: 128_000 },
      { label: "Qwen-Max", model: "qwen-max", contextWindow: 128_000 },
      { label: "Qwen-Turbo", model: "qwen-turbo", contextWindow: 1_000_000 },
      { label: "Qwen3-235B-A22B", model: "qwen3-235b-a22b", contextWindow: 128_000 },
      { label: "Qwen3-30B-A3B", model: "qwen3-30b-a3b", contextWindow: 128_000 },
    ],
  },
  kimi: {
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2",
    requiresKey: true,
    label: "Kimi",
    contextWindow: 128_000,
    models: [
      { label: "Kimi K2", model: "kimi-k2", contextWindow: 128_000 },
      { label: "Kimi K2 Turbo", model: "kimi-k2-turbo", contextWindow: 128_000 },
    ],
  },
  zai: {
    baseUrl: "https://api.stepfun.com/v1",
    model: "step-3.7-flash",
    requiresKey: true,
    label: "ZAI",
    contextWindow: 128_000,
    models: [
      { label: "Step-3.7-Flash", model: "step-3.7-flash", contextWindow: 128_000 },
      { label: "Step-3.7-Turbo", model: "step-3.7-turbo", contextWindow: 128_000 },
    ],
  },
  stepfun: {
    baseUrl: "https://api.stepfun.com/v1",
    model: "step-3.7-flash",
    requiresKey: true,
    label: "Stepfun",
    contextWindow: 128_000,
    models: [
      { label: "Step-3.7-Flash", model: "step-3.7-flash", contextWindow: 128_000 },
      { label: "Step-3.7-Turbo", model: "step-3.7-turbo", contextWindow: 128_000 },
    ],
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    requiresKey: true,
    label: "OpenAI",
    contextWindow: 128_000,
    models: [
      { label: "GPT-4o", model: "gpt-4o", contextWindow: 128_000 },
      { label: "GPT-4o-mini", model: "gpt-4o-mini", contextWindow: 128_000 },
      { label: "o3", model: "o3", contextWindow: 200_000 },
      { label: "o4-mini", model: "o4-mini", contextWindow: 200_000 },
    ],
  },
}

export function getModelContextWindow(provider: string | undefined, model: string | undefined): number {
  const providerCfg = provider ? PROVIDERS[provider] : undefined
  const modelCfg = providerCfg?.models.find((entry) => entry.model === model)
  return modelCfg?.contextWindow ?? providerCfg?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
}

function envKey(provider: string, suffix: string): string {
  return `${provider.toUpperCase().replace(/-/g, "_")}_${suffix}`
}

export function getApiKeyEnvVar(provider: string): string {
  return envKey(provider, "API_KEY")
}

function getBaseUrlEnvVar(provider: string): string {
  return envKey(provider, "BASE_URL")
}

function getModelEnvVar(provider: string): string {
  return envKey(provider, "MODEL")
}

const LAST_CONFIG_FILE = ".covalo/last-config.json"
const MODEL_TARGETS_FILE = ".covalo/model-targets.json"
const ROLE_CONFIG_FILE = ".covalo/role-config.json"

/** per-role 模型配置（worker / supervisor 各自的 provider/model/baseUrl） */
export interface RoleConfig {
  provider: string
  model: string
  baseUrl: string
}

function loadModelTargets(): Record<string, Partial<ModelTarget>> | undefined {
  try {
    const raw = readFileSync(resolve(process.cwd(), MODEL_TARGETS_FILE), "utf8")
    const parsed = JSON.parse(raw) as { targets?: Record<string, Partial<ModelTarget>> }
    return parsed.targets
  } catch {
    return undefined
  }
}

export function saveLastConfig(cfg: { provider: string; model: string; baseUrl: string }): void {
  try {
    const dir = join(process.cwd(), ".covalo")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "last-config.json"), JSON.stringify(cfg, null, 2), "utf8")
  } catch {}
}

function loadLastConfig(): { provider?: string; model?: string; baseUrl?: string } | null {
  try {
    const raw = readFileSync(resolve(process.cwd(), LAST_CONFIG_FILE), "utf8")
    const parsed = JSON.parse(raw)
    const result = LastConfigSchema["~standard"].validate(parsed)
    if (result && typeof result === "object" && "then" in result) {
      return null
    }
    if ("issues" in (result as { issues: unknown })) {
      return null
    }
    return (result as { value: { provider?: string; model?: string; baseUrl?: string } }).value
  } catch {
    return null
  }
}

/**
 * 保存单个 role 的模型配置到 role-config.json（读-改-写，保留另一个 role）。
 * apiKey 不持久化（仅 provider/model/baseUrl）。
 */
export function saveRoleConfig(role: "worker" | "supervisor", cfg: RoleConfig): void {
  try {
    const dir = join(process.cwd(), ".covalo")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const filePath = join(dir, "role-config.json")
    let existing: { worker?: RoleConfig; supervisor?: RoleConfig } = {}
    try {
      const raw = readFileSync(filePath, "utf8")
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === "object") existing = parsed
    } catch {
      // 文件不存在或损坏，从空开始
    }
    existing[role] = cfg
    writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf8")
  } catch {
    // 持久化失败不致命（与 saveLastConfig 行为一致）
  }
}

/**
 * 读取单个 role 的持久化模型配置。文件不存在或 role 缺失返回 null。
 */
export function loadRoleConfig(role: "worker" | "supervisor"): RoleConfig | null {
  try {
    const raw = readFileSync(resolve(process.cwd(), ROLE_CONFIG_FILE), "utf8")
    const parsed = JSON.parse(raw)
    const result = RoleConfigSchema["~standard"].validate(parsed)
    if (result && typeof result === "object" && "then" in result) return null
    if ("issues" in (result as { issues: unknown })) return null
    const value = (result as { value: { worker?: RoleConfig; supervisor?: RoleConfig } }).value
    const entry = value?.[role]
    if (!entry || !entry.provider || !entry.model) return null
    return { provider: entry.provider, model: entry.model, baseUrl: entry.baseUrl }
  } catch {
    return null
  }
}

const PROJECT_API_KEY_FILE = "api-key"

function parseProjectApiKeyFile(): Record<string, string> {
  const result: Record<string, string> = {}
  try {
    const p = resolve(process.cwd(), PROJECT_API_KEY_FILE)
    const raw = readFileSync(p, "utf-8")
    if (!raw) return result

    // Match all PROVIDER_API_KEY="value" lines
    for (const line of raw.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const match =
        trimmed.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)_API_KEY\s*=\s*"([^"]+)"\s*$/) ??
        trimmed.match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)_API_KEY\s*=\s*'([^']+)'\s*$/)
      if (match) {
        const providerKey = match[1].toLowerCase().replace(/_/g, "-")
        result[providerKey] = match[2]
      }
    }
    return result
  } catch {
    return result
  }
}

function apiKeyFromFile(provider: string): string | undefined {
  const all = parseProjectApiKeyFile()
  return all[provider]
}

function bareKeyFromFile(): string | undefined {
  try {
    const p = resolve(process.cwd(), PROJECT_API_KEY_FILE)
    const raw = readFileSync(p, "utf-8").trim()
    if (raw.startsWith("sk-") || raw.startsWith("ak-")) return raw
    return undefined
  } catch {
    return undefined
  }
}

export function resolveApiKey(provider: string): { value: string; source: ApiKeySource } {
  if (!safeProviderId(provider)) return { value: "", source: "none" }

  const info = PROVIDERS[provider]
  const envName = getApiKeyEnvVar(provider)
  const envVal = process.env[envName]

  // keyless providers always return empty
  if (info?.keyless) return { value: "", source: "none" }

  // 1. env var
  if (envVal) return { value: envVal, source: "env" }

  // 2. project file
  const fileVal = apiKeyFromFile(provider)
  if (fileVal) return { value: fileVal, source: "project-file" }

  // 3. bare key fallback (old format, only for the first matching provider)
  const bareVal = bareKeyFromFile()
  if (bareVal) return { value: bareVal, source: "project-file" }

  // 4. default
  if (info?.defaultKey) return { value: info.defaultKey, source: "default" }

  return { value: "", source: "none" }
}

export function listConfiguredApiKeys(): Record<string, ApiKeySource> {
  const result: Record<string, ApiKeySource> = {}
  const fileKeys = parseProjectApiKeyFile()

  for (const id of Object.keys(PROVIDERS)) {
    const info = PROVIDERS[id]
    if (info?.keyless) continue
    const envName = getApiKeyEnvVar(id)
    if (process.env[envName]) {
      result[id] = "env"
    } else if (fileKeys[id]) {
      result[id] = "project-file"
    } else if (info?.defaultKey) {
      result[id] = "default"
    }
  }

  // Check bare key in project file
  const bareVal = bareKeyFromFile()
  if (bareVal && Object.keys(result).length === 0) {
    // bare key only counts if no provider-specific keys found
  }

  return result
}

export function saveProjectApiKey(provider: string, value: string): void {
  if (!safeProviderId(provider)) throw new Error(`Invalid provider ID: ${provider}`)
  if (!value) throw new Error("API key must not be empty")

  const filePath = resolve(process.cwd(), PROJECT_API_KEY_FILE)
  const existing = parseProjectApiKeyFile()
  existing[provider] = value

  // Build new content preserving existing keys
  const lines: string[] = []
  for (const [pv, key] of Object.entries(existing)) {
    const envName = `${pv.toUpperCase().replace(/-/g, "_")}_API_KEY`
    lines.push(`${envName}="${key}"`)
  }
  const content = lines.join("\n") + "\n"

  // Atomic write: temp file + rename with unique name to prevent concurrent collisions
  const tmpDir = dirname(filePath)
  const tmpFile = join(tmpDir, `.api-key.tmp.${process.pid}.${randomUUID()}`)
  writeFileSync(tmpFile, content, "utf-8")
  try { chmodSync(tmpFile, 0o600) } catch {}
  renameSync(tmpFile, filePath)
}

export function deleteProjectApiKey(provider: string): void {
  if (!safeProviderId(provider)) return

  const filePath = resolve(process.cwd(), PROJECT_API_KEY_FILE)
  const existing = parseProjectApiKeyFile()
  delete existing[provider]

  if (Object.keys(existing).length === 0) {
    // If no keys left, remove the file entirely
    try { writeFileSync(filePath, "", "utf-8") } catch {}
    return
  }

  const lines: string[] = []
  for (const [pv, key] of Object.entries(existing)) {
    const envName = `${pv.toUpperCase().replace(/-/g, "_")}_API_KEY`
    lines.push(`${envName}="${key}"`)
  }
  const content = lines.join("\n") + "\n"

  // Atomic write with unique tmp file
  const tmpDir = dirname(filePath)
  const tmpFile = join(tmpDir, `.api-key.tmp.${process.pid}.${randomUUID()}`)
  writeFileSync(tmpFile, content, "utf-8")
  try { chmodSync(tmpFile, 0o600) } catch {}
  renameSync(tmpFile, filePath)
}

export function loadConfig(): DeepreefConfig {
  // Priority: env vars > persisted last-config > defaults
  const last = loadLastConfig()

  const provider = process.env.COVALO_PROVIDER ?? last?.provider ?? "zen"
  const providerCfg = PROVIDERS[provider]
  const lastForProvider = last?.provider === provider ? last : null

  const providerBaseUrlEnv = process.env[getBaseUrlEnvVar(provider)]
  const legacyDeepSeekBaseUrlEnv = provider === "deepseek" ? process.env.DEEPSEEK_BASE_URL : undefined
  const baseUrl = providerBaseUrlEnv ?? legacyDeepSeekBaseUrlEnv ?? lastForProvider?.baseUrl ?? providerCfg?.baseUrl ?? DEEPSEEK_BASE_URL

  const providerModelEnv = process.env[getModelEnvVar(provider)]
  const legacyDeepSeekModelEnv = provider === "deepseek" ? process.env.DEEPSEEK_MODEL : undefined
  const rawModel = providerModelEnv ?? legacyDeepSeekModelEnv ?? lastForProvider?.model ?? providerCfg?.model ?? DEEPSEEK_MODEL
  // OpenAI Compatible: allow any model name (no normalization), others validated against provider's model list
  const model = provider === "openai-compatible"
    ? (rawModel || "")
    : normalizeModelForProvider(providerCfg, rawModel)
  const contextWindow = getModelContextWindow(provider, model)

  const { value: apiKey } = resolveApiKey(provider)

  return {
    apiKey,
    baseUrl,
    model,
    maxTokens: 8192,
    temperature: 0.3,
    maxContextRounds: 20,
    contextWindow,
    provider,
    modelTargets: loadModelTargets(),
  }
}

function normalizeModelForProvider(providerCfg: ProviderInfo | undefined, model: string): string {
  if (!providerCfg || providerCfg.models.length === 0) return model
  if (providerCfg.models.some((entry) => entry.model === model)) return model
  return providerCfg.models[0]?.model ?? providerCfg.model
}
