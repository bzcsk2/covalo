# LoopRig `/eval` 真实 Case 开发规范

最后更新：2026-06-27。

本文件是给后续开发 agent 的 case 开发 spec。目标不是继续扩充当前那批小型 synthetic fixtures，而是把 LoopRig `/eval` 升级为可运行、可复现、可维护的真实任务评测集，优先接入：

- `/vol4/Agent/terminal-bench`
- `/vol4/Agent/SWE-bench`
- LoopRig 自己仓库内的真实开发任务

本文件只定义 case 来源、适配规则、目录结构、选题标准、验收标准。沙箱与运行时要求以 [EVAL_SANDBOX.md](./EVAL_SANDBOX.md) 为准。

## 1. 目标

后续 agent 必须把 `/eval` 的真实 case 库建设到下面这个标准：

1. 六个评测大项全部启用：
   - `coding-basics`
   - `tool-use`
   - `safety`
   - `supervisor-recovery`
   - `long-run`
   - `weak-model`
2. 每个大项至少 `10` 个真实 case。
3. “真实 case” 的定义必须满足：
   - 来自真实 benchmark 或真实仓库任务，而不是纯手工最小夹具
   - 有真实代码、真实依赖、真实 verifier
   - 有可追溯的来源 ID、版本、commit、任务目录或实例 ID
4. 真实 case 必须能落到 LoopRig 自己的 manifest/registry 体系中，不允许运行时再临时解释第三方仓库格式。

本轮完成标准是：

- 总计至少 `60` 个真实 case
- 每个 category `>= 10`
- 至少覆盖 `Terminal-Bench`、`SWE-bench`、`LoopRig real tasks` 三类来源

## 2. 基于当前目录的事实

后续 agent 必须按当前本地实际情况开发，不要做错误假设。

### 2.1 Terminal-Bench 本地现状

当前本地仓库：

- `/vol4/Agent/terminal-bench`

可直接利用的事实：

- 有本地任务注册表：`/vol4/Agent/terminal-bench/registry.json`
- 有大量真实任务目录：`/vol4/Agent/terminal-bench/original-tasks/*`
- 单个任务目录通常已经包含：
  - `task.yaml`
  - `Dockerfile`
  - `docker-compose.yaml`
  - `run-tests.sh`
  - `solution.sh`
  - `tests/*`
- 有现成 adapter 目录，含 `swebench` adapter：
  - `/vol4/Agent/terminal-bench/adapters/swebench`

结论：

- Terminal-Bench 是本轮首选真实 case 来源。
- 首批 case 适配应优先从 `original-tasks/` 本地任务目录中选择。
- 不要把 Terminal-Bench 当成“只读参考文档”；它已经有足够多可直接物化的真实任务。

### 2.2 SWE-bench 本地现状

当前本地仓库：

- `/vol4/Agent/SWE-bench`

可直接利用的事实：

- 本地 clone 的主要是 harness、collect、versioning、docs 代码
- 本地并没有天然随仓库附带一批可直接运行的 task workspace 目录
- 本地有评测 harness：
  - `swebench/harness/run_evaluation.py`
  - `swebench/harness/prepare_images.py`
- 本地有实例收集与构建脚本：
  - `swebench/collect/get_tasks_pipeline.py`
  - `swebench/collect/build_dataset.py`

结论：

- SWE-bench 接入不能假设“case 已经在仓库里躺好”。
- 必须显式建立 LoopRig 自己的“精选实例清单 + 本地物化流程”。
- 首批真实 SWE case 应优先使用 `SWE-bench Verified` / `SWE-bench Lite` 的精选实例，而不是全量接入。

### 2.3 LoopRig 当前 eval 现状

当前 LoopRig 自己只有：

- `packages/core/src/eval/fixtures/*`
- `packages/core/src/eval/registry.ts`

这批 case 的性质是：

- 有真实代码和 verifier
- 但本质还是小型 synthetic fixture
- 还不能作为“真实任务库”完成态

结论：

- 这批 fixture 可以保留为 `core/core-set` 或 `diagnostic`。
- 但它们不应再代表“真实 case 库已经完成”。

## 3. 不可违反的规则

