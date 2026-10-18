import { z } from "zod";
import {
  CARRIED_ITEM_KINDS,
  TURN_DISPOSITION_CHOICES,
  TurnDispositionStateSchema,
  type CarriedItemKind,
  type TurnDisposition,
} from "./turn-disposition";

/**
 * One evaluation case: a settled Rally turn with its state, what production
 * did afterwards, and the golden label a person gave it. `expected` is null
 * for a case not yet labeled; the runner still calls the classifier on it and
 * reports it under coverage, not accuracy.
 */
export const TurnDispositionExpectedSchema = z.object({
  disposition: z.enum(TURN_DISPOSITION_CHOICES),
  kind: z.enum(CARRIED_ITEM_KINDS).nullable(),
  note: z.string().optional(),
});
export type TurnDispositionExpected = z.infer<typeof TurnDispositionExpectedSchema>;

export const TurnDispositionCaseSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  workstreamId: z.string().min(1),
  substreamId: z.string().min(1),
  turnId: z.string().min(1),
  runId: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  state: TurnDispositionStateSchema,
  production: z.object({
    /** A merge marker landed in this conversation after this turn. */
    mergedLater: z.boolean(),
    /** The merge marker landed before the next completed run's final turn. */
    mergedBeforeNextTurn: z.boolean(),
    /** This turn was the newest completed run's final turn when exported. */
    lastTurn: z.boolean(),
    breakoutState: z.string(),
    archived: z.boolean(),
    turnOrdinal: z.number().int().positive(),
    turnCount: z.number().int().positive(),
  }),
  expected: TurnDispositionExpectedSchema.nullable(),
});
export type TurnDispositionCase = z.infer<typeof TurnDispositionCaseSchema>;

export interface TurnDispositionActual {
  disposition: TurnDisposition;
  confidence: number;
  kind: CarriedItemKind | null;
  kindConfidence: number | null;
}

export interface TurnDispositionResult {
  caseId: string;
  target: string;
  model: string;
  run: number;
  expected: TurnDispositionExpected | null;
  actual?: TurnDispositionActual;
  latencyMs: number;
  error?: string;
  resolvedModel?: string;
}

