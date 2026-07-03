# Self-Harness 与自我进化功能现状审计

**审计日期**：2026-07-03
**审计范围**：`packages/core/src/harness-evolution/`、`packages/cli/src/commands/harness.ts`、`packages/core/src/engine.ts`、`packages/core/src/streaming-executor.ts`、`packages/core/src/eval/runner.ts`
**审计方法**：代码静态分析 + 调用链验证 + grep 验证

---

## 一、总体结论

Covalo 项目中存在一个结构完整、测试覆盖良好的 "harness-evolution"（自我进化）模块，设计灵感来自 FuguNano。但需要严格区分两个集成层次：

| 层次 | 状态 | 说明 |
|---|---|---|
| **A. Packet 系统（证据包）** | 完全接入运行时 | `engine.ts` / `streaming-executor.ts` / `eval/runner.ts` 都在主循环中真实创建并落盘 packet |
| **B. Self-Harness 进化闭环（mine→propose→validate→promote）** | 仅 CLI 手动触发 | `runSelfHarness()` 和 `BoundedRepairLoop` 在生产代码中从未被自动调用 |
| **C. 自动修复循环（BoundedRepairLoop）** | 完全未接入 | 代码完整但生产代码从不实例化 |

这是**部分设计意图**（见 `docs/FuguNano.md` 第 107-108、968 行明确将"把 self-harness 放进每一次用户任务的在线主循环"列为 Non-Goal），但 `BoundedRepairLoop` 完全不接入、CLI 命令不发射 observability 事件、validate 命令不跑真实 eval——这些更像是实现尚未达到设计文档预期的完整度。

---

## 二、文件位置全景

### 主模块树：`packages/core/src/harness-evolution/`

```
harness-evolution/
├── index.ts                          # 统一导出
├── observability.ts                  # 事件名常量（11 个事件）
├── event-emitter.ts
├── repair-loop.ts                    # BoundedRepairLoop（生产未接入）
├── packets/                          # 7 类 typed evidence packets
│   ├── types.ts
│   ├── task-digest.ts
│   ├── review-packet.ts
│   ├── incident-packet.ts
│   ├── recovery-packet.ts
│   ├── runtime-guard.ts
│   ├── action-certificate.ts
│   └── packet-store.ts               # JSONL append-only 持久化
├── self-harness/                     # 自我进化核心
│   ├── index.ts
│   ├── patch-schema.ts               # HarnessSurface / HarnessPatchPacket 类型
│   ├── patch-proposer.ts             # PatchProposer 类
│   ├── patch-validator.ts            # PatchValidator 类
│   ├── promotion-gate.ts             # evaluatePromotion / buildValidationResult
│   ├── lineage-store.ts              # LineageStore 类（lineage.jsonl）
│   └── self-harness-loop.ts          # runSelfHarness() 主入口
├── experience/                       # 经验记忆
│   ├── experience-types.ts
│   ├── experience-store.ts           # ExperienceStore（experiences.jsonl）
│   ├── weakness-miner.ts             # mineFromIncidents / mineFromReview
│   ├── recall-policy.ts
│   └── index.ts
├── outcomes/                         # P2: 模型产出记录
│   ├── model-outcome.ts
│   ├── outcome-store.ts
│   └── index.ts
├── loop/
│   └── deterministic-gates.ts        # anyGateFailed / constrainVerdictWithGates
└── surfaces/
    ├── surface-store.ts              # SurfaceStore（默认内容嵌入在 TS 中）
    ├── index.ts
    └── defaults/                     # 11 个 .md 文件（仅作文档参考，代码不读取）
        ├── supervisor-system-prompt.md
        ├── worker-system-prompt.md
        ├── task-digest-template.md
        ├── review-rubric.md
        ├── incident-taxonomy.md
        ├── recovery-playbook.md
        ├── context-selection-policy.md
        ├── tool-use-policy.md
        ├── eval-gate-policy.md
        ├── memory-recall-policy.md
        └── runtime-guard-policy.md
```

