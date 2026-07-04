# Covalo 评测系统修复实施 Spec

**文档类型**：Agent 修复实施规范  
**目标仓库**：`bzcsk2/covalo`  
**目标模块**：`packages/core/src/eval/` 及其相关 sandbox / harness-evolution 依赖  
**基准来源**：原始审计报告 `covalo_eval_system_audit_20260705(2).md`，并结合当前代码核验后重排优先级  
**修复目标**：提升 Covalo eval 系统的评分正确性、安全边界、跨平台一致性、诊断能力和未来并发扩展能力  
**建议实施方式**：按 Pack 分批提交，每个 Pack 独立可测、独立可回滚

---

## 0. 给修复 Agent 的总指令

你要修复的是 Covalo 的 eval 系统，不是业务主引擎。请在修改前先阅读以下文件，并在每个 Pack 修改后运行相关测试或至少补充对应单元测试：

```text
packages/core/src/eval/runner.ts
packages/core/src/eval/verifier.ts
packages/core/src/eval/verifier-classifier.ts
packages/core/src/eval/workspace.ts
packages/core/src/eval/loader.ts
packages/core/src/eval/types.ts
packages/core/src/eval/tool-tracker.ts
packages/core/src/eval/materialize/shared.ts
packages/core/src/eval/materialize/swe-bench.ts
packages/core/src/eval/sources/terminal-bench.ts
packages/core/src/eval/sources/swe-bench.ts
packages/core/src/eval/profile/installer.ts
```

实施原则：

1. **不要把基础设施失败当成 Worker 失败。**
   - Verifier timeout、sandbox provider 抛错、命令不存在、测试环境缺失、test patch 无法 apply，都应进入 infra / verifier contract 路径。
   - 这些结果应默认 `scoreEligible=false`，不要生成普通可排名分数。

2. **不要把不可验证任务当成 verifier skipped。**
   - `verifierSkipped=true` 只适用于显式未运行 verifier 的场景。
   - `verifierResult.verdict === "error"` 不是 skipped，而是 verifier / sandbox / infra 异常。

3. **所有来自 manifest 的路径都必须做 containment 校验。**
   - `fixtureSource`
   - `fileAssertions.path`
   - `scriptPath`
   - `protectedFiles`
   - `outOfBoundsCheckPaths`

4. **评分信号必须可解释。**
   - `objectiveSignals` 中要区分 tracked diff、untracked files、git 失败、tool tracker 是否真实启用。
   - 不要在 git 失败时给出看似正常的客观分。

5. **修复要保持 eval artifact 可读。**
   - `score.json`
   - `objective-signals.json`
   - `verifier.json`
   - `verifier-classification.json`
   - `policy-gates.json`
   - `case-contract.json`
   - `sandbox-fingerprint.json`

---

## 1. 原审计报告的优先级重排

原报告中的问题不是全部错误，但优先级需要重排。以下是本 Spec 采用的修复优先级。

### 1.1 P0：必须优先修复

| 编号 | 问题 | 真实风险 |
|---|---|---|
| P0-A | `verifierResult.verdict === "error"` 被当成普通 0 分失败 | 会污染 eval 排名，把 infra / verifier contract failure 误判成 Worker 失败 |
| P0-B | manifest 路径缺少 containment guard | 可能读取、复制或删除 workspace 之外的文件 |
| P0-C | `outOfBoundsCheckPaths` 直接 `rmSync(..., recursive:true)` | 如果 manifest 被污染，存在灾难性删除风险 |

### 1.2 P1：影响评测可信度

| 编号 | 问题 | 真实风险 |
|---|---|---|
| P1-A | `git diff --name-only` 不统计 untracked files | Worker 新增文件可能绕过 `maxChangedFiles` |
| P1-B | `extractAssessment()` 贪婪正则提取 JSON | Supervisor 输出多个 JSON 时评分提取失败 |
| P1-C | `patchTestPaths()` 依赖 `find + sed -i` | Windows 上静默失效，Terminal-Bench verifier 可能误失败 |
| P1-D | `tsconfig.json` 被全局自动保护 | 构建配置修复类 case 会被误判 policy gate failure |
| P1-E | SWE-bench `git apply` 失败诊断不足 | 无法快速定位 test patch apply 失败原因 |
| P1-F | sandbox provider 抛异常未结构化为 verifier error | 错误路径不统一，artifact 不完整 |

### 1.3 P2：架构一致性和未来扩展

| 编号 | 问题 | 真实风险 |
|---|---|---|
| P2-A | `evalToolTracker` 是全局单例 | 并发 eval run / 并发 case 会互相污染 |
| P2-B | `_currentCaseWorkspace` / `_currentEvalContext` 是模块级全局状态 | 不支持并发，也容易造成上下文串线 |
| P2-C | Zod schema 与 TypeScript interface 漂移 | manifest 字段类型错误无法被发现 |
| P2-D | installer 对 unsupported platform 可能误报 ready | 非 Linux 平台官方分数判断不可信 |
| P2-E | Supervisor prompt 固定截断 patch diff 到 2000 字符 | 大 patch 评分信息不充分 |

### 1.4 不应直接实施的原报告结论

以下原报告结论不应按原文直接执行：

