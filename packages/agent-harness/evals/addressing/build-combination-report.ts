import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { AddressingClassificationSchema } from "@rally/contracts";
import { z } from "zod";
import {
  summarizeAddressingEvaluation,
  type AddressingEvaluationResult,
} from "../../src/addressing-evaluation";
import { assertProtectedEvaluationPaths, writePrivateFile } from "./secure-paths";

const EvaluationResultSchema = z.object({
  caseId: z.string().min(1),
  model: z.string().min(1),
  expected: AddressingClassificationSchema.nullable(),
  actual: AddressingClassificationSchema.optional(),
  latencyMs: z.number().nonnegative(),
  error: z.string().optional(),
  resolvedModels: z.array(z.string()).optional(),
  cascadeRoute: z.enum(["not_needed", "typesafe", "fallback", "terminal_heuristic"]).optional(),
  cascadeFallbackReason: z.enum(["low_confidence", "typesafe_failure"]).optional(),
  typesafeConfidence: z.number().min(0).max(1).optional(),
});

const EvaluationReportSchema = z.object({
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  models: z.array(z.object({ model: z.string().min(1) }).passthrough()),
  results: z.array(EvaluationResultSchema),
});

const JudgeReportSchema = z.object({
  datasetSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceReportSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  judgments: z.array(z.object({
    caseId: z.string().min(1),
    production: AddressingClassificationSchema.nullable(),
    sol: AddressingClassificationSchema.optional(),
    error: z.string().optional(),
  })),
});

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value) throw new Error(`${name} is required`);
  return resolve(value);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted[0]!;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function seconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(3)}s`;
}

function duration(milliseconds: number): string {
  const secondsTotal = milliseconds / 1_000;
  const minutes = Math.floor(secondsTotal / 60);
  return `${minutes}m${(secondsTotal - minutes * 60).toFixed(1).padStart(4, "0")}s`;
}

function displayModel(model: string): string {
  return model.replaceAll(" | ", " · ");
}

async function main(): Promise<void> {
  const reportPath = argument("--report");
  const judgePath = argument("--judge");
  const outputPath = argument("--output");
  await assertProtectedEvaluationPaths([reportPath, judgePath], [outputPath]);
  const reportSource = await readFile(reportPath, "utf8");
  const judgeSource = await readFile(judgePath, "utf8");
  const report = EvaluationReportSchema.parse(JSON.parse(reportSource));
  const judge = JudgeReportSchema.parse(JSON.parse(judgeSource));
  if (judge.datasetSha256 !== report.datasetSha256) {
    throw new Error("The report and judge output use different dataset SHA-256 values");
  }
  const reportSha256 = createHash("sha256").update(reportSource).digest("hex");
  if (judge.sourceReportSha256 !== reportSha256) {
    throw new Error("The judge output does not belong to this exact evaluation report");
  }
  const solByCase = new Map(judge.judgments.flatMap((judgment) =>
    judgment.sol ? [[judgment.caseId, judgment.sol.classification] as const] : []));
  const judgedCaseIds = new Set(judge.judgments.map((judgment) => judgment.caseId));
  const combinations = report.models.map(({ model }) => {
    const results = report.results.filter((result) => result.model === model) as AddressingEvaluationResult[];
    const summary = summarizeAddressingEvaluation(model, results);
    const completed = results.filter((result) => result.actual !== undefined);
    const latencies = completed.map((result) => result.latencyMs);
    const overlayReferences = completed.flatMap((result) => {
      const reference = solByCase.get(result.caseId)
        ?? (judgedCaseIds.has(result.caseId) ? undefined : result.expected?.classification);
      return reference === undefined ? [] : [{ result, reference }];
    });
    const overlayCorrect = overlayReferences.filter(({ result, reference }) =>
      result.actual?.classification === reference).length;
    const hardResults = completed.filter((result) => solByCase.has(result.caseId));
    const hardCorrect = hardResults.filter((result) =>
      result.actual?.classification === solByCase.get(result.caseId)).length;
    const confusion = Object.fromEntries([...new Set(results.flatMap((result) => {
      if (!result.expected || !result.actual) return [];
      return [`${result.expected.classification}->${result.actual.classification}`];
    }))].sort().map((key) => [key, results.filter((result) =>
      result.expected && result.actual
      && `${result.expected.classification}->${result.actual.classification}` === key).length]));
    return {
      ...summary,
      solOverlay: {
        correct: overlayCorrect,
        total: overlayReferences.length,
        accuracy: overlayReferences.length === 0 ? 0 : overlayCorrect / overlayReferences.length,
        hardCorrect,
        hardTotal: hardResults.length,
        hardAccuracy: hardResults.length === 0 ? 0 : hardCorrect / hardResults.length,
      },
      latencyMs: {
        ...summary.latencyMs,
        p75: percentile(latencies, 0.75),
        mean: latencies.length === 0
          ? 0
          : Math.round(latencies.reduce((total, latency) => total + latency, 0) / latencies.length),
        max: latencies.length === 0 ? 0 : Math.max(...latencies),
        total: latencies.reduce((total, latency) => total + latency, 0),
      },
      confusion,
    };
  });
  const trialCounts = [...new Set(combinations.map((combination) => combination.cases))];
  if (trialCounts.length !== 1) {
    throw new Error(`Every combination must contain the same case count; received ${trialCounts.join(", ")}`);
  }
  const trialsPerCombination = trialCounts[0] ?? 0;
  const judged = judge.judgments.filter((judgment) => judgment.sol !== undefined);
  const metadata = {
    generatedAt: new Date().toISOString(),
    sourceReport: reportPath,
    sourceJudge: judgePath,
    combinationCount: combinations.length,
    datasetSha256: report.datasetSha256,
    sourceReportSha256: reportSha256,
    sourceJudgeSha256: createHash("sha256").update(judgeSource).digest("hex"),
    trialsPerCombination,
    judge: {
      cases: judged.length,
      errors: judge.judgments.length - judged.length,
      supportsProduction: judged.filter((judgment) =>
        judgment.production?.classification === judgment.sol?.classification).length,
      rejectsProduction: judged.filter((judgment) =>
        judgment.production !== null
        && judgment.production.classification !== judgment.sol?.classification).length,
      unlabeled: judged.filter((judgment) => judgment.production === null).length,
    },
  };
  await writePrivateFile(outputPath, `${JSON.stringify({ ...metadata, combinations }, null, 2)}\n`);

  const qualityRows = combinations.map((item) =>
    `| ${displayModel(item.model)} | ${item.completed}/${item.cases} | ${item.errors} | ${percent(item.successRate)} | ${percent(item.endToEndAccuracy)} | ${percent(item.classificationAccuracy)} | ${percent(item.solOverlay.accuracy)} | ${item.solOverlay.hardCorrect}/${item.solOverlay.hardTotal} | ${percent(item.rationaleAgreement)} | ${item.confidenceMeanAbsoluteError.toFixed(4)} | ${item.macroF1.toFixed(4)} |`);
  const latencyRows = combinations.map((item) =>
    `| ${displayModel(item.model)} | ${seconds(item.latencyMs.p50)} | ${seconds(item.latencyMs.p75)} | ${seconds(item.latencyMs.p90)} | ${seconds(item.latencyMs.p99)} | ${seconds(item.latencyMs.mean)} | ${seconds(item.latencyMs.max)} | ${duration(item.latencyMs.total)} |`);
  const classRows = combinations.map((item) => {
    const agent = item.byClassification.agent_action;
    const human = item.byClassification.human_only;
    const both = item.byClassification.both;
    const uncertain = item.byClassification.uncertain;
    const metrics = (value: typeof agent): string =>
      `${value.support} / ${value.precision.toFixed(3)} / ${value.recall.toFixed(3)} / ${value.f1.toFixed(3)}`;
    return `| ${displayModel(item.model)} | ${metrics(agent)} | ${metrics(human)} | ${metrics(both)} | ${metrics(uncertain)} |`;
  });
  const confusionRows = combinations.map((item) => {
    const disagreements = Object.entries(item.confusion)
      .filter(([key]) => key.split("->")[0] !== key.split("->")[1])
      .map(([key, count]) => `${key}: ${count}`).join(", ") || "none";
    return `| ${displayModel(item.model)} | ${disagreements} |`;
  });
  const markdown = [
    "# Addressing classifier model matrix",
    "",
    `Generated from ${combinations.length} full trials of ${trialsPerCombination} cases. Sol medium adjudicated ${metadata.judge.cases} union-disagreement cases; ${metadata.judge.rejectsProduction} captured labels were rejected and ${metadata.judge.unlabeled} case was unlabeled.`,
    "",
    "## Quality",
    "",
    "| Combination | Completed | Errors | Success | End-to-end accuracy | Conditional agreement | Sol overlay | Sol hard set | Rationale agreement | Confidence MAE | Macro F1 |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...qualityRows,
    "",
    "## Latency",
    "",
    "| Combination | p50 | p75 | p90 | p99 | Mean | Max | Summed request latency |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...latencyRows,
    "",
    "## Per-class metrics",
    "",
    "Each cell is support / precision / recall / F1.",
    "",
    "| Combination | Agent action | Human only | Both | Uncertain |",
    "|---|---|---|---|---|",
    ...classRows,
    "",
    "## Raw disagreement confusion",
    "",
    "| Combination | Expected -> actual counts |",
    "|---|---|",
    ...confusionRows,
    "",
  ].join("\n");
  await writePrivateFile(outputPath.replace(/\.json$/u, ".md"), markdown);
}

await main();