### 入口点与集成点

| 文件 | 角色 |
|---|---|
| `packages/cli/src/commands/harness.ts` | **CLI 入口**：`covalo harness doctor/mine/propose/validate/promote/history/rollback` |
| `packages/cli/src/index.ts` (line 83-88) | CLI 路由：把 `harness` 子命令分发给 `harnessCommand` |
| `packages/tui/src/App.tsx` (line 726-772) | TUI `/harness` 命令：严格度切换直接生效；mine/propose 等子命令显式路由到 CLI（提示"在终端中运行"） |
| `packages/tui/src/commands.ts` (line 65-82) | TUI 命令解析：识别 `/harness` 子命令 |
| `packages/core/src/engine.ts` (line 1070-1369) | **运行时集成主战场**：在 `submit()` 中创建并落盘 TaskDigest/RuntimeGuard/Review/Incident/Recovery packets |
| `packages/core/src/streaming-executor.ts` (line 288-320) | **运行时集成**：对 bash/shell/exec 创建 ActionCertificate，落盘到 `.covalo/harness/certificates/` |
| `packages/core/src/eval/runner.ts` (line 440-904) | **Eval 集成**：完整 packet 管线在 eval 流程中运行 |
| `packages/core/src/index.ts` (line 755, 782, 820-826) | 公开导出 harness-evolution API |

---

## 三、能否正常运作：分层评估

### 3.1 ✅ 证据收集（Packet 系统）— 能正常运作

每次用户任务都在真实收集证据，无需任何手动干预。

| 功能 | 位置 | 状态 |
|---|---|---|
| TaskDigest 创建 | `engine.ts` submit 开始时 | ✅ 每次 submit 都执行 |
| RuntimeGuard 拦截 | `engine.ts` guard disposition=block 时提前 return | ✅ 真实阻断 |
| ActionCertificate 记录 | `streaming-executor.ts` 对中/高风险 bash 命令 | ✅ 真实落盘 |
| Review/Incident/Recovery packets | `engine.ts` post-loop | ✅ 失败时创建 |
| Packet 持久化 | `.covalo/runs/<runId>/packets.jsonl` | ✅ 正常写入 |
| Eval runner 管线 | `eval/runner.ts` | ✅ 完整运行 |

### 3.2 ⚠️ 手动进化（CLI）— 部分能运作

通过 `covalo harness` CLI 命令手动执行，**生产代码从不自动调用**。

| 步骤 | CLI 命令 | 状态 | 问题 |
|---|---|---|---|
| mine | `covalo harness mine` | ✅ 正常挖掘 weakness | — |
| propose | `covalo harness propose` | ✅ 正常生成 patch | — |
| validate | `covalo harness validate` | ⚠️ 不完整 | **只做完整性校验，不跑真实 held-in/held-out eval**（`harness.ts:256` 注释明确说明） |
| promote | `covalo harness promote` | ⚠️ 需 `--force` | **没有真实 eval 结果时必须用 `--force` 绕过 promotion gate**（`harness.ts:347-348`），等于绕开了核心安全机制 |

另外 CLI 命令**不发射任何 observability 事件**（`harness.self.*` 系列事件已定义在 `observability.ts` 但从未被调用，grep `logger|emit|observability|HARNESS_EVENT` 在 `harness.ts` 中无匹配）。

### 3.3 ❌ 自动修复（BoundedRepairLoop）— 完全未接入

`BoundedRepairLoop` 定义了完整的状态机（maxRounds、keepBest），但：

- `BoundedRepairLoop` 只在 `packages/core/src/index.ts:755` 被 export，**从未在生产代码中实例化**
- `buildRepairInstruction` 从未在生产代码中被调用
- `runSelfHarness()` 完整编排函数**从未被任何生产代码调用**

也就是说：worker 失败时 engine 只会 emit incident/recovery packets，**不会自动进入下一轮修复**。

### 3.4 ❌ 自动进化（runSelfHarness）— 完全未接入

