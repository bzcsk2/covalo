import type { AgentTool } from "@covalo/protocol"
import { safeStringify } from "../safe-stringify.js"
import { loadSkillsDirs, matchSkills } from "../skill-loader.js"
import type { SkillDef } from "../skill-loader.js"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type { SkillDef } from "../skill-loader.js"

export interface SkillToolOptions {
  skillDirs?: string[]
  preloadedSkills?: SkillDef[]
}

let cachedSkills: SkillDef[] | null = null
let cachedExtraDirs: string[] = []
let cachedPreloaded: SkillDef[] = []

async function getSkills(extraDirs: string[] = [], preloadedSkills: SkillDef[] = []): Promise<SkillDef[]> {
  if (cachedSkills !== null && arraysEqual(cachedExtraDirs, extraDirs) && cachedPreloaded === preloadedSkills) return cachedSkills

  const dirname = typeof __dirname !== "undefined" ? __dirname : join(process.cwd(), "packages/tools/src/skills")
  const dirs = [join(dirname), ...extraDirs]
  // Deduplicate
  const seen = new Set<string>()
  const uniqueDirs = dirs.filter(d => {
    if (seen.has(d)) return false
    seen.add(d)
    return true
  })

  const allSkills = await loadSkillsDirs(uniqueDirs)

  // Deduplicate by name: built-in skills (no source) keep their name and win.
  // External skills with name conflicts get namespace: <pluginId>:<name>.
  const builtinNames = new Set<string>()
  const result: SkillDef[] = []

  for (const skill of allSkills) {
    if (!skill.source) {
      // Built-in skill — always wins
      builtinNames.add(skill.name)
      result.push(skill)
    }
  }

  for (const skill of allSkills) {
    if (!skill.source) continue // already added

    if (builtinNames.has(skill.name)) {
      // External skill name conflicts with built-in — namespace it
      const pluginId = skill.source.pluginId ?? "external"
      const namespaced = `${pluginId}:${skill.name}`
      skill.name = namespaced
    } else if (result.some((s) => s.name === skill.name)) {
      // External skill name conflicts with another external skill
      const pluginId = skill.source.pluginId ?? "external"
      skill.name = `${pluginId}:${skill.name}`
    }

    result.push(skill)
  }

  // Merge preloaded skills (command skills, rule skills, etc.)
  // Preloaded skills are appended; name conflicts are resolved with namespace.
  for (const skill of preloadedSkills) {
    if (result.some((s) => s.name === skill.name)) {
      const namespaced = `ecc:${skill.name}`
      skill.name = namespaced
    }
    result.push(skill)
  }

  cachedSkills = result
  cachedExtraDirs = extraDirs
  cachedPreloaded = preloadedSkills
  return result
}

export function createSkillTool(options?: SkillToolOptions): AgentTool {
  const extraDirs = options?.skillDirs ?? []
  const preloaded = options?.preloadedSkills ?? []

  return {
    name: "Skill",
    description: "Load, search, and manage skills. Skills are reference guides that provide specialized knowledge and workflows. Use this tool to find relevant skills for your current task.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command: 'search' to find relevant skills, 'list' to show all skills, 'load' to load a specific skill by name.",
          enum: ["search", "list", "load"],
        },
        query: {
          type: "string",
          description: "Search query for 'search' command, or skill name for 'load' command.",
        },
      },
      required: ["command"],
    },
    concurrency: "exclusive",
    approval: "read",
    async execute(args) {
      const cmd = args.command
      if (typeof cmd !== "string") {
        return { content: safeStringify({ error: "command must be a string" }), isError: true }
      }

      try {
        const skills = await getSkills(extraDirs, preloaded)

        switch (cmd) {
          case "list": {
            return {
              content: safeStringify({
                count: skills.length,
                skills: skills.map(s => ({
                  name: s.name,
                  description: s.description,
                  tags: s.tags,
                  source: s.source?.pluginId ?? "built-in",
                })),
              }),
              isError: false,
            }
          }

          case "search": {
            if (typeof args.query !== "string" || !args.query) {
              return { content: safeStringify({ error: "query is required for search" }), isError: true }
            }
            const matches = matchSkills(args.query, skills)
            return {
              content: safeStringify({
                query: args.query,
                count: matches.length,
                skills: matches.map(s => ({
                  name: s.name,
                  description: s.description,
                  tags: s.tags,
                  source: s.source?.pluginId ?? "built-in",
                })),
              }),
              isError: false,
            }
          }

          case "load": {
            if (typeof args.query !== "string" || !args.query) {
              return { content: safeStringify({ error: "skill name is required for load" }), isError: true }
            }
            // Try exact match first, then namespace match
            let match = skills.find(s => s.name === args.query)
            if (!match) {
              match = skills.find(s => s.name.endsWith(`:${args.query}`) || s.name === `${extraDirs.length > 0 ? "ecc:" : ""}${args.query}`)
            }
            if (!match) {
              return { content: safeStringify({ error: `Skill not found: ${args.query}` }), isError: true }
            }
            return {
              content: safeStringify({
                name: match.name,
                description: match.description,
                content: match.content,
                source: match.source?.pluginId ?? "built-in",
              }),
              isError: false,
            }
          }

          default:
            return { content: safeStringify({ error: `Unknown command: ${cmd}` }), isError: true }
        }
      } catch (e) {
        return { content: safeStringify({ error: `Skill error: ${e instanceof Error ? e.message : String(e)}` }), isError: true }
      }
    },
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
