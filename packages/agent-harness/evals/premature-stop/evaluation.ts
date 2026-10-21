import { createHash } from "node:crypto";
import { z } from "zod";

export { choices, answers, questions, type Choice } from "../../src/completion-verification-question";
import { choices, completionStateSchema, type Choice } from "../../src/completion-verification-question";

export const caseSchema = z.object({
  id: z.string(), family: z.string(), split: z.enum(["development", "holdout"]),
  suite: z.enum(["real", "synthetic"]), org: z.string(), kind: z.string(), tags: z.array(z.string()),
  state: completionStateSchema,
  lifecycle: z.enum(["ready", "background_pending", "cancelled", "input_required", "ambiguous_write", "recovery_used", "unknown"]),
  expected: z.enum(choices), expectedNudge: z.boolean(), rationale: z.string(),
  provenance: z.record(z.string(), z.unknown()),
});
export type EvalCase = z.infer<typeof caseSchema>;
export type Answer = { choice: Choice; confidence: number };
export type EvalResult = EvalCase & {
  answer: Answer | null; failure: string | null; nudge: boolean; latencyMs: number;
  requestBytes: number; inputTokens: number | null;
};

export function shouldNudge(example: Pick<EvalCase, "lifecycle" | "state">, answer: Answer | null, threshold = 0.5): boolean {
  return example.lifecycle === "ready" && example.state.context_status === "resolved"
    && answer?.choice === "announces_unfinished_work" && answer.confidence > threshold;
}

export function splitForFamily(family: string): "development" | "holdout" {
  return createHash("sha256").update(family).digest()[0]! < 128 ? "development" : "holdout";
}

function percentile(values: number[], fraction: number): number | null {
  return values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]! : null;
}

export function aggregate(results: EvalResult[]) {
  const scored = results.filter((r) => r.answer !== null);
  const tp = results.filter((r) => r.expectedNudge && r.nudge).length;
  const fp = results.filter((r) => !r.expectedNudge && r.nudge).length;
  const fn = results.filter((r) => r.expectedNudge && !r.nudge).length;
  return {
    count: results.length, available: scored.length, unavailable: results.length - scored.length,
    labelCorrect: scored.filter((r) => r.answer?.choice === r.expected).length,
    labelAccuracyWhenAvailable: scored.length ? scored.filter((r) => r.answer?.choice === r.expected).length / scored.length : null,
    expectedLabels: Object.fromEntries(choices.map((c) => [c, results.filter((r) => r.expected === c).length])),
    confusion: Object.fromEntries(choices.map((c) => [c, Object.fromEntries([...choices, "unavailable"].map((p) =>
      [p, results.filter((r) => r.expected === c && (r.answer?.choice ?? "unavailable") === p).length]))])),
    gate: { tp, fp, fn, tn: results.length - tp - fp - fn,
      precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null },
    failures: Object.fromEntries([...new Set(results.flatMap((r) => r.failure ? [r.failure] : []))]
      .map((f) => [f, results.filter((r) => r.failure === f).length])),
    latencyMs: { p50: percentile(results.map((r) => r.latencyMs), 0.5), p95: percentile(results.map((r) => r.latencyMs), 0.95) },
    inputTokens: { p50: percentile(scored.flatMap((r) => r.inputTokens === null ? [] : [r.inputTokens]), 0.5),
      p95: percentile(scored.flatMap((r) => r.inputTokens === null ? [] : [r.inputTokens]), 0.95) },
    stateBytes: { p50: percentile(results.map((r) => r.requestBytes), 0.5), p95: percentile(results.map((r) => r.requestBytes), 0.95) },
  };
}
