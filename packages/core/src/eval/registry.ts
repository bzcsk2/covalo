import type { EvalCategory, EvalCategoryId, EvalSuite, EvalSuiteId, EvalCaseRef } from "./types";
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

const coreSuite: EvalSuite = {
  id: "smoke",
  title: "Core Test Set",
  description: "当前固定基础测试集，覆盖该评测大项的核心能力验证",
  estimatedMinutes: "10-15",
  cases: [],
};

const NATIVE_CATEGORIES: EvalCategory[] = [
  {
    id: "coding-basics",
    title: "Coding Basics",
    description: "基础编码能力评测：类型修复、bug 修复、测试修复",
    suites: [
      {
        ...coreSuite,
        cases: smokeCases["coding-basics"],
      },
    ],
  },
  {
    id: "tool-use",
    title: "Tool Use",
    description: "工具使用能力评测：搜索、编辑、命令执行",
    suites: [
      {
        ...coreSuite,
        cases: smokeCases["tool-use"],
      },
    ],
  },
  {
    id: "safety",
    title: "Safety",
    description: "安全与约束评测：越权防护、deny 命令处理、只读约束",
    suites: [
      {
        ...coreSuite,
        cases: smokeCases["safety"],
      },
    ],
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
    suites: [],
  },
];

function mergeCategories(): EvalCategory[] {
  const realCats = getRealCategories();
  const realMap = new Map(realCats.map((c) => [c.id, c]));

  return NATIVE_CATEGORIES.map((nativeCat) => {
    const realCat = realMap.get(nativeCat.id);
    if (!realCat) return nativeCat;

    return {
      ...nativeCat,
      suites: [...nativeCat.suites, ...realCat.suites],
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
): EvalSuite | undefined {
  const category = CATEGORY_MAP.get(categoryId);
  if (!category) return undefined;
  return category.suites.find((s) => s.id === suiteId);
}

export function getCaseRef(
  categoryId: EvalCategoryId,
  suiteId: EvalSuiteId,
  caseId: string,
): EvalCaseRef | undefined {
  const suite = getSuite(categoryId, suiteId);
  if (!suite) return undefined;
  return suite.cases.find((c) => c.id === caseId);
}

export function listCaseRefs(
  categoryId: EvalCategoryId,
  suiteId: EvalSuiteId,
): EvalCaseRef[] {
  const suite = getSuite(categoryId, suiteId);
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

export function getCaseCount(
  categoryId?: EvalCategoryId,
  suiteId?: EvalSuiteId,
): number {
  if (categoryId && suiteId) {
    return listCaseRefs(categoryId, suiteId).length;
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
