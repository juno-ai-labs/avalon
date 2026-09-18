import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { AddressingClassification } from "@rally/contracts";
import {
  AddressingEvaluationCaseSchema,
  summarizeAddressingEvaluation,
  type AddressingEvaluationCase,
} from "../../src/addressing-evaluation";
import { classifyAddressingWithModel, renderAddressingMessages } from "../../src/index";
import { assertProtectedEvaluationPaths, writePrivateFile } from "./secure-paths";

interface Options {
  dataset: string;
  model: string;
  providers: string[];
  sampleSize: number;
  concurrency: number;
  output: string;
  reasoningEffort?: "none" | "low" | "medium" | "high";
}

interface ProviderBenchmarkResult {
  provider: string;
  caseId: string;
  inputBytes: number;
  latencyMs: number;
  expected: AddressingClassification | null;
  actual?: AddressingClassification;
  error?: string;
}

function options(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const providers = value("--providers")?.split(",").map((provider) => provider.trim()).filter(Boolean) ?? [];
  if (providers.length === 0) throw new Error("Pass comma-separated OpenRouter provider slugs with --providers");
  const sampleSize = Number(value("--sample-size"));
  if (!Number.isInteger(sampleSize) || sampleSize < 4) {
    throw new Error("--sample-size must be an integer of at least 4 so p75 is meaningful");
  }
  const concurrency = Number(value("--concurrency") ?? "1");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  const model = value("--model")?.trim();
  if (!model) throw new Error("--model is required");
  const dataset = value("--dataset")?.trim();
  if (!dataset) throw new Error("--dataset is required");
  const output = value("--output")?.trim();
  if (!output) throw new Error("--output is required");
  const reasoningEffort = value("--reasoning-effort");
  if (reasoningEffort !== undefined
    && !["none", "low", "medium", "high"].includes(reasoningEffort)) {
    throw new Error("--reasoning-effort must be none, low, medium, or high");
  }
  return {
    dataset: resolve(dataset),
    model,
    providers,
    sampleSize,
    concurrency,
    output: resolve(output),
    ...(reasoningEffort ? {
      reasoningEffort: reasoningEffort as NonNullable<Options["reasoningEffort"]>,
    } : {}),
  };
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted[0]!;
}

function transmittedInputBytes(evaluationCase: AddressingEvaluationCase): number {
  const rendered = renderAddressingMessages(evaluationCase.input);
  return new TextEncoder().encode(JSON.stringify(rendered)).byteLength;
}

function stratifiedByInputSize(cases: AddressingEvaluationCase[], sampleSize: number): AddressingEvaluationCase[] {
  if (sampleSize > cases.length) throw new Error(`--sample-size ${sampleSize} exceeds ${cases.length} cases`);
  const sorted = [...cases].sort((left, right) =>
    transmittedInputBytes(left) - transmittedInputBytes(right));
  if (sampleSize === 1) return [sorted[0]!];
  return Array.from({ length: sampleSize }, (_, index) =>
    sorted[Math.round(index * (sorted.length - 1) / (sampleSize - 1))]!);
}

async function main(): Promise<void> {
  const selected = options(process.argv.slice(2));
  await assertProtectedEvaluationPaths([selected.dataset], [selected.output]);
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required");
  const source = await readFile(selected.dataset, "utf8");
  const cases = source.split("\n").filter((line) => line.trim().length > 0)
    .map((line) => AddressingEvaluationCaseSchema.parse(JSON.parse(line)));
  const sample = stratifiedByInputSize(cases, selected.sampleSize);
  // Rotate which provider runs first for each case. At concurrency 1 this
  // counterbalances temporal backend/load drift instead of running providers
  // in large, order-confounded blocks.
  const jobs = sample.flatMap((evaluationCase, caseIndex) =>
    selected.providers.map((_, offset) => ({
      provider: selected.providers[(caseIndex + offset) % selected.providers.length]!,
      evaluationCase,
    })));
  const results: ProviderBenchmarkResult[] = [];
  let nextIndex = 0;
  await Promise.all(Array.from({ length: selected.concurrency }, async () => {
    while (nextIndex < jobs.length) {
      const job = jobs[nextIndex++]!;
      const startedAt = performance.now();
      try {
        const actual = await classifyAddressingWithModel({
          apiKey,
          model: selected.model,
          fallbackModels: [],
          ...job.evaluationCase.input,
          ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
          provider: {
            only: [job.provider],
            allowFallbacks: false,
            requireParameters: true,
          },
        });
        results.push({
          provider: job.provider,
          caseId: job.evaluationCase.id,
          inputBytes: transmittedInputBytes(job.evaluationCase),
          latencyMs: Math.round(performance.now() - startedAt),
          expected: job.evaluationCase.expected,
          actual,
        });
      } catch (error) {
        results.push({
          provider: job.provider,
          caseId: job.evaluationCase.id,
          inputBytes: transmittedInputBytes(job.evaluationCase),
          latencyMs: Math.round(performance.now() - startedAt),
          expected: job.evaluationCase.expected,
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
      }
    }
  }));
  const summaries = selected.providers.map((provider) => {
    const providerResults = results.filter((result) => result.provider === provider);
    const completed = providerResults.filter((result) => result.actual !== undefined);
    return {
      provider,
      ...summarizeAddressingEvaluation(selected.model, providerResults.map((result) => ({
        caseId: result.caseId,
        model: selected.model,
        expected: result.expected,
        ...(result.actual ? { actual: result.actual } : {}),
        latencyMs: result.latencyMs,
        ...(result.error ? { error: result.error } : {}),
      }))),
      latencyP75Ms: percentile(completed.map((result) => result.latencyMs), 0.75),
      errorMessages: [...new Set(providerResults.flatMap((result) => result.error ? [result.error] : []))],
    };
  }).sort((left, right) => left.errors - right.errors || left.latencyP75Ms - right.latencyP75Ms);
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: selected.dataset,
    datasetSha256: createHash("sha256").update(source).digest("hex"),
    model: selected.model,
    reasoningEffort: selected.reasoningEffort ?? null,
    sampleCaseIds: sample.map((evaluationCase) => evaluationCase.id),
    summaries,
    results,
  };
  await writePrivateFile(selected.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
}

await main();
