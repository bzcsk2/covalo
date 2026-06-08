import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { PROVIDERS, getApiKeyEnvVar, getModelContextWindow, loadConfig, saveLastConfig } from "../src/config.js"
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

describe("PROVIDERS", () => {
  it("should have zen provider with defaultKey", () => {
    const zen = PROVIDERS.zen
    expect(zen).toBeDefined()
    expect(zen.defaultKey).toBe("public")
    expect(zen.requiresKey).toBe(false)
    expect(zen.label).toBe("Zen (Free)")
    expect(zen.model).toBe("deepseek-v4-flash-free")
    expect(zen.models.map((entry) => entry.model)).toEqual(["deepseek-v4-flash-free", "mimo-v2.5-free"])
    expect(zen.models.every((entry) => entry.contextWindow === 1_000_000)).toBe(true)
  })

  it("should have deepseek provider without defaultKey", () => {
    const ds = PROVIDERS.deepseek
    expect(ds).toBeDefined()
    expect(ds.requiresKey).toBe(true)
    expect(ds.defaultKey).toBeUndefined()
  })

  it("should have mimo provider", () => {
    const mimo = PROVIDERS.mimo
    expect(mimo).toBeDefined()
    expect(mimo.models).toHaveLength(2)
  })

  it("should resolve model-specific context windows", () => {
    expect(getModelContextWindow("zen", "deepseek-v4-flash-free")).toBe(1_000_000)
    expect(getModelContextWindow("deepseek", "deepseek-v4-pro")).toBe(1_000_000)
    expect(getModelContextWindow("mimo", "mimo-v2.5")).toBe(1_000_000)
    expect(getModelContextWindow("unknown", "custom")).toBe(128_000)
  })
})

describe("getApiKeyEnvVar", () => {
  it("should return ZEN_API_KEY for zen", () => {
    expect(getApiKeyEnvVar("zen")).toBe("ZEN_API_KEY")
  })

  it("should return DEEPSEEK_API_KEY for deepseek", () => {
    expect(getApiKeyEnvVar("deepseek")).toBe("DEEPSEEK_API_KEY")
  })
})


describe("loadConfig - 环境变量", () => {
  const OLD_ENV = { ...process.env }
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "deepicode-config-"))
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir)
    delete process.env.DEEPICODE_PROVIDER
    delete process.env.DEEPSEEK_MODEL
    delete process.env.DEEPSEEK_BASE_URL
    delete process.env.ZEN_MODEL
    delete process.env.ZEN_BASE_URL
  })

  afterEach(() => {
    process.env = { ...OLD_ENV }
    vi.restoreAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should use DEEPICODE_PROVIDER env var to override provider", () => {
    process.env.DEEPICODE_PROVIDER = "mimo"
    const cfg = loadConfig()
    expect(cfg.provider).toBe("mimo")
    expect(cfg.baseUrl).toContain("mimo")
  })

  it("should use ZEN_API_KEY env var when provider is zen", () => {
    process.env.DEEPICODE_PROVIDER = "zen"
    process.env.ZEN_API_KEY = "zen-key-from-env"
    const cfg = loadConfig()
    expect(cfg.provider).toBe("zen")
    expect(cfg.apiKey).toBe("zen-key-from-env")
  })

  it("should use DEEPSEEK_API_KEY env var for deepseek", () => {
    process.env.DEEPICODE_PROVIDER = "deepseek"
    process.env.DEEPSEEK_API_KEY = "ds-key-from-env"
    const cfg = loadConfig()
    expect(cfg.provider).toBe("deepseek")
    expect(cfg.apiKey).toBe("ds-key-from-env")
  })

  it("should fall back to defaultKey for zen when no env var set", () => {
    process.env.DEEPICODE_PROVIDER = "zen"
    delete process.env.ZEN_API_KEY
    const cfg = loadConfig()
    expect(cfg.apiKey).toBe("public")
    expect(cfg.model).toBe("deepseek-v4-flash-free")
  })

  it("should use provider-specific model and base URL env vars for zen", () => {
    process.env.DEEPICODE_PROVIDER = "zen"
    process.env.ZEN_MODEL = "mimo-v2.5-free"
    process.env.ZEN_BASE_URL = "https://opencode.ai/zen/v1"

    const cfg = loadConfig()
    expect(cfg.provider).toBe("zen")
    expect(cfg.model).toBe("mimo-v2.5-free")
    expect(cfg.baseUrl).toBe("https://opencode.ai/zen/v1")
  })

  it("should not let legacy DeepSeek env vars override zen", () => {
    process.env.DEEPICODE_PROVIDER = "zen"
    process.env.DEEPSEEK_MODEL = "deepseek-v4-flash"
    process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com"

    const cfg = loadConfig()
    expect(cfg.provider).toBe("zen")
    expect(cfg.model).toBe("deepseek-v4-flash-free")
    expect(cfg.baseUrl).toBe("https://opencode.ai/zen/v1")
  })

  it("should default to zen provider when no env and no last-config", () => {
    delete process.env.DEEPICODE_PROVIDER
    const cfg = loadConfig()
    expect(cfg.provider).toBe("zen")
    expect(cfg.model).toBe("deepseek-v4-flash-free")
    expect(cfg.apiKey).toBe("public")
    expect(cfg.contextWindow).toBe(1_000_000)
  })
})

