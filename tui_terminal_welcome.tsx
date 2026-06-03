import React, { useState, useEffect } from 'react';

// 精准提取图中的 TUI 渐变配色体系
const COLORS = {
  bg: '#000000',         // 纯黑背景
  text: '#E1D3DC',       // 浅灰粉主文字
  dimText: '#8D7B88',    // 偏暗辅助文字
  green: '#00FF66',      // 经典高亮翠绿
  blue: '#3B82F6',       // 统一的 DeepSeek 科技蓝
  blueBg: '#1D3B5C',     // 输入框/历史气泡背景蓝
  blueText: '#FFFFFF',   // 提示框白色文字
};

export default function App() {
  const [inputValue, setInputValue] = useState('');
  const [cursorVisible, setCursorVisible] = useState(true);
  const [history, setHistory] = useState([]);

  // 模拟光标闪烁
  useEffect(() => {
    const interval = setInterval(() => {
      setCursorVisible((prev) => !prev);
    }, 600);
    return () => clearInterval(interval);
  }, []);

  // 简单的输入框回车提交模拟
  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && inputValue.trim()) {
      setHistory([...history, inputValue]);
      setInputValue('');
    }
  };

  return (
    <div 
      className="min-h-screen w-full flex flex-col justify-center items-center p-4 md:p-8"
      style={{ backgroundColor: '#000000' }} // 整个外层背景设为纯黑
    >
      {/* 模拟终端视窗容器 */}
      <div 
        className="w-full max-w-4xl rounded-lg shadow-2xl border border-[#222222] overflow-hidden flex flex-col font-mono text-[14px] leading-relaxed"
        style={{ backgroundColor: COLORS.bg, color: COLORS.text }} 
      >
        {/* 终端头部装饰栏 - 修改为 DEEPSEEK Terminal */}
        <div className="bg-[#0c0c0c] px-4 py-2 flex items-center justify-between border-b border-[#222222] select-none">
           <span className="text-xs tracking-wider" style={{ color: COLORS.dimText }}>deepseek code v0.1.0</span>
          <div className="w-12" /> {/* 占位平衡 */}
        </div>

        {/* 终端主内容区 */}
        <div className="p-4 md:p-6 overflow-y-auto flex-1 space-y-6">
          
          {/* 欢迎模块：全大写渐变 deepseek + 图中副标题 */}
          <div className="flex flex-col items-center justify-center py-6 border border-[#222222] rounded bg-[#050505] space-y-3">
            {/* 蓝色至紫粉色渐变 deepseek 主体标题 */}
            <h1 className="text-5xl md:text-6xl font-bold tracking-tight select-none bg-gradient-to-r from-[#4fa3f7] via-[#7d7dfc] to-[#ca5ff2] bg-clip-text text-transparent font-sans">
              D E E P S E E K
            </h1>
            
            {/* 还原图片副标题 */}
            <p className="text-sm md:text-base font-semibold text-[#E1D3DC] font-sans">
              探索未至之境
            </p>

            <p className="text-xs pt-2" style={{ color: COLORS.dimText }}>
              当前模型: <span className="text-white font-semibold">deepseek-v4-flash </span> · 计费: <span className="text-white">免费</span>
            </p>
          </div>

          {/* 信息分栏面板：左右结构 */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* 左半栏：Active Sessions */}
            <div className="border border-[#222222] rounded p-4 bg-[#030303] space-y-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-amber-500 border-b border-[#222222] pb-1">
                Agent设置
              </h2>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span>推理档位 </span>
                  <span> [ <span className="text-green-400">✓</span> ] <span className="text-green-400">自动</span></span>
                </div>
                <div className="flex justify-between">
                  <span>上下文裁剪 </span>
                  <span> [ <span className="text-green-400">✓</span> ] <span className="text-green-400">开启</span></span>
                </div>
                <div className="flex justify-between">
                  <span>子代理 </span>
                  <span> [ <span className="text-green-400">✓</span> ] <span className="text-green-400">自动</span></span>
                </div>
              </div>
            </div>

            {/* 右半栏：Tools & MCP Status */}
            <div className="border border-[#222222] rounded p-4 bg-[#030303] space-y-2">
              <h2 className="text-xs font-bold uppercase tracking-wider text-amber-500 border-b border-[#222222] pb-1">
                组件状态
              </h2>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span>Skills:</span>
                  <span>[<span className="text-green-400">✓</span>]   <span className="text-green-400">35</span></span>
                </div>
                <div className="flex justify-between">
                  <span>MCP:</span>
                  <span>[<span className="text-green-400">✓</span>]   <span className="text-green-400"> 5</span></span>
                </div>
                <div className="flex justify-between">
                  <span>插件:</span>
                  <span>[<span className="text-green-400">✓</span>]   <span className="text-green-400"> 1</span></span>
                </div>
              </div>
            </div>
          </div>

          {/* 分割线 */}
          <div className="flex items-center space-x-2 select-none">
            <span className="whitespace-nowrap text-xs" style={{ color: COLORS.dimText }}>- 我准备好了，可以开始</span>
            <div className="h-[1px] w-full" style={{ backgroundColor: '#222222' }} />
          </div>

          {/* 用户执行记录历史 */}
          <div className="space-y-2">
            {history.map((cmd, i) => (
              <div 
                key={i} 
                className="rounded px-4 py-2.5 flex items-center opacity-70"
                style={{ backgroundColor: '#13283f' }}
              >
                <span className="mr-2 select-none font-bold" style={{ color: COLORS.green }}>❯</span>
                <span className="text-white">{cmd}</span>
              </div>
            ))}

            {/* 输入交互区域 */}
            <div 
              className="rounded px-4 py-2.5 flex items-center shadow-md focus-within:ring-1 focus-within:ring-[#4A90E2] transition-all"
              style={{ backgroundColor: COLORS.blueBg }}
            >
              <span className="mr-2 select-none font-bold" style={{ color: COLORS.green }}>❯</span>
              <input 
                type="text" 
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
                className="bg-transparent border-none outline-none flex-1 text-white placeholder-blue-300 font-mono"
                style={{ caretColor: 'transparent' }}
                placeholder="type /init or ask anything..."
                autoFocus
              />
              <span 
                className={`w-2.5 h-5 bg-white ml-0.5 ${cursorVisible ? 'opacity-100' : 'opacity-0'}`} 
                style={{ transition: 'opacity 150ms' }}
              />
            </div>
          </div>

          {/* 辅助快捷键提示 */}
          <div className="flex justify-start space-x-4 text-xs" style={{ color: COLORS.dimText }}>
            <span>/help 可以提问本软件任何用法</span>
            <span>•</span>
            <span>/lang can switch to English</span>
          </div>

        </div>

        {/* 底部状态栏 */}
        <div className="bg-[#0c0c0c] px-4 py-3 flex items-center justify-between border-t border-[#222222] text-xs select-none">
          <span style={{ color: COLORS.dimText }}>deepseek-v4-flash</span>
          <span style={{ color: COLORS.green }}>/vol4/bzc</span>
        </div>
      </div>
    </div>
  );
}