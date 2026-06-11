/**
 * OpenTUI 渲染入口（使用本地 /vol4/Agent/opentui 源码）
 *
 * 注意：本地 @opentui/react 的 API 与 npm 0.2.x 版本不同。
 * 正确用法是：createCliRenderer() + createRoot()
 *
 * 重要：由于 @opentui/react 使用自己的 React 实例，本包不能使用任何 React Hook。
 * 所有状态通过外部订阅管理，通过 props 传递给组件。
 */

import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import type { TuiState } from "./store/types.js"
import { tuiStore, replayEvents, sampleOrchestrationFixture } from "./store/index.js"
import { OrchestrationDashboard } from "./components/dashboard/OrchestrationDashboard.js"

export interface OpenTUIAppProps {
  state: TuiState;
}

// 纯函数组件，不包含任何 Hook
export function OpenTUIApp({ state }: OpenTUIAppProps) {
  const terminalWidth = process.stdout.columns || 120

  return (
    <box style={{ flexDirection: "column", height: "100%" }}>
      <box style={{ padding: 1, backgroundColor: "#24283b" }}>
        <text bold color="#c0caf5">Deepreef · OpenTUI (本地源码模式)</text>
      </box>
      <OrchestrationDashboard terminalWidth={terminalWidth} state={state} />
      <box style={{ padding: 1 }}>
        <text color="#787c99">按 Ctrl+C 退出</text>
      </box>
    </box>
  )
}

export async function startOpenTUI(): Promise<void> {
  // 初始化 fixture 数据
  replayEvents(sampleOrchestrationFixture)

  const cliRenderer = await createCliRenderer({
    exitOnCtrlC: true,
    targetFps: 30,
  })
  const root = createRoot(cliRenderer)

  // 外部订阅：状态变化时重新渲染整个 App
  // 这是避免多 React 实例 hook 冲突的最简单方式
  let currentState = tuiStore.getState()

  const renderApp = () => {
    root.render(<OpenTUIApp state={currentState} />)
  }

  // 首次渲染
  renderApp()

  // 订阅后续更新
  tuiStore.subscribe((newState) => {
    currentState = newState
    renderApp()
  })
}