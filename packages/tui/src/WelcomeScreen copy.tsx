import React from 'react';
import { Box, Text } from '@deepicode/ink';
import { FG, TONE } from './reasonix/tokens.js';

/**
 * WelcomeScreen 组件 - 欢迎界面
 *
 * 【组件职责】
 * 在对话开始前显示欢迎信息，包括：
 * - 应用 Logo（DEEPICODE 渐变色字母）
 * - 标语 "探索未至之境"
 * - 当前模型信息
 * - Agent 设置面板（推理档位、上下文裁剪、子代理）
 * - 组件状态面板（Provider、Skills、MCP）
 * - 快捷操作提示
 *
 * 【Props 说明】
 * - model: 当前使用的模型名称
 * - provider: 当前使用的提供商名称
 * - agent: 当前使用的 Agent 名称
 * - thinkingMode: 当前推理模式（auto/off/open/high）
 *
 * 【显示参数】
 * 以下参数控制欢迎界面的视觉样式
 */

interface WelcomeScreenProps {
  model: string;
  provider: string;
  agent: string;
  thinkingMode: string;
}

/**
 * Logo 组件 - 渐变色 DEEPICODE 文字
 *
 * 每个字母使用不同的渐变色，从蓝色过渡到紫色
 * 显示参数：每个字母使用独立的 color 属性
 */
function Title(): React.ReactElement {
  return (
    <Box flexDirection="row" justifyContent="center">
      <Text bold color="#4FA3F7">D </Text>
      <Text bold color="#5C94F9">E </Text>
      <Text bold color="#6985FA">E </Text>
      <Text bold color="#7676FC">P </Text>
      <Text bold color="#866FFB">I </Text>
      <Text bold color="#9868F9">C </Text>
      <Text bold color="#B064F6">O </Text>
      <Text bold color="#C15FF3">D </Text>
      <Text bold color="#CA5FF2">E</Text>
    </Box>
  );
}

/**
 * 勾选值组件 - 显示带勾选框的配置项
 *
 * 格式：[✓] 值
 * 显示参数：
 * - 方括号使用 body 色
 * - 勾选符号使用 ok 色（绿色）
 * - 值使用 ok 色（绿色）
 */
function CheckValue({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Text>
      <Text color={FG.body}>[</Text>
      <Text color={TONE.ok}>✓</Text>
      <Text color={FG.body}>] </Text>
      <Text color={TONE.ok}>{children}</Text>
    </Text>
  );
}

/**
 * 面板组件 - 带边框的信息面板
 *
 * 【显示参数】
 * - borderStyle="round": 圆角边框
 * - borderColor="#222222": 深灰色边框（低调）
 * - backgroundColor="#030303": 接近黑色的背景
 * - paddingX={1}, paddingY={1}: 内边距 1 字符/行
 *
 * @param title - 面板标题
 * @param children - 面板内容
 */
function Panel({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box
      flexDirection="column"
      flexGrow={1}
      borderStyle="round"
      borderColor="#222222"
      backgroundColor="#030303"
      paddingX={1}
      paddingY={1}
    >
      {/* 标题栏：底部边框分隔 */}
      <Box borderStyle="single" borderTop={false} borderLeft={false} borderRight={false} borderColor="#222222">
        <Text bold color="#F59E0B">{title}</Text>
      </Box>
      {/* 内容区：顶部边距 1 行 */}
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * 键值行组件 - 显示标签和值
 *
 * 布局：标签左对齐，值右对齐
 * 使用 flexGrow={1} 将值推到右侧
 */
function Row({ label, value }: { label: string; value: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="row" width="100%">
      <Text color={FG.body}>{label}</Text>
      <Box flexGrow={1} />
      {value}
    </Box>
  );
}

/**
 * 欢迎界面主组件
 *
 * 布局结构（从上到下）：
 * 1. Logo 区域（渐变色 DEEPICODE）
 * 2. 标语
 * 3. 模型信息
 * 4. 双列面板（Agent 设置 | 组件状态）
 * 5. 快捷提示
 */
export function WelcomeScreen({ model, provider, agent, thinkingMode }: WelcomeScreenProps): React.ReactElement {
  // 推理模式显示：off 显示为 "自动"
  const thinking = thinkingMode === 'off' ? '自动' : thinkingMode;
  // 只显示 agent 名称，去掉 " Agent" 后缀
  const agentShort = agent?.replace(/\s+Agent$/i, '') ?? agent;

  return (
    // 显示参数：paddingX={1} 左右内边距 1 字符
    <Box flexDirection="column" width="100%" paddingX={1}>
      {/* Logo 区域 */}
      <Box
        flexDirection="column"
        width="100%"
        borderStyle="round"
        borderColor="#222222"
        backgroundColor="#050505"
        paddingX={1}
        paddingY={1}
      >
        <Box justifyContent="center">
          <Title />
        </Box>
        <Box justifyContent="center">
          <Text bold color={FG.body}>探索未至之境</Text>
        </Box>
        <Box justifyContent="center" marginTop={1}>
          <Text color={FG.meta}>
            当前模型: <Text bold color={FG.strong}>{model}</Text>
            <Text color={FG.meta}> · 计费: </Text>
            <Text color={FG.strong}>免费</Text>
          </Text>
        </Box>
      </Box>

      {/* 双列面板 */}
      <Box flexDirection="row" width="100%" marginTop={1}>
        {/* Agent 设置面板 */}
        <Panel title="Agent设置">
          <Row label="推理档位 " value={<CheckValue>{thinking}</CheckValue>} />
          <Row label="上下文裁剪 " value={<CheckValue>开启</CheckValue>} />
          <Row label="子代理 " value={<CheckValue>{agentShort}</CheckValue>} />
        </Panel>

        {/* 列间距：1 字符 */}
        <Box width={1} />

        {/* 组件状态面板 */}
        <Panel title="组件状态">
          <Row label="Provider:" value={<CheckValue>{provider}</CheckValue>} />
          <Row label="Skills:" value={<CheckValue>已加载</CheckValue>} />
          <Row label="MCP:" value={<CheckValue>按需连接</CheckValue>} />
        </Panel>
      </Box>

      {/* 快捷提示 1 */}
      <Box flexDirection="row" width="100%" marginTop={1}>
        <Text color={FG.meta}>- 我准备好了，可以开始</Text>
        {/* 分隔线：使用单线边框样式 */}
        <Box flexGrow={1} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderColor="#222222" />
      </Box>

      {/* 快捷提示 2 */}
      <Box flexDirection="row" marginTop={1}>
        <Text color={FG.meta}>/help 可以提问本软件任何用法</Text>
        <Text color={FG.meta}> • </Text>
        <Text color={FG.meta}>/lang can switch to English</Text>
      </Box>
    </Box>
  );
}