1. **“把 verifier error 当成 verifier skipped”**  
   不要这样改。`error` 不是 skipped。正确做法是分类为 infra / verifier contract / sandbox failure，并设置 `scoreEligible=false`。

2. **“runner.ts 与 scoring/eval-prompts.ts 两套 Worker prompt 逻辑”**  
   当前仓库未发现 `packages/core/src/eval/scoring/eval-prompts.ts`。不要基于不存在文件做重构。若后续发现旧分支存在该文件，再另行处理。

3. **“Terminal-Bench 数量为 60”**  
   当前 lock 文件实际是 72 个 Terminal-Bench case：6 类 × 每类 12 个。

4. **“unsupported platform fallback 到 linux binary”**  
   当前 installer 对 `aix/android/freebsd/...` 是空数组，不是直接 fallback。更真实的问题是空数组可能导致 status `ready=true`，应改为 unsupported。

---

## 2. Pack A：重构 verifier error 的评分语义

### 2.1 背景

当前 `computeScore()` 对 `verifierResult.verdict === "error"` 的处理是：

```ts
else if (verifierResult.verdict === "error") verifierScore = 0;
// ...
if (verifierResult && verifierResult.verdict === "error") {
  finalScore = 0;
}
```

问题不是“分数低”，而是“语义错误”。Verifier error 通常表示基础设施、沙箱、命令、测试环境或 verifier contract 失败，不应进入普通 Worker fail 排名。

### 2.2 目标行为

| verifierResult | classifier verdict | Case verdict | scoreEligible | score |
|---|---|---|---|---|
| `pass` | `task_pass` | `pass` | true | 正常评分 |
| `fail`，且不是 infra | `task_fail` | `fail` | true | 正常评分，但 finalScore capped |
| `error`，timeout | `sandbox_failure` 或 `verifier_contract_failure` | `infra_error` 或 `error`，按现有类型约束选择 | false | `score=null` 或 `score.scoreIneligible=true` |
| `fail`，但输出显示 `command not found` / `ModuleNotFoundError` / `No tests found` | `setup_failure` / `verifier_contract_failure` | `infra_error` | false | `score=null` 或 `score.scoreIneligible=true` |
| verifier 未运行 | skipped | `skipped` | false 或 neutral，视调用场景 | 不参与官方分数 |

### 2.3 修改文件

```text
packages/core/src/eval/runner.ts
packages/core/src/eval/verifier-classifier.ts
packages/core/src/eval/types.ts
```

### 2.4 建议实现

#### Step 1：提前分类 verifier 结果

在 `runSingleCase()` 中，`runVerifier()` 后立即调用：

```ts
const classifiedVerifier = verifierResult
  ? classifyVerifierResult(verifierResult, manifest)
  : null;
```

并把 `classifiedVerifier` 贯穿后续：

- artifact 写入
- verdict 计算
- score eligibility
- failureClass 计算
- officialScoreEligible 计算

#### Step 2：将 `computeScore()` 改为只处理“可评分结果”

推荐签名：

```ts
function computeScore(
  verifierResult: VerifierResult | null,
  objectiveSignals: ObjectiveSignals | null,
  supervisorAssessment: Record<string, number> | null,
  policyGates: PolicyGateResult[] = [],
  options?: {
    scoreEligible?: boolean;
    verifierClassification?: ClassifiedVerifierResult | null;
  },
): CaseScore | null
```

行为：

```ts
if (options?.scoreEligible === false) {
  return null;
}
```

或者保留 `CaseScore`，但必须：

```ts
return {
  ...,
  finalScore: 0,
  scoreIneligible: true,
}
```

二选一即可，但整个系统要统一。

推荐更清晰的方式：**score 不可用时返回 `null`**。因为当前 `CaseResult.score` 已经允许为 `null`。

#### Step 3：重新定义 `scoreEligible`

推荐逻辑：

```ts
const classifiedVerifier = verifierResult
  ? classifyVerifierResult(verifierResult, manifest)
  : null;

const verifierScoreEligible =
  !classifiedVerifier || classifiedVerifier.scoreEligible;

const hasPolicyFailures = policyGates.some(g => !g.passed);

const scoreEligible =
  verifierScoreEligible &&
  !hasPolicyFailures &&
  !objectiveSignals.gitSignalError;
```

注意：policy gate fail 可以保留 score，但应标记 `scoreIneligible=true`，因为 policy gate 是硬约束。是否返回 `score=null` 或 `finalScore=0` 需要统一。

建议：

- policy gate fail：保留 `score`，`finalScore=0`，`scoreIneligible=true`
- infra / verifier contract / setup failure：`score=null`
- git signal error：`score=null` 或 `scoreIneligible=true`，但不要当普通分数参与排名

#### Step 4：更新 verdict 映射

当前逻辑：

```ts
let verdict = error
  ? "error"
  : !verifierResult
    ? "skipped"
    : verifierResult.verdict === "pass"
      ? "pass"
      : "fail";
```

应改为更细：

```ts
let verdict: CaseResult["verdict"];

if (error) {
  verdict = "error";
} else if (!verifierResult) {
  verdict = "skipped";
} else if (classifiedVerifier?.verdict === "task_pass") {
  verdict = "pass";
} else if (classifiedVerifier?.scoreEligible === false) {
  verdict = "infra_error"; // 如果类型不支持，先扩展 CaseResult verdict 类型
} else {
  verdict = "fail";
}
```

