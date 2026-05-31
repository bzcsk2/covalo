# Deepicode Bug 跟踪与修复指南

**最后更新**: 2026-05-31（N1-N14 修复完成）

> **历史审计记录，不是当前开发队列。** 多个条目已经失效。开始开发前以 `TODO.md` 为唯一入口，并核对 `DONE.md`。
> 已修复项 → `DONE.md` ｜ 当前待办与暂缓项 → `TODO.md`

---

## 历史审计条目（可能已失效）

| # | 问题 | 位置 | 优先级 |
|---|------|------|--------|
| B6 | SessionLoader 恢复时系统消息重复 | `core/src/session.ts` | P1 |
| B5 | repair.ts 1e+1f 组合策略缺失 | `core/src/context/repair.ts` | P2 |
| L2 | SessionWriter 队列无界增长 | `core/src/session.ts:114-142` | P2 |
| L5 | fuzzy-edit/hash-edit 未归一化 CRLF | `tools/src/fuzzy-edit.ts`, `hash-edit.ts` | P2 |
| L9 | reasoningText 消失导致布局跳动 | `tui/src/bridge.tsx:180-189` | P2 |
| — | Bash 确认 UI 4 个 Bug（U1-U4） | 多文件 | P1 |
| N5 | MCP auth `set` 接收明文 `api_key`（当前已返回 not_implemented，暂不处理） | `mcp/src/auth.ts` | P3 |
| N14 | API 重试未覆盖网络级错误（现有 catch 块已覆盖，经验证） | `core/src/client.ts` | 已验证 |

---

## 本轮审查——驳回项

| 来源 | 编号 | 原描述 | 驳回理由 |
|------|------|--------|---------|
| v4 | C1 | write_file 未从 index.ts 导出 | **误判**。代码中已 `export { createWriteFileTool } from "./write-file.js"` |
| v4 | C3 | MCP 超时硬编码 30s 不可配置 | 降级（已知 tradeoff）。30s 对当前场景足够 |
| pkg | 1.8 | AbortSignal 未传给工具 | **误判**。`ToolContext.signal` 已存在且 `ctx.signal` 已传给各工具 |
| pkg | 1.5 | Windows bash 不兼容 | 非目标平台 |
| v4 | H1 | bash OOM 无界内存 | 降级。`maxChars` 已有默认 200K 限制，截断前 OOM 场景极罕见 |
| v4 | H4 | 会话文件无写锁 | 已知限制。单用户单实例场景不触发 |
| v4 | H6 | 临时文件权限 | 降级。非安全关键路径 |
| v4 | M2 | SSE 不支持 `\r\n` | 降级。DeepSeek API 仅用 `\n` |
| v4 | M4 | safeStringify 截断破坏 JSON | **已修复**。P0-P3 批量修复中已改为合法 JSON |
| sec | 1.1 | 权限大小写敏感 | 已知限制 K10 |
| sec | 4.1 | 终端恢复缺 Ink unmount | **已修复**。DONE.md SIGINT 三轮修复 |
| sec | 5.3 | 危险命令正则可绕过 | 已知限制 K3 |
| pkg | 1.3 | JSONL 非原子写入 | 已知限制 K2 |

---

## 已知限制（不修复）

| # | 问题 | 理由 |
|---|------|------|
| K1 | Stale-read TOCTOU 窗口 | 毫秒级 |
| K2 | Session JSONL 崩溃一致性 | best-effort 设计 |
| K3 | Bash 黑名单可绕过 | 黑名单固有缺陷 |
| K4 | Tool 结果 200 字符截断 | 完整输出在 session 文件中 |
| K5 | Token 估算 ~20% 偏差 | 已知 tradeoff |
| K6 | 多进程并发编辑无冲突检测 | 单进程设计 |
| K7 | Push/monitor/cron 仅 Linux | 目标平台 |
| K8 | workflow/agent-tool 模拟执行 | 占位实现 |
| K9 | 跨 provider 会话迁移 | 仅 DeepSeek-compatible |
| K10 | 权限检查大小写敏感 | 工具名统一小写 |
| K11 | 光标位置用 ref | useInput 触发 re-render |
