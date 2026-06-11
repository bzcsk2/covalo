/**
 * OrchestrationDashboard
 *
 * 三栏总览：Local Workers / Supervisor / Loop State
 * 这是 OpenTUI 的核心可视化入口。
 *
 * 样式说明（中文）：
 * - 面板背景使用 colors.bg.secondary，便于与主背景区分
 * - 边框使用 border.normal，聚焦态可切换为 border.focus
 * - 状态颜色严格来自 colors.status / colors.task，保证全局一致
 * - 后续手动调整三栏比例时，只需修改 flex 或 layout.panelGap
 */

import type { TuiState } from "../../store/types.js";
import { colors } from "../../theme/colors.js";
import { layout } from "../../theme/layout.js";

export interface OrchestrationDashboardProps {
  terminalWidth: number;
  state: TuiState;
}

export function OrchestrationDashboard({ state }: OrchestrationDashboardProps) {
  const workers = Object.values(state.workers);
  const supervisors = Object.values(state.supervisors);
  const loop = state.loop;

  return (
    <box style={{ flexDirection: "row", gap: layout.panelGap }}>
      {/* Local Workers 面板 */}
      <box
        style={{
          flex: 1,
          borderStyle: "single",
          borderColor: colors.border.normal,
          backgroundColor: colors.bg.secondary,
          padding: layout.padding.content,
        }}
      >
        <text bold color={colors.fg.primary}>Local Workers ({workers.length})</text>
        {workers.length === 0 && <text color={colors.fg.muted}>暂无 Worker</text>}
        {workers.slice(0, layout.maxVisibleRows).map(w => (
          <text key={w.id} color={colors.task[w.status] ?? colors.fg.primary}>
            {w.status === "running" ? "◉" : "○"} {w.modelTarget} {w.status} {w.currentTask ?? ""} {(w.elapsedMs / 1000).toFixed(0)}s
          </text>
        ))}
      </box>

      {/* Supervisor 面板 */}
      <box
        style={{
          flex: 1,
          borderStyle: "single",
          borderColor: colors.border.normal,
          backgroundColor: colors.bg.secondary,
          padding: layout.padding.content,
        }}
      >
        <text bold color={colors.fg.primary}>Supervisor ({supervisors.length})</text>
        {supervisors.length === 0 && <text color={colors.fg.muted}>暂无 Supervisor</text>}
        {supervisors.slice(0, layout.maxVisibleRows).map(s => (
          <text key={s.id} color={colors.status[s.status] ?? colors.fg.primary}>
            ◆ {s.modelTarget} {s.status} {s.reviewingWorkerId ? `reviewing ${s.reviewingWorkerId}` : ""}
          </text>
        ))}
      </box>

      {/* Loop State 面板 */}
      <box
        style={{
          flex: 1,
          borderStyle: "single",
          borderColor: colors.border.normal,
          backgroundColor: colors.bg.secondary,
          padding: layout.padding.content,
        }}
      >
        <text bold color={colors.fg.primary}>Loop State</text>
        <text color={colors.status.info}>
          {loop.phase} · attempt {loop.attempt}
        </text>
        {loop.lastTransition && (
          <text color={colors.fg.muted}>
            {loop.lastTransition.from} → {loop.lastTransition.to}
          </text>
        )}
      </box>
    </box>
  );
}
