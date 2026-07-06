import { getPromptLocale } from "../prompt-locale.js"

export function buildActiveSkillsPrompt(
  activeSkills: Array<{ name: string; description: string; content: string }>,
): string {
  if (activeSkills.length === 0) return ""
  const isZh = getPromptLocale() === "zh-CN"
  const blocks = activeSkills.map(skill => [
    `### ${skill.name}`,
    skill.description,
    skill.content.trim(),
  ].filter(Boolean).join("\n"))
  return [
    isZh ? "## 已启用的技能" : "## Enabled Skills",
    isZh
      ? "以下技能已在此会话中启用。在相关时将其用作指导。"
      : "The following skills are enabled for this session. Use them as guidance when relevant.",
    "",
    blocks.join("\n\n"),
  ].join("\n")
}
