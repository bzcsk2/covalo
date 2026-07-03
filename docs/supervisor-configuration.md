# Supervisor 候选池配置

最后更新：2026-07-03。

本文件说明 Covalo Supervisor 候选池的配置方法。Supervisor 是弱模型监督机制的核心组件，用于在 Worker 执行过程中提供 plan、review 和 intervene 能力。

## 设计原则

**ADV-HAR-04 不变性**：所有 Supervisor 候选默认禁用。用户必须显式创建 `.covalo/supervisor-pool.json` 才能启用任何 Supervisor 网络请求。未配置时不发起任何 Supervisor 调用，Worker 单独运行。

这是出于以下考虑：

- **成本控制**：Supervisor 调用会产生额外 LLM 网络请求和费用
- **可选性**：并非所有工作流都需要 Supervisor 监督
- **安全默认**：避免在用户不知情的情况下发起额外网络请求

## 配置文件

### 文件位置

```
<workspace>/.covalo/supervisor-pool.json
```

文件不存在时返回空池（无候选），Supervisor 不启用。文件解析失败时同样返回空池（容错降级）。

### 配置格式

```json
{
  "candidates": [
    {
      "id": "zen-deepseek",
      "target": "supervisor.zen-free",
      "priority": 100,
      "capabilities": {
        "structuredJson": true,
        "reasoningText": true,
        "maxEvidenceTokens": 8192
      },
      "costClass": "free",
      "enabled": true
    }
  ]
}
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 候选唯一标识符 |
| `target` | string | ModelTarget ID（对应 `model-target.ts` 中定义的目标） |
| `priority` | number | 优先级，越高越优先 |
| `capabilities.structuredJson` | boolean | 是否支持结构化 JSON 输出 |
| `capabilities.reasoningText` | boolean | 是否支持 reasoning 文本 |
| `capabilities.maxEvidenceTokens` | number | 单次 evidence 输入 token 上限（正整数） |
| `costClass` | `"free"` \| `"free-tier"` \| `"paid"` | 成本类别 |
| `enabled` | boolean | 是否启用。**默认所有候选必须为 false**，用户显式设为 true 才生效 |

### 合并规则

用户配置与默认池按 ID 合并：

- 用户文件中同 ID 条目**覆盖**默认条目
- 默认池中未覆盖的条目**保留**
- 用户可添加默认池中没有的新 ID

## 默认候选池

Covalo 内置 3 个默认候选，**全部默认禁用**：

| ID | Target | Priority | structuredJson | reasoningText | costClass | enabled |
|----|--------|----------|----------------|---------------|-----------|---------|
| `zen-deepseek` | `supervisor.zen-free` | 100 | true | true | free | false |
| `zen-mimo` | `supervisor.mimo-free` | 90 | true | true | free | false |
| `stepfun-3.5` | `supervisor.stepfun` | 50 | false | true | free-tier | false |

启用某个候选时，需要在 `model-target.ts` 或用户配置中定义对应的 `target`（如 `supervisor.zen-free`），否则 Supervisor 调用会因找不到 target 而失败。

## 启用 Supervisor 的步骤

1. **确认目标已配置**：在 Covalo 配置中定义 Supervisor 用的 ModelTarget（provider + model + API key）
2. **创建配置文件**：在工作目录下创建 `.covalo/supervisor-pool.json`
3. **设置 enabled: true**：将需要启用的候选的 `enabled` 字段设为 `true`
4. **验证配置**：运行 `covalo doctor`（如果可用）或启动 TUI 查看 Supervisor 状态

## 示例：启用单个候选

```json
{
  "candidates": [
    {
      "id": "zen-deepseek",
      "target": "supervisor.zen-free",
      "priority": 100,
      "capabilities": {
        "structuredJson": true,
        "reasoningText": true,
        "maxEvidenceTokens": 8192
      },
      "costClass": "free",
      "enabled": true
    }
  ]
}
```

此配置会覆盖默认池中 `zen-deepseek` 的 `enabled: false`，其余默认候选仍保持禁用。

## 示例：添加自定义候选

```json
{
  "candidates": [
    {
      "id": "my-custom-supervisor",
      "target": "supervisor.my-model",
      "priority": 200,
      "capabilities": {
        "structuredJson": true,
        "reasoningText": false,
        "maxEvidenceTokens": 4096
      },
      "costClass": "paid",
      "enabled": true
    }
  ]
}
```

此配置会添加一个新的候选 `my-custom-supervisor`，默认池中的 3 个候选仍保留（但全部禁用）。

## 诊断工具

`packages/core/src/supervisor/smoke.ts` 提供诊断函数（需 `COVALO_SUPERVISOR_SMOKE=1` 环境变量才生效）：

- `runSupervisorSmokeTest` — 单个候选的连通性测试
- `runSupervisorPoolSmokeTests` — 整个候选池的连通性测试
- `isSupervisorSmokeEnabled` — 检查是否启用 smoke test

这些函数生产从不调用，保留 export 供未来 CLI doctor 命令使用。

## 相关代码

| 文件 | 作用 |
|------|------|
| [packages/core/src/supervisor/pool.ts](../packages/core/src/supervisor/pool.ts) | 候选池定义、加载、合并、校验 |
| [packages/core/src/supervisor/smoke.ts](../packages/core/src/supervisor/smoke.ts) | 诊断工具（需环境变量启用） |
| [packages/core/src/model-target.ts](../packages/core/src/model-target.ts) | ModelTarget 定义（Supervisor target 需在此配置） |

## 设计依据

- **DRF-51**：Supervisor 候选必须由用户显式配置为具体 provider/model target；不得使用虚拟自动路由 target
- **ADV-HAR-04**：所有候选默认禁用，用户必须显式配置才能启用