`runSelfHarness(input)` 是完整的 mine → propose → validate → promote 编排函数，但生产代码从不调用。这是**设计意图**（`docs/FuguNano.md` 第 107-108 行明确将"把 self-harness 放进每一次用户任务的在线主循环"列为 Non-Goal）。

---

## 四、关键类与函数

### 4.1 Self-Harness 进化闭环（手动触发）

| 函数/类 | 文件 | 作用 |
|---|---|---|
| `runSelfHarness(input)` | `self-harness/self-harness-loop.ts:69` | 完整管线：mine → propose → validate → promote。**仅导出，生产代码不调用** |
| `proposePatches(options)` | `self-harness/self-harness-loop.ts:191` | 单步：从 weakness 提出 patch |
| `validatePatches(options)` | `self-harness/self-harness-loop.ts:200` | 单步：held-in/held-out 验证 |
| `promotePatch(options)` | `self-harness/self-harness-loop.ts:228` | 单步：晋升 patch 到 surface 覆盖 |
| `recordLineageForPatch(params)` | `self-harness/self-harness-loop.ts:269` | 写 lineage 记录 |
| `canAutoPromote(surface, validation)` | `self-harness/self-harness-loop.ts:300` | 安全 surface 强制人工晋升 |
| `PatchProposer` | `self-harness/patch-proposer.ts:63` | 从 Weakness 生成 HarnessPatchPacket |
| `PatchValidator` | `self-harness/patch-validator.ts:12` | 校验 patch 完整性 + 跑 held-in/held-out |
| `LineageStore` | `self-harness/lineage-store.ts:26` | lineage.jsonl + patches/<id>.json |
| `SurfaceStore` | `surfaces/surface-store.ts:400` | surface 内容 + 用户 override（`.covalo/harness/surfaces/<surface>.md`） |
| `evaluatePromotion(input)` | `self-harness/promotion-gate.ts:13` | **核心 gate**：`deltaIn>=0 && deltaOut>=0 && max(delta)>0 && !regressions` |

### 4.2 Packet 系统（运行时自动触发）

| 函数/类 | 作用 |
|---|---|
| `PacketStore` (`packets/packet-store.ts:12`) | 落盘到 `.covalo/runs/<runId>/{packets.jsonl, events.jsonl, artifacts/}` |
| `createTaskDigest` | `engine.ts:1082` 在 submit 开始时调用 |
| `guardPrompt` + `createRuntimeGuardPacket` | `engine.ts:1109` 在 submit 中调用，**block 时终止 submit** |
| `createReviewPacket` | `engine.ts:1285` 在 loop 结束后调用 |
| `createIncidentPacket` + `classifyFailureClass` | `engine.ts:1286` 在失败时调用 |
| `createRecoveryPacket` | `engine.ts:1287` 在失败时调用 |
| `classifyRisk` + `createActionCertificate` + `completeActionCertificate` | `streaming-executor.ts:291` 对中/高风险 bash 命令调用 |
| `BoundedRepairLoop` (`repair-loop.ts:40`) | 有界修复循环状态机。**生产代码从不实例化**，仅测试使用 |
| `buildRepairInstruction` (`repair-loop.ts:186`) | 从 RecoveryPacket 构建修复指令。**生产代码不调用** |

### 4.3 Experience 记忆

| 函数/类 | 作用 |
|---|---|
| `ExperienceStore` (`experience/experience-store.ts:6`) | 落盘到 `.covalo/experience/experiences.jsonl` |
| `mineFromIncidents` / `mineFromReview` (`experience/weakness-miner.ts:61,111`) | 从 packets 挖掘 weakness（10 个内置签名） |
| `storeWeaknesses` | 把 weakness 转成 ExperienceRecord 存储 |
| `formatWeaknesses` | CLI 友好打印 |

---

## 五、调用关系图

### 5.1 运行时真实调用链（每次 submit 都执行）

