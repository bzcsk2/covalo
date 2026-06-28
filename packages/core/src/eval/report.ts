import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalRunReport, CaseResult } from "./types";

function getDeepReefRoot(): string {
  return process.env.DEEPRREF_ROOT ?? ".deepreef";
}

function getEvalsDir(): string {
  return join(getDeepReefRoot(), "evals");
}

export async function saveEvalReport(
  report: EvalRunReport,
): Promise<{ reportDir: string; summaryMd: string; summaryJson: string }> {
  const evalDir = join(getEvalsDir(), report.meta.runId);
  await mkdir(evalDir, { recursive: true });

  const summaryJsonPath = join(evalDir, "summary.json");
  const summaryMdPath = join(evalDir, "summary.md");
  const metaPath = join(evalDir, "meta.json");

  const metaJson = JSON.stringify(report.meta, null, 2);
  await writeFile(metaPath, metaJson, "utf-8");

  const summaryJson = JSON.stringify(
    {
      meta: report.meta,
      suiteSummary: {
        suiteId: report.suiteSummary.suiteId,
        categoryId: report.suiteSummary.categoryId,
        totalCases: report.suiteSummary.totalCases,
        passed: report.suiteSummary.passed,
        failed: report.suiteSummary.failed,
        errored: report.suiteSummary.errored,
        skipped: report.suiteSummary.skipped,
        averageScore: report.suiteSummary.averageScore,
      },
      overallScore: report.overallScore,
    },
    null,
    2,
  );
  await writeFile(summaryJsonPath, summaryJson, "utf-8");

  const sandboxMeta = {
    providerId: report.meta.providerId,
    environmentId: report.meta.environmentId,
    officialScore: report.meta.officialScore,
    fallbackReason: report.meta.fallbackReason,
  };

  const envMetaPath = join(evalDir, "sandbox-meta.json");
  await writeFile(envMetaPath, JSON.stringify(sandboxMeta, null, 2), "utf-8");

  const summaryMd = generateMarkdownReport(report);
  await writeFile(summaryMdPath, summaryMd, "utf-8");

  for (const result of report.suiteSummary.results) {
    const caseDir = join(evalDir, "cases", result.caseId);
    await mkdir(caseDir, { recursive: true });

    if (result.verifierResult) {
      await writeFile(
        join(caseDir, "verifier.json"),
        JSON.stringify(result.verifierResult, null, 2),
        "utf-8",
      );
    }
    if (result.score) {
      await writeFile(
        join(caseDir, "score.json"),
        JSON.stringify(result.score, null, 2),
        "utf-8",
      );
    }
    if (result.patchDiff) {
      await writeFile(join(caseDir, "patch.diff"), result.patchDiff, "utf-8");
    }
    if (result.workerOutput) {
      await writeFile(join(caseDir, "worker-output.md"), result.workerOutput, "utf-8");
    }
    if (result.supervisorOutput) {
      await writeFile(
        join(caseDir, "supervisor-output.md"),
        result.supervisorOutput,
        "utf-8",
      );
    }
  }

  return { reportDir: evalDir, summaryMd, summaryJson };
}

function generateMarkdownReport(report: EvalRunReport): string {
  const { meta, suiteSummary, overallScore } = report;
  const lines: string[] = [];

  lines.push(`# LoopRig Eval Report`);
  lines.push(``);
  lines.push(`- **Run ID**: \`${meta.runId}\``);
  lines.push(`- **Category**: ${meta.categoryId}`);
  lines.push(`- **Suite**: ${meta.suiteId}`);
  lines.push(`- **Environment**: ${meta.environmentId}`);
  lines.push(`- **Provider**: ${meta.providerId}`);
  lines.push(`- **Official Score**: ${meta.officialScore}`);
  if (meta.fallbackReason) {
    lines.push(`- **Provider Note**: ${meta.fallbackReason}`);
  }
  lines.push(`- **Model**: ${meta.model}`);
  lines.push(`- **Status**: ${meta.status}`);
  lines.push(`- **Started**: ${meta.startedAt}`);
  lines.push(`- **Finished**: ${meta.finishedAt}`);
  lines.push(``);
  lines.push(`## Summary`);
  lines.push(``);
  lines.push(`| Metric | Value |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Total Cases | ${suiteSummary.totalCases} |`);
  lines.push(`| Passed | ${suiteSummary.passed} |`);
  lines.push(`| Failed | ${suiteSummary.failed} |`);
  lines.push(`| Errored | ${suiteSummary.errored} |`);
  lines.push(`| Skipped | ${suiteSummary.skipped} |`);
  lines.push(`| Average Score | ${suiteSummary.averageScore.toFixed(2)} |`);
  lines.push(`| Overall Score | ${overallScore.toFixed(2)} |`);
  lines.push(``);

  lines.push(`## Case Results`);
  lines.push(``);
  for (const result of suiteSummary.results) {
    lines.push(`### ${result.caseId}: ${result.title}`);
    lines.push(``);
    lines.push(`- **Verdict**: \`${result.verdict}\``);
    lines.push(`- **Final Score**: ${result.score?.finalScore.toFixed(2) ?? "N/A"}`);
    lines.push(`- **Verifier**: ${result.verifierResult?.verdict ?? "N/A"}`);
    if (result.manifest?.sourceMeta) {
      lines.push(`- **Source**: \`${result.manifest.sourceMeta.sourceKind}\` (\`${result.manifest.sourceMeta.sourceId}\`)`);
    }
    lines.push(`- **Duration**: ${result.startedAt} → ${result.finishedAt}`);
    if (result.error) {
      lines.push(`- **Error**: ${result.error}`);
    }
    if (result.verifierResult && result.verifierResult.details.length > 0) {
      lines.push(``);
      lines.push(`#### Verifier Details`);
      lines.push(``);
      for (const detail of result.verifierResult.details) {
        lines.push(`- ${detail}`);
      }
    }
    if (result.score) {
      lines.push(``);
      lines.push(`#### Score Breakdown`);
      lines.push(``);
      lines.push(`| Component | Weight | Score |`);
      lines.push(`| --- | --- | --- |`);
      lines.push(
        `| Verifier | ${result.score.verifierWeight} | ${result.score.verifierScore.toFixed(2)} |`,
      );
      lines.push(
        `| Objective | ${result.score.objectiveWeight} | ${result.score.objectiveScore.toFixed(2)} |`,
      );
      lines.push(
        `| Supervisor | ${result.score.supervisorWeight} | ${result.score.supervisorScore.toFixed(2)} |`,
      );
      lines.push(
        `| **Final** | **1.00** | **${result.score.finalScore.toFixed(2)}** |`,
      );
    }
    lines.push(``);
  }

  return lines.join("\n");
}
