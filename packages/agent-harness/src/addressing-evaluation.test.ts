import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  AddressingEvaluationCaseSchema,
  summarizeAddressingEvaluation,
  type AddressingEvaluationResult,
} from "./addressing-evaluation";

describe("addressing model evaluation", () => {
  it("validates a production-derived case", () => {
    expect(AddressingEvaluationCaseSchema.parse({
      id: "case-1",
      timestamp: "2026-09-16T12:00:00.000-07:00",
      workspaceId: "workspace-1",
      workstreamId: "workstream-1",
      inferenceRequestId: "request-1",
      productionModel: "model/a",
      input: {
        message: "Can you check this?",
        activeTask: false,
        connectorMentions: [],
        humanMentions: [],
        addressesRally: false,
        recentMessages: [],
      },
      expected: { classification: "both", confidence: 0.72, rationaleCode: "question" },
    }).input.message).toBe("Can you check this?");
  });

  it("reports agreement, macro F1, errors, and nearest-rank latency percentiles", () => {
    const results: AddressingEvaluationResult[] = [
      { caseId: "1", model: "model/a", latencyMs: 10,
        expected: { classification: "agent_action", confidence: 0.9, rationaleCode: "imperative" },
        actual: { classification: "agent_action", confidence: 0.8, rationaleCode: "imperative" } },
      { caseId: "2", model: "model/a", latencyMs: 20,
        expected: { classification: "human_only", confidence: 0.8, rationaleCode: "human_coordination" },
        actual: { classification: "agent_action", confidence: 0.6, rationaleCode: "active_task" } },
      { caseId: "3", model: "model/a", latencyMs: 30,
        expected: { classification: "both", confidence: 0.7, rationaleCode: "question" },
        actual: { classification: "both", confidence: 0.7, rationaleCode: "question" } },
      { caseId: "4", model: "model/a", latencyMs: 40,
        expected: { classification: "uncertain", confidence: 0.5, rationaleCode: "insufficient_signal" },
        error: "provider failed" },
    ];
    const summary = summarizeAddressingEvaluation("model/a", results);
    expect(summary).toMatchObject({
      cases: 4,
      labeledCases: 3,
      completed: 3,
      errors: 1,
      successRate: 3 / 4,
      classificationAccuracy: 2 / 3,
      endToEndAccuracy: 1 / 2,
      rationaleAgreement: 2 / 3,
      latencyMs: { p50: 20, p90: 30, p99: 30 },
    });
    expect(summary.macroF1).toBeCloseTo(5 / 9);
    expect(summary.confidenceMeanAbsoluteError).toBeCloseTo(0.1);
    expect(summary.byClassification.human_only).toMatchObject({ support: 1, precision: 0, recall: 0, f1: 0 });
  });

  it("evaluates an unlabeled retained call without claiming agreement", () => {
    const summary = summarizeAddressingEvaluation("model/a", [{
      caseId: "1",
      model: "model/a",
      latencyMs: 10,
      expected: null,
      actual: { classification: "human_only", confidence: 0.8, rationaleCode: "insufficient_signal" },
    }]);
    expect(summary).toMatchObject({ cases: 1, labeledCases: 0, completed: 1, classificationAccuracy: 0 });
  });

  it("counts a failed labeled call against end-to-end accuracy", () => {
    const summary = summarizeAddressingEvaluation("model/a", [{
      caseId: "1",
      model: "model/a",
      latencyMs: 10,
      expected: { classification: "human_only", confidence: 0.8, rationaleCode: "human_coordination" },
      error: "provider failed",
    }]);
    expect(summary).toMatchObject({
      labeledCases: 0,
      successRate: 0,
      classificationAccuracy: 0,
      endToEndAccuracy: 0,
    });
  });

  it("keeps a small committed synthetic smoke corpus", async () => {
    const source = await readFile(new URL("../evals/addressing/synthetic-cases.jsonl", import.meta.url), "utf8");
    const cases = source.trim().split("\n").map((line) =>
      AddressingEvaluationCaseSchema.parse(JSON.parse(line)));
    expect(cases).toHaveLength(4);
    expect(cases.map((item) => item.expected?.classification)).toEqual([
      "agent_action",
      "human_only",
      "both",
      "uncertain",
    ]);
  });
});
