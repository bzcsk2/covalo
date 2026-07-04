/** Centralized slash command registry — single source of truth for commands. */

import type { Strings } from './i18n/strings.js';

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: Array<{ name: string; descKey: keyof Strings }> = [
  { name: '/exit', descKey: 'cmdExit' },
  { name: '/bye', descKey: 'cmdExit' },
  { name: '/help', descKey: 'cmdHelp' },
  { name: '/model', descKey: 'cmdModel' },
  { name: '/sessions', descKey: 'cmdSessions' },
  { name: '/agent', descKey: 'cmdAgent' },
  { name: '/skill', descKey: 'cmdSkill' },
  { name: '/lang', descKey: 'cmdLang' },
  { name: '/status', descKey: 'cmdStatus' },
  { name: '/context', descKey: 'cmdContext' },
  { name: '/thinking', descKey: 'cmdThinking' },
  { name: '/harness', descKey: 'cmdThinking' },
  { name: '/cases', descKey: 'cmdCases' },
  { name: '/eval', descKey: 'cmdEval' },
  { name: '/talk', descKey: 'cmdTalk' },
  { name: '/theme', descKey: 'cmdTheme' },
  { name: '/reset', descKey: 'cmdReset' },
  { name: '/config', descKey: 'cmdConfig' },
  { name: '/config open', descKey: 'cmdConfigOpen' },
  { name: '/config reload', descKey: 'cmdConfigReload' },
  { name: '/alone', descKey: 'cmdAlone' },
  { name: '/subagent', descKey: 'cmdSubagent' },
  { name: '/loop', descKey: 'cmdLoop' },
  { name: '/eval-start', descKey: 'cmdEvalStart' },
  { name: '/eval-cancel', descKey: 'cmdEvalCancel' },
];

export function filterCommands(query: string, t?: () => Strings): SlashCommand[] {
  const lower = query.toLowerCase();
  return SLASH_COMMANDS
    .filter(cmd => cmd.name.startsWith(lower))
    .map(cmd => ({
      name: cmd.name,
      description: t ? (t() as any)[cmd.descKey] as string : cmd.name,
    }));
}
