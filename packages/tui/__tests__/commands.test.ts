import { describe, expect, it } from "bun:test"
import {
  buildHelpText,
  formatSkillList,
  getThinkingModes,
  parseSlashCommand,
  toggleAgent,
  validateThinkingMode,
} from "../src/commands.js"

describe("CL-52: slash command routing helpers", () => {
  it("parses supported commands and the exit alias", () => {
    expect(parseSlashCommand("/exit")).toEqual({ name: "exit" })
    expect(parseSlashCommand("/bye")).toEqual({ name: "exit" })
    expect(parseSlashCommand("  /model  ")).toEqual({ name: "model" })
    expect(parseSlashCommand("/sessions")).toEqual({ name: "sessions" })
    expect(parseSlashCommand("/skill")).toEqual({ name: "skill" })
    expect(parseSlashCommand("/agent")).toEqual({ name: "agent" })
    expect(parseSlashCommand("/lang")).toEqual({ name: "lang" })
    expect(parseSlashCommand("/status")).toEqual({ name: "status" })
    expect(parseSlashCommand("/context")).toEqual({ name: "context" })
  })

  it("keeps normal and unknown input outside slash routing", () => {
    expect(parseSlashCommand("hello")).toBeNull()
    expect(parseSlashCommand("/unknown")).toBeNull()
  })

  it("parses and validates thinking modes", () => {
    expect(parseSlashCommand("/thinking high")).toEqual({ name: "thinking", mode: "high" })
    expect(parseSlashCommand("/thinking")).toEqual({ name: "thinking", mode: "" })
    expect(getThinkingModes()).toEqual(["off", "open", "high"])
    expect(validateThinkingMode("open")).toBeNull()
    expect(validateThinkingMode("invalid")).toContain("Usage: /thinking <mode>")
  })

  it("toggles through all registered agents", () => {
    expect(toggleAgent("worker").next).toBe("supervisor")
    expect(toggleAgent("supervisor").next).toBe("worker")
  })

  it("builds help text with command strings and the active agent", () => {
    const help = buildHelpText("build", {
      cmdExit: "exit",
      cmdHelp: "help",
      cmdModel: "model",
      cmdSessions: "sessions",
      cmdAgent: "agent",
      cmdSkill: "skill",
      cmdLang: "lang",
      cmdStatus: "status",
      cmdContext: "context",
    })

    expect(help).toContain("/exit, /bye")
    expect(help).toContain("/status")
    expect(help).toContain("/context")
    expect(help).toContain("Agents:")
    expect(help).toContain("Current:")
  })

  it("formats skill lists with truncation and preserves malformed fallback", () => {
    const skills = Array.from({ length: 21 }, (_, index) => ({
      name: `skill-${index}`,
      description: `description-${index}`,
    }))
    const formatted = formatSkillList(
      JSON.stringify({ count: skills.length, skills }),
      count => `Loaded ${count}\n`,
    )

    expect(formatted).toContain("Loaded 21")
    expect(formatted).toContain("skill-19")
    expect(formatted).not.toContain("skill-20")
    expect(formatted).toContain("... and 1 more")
    expect(formatSkillList("not-json", count => `Loaded ${count}\n`)).toBe("not-json")
  })
})
