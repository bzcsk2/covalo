/** Theme tokens adapted from Reasonix for covalo.
 *  Colors are cast to `any` because @covalo/ink's type system expects
 *  Color | keyof Theme, but hex strings work at runtime. */

/**
 * 主题颜色令牌接口。
 * @remarks 修改此接口或 dark 对象中的色值即可全局更改 TUI 配色。
 *
 * @field fg     - 前景色层级：strong（最亮，标题）→ body（正文）→ sub（次要文字）→ meta（元数据）→ faint（最淡，辅助标记）
 * @field tone   - 功能色调：brand（品牌蓝，流式卡片头部）→ accent（品牌紫，强调）→ ok（成功绿）→ warn（警告橙）→ err（错误红）→ info（信息蓝）
 * @field surface - 表面色层级：bg（最底层，大背景）→ bgInput（输入框底色）→ bgCode（代码块底色）→ bgElev（弹起卡片，卡片容器）
 */
export interface ThemeTokens {
  fg: { strong: string; body: string; sub: string; meta: string; faint: string };
  tone: { brand: string; accent: string; ok: string; warn: string; err: string; info: string };
  surface: { bg: string; bgInput: string; bgCode: string; bgElev: string };
}

/**
 * 深色主题颜色定义 — 与项目落地页（docs/index.html）配色统一。
 * 所有组件通过 FG / TONE / SURFACE 代理引用此处色值，修改此对象即可全局换肤。
 *
 * 配色思路：深蓝黑画布（bg: #0a0e1a）、蓝紫渐变强调色（brand/accent: #7c9eff/#b27cff）、
 * 琥珀警告色（warn: #ff9b50），与 docs/index.html 的 CSS 变量保持一致。
 *
 * 前景色层级（参考 GitHub Dark Dimmed）：
 * - fg.strong    (#e6edf3) 标题/高亮文字（最亮）
 * - fg.body      (#c9d1d9) 正文（中性灰白，不再偏蓝）
 * - fg.sub       (#8b949e) 次要文字（gray-400）
 * - fg.meta      (#6e7681) 元数据标签（gray-500）
 * - fg.faint     (#484f58) 最淡文字（gray-600，用于分隔线、辅助标记）
 *
 * 功能色调（参考落地页 --accent 变量）：
 * - tone.brand   (#7c9eff) 品牌蓝：StreamingCard 头部、主角色、提示符
 * - tone.accent  (#b27cff) 品牌紫：强调色、活动状态、Supervisor 角色
 * - tone.ok      (#56d364) 成功绿：完成状态、Worker 角色
 * - tone.warn    (#ff9b50) 警告琥珀：待定状态、思考内容
 * - tone.err     (#ff6b6b) 错误红：失败状态（柔和，不刺眼）
 * - tone.info    (#7c9eff) 信息蓝（同 brand）
 *
 * 表面色层级（参考落地页 --bg / --surface 变量）：
 * - surface.bg      (#0a0e1a) 终端大背景（深蓝黑）
 * - surface.bgInput (#111726) 输入框/卡片背景（略亮于 bg）
 * - surface.bgCode  (#0d1220) 代码块背景（略暗于 bgInput）
 * - surface.bgElev  (#161d2e) 面板/弹窗背景（最亮，层级感清晰）
 */
const dark: ThemeTokens = {
  fg: { strong: '#e6edf3', body: '#c9d1d9', sub: '#8b949e', meta: '#6e7681', faint: '#484f58' },
  tone: { brand: '#7c9eff', accent: '#b27cff', ok: '#56d364', warn: '#ff9b50', err: '#ff6b6b', info: '#7c9eff' },
  surface: { bg: '#0a0e1a', bgInput: '#111726', bgCode: '#0d1220', bgElev: '#161d2e' },
};

// 仅在运行时需要切换主题时使用（例如用户设置偏好），当前始终使用 dark。
let activeTheme: ThemeTokens = dark;

/**
 * 切换当前主题。修改后所有通过 FG / TONE / SURFACE 代理读取的值将立即反映新主题。
 * @param theme - 新的主题令牌对象
 */
export function setActiveTheme(theme: ThemeTokens): void { activeTheme = theme; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
/**
 * 创建响应式颜色令牌代理。
 * 通过 Proxy 将属性读取转发到 activeTheme，使得组件可以像访问普通对象一样使用颜色，
 * 且切换主题后无需重新渲染即可自动获取新色值。
 *
 * @param select - 从 ThemeTokens 中选取要代理的子对象（fg / tone / surface）
 * @returns 一个 Proxy 包装的对象，所有属性读取都会返回 activeTheme 中的对应值
 *
 * @remarks 返回类型为 any 是因为 Ink 的 color 属性接受 `Color | keyof Theme`，
 *          但 hex 字符串在运行时正常工作，类型声明与实际行为不一致。
 */
function proxyTokens(select: (t: ThemeTokens) => any): any {
  const target = select(dark);
  return new Proxy(target, {
    get: (_, prop: string | symbol) => select(activeTheme)[prop as string],
  });
}

/**
 * 全局前景色代理。等同于 `activeTheme.fg`，但切换主题后自动更新。
 * - FG.strong → 标题/高亮（#e6edf3）
 * - FG.body   → 正文（#c9d1d9）
 * - FG.sub    → 次要文字（#8b949e）
 * - FG.meta   → 元数据（#6e7681）
 * - FG.faint  → 最淡文字（#484f58）
 */
export const FG: any = proxyTokens(t => t.fg);

/**
 * 全局功能色调代理。等同于 `activeTheme.tone`，切换主题后自动更新。
 * - TONE.brand  → 品牌蓝（#7c9eff），流式卡片头部、提示符
 * - TONE.accent → 品牌紫（#b27cff），强调、Supervisor 角色
 * - TONE.ok     → 成功绿（#56d364），Worker 角色、完成状态
 * - TONE.warn   → 警告琥珀（#ff9b50），思考内容、待定状态
 * - TONE.err    → 错误红（#ff6b6b），失败状态
 * - TONE.info   → 信息蓝（#7c9eff，同 brand）
 */
export const TONE: any = proxyTokens(t => t.tone);

/**
 * 全局表面色代理。等同于 `activeTheme.surface`，切换主题后自动更新。
 * - SURFACE.bg      → 大背景（#0a0e1a，深蓝黑）
 * - SURFACE.bgInput → 输入框/卡片背景（#111726）
 * - SURFACE.bgCode  → 代码块背景（#0d1220）
 * - SURFACE.bgElev  → 面板/弹窗背景（#161d2e）
 */
export const SURFACE: any = proxyTokens(t => t.surface);
