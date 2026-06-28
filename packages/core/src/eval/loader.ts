import { z } from "zod";
import type { EvalCaseManifest, EvalCategoryId, EvalSuiteId } from "./types";

const FileAssertionSchema = z.object({
  path: z.string(),
  mustExist: z.boolean().optional(),
  mustContain: z.array(z.string()).optional(),
  mustNotContain: z.array(z.string()).optional(),
});

const VerifierSchema = z.object({
  type: z.enum(["command", "script", "file-assert"]),
  command: z.string().optional(),
  scriptPath: z.string().optional(),
  fileAssertions: z.array(FileAssertionSchema).optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const ScoringSchema = z.object({
  requireCleanGitDiff: z.boolean().optional(),
  maxChangedFiles: z.number().int().min(0).optional(),
});

const EvalCaseManifestSchema = z.object({
  id: z.string().min(1),
  category: z.enum([
    "coding-basics",
    "tool-use",
    "safety",
    "supervisor-recovery",
    "long-run",
    "weak-model",
  ]),
  suite: z.enum(["smoke", "standard", "stress"]),
  title: z.string().min(1),
  description: z.string().min(1),
  fixtureSource: z.string(),
  sourceMeta: z.object({
    sourceKind: z.enum(["terminal-bench", "swe-bench", "looprig-real"]),
    sourceId: z.string(),
    sourceRepoPath: z.string(),
    sourceCommit: z.string().optional(),
    sourceDataset: z.string().optional(),
    sourceSplit: z.string().optional(),
    sourceTaskPath: z.string().optional(),
    sourceInstanceId: z.string().optional(),
  }).optional(),
  setup: z.array(z.string()).optional(),
  taskPrompt: z.string().min(1),
  expectedVerification: z.array(z.string()).min(1),
  verifier: VerifierSchema,
  scoring: ScoringSchema.optional(),
}).passthrough();

export type ParsedManifest = z.infer<typeof EvalCaseManifestSchema>;

export function validateManifest(data: unknown): {
  success: boolean;
  data?: EvalCaseManifest;
  error?: string;
} {
  const result = EvalCaseManifestSchema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data as EvalCaseManifest };
  }
  const error = result.error.issues
    .map((i) => `${i.path.join(".")}: ${i.message}`)
    .join("; ");
  return { success: false, error };
}

const builtinManifests = new Map<string, EvalCaseManifest>();

export function registerBuiltinManifest(manifest: EvalCaseManifest): void {
  const validation = validateManifest(manifest);
  if (!validation.success) {
    throw new Error(
      `Invalid manifest "${manifest.id}": ${validation.error}`,
    );
  }
  builtinManifests.set(manifest.id, manifest);
}

export function registerBuiltinManifests(
  manifests: EvalCaseManifest[],
): void {
  for (const m of manifests) {
    registerBuiltinManifest(m);
  }
}

export function getManifest(id: string): EvalCaseManifest | undefined {
  return builtinManifests.get(id);
}

export function listAllManifests(): EvalCaseManifest[] {
  return Array.from(builtinManifests.values());
}

export function getManifestsByCategory(
  category: EvalCategoryId,
): EvalCaseManifest[] {
  return listAllManifests().filter((m) => m.category === category);
}

export function getManifestsBySuite(
  category: EvalCategoryId,
  suite: EvalSuiteId,
): EvalCaseManifest[] {
  return listAllManifests().filter(
    (m) => m.category === category && m.suite === suite,
  );
}

export function clearManifests(): void {
  builtinManifests.clear();
}
