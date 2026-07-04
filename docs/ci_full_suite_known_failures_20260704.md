# CI Full Suite 已知失败清单

**生成时间**: 2026-07-04
**本地实测**: 2270 pass / 33 skip / 27 fail（Windows 本机，bun 1.3.14）
**CI workflow**: [.github/workflows/ci.yml](file:///d:/Proj/covalo/.github/workflows/ci.yml) — 三平台矩阵（ubuntu/macos/windows），`fail-fast: false`，`Run test suite` step 任一平台失败即整 PR 红灯，后续 build/smoke/package/probe 全部 skipped。

**背景**：PR #27/#29/#30/#31 都遇到 "PR focused tests 通过 / full suite 失败 / 后续 skipped" 同一模式。本文档列出 27 个失败测试及根源，作为后续修复依据。

---

## 失败分类总览

| 分类 | 数量 | 根源 | 修复难度 |
|------|------|------|----------|
| A. POSIX/Linux-only 工具缺失 | 12 | Windows/macOS runner 没有 `bwrap`/`timeout`/`which` | 中（加平台 skip） |
| B. 网络依赖测试 | 6 | CI 网络偶发不稳定，外部 URL 不可达 | 中（加网络可达性检查） |
| C. 测试代码自身 bug | 2 | 测试引用了不存在的 API 或过期导出名 | 低（已在本 PR 修 1 个） |
| D. Windows 平台行为差异 | 4 | `cat`/路径分隔符/文件检测行为不同 | 中（加平台条件） |
| E. hash-edit 实现 bug | 1 | `CL-12: rejects binary file` 在 Windows 不触发 | 中 |
| F. 已修（PR #31 引入回归） | 2 | SFR-00 + sensitive.test.ts import（已在本 PR 修复） | 已完成 |

---

## A. POSIX/Linux-only 工具缺失（12 个）

### A1. native sandbox fixture verifier contract（3 个）

**文件**: `packages/sandbox/__tests__/native-sandbox-fixture-verifier.test.ts`（路径需确认）
**失败测试**:
- `verifier output does not contain 'No tests found' when run against fixture workspace`
- `baseline (unfixed) fixtures should fail for business-logic reasons, not infra`
- `verifier edge cases > should produce error on command timeout`

**根源**: 依赖 `bwrap`（Linux bubblewrap 容器工具）。Windows 和 macOS runner 没有 `bwrap`，所有 sandbox 后端测试必然失败。`timeout` 命令也是 POSIX 专属。

**修复建议**:
- 在 `beforeEach` 加 `if (process.platform === 'win32' || process.platform === 'darwin') return this.skip()`
- 或用 `bun:test` 的 `it.skipIf(process.platform !== 'linux')`

### A2. workspace creation / soft-workspace（5 个）

**文件**: `packages/sandbox/__tests__/workspace.test.ts`、`soft-workspace.test.ts`
**失败测试**:
- `workspace creation > should create a workspace directory for a case`
- `workspace creation > should handle manifest with no fixture path`
- `soft-workspace > run sets HOME to cwd`
- `soft-workspace > run passes env vars`
- `provider-registry > detectBestProvider('sandbox.benchmark') prefers bwrap over soft-workspace when bwrap available`

**根源**: 同 A1，sandbox 后端在非 Linux 平台不可用。

**修复建议**: 同 A1。

### A3. Server Resolver（1 个）

**失败测试**: `Server Resolver > should resolve command that exists in PATH`

**根源**: 测试用 `which` 命令检测 PATH 中的可执行文件，`which` 是 POSIX 专属。Windows 用 `where`。

**修复建议**: 在 `server-resolver.ts` 或测试中根据平台选择 `which`/`where`，或测试加平台 skip。

### A4. 真实来源覆盖（1 个）

**失败测试**: `真实来源覆盖 > 终端 bench manifest 数量等于锁文件条目数`

**根源**: 同 A1，依赖 sandbox bench 工具链，Windows 不可用。

---

## B. 网络依赖测试（6 个）

### B1. M12: WebFetch full flow（6 个）

**文件**: `packages/tools/__tests__/web-fetch.test.ts`（或 webfetch.test.ts）
**失败测试**:
- `should handle normal HTTPS URL`
- `should upgrade HTTP to HTTPS`
- `should handle redirect (follow by default)`
- `should convert HTML to markdown`
- `should reject content >10MB`
- `should truncate output at max_length`

**根源**: 这些测试需要真实 HTTPS 访问外部 URL。CI runner 网络偶发不稳定时全部失败。

**修复建议**:
- 用 `nock`/`msw` mock HTTP 响应，或在 `beforeAll` 加网络可达性检查（如 `fetch('https://example.com', { signal: AbortSignal.timeout(2000) })`），不可达时 `describe.skip`
- 或测试本身改为离线 fixture

---

## C. 测试代码自身 bug（2 个，1 个已修）

### C1. ~~sensitive.test.ts import 失效~~（已修）

**文件**: `packages/tools/__tests__/sensitive.test.ts`
**失败测试**: 整个文件 SyntaxError，连带 `write_file tool > should reject sensitive paths` (4 个) 失败
**根源**: 测试 `import { SENSITIVE_FILE_PATTERNS }`，但源码早已重命名为 `SENSITIVE_READ_PATTERNS`/`SENSITIVE_WRITE_PATTERNS`。
**状态**: **PR #31 已修** — 改为 `import { SENSITIVE_READ_PATTERNS, SENSITIVE_WRITE_PATTERNS }`，新增对应 describe 块。

### C2. ~~edit.test.ts hashAnchoredReplaceOnce~~（已修）

**文件**: `packages/tools/__tests__/edit.test.ts`
**失败测试**: `fuzzyReplaceOnce > hashAnchoredReplaceOnce should delete old_string when newString is empty`
**根源**: commit `e31809d`（冗余代码清理）删除了 `hash-edit.ts`，但测试代码还在调用 `hashAnchoredReplaceOnce`，函数已不存在。
**状态**: **PR #31 已修** — 改为通过 `createEditTool().execute({ old_string, new_string: "" })` 验证删除行为，验证 `replaced: 1` 和文件内容。

---

## D. Windows 平台行为差异（4 个）

### D1. bash tool cwd 解析（1 个）

**失败测试**: `bash tool > should resolve cwd relative to ctx.cwd`
**文件**: `packages/tools/__tests__/bash.test.ts:125-130`
**根源**: 测试用 `cat test.txt` 验证 cwd 解析。Windows runner 默认 shell 没有 `cat`（PowerShell 用 `Get-Content`），命令失败返回非零。
**修复建议**: 测试改用跨平台命令（如 `node -e "console.log(require('fs').readFileSync('test.txt','utf8'))"`），或加平台 skip。

### D2. grep sensitive 过滤（2 个）

**失败测试**:
- `grep > filters out sensitive files from grep results when searching a directory`
- `grep > non-sensitive dot files are searchable`

**根源**: Windows 路径分隔符 `\` 与 POSIX `/` 不同，grep 工具内部路径处理在 Windows 上行为不同，导致 sensitive 文件过滤逻辑失败。
**修复建议**: 检查 `packages/tools/src/grep.ts` 中路径归一化逻辑，或测试 fixture 改为跨平台路径。

### D3. CL-12: Hash edit rejects binary file（1 个）

**失败测试**: `CL-12: Hash edit sampling and stream close > rejects binary file`
**文件**: `packages/tools/__tests__/edit.test.ts:400-410`
**根源**: 测试写入二进制 buffer 到文件，期望 edit tool 检测到二进制并拒绝。Windows 上 `readFile`/`stat` 对二进制文件的检测结果与 POSIX 不同，可能不触发拒绝逻辑。
**修复建议**: 检查 `packages/tools/src/edit.ts` 的二进制检测逻辑（应基于字节内容而非平台 API），或测试加平台 skip。

---

## E. PR #31 引入的回归（2 个，已修）

### E1. ~~SFR-00: Supervisor toolNames 回归~~（已修）

**文件**: `packages/core/__tests__/supervisor-request-contract.test.ts:91`
**失败测试**: `[SFR-30] Supervisor alone 模式应暴露 5 个只读工具`
**根源**: PR #31 S1-5 修复给 supervisor agent 注册了显式 `toolNames`，但违背了 SFR-30 设计契约——`toolNames` 应为 `undefined`，由 `resolveEffectiveTools` 的 phase/mode 策略统一计算（`SUPERVISOR_TOOLS_ALONE` / `SUPERVISOR_TOOLS_SUBAGENT` / `supervisorLoopToolsForPhase`）。
**状态**: **PR #31 已修** — 删除 supervisor 的显式 `toolNames`，回退到 `undefined`。同时删除对应的 `agent-supervisor-toolnames.test.ts`（它验证的是错误方向）。工具上界防护实际由 `resolveEffectiveTools` 中的 set 集合实现，不需要在 agent.ts 重复声明。

---

## 修复优先级建议

### P0（已修，PR #31 闭合）
- C1 sensitive.test.ts import
- C2 edit.test.ts hashAnchoredReplaceOnce
- E1 SFR-00 supervisor toolNames 回归

### P1（适合下一个 PR，平台 skip）
- A1-A4 sandbox/POSIX 工具测试（12 个）— 加 `process.platform` skip 条件
- D1 bash cwd 测试（1 个）— 改跨平台命令
- D2 grep sensitive 测试（2 个）— 修路径归一化

### P2（适合独立 PR）
- B1 WebFetch 网络测试（6 个）— mock HTTP 或加网络可达性检查
- D3 CL-12 binary file 测试（1 个）— 修二进制检测逻辑

---

## 验证命令

```bash
# 跑 PR-focused tests（必须全绿）
bun test packages/core/__tests__/streaming-executor.test.ts packages/core/__tests__/e2e.test.ts packages/core/__tests__/text-parsers.test.ts packages/core/__tests__/repair.test.ts packages/security/__tests__/hooks.test.ts packages/security/__tests__/permission.test.ts --timeout 30000

# 跑 full suite（预期 27 fail，与本文档一致）
bun test packages/core/__tests__/ packages/security/__tests__/ packages/tools/__tests__/ packages/tui/__tests__/ packages/cli/__tests__/ --timeout 30000
```