如果 `CaseResult["verdict"]` 当前已经在别处使用了 `"infra_error"`，请把类型定义显式补齐。

### 2.5 验收标准

必须新增或更新测试覆盖：

1. verifier command timeout：
   - `verifierResult.verdict === "error"`
   - `scoreEligible=false`
   - `score=null` 或 `score.scoreIneligible=true`
   - 不计入普通 failed

2. verifier 输出 `command not found`：
   - classifier verdict 为 `setup_failure`
   - score 不参与官方评分

3. pytest 断言失败：
   - classifier verdict 为 `task_fail`
   - `scoreEligible=true`
   - verdict 为 `fail`

4. verifier pass：
   - verdict 为 `pass`
   - score 正常生成

5. policy gate fail：
   - verdict 为 `fail`
   - finalScore 为 0
   - failureClass 为 `policy_gate_failure`

---

## 3. Pack B：统一路径 containment guard

### 3.1 背景

当前多个路径来自 manifest，但没有统一 containment 校验：

- `workspace.ts`：`fixtureSource`
- `verifier.ts`：`fileAssertions.path`
- `runner.ts`：`outOfBoundsCheckPaths`
- `runner.ts`：`protectedFiles`
- `verifier.ts`：`scriptPath` 已有部分校验，但可以复用统一 helper

### 3.2 新增工具文件

建议新增：

```text
packages/core/src/eval/path-guards.ts
```

实现：

```ts
import { resolve, relative, isAbsolute } from "node:path";

export class UnsafeEvalPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeEvalPathError";
  }
}

export function resolveWithinRoot(
  rootDir: string,
  candidatePath: string,
  label: string,
): string {
  if (!candidatePath || typeof candidatePath !== "string") {
    throw new UnsafeEvalPathError(`${label} must be a non-empty string`);
  }

  if (candidatePath.includes("\0")) {
    throw new UnsafeEvalPathError(`${label} contains NUL character`);
  }

  const root = resolve(rootDir);
  const resolved = resolve(root, candidatePath);
  const rel = relative(root, resolved);

  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new UnsafeEvalPathError(`${label} must stay within ${root}`);
  }

  return resolved;
}

export function isWithinRoot(rootDir: string, candidatePath: string): boolean {
  try {
    resolveWithinRoot(rootDir, candidatePath, "path");
    return true;
  } catch {
    return false;
  }
}
```

### 3.3 修改点

#### workspace.ts

替换：

```ts
const fixturePath = join(getFixtureDir(), manifest.fixtureSource);
```

为：

```ts
const fixturePath = resolveWithinRoot(
  getFixtureDir(),
  manifest.fixtureSource,
  `fixtureSource for ${manifest.id}`,
);
```

注意：`fixtureSource` 以 `__tb__` / `__swe__` 开头的 materialized case 不应先尝试当作普通 fixture path copy。当前代码会先检查 `existsSync(fixturePath)`，再判断 `startsWith("__")`。建议改成：

```ts
const isMaterialized = manifest.fixtureSource.startsWith("__");

if (!isMaterialized) {
  const fixturePath = resolveWithinRoot(...);
  if (existsSync(fixturePath)) {
    await cp(...);
  }
} else {
  await initDefaultMaterializers();
  await runMaterializers(...);
}
```

#### verifier.ts / runFileAssertions

替换：

```ts
const fullPath = join(workspaceDir, assertion.path);
```

为：

```ts
let fullPath: string;
try {
  fullPath = resolveWithinRoot(workspaceDir, assertion.path, "file assertion path");
} catch (err) {
  details.push(`ERROR: unsafe file assertion path ${assertion.path}`);
  return { passed: false, details };
}
```

如果希望 unsafe path 属于 verifier contract failure，应让 `runFileAssertions()` 能返回 `error` 状态，或者在 details 中包含可被 classifier 识别的标记，例如：

```text
Unsafe file assertion path
```

并在 classifier 中将其归类为 `verifier_contract_failure`。

#### outOfBoundsCheckPaths

当前代码会直接删除 manifest 指定路径：

```ts
rmSync(p, { force: true, recursive: true });
```

必须删除这段逻辑，改成安全 sentinel 策略。

推荐实现：

- 只允许 `outOfBoundsCheckPaths` 指向 runner 创建的专用临时 sentinel root。
- 不允许 manifest 任意指定绝对路径。
- 如果确实需要检查 workspace 外路径，必须限定在：

```text
<COVALO_ROOT>/evals/<runId>/sentinels/<caseId>/
```

建议新增：

```ts
function resolveOutOfBoundsSentinelPath(
  evalDir: string,
  caseId: string,
  p: string,
): string
```

规则：

- `p` 必须是相对路径
- 最终路径必须位于 `join(evalDir, "sentinels", caseId)` 内
- 初始化时只删除 sentinel root 内部路径
- 检查时只检查 sentinel root 内部路径

如果现有 manifest 使用绝对路径，应先迁移 manifest，而不是放宽代码。

### 3.4 验收标准

