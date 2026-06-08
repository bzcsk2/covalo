/**
 * ModelPicker — 模型选择弹窗
 *
 * 功能：引导用户分三步选择 AI 模型：选择提供商 → 输入 API Key（如需）→ 选择模型。
 * 通过 step 状态控制当前展示步骤，支持键盘上下键导航、回车确认、Esc 返回/取消。
 *
 * @param currentProvider - 当前已选的提供商 ID
 * @param currentModel - 当前已选的模型名称
 * @param onSelect - 确认选择后的回调，传入 { provider, model, apiKey, baseUrl }
 * @param onCancel - 用户按 Esc 取消时的回调
 */
import { useState, useCallback } from 'react';
import { Box, Text, useInput } from '@deepicode/ink';
import { PROVIDERS, getApiKeyEnvVar } from '@deepicode/core';
import { execFile } from 'node:child_process';
import { t } from './i18n/index.js';

interface ModelPickerProps {
  currentProvider: string;
  currentModel: string;
  onSelect: (config: { provider: string; model: string; apiKey: string; baseUrl: string }) => void;
  onCancel: () => void;
}

/** 当前所处的选择步骤：'provider' 选择提供商，'key' 输入 API Key，'model' 选择具体模型，'custom' 自定义 URL/模型 */
type Step = 'provider' | 'key' | 'model' | 'custom';

/** 提供商列表的显示顺序，数组索引同时也决定了键盘上下键的选中顺序 */
const PROVIDER_ORDER = ['zen', 'deepseek', 'mimo', 'kilo', 'free-auto', 'openai-compatible', 'nvidia'];

/**
 * tryReadClipboard — 尝试从系统剪贴板读取文本
 * 按平台依次尝试：macOS 用 pbpaste，Windows 用 powershell Get-Clipboard，Linux 用 wl-paste / xclip / xsel
 * 用于在输入 API Key 时支持 Ctrl+V 粘贴操作
 */
async function tryReadClipboard(): Promise<string | null> {
  const platform = process.platform;
  const cmds: Array<{ bin: string; args: string[] }> = [];
  if (platform === 'darwin') {
    cmds.push({ bin: 'pbpaste', args: [] });
  } else if (platform === 'win32') {
    cmds.push({ bin: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard'] });
  } else {
    cmds.push({ bin: 'wl-paste', args: [] });
    cmds.push({ bin: 'xclip', args: ['-o', '-selection', 'clipboard'] });
    cmds.push({ bin: 'xsel', args: ['--clipboard', '--output'] });
  }
  for (const { bin, args } of cmds) {
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(bin, args, { encoding: 'utf8', timeout: 500 }, (err, stdout) => {
          if (err) reject(err); else resolve(stdout);
        });
      });
      if (out) return out.replace(/\n$/, '');
    } catch { continue }
  }
  return null;
}

/** Default baseURL for openai-compatible provider */
const DEFAULT_LOCAL_URL = 'http://localhost:8000/v1';

