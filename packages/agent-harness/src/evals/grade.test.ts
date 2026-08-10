import { describe, expect, it } from "vitest";
import {
  SUGGESTION_CONFIDENCE_FLOOR,
  formatPassRate,
  gradeActivityRouting,
  gradeAddressing,
  gradeSemanticTrigger,
  routingDecision,
  semanticTriggerFires,
} from "./grade";
import { activityRoutingCases, addressingCases, semanticTriggerCases, totalCaseCount } from "./cases";

const CANDIDATES = ["6f1d0c62-5a7e-4d5b-9d64-1f0e2a3b4c5d", "8a2b4d10-3c6f-4e91-b7a2-9d5c1e8f0a34"];

function routing(overrides: Partial<Parameters<typeof routingDecision>[0]> = {}) {
  return {
    candidateWorkstreamId: CANDIDATES[0] ?? null,
    confidence: 0.9,
    reason: "The pull request changes the model routing configuration.",
    matchedEntities: ["juno-ai-labs/avalon"],
    suggest: true,
    ...overrides,
  };
}

describe("addressing grading", () => {
  it("passes only on the expected classification", () => {
    const response = { classification: "agent_action" as const, confidence: 0.82, rationaleCode: "imperative" };
    expect(gradeAddressing("agent_action", response).passed).toBe(true);
    expect(gradeAddressing("human_only", response).passed).toBe(false);
  });

  it("flags a wrong answer the model was confident about", () => {
    const verdict = gradeAddressing("human_only", {
      classification: "agent_action",
      confidence: 0.97,
      rationaleCode: "imperative",
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.note).toContain("confidently wrong");
  });
});

describe("semantic trigger grading", () => {
  it("requires the production confidence floor, not just a match", () => {
    expect(semanticTriggerFires({ matches: true, confidence: SUGGESTION_CONFIDENCE_FLOOR })).toBe(true);
    expect(semanticTriggerFires({ matches: true, confidence: 0.79 })).toBe(false);
    expect(semanticTriggerFires({ matches: false, confidence: 1 })).toBe(false);
  });

  it("counts a low-confidence match as no trigger", () => {
    const verdict = gradeSemanticTrigger(true, { matches: true, confidence: 0.6 });
    expect(verdict.passed).toBe(false);
    expect(verdict.actual).toBe("no-trigger");
  });

  it("passes when a non-match is expected and the floor is missed", () => {
    expect(gradeSemanticTrigger(false, { matches: true, confidence: 0.4 }).passed).toBe(true);
  });
});

describe("activity routing grading", () => {
  it("suggests only above the floor with a grounded candidate", () => {
    expect(routingDecision(routing(), CANDIDATES)).toEqual({ kind: "suggest", workstreamId: CANDIDATES[0] });
    expect(routingDecision(routing({ confidence: 0.7 }), CANDIDATES)).toEqual({ kind: "none" });
    expect(routingDecision(routing({ suggest: false }), CANDIDATES)).toEqual({ kind: "none" });
    expect(routingDecision(routing({ candidateWorkstreamId: null }), CANDIDATES)).toEqual({ kind: "none" });
  });

  it("separates a hallucinated identifier from an abstention", () => {
    const invented = "00000000-0000-4000-8000-000000000000";
    const decision = routingDecision(routing({ candidateWorkstreamId: invented }), CANDIDATES);
    expect(decision).toEqual({ kind: "ungrounded", workstreamId: invented });

    const verdict = gradeActivityRouting(null, routing({ candidateWorkstreamId: invented }), CANDIDATES);
    expect(verdict.passed).toBe(false);
    expect(verdict.note).toContain("not offered as a candidate");
  });

  it("passes an abstention when no suggestion is expected", () => {
    expect(gradeActivityRouting(null, routing({ suggest: false }), CANDIDATES).passed).toBe(true);
  });

  it("fails a suggestion where abstention is required", () => {
    const verdict = gradeActivityRouting(null, routing(), CANDIDATES);
    expect(verdict.passed).toBe(false);
    expect(verdict.note).toContain("abstention");
  });
});

describe("case data", () => {
  it("gives every case a unique id and an intent", () => {
    const all = [...addressingCases, ...semanticTriggerCases, ...activityRoutingCases];
    expect(all).toHaveLength(totalCaseCount);
    expect(new Set(all.map((testCase) => testCase.id)).size).toBe(all.length);
    for (const testCase of all) expect(testCase.intent.length).toBeGreaterThan(0);
  });

  it("only expects routing candidates that are actually offered", () => {
    for (const testCase of activityRoutingCases) {
      if (testCase.expected === null) continue;
      expect(testCase.input.candidates.map((candidate) => candidate.id)).toContain(testCase.expected);
    }
  });

  it("covers both trigger outcomes so a degenerate model cannot pass", () => {
    expect(semanticTriggerCases.some((testCase) => testCase.expected)).toBe(true);
    expect(semanticTriggerCases.some((testCase) => !testCase.expected)).toBe(true);
    expect(activityRoutingCases.some((testCase) => testCase.expected === null)).toBe(true);
    expect(activityRoutingCases.some((testCase) => testCase.expected !== null)).toBe(true);
    expect(new Set(addressingCases.map((testCase) => testCase.expected)).size).toBeGreaterThan(2);
  });
});

describe("reporting", () => {
  it("formats a pass rate", () => {
    expect(formatPassRate({ passed: 3, total: 4 })).toBe("3/4 (75%)");
    expect(formatPassRate({ passed: 0, total: 0 })).toBe("0/0 (0%)");
  });
});
