# 自动推理强度切换设计文档

> 本文档基于代码阅读整理，记录项目中"自动切换推理强度"功能的完整设计、现有实现以及未完成的部分。

---

## 一、概述

项目中有两套独立的推理强度自动切换机制：

| 机制 | 作用范围 | 切换方式 | 当前状态 |
|------|---------|---------|:--------:|
| **Thinking Mode 切换** | 同一模型内开关推理功能 | 自动 | ✅ 完整闭环 |
| **Strategy Tier 推荐** | 换模型+调参 | 仅发出事件，需手动确认 | ⚠️ 半成品 |

两者都在 `packages/core/src/loop.ts` 的 `runLoop()` 中集成。

---

## 二、Thinking Mode 自动切换（完整实现）

### 2.1 核心文件

| 文件 | 职责 |
|------|------|
| `packages/core/src/provider-thinking.ts` | ThinkingMode 类型定义、API 参数映射 |
| `packages/core/src/mode-selector.ts` | 切换规则引擎 |
| `packages/core/src/mode-stats.ts` | 切换统计追踪 |
| `packages/core/src/loop-helpers.ts` | `evaluateModeSwitchForTurn()` 信号组装 |

### 2.2 支持的模式

```
ThinkingMode = "off" | "open" | "high" | "auto"
```

- `off` → `{ thinking: { type: "disabled" } }` — 关闭推理
- `open` → `{ thinking: { type: "enabled" } }` — 开启推理
- `high` → `{ thinking: { type: "enabled" }, reasoningEffort: "high" }` — 高强度推理
- `auto` → 初始为 `off`，启动自动切换

### 2.3 切换规则

```
SwitchSignal {
  currentMode     // 当前模式
  toolCallCount   // 本轮 tool call 数量
  textLength      // 本轮回复文本长度
  loopCount       // 当前是第几轮
  retryCount      // 连续错误次数
  hasError        // 本轮是否有错误
}
```

流程图：

```
每轮结束 (非 tool_calls 时)
  │
  ├── 紧急模式激活中?
  │     ├─ 距离上次切换 < 5 分钟 → 保持
  │     └─ ≥ 5 分钟 → 自动恢复，继续正常评估
  │
  ├── 冷却期内 (距上次切换 < 120s)?
  │     └─ 保持
  │
  ├── toolCall > 3 且 loop > 5?
  │     └─ 切换到 off (复杂工具链，减少推理开销)
  │
  ├── retry >= 2?
  │     └─ 切换到 off (退避策略)
  │
  ├── hasError?
  │     └─ 标记紧急模式，切换到 off
  │
  ├── 10 分钟内错误 >= 3 次?
  │     └─ 切换到 off (错误频率过高)
  │
  ├── toolCall <= 1 且 loop <= 2 且 text < 500?
  │     └─ 切换到 open (简单查询，开启推理)
  │
  └─ 以上都不匹配 → 保持
```

### 2.4 触发位置

`loop.ts` 第 260-270 行：

```typescript
// CL-51: Evaluate thinking mode switch before returning
if (modeSelectorState && !signal.aborted && thinkingMode === "auto") {
  const switchResult = evaluateModeSwitchForTurn(
    modeSelectorState, currentMode,
    totalToolCalls, fullContent.length,
    turnCount, consecutiveErrors, !!streamError
  )
  if (switchResult.switched) {
    currentMode = switchResult.to!
    modeSelectorState.lastSwitchTime = Date.now()
    yield { role: "status", content: "thinking_mode_switch", metadata: {...} }
  }
}
```

**触发时机：** 每轮 LLM 返回 `finish_reason: "stop"` 且无 tool_calls 时。

### 2.5 闭环状态

Thinking Mode 切换是**完整的自动闭环**：

```
规则触发 → 更新 currentMode → 下一轮 API 请求应用新模式 → 继续循环
```

无需外部干预，完全在 `runLoop()` 内部完成。

---

## 三、Strategy Tier 推荐（半成品）

### 3.1 核心文件

| 文件 | 职责 |
|------|------|
| `packages/core/src/strategy/tiers.ts` | 四个 Tier 的定义 |
| `packages/core/src/strategy/recommender.ts` | 推荐算法 |

### 3.2 四个 Tier 定义

