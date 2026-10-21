import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  AddressingEvaluationCaseSchema,
  summarizeAddressingEvaluation,
  type AddressingEvaluationCase,
  type AddressingEvaluationResult,
} from "../../src/addressing-evaluation";
import {
  classifyMessageAdmission,
  classifyAddressingWithModel,
  classifyAddressingWithTypeSafe,
  ADDRESSING_FALLBACK_MODEL,
  ADDRESSING_FALLBACK_PROVIDER,
  ADDRESSING_FALLBACK_TIMEOUT_MS,
  TYPESAFE_ADDRESSING_CONFIDENCE_THRESHOLD,
  TYPESAFE_ADDRESSING_MODEL,
  TYPESAFE_ADDRESSING_TIMEOUT_MS,
  type StructuredModelDiagnostic,
} from "../../src/index";
import {
  MESSAGE_CONTINUATION_CONFIDENCE_THRESHOLD,
  MESSAGE_CONTINUATION_TIMEOUT_MS,
  MESSAGE_CONTINUATION_FALLBACK_MODEL,
  MESSAGE_CONTINUATION_FALLBACK_PROVIDER,
} from "../../src/message-continuation";
import { assertProtectedEvaluationPaths, writePrivateFile } from "./secure-paths";

type EvaluationTarget = "openrouter" | "typesafe" | "cascade";

interface Options {
  dataset: string;
  models: string[];
  output: string;
  concurrency: number;
  target: EvaluationTarget;
  reasoningEffort?: "none" | "low" | "medium" | "high";
}

function options(argv: string[]): Options {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index === -1 ? undefined : argv[index + 1];
  };
  const target = value("--target") ?? "openrouter";
  if (!(["openrouter", "typesafe", "cascade"] as const).includes(target as EvaluationTarget)) {
    throw new Error("--target must be openrouter, typesafe, or cascade");
  }
  const requestedModels = value("--models")?.split(",").map((model) => model.trim()).filter(Boolean) ?? [];
  if (target === "openrouter" && requestedModels.length < 1) {
    throw new Error("Pass at least one model ID with --models");
  }
  if (target === "cascade"
    && (requestedModels.length > 1
      || (requestedModels.length === 1 && requestedModels[0] !== ADDRESSING_FALLBACK_MODEL))) {
    throw new Error(`The cascade target is fixed to ${ADDRESSING_FALLBACK_MODEL}`);
  }
  const dataset = value("--dataset")?.trim();
  if (!dataset) throw new Error("--dataset is required");
  const output = value("--output")?.trim();
  if (!output) throw new Error("--output is required");
  const concurrency = Number(value("--concurrency") ?? "1");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("--concurrency must be a positive integer");
  }
  const reasoningEffort = value("--reasoning-effort");
  if (reasoningEffort !== undefined
    && !["none", "low", "medium", "high"].includes(reasoningEffort)) {
    throw new Error("--reasoning-effort must be none, low, medium, or high");
  }
  if (reasoningEffort !== undefined && target !== "openrouter") {
    throw new Error("--reasoning-effort is only valid for the openrouter target; cascade fallback is fixed to low");
  }
  return {
    dataset: resolve(dataset),
    models: target === "typesafe"
      ? ["typesafe/jev-latest"]
      : target === "cascade"
        ? [ADDRESSING_FALLBACK_MODEL]
        : requestedModels,
    output: resolve(output),
    concurrency,
    target: target as EvaluationTarget,
    ...(reasoningEffort ? {
      reasoningEffort: reasoningEffort as NonNullable<Options["reasoningEffort"]>,
    } : {}),
  };
}

function loadCases(source: string): AddressingEvaluationCase[] {
  return source.split("\n").filter((line) => line.trim().length > 0)
    .map((line) => AddressingEvaluationCaseSchema.parse(JSON.parse(line)));
}

