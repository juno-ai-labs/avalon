/**
 * The suggestion backfill's answer to the thread-backfill lane: a settled
 * judgement is the row's outcome, a classifier failure is thrown so the lane
 * retries the row, and a missing key settles because no retry would answer.
 */
import { describe, expect, it } from "vitest";

import { settledBackfillOutcome } from "../src/services/suggestion-backfill-service";

describe("settledBackfillOutcome", () => {
  it("passes a judgement through as the row's outcome", () => {
    expect(settledBackfillOutcome({ outcome: "judged:continue_here", failureKind: null })).toBe("judged:continue_here");
    expect(settledBackfillOutcome({ outcome: "skipped:already_judged", failureKind: null })).toBe("skipped:already_judged");
  });

  it("throws on a classifier failure, naming the kind, so the lane retries the row", () => {
    expect(() => settledBackfillOutcome({ outcome: "judged:classifier_unavailable", failureKind: "http_503" }))
      .toThrow("suggestion_backfill_classifier_unavailable_http_503");
  });

  it("settles a conversation judged without a key, which a retry cannot fix", () => {
    expect(settledBackfillOutcome({ outcome: "judged:classifier_unavailable", failureKind: "typesafe_key_missing" }))
      .toBe("judged:classifier_unavailable");
  });
});