export interface ThresholdPoint {
  threshold: number;
  /** Suggested when the disposition is `worth_carrying_up` and confidence > threshold. */
  suggested: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface TurnDispositionSummary {
  target: string;
  model: string;
  cases: number;
  labeledCases: number;
  completed: number;
  errors: number;
  successRate: number;
  accuracy: number;
  endToEndAccuracy: number;
  macroF1: number;
  carryUpBinaryAccuracy: number;
  kindAccuracy: number;
  kindLabeled: number;
  confidence: { meanCorrect: number; meanWrong: number };
  thresholds: ThresholdPoint[];
  latencyMs: { p50: number; p90: number; p95: number; p99: number; mean: number; max: number };
  byDisposition: Record<TurnDisposition, { support: number; predicted: number; precision: number; recall: number; f1: number }>;
  confusion: Record<TurnDisposition, Record<TurnDisposition, number>>;
  /** How often the golden label agrees with what production did: a merge later means carry-up. */
  productionAgreement: { cases: number; agreeing: number; rate: number };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted[0]!;
}

function f1(precision: number, recall: number): number {
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
}

export const EVALUATION_THRESHOLDS = [0, 0.3, 0.5, 0.6, 0.7, 0.8] as const;

export function summarizeTurnDispositionEvaluation(
  target: string,
  model: string,
  results: TurnDispositionResult[],
  cases: TurnDispositionCase[],
): TurnDispositionSummary {
  const completed = results.filter((result) => result.actual !== undefined);
  const labeledAttempts = results.filter((result) => result.expected !== null);
  const labeled = completed.filter((result): result is TurnDispositionResult & {
    actual: TurnDispositionActual; expected: TurnDispositionExpected;
  } => result.expected !== null);
  const exact = labeled.filter((result) => result.actual.disposition === result.expected.disposition);
  const wrong = labeled.filter((result) => result.actual.disposition !== result.expected.disposition);
  const byDisposition = Object.fromEntries(TURN_DISPOSITION_CHOICES.map((choice) => {
    const support = labeled.filter((result) => result.expected.disposition === choice).length;
    const predicted = labeled.filter((result) => result.actual.disposition === choice).length;
    const truePositive = labeled.filter((result) =>
      result.expected.disposition === choice && result.actual.disposition === choice).length;
    const precision = ratio(truePositive, predicted);
    const recall = ratio(truePositive, support);
    return [choice, { support, predicted, precision, recall, f1: f1(precision, recall) }];
  })) as TurnDispositionSummary["byDisposition"];
  const supported = TURN_DISPOSITION_CHOICES.filter((choice) => byDisposition[choice].support > 0);
  const confusion = Object.fromEntries(TURN_DISPOSITION_CHOICES.map((expected) => [
    expected,
    Object.fromEntries(TURN_DISPOSITION_CHOICES.map((actual) => [
      actual,
      labeled.filter((result) => result.expected.disposition === expected && result.actual.disposition === actual).length,
    ])),
  ])) as TurnDispositionSummary["confusion"];
  const carryUpAgree = labeled.filter((result) =>
    (result.actual.disposition === "worth_carrying_up") === (result.expected.disposition === "worth_carrying_up")).length;
  // The kind only reaches a person through the merge chip's wording, so it is
  // scored where both the label and the answer would show that chip.
  const kindLabeled = labeled.filter((result) =>
    result.expected.disposition === "worth_carrying_up"
    && result.actual.disposition === "worth_carrying_up"
    && result.expected.kind !== null
    && result.actual.kind !== null);
  const kindExact = kindLabeled.filter((result) => result.actual.kind === result.expected.kind).length;
  const thresholds = EVALUATION_THRESHOLDS.map((threshold) => {
    const positives = labeled.filter((result) => result.expected.disposition === "worth_carrying_up");
    const suggested = labeled.filter((result) =>
      result.actual.disposition === "worth_carrying_up" && result.actual.confidence > threshold);
    const truePositives = suggested.filter((result) => result.expected.disposition === "worth_carrying_up").length;
    const falsePositives = suggested.length - truePositives;
    const falseNegatives = positives.length - truePositives;
    const precision = ratio(truePositives, suggested.length);
    const recall = ratio(truePositives, positives.length);
    return { threshold, suggested: suggested.length, truePositives, falsePositives, falseNegatives, precision, recall, f1: f1(precision, recall) };
  });
  const latencies = completed.map((result) => result.latencyMs);
  const caseById = new Map(cases.map((evaluationCase) => [evaluationCase.id, evaluationCase]));
  const productionCases = labeled.map((result) => caseById.get(result.caseId)).filter((evaluationCase): evaluationCase is TurnDispositionCase =>
    evaluationCase !== undefined && evaluationCase.expected !== null);
  const productionAgreeing = productionCases.filter((evaluationCase) =>
    (evaluationCase.expected!.disposition === "worth_carrying_up") === evaluationCase.production.mergedLater).length;
  const mean = (values: number[]): number => ratio(values.reduce((total, value) => total + value, 0), values.length);
  return {
    target,
    model,
    cases: results.length,
    labeledCases: labeled.length,
    completed: completed.length,
    errors: results.length - completed.length,
    successRate: ratio(completed.length, results.length),
    accuracy: ratio(exact.length, labeled.length),
    endToEndAccuracy: ratio(exact.length, labeledAttempts.length),
    macroF1: ratio(supported.reduce((total, choice) => total + byDisposition[choice].f1, 0), supported.length),
    carryUpBinaryAccuracy: ratio(carryUpAgree, labeled.length),
    kindAccuracy: ratio(kindExact, kindLabeled.length),
    kindLabeled: kindLabeled.length,
    confidence: {
      meanCorrect: mean(exact.map((result) => result.actual.confidence)),
      meanWrong: mean(wrong.map((result) => result.actual.confidence)),
    },
    thresholds,
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
      mean: Math.round(mean(latencies)),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
    byDisposition,
    confusion,
    productionAgreement: {
      cases: productionCases.length,
      agreeing: productionAgreeing,
      rate: ratio(productionAgreeing, productionCases.length),
    },
  };
}
