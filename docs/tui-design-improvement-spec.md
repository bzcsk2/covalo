# TUI 配色与布局改进 Spec

> 参考 `docs/index.html` 落地页的设计风格和配色，对项目 TUI 的布局和配色进行改进，让界面更加美观、协调。

---

## 1. 背景与目标

### 1.1 当前问题

TUI 当前存在以下设计问题：

1. **配色与落地页不统一**：`docs/index.html` 使用深蓝黑背景（`#0a0e1a`）+ 蓝紫渐变强调色（`#7c9eff` / `#b27cff`），而 TUI 用纯黑背景（`#050505`）+ 不同的蓝色（`#3b82f6`）和紫色（`#a855f7`），两者视觉风格割裂。
2. **前景色层级混乱**：`fg.body` 当前是 `#85a9ff`（蓝色），正文文字不应该是蓝色——这会让整屏文字偏蓝，与"正文应为中性灰白"的视觉习惯冲突。
3. **表面层级感弱**：`bgInput` 和 `bgCode` 都是 `#0c0c0c`，`bg` 和 `bgElev` 仅相差 `#050505` → `#0a0a0a`，卡片/输入框与背景几乎无区分。
4. **功能色过于刺眼**：`tone.ok` 是 `#00ff41`（霓虹绿），在深色终端上过于刺眼；`tone.err` 是 `#ef4444`（纯红），缺乏柔和感。
5. **硬编码颜色泄漏**：3 处硬编码绕过 token 系统——
   - `WorkflowStatusBar.tsx`：激活角色 Tab 文字色硬编码 `'#000'`
   - `WelcomeScreen.tsx`：`COVALO_COLORS` 数组 + 面板标题 `'#F59E0B'`
   - `BridgeConnected.tsx`：Ink 命名色 `"warning"` / `"error"`
6. **注释与实际值不一致**：`tokens.ts` 的注释（如"品牌绿 #00FF66"）与实际值（`#3b82f6` 蓝色）多处矛盾，误导维护者。

### 1.2 改进目标

- TUI 配色与 `docs/index.html` 落地页视觉统一
- 前景色、功能色、表面色三层级清晰可辨
- 消除所有硬编码颜色，统一走 token 系统
- 修正注释，使其与实际值一致

---

## 2. 配色方案

### 2.1 设计参考

落地页 `docs/index.html` 的 CSS 变量：

| CSS 变量 | 值 | 用途 |
|---|---|---|
| `--bg` | `#0a0e1a` | 主背景 |
| `--bg-2` | `#111726` | 次背景 |
| `--surface` | `rgba(255,255,255,0.03)` | 卡片表面 |
| `--border` | `rgba(255,255,255,0.08)` | 边框 |
| `--text` | `#e6edf3` | 主文字 |
| `--text-muted` | `#8b949e` | 次要文字 |
| `--accent` | `#7c9eff` | 品牌蓝 |
| `--accent-2` | `#b27cff` | 品牌紫 |
| `--accent-3` | `#56d364` | 成功绿 |
| `--accent-4` | `#ff9b50` | 警告橙 |

### 2.2 新 Token 配色表

以下为 `packages/tui/src/reasonix/tokens.ts` 中 `dark` 对象的新色值：

#### 前景色（fg）— 参考 GitHub Dark Dimmed

| token | 旧值 | 新值 | 用途 |
|---|---|---|---|
| `fg.strong` | `#e0e0e0` | `#e6edf3` | 标题/高亮文字（最亮） |
| `fg.body` | `#85a9ff` | `#c9d1d9` | 正文（中性灰白，不再偏蓝） |
| `fg.sub` | `#9ca3af` | `#8b949e` | 次要文字 |
| `fg.meta` | `#6b7280` | `#6e7681` | 元数据标签 |
| `fg.faint` | `#4b5563` | `#484f58` | 最淡文字（分隔线、辅助标记） |

**变更说明**：
- `fg.body` 从蓝色 `#85a9ff` 改为中性灰白 `#c9d1d9`，这是最重要的变更——正文文字不再偏蓝。
- `fg.strong` 从 `#e0e0e0` 提亮到 `#e6edf3`，与落地页 `--text` 一致。
- 其余微调，与落地页 `--text-muted` / `--text-dim` 对齐。

#### 功能色（tone）— 与落地页 --accent 系列统一

| token | 旧值 | 新值 | 用途 |
|---|---|---|---|
| `tone.brand` | `#3b82f6` | `#7c9eff` | 品牌蓝：提示符、主角色、StreamingCard 头部 |
| `tone.accent` | `#a855f7` | `#b27cff` | 品牌紫：Supervisor 角色、强调 |
| `tone.ok` | `#00ff41` | `#56d364` | 成功绿：Worker 角色、完成状态 |
| `tone.warn` | `#f59e0b` | `#ff9b50` | 警告橙：思考内容、待定状态 |
| `tone.err` | `#ef4444` | `#ff6b6b` | 错误红：失败状态（柔和，不刺眼） |
| `tone.info` | `#3b82f6` | `#7c9eff` | 信息蓝（同 brand） |

