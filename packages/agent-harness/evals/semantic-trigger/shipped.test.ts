import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { semanticTriggerQuestions, SEMANTIC_TRIGGER_CHOICES } from "../../src/semantic-trigger-gate";
import { candidateQuestions, type CandidateContract } from "./contract";

/**
 * What ships is what was measured.
 *
 * The optimization's winner is recorded as data in `candidates/winner.json`, and
 * the runtime builds its request from code. Nothing but this test keeps the two
 * the same, and the failure it prevents is the expensive one: a later edit to a
 * criterion — a clarification, a typo fix, a sentence someone thought was
 * equivalent — silently detaches the shipped request from the only evidence that
 * it works, and every number in `docs/semantic-activity-triggers.md` becomes a
 * claim about a request that no longer exists.
 *
 * So a change to the shipped question must either come with a rerun that moves
 * the winner file, or it does not happen. This test is the place that says so.
 */
describe("the shipped semantic trigger request", () => {
  const winner = JSON.parse(
    readFileSync(new URL("./candidates/winner.json", import.meta.url), "utf8"),
  ) as CandidateContract[];

  it("is byte-identical to the candidate the optimization selected", () => {
    expect(winner).toHaveLength(1);
    expect(JSON.stringify(candidateQuestions(winner[0]!)))
      .toBe(JSON.stringify(semanticTriggerQuestions));
  });

  it("maps every choice it can receive onto an operational verdict", () => {
    const mapping = winner[0]!.mapping;
    expect(Object.keys(mapping).sort()).toEqual([...SEMANTIC_TRIGGER_CHOICES].sort());
    for (const verdict of Object.values(mapping)) {
      expect(["met", "not_met", "not_judgeable"]).toContain(verdict);
    }
  });
});
