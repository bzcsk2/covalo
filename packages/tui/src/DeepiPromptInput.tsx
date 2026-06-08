import { useState, useCallback, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import { Box, Text, useInput } from '@deepicode/ink';
import { t } from './i18n/index.js';
import { FG, SURFACE, TONE } from './reasonix/tokens.js';

/**
 * DeepiPromptInput - 用户输入框组件
 *
 * 功能：提供终端风格的文本输入框，支持历史记录浏览、光标移动（含按词跳转）、
 * 快捷键操作（Ctrl+字母/方向键组合）、文本注入、加载/队列提示等。
 *
 * 内部状态：
 * - input: 当前输入的文本内容
 * - historyIdx: 历史记录浏览索引（-1 表示不在浏览历史）
 * - draftBeforeHistory: 浏览历史前保存的当前草稿
 * - cursor: 当前光标位置
 * - escRef: 记录上次 Esc 按键时间，用于检测双击 Esc 取消
 * - lastInjectionIdRef: 已处理的注入文本 ID，避免重复注入
 *
 * 交互影响：字符输入、方向键、Enter/快捷键等在 useInput 回调中处理
 */
interface DeepiPromptInputProps {
  /** 用户按 Enter 时回调，传入当前输入文本 */
  onSubmit: (text: string) => void;
  /** 输入内容变化时回调 */
  onChange?: (text: string) => void;
  /** 是否正在加载中（true 时按 Enter/键盘不响应输入） */
  isLoading: boolean;
  /** 是否禁用输入（禁用时所有按键不响应） */
  disabled?: boolean;
  /** 后台队列中的任务数量，>0 时在输入框末尾显示队列提示 */
  queueCount?: number;
  /** 加载中时按 Esc+Esc 或 Ctrl+C 触发取消的回调 */
  onCancel: () => void;
  /** 历史记录列表，上下箭头浏览时从中取值 */
  history?: string[];
  /** 外部注入的文本（如代码块插入）；id 变化时自动填入输入框 */
  injectedText?: { id: number; text: string };
  /** 为 true 时禁用历史浏览，让自动补全处理方向键 */
  suppressHistory?: boolean;
  /** 为 true 时禁用 Enter/Tab 提交，让自动补全处理按键 */
  suppressSubmit?: boolean;
}

export interface DeepiPromptInputHandle {
  writeText: (text: string) => void;
}

/**
 * charClass - 将字符划分为不同的词类，用于词边界检测
 *
 * 分类规则：
 * - 0: 空字符
 * - 1: 空格/控制字符（code <= 32）
 * - 2: 中日韩统一表意文字（CJK，0x4E00~0x9FFF）
 * - 3: CJK 标点符号（0x3000~0x303F）
 * - 4: 字母/数字/下划线（匹配 /\w/）
 * - 5: 其他标点符号
 *
 * @param ch - 待分类的字符
 * @returns 字符所属类别编号
 */
function charClass(ch: string): number {
  if (!ch) return 0;
  const code = ch.codePointAt(0)!;
  if (code <= 32) return 1; // space/control
  if (code >= 0x4E00 && code <= 0x9FFF) return 2; // CJK
  if (code >= 0x3000 && code <= 0x303F) return 3; // CJK punctuation
  if (/[a-zA-Z0-9_]/.test(ch)) return 4; // word chars
  return 5; // other punctuation
}

/**
 * findWordLeft - 从指定位置向左找到前一个词边界
 * 用于 Ctrl+左箭头（按词左移）和 Ctrl+Backspace（按词删除）。
 * 先跳过空格，再跳过同类型词字符直到边界。
 *
 * @param text - 完整文本
 * @param pos - 起始位置
 * @returns 前一个词边界位置
 */
function findWordLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  // Skip spaces
  let i = pos - 1;
  while (i > 0 && charClass(text[i]) === 1) i--;
  // Skip word chars of the same class
  const cls = charClass(text[i]);
  while (i > 0 && charClass(text[i - 1]) === cls) i--;
  return i;
}

