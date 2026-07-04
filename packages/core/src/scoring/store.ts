import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from "node:fs"
import { dirname, resolve, join } from "node:path"
import type { AgentRunScore } from "./types.js"
import type { AgentBenchmarkLeaderboardEntry, AgentBenchmarkSuiteSummary, AgentBenchmarkRunScore } from "./types.js"

export interface AgentScoreStoreOptions {
  basePath?: string
}

export class AgentScoreStore {
  private basePath: string

  constructor(options: AgentScoreStoreOptions = {}) {
    this.basePath = options.basePath ?? resolve(process.cwd(), ".covalo", "scores")
  }

  private pathForWorkflow(workflowId: string): string {
    return resolve(this.basePath, `${safeName(workflowId)}.jsonl`)
  }

  append(score: AgentRunScore): void {
    const workflowId = score.workflowId ?? "benchmark"
    const path = this.pathForWorkflow(workflowId)
    mkdirSync(dirname(path), { recursive: true })
    const line = JSON.stringify(score)
    appendFileSync(path, line + "\n", "utf8")
  }

  list(workflowId: string): AgentRunScore[] {
    const path = this.pathForWorkflow(workflowId)
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AgentRunScore]
        } catch {
          return []
        }
      })
  }

  latest(workflowId: string): AgentRunScore | null {
    const scores = this.list(workflowId)
    return scores.at(-1) ?? null
  }
}

export class EvalReportStore {
  private basePath: string

  constructor(basePath?: string) {
    this.basePath = basePath ?? resolve(process.cwd(), ".covalo", "evals")
  }

  private evalDir(evalRunId: string): string {
    return resolve(this.basePath, evalRunId)
  }

  private ensureDir(evalRunId: string): void {
    mkdirSync(this.evalDir(evalRunId), { recursive: true })
  }

  listEvalRuns(): string[] {
    if (!existsSync(this.basePath)) return []
    return readdirSync(this.basePath)
      .filter(name => name.startsWith("eval-"))
      .sort()
      .reverse()
  }

  saveMeta(evalRunId: string, meta: Record<string, unknown>): void {
    this.ensureDir(evalRunId)
    writeFileSync(join(this.evalDir(evalRunId), "meta.json"), JSON.stringify(meta, null, 2), "utf8")
  }

  saveSummary(evalRunId: string, summary: AgentBenchmarkSuiteSummary): void {
    this.ensureDir(evalRunId)
    writeFileSync(join(this.evalDir(evalRunId), "summary.json"), JSON.stringify(summary, null, 2), "utf8")
  }

  saveLeaderboard(evalRunId: string, leaderboard: AgentBenchmarkLeaderboardEntry[]): void {
    this.ensureDir(evalRunId)
    writeFileSync(join(this.evalDir(evalRunId), "leaderboard.json"), JSON.stringify(leaderboard, null, 2), "utf8")
  }

  saveScores(evalRunId: string, scores: AgentBenchmarkRunScore[]): void {
    this.ensureDir(evalRunId)
    const lines = scores.map(s => JSON.stringify(s)).join("\n")
    writeFileSync(join(this.evalDir(evalRunId), "scores.jsonl"), lines + "\n", "utf8")
  }

  loadMeta(evalRunId: string): Record<string, unknown> | null {
    const path = join(this.evalDir(evalRunId), "meta.json")
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return null
    }
  }

  loadSummary(evalRunId: string): Record<string, unknown> | null {
    const path = join(this.evalDir(evalRunId), "summary.json")
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return null
    }
  }

  loadLeaderboard(evalRunId: string): Record<string, unknown> | null {
    const path = join(this.evalDir(evalRunId), "leaderboard.json")
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return null
    }
  }

  loadScores(evalRunId: string): AgentBenchmarkRunScore[] {
    const path = join(this.evalDir(evalRunId), "scores.jsonl")
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .flatMap(l => {
        try {
          return [JSON.parse(l) as AgentBenchmarkRunScore]
        } catch {
          return []
        }
      })
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 120) || "unknown"
}