```
engine.submit(userInput, ..., mode="loop"|"subagent")
  │
  ├─ [1] 创建 PacketStore（baseDir=.covalo/runs/<runId>）  engine.ts:1078
  ├─ [2] createTaskDigest + packetStore.append + writeArtifact  engine.ts:1083-1103
  ├─ [3] guardPrompt(userInput) → createRuntimeGuardPacket  engine.ts:1110-1117
  │       └─ 若 disposition="block" → 设置 guardBlocked=true → 提前 return
  │       └─ packetStore.append(guardPacket) + writeArtifact
  │
  ├─ [4] runLoop(...)  正常执行 worker
  │       └─ streaming-executor.ts:291  对 bash/shell/exec:
  │           classifyRisk → createActionCertificate → completeActionCertificate
  │           落盘 .covalo/harness/certificates/
  │
  └─ [5] Post-loop（engine.ts:1283-1369）：
          createReviewPacket → packetStore.append + writeArtifact("review-packet.json")
          if verdict=="NEEDS_FIX":
            createIncidentPacket → packetStore.append + writeArtifact("incident-packet.json")
            createRecoveryPacket → packetStore.append + writeArtifact("recovery-packet.json")
```

### 5.2 CLI 手动进化链（人工触发，不在运行时主循环中）

```
用户在终端运行 `covalo harness mine --from-eval <id>`
  │
  └─ harnessCommand → harnessMine  cli/commands/harness.ts:86
       ├─ 读取 .covalo/evals/<id>/cases/*/packets.jsonl
       ├─ mineFromIncidents + mineFromReview   ← 真实调用 weakness-miner
       ├─ ExperienceStore.append（每个 weakness 存为 experience）
       └─ 打印结果（不调用 logger 发射 observability 事件）

用户运行 `covalo harness propose --weakness <id>`
  │
  └─ harnessPropose  cli/commands/harness.ts:168
       ├─ ExperienceStore.getById(id) 取出 weakness
       ├─ new PatchProposer(surfaceStore).proposeFromWeaknesses([weakness])
       └─ 落盘到 .covalo/harness/patches/<patchId>.json

用户运行 `covalo harness validate --patch <id>`
  │
  └─ harnessValidate  cli/commands/harness.ts:224
       └─ new PatchValidator(surfaceStore).validatePatchIntegrity(patch)
          ⚠ 仅做完整性校验，不跑真实 held-in/held-out eval
          ⚠ 代码注释明确说明：完整验证需手动跑 covalo eval 前后对比

用户运行 `covalo harness promote --patch <id>`
  │
  └─ harnessPromote  cli/commands/harness.ts:277
       ├─ 校验 beforeHash 仍然匹配
       ├─ 备份当前 surface 到 .covalo/harness/rollbacks/<id>-before.json
       ├─ promotePatch() → surfaceStore.writeOverride(surface, patch.patch)
       └─ recordLineageForPatch() → LineageStore.append（写 lineage.jsonl）
```

### 5.3 未接入的"死代码"

```
runSelfHarness(input)            ← 仅在 self-harness-loop.ts 中定义，从未被调用
BoundedRepairLoop (new ...)      ← 仅在测试文件中被实例化
buildRepairInstruction(...)      ← 仅在测试中被调用
```

---

## 六、落盘/持久化机制

| 数据 | 路径 | 写入者 |
|---|---|---|
| Packet JSONL 流 | `.covalo/runs/<runId>/packets.jsonl` | PacketStore.append（engine/runner） |
| Packet 事件流 | `.covalo/runs/<runId>/events.jsonl` | PacketStore.writeEvent |
| Packet 工件 | `.covalo/runs/<runId>/artifacts/*.json` | PacketStore.writeArtifact |
| Run 元数据 | `.covalo/runs/<runId>/run.json` | PacketStore.init |
| Eval case 镜像 | `.covalo/evals/<evalRunId>/cases/<caseId>/packets.jsonl` | PacketStore.mirrorToEvalCase |
| Lineage | `.covalo/harness/lineage.jsonl` | LineageStore.append |
| Patch 工件 | `.covalo/harness/patches/<patchId>.json` | LineageStore.append + CLI harnessPropose |
| Surface 覆盖 | `.covalo/harness/surfaces/<surface>.md` | SurfaceStore.writeOverride（promote 时） |
| Rollback 备份 | `.covalo/harness/rollbacks/<patchId>-before.json` | CLI harnessPromote |
| Action 证书 | `.covalo/harness/certificates/<certId>.json` | streaming-executor.ts:317 |
| 经验记忆 | `.covalo/experience/experiences.jsonl` | ExperienceStore.append |