export function ModelPicker({ currentProvider, currentModel, onSelect, onCancel }: ModelPickerProps) {
  /** 当前步骤：提供商选择 → 输入 Key → 选择模型 */
  const [step, setStep] = useState<Step>('provider');
  /** 当前选中的列表项索引，用于上下键导航 */
  const [selIdx, setSelIdx] = useState(Math.max(0, PROVIDER_ORDER.indexOf(currentProvider)));
  /** 用户选中的提供商 ID */
  const [selProvider, setSelProvider] = useState(currentProvider);
  /** 用户选中的模型名称 */
  const [selModel, setSelModel] = useState(currentModel);
  /** 用户输入的 API Key */
  const [apiKey, setApiKey] = useState('');
  /** 输入缓存区，用于收集键盘字符输入（也支持终端的 bracketed paste 多字符粘贴） */
  const [inputBuf, setInputBuf] = useState('');
  /** openai-compatible: 当前编辑的字段索引 (0=URL, 1=模型名) */
  const [editField, setEditField] = useState(0);
  /** openai-compatible: 自定义 baseURL */
  const [customUrl, setCustomUrl] = useState(DEFAULT_LOCAL_URL);
  /** openai-compatible: 自定义模型名 */
  const [customModel, setCustomModel] = useState('');

  /**
   * confirmSelection — 确认并提交选择结果
   * @param modelOverride - 可选，用于覆盖当前选中的模型（直接回车选择时传入）
   *
   * model 优先级：显式传入的 modelOverride > 已缓存的 selModel > 提供商默认模型
   * apiKey 优先级：用户输入的 apiKey > 环境变量中的 Key > 提供商预设的 defaultKey
   */
  const confirmSelection = useCallback((modelOverride?: string) => {
    const cfg = PROVIDERS[selProvider];
    if (!cfg) return;
    // openai-compatible: use custom URL and model name from user input
    if (selProvider === 'openai-compatible') {
      onSelect({
        provider: selProvider,
        model: customModel || 'gpt-3.5-turbo',
        apiKey: '',
        baseUrl: customUrl || DEFAULT_LOCAL_URL,
      });
      return;
    }
    const envKey = process.env[getApiKeyEnvVar(selProvider)] ?? '';
    onSelect({
      provider: selProvider,
      model: modelOverride ?? (selModel || cfg.model),
      apiKey: apiKey || envKey || (cfg.defaultKey ?? ''),
      baseUrl: cfg.baseUrl,
    });
  }, [selProvider, selModel, customModel, customUrl, apiKey, onSelect]);

  /**
   * goBack — 返回上一步
   * - 如果在第一步（provider），则取消整个弹窗
   * - 如果在 key 输入步骤，清空输入缓存后退回提供商选择
   * - 如果在 model 选择步骤：若当前提供商必须输入 Key 且尚未提供，则退回 key 步骤；否则直接退回提供商选择
   */
  const goBack = useCallback(() => {
    if (step === 'provider') {
      onCancel();
    } else if (step === 'key') {
      setInputBuf('');
      setStep('provider');
    } else if (step === 'custom') {
      setInputBuf('');
      setEditField(0);
      setStep('provider');
    } else {
      const p = PROVIDERS[selProvider];
      // 若提供商需要 Key、无默认 Key 且环境变量中也没有，且不是 keyless provider，则退回 key 步骤
      if (p && !p.keyless && p.requiresKey && !p.defaultKey && !process.env[getApiKeyEnvVar(selProvider)]) {
        setSelIdx(0);
        setStep('key');
      } else {
        setSelIdx(Math.max(0, PROVIDER_ORDER.indexOf(selProvider)));
        setStep('provider');
      }
    }
  }, [step, selProvider, onCancel]);

  useInput((_input, key) => {
    if (key.escape || (key.ctrl && _input === 'c')) {
      if (step === 'provider') {
        onCancel();
      } else {
        goBack();
      }
      return;
    }

    if (step === 'provider') {
      if (key.upArrow) {
        setSelIdx(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelIdx(prev => Math.min(PROVIDER_ORDER.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const p = PROVIDER_ORDER[selIdx];
        setSelProvider(p);
        setSelModel(PROVIDERS[p].models[0]?.model ?? '');
        setInputBuf('');
        if (p === 'openai-compatible') {
          // openai-compatible: go directly to custom config step
          setEditField(0);
          setInputBuf(customUrl || DEFAULT_LOCAL_URL);
          setStep('custom');
          return;
        }
        const cfg = PROVIDERS[p];
        // Keyless providers skip API key entry; requiresKey providers without default/env key show key input
        if (cfg.keyless || !cfg.requiresKey || cfg.defaultKey || process.env[getApiKeyEnvVar(p)]) {
          setStep('model');
        } else {
          setStep('key');
        }
        return;
      }
      return;
    }

    if (step === 'key') {
      if (key.return && inputBuf.length > 0) {
        setApiKey(inputBuf);
        setInputBuf('');
        setSelIdx(0);
        setStep('model');
        return;
      }
      if (key.backspace || key.delete) {
        setInputBuf(prev => prev.slice(0, -1));
        return;
      }
      if (key.ctrl && (_input === 'v' || _input === 'V')) {
        void tryReadClipboard().then(clip => {
          if (clip) setInputBuf(prev => prev + clip);
        });
        return;
      }
      if (_input) {
        setInputBuf(prev => prev + _input);
      }
      return;
    }

    if (step === 'custom') {
      if (key.return && inputBuf.length > 0) {
        if (editField === 0) {
          // Save URL, move to model name input
          setCustomUrl(inputBuf);
          setEditField(1);
          setInputBuf(customModel);
          return;
        } else {
          // Save model and confirm
          setCustomModel(inputBuf);
          setEditField(0);
          confirmSelection();
          return;
        }
      }
      if (key.backspace || key.delete) {
        setInputBuf(prev => prev.slice(0, -1));
        return;
      }
      if (key.ctrl && (_input === 'v' || _input === 'V')) {
        void tryReadClipboard().then(clip => {
          if (clip) setInputBuf(prev => prev + clip);
        });
        return;
      }
      if (_input) {
        setInputBuf(prev => prev + _input);
      }
      return;
    }

    if (step === 'model') {
      const models = PROVIDERS[selProvider]?.models ?? [];
      if (key.upArrow) {
        setSelIdx(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow) {
        setSelIdx(prev => Math.min(models.length - 1, prev + 1));
        return;
      }
      if (key.return) {
        const m = models[selIdx];
        if (m) {
          setSelModel(m.model);
          confirmSelection(m.model);
        }
        return;
      }
      return;
    }
  });

  const providerName = PROVIDERS[selProvider]?.label ?? selProvider;
  const models = PROVIDERS[selProvider]?.models ?? [];

  return (
    // 主容器：纵向排列，圆角边框，padding 1，宽度 100%
    <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="round" width="100%">
      <Box marginBottom={1}>
        <Text bold>{t().modelSettings}</Text>
      </Box>

      {step === 'provider' && (
        <Box flexDirection="column">
          {/* dimColor 表示辅助性提示文字，降低视觉权重 */}
          <Text dimColor>{t().selectProvider}</Text>
          {PROVIDER_ORDER.map((p, i) => {
            const info = PROVIDERS[p];
            if (!info) return null;
            return (
              <Box key={p}>
                {/* ❯ 表示当前选中项；未选中时保留两个空格占位保持对齐 */}
                <Text>{i === selIdx ? '❯ ' : '  '}</Text>
                {/* bold 加粗当前选中项的标签，提供视觉焦点 */}
                <Text bold={i === selIdx}>{info.label}</Text>
                {p === currentProvider && <Text dimColor>{t().current}</Text>}
              </Box>
            );
          })}
        </Box>
      )}

      {step === 'key' && (
        <Box flexDirection="column">
          <Text dimColor>{t().enterApiKey(providerName)}</Text>
          {/* inputBuf 显示当前输入内容，▊ 为光标指示符；无输入时不显示光标 */}
          <Text>  {inputBuf}{inputBuf.length > 0 ? '▊' : ''}</Text>
          <Text dimColor>{t().escToGoBack}</Text>
        </Box>
      )}

      {step === 'custom' && (
        <Box flexDirection="column">
          <Text dimColor>Configure OpenAI Compatible Provider:</Text>
          <Box marginTop={1}>
            <Text bold={editField === 0}>❯ </Text>
            <Text dimColor>Base URL: </Text>
            <Text>{editField === 0 ? `${inputBuf}${inputBuf.length > 0 ? '▊' : ''}` : customUrl}</Text>
          </Box>
          <Box>
            <Text bold={editField === 1}>❯ </Text>
            <Text dimColor>Model:    </Text>
            <Text>{editField === 1 ? `${inputBuf}${inputBuf.length > 0 ? '▊' : ''}` : customModel || '(type model name)'}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>{t().escToGoBack}</Text>
          </Box>
        </Box>
      )}

      {step === 'model' && (
        <Box flexDirection="column">
          {/* dimColor 降低提示文字亮度，不干扰列表内容 */}
          <Text dimColor>{t().selectModel(providerName)}</Text>
          {models.map((m, i) => (
            <Box key={m.model}>
              <Text>{i === selIdx ? '❯ ' : '  '}</Text>
              {/* bold 高亮当前选中的模型名称 */}
              <Text bold={i === selIdx}>{m.label}</Text>
              {m.model === currentModel && <Text dimColor>{t().current}</Text>}
            </Box>
          ))}
          <Text dimColor>{t().escToGoBack}</Text>
        </Box>
      )}
    </Box>
  );
}
