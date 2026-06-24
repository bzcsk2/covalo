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
  { name: '/workflow', descKey: 'cmdWorkflow' },
  { name: '/goal', descKey: 'cmdGoal' },
  { name: '/goal edit', descKey: 'cmdGoalEdit' },
  { name: '/goal pause', descKey: 'cmdGoalPause' },
  { name: '/goal resume', descKey: 'cmdGoalResume' },
  { name: '/goal clear', descKey: 'cmdGoalClear' },
  { name: '/goal budget', descKey: 'cmdGoalBudget' },
  { name: '/goal no-budget', descKey: 'cmdGoalNoBudget' },
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