`baseDir` 默认是 `process.cwd()`（CLI `harness.ts:30` 的 `getBaseDir()`），SurfaceStore 在没有 baseDir 时回退到 `homedir()/.covalo/...`（`surface-store.ts:407`）。

---

## 七、测试覆盖情况

测试覆盖良好，共 11 个测试文件，`FuguNano.md` 声称 124 项测试通过：

| 测试文件 | 覆盖范围 |
|---|---|
| `__tests__/harness-evolution.test.ts` | 总览：TaskDigest、Review、Incident、Recovery、RuntimeGuard、ActionCertificate、PacketStore |
| `__tests__/harness-evolution-repair-loop.test.ts` | BoundedRepairLoop 状态机、maxRounds、keepBest |
| `__tests__/harness-evolution-experience.test.ts` | ExperienceStore recall/filter/supersession |
| `__tests__/harness-evolution-lineage-store.test.ts` | LineageStore 读写 |
| `__tests__/harness-evolution-outcomes.test.ts` | ModelOutcome 记录 |
| `__tests__/harness-evolution-promotion-gate.test.ts` | evaluatePromotion 6 种 accept/reject 场景 + safety surface |
| `__tests__/harness-evolution-proposer.test.ts` | PatchProposer + determinePatchRisk + generatePatchId |
| `__tests__/harness-evolution-surface-store.test.ts` | SurfaceStore override/hash |
| `__tests__/harness-evolution-validator.test.ts` | PatchValidator integrity + validation |
| `__tests__/harness-evolution-weakness-miner.test.ts` | mineFromIncidents/mineFromReview |
| `__tests__/deterministic-gates.test.ts` | anyGateFailed / constrainVerdictWithGates |

**测试未覆盖的盲区**：
- 没有端到端测试验证 `covalo harness mine → propose → validate → promote` 的完整 CLI 流程
- 没有 `engine.ts` 中 packet 落盘的集成测试（packet 创建逻辑藏在 1000+ 行的 `submit()` 里）
- 没有 `streaming-executor.ts` 中 ActionCertificate 创建的集成测试

---

## 八、未完成标记

### 8.1 源代码内

源代码内**无 TODO/FIXME/stub/placeholder 标记**（在 `harness-evolution/` 目录下用 grep 全部关键词均无匹配）。

### 8.2 FuguNano.md 文档显式承认未接入的 observability 事件

用 🔲 标记：

| 事件名 | 状态 |
|---|---|
| `harness.repair.round.start` | 🔲 已定义但 repair-loop 未在生产链路运行 |
| `harness.repair.round.done` | 🔲 同上 |
| `harness.self.mine.done` | 🔲 已定义，CLI 级别未接 logger |
| `harness.self.patch.proposed` | 🔲 同上 |
| `harness.self.patch.validated` | 🔲 同上 |
| `harness.self.patch.promoted` | 🔲 同上 |
| `harness.self.patch.rejected` | 🔲 同上 |

这些事件常量都定义在 `observability.ts:6-20`，但 CLI 命令（`harness.ts`）和 `runSelfHarness()` 都没有调用 logger 发射这些事件。`engine.ts` 仅发射了 `harness.guard.allow/review/block` 和 `harness.packet.created`。

### 8.3 隐性未完成

**1. `harnessValidate` 只做完整性校验**（`harness.ts:256-274` 代码注释明确说明）：

> "Note: this is a PATCH INTEGRITY CHECK, not a held-in/held-out eval validation. Full self-harness validation requires running fixed eval before and after the patch, then comparing pass rates."