### 3.1 真实 case 的判定标准

只有满足下面全部条件，才允许记入“真实 case 数量”：

1. 来源可追溯：
   - Terminal-Bench task id
   - SWE-bench instance id
   - LoopRig 真实仓库 issue/task id
2. 工作区不是纯手工拼装的最小 demo。
3. verifier 是真实命令或真实 harness，不是仅检查某个字符串是否出现。
4. 能记录版本锁定信息：
   - source repo
   - branch / commit / dataset version
   - instance id / task id

### 3.2 不允许伪造真实 case

下面这些不能算“真实 case”：

- 继续新增只有几行代码的 toy project
- 从真实 benchmark 抄一个题目描述，但手工重写成最小玩具项目
- 没有固定来源 ID，只写“参考自某 benchmark”
- verifier 只有 `fileAssertions`，没有真实运行步骤

### 3.3 不允许在线漂移

真实 case 运行时不能依赖“当前网络上的最新数据”。

要求：

- case selection 结果必须落成 LoopRig 仓库内的 lock/manifest 文件
- 每个 case 必须固定来源版本
- 不允许 `/eval` 运行时临时联网抓取“最新实例”

### 3.4 不允许重复凑数

不允许通过“同一个任务改三个名字”来凑够 10 个。

允许重复底层来源实例的唯一条件：

- 同一个真实任务被放到不同 category 时，评测目标显著不同
- verifier 和 scoring 逻辑不同
- 文档中明确记录“这是 scenario wrapper，不是新源任务”

默认规则：

- 统计 `60` 个真实 case 时，优先按唯一 `source + instance` 去重

## 4. 目标 case 结构

后续 agent 必须把真实 case 分成三层：

### 4.1 Source Layer

表示原始来源：

- `terminal-bench`
- `swe-bench`
- `looprig-real`

### 4.2 Curated Instance Layer

表示“从来源中选出的可用实例集合”。

这一层必须是 LoopRig 自己管理的锁定文件，不允许直接把第三方仓库当 registry。

### 4.3 Runtime Materialization Layer

表示“把精选实例物化成 LoopRig `/eval` 能运行的 workspace + verifier + report 结构”。

也就是说，LoopRig `/eval` 的真值来源必须是：

```text
第三方仓库
  -> LoopRig curated lock
  -> LoopRig materializer
  -> LoopRig EvalCaseManifest
  -> LoopRig runner
```

不能变成：

```text
/eval
  -> 临时猜第三方仓库格式
  -> 直接运行
```

## 5. 推荐目录结构

不要继续把所有逻辑堆在 `fixtures/index.ts` 和 `registry.ts` 里。

推荐新增：

```text
packages/core/src/eval/
  sources/
    terminal-bench.ts
    swe-bench.ts
    looprig-real.ts

  curated/
    terminal-bench.lock.json
    swe-bench.lock.json
    looprig-real.lock.json
    category-map.json

  materialize/
    terminal-bench.ts
    swe-bench.ts
    looprig-real.ts
    shared.ts

  generated/
    manifests.ts
    registry.ts
```

说明：

- `sources/*`：读取第三方来源元数据
- `curated/*.lock.json`：精选后的固定实例清单
- `materialize/*`：把来源实例转成 LoopRig workspace/verifier
- `generated/*`：由 curated 数据生成的 LoopRig registry/manifests

不要求文件名完全一致，但职责必须分层。

## 6. 每个评测大项的配额

这是硬要求。

### 6.1 `coding-basics`

至少 `10` 个真实 case。

允许来源：

- SWE-bench Verified / Lite 的小中型 bugfix 实例
- Terminal-Bench 中明确属于修 bug / 修测试 / 修构建的任务
- LoopRig 自己仓库的真实回归修复任务

优先方向：

- 修测试失败
- 修类型错误
- 修 CLI/解析 bug
- 修构建或依赖冲突

### 6.2 `tool-use`

至少 `10` 个真实 case。

允许来源：

- Terminal-Bench 为主
- 少量 LoopRig 自己的真实 repo 任务

优先方向：

- 必须先搜索再编辑
- 必须多轮运行命令和迭代
- 多文件联动修改
- shell / grep / edit / verify 组合明显

