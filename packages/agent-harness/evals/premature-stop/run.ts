import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { askJev, jevFailureKind } from "../../src/jev";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";
import { aggregate, answers, caseSchema, shouldNudge, type EvalResult } from "./evaluation";
import { comparePolicies } from "./policies";
import { promptVariants, variantNames } from "./prompt-variants";

const [datasetArg, outputArg, model = "jev-1.14.0", timeoutArg = "1000", thresholdArg = "0.5", variantArg = "baseline"] = process.argv.slice(2);
if (!datasetArg || !outputArg) throw new Error("Usage: run.ts <cases.jsonl> <report.json> [model] [timeoutMs] [threshold] [variant]");
const confidenceThreshold = z.coerce.number().min(0).max(1).parse(thresholdArg);
const variant = z.enum(variantNames).parse(variantArg);
const questions = promptVariants[variant];
const timeoutMs = Number(timeoutArg);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive");
if (!process.env.TYPESAFE_API_KEY) throw new Error("TYPESAFE_API_KEY is required for a live eval");
const dataset = resolve(datasetArg);
const output = resolve(outputArg);
await assertProtectedEvaluationPaths([dataset], [output]);
const raw = await readFile(dataset, "utf8");
const cases = raw.split("\n").filter((s) => s.trim()).map((s) => caseSchema.parse(JSON.parse(s)));
if (new Set(cases.map((c) => c.id)).size !== cases.length) throw new Error("Duplicate case IDs");
for (const family of new Set(cases.map((c) => c.family))) {
  if (new Set(cases.filter((c) => c.family === family).map((c) => c.split)).size !== 1) throw new Error("Family leaks across splits");
}
const results: Array<EvalResult & { diagnostics: unknown[]; resolvedModel: string | null }> = [];
const implementationSha256 = Object.fromEntries(await Promise.all(["evaluation.ts", "run.ts", "build.ts", "policies.ts", "prompt-variants.ts", "../../src/completion-verification-question.ts", "../../src/completion-verification.ts"].map(async (file) =>
  [file, createHash("sha256").update(await readFile(new URL(file, import.meta.url))).digest("hex")])));
const startedAt = new Date().toISOString();
for (const example of cases) {
  const diagnostics: unknown[] = [];
  const start = performance.now();
  let answer: EvalResult["answer"] = null;
  let failure: string | null = null;
  let resolvedModel: string | null = null;
  let inputTokens: number | null = null;
  try {
    const result = await askJev({
      apiKey: process.env.TYPESAFE_API_KEY, model, timeoutMs,
      schemaName: "premature_stop_evaluation", state: example.state, questions, answers,
      onDiagnostic: (event) => { diagnostics.push(event); },
    });
    answer = result.answers.stopping;
    resolvedModel = result.model;
    inputTokens = result.usage?.inputTokens ?? null;
  } catch (error) {
    failure = jevFailureKind(error);
  }
  results.push({ ...example, answer, failure, resolvedModel, diagnostics, inputTokens,
    nudge: shouldNudge(example, answer, confidenceThreshold), latencyMs: performance.now() - start,
    requestBytes: Buffer.byteLength(JSON.stringify(example.state)) });
  if (results.length % 20 === 0) console.log(JSON.stringify({ completed: results.length, total: cases.length, unavailable: results.filter((r) => r.failure).length }));
}
const slices = (key: "split" | "org" | "kind" | "lifecycle") => Object.fromEntries(
  [...new Set(results.map((r) => r[key]))].map((value) => [value, aggregate(results.filter((r) => r[key] === value))]));
const summary = {
  startedAt, finishedAt: new Date().toISOString(), model, implementationSha256,
  resolvedModels: [...new Set(results.flatMap((r) => r.resolvedModel ? [r.resolvedModel] : []))],
  timeoutMs, confidenceThreshold, variant, noRetries: true,
  corpusSha256: createHash("sha256").update(raw).digest("hex"),
  questionsSha256: createHash("sha256").update(JSON.stringify(questions)).digest("hex"),
  all: aggregate(results), bySplit: slices("split"), byOrg: slices("org"), byKind: slices("kind"), byLifecycle: slices("lifecycle"),
  preferredPolicy: "uncertainty_fallback", policyComparisons: comparePolicies(results, confidenceThreshold),
  byTag: Object.fromEntries([...new Set(results.flatMap((r) => r.tags))].map((tag) => [tag, aggregate(results.filter((r) => r.tags.includes(tag)))])),
};
await writePrivateFile(output, JSON.stringify({ summary, questions, results }, null, 2));
await writePrivateFile(output.replace(/\.json$/, "") + ".summary.json", JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary.all));
