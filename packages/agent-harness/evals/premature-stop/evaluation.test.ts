import { describe, expect, it } from "vitest";
import { aggregate, shouldNudge, type EvalCase, type EvalResult } from "./evaluation";
import { buildCases, type Annotation, type RawConversation } from "./build";

const annotation: Annotation = {
  runId: "run", contextSequences: [1], contextStatus: "resolved", expected: "announces_unfinished_work",
  expectedNudge: true, lifecycle: "ready", rationale: "The article remains promised.", tags: [],
};
function conversation(): RawConversation {
  return {
    org: "Test org", workspaceId: "workspace", workstreamId: "thread-b", substreamId: "0",
    runs: [{ run_id: "run", trigger_part_id: "request", input_fence_seq: 3, final_turn_id: "final", origin: "human_message", started_at: 30 }],
    turns: [
      { seq: 1, id: "older", role: "user", content: "Write an article when I say go.", created_at: 10 },
      { seq: 2, id: "irrelevant", role: "user", content: "Unrelated question", created_at: 20 },
      { seq: 3, id: "request", role: "user", content: "Go.", created_at: 30 },
      { seq: 4, id: "progress", role: "assistant", content: "Loading the tool", created_at: 40 },
      { seq: 5, id: "correction", role: "user", content: "Use city trees as the topic.", created_at: 50 },
      { seq: 6, id: "final", role: "assistant", content: "I will draft it now.", created_at: 60 },
      { seq: 7, id: "future", role: "user", content: "You did not write it!", created_at: 70 },
    ],
    tools: [
      { run_id: "run", call_id: "load", operation: "load_plugin", status: "completed", input: '{"pluginId":"terminal"}', summary: "Loaded Terminal", started_at: 35, settled_at: 38 },
      { run_id: "run", call_id: "later-receipt", operation: "write_file", status: "completed", input: '{"path":"article.md"}', summary: "Wrote article.md", started_at: 55, settled_at: 65 },
      { run_id: "run", call_id: "future-call", operation: "publish_resource", status: "completed", input: '{}', summary: "Published", started_at: 70, settled_at: 80 },
      { run_id: "different-run", call_id: "different-call", operation: "publish_resource", status: "completed", input: '{}', summary: "Unrelated publish", started_at: 30, settled_at: 35 },
    ],
  };
}
const example = (): EvalCase => buildCases([conversation()], [annotation])[0]!;

describe("premature-stop snapshot", () => {
  it("uses the exact final, selected nonadjacent antecedents, and delivered steering without future leakage", () => {
    const state = example().state;
    expect(state.candidate_final).toBe("I will draft it now.");
    expect(state.linked_context.map((c) => c.text)).toEqual(["Write an article when I say go.", "Use city trees as the topic."]);
    expect(state.tool_receipts.map((t) => [t.id, t.status, t.summary])).toEqual([
      ["load", "completed", "Loaded Terminal"], ["later-receipt", "pending", null],
    ]);
  });
  it("rejects a context link that would expose a future correction", () => {
    expect(() => buildCases([conversation()], [{ ...annotation, contextSequences: [7] }])).toThrow("Invalid older context");
  });
  it("does not silently substitute another user message for a missing trigger", () => {
    const raw = conversation();
    raw.runs[0]!.trigger_part_id = "not-exported";
    expect(buildCases([raw], [annotation])[0]!.state).toMatchObject({
      context_status: "unresolved", triggering_request: { id: "not-exported", text: "" },
    });
  });
  it("extracts the actual structured elicitation answer", () => {
    const raw = conversation();
    raw.turns[2]!.content = "";
    raw.turns[2]!.structured = JSON.stringify({ elicitation: { prompt: "Which source?", answer: "Use public web sources" } });
    expect(buildCases([raw], [annotation])[0]!.state.triggering_request.text)
      .toBe('{"question":"Which source?","answer":"Use public web sources"}');
  });
  it("carries failed-operation reasons but never reveals a later failure", () => {
    const raw = conversation();
    raw.tools[0]!.status = "failed";
    raw.tools[0]!.summary = null;
    raw.tools[0]!.error = '{"code":"sandbox_busy","message":"Workspace in use"}';
    raw.tools[1]!.error = '{"code":"later_failure","message":"Only learned later"}';
    expect(buildCases([raw], [annotation])[0]!.state.tool_receipts.map((t) => t.summary))
      .toEqual(['{"code":"sandbox_busy","message":"Workspace in use"}', null]);
  });
  it("deduplicates alias runs and keeps the entire parent/breakout family in one split", () => {
    const main = conversation(), breakout = conversation();
    breakout.workstreamId = "thread-a";
    breakout.substreamId = "thread-b";
    breakout.runs.push({ ...breakout.runs[0]!, run_id: "other-run" });
    const cases = buildCases([main, breakout], [annotation, { ...annotation, runId: "other-run" }]);
    expect(cases.map((c) => c.family)).toEqual(["thread-a", "thread-a"]);
    expect(new Set(cases.map((c) => c.split)).size).toBe(1);
    expect(cases[0]!.kind).toBe("breakout");
    expect(cases[0]!.provenance.aliases).toHaveLength(2);
  });
});

describe("continuation policy", () => {
  it("requires a confident unfinished-work label, with a strict threshold", () => {
    expect(shouldNudge(example(), { choice: "announces_unfinished_work", confidence: 0.51 })).toBe(true);
    expect(shouldNudge(example(), { choice: "announces_unfinished_work", confidence: 0.5 })).toBe(false);
    expect(shouldNudge(example(), { choice: "answer_or_result", confidence: 0.99 })).toBe(false);
    expect(shouldNudge(example(), null)).toBe(false);
  });
  it.each(["background_pending", "cancelled", "input_required", "ambiguous_write", "recovery_used", "unknown"] as const)("suppresses recovery for %s", (lifecycle) => {
    expect(shouldNudge({ ...example(), lifecycle }, { choice: "announces_unfinished_work", confidence: 0.99 })).toBe(false);
  });
  it("does not recover an unresolved old reference", () => {
    const c = example();
    c.state.context_status = "unresolved";
    expect(shouldNudge(c, { choice: "announces_unfinished_work", confidence: 0.99 })).toBe(false);
  });
});

it("keeps provider failures in the operational denominator, but out of available-label accuracy", () => {
  const base: EvalResult = { ...example(), answer: { choice: "announces_unfinished_work", confidence: 0.9 },
    failure: null, nudge: true, latencyMs: 100, requestBytes: 300, inputTokens: 1200 };
  const result = aggregate([base, { ...base, id: "timeout", answer: null, failure: "typesafe_request_timed_out", nudge: false, latencyMs: 1000 }]);
  expect(result).toMatchObject({ count: 2, available: 1, unavailable: 1, labelAccuracyWhenAvailable: 1,
    gate: { tp: 1, fp: 0, fn: 1, tn: 0, recall: 0.5 }, failures: { typesafe_request_timed_out: 1 } });
  expect(aggregate([]).gate.recall).toBeNull();
});