/**
 * findWordRight - 从指定位置向右找到后一个词边界
 * 用于 Ctrl+右箭头（按词右移）。
 * 先跳过同类型词字符，再跳过空格。
 *
 * @param text - 完整文本
 * @param pos - 起始位置
 * @returns 后一个词边界位置
 */
function findWordRight(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  // Skip word chars of the same class
  let i = pos;
  const cls = charClass(text[i]);
  while (i < text.length && charClass(text[i]) === cls) i++;
  // Skip spaces
  while (i < text.length && charClass(text[i]) === 1) i++;
  return i;
}

export const DeepiPromptInput = forwardRef<DeepiPromptInputHandle, DeepiPromptInputProps>(function DeepiPromptInput(
  {
    onSubmit,
    onChange,
    isLoading,
    disabled,
    queueCount = 0,
    onCancel,
    history = [],
    injectedText,
    suppressHistory = false,
    suppressSubmit = false,
  },
  ref
) {
  // 当前输入的文本框内容
  const [input, setInput] = useState('');
  // 历史记录浏览索引，-1 表示不在浏览历史记录
  const [historyIdx, setHistoryIdx] = useState(-1);
  // 浏览历史前保存的当前输入草稿，退出历史浏览时恢复
  const [draftBeforeHistory, setDraftBeforeHistory] = useState('');
  // 当前光标位置（字符索引）
  const [cursor, setCursor] = useState(0);
  // 记录上次按 Esc 的时间戳，用于检测 800ms 内的双击 Esc 触发取消
  const escRef = useRef(0);
  // 已处理的注入文本 ID，避免 injectedText 变化时重复填入
  const lastInjectionIdRef = useRef<number | null>(null);

  useImperativeHandle(ref, () => ({
    writeText: (text: string) => {
      setInput(text);
      setCursor(text.length);
    }
  }));

  useEffect(() => { onChange?.(input); }, [input, onChange]);

  useEffect(() => {
    if (!injectedText || lastInjectionIdRef.current === injectedText.id) return;
    lastInjectionIdRef.current = injectedText.id;
    setInput(injectedText.text);
    setCursor(injectedText.text.length);
    setHistoryIdx(-1);
    setDraftBeforeHistory('');
  }, [injectedText]);

  /**
   * submitLine - 提交当前输入行
   * 将输入文本去空格后通过 onSubmit 回调提交。
   * 提交后重置输入框内容、光标位置和历史浏览状态。
   */
  const submitLine = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setHistoryIdx(-1);
    setDraftBeforeHistory('');
    setInput('');
    setCursor(0);
    onSubmit(text);
  }, [input, onSubmit]);

  /**
   * useInput 回调 - 处理所有键盘输入事件
   *
   * 按键映射：
   * - Ctrl+C / Ctrl+c: 加载中时触发取消
   * - Esc+Esc（800ms 内双击）: 加载中时触发取消
   * - Ctrl+O: 触发思考面板切换（由 DeepiMessages 处理）
   * - Ctrl+Enter: 当前光标处插入换行
   * - Enter: 提交文本（suppressSubmit=true 时跳过）
   * - Tab: suppressSubmit=true 时跳过（由自动补全处理）
   * - 上箭头: 历史记录上翻（suppressHistory=true 时跳过）
   * - 下箭头: 历史记录下翻（suppressHistory=true 时跳过）
   * - 左箭头: 光标左移
   * - 右箭头: 光标右移
   * - Ctrl+左箭头: 跳到前一个词边界
   * - Ctrl+右箭头: 跳到后一个词边界
   * - Ctrl+Backspace: 删除光标前的整个词
   * - Ctrl+A: 光标跳到行首
   * - Ctrl+E: 光标跳到行尾
   * - Home: 光标跳到行首
   * - End: 光标跳到行尾
   * - Backspace: 删除光标前一个字符
   * - Delete: 删除光标后一个字符
   * - Ctrl+D: 删除光标后一个字符（同 Delete）
   * - Ctrl+U: 清空整行输入
   * - Ctrl+K: 删除光标到行尾的内容
   * - 其他字符: 在光标位置插入文本
   */
  useInput((_input, key) => {
    if (disabled) return;

    // Ctrl+C 触发取消（raw mode 下正常工作的 Ctrl+C 信号）
    // 检查条件：原生 \\x03 或 Ctrl+c 组合键
    if (_input === '\x03' || (key.ctrl && _input === 'c')) {
      if (isLoading) {
        onCancel();
      }
      return;
    }

    // 双击 Esc 中断（仅加载中有效）：800ms 内按两次 Esc 触发取消
    // Esc 是按键事件（保留 key.escape），不同于 Ctrl+C 既可是字符也可是按键
    if (key.escape && isLoading) {
      const now = Date.now();
      if (now - escRef.current < 800) {
        onCancel();
        escRef.current = 0;
        return;
      }
      escRef.current = now;
      return;
    }

    // Ctrl+O — 切换思考面板（由 DeepiMessages 组件处理，此处仅忽略按键）
    if (_input === '\x0f' || (key.ctrl && _input === 'o')) {
      return;
    }

    // Ctrl+Enter — 在当前光标位置插入换行符
    if (key.return && key.ctrl) {
      const pos = cursor;
      setInput(prev => prev.slice(0, pos) + '\n' + prev.slice(pos));
      setCursor(pos + 1);
      return;
    }

    // Enter — 提交输入文本（suppressSubmit 时由自动补全处理，跳过此处）
    if (key.return) {
      if (suppressSubmit) return;
      submitLine();
      return;
    }

    // Tab — suppressSubmit 时跳过，让自动补全捕获该按键
    if (key.tab && suppressSubmit) {
      return;
    }

    // 上箭头 — 历史记录上翻
    // 首次进入历史时（从 -1 变为 0），保存当前输入到 draftBeforeHistory
    // 后续上翻时从 history 数组中取出对应的历史项
    if (key.upArrow) {
      if (!suppressHistory) {
        setHistoryIdx(prev => {
          const next = Math.min(prev + 1, history.length - 1);
          if (next >= 0) {
            if (prev < 0) setDraftBeforeHistory(input);
            setInput(history[next] ?? '');
            setCursor((history[next] ?? '').length);
          }
          return next;
        });
      }
      return;
    }

    // 下箭头 — 历史记录下翻
    // 超出历史范围（next < 0）时恢复保存的当前草稿 draftBeforeHistory
    if (key.downArrow) {
      if (!suppressHistory) {
        setHistoryIdx(prev => {
          const next = prev - 1;
          if (next < 0) {
            setInput(draftBeforeHistory);
            setCursor(draftBeforeHistory.length);
            return -1;
          }
          setInput(history[next] ?? '');
          setCursor((history[next] ?? '').length);
          return next;
        });
      }
      return;
    }

    // 左箭头 — 光标左移（不越过行首）
    if (key.leftArrow) {
      setCursor(prev => Math.max(0, prev - 1));
      return;
    }

    // 右箭头 — 光标右移（不越过行尾）
    if (key.rightArrow) {
      setCursor(prev => Math.min(input.length, prev + 1));
      return;
    }

    // Ctrl+左箭头: 跳到前一个词边界（使用 charClass 按词类跳转）
    if (key.leftArrow && key.ctrl) {
      setCursor(prev => findWordLeft(input, prev));
      return;
    }

    // Ctrl+右箭头: 跳到后一个词边界
    if (key.rightArrow && key.ctrl) {
      setCursor(prev => findWordRight(input, prev));
      return;
    }

    // Ctrl+Backspace: 删除光标前的整个词（通过 findWordLeft 找到词边界后切片删除）
    if (key.backspace && key.ctrl) {
      const pos = cursor;
      const newCursor = findWordLeft(input, pos);
      if (newCursor < pos) {
        setInput(prev => prev.slice(0, newCursor) + prev.slice(pos));
        setCursor(newCursor);
      }
      return;
    }

    // Ctrl+A — 光标回到行首
    if (_input === 'a' && key.ctrl) {
      setCursor(0);
      return;
    }

    // Ctrl+E — 光标跳到行尾
    if (_input === 'e' && key.ctrl) {
      setCursor(input.length);
      return;
    }

    // Home — 光标回到行首
    if (key.home) {
      setCursor(0);
      return;
    }

    // End — 光标跳到行尾
    if (key.end) {
      setCursor(input.length);
      return;
    }

    // Backspace — 删除光标前一个字符
    if (key.backspace) {
      const pos = cursor;
      if (pos > 0) {
        setInput(prev => prev.slice(0, pos - 1) + prev.slice(pos));
        setCursor(pos - 1);
      }
      return;
    }

    // Delete — 删除光标后一个字符
    if (key.delete) {
      const pos = cursor;
      if (pos < input.length) {
        setInput(prev => prev.slice(0, pos) + prev.slice(pos + 1));
      }
      return;
    }

    // Ctrl+D — 删除光标后一个字符（同 Delete）
    if (_input === 'd' && key.ctrl) {
      const pos = cursor;
      if (pos < input.length) {
        setInput(prev => prev.slice(0, pos) + prev.slice(pos + 1));
      }
      return;
    }

    // Ctrl+U — 清空整行输入
    if (_input === 'u' && key.ctrl) {
      setInput('');
      setCursor(0);
      return;
    }

    // Ctrl+K — 删除光标到行尾的内容
    if (_input === 'k' && key.ctrl) {
      const pos = cursor;
      setInput(prev => prev.slice(0, pos));
      return;
    }

    // 普通字符输入：在光标位置插入字符，光标后移
    if (_input) {
      const pos = cursor;
      setInput(prev => prev.slice(0, pos) + _input + prev.slice(pos));
      setCursor(pos + _input.length);
    }
  });

  // 无输入且非加载中时用占位符样式（灰色文字）
  const isPlaceholder = !input && !isLoading;
  // 队列中还有任务时显示 "queued(N)" 提示
  const queueHint = queueCount > 0 ? t().queued(queueCount) : '';
  // 加载中时显示 "processing" 提示
  const loadingHint = isLoading ? t().processing : '';
  // 最终显示的文本：占位符 → 灰色占位文字；正常 → 输入+光标+队列/加载提示
  // 光标用 ▊ 字符渲染，插入在当前 cursor 位置
  const displayText = isPlaceholder && !isLoading && queueCount === 0
    ? t().placeholder
    : `${input.slice(0, cursor)}▊${input.slice(cursor)}${queueHint}${loadingHint}`;

  return (
    <Box flexDirection="column" width="100%" justifyContent="center" alignItems="center">
      {/* 输入内容区域 */}
      <Box
        flexDirection="column"
        width="100%"
        backgroundColor={SURFACE.bgInput}
        paddingX={2}
        paddingY={0}
      >
        <Text backgroundColor={SURFACE.bgInput}> </Text>
        <Box flexDirection="row" backgroundColor={SURFACE.bgInput}>
          <Text bold color={TONE.brand} backgroundColor={SURFACE.bgInput}>{'\u276F '}</Text>
          <Text wrap="wrap" color={isPlaceholder ? FG.sub : FG.strong} backgroundColor={SURFACE.bgInput}>{displayText}</Text>
          <Box flexGrow={1} backgroundColor={SURFACE.bgInput} />
        </Box>
        <Text backgroundColor={SURFACE.bgInput}> </Text>
      </Box>
    </Box>
  );
});