### 6.3 `safety`

至少 `10` 个真实 case。

允许来源：

- Terminal-Bench 中带明显权限、敏感文件、环境边界要求的任务
- LoopRig 自己的安全边界任务

优先方向：

- 只读任务
- 禁止访问宿主外路径
- 遇到 deny 命令后的正确退避
- 不能通过作弊绕过 verifier

### 6.4 `supervisor-recovery`

至少 `10` 个真实 case。

允许来源：

- 真实 Terminal-Bench / SWE-bench / LoopRig real task
- 但要作为“恢复场景”包装

要求：

- 底层任务必须是真实任务
- 评测目标不是“能否直接一次过”，而是“初次失败后能否基于证据恢复”

允许实现方式：

- 限制第一轮预算
- 注入一个受控错误中间态
- 在第一次 verifier fail 后由 supervisor 接管

但不得把纯手工玩具故障当作真实 case。

### 6.5 `long-run`

至少 `10` 个真实 case。

允许来源：

- Terminal-Bench 长链任务优先
- 少量真实仓库多阶段修复任务

要求：

- 多步命令
- 多文件或多阶段验证
- 明显长于 current core-set

### 6.6 `weak-model`

至少 `10` 个真实 case。

允许来源：

- Terminal-Bench 的 `.easy` / 小型任务
- SWE-bench Verified 中较短、依赖较轻的实例
- LoopRig 自己仓库的真实但范围小的修复任务

要求：

- 仍然是真实任务
- 但难度和上下文规模适合较弱模型闭环

## 7. Source 选择策略

### 7.1 Terminal-Bench

首批开发应以 Terminal-Bench 为主。

具体要求：

1. 优先使用本地 `original-tasks/*`
2. 优先从 `registry.json` 中 `terminal-bench-core` 的 task subset 选题
3. 每个入选 case 必须记录：
   - `taskId`
   - `sourceRepoCommit`
   - `taskPath`
   - `task.yaml` 路径
4. 优先选这类任务：
   - `fix-*`
   - `git-*`
   - `csv-to-parquet`
   - `jq-data-processing`
   - `jsonl-aggregator`
   - `configure-git-webserver`
   - `fix-permissions`
   - `sanitize-git-repo`
   - `nginx-request-logging`
   - 其他明显属于软件工程和终端工作流的任务
5. 暂时不要把特别重的研究型任务和超长编译任务作为首批 60 个主力 case

首批原则：

- 先选能稳定在本机/容器跑通的任务
- 不要为了“看起来高级”一开始就选最重任务

### 7.2 SWE-bench

SWE-bench 不能直接拿仓库代码当 case 集。

必须这样做：

1. 从 `SWE-bench Verified` 或 `SWE-bench Lite` 中人工精选实例
2. 生成 LoopRig 自己的 locked instance list
3. 每个入选实例记录：
   - `instance_id`
   - `repo`
   - `base_commit`
   - `dataset_name`
   - `split`
   - `language`
4. LoopRig 运行时只依赖这个 locked list，不直接面向全量 HF dataset

首批建议：

- `Verified` 优先于 full dataset
- Python repo 优先于多语言混入
- 小中型依赖优先

### 7.3 LoopRig Real Tasks

这类 case 不是指“当前 synthetic fixtures”，而是：

- 来自 LoopRig 仓库真实 bugfix / regression / refactor / test repair
- 有真实 git 变更历史或真实 issue/task 来源

要求：

- 必须有真实任务来源说明
- 不允许把随手造的小项目塞进 `looprig-real`

## 8. 真实 case 的 manifest 规范

所有真实 case 最终都必须落成 LoopRig `EvalCaseManifest`。

至少新增或落地这些字段：

```ts
interface RealCaseSourceMeta {
  sourceKind: "terminal-bench" | "swe-bench" | "looprig-real";
  sourceId: string;
  sourceRepoPath: string;
  sourceCommit?: string;
  sourceDataset?: string;
  sourceSplit?: string;
  sourceTaskPath?: string;
  sourceInstanceId?: string;
}
```

推荐 manifest 至少包含：

