import { describe, expect, it } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BranchBudgetTracker } from "../src/governance/branch-budget.js"
import {
  extractRunCommand,
  extractToolTargetPath,
} from "../src/governance/branch-budget-tool-path.js"

describe("BranchBudgetTracker - hard block gate", () => {
  it("wouldBlockFileEdit when count reaches fileEditMax", () => {
    const t = new BranchBudgetTracker({ fileEditMax: 3 })
    t.recordFileEdit("src/tasks.ts")
    t.recordFileEdit("src/tasks.ts")
    t.recordFileEdit("src/tasks.ts")
    expect(t.wouldBlockFileEdit("src/tasks.ts")).toBe(true)
    expect(t.wouldBlockFileEdit("src/other.ts")).toBe(false)
  })

  it("checkToolBlock rejects write_file at limit", () => {
    const t = new BranchBudgetTracker({ fileEditMax: 2 })
    t.recordFileEdit("src/a.ts")
    t.recordFileEdit("src/a.ts")
    const block = t.checkToolBlock(
      "write_file",
      { path: "src/a.ts" },
      extractToolTargetPath,
      extractRunCommand,
    )
    expect(block.blocked).toBe(true)
    expect(block.dimension).toBe("file_edit")
    expect(block.message).toMatch(/Blocked/)
  })

  it("checkToolBlock rejects run_command after failed retries", () => {
    const t = new BranchBudgetTracker({ commandRetryMax: 2 })
    t.recordFailedCommandAttempt("npm test")
    t.recordFailedCommandAttempt("npm test")
    const block = t.checkToolBlock(
      "run_command",
      { command: "npm test" },
      extractToolTargetPath,
      extractRunCommand,
    )
    expect(block.blocked).toBe(true)
    expect(block.dimension).toBe("command_retry")
  })

  it("checkToolBlock is no-op when disabled", () => {
    const t = new BranchBudgetTracker({ fileEditMax: 1 })
    t.setEnabled(false)
    t.recordFileEdit("src/a.ts")
    t.recordFileEdit("src/a.ts")
    expect(t.checkToolBlock(
      "edit_file",
      { path: "src/a.ts" },
      extractToolTargetPath,
      extractRunCommand,
    ).blocked).toBe(false)
  })

  it("allows write_file at file cap when path missing on disk", () => {
    const root = mkdtempSync(join(tmpdir(), "drf-budget-"))
    const t = new BranchBudgetTracker({ fileEditMax: 2 })
    const filePath = "src/scenes/MapSelectScene.ts"
    t.recordFileEdit(filePath)
    t.recordFileEdit(filePath)
    const block = t.checkToolBlock(
      "write_file",
      { path: filePath },
      extractToolTargetPath,
      extractRunCommand,
      { workspaceRoot: root },
    )
    expect(block.blocked).toBe(false)
  })

  it("file edit block message mentions rewrite guidance when file exists", () => {
    const root = mkdtempSync(join(tmpdir(), "drf-budget-"))
    const t = new BranchBudgetTracker({ fileEditMax: 2 })
    const filePath = "src/scenes/Existing.ts"
    mkdirSync(join(root, "src", "scenes"), { recursive: true })
    writeFileSync(join(root, filePath), "export {};\n")
    t.recordFileEdit(filePath)
    t.recordFileEdit(filePath)
    const block = t.checkToolBlock(
      "write_file",
      { path: filePath },
      extractToolTargetPath,
      extractRunCommand,
      { workspaceRoot: root },
    )
    expect(block.blocked).toBe(true)
    expect(block.message).toMatch(/不要重写此文件/)
  })

  it("file edit block message mentions write_file when file missing", () => {
    const root = mkdtempSync(join(tmpdir(), "drf-budget-"))
    const t = new BranchBudgetTracker({ fileEditMax: 2 })
    const filePath = "src/scenes/Missing.ts"
    t.recordFileEdit(filePath)
    t.recordFileEdit(filePath)
    const block = t.checkToolBlock(
      "edit_file",
      { path: filePath },
      extractToolTargetPath,
      extractRunCommand,
      { workspaceRoot: root },
    )
    expect(block.blocked).toBe(true)
    expect(block.message).toMatch(/write_file/)
    expect(block.message).toMatch(/不存在/)
  })
})