1. `assertion.path = "../secret.txt"` 必须被拒绝。
2. `fixtureSource = "../outside"` 必须被拒绝。
3. `outOfBoundsCheckPaths = ["/"]` 不得触发删除，必须返回 manifest contract error 或 preflight error。
4. 正常相对路径 case 不受影响。
5. 所有 unsafe path 都要进入 artifact，便于诊断。

---

## 4. Pack C：修复 objectiveSignals 的 git 信号

### 4.1 背景

当前 `getObjectiveSignals()` 用：

```ts
git diff --name-only
```

它只统计 tracked file diff，不统计 untracked files。后续 policy gate 使用 `objectiveSignals.changedFiles`，因此新增文件可能绕过 `maxChangedFiles`。

同时，git 命令失败时当前函数返回：

```ts
changedFiles: 0,
cleanGitDiff: false,
gitSignalError: "git command failed"
```

然后 `computeScore()` 会给出一个看似正常的 objectiveScore，容易误导。

### 4.2 修改文件

```text
packages/core/src/eval/runner.ts
packages/core/src/eval/types.ts
```

### 4.3 扩展 ObjectiveSignals

建议改成：

```ts
export interface ObjectiveSignals {
  changedFiles: number;
  trackedChangedFiles: number;
  untrackedFiles: number;
  changedFilePaths: string[];
  untrackedFilePaths: string[];
  diffSize: number;
  toolFailureCount: number;
  verificationCommandsRun: number;
  cleanGitDiff: boolean;
  outOfBoundsWrites: string[];
  toolTrackingValid: boolean;
  gitSignalError?: string;
}
```

兼容性要求：

- `changedFiles` = tracked changed + untracked
- `cleanGitDiff` = tracked changed 为 0 且 untracked 为 0
- artifact 中保留路径数组

### 4.4 建议实现

拆分函数：

```ts
function getGitTrackedChangedFiles(workspaceDir: string): string[]
function getGitUntrackedFiles(workspaceDir: string): string[]
function getGitDiffSize(workspaceDir: string): number
```

注意 Windows 编码：

- 继续用 `encoding: "utf-8"` 可以接受，但应设置环境变量：

```ts
env: {
  ...process.env,
  LC_ALL: "C.UTF-8",
  LANG: "C.UTF-8",
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
}
```

不要使用 shell-only 重定向作为逻辑依赖。

### 4.5 修改 policy gate

当前 `maxChangedFiles` 使用 `objectiveSignals.changedFiles`，修复后它会包含 untracked files。

保护文件检测当前有一段独立 `git ls-files --others`，修复后应复用 `objectiveSignals.untrackedFilePaths`，避免重复执行 git 命令。

### 4.6 验收标准

1. Worker 新增一个未追踪文件时：
   - `objectiveSignals.untrackedFiles === 1`
   - `changedFiles >= 1`
   - `maxChangedFiles` 能正确失败

2. Worker 修改 tracked 文件时：
   - `trackedChangedFiles >= 1`
   - `changedFiles >= 1`

3. git 命令失败时：
   - `gitSignalError` 存在
   - score 不应作为正常分数参与排名

---

## 5. Pack D：重写 Supervisor JSON 提取

### 5.1 背景

当前：

```ts
const jsonMatch = supervisorOutput.match(/\{[\s\S]*"dimensions"[\s\S]*\}/);
```

这是贪婪匹配，会从第一个 `{` 匹配到最后一个 `}`。如果 supervisor 输出多个 JSON，解析会失败。

### 5.2 修改文件

```text
packages/core/src/eval/runner.ts
```

建议将 `extractAssessment()` 移到单独文件，便于测试：

```text
packages/core/src/eval/supervisor-assessment.ts
```

### 5.3 建议实现

优先级：

1. 优先解析 fenced code block：

```md
```json
{ "dimensions": { ... } }
```
```

2. 如果没有 fenced block，则扫描所有 balanced JSON object candidates。
3. 对每个 candidate 做 `JSON.parse()`。
4. 找到第一个包含 `dimensions` 且可规范化的对象。
5. 分数支持 0-1 或 0-100，统一归一化到 0-1。
6. 不接受非 number 值。

伪代码：

```ts
function extractJsonCandidates(text: string): string[] {
  const candidates: string[] = [];

  // 1. fenced blocks
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/gi;
  for (const m of text.matchAll(fenceRe)) {
    candidates.push(m[1].trim());
  }

  // 2. balanced braces
  const stack: number[] = [];
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") {
      if (stack.length === 0) start = i;
      stack.push(i);
    } else if (text[i] === "}") {
      stack.pop();
      if (stack.length === 0 && start >= 0) {
        candidates.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}
```

### 5.4 验收标准

覆盖以下输入：

1. 纯 JSON：
   ```json
   {"dimensions":{"taskCompletion":80}}
   ```

2. Markdown + fenced JSON：
   ```md
   分析如下：
   ```json
   {"dimensions":{"taskCompletion":80}}
   ```
   ```

3. 多 JSON：
   ```json
   {"caseId":"x"}
   {"dimensions":{"taskCompletion":80}}
   ```

4. 嵌套对象：
   ```json
   {"dimensions":{"taskCompletion":80,"safety":1}}
   ```

5. 非法 JSON：
   - 返回 `null`
   - 不抛异常

---

## 6. Pack E：移除 Terminal-Bench materializer 的 POSIX-only 命令

