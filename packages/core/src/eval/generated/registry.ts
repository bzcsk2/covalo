import type { EvalCategory, EvalCategoryId, EvalSuite, EvalSuiteId, EvalCaseRef } from "../types";
import { getRealManifests } from "./manifests";
import categoryMap from "../curated/category-map.json";

interface CategoryMapData {
  version: string;
  categories: Record<string, {
    title: string;
    description: string;
    suites: Record<string, {
      title: string;
      description: string;
      estimatedMinutes: string;
    }>;
  }>;
}

const mapData = categoryMap as unknown as CategoryMapData;

export function buildRealCategories(): EvalCategory[] {
  const manifests = getRealManifests();
  const categoryGroups = new Map<EvalCategoryId, Map<EvalSuiteId, EvalCaseRef[]>>();

  for (const m of manifests) {
    if (!categoryGroups.has(m.category)) {
      categoryGroups.set(m.category, new Map());
    }
    const suiteMap = categoryGroups.get(m.category)!;
    if (!suiteMap.has(m.suite)) {
      suiteMap.set(m.suite, []);
    }
    suiteMap.get(m.suite)!.push({
      id: m.id,
      title: m.title,
      difficulty: m.suite,
      manifestId: m.id,
    });
  }

  const categories: EvalCategory[] = [];
  for (const [catId, suiteMap] of categoryGroups) {
    const catConfig = mapData.categories[catId];
    const suites: EvalSuite[] = [];
    for (const [suiteId, cases] of suiteMap) {
      const suiteConfig = catConfig?.suites[suiteId];
      suites.push({
        id: suiteId,
        title: suiteConfig?.title ?? suiteId,
        description: suiteConfig?.description ?? "",
        estimatedMinutes: suiteConfig?.estimatedMinutes ?? "15-30",
        cases,
      });
    }
    categories.push({
      id: catId,
      title: catConfig?.title ?? catId,
      description: catConfig?.description ?? "",
      suites,
    });
  }

  return categories;
}

let _cached: EvalCategory[] | null = null;

export function getRealCategories(): EvalCategory[] {
  if (!_cached) {
    _cached = buildRealCategories();
  }
  return _cached;
}

export function getRealCategory(id: EvalCategoryId): EvalCategory | undefined {
  return getRealCategories().find((c) => c.id === id);
}

export function getRealSuite(
  categoryId: EvalCategoryId,
  suiteId: EvalSuiteId,
): EvalSuite | undefined {
  return getRealCategory(categoryId)?.suites.find((s) => s.id === suiteId);
}

export function listRealCaseRefs(
  categoryId: EvalCategoryId,
  suiteId: EvalSuiteId,
): EvalCaseRef[] {
  return getRealSuite(categoryId, suiteId)?.cases ?? [];
}

export function getRealAvailableCategoryIds(): EvalCategoryId[] {
  return getRealCategories().map((c) => c.id);
}

export function getRealAvailableSuiteIds(): EvalSuiteId[] {
  const ids = new Set<EvalSuiteId>();
  for (const cat of getRealCategories()) {
    for (const s of cat.suites) {
      ids.add(s.id);
    }
  }
  return Array.from(ids);
}
