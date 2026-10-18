import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  OpenRouterClient,
  type StructuredModelDiagnostic,
} from "../../src/index";
import {
  judgeTurnDisposition,
  TURN_DISPOSITION_CONFIDENCE_THRESHOLD,
  TURN_DISPOSITION_JEV_TIMEOUT_MS,
  turnDispositionQuestions,
  type CarriedItemKind,
  type TurnDisposition,
} from "../../src/turn-disposition";
import { renderTurnDispositionMessages, turnDispositionJsonSchema } from "../../src/prompts/turn-disposition";
import {
  summarizeTurnDispositionEvaluation,
  TurnDispositionCaseSchema,
  TurnDispositionExpectedSchema,
  type TurnDispositionCase,
  type TurnDispositionResult,
} from "../../src/turn-disposition-evaluation";
import { assertProtectedEvaluationPaths, writePrivateFile } from "../addressing/secure-paths";

/**
 * Run the turn-disposition decision over a labeled corpus against one target:
 * JEV (`typesafe`), or a generative model over OpenRouter (`openrouter`) given
 * the same state bytes through `renderTurnDispositionMessages`. Cases run
 * sequentially so one target's throttling never shapes another's latency, and
 * every call's end-to-end wall clock is what the report records.
 */
type Target = "typesafe" | "openrouter";

interface Options {
  cases: string;
  labels: string | undefined;
  output: string;
  target: Target;
  models: string[];
  runs: number;
  timeoutMs: number;
  reasoningEffort: "none" | "low" | "medium" | "high" | undefined;
  limit: number | undefined;
}