### 6.1 背景

当前：

```ts
find "${testsDir}" -name '*.py' -exec sed -i 's|/app/|./|g' {} + 2>/dev/null
```

在 Windows 上不可用，并且失败被 catch 吞掉。

### 6.2 修改文件

```text
packages/core/src/eval/materialize/shared.ts
```

### 6.3 建议实现

用 Node.js 原生 API：

```ts
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

export function patchTestPaths(workspaceDir: string): void {
  const testsDir = join(workspaceDir, "tests");
  if (!existsSync(testsDir)) return;

  for (const file of walkFiles(testsDir)) {
    if (!file.endsWith(".py")) continue;
    const original = readFileSync(file, "utf-8");
    const patched = original.replace(/\/app\//g, "./");
    if (patched !== original) {
      writeFileSync(file, patched, "utf-8");
    }
  }
}
```

### 6.4 验收标准

1. Windows、Linux、macOS 逻辑一致。
2. 没有 `.py` 文件时不报错。
3. 多层 tests 子目录能被递归处理。
4. `/app/` 被替换为 `./`。
5. 不再依赖 `find`、`sed`、shell 重定向。

---

## 7. Pack F：调整自动保护文件规则

### 7.1 背景

当前全局自动保护规则包含：

```ts
/tsconfig\.json$/
```

这会把 `tsconfig.json` 当作测试/验证文件保护。它不是测试文件，而是构建配置文件。某些 case 可能需要合法修改它。

### 7.2 修改文件

```text
packages/core/src/eval/runner.ts
packages/core/src/eval/fixtures/index.ts
```

### 7.3 建议修改

#### Step 1：从全局规则删除

删除：

```ts
/tsconfig\.json$/,
```

#### Step 2：case 级显式保护

对确实不允许修改 `tsconfig.json` 的 case，例如 `cb-fix-ts-type`，在 manifest 中加：

```ts
protectedFiles: ["tsconfig.json"],
```

这个 case 的 taskPrompt 已明确“不要修改 tsconfig.json”，expectedVerification 也要求“不应修改 tsconfig.json”，所以用 manifest 显式保护更合理。

### 7.4 验收标准

1. 默认情况下修改 `tsconfig.json` 不再自动触发测试文件保护。
2. `cb-fix-ts-type` 修改 `tsconfig.json` 仍会触发 protectedFiles gate。
3. 测试文件规则仍覆盖：
   - `*.test.ts`
   - `*.spec.ts`
   - `*_test.py`
   - `*_test.go`
   - `__tests__/`
   - `vitest/jest/playwright config`
   - `/test/`
   - `test_`

可考虑补充：

```ts
/conftest\.py$/,
/pytest\.ini$/,
```

但这类配置是否保护应谨慎，最好按 manifest 显式声明。

---

## 8. Pack G：补齐 Zod schema 并减少类型漂移

### 8.1 背景

`types.ts` 的 `EvalCaseManifest` 包含：

```ts
protectedFiles?: string[];
outOfBoundsCheckPaths?: string[];
requiredBinaries?: string[];
requiredPythonModules?: string[];
network?: boolean;
requires?: { ... };
```

但 `loader.ts` 的 Zod schema 只显式验证了部分字段，最后用 `.passthrough()` 放过未知字段。

### 8.2 修改文件

```text
packages/core/src/eval/loader.ts
packages/core/src/eval/types.ts
```

### 8.3 建议修改

在 `EvalCaseManifestSchema` 中显式加入：

```ts
protectedFiles: z.array(z.string()).optional(),
outOfBoundsCheckPaths: z.array(z.string()).optional(),
requiredBinaries: z.array(z.string()).optional(),
requiredPythonModules: z.array(z.string()).optional(),
network: z.boolean().optional(),
requires: z.object({
  toolchainProfile: z.string().optional(),
  tools: z.object({
    required: z.array(z.string()).optional(),
    recommended: z.array(z.string()).optional(),
    optional: z.array(z.string()).optional(),
  }).optional(),
  network: z.object({
    setup: z.boolean().optional(),
    agent: z.boolean().optional(),
    verifier: z.boolean().optional(),
  }).optional(),
}).optional(),
```

短期可保留 `.passthrough()`，防止外部扩展 manifest 破坏兼容；但核心字段必须显式验证。

中期目标：

```ts
export type EvalCaseManifest = z.infer<typeof EvalCaseManifestSchema>
```

如果直接替换会导致循环依赖，先不要强行做。可以先通过测试确保 schema 与 interface 不再漂移。

### 8.4 验收标准

1. `requiredBinaries: [123]` 应 validation fail。
2. `network: "yes"` 应 validation fail。
3. `requires.network.agent: "false"` 应 validation fail。
4. 合法 smoke / terminal-bench / swe-bench manifest 均通过。

---

## 9. Pack H：将 evalToolTracker 改为 per-case context

### 9.1 背景

当前 `tool-tracker.ts` 是模块级全局状态：

```ts
let enabled = false;
let callCount = 0;
let failureCount = 0;
```

当前 runner 是顺序 case，短期不一定出问题；但 runFixedEval 并发调用时会污染。

### 9.2 修改文件

```text
packages/core/src/eval/tool-tracker.ts
packages/core/src/eval/runner.ts
```