describe("saveLastConfig / loadConfig 持久化", () => {
  const OLD_ENV = { ...process.env }
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "deepicode-config-"))
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir)
    delete process.env.DEEPICODE_PROVIDER
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.ZEN_API_KEY
    delete process.env.DEEPSEEK_MODEL
    delete process.env.DEEPSEEK_BASE_URL
    delete process.env.ZEN_MODEL
    delete process.env.ZEN_BASE_URL
  })

  afterEach(() => {
    process.env = { ...OLD_ENV }
    vi.restoreAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("should persist provider/model/baseUrl and restore them via loadConfig", () => {
    saveLastConfig({ provider: "mimo", model: "mimo-v2.5", baseUrl: "https://api.mimo.ai/v1" })

    const configPath = join(tmpDir, ".deepicode", "last-config.json")
    expect(existsSync(configPath)).toBe(true)
    const saved = JSON.parse(readFileSync(configPath, "utf8"))
    expect(saved.provider).toBe("mimo")
    expect(saved.model).toBe("mimo-v2.5")

    const cfg = loadConfig()
    expect(cfg.provider).toBe("mimo")
    expect(cfg.model).toBe("mimo-v2.5")
    expect(cfg.baseUrl).toBe("https://api.mimo.ai/v1")
  })

  it("should normalize stale zen-free last-config model", () => {
    saveLastConfig({ provider: "zen", model: "zen-free", baseUrl: "https://opencode.ai/zen/v1" })

    const cfg = loadConfig()
    expect(cfg.provider).toBe("zen")
    expect(cfg.model).toBe("deepseek-v4-flash-free")
    expect(cfg.baseUrl).toBe("https://opencode.ai/zen/v1")
    expect(cfg.apiKey).toBe("public")
  })

  it("should ignore last-config from a different provider when env provider is set", () => {
    saveLastConfig({ provider: "deepseek", model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com" })
    process.env.DEEPICODE_PROVIDER = "zen"

    const cfg = loadConfig()
    expect(cfg.provider).toBe("zen")
    expect(cfg.model).toBe("deepseek-v4-flash-free")
    expect(cfg.baseUrl).toBe("https://opencode.ai/zen/v1")
  })

  it("should return defaults when last-config file does not exist", () => {
    const cfg = loadConfig()
    expect(cfg.provider).toBe("zen")
    expect(cfg.baseUrl).toBe("https://opencode.ai/zen/v1")
    expect(cfg.model).toBe("deepseek-v4-flash-free")
    expect(cfg.apiKey).toBe("public")
  })

  it("should not crash when last-config file is corrupted JSON", () => {
    const dir = join(tmpDir, ".deepicode")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "last-config.json"), "{invalid json!!!}", "utf8")

    const cfg = loadConfig()
    expect(cfg.provider).toBe("zen")
  })

  it("should not crash when last-config file is empty", () => {
    const dir = join(tmpDir, ".deepicode")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "last-config.json"), "", "utf8")

    const cfg = loadConfig()
    expect(cfg.provider).toBe("zen")
  })

  describe("kilo", () => {
    it("should have correct config", () => {
      const kilo = PROVIDERS.kilo
      expect(kilo).toBeDefined()
      expect(kilo.label).toBe("Kilo (Free)")
      expect(kilo.baseUrl).toBe("https://api.kilo.ai/api/gateway/v1")
      expect(kilo.requiresKey).toBe(false)
      expect(kilo.keyless).toBe(true)
      expect(kilo.models).toHaveLength(2)
      expect(kilo.models[0]!.model).toBe("nvidia/nemotron-3-super-120b-a12b:free")
      expect(kilo.models[1]!.model).toBe("poolside/laguna-xs.2:free")
    })
  })

  describe("nvidia", () => {
    it("should have correct config", () => {
      const nv = PROVIDERS.nvidia
      expect(nv).toBeDefined()
      expect(nv.label).toBe("NVIDIA NIM")
      expect(nv.baseUrl).toBe("https://integrate.api.nvidia.com/v1")
      expect(nv.requiresKey).toBe(true)
      expect(nv.models).toHaveLength(6)
      expect(nv.models[0]!.model).toBe("nvidia/nemotron-3-super-120b-a12b")
    })
  })

  describe("free-auto", () => {
    it("should be virtual and keyless", () => {
      const fa = PROVIDERS["free-auto"]
      expect(fa).toBeDefined()
      expect(fa.label).toBe("Free Auto")
      expect(fa.virtual).toBe(true)
      expect(fa.keyless).toBe(true)
      expect(fa.baseUrl).toBe("")
      expect(fa.requiresKey).toBe(false)
    })
  })

  describe("openai-compatible", () => {
    it("should have correct config", () => {
      const oac = PROVIDERS["openai-compatible"]
      expect(oac).toBeDefined()
      expect(oac.label).toBe("OpenAI Compatible (Local)")
      expect(oac.keyless).toBe(true)
      expect(oac.requiresKey).toBe(false)
      expect(oac.models).toHaveLength(0)
    })

    it("should allow any model name", () => {
      process.env.DEEPICODE_PROVIDER = "openai-compatible"
      process.env.OPENAI_COMPATIBLE_MODEL = "my-custom-model"
      process.env.OPENAI_COMPATIBLE_BASE_URL = "http://localhost:8080/v1"
      const cfg = loadConfig()
      expect(cfg.provider).toBe("openai-compatible")
      expect(cfg.model).toBe("my-custom-model")
      expect(cfg.apiKey).toBe("")
      expect(cfg.baseUrl).toBe("http://localhost:8080/v1")
      delete process.env.DEEPICODE_PROVIDER
      delete process.env.OPENAI_COMPATIBLE_MODEL
      delete process.env.OPENAI_COMPATIBLE_BASE_URL
    })
  })

  describe("loadConfig with keyless providers", () => {
    it("should handle kilo without API key", () => {
      process.env.DEEPICODE_PROVIDER = "kilo"
      const cfg = loadConfig()
      expect(cfg.provider).toBe("kilo")
      expect(cfg.apiKey).toBe("")
      delete process.env.DEEPICODE_PROVIDER
    })

    it("should handle free-auto as virtual provider", () => {
      process.env.DEEPICODE_PROVIDER = "free-auto"
      const cfg = loadConfig()
      expect(cfg.provider).toBe("free-auto")
      expect(cfg.apiKey).toBe("")
      expect(cfg.baseUrl).toBe("")
      delete process.env.DEEPICODE_PROVIDER
    })
  })
})
