import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ExperienceRecord, RecallFilter, RecallResult } from "./experience-types";

export class ExperienceStore {
  private jsonlPath: string;

  constructor(baseDir: string) {
    this.jsonlPath = join(baseDir, ".covalo", "experience", "experiences.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(join(this.jsonlPath, ".."), { recursive: true });
  }

  async append(record: ExperienceRecord): Promise<void> {
    const line = JSON.stringify(record) + "\n";
    await appendFile(this.jsonlPath, line, "utf-8");
  }

  async appendMany(records: ExperienceRecord[]): Promise<void> {
    const lines = records.map(r => JSON.stringify(r) + "\n").join("");
    await appendFile(this.jsonlPath, lines, "utf-8");
  }

  async recall(filter: RecallFilter = {}): Promise<RecallResult> {
    if (!existsSync(this.jsonlPath)) {
      return { records: [], total: 0, appliedFilters: filter };
    }
    const content = await readFile(this.jsonlPath, "utf-8");
    const MAX_RECALL_LINES = 5000;
    const lines = content.trim().split("\n").filter(Boolean).slice(-MAX_RECALL_LINES);
    const all: ExperienceRecord[] = [];
    for (const line of lines) {
      try {
        all.push(JSON.parse(line) as ExperienceRecord);
      } catch {
        continue;
      }
    }

    // Load superseded IDs (records referenced by any record's supersedes field)
    const supersededIds = new Set<string>();
    for (const r of all) {
      if (r.supersedes) {
        for (const s of r.supersedes) {
          supersededIds.add(s);
        }
      }
    }

    let filtered = all.filter(r => {
      // Hide superseded by default
      if (supersededIds.has(r.id)) return false;

      if (filter.sourceKind && !filter.sourceKind.includes(r.sourceKind)) return false;
      if (filter.trust && !filter.trust.includes(r.trust)) return false;
      if (filter.failureMode && r.failureMode !== filter.failureMode) return false;
      if (filter.sourceRef && r.sourceRef !== filter.sourceRef) return false;
      if (filter.taskType && !filter.taskType.includes(r.taskType)) return false;
      if (filter.minConfidence !== undefined && r.confidence < filter.minConfidence) return false;
      if (filter.maxAgeMs !== undefined) {
        const age = Date.now() - new Date(r.createdAt).getTime();
        if (age > filter.maxAgeMs) return false;
      }
      return true;
    });

    // Sort by confidence desc, then createdAt desc
    filtered.sort((a, b) => b.confidence - a.confidence || new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const total = filtered.length;
    if (filter.limit !== undefined && filter.limit > 0) {
      filtered = filtered.slice(0, filter.limit);
    }

    return { records: filtered, total, appliedFilters: filter };
  }

  async count(): Promise<number> {
    if (!existsSync(this.jsonlPath)) return 0;
    const content = await readFile(this.jsonlPath, "utf-8");
    return content.trim().split("\n").filter(Boolean).length;
  }

  async getById(id: string): Promise<ExperienceRecord | null> {
    if (!existsSync(this.jsonlPath)) return null;
    const content = await readFile(this.jsonlPath, "utf-8");
    for (const line of content.trim().split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as ExperienceRecord;
      if (r.id === id) return r;
    }
    return null;
  }

  async promote(id: string): Promise<boolean> {
    const record = await this.getById(id);
    if (!record) return false;
    if (record.trust === "trusted") return true;
    record.trust = "trusted";
    // Append the updated record (supersedes the old one)
    await this.append(record);
    // Mark old version as superseded
    const superseder = { ...record, id: `${record.id}:v2`, supersedes: [record.id] };
    await this.append(superseder);
    return true;
  }

  async close(): Promise<void> {
    // no-op for file store
  }
}