async function evaluateCase(
  keys: { openRouter: string | undefined; typesafe: string | undefined },
  target: EvaluationTarget,
  model: string,
  evaluationCase: AddressingEvaluationCase,
  reasoningEffort?: Options["reasoningEffort"],
): Promise<AddressingEvaluationResult> {
  const startedAt = performance.now();
  const resolvedModels = new Set<string>();
  let openRouterAttempted = false;
  let openRouterTerminalSuccess: boolean | undefined;
  let typesafeConfidence: number | undefined;
  let typesafeFailure = false;
  const onDiagnostic = (event: StructuredModelDiagnostic): void => {
    if (event.model) resolvedModels.add(`${event.provider ?? "openrouter"}:${event.model}`);
    if (event.schemaName === "message_addressing" && (event.provider ?? "openrouter") === "openrouter" && event.stage === "model_request") {
      openRouterAttempted = true;
    }
    if (event.schemaName === "message_addressing" && (event.provider ?? "openrouter") === "openrouter" && event.stage === "complete") {
      openRouterTerminalSuccess = event.success;
    }
    if (event.provider === "typesafe" && event.schemaName === "message_addressing" && event.stage === "complete") {
      typesafeFailure = event.success === false;
      const answers = event.responsePayload?.answers;
      const addressing = typeof answers === "object" && answers !== null
        ? (answers as Record<string, unknown>).addressing
        : undefined;
      const confidence = typeof addressing === "object" && addressing !== null
        ? (addressing as Record<string, unknown>).confidence
        : undefined;
      if (typeof confidence === "number") typesafeConfidence = confidence;
    }
  };
  try {
    const common = {
      message: evaluationCase.input.message,
      activeTask: evaluationCase.input.activeTask,
      connectorMentions: evaluationCase.input.connectorMentions,
      humanMentions: evaluationCase.input.humanMentions,
      addressesRally: evaluationCase.input.addressesRally,
      recentMessages: evaluationCase.input.recentMessages,
      ...(evaluationCase.input.authorName === undefined ? {} : { authorName: evaluationCase.input.authorName }),
    };
    const admission = target === "cascade" ? await classifyMessageAdmission({
      ...common,
      apiKey: keys.openRouter!,
      typesafeApiKey: keys.typesafe!,
      model,
      fallbackModels: [],
      onDiagnostic,
    }) : undefined;
    const actual = target === "typesafe"
      ? await classifyAddressingWithTypeSafe({
          ...common,
          typesafeApiKey: keys.typesafe!,
          onDiagnostic,
        })
      : admission
        ? admission.classification
        : await classifyAddressingWithModel({
            ...common,
            apiKey: keys.openRouter!,
            model,
            fallbackModels: [],
            onDiagnostic,
            ...(reasoningEffort ? { reasoningEffort } : {}),
          });
    const resultModel = target === "cascade" ? `typesafe/jev-latest -> ${model}` : model;
    const continuationSelected = admission?.continuation !== undefined && admission.continuation.decision !== "use_addressing";
    return {
      caseId: evaluationCase.id,
      model: resultModel,
      expected: evaluationCase.expected,
      actual,
      ...(admission?.continuation ? { continuation: admission.continuation } : {}),
      latencyMs: Math.round(performance.now() - startedAt),
      resolvedModels: [...resolvedModels],
      ...(target === "cascade" ? {
        cascadeRoute: continuationSelected ? "not_needed" as const : openRouterAttempted
          ? openRouterTerminalSuccess === false ? "terminal_heuristic" as const : "fallback" as const
          : "typesafe" as const,
        ...(!continuationSelected && openRouterAttempted ? {
          cascadeFallbackReason: typesafeFailure ? "typesafe_failure" as const : "low_confidence" as const,
        } : {}),
        ...(typesafeConfidence !== undefined ? { typesafeConfidence } : {}),
      } : {}),
    };
  } catch (error) {
    return {
      caseId: evaluationCase.id,
      model: target === "cascade" ? `typesafe/jev-latest -> ${model}` : model,
      expected: evaluationCase.expected,
      latencyMs: Math.round(performance.now() - startedAt),
      resolvedModels: [...resolvedModels],
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

async function main(): Promise<void> {
  const selected = options(process.argv.slice(2));
  await assertProtectedEvaluationPaths([selected.dataset], [selected.output]);
  const keys = {
    openRouter: process.env.OPENROUTER_API_KEY?.trim(),
    typesafe: process.env.TYPESAFE_API_KEY?.trim(),
  };
  if (selected.target !== "typesafe" && !keys.openRouter) {
    throw new Error("OPENROUTER_API_KEY is required for openrouter and cascade targets");
  }
  if (selected.target !== "openrouter" && !keys.typesafe) {
    throw new Error("TYPESAFE_API_KEY is required for typesafe and cascade targets");
  }
  const source = await readFile(selected.dataset, "utf8");
  const datasetSha256 = createHash("sha256").update(source).digest("hex");
  const cases = loadCases(source);
  const results: AddressingEvaluationResult[] = [];
  for (const model of selected.models) {
    const modelResults = new Array<AddressingEvaluationResult>(cases.length);
    let nextIndex = 0;
    let completed = 0;
    await Promise.all(Array.from({ length: selected.concurrency }, async () => {
      while (nextIndex < cases.length) {
        const index = nextIndex++;
        const result = await evaluateCase(keys, selected.target, model, cases[index]!, selected.reasoningEffort);
        modelResults[index] = result;
        completed += 1;
        process.stderr.write(`${model} ${completed}/${cases.length} ${result.error ? "error" : "ok"}\n`);
      }
    }));
    results.push(...modelResults);
  }
  const sourceFingerprint = createHash("sha256");
  for (const sourceFile of [
    new URL("../../src/index.ts", import.meta.url),
    new URL("../../src/message-continuation.ts", import.meta.url),
    new URL("../../src/prompts/message-continuation.ts", import.meta.url),
    new URL("../../src/addressing-evaluation.ts", import.meta.url),
    new URL("./run.ts", import.meta.url),
  ]) {
    sourceFingerprint.update(await readFile(sourceFile));
  }
  const report = {
    generatedAt: new Date().toISOString(),
    dataset: selected.dataset,
    datasetSha256,
    caseCount: cases.length,
    target: selected.target,
    reasoningEffort: selected.reasoningEffort ?? null,
    sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    sourceFingerprintSha256: sourceFingerprint.digest("hex"),
    classifierConfig: {
      typesafe: {
        model: TYPESAFE_ADDRESSING_MODEL,
        confidenceThresholdExclusive: TYPESAFE_ADDRESSING_CONFIDENCE_THRESHOLD,
        timeoutMs: TYPESAFE_ADDRESSING_TIMEOUT_MS,
      },
      continuation: {
        model: TYPESAFE_ADDRESSING_MODEL,
        confidenceThresholdExclusive: MESSAGE_CONTINUATION_CONFIDENCE_THRESHOLD,
        timeoutMs: MESSAGE_CONTINUATION_TIMEOUT_MS,
        fallbackModel: MESSAGE_CONTINUATION_FALLBACK_MODEL,
        fallbackProvider: MESSAGE_CONTINUATION_FALLBACK_PROVIDER,
        fallbackReasoningEffort: "low",
        fallbackTimeoutMs: ADDRESSING_FALLBACK_TIMEOUT_MS,
      },
      fallback: {
        model: ADDRESSING_FALLBACK_MODEL,
        provider: ADDRESSING_FALLBACK_PROVIDER,
        reasoningEffort: "low",
        providerFallbacks: false,
        timeoutMs: ADDRESSING_FALLBACK_TIMEOUT_MS,
      },
    },
    models: selected.models.map((model) => {
      const resultModel = selected.target === "cascade" ? `typesafe/jev-latest -> ${model}` : model;
      return summarizeAddressingEvaluation(
        resultModel,
        results.filter((result) => result.model === resultModel),
      );
    }),
    ...(selected.target === "cascade" ? {
      cascadeRouting: {
        notNeeded: results.filter((result) => result.cascadeRoute === "not_needed").length,
        typesafe: results.filter((result) => result.cascadeRoute === "typesafe").length,
        fallback: results.filter((result) => result.cascadeRoute === "fallback").length,
        terminalHeuristic: results.filter((result) => result.cascadeRoute === "terminal_heuristic").length,
        lowConfidenceFallback: results.filter((result) =>
          result.cascadeFallbackReason === "low_confidence").length,
        primaryFailureFallback: results.filter((result) =>
          result.cascadeFallbackReason === "typesafe_failure").length,
      },
    } : {}),
    results,
  };
  await writePrivateFile(selected.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report.models, null, 2)}\n`);
}

await main();
