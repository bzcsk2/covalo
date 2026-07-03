import { describe, it, expect } from "vitest"
import {
  isHardDeniedForSupervisorLoop,
  isHardDeniedForWorkerLoop,
  isToolAllowed,
} from "../src/config/adapter.js"
import { DEFAULT_CONFIG } from "../src/config/defaults.js"
import type { CovaloConfig } from "../src/config/schema.js"

describe("Tool Policy", () => {
  describe("isHardDeniedForSupervisorLoop", () => {
    it("should deny engineering tools for supervisor loop", () => {
      expect(isHardDeniedForSupervisorLoop("bash")).toBe(true)
      expect(isHardDeniedForSupervisorLoop("edit_file")).toBe(true)
      expect(isHardDeniedForSupervisorLoop("apply_patch")).toBe(true)
      expect(isHardDeniedForSupervisorLoop("write_file")).toBe(true)
      expect(isHardDeniedForSupervisorLoop("AgentTool")).toBe(true)
    })

    it("should allow non-engineering tools for supervisor loop", () => {
      expect(isHardDeniedForSupervisorLoop("get_goal")).toBe(false)
      expect(isHardDeniedForSupervisorLoop("list_dir")).toBe(false)
      expect(isHardDeniedForSupervisorLoop("read_file")).toBe(false)
      expect(isHardDeniedForSupervisorLoop("grep")).toBe(false)
    })
  })

  describe("isHardDeniedForWorkerLoop", () => {
    it("should deny goal tools for worker loop", () => {
      expect(isHardDeniedForWorkerLoop("update_goal")).toBe(true)
    })

    it("should allow non-goal tools for worker loop", () => {
      expect(isHardDeniedForWorkerLoop("bash")).toBe(false)
      expect(isHardDeniedForWorkerLoop("edit_file")).toBe(false)
      expect(isHardDeniedForWorkerLoop("read_file")).toBe(false)
      expect(isHardDeniedForWorkerLoop("grep")).toBe(false)
    })
  })

  describe("isToolAllowed", () => {
    it("should deny tools in deny list", () => {
      const config: CovaloConfig = {
        ...DEFAULT_CONFIG,
        tools: {
          ...DEFAULT_CONFIG.tools,
          worker: {
            loop: {
              allow: [],
              deny: ["bash", "edit_file"],
            },
            subagent: {
              allow: [],
              deny: [],
            },
          },
        },
      }

      expect(isToolAllowed(config, "worker", "loop", "bash")).toBe(false)
      expect(isToolAllowed(config, "worker", "loop", "edit_file")).toBe(false)
      expect(isToolAllowed(config, "worker", "loop", "read_file")).toBe(true)
    })

    it("should only allow tools in allow list when specified", () => {
      const config: CovaloConfig = {
        ...DEFAULT_CONFIG,
        tools: {
          ...DEFAULT_CONFIG.tools,
          worker: {
            loop: {
              allow: ["read_file", "grep"],
              deny: [],
            },
            subagent: {
              allow: [],
              deny: [],
            },
          },
        },
      }

      expect(isToolAllowed(config, "worker", "loop", "read_file")).toBe(true)
      expect(isToolAllowed(config, "worker", "loop", "grep")).toBe(true)
      expect(isToolAllowed(config, "worker", "loop", "bash")).toBe(false)
    })

    it("should allow all tools when allow list is empty and deny list is empty", () => {
      const config: CovaloConfig = {
        ...DEFAULT_CONFIG,
        tools: {
          ...DEFAULT_CONFIG.tools,
          worker: {
            loop: {
              allow: [],
              deny: [],
            },
            subagent: {
              allow: [],
              deny: [],
            },
          },
        },
      }

      expect(isToolAllowed(config, "worker", "loop", "bash")).toBe(true)
      expect(isToolAllowed(config, "worker", "loop", "read_file")).toBe(true)
    })
  })
})