### 9.3 建议实现

将 tracker 改成类：

```ts
export class EvalToolTracker {
  private enabled = false;
  private callCount = 0;
  private failureCount = 0;

  enable() {
    this.enabled = true;
    this.callCount = 0;
    this.failureCount = 0;
  }

  disable() {
    this.enabled = false;
  }

  record(isError: boolean) {
    if (!this.enabled) return;
    this.callCount++;
    if (isError) this.failureCount++;
  }

  getStats() {
    return { calls: this.callCount, failures: this.failureCount };
  }
}
```

如果当前其他模块引用 `evalToolTracker.record()`，短期可以保留一个 AsyncLocalStorage 入口：

```ts
export const evalToolTrackerContext = new AsyncLocalStorage<EvalToolTracker>();

export function recordEvalToolCall(isError: boolean): void {
  evalToolTrackerContext.getStore()?.record(isError);
}
```

在 `runSingleCase()` 中：

```ts
const tracker = new EvalToolTracker();
return evalToolTrackerContext.run(tracker, async () => {
  tracker.enable();
  ...
});
```

如果当前项目没有工具层 instrumentation，仅 runner 内使用 tracker，可先做最小改造：每个 `runSingleCase()` 局部 new 一个 tracker，不再用单例。

### 9.4 验收标准

1. 两个 runFixedEval 并发执行时 tool stats 不互相污染。
2. 单个 case 的 tool stats 在 case 结束后稳定写入 artifact。
3. tracker disable 后不再记录。

---

## 10. Pack I：增强 SWE-bench materializer 错误信息

### 10.1 背景

当前 `git apply "__test.patch"` 失败时：

```ts
throw new EvalAssetExtractionError(
  `Failed to apply test_patch for ${manifest.id}: ${e}`,
);
```

没有明确 stdout/stderr/status。

### 10.2 修改文件

```text
packages/core/src/eval/materialize/swe-bench.ts
```

### 10.3 建议实现

```ts
try {
  execSync(`git apply "__test.patch"`, {
    cwd: workspaceDir,
    stdio: "pipe",
    timeout: 30000,
    encoding: "utf-8",
  });
} catch (e: unknown) {
  const err = e as Error & {
    stdout?: Buffer | string;
    stderr?: Buffer | string;
    status?: number;
    signal?: string;
  };

  const stdout = Buffer.isBuffer(err.stdout)
    ? err.stdout.toString("utf-8")
    : err.stdout ?? "";

  const stderr = Buffer.isBuffer(err.stderr)
    ? err.stderr.toString("utf-8")
    : err.stderr ?? "";

  throw new EvalAssetExtractionError(
    [
      `Failed to apply test_patch for ${manifest.id}`,
      `status: ${err.status ?? "unknown"}`,
      `signal: ${err.signal ?? "none"}`,
      stdout ? `stdout:\n${stdout.slice(0, 2000)}` : "",
      stderr ? `stderr:\n${stderr.slice(0, 2000)}` : "",
      `message: ${err.message}`,
    ].filter(Boolean).join("\n"),
  );
}
```

### 10.4 验收标准

1. patch apply 失败时 artifact / error 中包含 stderr。
2. 错误信息不超过合理长度。
3. 成功路径不受影响。
4. patch file cleanup 仍执行。建议用 `finally` 清理。

---

## 11. Pack J：修复 unsupported platform 的 official toolchain 判断

### 11.1 背景

`TOOL_MANIFEST_BY_PLATFORM` 对 `aix/android/freebsd/openbsd/sunos/cygwin/netbsd/haiku` 是空数组。当前 `getBenchmarkToolchainStatus()` 对空 manifest 可能返回 ready。

### 11.2 修改文件

```text
packages/core/src/eval/profile/installer.ts
packages/core/src/eval/runner.ts
```

### 11.3 建议实现

扩展 status：

```ts
export interface BenchmarkToolchainStatus {
  ready: boolean;
  unsupportedPlatform?: string;
  missingTools: string[];
  missingSha256: string[];
  versionMismatches: Array<{ name: string; expected: string; actual: string | null }>;
}
```

在 `getBenchmarkToolchainStatus()` 开头：

```ts
if (TOOL_MANIFEST.length === 0) {
  return {
    ready: false,
    unsupportedPlatform: process.platform,
    missingTools: [],
    missingSha256: [],
    versionMismatches: [],
  };
}
```

`formatBenchmarkToolchainReason()` 中加入：

```ts
if (status.unsupportedPlatform) {
  parts.push(`unsupported platform: ${status.unsupportedPlatform}`);
}
```

### 11.4 验收标准

1. unsupported platform 不得 ready。
2. Linux 原有行为不变。
3. Windows / macOS 因 sha256 缺失时 ready=false，missingSha256 正确展示。
4. sandbox fingerprint / fallbackReason 能显示 unsupported 或 missingSha256。

---

## 12. Pack K：改进 Supervisor prompt 的 patch diff 供给

### 12.1 背景

当前 patch diff 固定截断到 2000 字符：

```ts
patchDiff.length > 2000 ? patchDiff.slice(0, 2000) + "\n[... truncated]" : patchDiff
```

对于 SWE-bench 或多文件 case，可能只看到第一个文件的 diff。

