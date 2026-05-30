import { readFile, readdir, stat } from "node:fs/promises"
import { join, isAbsolute, resolve } from "node:path"
import { homedir } from "node:os"

export interface SkillDef {
  name: string
  description: string
  whenToUse?: string
  content: string
  baseDir?: string
  tags?: string[]
}

const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/

function parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const match = raw.match(FRONTMATTER_RE)
  if (!match) return { frontmatter: {}, content: raw }
  const frontmatter: Record<string, unknown> = {}
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":")
    if (colon > 0) {
      const key = line.slice(0, colon).trim()
      const rawVal = line.slice(colon + 1).trim()
      let val: unknown = rawVal
      if (rawVal.startsWith('"') && rawVal.endsWith('"')) val = rawVal.slice(1, -1)
      else if (rawVal.startsWith("'") && rawVal.endsWith("'")) val = rawVal.slice(1, -1)
      else if (rawVal === "true") val = true
      else if (rawVal === "false") val = false
      frontmatter[key] = val
    }
  }
  return { frontmatter, content: match[2].trim() }
}

export async function loadSkillsDirs(dirs: string[]): Promise<SkillDef[]> {
  const results: SkillDef[] = []
  for (const dir of dirs) {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch { continue }
    for (const entry of entries) {
      const skillDir = join(dir, entry)
      let s: Awaited<ReturnType<typeof stat>>
      try { s = await stat(skillDir); if (!s.isDirectory()) continue } catch { continue }
      const skillFile = join(skillDir, "SKILL.md")
      let raw: string
      try { raw = await readFile(skillFile, "utf-8") } catch { continue }
      const { frontmatter, content } = parseFrontmatter(raw)
      const name = (frontmatter.name as string) ?? entry
      const desc = (frontmatter.description as string) ?? ""
      const whenToUse = frontmatter.when_to_use as string | undefined
      const tagsRaw = frontmatter.tags
      const tags = Array.isArray(tagsRaw) ? tagsRaw.map(String) : typeof tagsRaw === "string" ? tagsRaw.split(",").map(s => s.trim()) : undefined
      results.push({ name, description: desc, whenToUse, content, baseDir: skillDir, tags })
    }
  }
  return results
}

export function matchSkills(query: string, skills: SkillDef[]): SkillDef[] {
  const q = query.toLowerCase()
  return skills.filter(s => {
    if (s.name.toLowerCase().includes(q)) return true
    if (s.description.toLowerCase().includes(q)) return true
    if (s.whenToUse?.toLowerCase().includes(q)) return true
    if (s.tags?.some(t => t.toLowerCase().includes(q))) return true
    return false
  }).slice(0, 10)
}
