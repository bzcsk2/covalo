export interface ModelPricing {
  inputPer1K: number
  outputPer1K: number
  cacheReadPer1K: number
  cacheWritePer1K: number
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  "deepseek-v4-pro": { inputPer1K: 0.002, outputPer1K: 0.008, cacheReadPer1K: 0.0001, cacheWritePer1K: 0.0005 },
  "deepseek-v4-flash": { inputPer1K: 0.0005, outputPer1K: 0.002, cacheReadPer1K: 0.00005, cacheWritePer1K: 0.0002 },
  "deepseek-v4-flash-free": { inputPer1K: 0, outputPer1K: 0, cacheReadPer1K: 0, cacheWritePer1K: 0 },
  "mimo-v2.5-pro": { inputPer1K: 0.001, outputPer1K: 0.004, cacheReadPer1K: 0.00005, cacheWritePer1K: 0.0002 },
  "mimo-v2.5": { inputPer1K: 0.0008, outputPer1K: 0.003, cacheReadPer1K: 0.00004, cacheWritePer1K: 0.00015 },
  "mimo-v2.5-free": { inputPer1K: 0, outputPer1K: 0, cacheReadPer1K: 0, cacheWritePer1K: 0 },
  "zen-free": { inputPer1K: 0, outputPer1K: 0, cacheReadPer1K: 0, cacheWritePer1K: 0 },
}

export function calculateCost(model: string, promptTokens: number, completionTokens: number, cacheHitTokens = 0, cacheMissTokens = 0): number {
  const pricing = MODEL_PRICING[model]
  if (!pricing) return 0
  // DeepSeek API prompt_tokens includes cache_hit_tokens + cache_miss_tokens.
  // Subtract them to avoid double-counting, then add back at their specific rates.
  const nonCachePrompt = Math.max(0, promptTokens - cacheHitTokens - cacheMissTokens)
  const cost =
    (nonCachePrompt / 1000) * pricing.inputPer1K +
    (completionTokens / 1000) * pricing.outputPer1K +
    (cacheHitTokens / 1000) * pricing.cacheReadPer1K +
    (cacheMissTokens / 1000) * pricing.cacheWritePer1K
  return cost
}

// Phase 2.2: 以下函数已删除（无生产调用方）：
// - USD_TO_CNY
// - calculateCostCNY
// - getPricing
// 详见 docs/unintegrated_code_audit_20260703.md §3.9。