### 12.2 修改文件

```text
packages/core/src/eval/runner.ts
```

可考虑新增：

```text
packages/core/src/eval/diff-summary.ts
```

### 12.3 建议实现

策略：

1. 仍保留完整 `patch.diff` artifact。
2. Supervisor prompt 中不要只给前 2000 字符。
3. 给出：
   - changed files 列表
   - diff 总行数
   - 每个文件的前 N 行 diff
   - 超长文件显示 truncation marker

伪代码：

```ts
function buildPatchSummaryForPrompt(patchDiff: string, opts = {
  maxTotalChars: 8000,
  maxPerFileChars: 1500,
}): string
```

输出形态：

```md
## Code Changes Summary

Changed files:
- src/a.ts
- tests/a.test.ts

Diff size: 312 lines

### src/a.ts
```diff
...
```

### tests/a.test.ts
```diff
...
```

[Diff truncated for prompt. Full diff is available in patch.diff artifact.]
```

### 12.4 验收标准

1. 小 diff 完整展示。
2. 多文件 diff 至少展示每个文件的文件名。
3. prompt 明确说明完整 diff 在 artifact 中。
4. 不超过合理 token 预算。
5. 不破坏中英文 prompt 逻辑。

---

## 13. Pack L：结构化 sandbox provider 异常

### 13.1 背景

`runCommandViaProvider()` 中：

```ts
const result = await provider.run(sandboxCmd);
```

如果 provider 抛异常，当前会向外抛，被 `runSingleCase()` 外层 catch 变成 `system_error`，不会生成完整 verifier artifact。

### 13.2 修改文件

```text
packages/core/src/eval/verifier.ts
```

### 13.3 建议实现

包裹 provider.run：

```ts
let result;
try {
  result = await provider.run(sandboxCmd);
} catch (err) {
  return {
    passed: false,
    verdict: "error",
    stdout: "",
    stderr: err instanceof Error ? err.message : String(err),
    exitCode: null,
    details: [
      "Sandbox provider threw during command verifier",
      err instanceof Error ? err.name : "UnknownError",
    ],
  };
}
```

`runScriptVerifier()` 的 provider.run 也同样处理。

### 13.4 验收标准

1. provider 抛异常时仍写出 `verifier.json`。
2. classifier 将该结果归为 `verifier_contract_failure` 或 `sandbox_failure`。
3. runSingleCase 不应因 verifier provider throw 丢失后续 artifact 写入。
4. timeout 仍按原逻辑处理。

---

## 14. 建议测试计划

### 14.1 单元测试

建议新增或扩展：

```text
packages/core/src/eval/__tests__/score-semantics.test.ts
packages/core/src/eval/__tests__/path-guards.test.ts
packages/core/src/eval/__tests__/objective-signals.test.ts
packages/core/src/eval/__tests__/supervisor-assessment.test.ts
packages/core/src/eval/__tests__/materialize-shared.test.ts
packages/core/src/eval/__tests__/verifier-provider-errors.test.ts
```

### 14.2 score-semantics 测试矩阵

| 场景 | 期望 |
|---|---|
| verifier pass | pass + score |
| verifier fail，pytest assertion | fail + scoreEligible |
| verifier error，timeout | infra / error + scoreIneligible |
| command not found | setup_failure + scoreIneligible |
| policy gate fail | fail + finalScore 0 |
| no verifier | skipped |

### 14.3 path-guards 测试矩阵

| 输入 | 期望 |
|---|---|
| `index.ts` | 允许 |
| `src/a.ts` | 允许 |
| `../secret` | 拒绝 |
| `/etc/passwd` | 拒绝 |
| `a\0b` | 拒绝 |
| Windows absolute path | 拒绝，除非 root 内解析后合法 |

### 14.4 objective-signals 测试矩阵

| 文件状态 | trackedChangedFiles | untrackedFiles | cleanGitDiff |
|---|---:|---:|---|
| clean | 0 | 0 | true |
| modified tracked | 1 | 0 | false |
| added untracked | 0 | 1 | false |
| modified + untracked | 1 | 1 | false |
| git unavailable | 0 | 0 | false + gitSignalError |

### 14.5 supervisor-assessment 测试矩阵

| 输出形态 | 期望 |
|---|---|
| 纯 JSON | 提取 |
| fenced JSON | 提取 |
| 多个 JSON | 找到 dimensions |
| 非 JSON | null |
| 0-100 分数 | 归一化 |
| 0-1 分数 | 保留 |
| 字符串分数 | 忽略 |

---

## 15. 建议执行顺序

请按以下顺序实施，避免后续 Pack 建立在错误语义上。

```text
Pack A  verifier error 评分语义
Pack B  路径 containment guard
Pack C  objectiveSignals / untracked files
Pack L  sandbox provider 异常结构化
Pack D  Supervisor JSON 提取
Pack E  Terminal-Bench 跨平台 patchTestPaths
Pack F  自动保护规则调整
Pack I  SWE-bench git apply 诊断
Pack G  Zod schema 补齐
Pack J  unsupported platform status
Pack K  Supervisor diff summary
Pack H  tool tracker / context 并发化
```

如果只能先做最小修复，优先做：

```text
A + B + C + L
```

这四项直接影响评测分数可信度和安全边界。