即 held-in/held-out 真实验证需要人工跑两次 `covalo eval` 对比，CLI 不自动执行。

**2. `harnessPromote` 在没有 `--force` 时拒绝晋升**（`harness.ts:346-350`）：

```
⚠ No validation results available. Promote requires real held-in/held-out eval results.
  Use --force to promote with synthetic acceptance (bypasses validation gate).
```

也就是说，没有真实的 eval 结果传给 promote 命令时，必须用 `--force` 绕过 promotion gate——这等于绕开了 self-harness 的核心安全机制。

---

## 九、设计意图 vs 实现差距

`FuguNano.md` 第 107-108 行明确将以下列为 Non-Goal：

- "把 self-harness 放进每一次用户任务的在线主循环"
- "允许 self-harness 自动放宽安全策略、减少验证、扩大权限"

第 968 行明确要求：

> "Self-harness must never silently change active runtime behavior during a user task. Promotion applies to future runs."

因此，self-harness 进化闭环**不接入运行时主循环是设计意图**，不是 bug。但以下三点更像是实现尚未达到设计文档预期的完整度：

1. **`BoundedRepairLoop` 完全不接入** — 设计文档似乎预期它会在 worker 失败时被使用，但代码从不实例化
2. **CLI 命令不发射 observability 事件** — 7 个 `harness.self.*` 事件已定义但从未被调用
3. **`validate` 命令不跑真实 eval** — promotion gate 的核心安全机制无法真正生效

---

## 十、如何跑通一次自我进化闭环

目前最现实的路径：

1. 正常跑几次任务（自动收集 packets 到 `.covalo/runs/<runId>/packets.jsonl`）
2. `covalo harness mine --from-eval <id>` 挖掘 weakness
3. `covalo harness propose --weakness <id>` 生成 patch
4. 手动跑两次 `covalo eval`（应用 patch 前后）对比通过率
5. `covalo harness promote --patch <id>`（需要真实 eval 结果，否则只能 `--force`）

**当前缺失的自动化**：步骤 4 的前后 eval 对比无法通过 CLI 自动完成，需要人工操作并记录通过率。

---

## 十一、相关文件路径汇总

### 核心模块

- `packages/core/src/harness-evolution/index.ts`
- `packages/core/src/harness-evolution/self-harness/self-harness-loop.ts`
- `packages/core/src/harness-evolution/self-harness/patch-proposer.ts`
- `packages/core/src/harness-evolution/self-harness/patch-validator.ts`
- `packages/core/src/harness-evolution/self-harness/promotion-gate.ts`
- `packages/core/src/harness-evolution/self-harness/lineage-store.ts`
- `packages/core/src/harness-evolution/self-harness/patch-schema.ts`
- `packages/core/src/harness-evolution/repair-loop.ts`
- `packages/core/src/harness-evolution/experience/weakness-miner.ts`
- `packages/core/src/harness-evolution/experience/experience-store.ts`
- `packages/core/src/harness-evolution/surfaces/surface-store.ts`
- `packages/core/src/harness-evolution/packets/packet-store.ts`
- `packages/core/src/harness-evolution/packets/runtime-guard.ts`
- `packages/core/src/harness-evolution/packets/action-certificate.ts`
- `packages/core/src/harness-evolution/observability.ts`

### 运行时集成点

- `packages/core/src/engine.ts` (line 1070-1369)
- `packages/core/src/streaming-executor.ts` (line 288-320)
- `packages/core/src/eval/runner.ts` (line 440-904)

### 入口点

- `packages/cli/src/commands/harness.ts`
- `packages/cli/src/index.ts` (line 83-88)
- `packages/tui/src/App.tsx` (line 726-772)
- `packages/tui/src/commands.ts` (line 65-82)

### 测试

- `packages/core/__tests__/harness-evolution*.test.ts`（10 个文件）
- `packages/core/__tests__/deterministic-gates.test.ts`

### 设计文档

- `docs/FuguNano.md`