```typescript
STRATEGY_TIERS = {
  minimal: {
    id: "minimal",
    budgetCNY: 0.01,
    recommendedModel: "deepseek-v4-flash",
    enableReasoning: false,
    temperature: 0.1,
    maxChainLength: 500,
  },
  normal: {
    id: "normal",
    budgetCNY: 0.05,
    recommendedModel: "deepseek-v4-flash",
    enableReasoning: true,
    temperature: null,
    maxChainLength: 500,
  },
  deep: {
    id: "deep",
    budgetCNY: 0.20,
    recommendedModel: "deepseek-v4-reasoner",
    enableReasoning: true,
    temperature: null,
    maxChainLength: 500,
  },
  exhaustive: {
    id: "exhaustive",
    budgetCNY: 1.00,
    recommendedModel: "deepseek-v4-reasoner",
    enableReasoning: true,
    temperature: 0.3,
    maxChainLength: 500,
  },
}
```

### 3.3 推荐规则

```typescript
recommendTier(input: RecommenderInput): TierRecommendation {
  currentIndex = TIER_ORDER.indexOf(currentTierId)
  // TIER_ORDER = ["minimal", "normal", "deep", "exhaustive"]

  1. 超预算 (totalCost > budgetCNY) 且 currentIndex > 0
     → downgrade 到 TIER_ORDER[currentIndex - 1]

  2. 接近最大轮次 (> 70%) 且 上下文高 (> 80%) 且 currentIndex < 3
     → upgrade 到 TIER_ORDER[currentIndex + 1]

  3. 工具调用多 (> 50% maxChain) 且 预算有余 (< 80%) 且 currentIndex < 3
     → upgrade

  4. 低成本 (< 15% 预算) 且 turn >= 3 且 currentIndex > 0
     → downgrade

  5. 以上都不匹配 → stay
}
```

### 3.4 触发位置

`loop.ts` 第 228-247 行：

```typescript
// ST4: Tier recommendation after tool batch
if (tier && turnCount >= 2) {
  const estimatedTokens = await ctx.estimateTokens()
  const contextUsagePercent = estimatedTokens / ctx.getContextWindow()
  const rec = recommendTier({
    currentTierId: tier.id,
    stats, turnCount,
    toolCallsThisSubmit: totalToolCalls,
    contextUsagePercent, tier,
  })
  if (rec.action !== "stay") {
    yield { role: "tier_recommendation", metadata: { recommendation: rec, ... } }
  }
}
```

**触发时机：** 第 2 轮起，每轮工具调用完成后。

### 3.5 缺失的闭环

```
现有的流程：

loop 启动
  → ST2: 根据入参 tier 设置 model/temperature（只执行一次）
  → 循环运行
    → ST4: recommendTier() 发出 upgrade/downgrade 事件
    → TUI 展示给用户
    → ❌ 没有后续动作

缺失的部分（需要补全才能实现自动换模型）:

    1. 监听 tier_recommendation 事件
    2. 中断当前 loop
    3. 更新 tier 配置（model、temperature、enableReasoning）
    4. 保留对话上下文（messages）
    5. 用新 tier 重新启动 runLoop()
```

**根本原因：** `runLoop()` 在设计上是一次性的执行单元——它在开始时读取 `tier` 入参，之后不会在运行中改变。换模型意味着需要**重启整个 loop**，这需要在 loop 外部的引擎/TUI 层面处理。

---

## 四、Loop 中的集成位置汇总

标记为 `ST2`、`ST3`、`ST4`、`CL-51` 的四处集成点：

```
runLoop() {
  // ST2: loop 开始时，根据 tier 覆写 config.model 和 config.temperature
  if (tier) {
    config.model = tier.recommendedModel
    config.temperature = tier.temperature ?? config.temperature
  }

  while (turnCount < maxTurns) {
    // ... LLM 调用 ...

    switch (finish_reason) {
      case tool_calls:
        // 执行工具
        // ST3: 发出 strategy_estimate_refined 事件
        // ST4: 推荐 tier，发出 tier_recommendation 事件
        // 继续下一轮
        break

      case stop:
        // CL-51: 评估是否切换 thinking mode（自动生效）
        if (thinkingMode === "auto") evaluateModeSwitchForTurn()
        return
    }
  }
}
```

---

## 五、关键差异总结

| 维度 | Thinking Mode 切换 | Tier 推荐 |
|------|-------------------|-----------|
| **切换什么** | 同一模型的 thinking 参数 | 换模型、调温度 |
| **自动生效** | ✅ 是 | ❌ 否，仅发出事件 |
| **评估时机** | 每轮结束（文本回复时） | 第 2 轮起，每次 tool batch 后 |
| **决策依据** | tool 数、文本长度、错误率 | 成本、上下文占比、轮次 |
| **影响范围** | API 请求参数中的 thinking 字段 | model、temperature 整组配置 |
| **能否运行时切换** | ✅ 能（改 currentMode 变量即可） | ❌ 不能（需重启 loop） |
| **测试覆盖** | ❌ 未发现专门的测试文件 | ❌ 未发现专门的测试文件 |
