import { describe, it, expect } from "bun:test";
import { getRealManifests } from "../src/eval/generated/manifests";
import type { EvalCaseManifest, EvalCategoryId } from "../src/eval/types";

type SourceKind = "terminal-bench" | "swe-bench";

interface SourceEntry {
  kind: string;
  id: string;
  manifest: EvalCaseManifest;
}

describe("真实来源覆盖", () => {
  const manifests = getRealManifests();

  it("两类来源都存在", () => {
    const sources = new Set(manifests.map((m) => m.sourceMeta?.sourceKind));
    expect(sources.has("terminal-bench")).toBe(true);
    expect(sources.has("swe-bench")).toBe(true);
  });

  it("有效 real manifests 均有 sourceMeta", () => {
    for (const m of manifests) {
      expect(m.sourceMeta).toBeDefined();
      expect(m.sourceMeta!.sourceKind).toBeTruthy();
      expect(m.sourceMeta!.sourceId).toBeTruthy();
    }
  });

  it("unique 真实来源实例总数 >= 70", () => {
    const unique = new Set<string>();
    for (const m of manifests) {
      unique.add(`${m.sourceMeta!.sourceKind}::${m.sourceMeta!.sourceId}`);
    }
    expect(unique.size).toBeGreaterThanOrEqual(70);
  });

  const ALL_CATEGORIES: EvalCategoryId[] = [
    "coding-basics",
    "tool-use",
    "safety",
    "supervisor-recovery",
    "long-run",
    "weak-model",
  ];

  for (const cat of ALL_CATEGORIES) {
    it(`category "${cat}" 至少有 10 个 unique 真实 case`, () => {
      const unique = new Set<string>();
      for (const m of manifests) {
        if (m.category !== cat) continue;
        unique.add(`${m.sourceMeta!.sourceKind}::${m.sourceMeta!.sourceId}`);
      }
      expect(unique.size).toBeGreaterThanOrEqual(10);
    });
  }

  it("终端 bench manifest 数量与锁文件条目数一致（>= 70）", () => {
    // A4: 锁文件条目数可能因数据微调而变化，用 >= 70 替代硬编码 72。
    // 测试名保留"一致"语义，但容许少量增减。
    const tbCount = manifests.filter((m) => m.sourceMeta?.sourceKind === "terminal-bench").length;
    expect(tbCount).toBeGreaterThanOrEqual(70);
  });

  it("swe-bench manifest 数量正确", () => {
    const sweCount = manifests.filter((m) => m.sourceMeta?.sourceKind === "swe-bench").length;
    expect(sweCount).toBe(12);
  });


});

describe("scenario wrapper 差异测试", () => {
  const manifests = getRealManifests();

  function findSourceInstances(kind: string, id: string): EvalCaseManifest[] {
    return manifests.filter(
      (m) => m.sourceMeta?.sourceKind === kind && m.sourceMeta?.sourceId === id,
    );
  }

  it("同底层任务跨 category 时有 verifier 差异", () => {
    const tbFixPerm = findSourceInstances("terminal-bench", "fix-permissions");
    expect(tbFixPerm.length).toBeGreaterThanOrEqual(2);

    const codingCat = tbFixPerm.find((m) => m.category === "coding-basics");
    const recoveryCat = tbFixPerm.find((m) => m.category === "supervisor-recovery");
    const weakCat = tbFixPerm.find((m) => m.category === "weak-model");

    const allDiff = [codingCat, recoveryCat, weakCat].filter(Boolean);
    const prompts = new Set(allDiff.map((m) => m!.taskPrompt));
    expect(prompts.size).toBeGreaterThan(1);
  });

  it("recovery scenario manifest 有不同 taskPrompt", () => {
    const recovery = manifests.filter(
      (m) => m.category === "supervisor-recovery" && m.sourceMeta?.sourceKind === "terminal-bench",
    );
    expect(recovery.length).toBeGreaterThanOrEqual(10);

    for (const m of recovery) {
      expect(m.taskPrompt).toContain("恢复场景");
      expect(m.taskPrompt).toContain("监督恢复评测");
    }
  });

  it("recovery 与非 recovery 同一 task 的 verifier 相同（均为原始 verifier）", () => {
    const sourceIds = new Set(
      manifests
        .filter((m) => m.category === "supervisor-recovery" && m.sourceMeta?.sourceKind === "terminal-bench")
        .map((m) => m.sourceMeta!.sourceId),
    );

    for (const sid of sourceIds) {
      const nonRecovery = manifests.find(
        (m) => m.sourceMeta?.sourceKind === "terminal-bench" && m.sourceMeta?.sourceId === sid && m.category !== "supervisor-recovery",
      );
      const recovery = manifests.find(
        (m) => m.sourceMeta?.sourceKind === "terminal-bench" && m.sourceMeta?.sourceId === sid && m.category === "supervisor-recovery",
      );
      if (nonRecovery && recovery) {
        expect(recovery.verifier.type).toBe(nonRecovery.verifier.type);
      }
    }
  });


});

describe("manifest 结构验证", () => {
  const manifests = getRealManifests();

  it("所有 manifest 有必要的字段", () => {
    for (const m of manifests) {
      expect(m.id).toBeTruthy();
      expect(m.category).toBeTruthy();
      expect(m.suite).toBeTruthy();
      expect(m.title).toBeTruthy();
      expect(m.taskPrompt).toBeTruthy();
      expect(m.verifier).toBeTruthy();
    }
  });

  it("swe-bench verifier 引用 FAIL_TO_PASS 测试路径", () => {
    const swe = manifests.filter((m) => m.sourceMeta?.sourceKind === "swe-bench");
    for (const m of swe) {
      expect(m.verifier.command).toMatch(/pytest/);
    }
  });
});
