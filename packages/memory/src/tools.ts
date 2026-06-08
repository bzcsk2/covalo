import type { AgentTool, ToolResult } from "@deepreef/core"
import type { MemoryService } from "./memory-service.js"

function ok(content: unknown): ToolResult {
  return { content: typeof content === "string" ? content : JSON.stringify(content, null, 2), isError: false }
}

function err(msg: string): ToolResult {
  return { content: msg, isError: true }
}

export function createMemoryRecallTool(memory: MemoryService): AgentTool {
  return {
    name: "memory_recall",
    description: "Recall memories related to a query. Returns recent relevant context from past sessions.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query to find relevant memories" },
        limit: { type: "number", description: "Max results (default 5)", default: 5 },
      },
      required: ["query"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args): Promise<ToolResult> {
      try {
        const q = String(args.query ?? "")
        const limit = Number(args.limit ?? 5)
        const result = await memory.trigger("mem::search", { query: q, limit })
        return ok(result)
      } catch (e) { return err(String(e)) }
    },
  }
}

export function createMemorySaveTool(memory: MemoryService): AgentTool {
  return {
    name: "memory_save",
    description: "Save important information to long-term memory for future recall.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Content to remember" },
        tags: { type: "array", items: { type: "string" }, description: "Optional tags" },
      },
      required: ["content"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args): Promise<ToolResult> {
      try {
        const result = await memory.trigger("mem::remember", {
          content: String(args.content ?? ""),
          tags: Array.isArray(args.tags) ? args.tags : [],
        })
        return ok(result)
      } catch (e) { return err(String(e)) }
    },
  }
}

export function createMemorySmartSearchTool(memory: MemoryService): AgentTool {
  return {
    name: "memory_smart_search",
    description: "Advanced semantic search across all memories with hybrid BM25 + vector ranking.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "number", default: 10 },
      },
      required: ["query"],
    },
    concurrency: "shared",
    approval: "read",
    async execute(args): Promise<ToolResult> {
      try {
        const result = await memory.trigger("mem::smart-search", {
          query: String(args.query ?? ""),
          limit: Number(args.limit ?? 10),
        })
        return ok(result)
      } catch (e) { return err(String(e)) }
    },
  }
}

export function createMemoryForgetTool(memory: MemoryService): AgentTool {
  return {
    name: "memory_forget",
    description: "Delete a specific memory by ID.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Memory ID to delete" },
      },
      required: ["id"],
    },
    concurrency: "exclusive",
    approval: "write",
    async execute(args): Promise<ToolResult> {
      try {
        const result = await memory.trigger("mem::evict", { ids: [String(args.id ?? "")] })
        return ok(result)
      } catch (e) { return err(String(e)) }
    },
  }
}

export function createMemoryTimelineTool(memory: MemoryService): AgentTool {
  return {
    name: "memory_timeline",
    description: "Get a timeline view of memories, grouped by time period.",
    parameters: {
      type: "object",
      properties: {
        period: { type: "string", enum: ["hour", "day", "week", "month"], default: "day" },
        limit: { type: "number", default: 20 },
      },
    },
    concurrency: "shared",
    approval: "read",
    async execute(args): Promise<ToolResult> {
      try {
        const result = await memory.trigger("mem::timeline", {
          period: String(args.period ?? "day"),
          limit: Number(args.limit ?? 20),
        })
        return ok(result)
      } catch (e) { return err(String(e)) }
    },
  }
}

export function createMemoryStatusTool(memory: MemoryService): AgentTool {
  return {
    name: "memory_status",
    description: "Get memory system status: count of stored memories, storage usage, and system health.",
    parameters: {
      type: "object",
      properties: {},
    },
    concurrency: "shared",
    approval: "read",
    async execute(): Promise<ToolResult> {
      try {
        const result = await memory.trigger("mem::diagnose", {})
        return ok(result)
      } catch (e) { return err(String(e)) }
    },
  }
}