```ts
interface EvalCaseManifest {
  id: string;
  category: EvalCategoryId;
  suite: EvalSuiteId;
  title: string;
  description: string;
  fixtureSource: string;
  sourceMeta: RealCaseSourceMeta;
  setup?: string[];
  taskPrompt: string;
  expectedVerification: string[];
  verifier: {
    type: "command" | "script" | "file-assert";
    command?: string;
    scriptPath?: string;
    timeoutMs?: number;
  };
  scoring?: {
    requireCleanGitDiff?: boolean;
    maxChangedFiles?: number;
  };
}
```

硬要求：

- 每个真实 case 必须有 `sourceMeta`
- 报告里必须能看到 `sourceKind` 和原始来源 ID

## 9. 物化规则

### 9.1 Terminal-Bench 物化

Terminal-Bench case 物化时：

1. 从本地任务目录复制 task workspace
2. 记录原始 `task.yaml`
3. 尽量复用其 `run-tests.sh`
4. 如需容器运行，保留其 `Dockerfile` / `docker-compose.yaml` 信息
5. 生成 LoopRig 自己的 verifier 封装，不直接把第三方 CLI 暴露给用户

### 9.2 SWE-bench 物化

SWE-bench case 物化时：

1. 基于 locked instance list 还原 repo + commit
2. 生成固定 workspace
3. 将 LoopRig 产出的 patch 转成 SWE-bench harness 可消费格式
4. verifier 由 LoopRig 封装调用 SWE-bench harness

关键要求：

- LoopRig `/eval` 要吃的是自己的 case manifest
- 不是让用户自己先跑一遍 `swebench.harness.run_evaluation`

### 9.3 LoopRig Real Tasks 物化

这类 case 物化时：

1. 从 LoopRig 仓库真实 commit/issue 中提炼任务
2. 固定 baseline commit
3. 生成受控 workspace
4. verifier 优先用真实 `typecheck` / `test` / targeted command

## 10. 开发顺序

按下面顺序做，不要并行乱铺。

### P0：建立 curated lock 机制

目标：

- 能用 JSON/TS 清单表达“哪些真实实例被选中”
- 不再让 `registry.ts` 手写散落 case

验收：

- 至少有 `terminal-bench.lock.json` 和 `swe-bench.lock.json` 草案

### P1：先接 Terminal-Bench 10+10+10

目标：

- 先把 `coding-basics`、`tool-use`、`safety` 三个 category 做到各 `>=10`
- 来源以 Terminal-Bench 为主，必要时少量 LoopRig real task 补齐

验收：

- 三个 category 各至少 10 个真实 case
- 每个 case 都能追溯到原 task id

### P2：补齐 supervisor-recovery / long-run / weak-model

目标：

- 让六个 category 全部达到 `>=10`
- 允许用真实任务做 scenario wrapper

验收：

- 六个 category 全覆盖
- 总计 `>=60` 个真实 case

### P3：接入 SWE-bench 精选实例

目标：

- 至少接入 `10` 个精选 SWE-bench Verified/Lite 实例
- 这些实例分配到合适的 category 中

验收：

- 报告中能看到 `sourceKind=swe-bench`
- verifier 可稳定调用封装后的 SWE harness

## 11. 明确不做的事

本轮不做这些：

- 不全量镜像 Terminal-Bench 全库
- 不全量镜像 SWE-bench 全 dataset
- 不把第三方仓库直接暴露成 LoopRig 的 UI 概念
- 不用新的 synthetic toy case 去凑“10 个真实案例”
- 不先做排行榜，再补真实 case

## 12. 验收标准

只有满足下面条件，这轮真实 case 扩展才算完成：

1. 六个评测大项全部可选。
2. 每个大项至少 `10` 个真实 case。
3. Terminal-Bench 来源 case 可追溯到本地 `task.yaml` / task id。
4. SWE-bench 来源 case 可追溯到 locked instance list。
5. 报告中能显示每个 case 的 `sourceKind` 和来源 ID。
6. 真实 case 不再依赖手工最小 synthetic fixture 才能凑数。

后续 agent 直接按本文件实施，不要再把 `CASES.md` 写回“只有 native fixture 的 MVP 说明”。
