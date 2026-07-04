import { useState, useRef, useEffect } from 'react';
import { Box, Text, useInput } from '@covalo/ink';
import type { PermissionReply } from '@covalo/core';
import type { TuiPermissionPrompt } from './bridge.js';
import { t } from './i18n/index.js';

interface PermissionPromptProps {
  /** SPEC S0-1: request 类型扩展为 TuiPermissionPrompt，包含 originRole */
  request: TuiPermissionPrompt;
  /** SPEC S0-1: onSelect 显式回传 requestId + originRole，避免 closure 读旧 state */
  onSelect: (requestId: string, originRole: TuiPermissionPrompt['originRole'], reply: PermissionReply, message?: string) => void;
}

type PermissionStage = "permission" | "always" | "reject";

function formatToolDisplay(toolName: string, metadata: Record<string, unknown>): string {
  const name = toolName.toLowerCase();

  if (name === 'bash' || name === 'shell' || name === 'shell_exec') {
    const cmd = metadata.command ?? metadata.cmd ?? '';
    return typeof cmd === 'string' ? cmd : JSON.stringify(cmd);
  }

  const filePath = metadata.filePath ?? metadata.path ?? metadata.file;
  if (typeof filePath === 'string') {
    return filePath;
  }

  const url = metadata.url ?? metadata.query;
  if (typeof url === 'string') {
    return url;
  }

  return toolName;
}

function formatPermissionType(permission: string): string {
  const map: Record<string, string> = {
    read: t().permissionRead,
    edit: t().permissionEdit,
    bash: t().permissionExecute,
    shell: t().permissionExecute,
    external_directory: t().permissionDirectory,
    webfetch: t().permissionFetch,
    websearch: t().permissionSearch,
    task: t().permissionAgent,
  };
  return map[permission] ?? permission;
}

