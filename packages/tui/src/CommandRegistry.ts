/** Centralized slash command registry — single source of truth for commands. */

export interface SlashCommand {
  name: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/exit', description: 'exit' },
  { name: '/bye', description: 'exit' },
  { name: '/help', description: 'show help' },
  { name: '/model', description: 'switch provider/model' },
  { name: '/sessions', description: 'browse past sessions' },
  { name: '/agent', description: 'switch agent' },
  { name: '/skill', description: 'list loaded skills' },
  { name: '/lang', description: 'switch language' },
  { name: '/thinking', description: 'set thinking mode (off/low/medium/high/max)' },
];

export function filterCommands(query: string): SlashCommand[] {
  const lower = query.toLowerCase();
  return SLASH_COMMANDS.filter(cmd => cmd.name.startsWith(lower));
}