function options(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const target = value("--target") ?? "typesafe";
  if (target !== "typesafe" && target !== "openrouter") throw new Error("--target must be typesafe or openrouter");
  const models = value("--models")?.split(",").map((model) => model.trim()).filter(Boolean) ?? [];
  if (target === "openrouter" && models.length === 0) throw new Error("Pass at least one model ID with --models");
  const cases = value("--cases");
  const output = value("--output");
  if (!cases || !output) throw new Error("--cases and --output are required");
  const runs = Number(value("--runs") ?? "1");
  if (!Number.isInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const timeoutMs = Number(value("--timeout-ms") ?? "15000");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  const reasoningEffort = value("--reasoning-effort");
  if (reasoningEffort !== undefined && !["none", "low", "medium", "high"].includes(reasoningEffort)) {
    throw new Error("--reasoning-effort must be none, low, medium, or high");
  }
  const limit = value("--limit");
  return {
    cases: resolve(cases),
    labels: value("--labels") ? resolve(value("--labels")!) : undefined,
    output: resolve(output),
    target,
    models: target === "typesafe" ? ["typesafe/jev-latest"] : models,
    runs,
    timeoutMs,
    reasoningEffort: reasoningEffort as Options["reasoningEffort"],
    limit: limit ? Number(limit) : undefined,
  };
}

async function evaluateCase(
  keys: { openRouter: string | undefined; typesafe: string | undefined },
  selected: Options,
  model: string,
  run: number,
  evaluationCase: TurnDispositionCase,
): Promise<TurnDispositionResult> {
  const startedAt = performance.now();
  let resolvedModel: string | undefined;
  const onDiagnostic = (event: StructuredModelDiagnostic): void => {
    if (event.stage === "complete" && event.model) resolvedModel = event.model;
  };
  const base = { caseId: evaluationCase.id, target: selected.target, model, run, expected: evaluationCase.expected };
  try {
    if (selected.target === "typesafe") {
      const decision = await judgeTurnDisposition({
        typesafeApiKey: keys.typesafe!,
        state: evaluationCase.state,
        timeoutMs: selected.timeoutMs,
        onDiagnostic,
      });
      const latencyMs = Math.round(performance.now() - startedAt);
      if (decision.disposition === null || decision.confidence === null) {
        return { ...base, latencyMs, error: decision.failureKind ?? decision.code, ...(resolvedModel ? { resolvedModel } : {}) };
      }
      return {
        ...base,
        latencyMs,
        actual: {
          disposition: decision.disposition,
          confidence: decision.confidence,
          kind: decision.kind,
          kindConfidence: decision.kindConfidence,
        },
        ...(decision.model ? { resolvedModel: decision.model } : {}),
      };
    }
    const client = new OpenRouterClient({ apiKey: keys.openRouter!, primaryModel: model, fallbackModels: [] });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
    try {
      const parsed = await client.structured({
        messages: renderTurnDispositionMessages(evaluationCase.state),
        schemaName: "turn_disposition",
        jsonSchema: turnDispositionJsonSchema,
        parse: (value) => {
          const record = value as { disposition: TurnDisposition; kind: CarriedItemKind; confidence: number };
          if (!record || typeof record !== "object") throw new Error("turn_disposition_response_invalid");
          return record;
        },
        ...(selected.reasoningEffort ? { reasoningEffort: selected.reasoningEffort } : {}),
        signal: controller.signal,
        onDiagnostic,
      });
      return {
        ...base,
        latencyMs: Math.round(performance.now() - startedAt),
        actual: { disposition: parsed.disposition, confidence: parsed.confidence, kind: parsed.kind, kindConfidence: null },
        ...(resolvedModel ? { resolvedModel } : {}),
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return {
      ...base,
      latencyMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? `${error.name}: ${error.message.slice(0, 120)}` : String(error).slice(0, 120),
      ...(resolvedModel ? { resolvedModel } : {}),
    };
  }
}

async function main(): Promise<void> {
  const selected = options(process.argv.slice(2));
  await assertProtectedEvaluationPaths([selected.cases, ...(selected.labels ? [selected.labels] : [])], [selected.output]);
  const keys = {
    openRouter: process.env.OPENROUTER_API_KEY?.trim(),
    typesafe: process.env.TYPESAFE_API_KEY?.trim(),
  };
  if (selected.target === "openrouter" && !keys.openRouter) throw new Error("OPENROUTER_API_KEY is required");
  if (selected.target === "typesafe" && !keys.typesafe) throw new Error("TYPESAFE_API_KEY is required");

  const source = await readFile(selected.cases, "utf8");
  const casesSha256 = createHash("sha256").update(source).digest("hex");
  let cases = source.split("\n").filter((line) => line.trim().length > 0)
    .map((line) => TurnDispositionCaseSchema.parse(JSON.parse(line)));
  let labelsSha256: string | null = null;
  if (selected.labels) {
    const labelSource = await readFile(selected.labels, "utf8");
    labelsSha256 = createHash("sha256").update(labelSource).digest("hex");
    const labels = new Map(labelSource.split("\n").filter((line) => line.trim().length > 0).map((line) => {
      const parsed = JSON.parse(line) as { id: string } & Record<string, unknown>;
      return [parsed.id, TurnDispositionExpectedSchema.parse({ disposition: parsed.disposition, kind: parsed.kind ?? null, ...(parsed.note ? { note: parsed.note } : {}) })];
    }));
    cases = cases.map((evaluationCase) => ({ ...evaluationCase, expected: labels.get(evaluationCase.id) ?? evaluationCase.expected }));
  }
  if (selected.limit !== undefined) cases = cases.slice(0, selected.limit);

  const results: TurnDispositionResult[] = [];
  for (const model of selected.models) {
    for (let run = 1; run <= selected.runs; run += 1) {
      let completed = 0;
      for (const evaluationCase of cases) {
        const result = await evaluateCase(keys, selected, model, run, evaluationCase);
        results.push(result);
        completed += 1;
        if (completed % 25 === 0 || completed === cases.length) {
          process.stderr.write(`${model} run ${run}: ${completed}/${cases.length}\n`);
        }
      }
    }
  }

  const sourceFingerprint = createHash("sha256");
  for (const sourceFile of [
    new URL("../../src/turn-disposition.ts", import.meta.url),
    new URL("../../src/prompts/turn-disposition.ts", import.meta.url),
    new URL("../../src/turn-disposition-evaluation.ts", import.meta.url),
    new URL("./run.ts", import.meta.url),
  ]) {
    sourceFingerprint.update(await readFile(sourceFile));
  }
  const summaries = selected.models.map((model) => {
    const modelResults = results.filter((result) => result.model === model);
    const summary = summarizeTurnDispositionEvaluation(selected.target, model, modelResults, cases);
    const perRun = Array.from({ length: selected.runs }, (_, index) =>
      summarizeTurnDispositionEvaluation(selected.target, model, modelResults.filter((result) => result.run === index + 1), cases));
    const agreement = selected.runs > 1
      ? (() => {
          let agreeing = 0;
          for (const evaluationCase of cases) {
            const answers = modelResults.filter((result) => result.caseId === evaluationCase.id && result.actual).map((result) => result.actual!.disposition);
            if (answers.length === selected.runs && answers.every((answer) => answer === answers[0])) agreeing += 1;
          }
          return { cases: cases.length, agreeing, rate: cases.length ? agreeing / cases.length : 0 };
        })()
      : null;
    return { ...summary, perRun: perRun.map((item) => ({ accuracy: item.accuracy, latencyP50: item.latencyMs.p50, errors: item.errors })), runAgreement: agreement };
  });
  const report = {
    generatedAt: new Date().toISOString(),
    cases: selected.cases,
    casesSha256,
    labels: selected.labels ?? null,
    labelsSha256,
    caseCount: cases.length,
    labeledCount: cases.filter((evaluationCase) => evaluationCase.expected !== null).length,
    target: selected.target,
    runs: selected.runs,
    timeoutMs: selected.timeoutMs,
    reasoningEffort: selected.reasoningEffort ?? null,
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceFingerprintSha256: sourceFingerprint.digest("hex"),
    classifierConfig: {
      typesafe: { confidenceThresholdExclusive: TURN_DISPOSITION_CONFIDENCE_THRESHOLD, productionTimeoutMs: TURN_DISPOSITION_JEV_TIMEOUT_MS },
      questions: turnDispositionQuestions,
    },
    summaries,
    results,
  };
  await writePrivateFile(selected.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(summaries, null, 2)}\n`);
}

await main();