export function PermissionPrompt({ request, onSelect }: PermissionPromptProps) {
  const [stage, setStage] = useState<PermissionStage>("permission");
  const [selected, setSelected] = useState(0);
  const [rejectMessage, setRejectMessage] = useState('');
  const alive = useRef(true);

  useEffect(() => { return () => { alive.current = false; }; }, []);

  const permissionOptions = [
    { label: t().permissionAllowOnce, value: 'once' as const },
    { label: t().permissionAlwaysAllow, value: 'always' as const },
    { label: t().permissionReject, value: 'reject' as const },
  ];

  const alwaysOptions = [
    { label: 'Confirm', value: 'confirm' as const },
    { label: 'Cancel', value: 'cancel' as const },
  ];

  useInput((_input, key) => {
    if (stage === "permission") {
      if (key.upArrow) {
        setSelected(prev => (prev - 1 + permissionOptions.length) % permissionOptions.length);
      } else if (key.downArrow) {
        setSelected(prev => (prev + 1) % permissionOptions.length);
      } else if (key.return) {
        const opt = permissionOptions[selected];
        if (!alive.current) return;

        if (opt.value === 'once') {
          onSelect(request.id, request.originRole, 'once');
        } else if (opt.value === 'always') {
          setStage("always");
          setSelected(0);
        } else {
          onSelect(request.id, request.originRole, 'reject');
        }
      } else if (key.escape) {
        if (alive.current) onSelect(request.id, request.originRole, 'reject');
      }
    } else if (stage === "always") {
      if (key.upArrow) {
        setSelected(prev => (prev - 1 + alwaysOptions.length) % alwaysOptions.length);
      } else if (key.downArrow) {
        setSelected(prev => (prev + 1) % alwaysOptions.length);
      } else if (key.return) {
        const opt = alwaysOptions[selected];
        if (!alive.current) return;

        if (opt.value === 'confirm') {
          onSelect(request.id, request.originRole, 'always');
        } else {
          setStage("permission");
          setSelected(0);
        }
      } else if (key.escape) {
        if (alive.current) {
          setStage("permission");
          setSelected(0);
        }
      }
    } else if (stage === "reject") {
      if (key.escape) {
        if (alive.current) {
          setStage("permission");
          setSelected(0);
          setRejectMessage('');
        }
      } else if (key.return) {
        if (alive.current) {
          onSelect(request.id, request.originRole, 'reject', rejectMessage || undefined);
        }
      }
    }
  });

  const toolDisplay = formatToolDisplay(request.tool?.toolName ?? 'unknown', request.metadata);
  const permissionType = formatPermissionType(request.permission);

  if (stage === "always") {
    return (
      <Box flexDirection="column" width="100%" borderStyle="round" borderColor="warning" paddingX={1} paddingY={1} marginBottom={1}>
        <Box marginBottom={1}>
          <Text bold color="warning">{`⚠️  ${t().permissionAlwaysTitle}`}</Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            <Text bold>{request.tool?.toolName}</Text>
            <Text>{` ${t().permissionAlwaysAutoApproved}`}</Text>
          </Text>
        </Box>
        {request.patterns.map((pattern, i) => (
          <Box key={i} paddingLeft={1}>
            <Text>{`• ${pattern}`}</Text>
          </Box>
        ))}
        {request.always.length > 0 && (
          <Box marginTop={1} marginBottom={1}>
            <Text dimColor>{`${t().permissionSuggested} ${request.always.join(', ')}`}</Text>
          </Box>
        )}
        {alwaysOptions.map((opt, i) => (
          <Box key={opt.value} paddingLeft={1}>
            <Text color={i === selected ? 'warning' : undefined}>
              {i === selected ? '▸ ' : '  '}
            </Text>
            <Text bold={i === selected} color={i === selected ? 'warning' : undefined}>
              {opt.label}
            </Text>
          </Box>
        ))}
        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>{t().permissionEnterConfirm}</Text>
        </Box>
      </Box>
    );
  }

  if (stage === "reject") {
    return (
      <Box flexDirection="column" width="100%" borderStyle="round" borderColor="error" paddingX={1} paddingY={1} marginBottom={1}>
        <Box marginBottom={1}>
          <Text bold color="error">{`❌ ${t().permissionRejectTitle}`}</Text>
        </Box>
        <Box marginBottom={1}>
          <Text>
            <Text bold>{request.tool?.toolName}</Text>
            <Text>{` ${t().permissionToolDenied}`}</Text>
          </Text>
        </Box>
        <Box marginBottom={1}>
          <Text dimColor>{t().permissionTypeMessage}</Text>
        </Box>
        <Box paddingLeft={1} marginBottom={1}>
          <Text color="error">{`> ${rejectMessage}_`}</Text>
        </Box>
        <Box marginTop={1} paddingLeft={1}>
          <Text dimColor>{t().permissionEnterSubmit}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width="100%" borderStyle="round" borderColor="warning" paddingX={1} paddingY={1} marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color="warning">{`🔐 ${permissionType}`}</Text>
      </Box>
      <Box marginBottom={1}>
        <Text>
          <Text bold>{request.tool?.toolName}</Text>
          <Text>{` ${t().permissionToolWants}`}</Text>
        </Text>
      </Box>
      <Box paddingLeft={1} marginBottom={1}>
        <Text color="warning">{`$ ${toolDisplay}`}</Text>
      </Box>
      {request.patterns.length > 0 && (
        <Box marginBottom={1}>
          <Text dimColor>{`${t().permissionPatterns} ${request.patterns.join(', ')}`}</Text>
        </Box>
      )}
      {permissionOptions.map((opt, i) => (
        <Box key={opt.value} paddingLeft={1}>
          <Text color={i === selected ? 'warning' : undefined}>
            {i === selected ? '▸ ' : '  '}
          </Text>
          <Text bold={i === selected} color={i === selected ? 'warning' : undefined}>
            {opt.label}
          </Text>
        </Box>
      ))}
      <Box marginTop={1} paddingLeft={1}>
        <Text dimColor>{t().permissionUpDownSelect}</Text>
      </Box>
    </Box>
  );
}
