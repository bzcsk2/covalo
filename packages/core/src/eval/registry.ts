import type { EvalCategory, EvalCategoryId, EvalSuite, EvalSuiteId, EvalCaseRef, EvalEnvironmentId } from "./types";
import { getRealCategories } from "./generated/registry";

const smokeCases: Record<string, EvalCaseRef[]> = {
  "coding-basics": [
    {
      id: "cb-fix-ts-type",
      title: "TypeScript 类型错误修复",
      difficulty: "smoke",
      manifestId: "cb-fix-ts-type",
    },
    {
      id: "cb-fix-json-cli",
      title: "JSON/CLI 解析 bug 修复",
      difficulty: "smoke",
      manifestId: "cb-fix-json-cli",
    },
    {
      id: "cb-fix-test-fail",
      title: "小范围测试失败修复",
      difficulty: "smoke",
      manifestId: "cb-fix-test-fail",
    },
  ],
  "tool-use": [
    {
      id: "tu-search-before-edit",
      title: "必须先搜索再编辑",
      difficulty: "smoke",
      manifestId: "tu-search-before-edit",
    },
    {
      id: "tu-run-verify",
      title: "必须运行验证命令",
      difficulty: "smoke",
      manifestId: "tu-run-verify",
    },
    {
      id: "tu-retry-on-fail",
      title: "命令失败后重试并修正",
      difficulty: "smoke",
      manifestId: "tu-retry-on-fail",
    },
  ],
  "weak-model": [
    {
      id: "wm-hello",
      title: "简单 Python 测试验证",
      difficulty: "smoke",
      manifestId: "wm-hello",
    },
  ],
  safety: [
    {
      id: "sa-no-escape-fixture",
      title: "禁止越权修改 fixture 之外文件",
      difficulty: "smoke",
      manifestId: "sa-no-escape-fixture",
    },
    {
      id: "sa-deny-command",
      title: "遇到 deny 命令必须放弃并说明",
      difficulty: "smoke",
      manifestId: "sa-deny-command",
    },
    {
      id: "sa-readonly-no-diff",
      title: "只读 case 中不得产生写 diff",
      difficulty: "smoke",
      manifestId: "sa-readonly-no-diff",
    },
  ],
};

const benchmarkSuite: EvalSuite = {
  id: "smoke",
  title: "Official Sandbox Smoke Tests",
  description: "在当前环境的隔离沙箱中运行的基础官方测试集（synthetic fixtures）",
  estimatedMinutes: "10-15",
  environmentId: "sandbox.benchmark",
  cases: [],
};

const localSuite: EvalSuite = {
  id: "smoke",
  title: "Diagnostic Sandbox Smoke Tests",
  description: "在本地环境运行的镜像测试集。使用本地工具链，结果不计入官方评分。",
  estimatedMinutes: "10-15",
  environmentId: "sandbox.local",
  cases: [],
};

function nativeSuites(cases: typeof smokeCases[string]): EvalSuite[] {
  return [
    { ...benchmarkSuite, cases },
    { ...localSuite, cases },
  ];
}

const NATIVE_CATEGORIES: EvalCategory[] = [
  {
    id: "coding-basics",
    title: "Coding Basics",
    description: "基础编码能力评测：类型修复、bug 修复、测试修复",
    suites: nativeSuites(smokeCases["coding-basics"]),
  },
  {
    id: "tool-use",
    title: "Tool Use",
    description: "工具使用能力评测：搜索、编辑、命令执行",
    suites: nativeSuites(smokeCases["tool-use"]),
  },
  {
    id: "safety",
    title: "Safety",
    description: "安全与约束评测：越权防护、deny 命令处理、只读约束",
    suites: nativeSuites(smokeCases["safety"]),
  },
  {
    id: "supervisor-recovery",
    title: "Supervisor Recovery",
    description: "监督恢复能力评测：初始失败后基于 supervisor 反馈恢复",
    suites: [],
  },
  {
    id: "long-run",
    title: "Long Run",
    description: "长链任务评测：多步骤、多阶段、多文件修改的综合任务",
    suites: [],
  },
  {
    id: "weak-model",
    title: "Weak Model",
    description: "弱模型评测：适合轻量模型的短链小型修复任务",
    suites: nativeSuites(smokeCases["weak-model"] || []),
  },
];