---

## 16. 每个 Pack 的提交要求

每个 Pack 提交时必须包含：

1. 修改说明。
2. 涉及文件列表。
3. 新增/更新测试。
4. 至少一个失败前 / 成功后的行为说明。
5. artifact 结构是否变更。
6. 是否影响历史 eval report 兼容性。

提交信息建议：

```text
fix(eval): classify verifier errors as score-ineligible infra outcomes
fix(eval): guard manifest-controlled paths within eval roots
fix(eval): include untracked files in objective signals
fix(eval): make supervisor assessment JSON extraction robust
```

---

## 17. 不要做的事情

1. 不要把 `verifierResult.verdict === "error"` 简单改成 `verifierSkipped=true`。
2. 不要删除 classifier；应增强 classifier。
3. 不要把所有 fail 都改成 infra_error。
4. 不要为了跨平台把所有 shell 命令都禁掉。Verifier command 本身可以是 shell 命令，但 materializer / installer 内部能用 Node API 的地方应优先用 Node API。
5. 不要让 manifest 可以指定任意绝对路径。
6. 不要让 unsupported platform 返回 official ready。
7. 不要只改类型不改 artifact；eval 系统必须能解释每个结果为什么被评分或不评分。

---

## 18. 完成后的验收清单

修复完成后，Agent 应输出一份验收报告，至少包含：

```md
# Covalo Eval 修复验收

## 修改范围
- ...

## 已完成 Pack
- [x] Pack A
- [x] Pack B
- ...

## 行为变化
- verifier error: ...
- path guard: ...
- objective signals: ...

## 测试结果
- typecheck: pass/fail
- unit tests: pass/fail
- smoke eval: pass/fail

## 剩余风险
- ...

## 兼容性说明
- ...
```

最终标准：

1. infra / verifier contract failure 不再污染 Worker 失败排名。
2. manifest-controlled path 不再能越界读写删。
3. 新增文件会进入 objectiveSignals 和 policy gate。
4. Supervisor JSON 提取对常见 LLM 输出稳定。
5. Terminal-Bench materializer 不依赖 POSIX-only sed/find。
6. SWE-bench patch apply 失败可诊断。
7. manifest schema 能验证核心字段类型。
8. unsupported platform 不会误报 official ready。
9. 所有新增行为都有测试或明确验收步骤。

---

## 19. Agent 执行提示词模板

下面这段可直接交给 coding agent：

```md
你正在修复 bzcsk2/covalo 的 eval 系统。请按照 `Covalo 评测系统修复实施 Spec` 执行，先完成 Pack A、Pack B、Pack C、Pack L 四项，不要改业务主引擎。

要求：
1. 修改前阅读：
   - packages/core/src/eval/runner.ts
   - packages/core/src/eval/verifier.ts
   - packages/core/src/eval/verifier-classifier.ts
   - packages/core/src/eval/workspace.ts
   - packages/core/src/eval/types.ts
2. 先补测试，再改实现，或至少每个 Pack 配对应测试。
3. 不允许把 verifier error 简单当成 skipped。
4. 所有 manifest-controlled path 必须 containment check。
5. objectiveSignals 必须统计 untracked files。
6. sandbox provider 抛异常必须写出结构化 verifier result。
7. 完成后输出：
   - 修改文件列表
   - 每个 Pack 的完成情况
   - 测试命令与结果
   - 剩余风险
```

---

## 20. 附录：原报告结论采纳情况

| 原报告问题 | 采纳状态 | 本 Spec 处理 |
|---|---|---|
| P0-E1 verifier error 评分 | 采纳但改修法 | Pack A |
| P0-E2 Windows git 编码 | 降级采纳 | Pack C |
| P0-E3 Zod schema 缺字段 | 降级采纳 | Pack G |
| P1-E1 Worker prompt 双逻辑 | 不采纳 | 当前仓库无对应文件 |
| P1-E2 extractAssessment 正则 | 采纳 | Pack D |
| P1-E3 evalToolTracker 全局 | 采纳但降级 | Pack H |
| P1-E4 sed/find Windows 不兼容 | 采纳 | Pack E |
| P1-E5 objectiveScore 默认值 | 部分采纳 | Pack C + Pack A |
| P1-E6 git apply 信息不足 | 采纳 | Pack I |
| P1-E7 tsconfig 自动保护 | 采纳 | Pack F |
| P2-E1 duplicate suite id | 不作为修复重点 | 当前 getSuite 已按 environmentId 区分 |
| P2-E2 手写 YAML parser | 暂不修 | 取决于 Terminal-Bench task.yaml 复杂度 |
| P2-E3 direct verifier env 全局 | 暂不修 | 可后续做 per-run option |
| P2-E4 macOS/Windows sha256 为空 | 采纳 | Pack J |
| P2-E5 current context 全局 | 采纳但后置 | Pack H |
| P2-E6 patchDiff 截断 | 采纳 | Pack K |
| P2-E7 python 优先 python3 | 暂不作为核心 | 可后续与 requiredBinaries 对齐 |
| file-assert 越界 | 强化采纳 | Pack B |
| fixtureSource 越界 | 强化采纳 | Pack B |
| outOfBoundsCheckPaths 危险删除 | 强化采纳 | Pack B |
```
