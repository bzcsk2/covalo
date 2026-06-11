/**
 * 状态订阅工具（非 React Hook 版本）
 *
 * 设计要点：
 * - 由于 @opentui/react 和本地 React 实例冲突，暂不使用 useSyncExternalStore
 * - 使用传统的 subscribe + forceUpdate 模式，通过 createRoot 的 render 触发更新
 * - 后续如需优化，可将整个 App 作为单一订阅者，而非每个组件单独订阅
 */

import type { Store } from "./create-store.js";

export function subscribeStore<T>(store: Store<T>, callback: (state: T) => void): () => void {
  return store.subscribe(callback);
}