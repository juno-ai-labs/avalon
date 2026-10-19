/**
 * The suggestion backfill's answer to the thread-backfill lane: a settled
 * judgement is the row's outcome, a transient classifier failure or a step
 * that threw is thrown so the lane retries the row, and a classifier failure
 * no retry would fix settles because no retry would answer.
 */
import { describe, expect, it } from "vitest";

import { retryableClassifierFailure, settledBackfillOutcome } from "../src/services/suggestion-backfill-service";

describe("settledBackfillOutcome", () => {
  it("passes a judgement through as the row's outcome", () => {
    expect(settledBackfillOutcome({ outcome: "judged:continue_here", failureKind: null })).toBe("judged:continue_here");
    expect(settledBackfillOutcome({ outcome: "skipped:already_judged", failureKind: null })).toBe("skipped:already_judged");
  });

  it("throws on a transient classifier failure, naming the kind, so the lane retries the row", () => {
    expect(() => settledBackfillOutcome({ outcome: "judged:classifier_unavailable", failureKind: "typesafe_http_503" }))
      .toThrow("suggestion_backfill_classifier_unavailable_typesafe_http_503");
    expect(() => settledBackfillOutcome({ outcome: "judged:classifier_unavailable", failureKind: "typesafe_request_timed_out" }))
      .toThrow("suggestion_backfill_classifier_unavailable_typesafe_request_timed_out");
  });

  it("throws when the step itself failed before judging, so the row is not lost", () => {
    expect(() => settledBackfillOutcome({ outcome: "failed:turn_disposition_step_failed:d1_error", failureKind: null }))
      .toThrow("suggestion_backfill_turn_disposition_step_failed_d1_error");
  });

  it("settles a classifier failure a retry cannot fix: a missing or refused key, a rejected request, an unshaped answer", () => {
    for (const kind of ["typesafe_key_missing", "typesafe_http_401", "typesafe_http_400", "typesafe_http_413", "typesafe_response_invalid"]) {
      expect(settledBackfillOutcome({ outcome: "judged:classifier_unavailable", failureKind: kind })).toBe("judged:classifier_unavailable");
    }
  });

  it("counts overload, a deadline and an unreachable provider as transient, and nothing else", () => {
    expect(["typesafe_http_500", "typesafe_http_529", "typesafe_http_429", "typesafe_http_408", "typesafe_request_failed"].every(retryableClassifierFailure)).toBe(true);
    expect(["typesafe_http_404", "typesafe_http_422", "typesafe_response_invalid_json", "typesafe_key_missing"].some(retryableClassifierFailure)).toBe(false);
  });
});