function mergeCategories(): EvalCategory[] {
  const realCats = getRealCategories();
  const realMap = new Map(realCats.map((c) => [c.id, c]));

  return NATIVE_CATEGORIES.map((nativeCat) => {
    const realCat = realMap.get(nativeCat.id);
    if (!realCat) return nativeCat;

    const realSuites = realCat.suites.map(s => {
      return {
        ...s,
        title: `${s.title} (Sandbox.Local — Diagnostic)`,
        description: `${s.description} 此套件在 sandbox.local 环境中运行，使用本地工具链。结果不计入官方评分。`,
      };
    });

    return {
      ...nativeCat,
      suites: [...nativeCat.suites, ...realSuites],
      title: realCat.title,
      description: realCat.description,
    };
  });
}

function buildCategoryMap(): Map<EvalCategoryId, EvalCategory> {
  const cats = mergeCategories();
  return new Map(cats.map((c) => [c.id, c]));
}

let CATEGORIES = mergeCategories();
let CATEGORY_MAP = buildCategoryMap();

export function refreshRegistry(): void {
  CATEGORIES = mergeCategories();
  CATEGORY_MAP = buildCategoryMap();
}

export function getCategories(): EvalCategory[] {
  return CATEGORIES;
}

export function getCategory(id: EvalCategoryId): EvalCategory | undefined {
  return CATEGORY_MAP.get(id);
}

export function getSuite(
  categoryId: EvalCategoryId,
  suiteId: EvalSuiteId,
  environmentId: EvalEnvironmentId,
): EvalSuite | undefined {
  const category = CATEGORY_MAP.get(categoryId);
  if (!category) return undefined;
  return category.suites.find((s) => {
    if (s.id !== suiteId) return false;
    return s.environmentId === environmentId;
  });
}

export function getCaseRef(
  categoryId: EvalCategoryId,
  suiteId: EvalSuiteId,
  environmentId: EvalEnvironmentId,
  caseId: string,
): EvalCaseRef | undefined {
  const suite = getSuite(categoryId, suiteId, environmentId);
  if (!suite) return undefined;
  return suite.cases.find((c) => c.id === caseId);
}

export function listCaseRefs(
  categoryId: EvalCategoryId,
  suiteId: EvalSuiteId,
  environmentId: EvalEnvironmentId,
): EvalCaseRef[] {
  const suite = getSuite(categoryId, suiteId, environmentId);
  if (!suite) return [];
  return suite.cases;
}

export function getAvailableCategoryIds(): EvalCategoryId[] {
  const ids = new Set<EvalCategoryId>();
  for (const cat of CATEGORIES) {
    ids.add(cat.id);
  }
  return Array.from(ids);
}

export function getAvailableSuiteIds(): EvalSuiteId[] {
  const ids = new Set<EvalSuiteId>();
  for (const cat of CATEGORIES) {
    for (const s of cat.suites) {
      ids.add(s.id);
    }
  }
  return Array.from(ids);
}

export function getFilteredSuites(
  categoryId: EvalCategoryId,
  environmentId?: EvalEnvironmentId,
): EvalSuite[] {
  const category = getCategory(categoryId);
  if (!category) return [];
  if (!environmentId) return category.suites;
  return category.suites.filter(s => s.environmentId === environmentId);
}

export function getCaseCount(
  categoryId?: EvalCategoryId,
  suiteId?: EvalSuiteId,
  environmentId?: EvalEnvironmentId,
): number {
  if (categoryId && suiteId && environmentId) {
    return listCaseRefs(categoryId, suiteId, environmentId).length;
  }
  if (categoryId && suiteId && !environmentId) {
    return getCategory(categoryId)?.suites
      .filter(s => s.id === suiteId)
      .reduce((sum, s) => sum + s.cases.length, 0) ?? 0;
  }
  if (categoryId) {
    const cat = getCategory(categoryId);
    if (!cat) return 0;
    return cat.suites.reduce((sum, s) => sum + s.cases.length, 0);
  }
  return CATEGORIES.reduce(
    (sum, cat) => sum + cat.suites.reduce((s2, s) => s2 + s.cases.length, 0),
    0,
  );
}
