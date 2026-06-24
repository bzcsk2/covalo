import { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from '@deepreef/ink';
import { createSkillTool } from '@deepreef/tools';
import { ModalShell } from './ModalShell.js';
import { FG, TONE } from './reasonix/tokens.js';
import { t } from './i18n/index.js';

export interface SkillRecord {
  name: string;
  description: string;
  content: string;
}

interface SkillListItem {
  name: string;
  description: string;
}

interface SkillModalProps {
  activeSkills: SkillRecord[];
  onChange: (skills: SkillRecord[]) => void;
  onInsertSkill: (skillName: string) => void;
  onClose: () => void;
}

function parseList(content: unknown): SkillListItem[] {
  const parsed = JSON.parse(typeof content === 'string' ? content : String(content ?? '{}')) as {
    skills?: Array<{ name?: string; description?: string }>;
  };
  return (parsed.skills ?? [])
    .filter((skill): skill is { name: string; description?: string } => typeof skill.name === 'string')
    .map(skill => ({ name: skill.name, description: skill.description ?? '' }));
}

function parseLoadedSkill(content: unknown): SkillRecord {
  const parsed = JSON.parse(typeof content === 'string' ? content : String(content ?? '{}')) as Partial<SkillRecord>;
  if (!parsed.name || !parsed.description || !parsed.content) {
    throw new Error('invalid skill payload');
  }
  return { name: parsed.name, description: parsed.description, content: parsed.content };
}

export function SkillModal({ activeSkills, onChange, onInsertSkill, onClose }: SkillModalProps) {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [message, setMessage] = useState<string>(t().loadingSkills);
  const [busy, setBusy] = useState(false);

  const activeNames = useMemo(() => new Set(activeSkills.map(skill => skill.name)), [activeSkills]);
  const visible = skills.slice(Math.max(0, selectedIdx - 5), Math.max(12, selectedIdx + 7));
  const start = skills.indexOf(visible[0] ?? skills[0]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const tool = createSkillTool();
        const result = await tool.execute({ command: 'list' }, { cwd: process.cwd(), sessionId: '' });
        if (!alive) return;
        if (result.isError) {
          setMessage(typeof result.content === 'string' ? result.content : String(result.content ?? 'Failed to load skills'));
          return;
        }
        const list = parseList(result.content);
        setSkills(list);
        setMessage(list.length > 0 ? t().skillsAvailable(list.length) : t().noSkillsFound);
      } catch (error) {
        if (alive) setMessage(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => { alive = false; };
  }, []);

  async function toggleSelected(): Promise<void> {
    const selected = skills[selectedIdx];
    if (!selected || busy) return;

    if (activeNames.has(selected.name)) {
      onChange(activeSkills.filter(skill => skill.name !== selected.name));
      setMessage(t().skillDisabled(selected.name));
      return;
    }

    setBusy(true);
    try {
      const tool = createSkillTool();
      const result = await tool.execute({ command: 'load', query: selected.name }, { cwd: process.cwd(), sessionId: '' });
      if (result.isError) {
        setMessage(typeof result.content === 'string' ? result.content : String(result.content ?? `Failed to load ${selected.name}`));
        return;
      }
      const loaded = parseLoadedSkill(result.content);
      onChange([...activeSkills.filter(skill => skill.name !== loaded.name), loaded]);
      setMessage(t().skillEnabled(loaded.name));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  useInput((input, key) => {
    if (key.escape || (key.ctrl && input === 'c')) {
      onClose();
      return;
    }
    if (skills.length === 0) return;
    if (key.upArrow) {
      setSelectedIdx(prev => (prev - 1 + skills.length) % skills.length);
      return;
    }
    if (key.downArrow) {
      setSelectedIdx(prev => (prev + 1) % skills.length);
      return;
    }
    if (input === ' ') {
      void toggleSelected();
      return;
    }
    if (key.return) {
      const selected = skills[selectedIdx];
      if (selected) onInsertSkill(selected.name);
    }
  });

  return (
    <ModalShell title="/skill" subtitle={message} onCancel={onClose} width={92}>
      <Box flexDirection="column" gap={1}>
        {visible.map((skill, offset) => {
          const index = start + offset;
          const selected = index === selectedIdx;
          const enabled = activeNames.has(skill.name);
          return (
            <Box key={skill.name} flexDirection="column">
              <Box flexDirection="row">
                <Text color={selected ? TONE.brand : FG.faint}>{selected ? '❯ ' : '  '}</Text>
                <Text color={enabled ? TONE.brand : FG.faint}>{enabled ? '● ' : '○ '}</Text>
                <Text bold={selected} color={selected ? TONE.brand : FG.body}>{skill.name}</Text>
              </Box>
              <Box paddingLeft={4}>
                <Text color={FG.sub} wrap="truncate">{skill.description || t().skillNoDescription}</Text>
              </Box>
            </Box>
          );
        })}
        <Box marginTop={1}>
          <Text color={FG.faint}>{t().skillFooterHint}</Text>
        </Box>
      </Box>
    </ModalShell>
  );
}
