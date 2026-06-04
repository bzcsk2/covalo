import { Box, Text } from '@deepicode/ink';
import { t } from './i18n/index.js';
import { FG, SURFACE, TONE } from './reasonix/tokens.js';

/**
 * StatusBar - 底部状态栏组件
 *
 * 功能：显示当前会话的状态信息，包括模型与提供商、Agent 名称与层级、
 * Token 统计（输入、输出、缓存命中率）、上下文使用量、状态消息、待处理指令数等。
 *
 * Props 含义：
 * - inputTokens/outputTokens: 输入/输出 Token 数
 * - cacheHitTokens/cacheMissTokens: 用于计算缓存命中率
 * - contextUsed/contextTotal: 上下文窗口使用量（已用/总量）
 * - pendingInstructionCount: >0 时显示待处理指令通知
 * - thinkingMode: "off" 时不显示思考模式；其他值显示 🧠 Thinking 徽标
 * - tier: 服务层级标签（如 free/pro）
 * - cwd: 当前工作目录路径
 * - statusMessage: 有值时显示 ⚠ 警告信息
 */
interface StatusBarProps {
  model: string;
  provider: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  contextUsed: number;
  contextTotal: number;
  pendingInstructionCount?: number;
  statusMessage?: string | null;
  thinkingMode?: string;
  tier?: string;
  cwd?: string;
}

/**
 * fmt - 格式化数字为可读字符串
 * 1000+ 显示为 "1K"，1000000+ 显示为 "1.0M"
 * @param n - 待格式化的数字
 * @returns 格式化后的字符串
 */
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

/**
 * cacheRate - 计算缓存命中率百分比
 * hit / (hit + miss) * 100，保留整数部分
 * @param hit - 缓存命中的 Token 数
 * @param miss - 缓存未命中的 Token 数
 * @returns 命中率字符串（如 "75%"），若总数为 0 返回 "--"
 */
function cacheRate(hit: number, miss: number): string {
  const total = hit + miss;
  if (total === 0) return '--';
  return `${Math.round((hit / total) * 100)}%`;
}

export function StatusBar({ model, provider, agent, inputTokens, outputTokens, cacheHitTokens, cacheMissTokens, contextUsed, contextTotal, pendingInstructionCount, statusMessage, thinkingMode, tier, cwd }: StatusBarProps) {
  // 计算缓存命中率
  const rate = cacheRate(cacheHitTokens, cacheMissTokens);
  // 只显示 agent 名称，去掉 " Agent" 后缀
  const agentShort = agent?.replace(/\s+Agent$/i, '') ?? agent;
  // 只显示当前文件夹名
  const cwdShort = cwd ? cwd.split('/').filter(Boolean).pop() ?? cwd : '';
  // thinkingMode: off 不显示，其他显示 auto/open/high
  const showThinking = thinkingMode && thinkingMode !== 'off';
  return (
    <Box width="100%" flexDirection="column">
      {/* 状态警告信息（如 ⚠ 提示），仅在 statusMessage 有值时显示 */}
      {statusMessage && (
        <Box>
          <Text color={TONE.warn}>{` \u26a0 ${statusMessage} `}</Text>
        </Box>
      )}
      {/* 待处理指令数，>0 时显示 📥 通知徽标 */}
      {pendingInstructionCount ? (
        <Box>
          <Text color={TONE.ok}>{` \u{1F4E5} ${t().pendingTasks}${pendingInstructionCount} `}</Text>
        </Box>
      ) : null}
      {/* 主信息栏：背景色透明，水平内边距 paddingX=1 */}
      <Box width="100%" flexDirection="row" paddingX={1}>
        <Text color={FG.meta}>{`${agentShort} ${model}`}</Text>
        {showThinking ? <Text color={TONE.accent}>{` [${thinkingMode}]`}</Text> : null}
        {/* flexGrow=1 将后面元素推到右侧 */}
        <Box flexGrow={1} />
        <Text color={FG.faint}>{`${fmt(inputTokens)} ${t().inputTokens} `}</Text>
        <Text color={FG.faint}>{`${rate} ${t().cacheHit} `}</Text>
        <Text color={FG.faint}>{`${fmt(outputTokens)} ${t().outputTokens} `}</Text>
        {/* contextUsed/contextTotal：上下文使用量 */}
        <Text color={FG.sub}>{`${fmt(contextUsed)}/${fmt(contextTotal)}`}</Text>
        {cwdShort ? <Text color={TONE.ok}>{`  ${cwdShort}`}</Text> : null}
      </Box>
    </Box>
  );
}
