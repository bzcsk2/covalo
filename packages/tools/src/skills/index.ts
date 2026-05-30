import type { AgentTool } from "../../../core/src/interface.js"
import { safeStringify } from "../safe-stringify.js"
import { loadSkillsDirs, matchSkills } from "../skill-loader.js"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export type { SkillDef } from "../skill-loader.js"

let cachedSkills: Awaited<ReturnType<typeof loadSkillsDirs>> | null = null

async function getSkills(): Promise<Awaited<ReturnType<typeof loadSkillsDirs>>> {
  if (cachedSkills) return cachedSkills
  const dirname = typeof __dirname !== "undefined" ? __dirname : join(process.cwd(), "packages/tools/src/skills")
  const dirs = [join(dirname)]
  cachedSkills = await loadSkillsDirs(dirs)
  return cachedSkills
}

export function createSkillTool(): AgentTool {
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
        const skills = await getSkills()

        switch (cmd) {
          case "list": {
            return {
              content: safeStringify({
                count: skills.length,
                skills: skills.map(s => ({ name: s.name, description: s.description, tags: s.tags })),
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
                skills: matches.map(s => ({ name: s.name, description: s.description, tags: s.tags })),
              }),
              isError: false,
            }
          }

          case "load": {
            if (typeof args.query !== "string" || !args.query) {
              return { content: safeStringify({ error: "skill name is required for load" }), isError: true }
            }
            const match = skills.find(s => s.name === args.query)
            if (!match) {
              return { content: safeStringify({ error: `Skill not found: ${args.query}` }), isError: true }
            }
            return {
              content: safeStringify({
                name: match.name,
                description: match.description,
                content: match.content,
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
