/**
 * Finish reason 工具函数。
 *
 * 从 client.ts 提取为独立文件，避免 loop.ts 等不需要 client.ts 实现的模块
 * 仅因一个纯函数而触发 client.ts 的加载（Windows 上 bun test 存在 EPERM 问题）。
 */

/**
 * 判断 finish_reason 是否表示模型要求调用工具。
 * 兼容 OpenAI / Anthropic / DeepSeek / Kilo 等多种 provider 的命名约定。
 */
export function isToolUseFinishReason(reason: string | null): boolean {
  return reason === "tool_calls" || reason === "tool_use" || reason === "toolUse" || reason === "toolCall" || reason === "tool"
}
