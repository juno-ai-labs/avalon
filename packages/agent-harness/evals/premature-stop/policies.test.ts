import { expect, it } from "vitest";
import { type EvalResult } from "./evaluation";
import { comparePolicies, shouldReprompt, sweepConfidence } from "./policies";

const example: EvalResult = {
  id: "publication-stop", family: "build", split: "development", suite: "synthetic", org: "synthetic", kind: "synthetic", tags: [],
  state: { triggering_request: { id: "request", text: "Publish the article.", origin: "human_message" },
    linked_context: [], candidate_final: "I will publish it next.", tool_receipts: [],
    context_status: "resolved", evidence_coverage: "Synthetic fixture" },
  lifecycle: "ready", expected: "announces_unfinished_work", expectedNudge: true, rationale: "Publication remains promised.", provenance: {},
  answer: { choice: "announces_unfinished_work", confidence: 0.35 }, failure: null, nudge: false,
  latencyMs: 100, requestBytes: 300, inputTokens: 1200,
};

it("uses a verification reprompt on uncertainty and provider failure", () => {
  expect(shouldReprompt("uncertainty_fallback", example, example.answer)).toBe(true);
  expect(shouldReprompt("uncertainty_fallback", example, null)).toBe(true);
  expect(shouldReprompt("uncertainty_fallback", example, { choice: "answer_or_result", confidence: 0.5 })).toBe(true);
  expect(shouldReprompt("uncertainty_fallback", example, { choice: "unclear", confidence: 0.9 })).toBe(true);
});

it("checks once even when the judge confidently mistakes a promise for a result", () => {
  const answer = { choice: "answer_or_result", confidence: 0.63 } as const;
  expect(shouldReprompt("uncertainty_fallback", example, answer)).toBe(false);
  expect(shouldReprompt("verify_once", example, answer)).toBe(true);
});

it("uses opposite threshold directions for accepting unfinished work and accepting a stop", () => {
  expect(shouldReprompt("strict", example, example.answer, 0.34)).toBe(true);
  expect(shouldReprompt("strict", example, example.answer, 0.35)).toBe(false);
  const answer = { choice: "answer_or_result", confidence: 0.63 } as const;
  expect(shouldReprompt("uncertainty_fallback", example, answer, 0.62)).toBe(false);
  expect(shouldReprompt("uncertainty_fallback", example, answer, 0.63)).toBe(true);
  expect(shouldReprompt("uncertainty_fallback", { ...example, lifecycle: "recovery_used" }, answer, 1)).toBe(false);
});

it("sweeps missed reprompts and overhead without changing the recorded judgments", () => {
  const rows = sweepConfidence([
    { ...example, split: "holdout", answer: { choice: "answer_or_result", confidence: 0.63 } },
    { ...example, id: "done", expectedNudge: false, answer: { choice: "answer_or_result", confidence: 0.9 } },
  ], [0.5, 0.65, 0.95]);
  expect(rows.map((r) => [r.threshold, r.policies.uncertainty_fallback!.missed, r.policies.uncertainty_fallback!.extraVerificationTurns]))
    .toEqual([[0.5, 1, 0], [0.65, 0, 0], [0.95, 0, 1]]);
  expect(rows[1]!.policies.uncertainty_fallback!.bySplit.holdout).toMatchObject({ caught: 1, missed: 0 });
  expect(rows.map((r) => r.policies.verify_once!.totalReprompts)).toEqual([2, 2, 2]);
});

it("lets the main model resolve missing judge context", () => {
  const unresolved = { ...example, state: { ...example.state, context_status: "unresolved" as const } };
  expect(shouldReprompt("uncertainty_fallback", unresolved, { choice: "answer_or_result", confidence: 0.9 })).toBe(true);
});

it.each(["background_pending", "cancelled", "input_required", "ambiguous_write", "recovery_used", "unknown"] as const)("does not bypass authoritative lifecycle state %s", (lifecycle) => {
  expect(shouldReprompt("verify_once", { ...example, lifecycle }, null)).toBe(false);
  expect(shouldReprompt("uncertainty_fallback", { ...example, lifecycle }, example.answer)).toBe(false);
});

it("counts recovered opportunities and verification overhead separately", () => {
  const result = comparePolicies([
    example,
    { ...example, id: "calendar-stop", answer: { choice: "answer_or_result", confidence: 0.63 } },
    { ...example, id: "already-done", expected: "answer_or_result", expectedNudge: false, answer: { choice: "answer_or_result", confidence: 0.99 } },
  ]);
  expect(result.strict).toMatchObject({ needsContinuation: 2, caught: 0, missed: 2, extraVerificationTurns: 0 });
  expect(result.uncertainty_fallback).toMatchObject({ caught: 1, missed: 1, extraVerificationTurns: 0 });
  expect(result.verify_once).toMatchObject({ caught: 2, missed: 0, extraVerificationTurns: 1 });
});