**变更说明**：
- `tone.brand` 从 `#3b82f6` 改为 `#7c9eff`（落地页 `--accent`），更柔和的蓝。
- `tone.accent` 从 `#a855f7` 改为 `#b27cff`（落地页 `--accent-2`），略偏蓝调。
- `tone.ok` 从霓虹绿 `#00ff41` 改为 `#56d364`（落地页 `--accent-3`），大幅降低刺眼感。
- `tone.warn` 从 `#f59e0b` 改为 `#ff9b50`（落地页 `--accent-4`），更偏橙。
- `tone.err` 从 `#ef4444` 改为 `#ff6b6b`，降低饱和度，更柔和。

#### 表面色（surface）— 增强层级感

| token | 旧值 | 新值 | 用途 |
|---|---|---|---|
| `surface.bg` | `#050505` | `#0a0e1a` | 终端大背景（深蓝黑） |
| `surface.bgInput` | `#0c0c0c` | `#111726` | 输入框/卡片背景 |
| `surface.bgCode` | `#0c0c0c` | `#0d1220` | 代码块背景 |
| `surface.bgElev` | `#0a0a0a` | `#161d2e` | 面板/弹窗背景 |

**变更说明**：
- 从纯黑系（`#050505` ~ `#0c0c0c`，差值仅 7）改为深蓝黑系（`#0a0e1a` ~ `#161d2e`，差值 28），层级感大幅增强。
- 4 个表面色之间有明显亮度梯度：`bg` < `bgCode` < `bgInput` < `bgElev`。
- 与落地页 `--bg` / `--bg-2` 一致。

---

## 3. 实施任务

### Task 1: 更新 `tokens.ts` 核心配色

**文件**：`packages/tui/src/reasonix/tokens.ts`

**改动**：
1. 更新 `dark` 对象的 17 个色值（5 fg + 6 tone + 4 surface + 重复的 2 个）
2. 更新文件顶部的接口注释（`@field tone` 中"品牌绿"改为"品牌蓝"）
3. 更新 `dark` 对象上方的块注释（配色思路、色值表）
4. 更新 `FG` / `TONE` / `SURFACE` 代理的 JSDoc 注释

**验证**：
- `bun run typecheck` 通过
- 现有测试 `packages/tui/__tests__/` 全部通过（颜色值变化不影响测试断言，因为测试不检查具体色值）

### Task 2: 修复 `WorkflowStatusBar.tsx` 硬编码颜色

**文件**：`packages/tui/src/components/workflow/WorkflowStatusBar.tsx`

**当前问题**（第 185、196 行）：
```tsx
<Text bold color={activeRole === 'supervisor' ? '#000' : FG.sub}>
  Supervisor
</Text>
```
激活角色 Tab 用 `TONE.brand` / `TONE.ok` 作背景色，文字色硬编码 `'#000'`（黑色）。新配色下 `TONE.brand` 是 `#7c9eff`（中亮度蓝），黑色文字在其上对比度尚可，但不如用深色背景文字统一。

**改动**：
- `'#000'` 替换为 `SURFACE.bg`（`#0a0e1a`），与终端大背景一致的深色，在亮色 Tab 背景上有良好对比度。

**验证**：视觉检查 Supervisor/Worker Tab 激活时文字可读。

### Task 3: 修复 `WelcomeScreen.tsx` 硬编码颜色

**文件**：`packages/tui/src/WelcomeScreen.tsx`

**当前问题**：
1. 第 24 行 `COVALO_COLORS` 数组：9 个硬编码蓝色渐变色，用于 ASCII art 着色
2. 第 50 行面板标题色 `'#F59E0B'`（硬编码琥珀色）

**改动**：
1. `COVALO_COLORS` 数组改为用 `TONE.brand` 和 `TONE.accent` 生成的渐变：
   ```ts
   // 从品牌蓝到品牌紫的渐变，与落地页 --gradient 一致
   const COVALO_COLORS = [
     '#7c9eff', '#8b8ffe', '#9a7ffd', '#a97ffc',
     '#b87ffb', '#c77ffa', '#d67ff9', '#e57ff8', '#f27ff7',
   ];
   ```
   保留为本地常量（因为这是 ASCII art 的特殊渐变，不需要全局 token 化）。
2. `'#F59E0B'` 替换为 `TONE.warn`（`#ff9b50`），与 token 系统一致。

**验证**：视觉检查 Welcome 屏幕 ASCII art 渐变效果和面板标题色。

### Task 4: 修复 `BridgeConnected.tsx` Ink 命名色

**文件**：`packages/tui/src/BridgeConnected.tsx`

