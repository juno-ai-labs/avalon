/**
 * Grading for model-comparison runs.
 *
 * Each grader reduces a raw model response to the decision Avalon derives from
 * it in production, so an eval failure corresponds to a behaviour difference a
 * workspace would actually see. The confidence floor and the candidate
 * grounding check mirror `consumeActivityQueue`.
 */
import type { AddressingOutcome } from "./cases";

/** Automation triggers and routing suggestions both require this confidence. */
export const SUGGESTION_CONFIDENCE_FLOOR = 0.8;

export interface CaseVerdict {
  passed: boolean;
  /** The production decision this response produces, rendered for a report. */
  actual: string;
  expected: string;
  /** Set when a response is wrong in a way worth calling out beyond the mismatch. */
  note?: string;
}

export interface AddressingResponse {
  classification: AddressingOutcome;
  confidence: number;
  rationaleCode: string;
}

export interface SemanticTriggerResponse {
  matches: boolean;
  confidence: number;
}

export interface ActivityRoutingResponse {
  candidateWorkstreamId: string | null;
  confidence: number;
  reason: string;
  matchedEntities: string[];
  suggest: boolean;
}

export function gradeAddressing(
  expected: AddressingOutcome,
  response: AddressingResponse,
): CaseVerdict {
  const passed = response.classification === expected;
  const verdict: CaseVerdict = {
    passed,
    actual: response.classification,
    expected,
  };
  if (!passed && response.confidence >= 0.9) {
    return { ...verdict, note: `confidently wrong (${response.confidence.toFixed(2)})` };
  }
  return verdict;
}

/** Mirrors `result.matches && result.confidence >= 0.8` in the activity consumer. */
export function semanticTriggerFires(response: SemanticTriggerResponse): boolean {
  return response.matches && response.confidence >= SUGGESTION_CONFIDENCE_FLOOR;
}

export function gradeSemanticTrigger(
  expected: boolean,
  response: SemanticTriggerResponse,
): CaseVerdict {
  const fires = semanticTriggerFires(response);
  const verdict: CaseVerdict = {
    passed: fires === expected,
    actual: fires ? "trigger" : "no-trigger",
    expected: expected ? "trigger" : "no-trigger",
  };
  if (!verdict.passed && response.matches !== expected && response.confidence < SUGGESTION_CONFIDENCE_FLOOR) {
    return { ...verdict, note: `held below the floor by confidence ${response.confidence.toFixed(2)}` };
  }
  return verdict;
}

export type RoutingDecision =
  | { kind: "none" }
  | { kind: "suggest"; workstreamId: string }
  /** The model returned an ID that was not among the supplied candidates. */
  | { kind: "ungrounded"; workstreamId: string };

/**
 * Mirrors the consumer's gate: suggest, clear the confidence floor, and name a
 * candidate that was actually offered. A response failing the last check is
 * dropped in production, but it is a hallucinated identifier and is reported
 * separately rather than being folded into "no suggestion".
 */
export function routingDecision(
  response: ActivityRoutingResponse,
  candidateIds: readonly string[],
): RoutingDecision {
  if (!response.suggest) return { kind: "none" };
  if (response.confidence < SUGGESTION_CONFIDENCE_FLOOR) return { kind: "none" };
  const id = response.candidateWorkstreamId;
  if (!id) return { kind: "none" };
  if (!candidateIds.includes(id)) return { kind: "ungrounded", workstreamId: id };
  return { kind: "suggest", workstreamId: id };
}

export function gradeActivityRouting(
  expected: string | null,
  response: ActivityRoutingResponse,
  candidateIds: readonly string[],
): CaseVerdict {
  const decision = routingDecision(response, candidateIds);
  const expectedLabel = expected ?? "no-suggestion";
  if (decision.kind === "ungrounded") {
    return {
      passed: false,
      actual: `ungrounded:${decision.workstreamId}`,
      expected: expectedLabel,
      note: "returned a work-stream ID that was not offered as a candidate",
    };
  }
  const actual = decision.kind === "none" ? "no-suggestion" : decision.workstreamId;
  const verdict: CaseVerdict = { passed: actual === expectedLabel, actual, expected: expectedLabel };
  if (!verdict.passed && expected === null) {
    return { ...verdict, note: "suggested a work stream where the prompt requires abstention" };
  }
  return verdict;
}

export interface SuiteTally {
  passed: number;
  total: number;
}

export function passRate(tally: SuiteTally): number {
  return tally.total === 0 ? 0 : tally.passed / tally.total;
}

export function formatPassRate(tally: SuiteTally): string {
  return `${tally.passed}/${tally.total} (${(passRate(tally) * 100).toFixed(0)}%)`;
}
