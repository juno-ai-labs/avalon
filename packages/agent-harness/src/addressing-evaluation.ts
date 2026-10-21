import { z } from "zod";
import { AddressingClassificationSchema } from "@rally/contracts";
import type { AddressingClassification } from "@rally/contracts";
import type { AddressingPromptInput } from "./prompts/addressing";

const AddressingContextMessageSchema = z.object({
  authorType: z.enum(["human", "agent"]),
  authorName: z.string().nullable(),
  message: z.string(),
});

export const AddressingEvaluationCaseSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime({ offset: true }),
  workspaceId: z.string().min(1),
  workstreamId: z.string().min(1),
  inferenceRequestId: z.string().min(1),
  productionModel: z.string().min(1),
  input: z.object({
    message: z.string(),
    authorName: z.string().nullable().optional(),
    activeTask: z.boolean(),
    connectorMentions: z.array(z.string()),
    humanMentions: z.array(z.string()),
    addressesRally: z.boolean(),
    recentMessages: z.array(AddressingContextMessageSchema),
  }),
  expected: AddressingClassificationSchema.nullable(),
});

export type AddressingEvaluationCase = z.infer<typeof AddressingEvaluationCaseSchema>;

export interface AddressingEvaluationResult {
  caseId: string;
  model: string;
  expected: AddressingClassification | null;
  actual?: AddressingClassification;
  latencyMs: number;
  error?: string;
  resolvedModels?: string[];
  continuation?: { decision: "resume_requested_work" | "followup_without_rally_action" | "use_addressing"; confidence: number; stage: "primary" | "fallback" | "floor" };
  cascadeRoute?: "not_needed" | "typesafe" | "fallback" | "terminal_heuristic";
  cascadeFallbackReason?: "low_confidence" | "typesafe_failure";
  typesafeConfidence?: number;
}

export interface AddressingEvaluationSummary {
  model: string;
  cases: number;
  labeledCases: number;
  completed: number;
  errors: number;
  successRate: number;
  classificationAccuracy: number;
  endToEndAccuracy: number;
  rationaleAgreement: number;
  confidenceMeanAbsoluteError: number;
  macroF1: number;
  latencyMs: { p50: number; p90: number; p99: number };
  byClassification: Record<AddressingClassification["classification"], {
    support: number;
    precision: number;
    recall: number;
    f1: number;
  }>;
}

const classifications = ["agent_action", "human_only", "both", "uncertain"] as const;

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(fraction * sorted.length) - 1] ?? sorted[0]!;
}

export function summarizeAddressingEvaluation(
  model: string,
  results: AddressingEvaluationResult[],
): AddressingEvaluationSummary {
  const completed = results.filter((result) => result.actual !== undefined);
  const labeledAttempts = results.filter((result): result is AddressingEvaluationResult & {
    expected: AddressingClassification;
  } => result.expected !== null);
  const labeled = completed.filter((result): result is AddressingEvaluationResult & {
    actual: AddressingClassification; expected: AddressingClassification;
  } => result.expected !== null);
  const exact = labeled.filter((result) => result.actual.classification === result.expected.classification);
  const rationaleMatches = labeled.filter((result) => result.actual.rationaleCode === result.expected.rationaleCode);
  const confidenceError = labeled.reduce(
    (total, result) => total + Math.abs(result.actual.confidence - result.expected.confidence),
    0,
  );
  const byClassification = Object.fromEntries(classifications.map((classification) => {
    const support = labeled.filter((result) => result.expected.classification === classification).length;
    const predicted = labeled.filter((result) => result.actual.classification === classification).length;
    const truePositive = labeled.filter((result) =>
      result.expected.classification === classification
      && result.actual.classification === classification).length;
    const precision = ratio(truePositive, predicted);
    const recall = ratio(truePositive, support);
    return [classification, {
      support,
      precision,
      recall,
      f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    }];
  })) as AddressingEvaluationSummary["byClassification"];
  const supportedClassifications = classifications.filter((classification) =>
    byClassification[classification].support > 0);
  const latencies = completed.map((result) => result.latencyMs);
  return {
    model,
    cases: results.length,
    labeledCases: labeled.length,
    completed: completed.length,
    errors: results.length - completed.length,
    successRate: ratio(completed.length, results.length),
    classificationAccuracy: ratio(exact.length, labeled.length),
    endToEndAccuracy: ratio(exact.length, labeledAttempts.length),
    rationaleAgreement: ratio(rationaleMatches.length, labeled.length),
    confidenceMeanAbsoluteError: ratio(confidenceError, labeled.length),
    macroF1: ratio(supportedClassifications.reduce((total, classification) =>
      total + byClassification[classification].f1, 0), supportedClassifications.length),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p90: percentile(latencies, 0.9),
      p99: percentile(latencies, 0.99),
    },
    byClassification,
  };
}

export function addressingPromptInput(
  evaluationCase: AddressingEvaluationCase,
): AddressingPromptInput {
  return evaluationCase.input;
}