**当前问题**（第 148、153 行）：
```tsx
<Text color="warning">...</Text>
<Text color="error">...</Text>
```
使用 Ink 内置命名色 `"warning"` / `"error"`，绕过 token 系统。

**改动**：
- `"warning"` 替换为 `TONE.warn`
- `"error"` 替换为 `TONE.err`

**验证**：`bun run typecheck` 通过。

### Task 5: 更新 `FullscreenLayout.tsx` 分隔线

**文件**：`packages/tui/src/FullscreenLayout.tsx`

**当前**：顶部和中间分隔线用 `FG.faint`（`#4b5563` → `#484f58`）。

**改动**：无代码改动。`FG.faint` 通过 token 代理自动获取新值 `#484f58`，无需修改。

**说明**：此 Task 仅用于记录验证——确认分隔线在新配色下视觉柔和但不消失。

---

## 4. 不改动的部分

以下明确不在本次改动范围内：

1. **`theme/` 目录（Gemini 派生主题系统）**：仅被 3 个组件（LoadingIndicator、ThemedGradient、hljs 代码高亮）使用，与 `reasonix/tokens.ts` 是独立系统。本次只统一 `reasonix/tokens.ts`，不合并两套系统（避免大范围回归风险）。
2. **`/theme` 命令**：仍只切换 Gemini 主题，不影响 `reasonix/tokens.ts`。
3. **Light 主题**：`setActiveTheme()` 已就绪但无 light 实现，本次不新增。
4. **布局结构**：不调整 `App.tsx` 的组件排列、`FullscreenLayout` 的 flex 结构。只改配色。
5. **组件 props / 交互逻辑**：不改变任何组件的行为，只改颜色值。

---

## 5. 影响范围

### 5.1 直接影响的文件

| 文件 | 改动类型 |
|---|---|
| `packages/tui/src/reasonix/tokens.ts` | 色值 + 注释 |
| `packages/tui/src/components/workflow/WorkflowStatusBar.tsx` | 替换 `'#000'` → `SURFACE.bg` |
| `packages/tui/src/WelcomeScreen.tsx` | 替换 `COVALO_COLORS` 渐变 + `'#F59E0B'` → `TONE.warn` |
| `packages/tui/src/BridgeConnected.tsx` | 替换 `"warning"` / `"error"` → `TONE.warn` / `TONE.err` |

### 5.2 间接受益的文件（通过 token 代理自动生效）

以下 37 个文件引用 `FG` / `TONE` / `SURFACE`，无需修改即可自动获取新配色：

- `StatusBar.tsx`、`DeepiMessages.tsx`、`DeepiPromptInput.tsx`、`FullscreenLayout.tsx`
- `components/workflow/WorkflowStatusBar.tsx`（色值部分）
- `components/shared/LoadingIndicator.tsx`（仅部分用 token）
- 其余 32 个组件

### 5.3 不受影响的文件

- `packages/core/`、`packages/tools/`、`packages/cli/`、`packages/security/`、`packages/memory/`、`packages/plugin/` — 不引用 TUI 的 token 系统。
- `packages/tui/src/theme/` — Gemini 主题系统独立，不受 `tokens.ts` 影响。

---

## 6. 验证计划

### 6.1 TypeCheck

```bash
bun run typecheck
```

### 6.2 单元测试

```bash
bun test packages/tui/__tests__/ --timeout 30000
```

预期：全部通过。测试不检查具体色值，只检查组件渲染行为。

### 6.3 视觉验证

启动 TUI 手动检查：

```bash
bun run dev
```

检查清单：
- [ ] Welcome 屏幕 ASCII art 蓝紫渐变（不再纯蓝）
- [ ] 输入框 `❯` 提示符为品牌蓝 `#7c9eff`
- [ ] 输入框背景与终端背景有区分（`#111726` vs `#0a0e1a`）
- [ ] 状态栏 agent 名为品牌蓝
- [ ] 消息时间线 Worker 角色圆点为绿色 `#56d364`（不再刺眼）
- [ ] 消息时间线 Supervisor 角色圆点为紫色 `#b27cff`
- [ ] WorkflowStatusBar 激活 Tab 文字在亮色背景上可读
- [ ] 思考内容标记 `∴` 为琥珀色 `#ff9b50`
- [ ] 错误信息为柔和红 `#ff6b6b`（不再刺眼）
- [ ] 分隔线 `─` 柔和但不消失

---

## 7. 回滚方案

如新配色不满意，回滚方式：

```bash
git revert <commit-hash>
```

或手动恢复 `tokens.ts` 的 `dark` 对象到旧值。

---

## 8. 实施顺序

1. **Task 1**：更新 `tokens.ts`（核心改动，1 个文件）
2. **Task 2-4**：修复 3 个文件的硬编码颜色（并行，互不依赖）
3. **Task 5**：无需改动，仅验证
4. 运行 typecheck + 测试
5. 视觉验证
6. 提交 PR
