import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"
import { DEEPSEEK_BASE_URL, DEEPSEEK_MODEL } from "./types.js"

export interface DeepicodeConfig {
  apiKey: string
  baseUrl: string
  model: string
  maxTokens: number
  temperature: number
  maxContextRounds?: number
  contextWindow?: number
  provider?: string
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
  /** Virtual providers (Free Auto) do not have a real base URL — routing is handled internally */
  virtual?: boolean
}

export const DEFAULT_CONTEXT_WINDOW = 128_000
export const MILLION_TOKEN_CONTEXT_WINDOW = 1_000_000

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
    ],
  },
  "free-auto": {
    baseUrl: "",
    model: "free-auto",
    requiresKey: false,
    keyless: true,
    virtual: true,
    label: "Free Auto",
    models: [
      { label: "Free Auto", model: "free-auto" },
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

const LAST_CONFIG_FILE = ".deepicode/last-config.json"

export function saveLastConfig(cfg: { provider: string; model: string; baseUrl: string }): void {
  try {
    const dir = join(process.cwd(), ".deepicode")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "last-config.json"), JSON.stringify(cfg, null, 2), "utf8")
  } catch {}
}

function loadLastConfig(): { provider?: string; model?: string; baseUrl?: string } | null {
  try {
    const raw = readFileSync(resolve(process.cwd(), LAST_CONFIG_FILE), "utf8")
    return JSON.parse(raw) as { provider?: string; model?: string; baseUrl?: string }
  } catch {
    return null
  }
}

function loadApiKeyFromProjectFile(provider?: string): string | undefined {
  try {
    const p = resolve(process.cwd(), "api-key")
    const raw = readFileSync(p, "utf-8")

    // Try provider-specific env var (e.g. DEEPSEEK_API_KEY, ZEN_API_KEY, MIMO_API_KEY)
    const providers = provider ? [provider.toUpperCase().replace(/-/g, "_")] : ["DEEPSEEK", "ZEN", "MIMO", "KILO", "NVIDIA"]
    for (const pv of providers) {
      const envName = `${pv}_API_KEY`
      const match =
        raw.match(new RegExp(`^\\s*export\\s+${envName}\\s*=\\s*"([^"]+)"\\s*$`, "m")) ??
        raw.match(new RegExp(`^\\s*export\\s+${envName}\\s*=\\s*'([^']+)'\\s*$`, "m")) ??
        raw.match(new RegExp(`^\\s*${envName}\\s*=\\s*"([^"]+)"\\s*$`, "m")) ??
        raw.match(new RegExp(`^\\s*${envName}\\s*=\\s*'([^']+)'\\s*$`, "m"))
      const key = match?.[1]?.trim()
      if (key) return key
    }

    const bareKey = raw.trim()
    if (bareKey.startsWith("sk-") || bareKey.startsWith("ak-")) {
      return bareKey
    }

    return undefined
  } catch {
    return undefined
  }
}

export function loadConfig(): DeepicodeConfig {
  // Priority: env vars > persisted last-config > defaults
  const last = loadLastConfig()

  const provider = process.env.DEEPICODE_PROVIDER ?? last?.provider ?? "zen"
  const providerCfg = PROVIDERS[provider]
  const lastForProvider = last?.provider === provider ? last : null

  const providerBaseUrlEnv = process.env[getBaseUrlEnvVar(provider)]
  const legacyDeepSeekBaseUrlEnv = provider === "deepseek" ? process.env.DEEPSEEK_BASE_URL : undefined
  const baseUrl = (providerCfg?.virtual)
    ? ""
    : (providerBaseUrlEnv ?? legacyDeepSeekBaseUrlEnv ?? lastForProvider?.baseUrl ?? providerCfg?.baseUrl ?? DEEPSEEK_BASE_URL)

  const providerModelEnv = process.env[getModelEnvVar(provider)]
  const legacyDeepSeekModelEnv = provider === "deepseek" ? process.env.DEEPSEEK_MODEL : undefined
  const rawModel = providerModelEnv ?? legacyDeepSeekModelEnv ?? lastForProvider?.model ?? providerCfg?.model ?? DEEPSEEK_MODEL
  // OpenAI Compatible: allow any model name (no normalization), others validated against provider's model list
  const model = provider === "openai-compatible"
    ? (rawModel || "")
    : normalizeModelForProvider(providerCfg, rawModel)
  const contextWindow = getModelContextWindow(provider, model)

  // Keyless providers (Kilo/LLM7/Free Auto/OpenAI Compatible) always use empty API key
  let apiKey = ""
  if (providerCfg?.keyless) {
    apiKey = ""
  } else {
    const apiKeyEnvVar = getApiKeyEnvVar(provider)
    apiKey = process.env[apiKeyEnvVar] ?? providerCfg?.defaultKey ?? ""
    if (!apiKey) {
      apiKey = loadApiKeyFromProjectFile(provider) ?? ""
    }
  }

  return {
    apiKey,
    baseUrl,
    model,
    maxTokens: 8192,
    temperature: 0.3,
    maxContextRounds: 20,
    contextWindow,
    provider,
  }
}

function normalizeModelForProvider(providerCfg: ProviderInfo | undefined, model: string): string {
  if (!providerCfg || providerCfg.models.length === 0) return model
  if (providerCfg.models.some((entry) => entry.model === model)) return model
  return providerCfg.models[0]?.model ?? providerCfg.model
}
